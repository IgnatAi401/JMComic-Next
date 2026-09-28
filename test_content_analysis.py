import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

from local_features import LocalFeatureStore
from content_analysis import ContentAnalysis


class ContentAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = LocalFeatureStore(Path(self.temp.name))
        self.store.read_ai_config = lambda **kwargs: {"configured": True, "model": "fake", "base_url": "https://example.invalid"}
        self.store.ai_content = Mock(return_value=json.dumps({"summary": "记忆交换影响人物关系", "assertions": {"development": {"value": 0.8, "source": "user_review", "quote": "设定展开充分"}}}, ensure_ascii=False))
        self.runtime = ContentAnalysis(self.store)

    def tearDown(self):
        self.runtime.queue.join()
        self.runtime.stop()
        if self.runtime.worker:
            self.runtime.worker.join(2)
        self.temp.cleanup()

    def save(self, **values):
        return self.store.upsert_comic({"id": "1", "title": "测试作品", "rating": 8, **values})

    def test_rating_and_review_sent_once_and_full_text_returned(self):
        self.save(review="设定展开充分，但结尾仓促。", favorite=True)
        self.runtime.enqueue("1")
        self.runtime.queue.join()
        result = self.runtime.get("1")
        self.assertTrue(result["current"])
        self.assertNotIn(self.store.ai_content.return_value, result["text"])
        self.assertIn("记忆交换影响人物关系", result["text"])
        self.assertIn("1", self.runtime.content.features())
        self.assertEqual(self.runtime.content.features()["1"]["assertions"]["development"]["value"], 0.8)
        payload = json.loads(self.store.ai_content.call_args.args[0][-1]["content"])
        self.assertNotIn("rating", payload)
        self.assertEqual(payload["user_review"], "设定展开充分，但结尾仓促。")
        self.runtime.enqueue("1")
        self.runtime.update_missing()
        self.runtime.queue.join()
        self.assertEqual(self.store.ai_content.call_count, 1)
        self.assertTrue(self.store.get_comic("1")["favorite"])

    def test_bulk_includes_missing_changed_rating_changed_review_and_failed(self):
        self.save(review="旧评语")
        self.runtime.enqueue("1")
        self.runtime.queue.join()
        self.save(review="新评语")
        self.assertEqual(self.runtime.get("1")["status"], "stale")
        self.store.upsert_comic({"id": "2", "rating": 6})
        self.store.upsert_comic({"id": "3", "favorite": True})
        self.runtime.update_missing()
        self.runtime.queue.join()
        self.assertEqual(self.store.ai_content.call_count, 3)
        self.save(rating=9, review="新评语")
        self.runtime.update_missing()
        self.runtime.queue.join()
        self.assertEqual(self.store.ai_content.call_count, 4)
        self.assertEqual(len(self.runtime.overview()["items"]), 0)
        self.assertEqual(self.runtime.overview()["counts"]["ready"], 2)

    def test_failure_preserves_rating_review_and_is_retriable(self):
        self.save(review="保留评语")
        self.store.ai_content.side_effect = RuntimeError("private provider response")
        self.runtime.enqueue("1")
        self.runtime.queue.join()
        self.assertEqual(self.runtime.get("1")["status"], "error")
        self.assertNotIn("private", self.runtime.get("1")["error"])
        self.assertEqual(self.store.get_comic("1")["review"], "保留评语")
        self.store.ai_content.side_effect = None
        self.runtime.update_missing()
        self.runtime.queue.join()
        self.assertTrue(self.runtime.get("1")["current"])

    def test_stale_completion_cannot_overwrite_new_review(self):
        started, release = threading.Event(), threading.Event()
        def remote(messages, **kwargs):
            payload = json.loads(messages[-1]["content"])
            started.set()
            release.wait(3)
            return json.dumps({"summary": payload["user_review"], "assertions": {}})
        self.store.ai_content.side_effect = remote
        self.save(review="旧版")
        self.runtime.enqueue("1")
        self.assertTrue(started.wait(2))
        self.save(review="新版")
        self.runtime.enqueue("1")
        self.runtime.enqueue("1")
        release.set()
        self.runtime.queue.join()
        self.assertIn("新版", self.runtime.get("1")["text"])
        self.assertNotIn("旧版", self.runtime.get("1")["text"])
        self.assertEqual(self.store.ai_content.call_count, 2)

    def test_clearing_rating_hides_summary_and_prevents_stale_write(self):
        self.save()
        self.runtime.enqueue("1")
        self.runtime.queue.join()
        self.save(rating=None)
        self.runtime.enqueue("1")
        self.assertEqual(self.runtime.get("1")["status"], "unrated")
        self.assertEqual(self.runtime.get("1")["text"], "")

    def test_no_model_saves_state_without_remote_call(self):
        self.store.read_ai_config = lambda **kwargs: {"configured": False}
        self.save()
        self.assertEqual(self.runtime.enqueue("1")["status"], "unconfigured")
        self.assertEqual(self.runtime.update_missing()["counts"]["unconfigured"], 1)
        self.store.ai_content.assert_not_called()

    def test_restart_exposes_interrupted_work_as_missing_for_bulk_retry(self):
        self.save()
        digest = self.runtime.snapshot(self.store.get_comic("1"))[0]
        # No result was committed before interruption; a fresh manager can retry.
        self.runtime = ContentAnalysis(self.store)
        self.assertEqual(self.runtime.get("1")["status"], "missing")
        self.runtime.update_missing()
        self.runtime.queue.join()
        self.assertTrue(self.runtime.get("1")["current"])

    def test_saved_analysis_is_the_ranker_input_and_review_invalidates_it(self):
        self.save(review="设定展开充分")
        self.runtime.enqueue("1")
        self.runtime.queue.join()
        model = self.store._build_preference_model()
        self.assertEqual(model["ranker"].features(self.store.get_comic("1"))["content:development"], 0.8)
        self.save(review="修改了内容描述")
        self.assertNotIn("1", self.store._build_preference_model()["content"])
        self.assertTrue(self.runtime.content.plan([])["training"])

    def test_recommendation_analysis_and_background_share_cache(self):
        self.save(review="设定展开充分")
        self.runtime.content.prepare({"id": "1", "title": "测试作品"})
        self.assertTrue(self.runtime.get("1")["current"])
        self.runtime.update_missing()
        self.runtime.queue.join()
        self.assertEqual(self.store.ai_content.call_count, 1)
        self.runtime.content.prepare({"id": "2", "title": "候选作品"})
        self.store.upsert_comic({"id": "2", "title": "候选作品", "favorite": True})
        self.assertIn("2", self.runtime.content.features())
        self.assertEqual(self.runtime.get("2")["status"], "unrated")

    def test_parallel_recommendation_and_background_do_not_duplicate_calls(self):
        started, release = threading.Event(), threading.Event()
        def remote(*args, **kwargs):
            started.set()
            release.wait(3)
            return '{"summary":"作品内容","assertions":{}}'
        self.store.ai_content.side_effect = remote
        self.save()
        self.runtime.enqueue("1")
        self.assertTrue(started.wait(2))
        thread = threading.Thread(target=lambda: self.runtime.content.prepare({"id": "1", "title": "测试作品"}))
        thread.start()
        release.set()
        thread.join(3)
        self.runtime.queue.join()
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.store.ai_content.call_count, 1)

    def test_cleared_rating_during_request_never_commits_review_evidence(self):
        started, release = threading.Event(), threading.Event()
        def remote(*args, **kwargs):
            started.set()
            release.wait(3)
            return '{"assertions":{}}'
        self.store.ai_content.side_effect = remote
        self.save(review="设定展开充分")
        self.runtime.enqueue("1")
        self.assertTrue(started.wait(2))
        self.save(rating=None)
        self.runtime.enqueue("1")
        release.set()
        self.runtime.queue.join()
        self.assertNotIn("1", self.runtime.content.features())
        self.assertEqual(self.runtime.get("1")["status"], "unrated")

    def test_legacy_summary_cleanup_preserves_user_data(self):
        self.save(review="保留评语", favorite=True)
        with self.store._managed_connection() as db:
            db.execute("CREATE TABLE rating_semantics (text TEXT)")
            db.execute("INSERT INTO rating_semantics VALUES ('旧总结')")
        reopened = LocalFeatureStore(Path(self.temp.name))
        comic = reopened.get_comic("1")
        self.assertEqual(comic["rating"], 8)
        self.assertEqual(comic["review"], "保留评语")
        self.assertTrue(comic["favorite"])
        with reopened._managed_connection() as db:
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='rating_semantics'").fetchone())

    def test_source_loader_supplies_description_and_comments_before_llm(self):
        self.save()
        self.runtime.source_loader = Mock(return_value={"description": "虚构简介内容", "description_fetched": True,
            "comments": [{"content": "读者对展开的描述"}], "comments_status": "ready", "comments_total": 1})
        self.runtime.enqueue("1")
        self.runtime.queue.join()
        payload = json.loads(self.store.ai_content.call_args.args[0][-1]["content"])
        self.assertEqual(payload["description"], "虚构简介内容")
        self.assertEqual(payload["comment:0"], "读者对展开的描述")
        self.assertTrue(self.runtime.get("1")["current"])

    def test_source_failure_does_not_spend_llm_call(self):
        self.save()
        self.runtime.source_loader = Mock(side_effect=ValueError("fetch failed"))
        self.runtime.enqueue("1")
        self.runtime.queue.join()
        self.assertEqual(self.runtime.get("1")["status"], "error")
        self.store.ai_content.assert_not_called()

    def test_old_empty_materials_can_be_completed(self):
        self.save()
        self.runtime.content.prepare({"id": "1", "title": "测试作品"})
        self.runtime.source_loader = Mock(return_value={"description": "", "description_fetched": True,
            "comments": [], "comments_status": "ready", "comments_total": 0})
        self.assertFalse(self.runtime.get("1")["current"])
        self.runtime.update_missing()
        self.runtime.queue.join()
        self.assertTrue(self.runtime.get("1")["current"])
