import json
import tempfile
import unittest
from pathlib import Path

from local_features import LocalFeatureStore, _atomic_json_write


class TotalRatingRecommenderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = LocalFeatureStore(Path(self.temporary.name))

    def tearDown(self):
        self.temporary.cleanup()

    def test_total_rating_and_passive_event_round_trip(self):
        saved = self.store.upsert_comic({
            "id": "10",
            "title": "测试漫画",
            "authors": ["作者甲"],
            "tags": ["剧情"],
            "cover_url": "https://cdn-msp.jmapiproxy1.cc/media/albums/10_3x4.jpg",
            "rating": 8,
        })
        self.assertEqual(saved["rating"], 8)
        self.assertNotIn("aspects", saved)

        event = self.store.record_interaction({
            "event_type": "read_start",
            "comic_id": "11",
            "chapter_id": "11001",
            "source": "reader",
            "comic": {"id": "11", "title": "先读后评"},
        })
        self.assertEqual(event["event_type"], "read_start")
        self.assertEqual(event["metadata"]["chapter_id"], "11001")
        self.assertEqual(self.store.get_comic("11")["title"], "先读后评")

        cleared = self.store.upsert_comic({"id": "10", "rating": None})
        self.assertIsNone(cleared["rating"])

    def test_cold_start_recommendation_does_not_call_remote_ai(self):
        self.store.ai_json = lambda *_args, **_kwargs: self.fail("remote AI must not rank candidates")
        result = self.store.generate_recommendations({
            "limit": 2,
            "candidates": [
                {"id": "101", "title": "候选一", "authors": [], "tags": []},
                {"id": "102", "title": "候选二", "authors": [], "tags": []},
            ],
        })
        self.assertEqual(len(result["recommendations"]), 2)
        self.assertEqual(result["ranking_engine"], "local-total-rating-v1")
        self.assertTrue(all(0 <= item["score"] <= 100 for item in result["recommendations"]))

    def test_total_ratings_drive_candidate_ranking(self):
        for comic_id, tags, rating in (
            ("1", ["优质"], 9),
            ("2", ["优质"], 10),
            ("3", ["差评"], 1),
            ("4", ["差评"], 2),
        ):
            self.store.upsert_comic({
                "id": comic_id, "title": comic_id, "tags": tags, "rating": rating,
            })
        candidates = [
            {"id": "101", "title": "高分候选", "tags": ["优质"]},
            {"id": "102", "title": "低分候选", "tags": ["差评"]},
        ]
        result = self.store.generate_recommendations({"limit": 2, "candidates": candidates})
        self.assertEqual(result["recommendations"][0]["id"], "101")
        self.assertGreater(
            result["recommendations"][0]["score_components"]["overall_rating"],
            result["recommendations"][1]["score_components"]["overall_rating"],
        )

    def test_cover_embedding_changes_total_rating_ranking(self):
        for comic_id, rating, vector in (("1", 10, [1, 0]), ("2", 1, [-1, 0])):
            self.store.upsert_comic({
                "id": comic_id, "title": comic_id,
                "rating": rating,
            })
            self.store.save_item_features({
                "comic_id": comic_id,
                "features": {"cover": {"status": "ready", "vector": vector}},
            })
        result = self.store.generate_recommendations({
            "limit": 2,
            "candidates": [
                {"id": "101", "title": "接近正样本", "cover_embedding": [0.99, 0.01]},
                {"id": "102", "title": "接近负样本", "cover_embedding": [-0.99, 0.01]},
            ],
        })
        positive, negative = result["recommendations"]
        self.assertEqual(positive["id"], "101")
        self.assertGreater(positive["score"], negative["score"])
        self.assertGreater(
            positive["score_components"]["overall_rating"],
            negative["score_components"]["overall_rating"],
        )

    def test_local_profile_and_validated_review_signal_feed_live_model(self):
        self.store.upsert_comic({
            "id": "1",
            "title": "评语样本",
            "tags": ["触手"],
            "review": "我明确喜欢触手题材。",
            "rating": 9,
        })
        profile = self.store.generate_profile()
        self.assertEqual(profile["narrative_source"], "local")
        self.assertEqual(profile["profile"]["rating_summary"]["mean"], 9)

        # Simulate a previously validated optional-LLM extraction.  It is soft
        # evidence and cannot become a hard block or override manual feedback.
        profile["profile"]["tag_preferences"] = [{
            "tag": "触手",
            "weight": 0.65,
            "confidence": 0.85,
            "source": "review_explicit",
            "constraint": "hard",
            "evidence_ids": ["1"],
        }]
        _atomic_json_write(self.store.profile_path, profile)
        model = self.store._build_preference_model()
        signal = model["tag_preferences"]["触手"]
        self.assertEqual(signal["source"], "review_explicit")
        self.assertEqual(signal["constraint"], "soft")
        self.assertLessEqual(signal["confidence"], 0.6)

    def test_history_omits_large_training_traces(self):
        self.store.generate_recommendations({
            "candidates": [{"id": "101", "title": "候选"}], "limit": 1,
        })
        history = self.store.recommendation_history()
        self.assertEqual(len(history), 1)
        item = history[0]["recommendations"][0]
        self.assertNotIn("prediction_signals", item)
        json.dumps(history, ensure_ascii=False)

    def test_discovery_excludes_evidence_and_real_impressions_only(self):
        self.store.upsert_comic({"id": "1", "title": "收藏", "favorite": True})
        self.store.upsert_comic({"id": "2", "title": "已评分", "rating": 8})
        self.store.record_interaction({
            "event_type": "read_start", "comic_id": "3",
            "comic": {"id": "3", "title": "读过"},
        })
        self.store.upsert_comic({"id": "4", "title": "只有元数据"})
        run = self.store.generate_recommendations({
            "candidates": [
                {"id": "5", "title": "生成但没看见"},
                {"id": "6", "title": "随后真实曝光"},
            ],
            "limit": 2,
        })
        self.assertNotIn("5", self.store.recommended_ids())
        self.store.record_interaction({
            "event_type": "recommendation_impression",
            "comic_id": "6",
            "run_id": run["id"],
        })

        excluded = set(self.store.discovery_excluded_ids())
        self.assertTrue({"1", "2", "3", "6"}.issubset(excluded))
        self.assertNotIn("4", excluded)
        self.assertNotIn("5", excluded)

    def test_recommendation_feedback_only_trains_the_selected_channel(self):
        for comic_id, tag, author, vector in (
            ("1", "封面样本标签", "封面样本作者", [1.0, 0.0]),
            ("2", "标签样本", "标签样本作者", [0.0, 1.0]),
        ):
            self.store.upsert_comic({
                "id": comic_id,
                "title": f"样本 {comic_id}",
                "tags": [tag],
                "authors": [author],
            })
            self.store.save_item_features({
                "comic_id": comic_id,
                "features": {
                    modality: {"status": "ready", "vector": vector}
                    for modality in ("cover", "title", "joint")
                },
            })

        self.store.save_recommendation_feedback({
            "comic_id": "1", "action": "not_interested", "reason": "cover",
        })
        self.store.save_recommendation_feedback({
            "comic_id": "2", "action": "interested", "reason": "tag_mix",
        })

        head = self.store._build_preference_model()["heads"]["interest"]
        self.assertNotIn("封面样本标签", head["tags"])
        self.assertIn("标签样本", head["tags"])
        self.assertEqual(head["authors"], {})
        self.assertEqual(set(head["prototypes"]), {"cover"})


if __name__ == "__main__":
    unittest.main()
