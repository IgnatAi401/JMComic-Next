import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

from local_features import LocalFeatureStore
from rating_semantics import RatingSemantics


class RatingSemanticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = LocalFeatureStore(Path(self.temp.name))
        self.store.read_ai_config = lambda **kwargs: {"configured": True, "model": "fake", "base_url": "https://example.invalid"}
        self.store.ai_content = Mock(return_value="评价总结\n设定展开充分。\n证据不足之处\n未检查正文。")
        self.runtime = RatingSemantics(self.store)

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
        self.assertEqual(result["text"], self.store.ai_content.return_value)
        payload = json.loads(self.store.ai_content.call_args.args[0][-1]["content"])
        self.assertEqual(payload["rating"], 8)
        self.assertEqual(payload["review"], "设定展开充分，但结尾仓促。")
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
        self.assertEqual(len(self.runtime.overview()["items"]), 2)

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
            return payload["review"]
        self.store.ai_content.side_effect = remote
        self.save(review="旧版")
        self.runtime.enqueue("1")
        self.assertTrue(started.wait(2))
        self.save(review="新版")
        self.runtime.enqueue("1")
        self.runtime.enqueue("1")
        release.set()
        self.runtime.queue.join()
        self.assertEqual(self.runtime.get("1")["text"], "新版")
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
        with self.store._managed_connection() as db:
            db.execute("INSERT INTO rating_semantics VALUES(?,?,'running','','fake','',0)", ("1", digest))
        self.assertEqual(self.runtime.get("1")["status"], "missing")
        self.runtime.update_missing()
        self.runtime.queue.join()
        self.assertTrue(self.runtime.get("1")["current"])
