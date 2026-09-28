import json
import tempfile
import unittest
from pathlib import Path

from local_features import LocalFeatureStore, _atomic_json_write
from recommender import ENGINE, PreferenceModel, feedback_adjustment, rating_outcome
from content_evidence import ContentEvidence
from unittest.mock import Mock


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
        self.assertEqual(result["ranking_engine"], ENGINE)
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
            result["recommendations"][0]["score_breakdown"][0]["contribution"],
            result["recommendations"][1]["score_breakdown"][0]["contribution"],
        )

    def test_cover_embedding_changes_total_rating_ranking(self):
        for comic_id, rating, vector in (("1", 10, [1, 0]), ("2", 1, [-1, 0]), ("3", 9, [1, 0]), ("4", 6, [-1, 0])):
            self.store.upsert_comic({
                "id": comic_id, "title": comic_id,
                "rating": rating,
            })
            self.store.save_item_features({
                "comic_id": comic_id,
                "features": {"cover": {"status": "ready", "vector": vector}},
            })
        for cid, vector in (("101", [0.99, 0.01]), ("102", [-0.99, 0.01])):
            self.store.upsert_comic({"id": cid})
            self.store.save_item_features({"comic_id": cid, "features": {"cover": {"status": "ready", "vector": vector}}})
        result = self.store.generate_recommendations({
            "limit": 2,
            "candidates": [
                {"id": "101", "title": "接近正样本"},
                {"id": "102", "title": "接近负样本"},
            ],
        })
        positive, negative = result["recommendations"]
        self.assertEqual(positive["id"], "101")
        self.assertGreater(positive["score"], negative["score"])
        self.assertGreater(
            positive["score_breakdown"][0]["contribution"],
            negative["score_breakdown"][0]["contribution"],
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
        # Saved narrative/profile is disposable and never trains the new ranker.
        self.assertNotIn("触手", model["tag_preferences"])

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

        model = self.store._build_preference_model()
        same_tags = {"id": "101", "tags": ["封面样本标签"], "authors": ["封面样本作者"]}
        self.assertEqual(feedback_adjustment(same_tags, model["rows"], model["vectors"]), 0)
        model["vectors"]["101"] = {"cover": [1, 0]}
        self.assertLess(feedback_adjustment(same_tags, model["rows"], model["vectors"]), 0)

    def test_six_is_not_positive_and_passive_events_do_not_train(self):
        self.assertLess(rating_outcome(6), 0)
        self.assertGreater(rating_outcome(7), 0)
        self.assertGreater(rating_outcome(10), rating_outcome(7))
        self.store.upsert_comic({"id": "1", "rating": 9, "tags": ["甲"]})
        self.store.upsert_comic({"id": "2", "rating": 6, "tags": ["乙"]})
        candidate = {"id": "100", "tags": ["乙"], "authors": []}
        before = self.store._build_preference_model()["ranker"].predict(candidate)[0]
        for _ in range(10):
            self.store.record_interaction({"event_type": "read_complete", "comic_id": "2"})
        after = self.store._build_preference_model()["ranker"].predict(candidate)[0]
        self.assertEqual(before, after)

    def test_unknown_content_is_neutral_and_training_is_deterministic(self):
        rows = [{"id": str(i), "rating": 9 if i < 4 else 6} for i in range(8)]
        content = {str(i): {"assertions": {"mechanism": {"value": 1 if i < 4 else 0}}} for i in range(8)}
        model = PreferenceModel(rows, content, {}, mode="content")
        self.assertGreater(model.predict({"id": "1"})[0], model.predict({"id": "5"})[0])
        self.assertAlmostEqual(model.predict({"id": "unknown"})[0], 50, delta=1)
        other = PreferenceModel(list(reversed(rows)), content, {}, mode="content")
        self.assertEqual(model.weights, other.weights)

    def test_retiring_results_preserves_all_user_evidence(self):
        self.store.upsert_comic({"id": "1", "rating": 9, "favorite": True, "review": "保留评语", "tags": ["甲"], "tag_feedback": {"甲": 1}})
        run = self.store.generate_recommendations({"candidates": [{"id": "1", "title": "作品", "tags": ["甲"]}]})
        self.store.save_recommendation_feedback({"comic_id": "1", "run_id": run["id"], "action": "interested", "reason": "cover"})
        self.store.record_interaction({"comic_id": "1", "run_id": run["id"], "event_type": "recommendation_impression"})
        before = self.store.get_comic("1")
        with self.store._managed_connection() as db:
            db.execute("DELETE FROM local_schema_migrations WHERE name='personal_content_v2_results'")
        replacement = LocalFeatureStore(self.store.data_dir)
        after = replacement.get_comic("1")
        for key in ("rating", "favorite", "review", "tag_feedback"):
            self.assertEqual(before[key], after[key])
        self.assertEqual(after["interest_feedback"]["cover"], {**before["interest_feedback"]["cover"], "run_id": None})
        self.assertEqual(replacement.recommendation_history(), [])
        self.assertEqual(len(replacement.list_interactions()), 1)
        self.assertIsNone(replacement.list_interactions()[0]["run_id"])
        self.assertEqual(replacement.recommended_ids(), [])


class ContentEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = LocalFeatureStore(Path(self.temp.name))
        self.store.read_ai_config = lambda **kwargs: {"configured": True, "model": "test", "base_url": "https://example.test/v1"}
        self.runtime = ContentEvidence(self.store)

    def tearDown(self):
        self.temp.cleanup()

    def test_extraction_is_blind_grounded_cached_and_deduplicated(self):
        self.store.ai_content = Mock(return_value=json.dumps({"assertions": {
            "mechanism": {"value": 1, "source": "comment:0", "quote": "有明确的独特设定"},
            "formulaic": {"value": 1, "source": "comment:0", "quote": "凭空编造的内容"},
        }}))
        value = {"id": "1", "title": "测试", "rating": 9, "review": "私人评语",
                 "comments_status": "ready", "comments_total": 200,
                 "comments": [{"content": "有明确的独特设定"}, {"content": "有明确的独特设定"}]}
        self.runtime.prepare(value)
        result = self.runtime.prepare(value)
        self.assertEqual(result["status"], "cached")
        self.assertEqual(self.store.ai_content.call_count, 1)
        request = self.store.ai_content.call_args.args[0][-1]["content"]
        self.assertNotIn("rating", request)
        self.assertNotIn("私人评语", request)
        saved = self.runtime.features()["1"]
        self.assertEqual(set(saved["assertions"]), {"mechanism"})
        self.assertEqual(saved["source"]["fetched_count"], 1)
        self.assertEqual(saved["source"]["platform_total"], 200)

    def test_failure_does_not_block_ranking_and_does_not_become_a_negative(self):
        self.store.ai_content = Mock(side_effect=RuntimeError("provider failed"))
        self.assertEqual(self.runtime.prepare({"id": "1", "title": "测试"})["status"], "error")
        self.assertEqual(self.runtime.features(), {})
        result = self.store.generate_recommendations({"candidates": [{"id": "1", "title": "测试"}]})
        self.assertEqual(len(result["recommendations"]), 1)

    def test_model_change_invalidates_cached_evidence(self):
        self.store.ai_content = Mock(return_value='{"assertions":{}}')
        self.runtime.prepare({"id": "1", "title": "测试"})
        self.store.read_ai_config = lambda **kwargs: {"configured": True, "model": "new"}
        self.assertEqual(self.runtime.features(), {})
        self.assertEqual(len(self.runtime.plan([{"id": "1", "title": "测试"}])["candidates"]), 1)


if __name__ == "__main__":
    unittest.main()
