import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from local_features import LocalFeatureError, LocalFeatureStore, _atomic_json_write


class PreferenceModelTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = LocalFeatureStore(Path(self.temporary.name))

    def tearDown(self):
        self.temporary.cleanup()

    def save_comic(self, comic_id, tags, rating=None, tag_feedback=None):
        value = {
            "id": str(comic_id),
            "title": f"漫画 {comic_id}",
            "authors": ["作者"],
            "tags": tags,
            "rating": rating,
        }
        if tag_feedback is not None:
            value["tag_feedback"] = tag_feedback
        return self.store.upsert_comic(value)

    def test_tag_feedback_round_trip_and_clear(self):
        saved = self.save_comic(1, ["剧情", "触手"], 9, {"剧情": 1, "触手": -1})
        self.assertEqual(saved["tag_feedback"], {"剧情": 1, "触手": -1})
        self.assertEqual(self.store.get_comic("1")["tag_feedback"]["触手"], -1)

        cleared = self.store.upsert_comic({"id": "1", "tag_feedback": {}})
        self.assertEqual(cleared["tag_feedback"], {})

    def test_explicit_dislike_is_not_reversed_by_high_rating(self):
        self.save_comic(1, ["剧情", "触手"], 9, {"剧情": 1, "触手": -1})
        self.save_comic(2, ["剧情"], 9)
        self.save_comic(3, ["触手"], 8)
        signals, _, _ = self.store._derive_tag_preferences(self.store.list_comics("evidence"))
        by_tag = {item["tag"]: item for item in signals}

        self.assertGreater(by_tag["剧情"]["weight"], 0)
        self.assertEqual(by_tag["触手"]["source"], "explicit")
        self.assertLess(by_tag["触手"]["weight"], 0)
        self.assertEqual(by_tag["触手"]["constraint"], "soft")

    def test_explicit_tag_confidence_grows_and_saturates_with_repeated_evidence(self):
        self.save_comic(1, ["剧情"], tag_feedback={"剧情": 1})
        first, _, _ = self.store._derive_tag_preferences(self.store.list_comics("evidence"))
        first_signal = {item["tag"]: item for item in first}["剧情"]

        for comic_id in range(2, 11):
            self.save_comic(comic_id, ["剧情"], tag_feedback={"剧情": 1})
        repeated, _, _ = self.store._derive_tag_preferences(self.store.list_comics("evidence"))
        repeated_signal = {item["tag"]: item for item in repeated}["剧情"]

        self.assertEqual(first_signal["weight"], 0.65)
        self.assertEqual(repeated_signal["weight"], 0.65)
        self.assertEqual(first_signal["confidence"], 0.65)
        self.assertGreater(repeated_signal["confidence"], first_signal["confidence"])
        self.assertLessEqual(repeated_signal["confidence"], 0.95)
        self.assertGreater(
            repeated_signal["weight"] * repeated_signal["confidence"],
            first_signal["weight"] * first_signal["confidence"],
        )

    def test_single_explicit_hard_block_remains_immediate(self):
        self.save_comic(1, ["触手"], tag_feedback={"触手": -2})
        signals, _, _ = self.store._derive_tag_preferences(self.store.list_comics("evidence"))
        signal = {item["tag"]: item for item in signals}["触手"]

        self.assertEqual(signal["confidence"], 0.65)
        self.assertEqual(signal["constraint"], "hard")
        result = self.store._score_candidate_structured(
            self.store._build_preference_model(),
            {"id": "101", "title": "屏蔽候选", "authors": [], "tags": ["触手"]},
            {},
        )
        self.assertIsNone(result)

    def test_hard_block_filters_candidate_and_ai_score_is_bounded(self):
        self.save_comic(1, ["剧情", "触手"], 9, {"剧情": 1, "触手": -2})
        self.save_comic(2, ["剧情"], 9)
        self.save_comic(3, ["日常"], 6)
        profile = {
            "schema_version": 2,
            "generated_at": 1,
            "model": "test",
            "evidence_count": 3,
            "profile": {
                "summary": "测试画像",
                "preferred_authors": [],
                "tag_preferences": [
                    {"tag": "剧情", "weight": 0.65, "confidence": 1, "source": "explicit", "constraint": "soft"},
                    {"tag": "触手", "weight": -1, "confidence": 1, "source": "explicit", "constraint": "hard"},
                ],
            },
        }
        _atomic_json_write(self.store.profile_path, profile)

        def fake_ai_json(messages, **_kwargs):
            payload = __import__("json").loads(messages[-1]["content"])
            return {
                "recommendations": [
                    {"id": item["id"], "score": 100, "reason": "测试理由"}
                    for item in payload["candidates"]
                ]
            }

        self.store.ai_json = fake_ai_json
        result = self.store.generate_recommendations({
            "candidates": [
                {"id": "101", "title": "剧情候选", "authors": [], "tags": ["剧情"]},
                {"id": "102", "title": "屏蔽候选", "authors": [], "tags": ["剧情", "触手"]},
            ],
            "limit": 10,
            "filters": {},
        })

        self.assertEqual(result["blocked_by_preferences"], 1)
        self.assertEqual([item["id"] for item in result["recommendations"]], ["101"])
        item = result["recommendations"][0]
        self.assertLessEqual(item["score"], item["local_score"] + 12)
        feedback = self.store.save_recommendation_feedback({
            "comic_id": "101", "run_id": result["id"], "action": "interested",
        })
        self.assertTrue(feedback["saved"])

    def test_review_signal_must_reference_a_reviewed_comic_with_that_tag(self):
        evidence = [
            {
                "id": "1", "tags": ["触手", "剧情"], "review": "整体不错，但不喜欢触手。",
                "rating": 9, "favorite": False, "tag_feedback": {},
            },
            {
                "id": "2", "tags": ["剧情"], "review": "", "rating": 8,
                "favorite": False, "tag_feedback": {},
            },
        ]
        narrative = {"explicit_review_tag_signals": [
            {"tag": "触手", "sentiment": "soft_dislike", "evidence_ids": ["1"]},
            {"tag": "不存在", "sentiment": "hard_block", "evidence_ids": ["1"]},
            {"tag": "剧情", "sentiment": "like", "evidence_ids": ["2"]},
        ]}
        result = self.store._merge_review_tag_preferences([], narrative, evidence)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["tag"], "触手")
        self.assertEqual(result[0]["source"], "review_explicit")
        self.assertLess(result[0]["weight"], 0)

    def test_feedback_can_create_comic_and_overall_rejection_records_dismiss(self):
        feedback = self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "not_interested",
            "reason": "overall",
            "source": "recommendation_feedback",
            "comic": {
                "id": "778899",
                "title": "随机漫画",
                "authors": ["随机作者"],
                "tags": ["测试标签"],
                "cover_url": "https://example.test/778899.jpg",
            },
        })

        comic = self.store.get_comic("778899")
        self.assertEqual(comic["title"], "随机漫画")
        self.assertNotIn("willing_to_try", comic)
        self.assertEqual(comic["interest_feedback"]["overall"]["action"], "not_interested")
        self.assertEqual(feedback["source"], "recommendation_feedback")
        with sqlite3.connect(self.store.database_path) as connection:
            source = connection.execute(
                "SELECT source FROM interaction_events WHERE comic_id=? AND event_type='dismiss'",
                ("778899",),
            ).fetchone()[0]
        self.assertEqual(source, "recommendation_feedback")

    def test_feedback_states_are_independent_and_each_dimension_is_upserted(self):
        self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "not_interested",
            "reason": "cover",
            "source": "recommendation_feedback",
            "comic": {"id": "778899", "title": "随机漫画"},
        })
        self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "interested",
            "reason": "overall",
            "source": "recommendation_feedback",
        })
        self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "interested",
            "reason": "cover",
            "source": "recommendation_feedback",
        })
        self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "not_interested",
            "reason": "cover",
            "source": "recommendation_feedback",
        })

        states = self.store.feedback_states(["778899", "778899", "bad"])["states"]
        self.assertEqual(states["778899"]["overall"]["action"], "interested")
        self.assertEqual(states["778899"]["cover"]["action"], "not_interested")
        with sqlite3.connect(self.store.database_path) as connection:
            active_count = connection.execute(
                "SELECT COUNT(*) FROM comic_interest_feedback WHERE comic_id=?",
                ("778899",),
            ).fetchone()[0]
        self.assertEqual(active_count, 2)
        history = self.store._recommendation_history_map()["778899"]
        self.assertIn("interested", history)
        self.assertNotIn("not_interested", history)
        self.assertNotIn("dismiss", history)

    def test_clicking_selected_feedback_again_clears_only_that_dimension(self):
        self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "not_interested",
            "reason": "overall",
            "source": "recommendation_feedback",
            "comic": {"id": "778899", "title": "随机漫画"},
        })
        self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "interested",
            "reason": "cover",
            "source": "recommendation_feedback",
        })

        cleared_interest = self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "clear",
            "reason": "cover",
            "source": "recommendation_feedback",
        })

        self.assertIsNone(cleared_interest["state"])
        self.assertNotIn("willing_to_try", cleared_interest)
        self.assertNotIn("cover", cleared_interest["interest_feedback"])
        self.assertEqual(
            cleared_interest["interest_feedback"]["overall"]["action"],
            "not_interested",
        )

        cleared_rejection = self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "clear",
            "reason": "overall",
            "source": "recommendation_feedback",
        })

        self.assertIsNone(cleared_rejection["state"])
        self.assertNotIn("willing_to_try", cleared_rejection)
        self.assertEqual(cleared_rejection["interest_feedback"], {})
        with sqlite3.connect(self.store.database_path) as connection:
            dismiss_count = connection.execute(
                "SELECT COUNT(*) FROM interaction_events WHERE comic_id=? AND event_type='dismiss'",
                ("778899",),
            ).fetchone()[0]
        self.assertEqual(dismiss_count, 0)
        self.assertNotIn(
            "not_interested",
            self.store._recommendation_history_map().get("778899", {}),
        )

    def test_changing_overall_rejection_to_interest_removes_derived_dismiss(self):
        self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "not_interested",
            "reason": "overall",
            "comic": {"id": "778899", "title": "随机漫画"},
        })
        self.store.save_recommendation_feedback({
            "comic_id": "778899",
            "action": "interested",
            "reason": "overall",
        })

        history = self.store._recommendation_history_map()["778899"]
        self.assertIn("interested", history)
        self.assertNotIn("dismiss", history)
        with sqlite3.connect(self.store.database_path) as connection:
            dismiss_count = connection.execute(
                "SELECT COUNT(*) FROM interaction_events WHERE comic_id=? AND event_type='dismiss'",
                ("778899",),
            ).fetchone()[0]
        self.assertEqual(dismiss_count, 0)

    def test_retired_willing_field_is_ignored_for_new_and_existing_comics(self):
        existing = self.store.upsert_comic({
            "id": "778899", "title": "已有漫画", "rating": 8,
            "willing_to_try": True,
        })
        created = self.store.upsert_comic({
            "id": "778900", "title": "新漫画", "willing_to_try": True,
        })

        self.assertEqual(existing["interest_feedback"], {})
        self.assertEqual(created["interest_feedback"], {})
        self.assertNotIn("willing_to_try", existing)
        self.assertNotIn("willing_to_try", created)

    def test_legacy_feedback_tables_and_only_their_derived_states_are_removed(self):
        self.store.upsert_comic({"id": "778899", "title": "迁移样本"})
        with sqlite3.connect(self.store.database_path) as connection:
            connection.execute(
                "DELETE FROM local_schema_migrations WHERE name='legacy_feedback_removed_v2'"
            )
            connection.execute(
                "INSERT OR REPLACE INTO local_schema_migrations(name,applied_at) VALUES('interest_feedback_v1',200)"
            )
            connection.executescript(
                """
                CREATE TABLE comic_feedback (
                    comic_id TEXT, channel TEXT, value REAL, source TEXT,
                    evidence TEXT, updated_at INTEGER
                );
                CREATE TABLE recommendation_feedback (
                    id INTEGER PRIMARY KEY, comic_id TEXT, run_id INTEGER,
                    action TEXT, reason TEXT, created_at INTEGER
                );
                """
            )
            connection.execute(
                "INSERT INTO comic_feedback VALUES(?,?,?,?,?,?)",
                ("778899", "willing_to_try", 1, "explicit", "", 100),
            )
            connection.execute(
                "INSERT INTO recommendation_feedback VALUES(NULL,?,?,?,?,?)",
                ("778899", None, "not_interested", "cover", 120),
            )
            connection.executemany(
                """INSERT INTO comic_interest_feedback(
                       comic_id,reason,action,run_id,source,updated_at
                   ) VALUES(?,?,?,?,?,?)""",
                [
                    ("778899", "overall", "interested", None, "explicit", 100),
                    ("778899", "cover", "not_interested", None, "recommendation_feedback", 120),
                    ("778899", "author", "interested", None, "recommendation_feedback", 300),
                ],
            )
        self.store.ensure_files()

        states = self.store.feedback_states(["778899"])["states"]["778899"]
        self.assertEqual(set(states), {"author"})
        with sqlite3.connect(self.store.database_path) as connection:
            tables = {
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
        self.assertNotIn("comic_feedback", tables)
        self.assertNotIn("recommendation_feedback", tables)

    def test_config_top_level_array_raises_domain_error(self):
        readers = (
            (self.store.ai_config_path, self.store.read_ai_config),
            (self.store.embedding_config_path, self.store.read_embedding_config),
        )
        for path, reader in readers:
            with self.subTest(path=path.name):
                path.write_text("[]", encoding="utf-8")
                with self.assertRaisesRegex(LocalFeatureError, "配置格式无效"):
                    reader()

    def test_bad_config_ports_raise_domain_errors(self):
        with self.assertRaisesRegex(LocalFeatureError, "DashScope Base URL"):
            self.store.save_embedding_config({
                "api_key": "secret",
                "api_base_url": "https://dashscope.aliyuncs.com:bad/api/v1",
            })
        with self.assertRaisesRegex(LocalFeatureError, "AI Base URL"):
            self.store.save_ai_config({
                "api_key": "secret",
                "base_url": "https://example.com:bad/v1",
                "model": "test",
            })

    def test_database_connection_is_closed_after_store_operation(self):
        connection = self.store.connect()
        with patch.object(self.store, "connect", return_value=connection):
            self.store.stats()
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")

    def test_database_connection_rolls_back_and_closes_after_error(self):
        connection = self.store.connect()
        with patch.object(self.store, "connect", return_value=connection):
            with self.assertRaisesRegex(LocalFeatureError, "ready 特征必须包含"):
                self.store.save_item_features({
                    "comic_id": "1",
                    "comic": {"id": "1", "title": "不会提交"},
                    "features": {"cover": {"status": "ready"}},
                })
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")
        self.assertIsNone(self.store.get_comic("1"))

    def test_atomic_json_write_removes_temporary_file_after_replace_failure(self):
        target = Path(self.temporary.name) / "atomic.json"
        with patch("local_features.os.replace", side_effect=OSError("replace failed")):
            with self.assertRaises(OSError):
                _atomic_json_write(target, {"ok": True})
        self.assertFalse(target.exists())
        self.assertEqual(list(target.parent.glob("atomic.json.*.tmp")), [])

    def test_atomic_json_write_fsyncs_file_and_parent_directory(self):
        target = Path(self.temporary.name) / "durable.json"
        with (
            patch("local_features.os.open", return_value=123) as mocked_open,
            patch("local_features.os.fsync") as mocked_fsync,
            patch("local_features.os.close") as mocked_close,
        ):
            _atomic_json_write(target, {"ok": True})
        mocked_open.assert_called_once_with(target.parent, os.O_RDONLY)
        self.assertEqual(mocked_fsync.call_count, 2)
        mocked_fsync.assert_any_call(123)
        mocked_close.assert_called_once_with(123)


if __name__ == "__main__":
    unittest.main()
