import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from local_features import LocalFeatureError, LocalFeatureStore
from qwen_embeddings import (
    API_PATH,
    DIMENSION,
    MODEL_ID,
    QwenEmbeddingError,
    QwenEmbeddingRuntime,
    _validate_cover_url,
)


class _Response:
    def __init__(self, payload):
        self.payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return self.payload


def _vector(index):
    value = [0.0] * DIMENSION
    value[index] = 1.0
    return value


class QwenEmbeddingRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = LocalFeatureStore(Path(self.temporary.name))
        self.store.save_embedding_config({"api_key": "sk-test-value"})
        self.runtime = QwenEmbeddingRuntime(self.store)

    def tearDown(self):
        self.runtime.stop()
        self.temporary.cleanup()

    def test_status_uses_dedicated_embedding_config(self):
        status = self.runtime.status()
        self.assertTrue(status["available"])
        self.assertEqual(status["model"], MODEL_ID)
        self.assertEqual(status["dimension"], DIMENSION)
        self.assertNotIn("api_key", status)

    def test_status_degrades_invalid_embedding_config_to_unavailable(self):
        self.store.embedding_config_path.write_text("[]", encoding="utf-8")
        status = self.runtime.status()
        self.assertFalse(status["available"])
        self.assertIn("配置格式无效", status["reason"])
        self.assertEqual(status["background_running"], 0)

    def test_enqueue_ignores_invalid_embedding_config_without_marker(self):
        self.store.embedding_config_path.write_text("[]", encoding="utf-8")
        self.runtime.enqueue_background({
            "id": "123",
            "title": "测试漫画",
            "cover_url": "https://cdn-msp.jmapiproxy1.cc/media/albums/123_3x4.jpg",
        })
        self.assertEqual(self.runtime.status()["background_running"], 0)

    def test_workspace_api_host_is_used_and_untrusted_hosts_are_rejected(self):
        workspace_base = "https://ws-example123.cn-beijing.maas.aliyuncs.com/api/v1"
        self.store.save_embedding_config({
            "api_key": "sk-ws-test-value",
            "api_base_url": workspace_base,
        })
        response = _Response({"output": {"embeddings": [
            {"index": 0, "type": "vl", "embedding": _vector(0)},
        ]}})
        with patch("qwen_embeddings.urlopen", return_value=response) as mocked:
            self.runtime.test_connection()
        self.assertEqual(mocked.call_args.args[0].full_url, workspace_base + API_PATH)
        with self.assertRaises(LocalFeatureError):
            self.store.save_embedding_config({
                "api_key": "secret",
                "api_base_url": "https://example.com/api/v1",
            })

    def test_cover_url_bad_port_raises_qwen_embedding_error(self):
        with self.assertRaisesRegex(QwenEmbeddingError, "封面地址无效"):
            _validate_cover_url(
                "123",
                "https://cdn-msp.jmapiproxy1.cc:bad/media/albums/123_3x4.jpg",
            )

    def test_candidate_uses_independent_and_fused_api_vectors_then_cache(self):
        independent = _Response({
            "output": {"embeddings": [
                {"index": 0, "type": "vl", "embedding": _vector(0)},
                {"index": 1, "type": "vl", "embedding": _vector(1)},
            ]},
            "request_id": "independent",
        })
        fused = _Response({
            "output": {"embeddings": [
                {"index": 0, "type": "fusion", "embedding": _vector(2)},
            ]},
            "request_id": "fusion",
        })
        candidate = {
            "id": "123",
            "title": "测试漫画",
            "cover_url": "https://cdn-msp.jmapiproxy1.cc/media/albums/123_3x4.jpg",
        }
        with patch("qwen_embeddings.urlopen", side_effect=[independent, fused]) as mocked:
            self.assertEqual(self.runtime.prepare_candidate(candidate), "123")
            self.assertEqual(self.runtime.prepare_candidate(candidate), "123")
        self.assertEqual(mocked.call_count, 2)
        features = self.store.get_item_features("123", include_vectors=True)
        self.assertEqual(set(features), {"cover", "title", "joint"})
        self.assertEqual(features["title"]["vector"][0], 1.0)
        self.assertEqual(features["cover"]["vector"][1], 1.0)
        self.assertEqual(features["joint"]["vector"][2], 1.0)

    def test_call_rejects_non_object_envelope_as_qwen_error(self):
        with patch("qwen_embeddings.urlopen", return_value=_Response([])):
            with self.assertRaisesRegex(QwenEmbeddingError, "返回格式无效"):
                self.runtime._call([{"text": "测试"}], fusion=False)

    def test_call_rejects_duplicate_or_missing_embedding_indexes(self):
        invalid_rows = (
            [
                {"index": 0, "embedding": _vector(0)},
                {"index": 0, "embedding": _vector(1)},
            ],
            [
                {"index": 0, "embedding": _vector(0)},
                {"index": 2, "embedding": _vector(1)},
            ],
        )
        for rows in invalid_rows:
            with self.subTest(indexes=[row["index"] for row in rows]):
                response = _Response({"output": {"embeddings": rows}})
                with patch("qwen_embeddings.urlopen", return_value=response):
                    with self.assertRaisesRegex(QwenEmbeddingError, "索引无效"):
                        self.runtime._call(
                            [{"text": "标题"}, {"image": "https://example.invalid/cover.jpg"}],
                            fusion=False,
                        )

    def test_identical_candidates_share_inflight_calls_but_keep_bulk_statistics(self):
        candidate = {
            "id": "123",
            "title": "测试漫画",
            "cover_url": "https://cdn-msp.jmapiproxy1.cc/media/albums/123_3x4.jpg",
        }
        call_count = 0
        call_lock = threading.Lock()

        def fake_call(contents, *, fusion):
            nonlocal call_count
            with call_lock:
                call_count += 1
            # Keep the first task in flight long enough for the duplicate to join it.
            time.sleep(0.03)
            return [_vector(2)] if fusion else [_vector(0), _vector(1)]

        with patch.object(self.runtime, "_call", side_effect=fake_call):
            result = self.runtime.prepare_candidates([dict(candidate), dict(candidate)])

        self.assertEqual(result["ready_ids"], ["123", "123"])
        self.assertEqual(result["ready"], 2)
        self.assertEqual(result["total"], 2)
        self.assertEqual(call_count, 2)

    def test_singleflight_failure_wakes_followers_clears_key_and_allows_retry(self):
        candidate = {
            "id": "123",
            "title": "测试漫画",
            "cover_url": "https://cdn-msp.jmapiproxy1.cc/media/albums/123_3x4.jpg",
        }
        start = threading.Barrier(2)
        first_call_entered = threading.Event()
        release_failure = threading.Event()
        call_count = 0
        call_lock = threading.Lock()

        def fail_call(_contents, *, fusion):
            nonlocal call_count
            self.assertFalse(fusion)
            with call_lock:
                call_count += 1
            first_call_entered.set()
            release_failure.wait(timeout=2)
            raise QwenEmbeddingError("模拟失败")

        def prepare_once():
            start.wait(timeout=2)
            return self.runtime.prepare_candidate(dict(candidate))

        with patch.object(self.runtime, "_call", side_effect=fail_call):
            with ThreadPoolExecutor(max_workers=2) as executor:
                futures = [executor.submit(prepare_once) for _index in range(2)]
                self.assertTrue(first_call_entered.wait(timeout=2))
                time.sleep(0.03)
                release_failure.set()
                for future in futures:
                    with self.assertRaisesRegex(QwenEmbeddingError, "模拟失败"):
                        future.result(timeout=2)

        self.assertEqual(call_count, 1)
        with self.runtime._lock:
            self.assertEqual(self.runtime._inflight_candidates, {})

        def successful_call(_contents, *, fusion):
            return [_vector(2)] if fusion else [_vector(0), _vector(1)]

        with patch.object(self.runtime, "_call", side_effect=successful_call):
            self.assertEqual(self.runtime.prepare_candidate(candidate), "123")

    def test_qwen_outbound_concurrency_is_globally_bounded_per_runtime(self):
        active = 0
        maximum_active = 0
        active_lock = threading.Lock()
        start = threading.Barrier(8)

        def fake_urlopen(_request, timeout):
            nonlocal active, maximum_active
            self.assertEqual(timeout, 120)
            with active_lock:
                active += 1
                maximum_active = max(maximum_active, active)
            try:
                time.sleep(0.04)
                return _Response({"output": {"embeddings": [
                    {"index": 0, "embedding": _vector(0)},
                ]}})
            finally:
                with active_lock:
                    active -= 1

        def call_once():
            start.wait(timeout=2)
            return self.runtime._call([{"text": "测试"}], fusion=False)

        with patch("qwen_embeddings.urlopen", side_effect=fake_urlopen):
            with ThreadPoolExecutor(max_workers=8) as executor:
                results = [future.result() for future in [
                    executor.submit(call_once) for _index in range(8)
                ]]

        self.assertEqual(len(results), 8)
        self.assertLessEqual(maximum_active, 4)
        self.assertGreater(maximum_active, 1)

    def test_enqueue_after_stop_does_not_leave_a_running_marker(self):
        self.runtime.stop()
        self.runtime.enqueue_background({
            "id": "123",
            "title": "测试漫画",
            "cover_url": "https://cdn-msp.jmapiproxy1.cc/media/albums/123_3x4.jpg",
        })
        self.assertEqual(self.runtime.status()["background_running"], 0)

    def test_background_marker_is_released_once_when_future_completes(self):
        candidate = {
            "id": "123", "title": "测试漫画",
            "cover_url": "https://cdn-msp.jmapiproxy1.cc/media/albums/123_3x4.jpg",
        }
        first = Future()
        second = Future()
        with (
            patch.object(self.runtime, "prepare_candidate", return_value="123"),
            patch.object(self.runtime._executor, "submit", side_effect=[first, second]) as submit,
        ):
            self.runtime.enqueue_background(candidate)
            first_run = submit.call_args.args[0]
            first_run()
            # A Future completes just after its callable returns. The marker
            # must survive this interval so its callback cannot clear a new job.
            self.runtime.enqueue_background(candidate)
            self.assertEqual(submit.call_count, 1)
            self.assertEqual(self.runtime.status()["background_running"], 1)
            first.set_result(None)
            self.assertEqual(self.runtime.status()["background_running"], 0)
            self.runtime.enqueue_background(candidate)
            self.assertEqual(submit.call_count, 2)
            self.assertEqual(self.runtime.status()["background_running"], 1)
            second.cancel()
            self.assertEqual(self.runtime.status()["background_running"], 0)

    def test_stop_cleans_markers_for_cancelled_and_completed_background_tasks(self):
        entered = 0
        entered_lock = threading.Lock()
        four_running = threading.Event()
        release = threading.Event()

        def blocking_prepare(candidate):
            nonlocal entered
            with entered_lock:
                entered += 1
                if entered == 4:
                    four_running.set()
            release.wait(timeout=2)
            return str(candidate["id"])

        with patch.object(self.runtime, "prepare_candidate", side_effect=blocking_prepare):
            for comic_id in range(1, 6):
                self.runtime.enqueue_background({
                    "id": str(comic_id),
                    "title": f"漫画 {comic_id}",
                    "cover_url": (
                        "https://cdn-msp.jmapiproxy1.cc/media/albums/"
                        f"{comic_id}_3x4.jpg"
                    ),
                })
            self.assertTrue(four_running.wait(timeout=2))
            self.runtime.stop()
            release.set()
            deadline = time.monotonic() + 2
            while self.runtime.status()["background_running"] and time.monotonic() < deadline:
                time.sleep(0.01)

        self.assertEqual(self.runtime.status()["background_running"], 0)

    def test_concurrent_enqueue_and_stop_never_raises_or_leaks_marker(self):
        start = threading.Barrier(4)

        def prepare_immediately(candidate):
            return str(candidate["id"])

        def enqueue_range(first_id):
            start.wait(timeout=2)
            for comic_id in range(first_id, first_id + 100):
                self.runtime.enqueue_background({
                    "id": str(comic_id),
                    "title": f"漫画 {comic_id}",
                    "cover_url": f"https://example.invalid/{comic_id}.jpg",
                })

        def stop_runtime():
            start.wait(timeout=2)
            self.runtime.stop()

        with patch.object(self.runtime, "prepare_candidate", side_effect=prepare_immediately):
            with ThreadPoolExecutor(max_workers=3) as executor:
                futures = [
                    executor.submit(enqueue_range, 1),
                    executor.submit(enqueue_range, 1001),
                    executor.submit(stop_runtime),
                ]
                start.wait(timeout=2)
                for future in futures:
                    future.result(timeout=3)

        deadline = time.monotonic() + 2
        while self.runtime.status()["background_running"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(self.runtime.status()["background_running"], 0)


if __name__ == "__main__":
    unittest.main()
