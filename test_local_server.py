import io
import json
import os
import tempfile
import threading
import time
import unittest
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from local_features import LocalFeatureStore


# Importing the server normally initializes project/data. Keep every test run
# isolated, including unittest discovery, before that initialization happens.
_server_temporary = tempfile.TemporaryDirectory()
_server_store = LocalFeatureStore(Path(_server_temporary.name))
with patch("local_features.LocalFeatureStore", return_value=_server_store):
    import local_server
local_server.LocalFeatureStore = LocalFeatureStore
local_server.DATA_DIR = _server_store.data_dir
local_server.ACCOUNT_FILE = local_server.DATA_DIR / "account.json"
local_server.SETTINGS_FILE = local_server.DATA_DIR / "settings.json"
local_server.CACHE_DIR = local_server.DATA_DIR / "cache" / "api"
local_server.IMAGE_CACHE_DIR = local_server.DATA_DIR / "cache" / "images"


def tearDownModule():
    local_server.embedding_runtime.stop()
    _server_temporary.cleanup()


class _ProxyResponse:
    status = HTTPStatus.OK

    def __init__(self, payload=b'{"ok":true}'):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return self.payload


def _handler_with_body(value):
    payload = json.dumps(value).encode("utf-8")
    handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
    handler.headers = {"Content-Length": str(len(payload))}
    handler.rfile = io.BytesIO(payload)
    handler.send_json = Mock()
    return handler


def _wait_until(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return bool(predicate())


class AtomicJsonWriteTests(unittest.TestCase):
    def test_failed_replace_removes_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "settings.json"

            with patch("local_server.os.replace", side_effect=OSError("replace failed")):
                with self.assertRaises(OSError):
                    local_server.atomic_json_write(target, {"value": 1})

            self.assertFalse(target.exists())
            self.assertEqual(list(target.parent.glob(f"{target.name}.*.tmp")), [])

    def test_successful_replace_fsyncs_parent_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "settings.json"

            with (
                patch("local_server.os.open", return_value=321) as open_directory,
                patch("local_server.os.fsync") as fsync,
                patch("local_server.os.close") as close_directory,
            ):
                local_server.atomic_json_write(target, {"value": 1})

            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"value": 1})
            open_directory.assert_called_once_with(target.parent, os.O_RDONLY)
            self.assertEqual(fsync.call_count, 2)
            fsync.assert_any_call(321)
            close_directory.assert_called_once_with(321)


class RuntimeFileReadTests(unittest.TestCase):
    def test_non_object_account_json_uses_empty_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "account.json"
            with patch.object(local_server, "ACCOUNT_FILE", target):
                for value in (None, [], "text", 3, True):
                    with self.subTest(value=value):
                        target.write_text(json.dumps(value), encoding="utf-8")
                        self.assertEqual(local_server.read_account(), {"username": "", "password": ""})

    def test_non_object_settings_json_uses_default_batch_size(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "settings.json"
            with patch.object(local_server, "SETTINGS_FILE", target):
                for value in (None, [], "text", 3, True):
                    with self.subTest(value=value):
                        target.write_text(json.dumps(value), encoding="utf-8")
                        self.assertEqual(local_server.read_settings(), {"image_load_batch_size": 5})


class LocalHandlerConfigGetTests(unittest.TestCase):
    def test_config_get_errors_are_returned_as_structured_json(self):
        routes = (
            ("/local-api/ai/config", local_server.local_features, "read_ai_config"),
            ("/local-api/ai/embeddings/config", local_server.local_features, "read_embedding_config"),
            ("/local-api/ai/embeddings/status", local_server.embedding_runtime, "status"),
        )
        error_types = (local_server.LocalFeatureError, local_server.QwenEmbeddingError)

        for path, target, method in routes:
            for error_type in error_types:
                with self.subTest(path=path, error_type=error_type.__name__):
                    handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
                    handler.path = path
                    handler.send_json = Mock()
                    with patch.object(target, method, side_effect=error_type("配置读取失败")):
                        handler.do_GET()
                    handler.send_json.assert_called_once_with(
                        {"error": "配置读取失败"},
                        status=HTTPStatus.INTERNAL_SERVER_ERROR,
                    )


class LocalHandlerBodyTests(unittest.TestCase):
    def test_json_body_must_be_an_object(self):
        for value in (None, [], [1], "text", 3, True):
            with self.subTest(value=value):
                handler = _handler_with_body(value)
                self.assertIsNone(handler.read_json_body())
                handler.send_json.assert_called_once_with(
                    {"error": "请求内容必须是 JSON 对象"},
                    status=HTTPStatus.BAD_REQUEST,
                )

    def test_json_object_body_is_returned(self):
        handler = _handler_with_body({"value": 1})
        self.assertEqual(handler.read_json_body(), {"value": 1})
        handler.send_json.assert_not_called()


class LocalHandlerResponseTests(unittest.TestCase):
    def make_handler(self):
        handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = io.BytesIO()
        handler.close_connection = False
        return handler

    def test_json_response_handles_browser_disconnect_during_headers_or_body(self):
        for phase in ("headers", "body"):
            for error in (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                with self.subTest(phase=phase, error=error.__name__):
                    handler = self.make_handler()
                    if phase == "headers":
                        handler.end_headers.side_effect = error()
                    else:
                        handler.wfile = Mock()
                        handler.wfile.write.side_effect = error()
                    handler.send_raw_json(b'{"ok":true}')
                    self.assertTrue(handler.close_connection)
                    handler.send_response.assert_called_once_with(HTTPStatus.OK)

    def test_image_response_keeps_open_file_when_cache_is_removed_during_headers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cover.img"
            payload = b"cached image data"
            path.write_bytes(payload)
            handler = self.make_handler()
            handler.end_headers.side_effect = path.unlink

            handler.send_image_file(path, "image/jpeg")

            self.assertEqual(handler.wfile.getvalue(), payload)
            handler.send_header.assert_any_call("Content-Length", str(len(payload)))

    def test_missing_image_is_reported_before_sending_success_headers(self):
        with tempfile.TemporaryDirectory() as directory:
            handler = self.make_handler()
            with self.assertRaises(local_server.ImageCacheError):
                handler.send_image_file(Path(directory) / "missing.img", "image/jpeg")
            handler.send_response.assert_not_called()


class CacheReadTests(unittest.TestCase):
    def test_non_object_api_cache_is_a_miss(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            path = cache_dir / "album" / "123.json"
            path.parent.mkdir()
            with patch.object(local_server, "CACHE_DIR", cache_dir):
                for value in (None, [], "text", 3, True):
                    with self.subTest(value=value):
                        path.write_text(json.dumps(value), encoding="utf-8")
                        handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
                        handler.path = "/local-api/cache/album/123"
                        handler.send_json = Mock()
                        handler.do_GET()
                        handler.send_json.assert_called_once_with(
                            {"hit": False}, status=HTTPStatus.NOT_FOUND,
                        )

    def test_non_object_chapter_cache_falls_back_to_source(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_dir = Path(directory)
            path = cache_dir / "chapter_names" / "123.json"
            path.parent.mkdir()
            with (
                patch.object(local_server, "CACHE_DIR", cache_dir),
                patch("local_server.discover_jm_web_origin", side_effect=local_server.ChapterNameError("source unavailable")) as discover,
            ):
                for value in (None, [], "text", 3, True):
                    with self.subTest(value=value):
                        path.write_text(json.dumps(value), encoding="utf-8")
                        discover.reset_mock()
                        with self.assertRaisesRegex(local_server.ChapterNameError, "source unavailable"):
                            local_server.get_web_chapter_names("123")
                        self.assertEqual(discover.call_count, 2)


class CheckInProxyTests(unittest.TestCase):
    def test_checkin_routes_are_exposed_without_cache(self):
        self.assertNotIn("checkin", local_server.CACHE_KINDS)
        self.assertEqual(local_server.PROXY_PATH_METHODS["/daily"], {"GET"})
        self.assertEqual(local_server.PROXY_PATH_METHODS["/daily_chk"], {"POST"})

        handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
        self.assertIsNone(handler.parse_cache_target("/local-api/cache/checkin/42"))

    def test_daily_status_get_is_forwarded_with_its_query(self):
        handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
        handler.send_json = Mock()
        handler.send_raw_json = Mock()
        state = {"server": "api.example.com", "session": "session", "user": {"uid": "42"}}
        with (
            patch.object(local_server.jm_session, "active", return_value=state),
            patch("local_server.urlopen", return_value=_ProxyResponse()) as urlopen,
        ):
            handler.proxy_jm_request({
                "path": "/daily?user_id=42",
                "method": "GET",
                "token": "token",
                "tokenParam": "1,3.2.0",
            })
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.full_url, "https://api.example.com/daily?user_id=42")
        handler.send_raw_json.assert_called_once()
        handler.send_json.assert_not_called()

    def test_each_daily_checkin_post_is_forwarded_with_daily_id(self):
        handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
        handler.send_json = Mock()
        handler.send_raw_json = Mock()
        state = {"server": "api.example.com", "session": "session", "user": {"uid": "42"}}

        with (
            patch.object(local_server.jm_session, "active", return_value=state),
            patch("local_server.urlopen", side_effect=lambda *_args, **_kwargs: _ProxyResponse()) as urlopen,
        ):
            for _ in range(2):
                handler.proxy_jm_request({
                    "path": "/daily_chk",
                    "method": "POST",
                    "data": {"user_id": "42", "daily_id": "68"},
                    "token": "token",
                    "tokenParam": "1,3.2.0",
                })

        self.assertEqual(urlopen.call_count, 2)
        for call in urlopen.call_args_list:
            request = call.args[0]
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(request.data, b"user_id=42&daily_id=68")
        self.assertEqual(handler.send_raw_json.call_count, 2)
        handler.send_json.assert_not_called()


class ImagePrefetchManagerTests(unittest.TestCase):
    servers = ["cdn-msp.jmapiproxy1.cc"]

    def test_workers_and_active_jobs_are_globally_bounded(self):
        manager = local_server.ImagePrefetchManager(max_active_jobs=2, max_workers=2)
        release = threading.Event()
        state_lock = threading.Lock()
        active = 0
        maximum_active = 0

        def blocked_download(*_args):
            nonlocal active, maximum_active
            with state_lock:
                active += 1
                maximum_active = max(maximum_active, active)
            try:
                release.wait(3)
            finally:
                with state_lock:
                    active -= 1

        jobs = []
        try:
            with patch("local_server.ensure_image_cached", side_effect=blocked_download):
                jobs.append(manager.enqueue("1", ["1.jpg", "2.jpg"], self.servers, 2))
                jobs.append(manager.enqueue("2", ["1.jpg", "2.jpg"], self.servers, 2))
                self.assertTrue(_wait_until(lambda: maximum_active == 2))
                with self.assertRaises(local_server.ImageCacheError):
                    manager.enqueue("3", ["1.jpg"], self.servers, 1)
                self.assertEqual(maximum_active, 2)
                release.set()
                self.assertTrue(_wait_until(lambda: all(job.completed for job in jobs)))

                next_job = manager.enqueue("3", ["1.jpg"], self.servers, 1)
                self.assertTrue(_wait_until(lambda: next_job.completed))
        finally:
            release.set()
            for job in jobs:
                job.cancel()

    def test_each_job_finishes_a_batch_before_starting_the_next(self):
        manager = local_server.ImagePrefetchManager(max_active_jobs=1, max_workers=4)
        release_first_batch = threading.Event()
        started = []
        started_lock = threading.Lock()

        def ordered_download(_chapter, image_path, _servers):
            with started_lock:
                started.append(image_path)
            if image_path in {"1.jpg", "2.jpg"}:
                release_first_batch.wait(3)

        job = None
        try:
            with patch("local_server.ensure_image_cached", side_effect=ordered_download):
                job = manager.enqueue(
                    "1", ["1.jpg", "2.jpg", "3.jpg", "4.jpg"], self.servers, 2,
                )
                self.assertTrue(_wait_until(lambda: len(started) == 2))
                time.sleep(0.05)
                self.assertCountEqual(started, ["1.jpg", "2.jpg"])
                release_first_batch.set()
                self.assertTrue(_wait_until(lambda: job.completed))
                self.assertCountEqual(started[2:], ["3.jpg", "4.jpg"])
        finally:
            release_first_batch.set()
            if job:
                job.cancel()

    def test_worker_thread_construction_failure_releases_global_slot(self):
        manager = local_server.ImagePrefetchManager(max_active_jobs=1, max_workers=1)
        real_thread = threading.Thread

        def build_thread(*args, **kwargs):
            target = kwargs.get("target")
            if getattr(target, "__name__", "") == "download_one_bounded":
                raise RuntimeError("worker construction failed")
            return real_thread(*args, **kwargs)

        try:
            with patch("local_server.threading.Thread", side_effect=build_thread):
                job = manager.enqueue("1", ["1.jpg"], self.servers, 1)
                self.assertTrue(_wait_until(lambda: job.completed))

            self.assertTrue(manager.worker_slots.acquire(blocking=False))
            manager.worker_slots.release()
            self.assertEqual(job.errors, {"1.jpg": "worker construction failed"})
        finally:
            manager.stop()

    def test_cancel_after_worker_slot_acquire_does_not_start_another_download(self):
        holder = {}
        ready = threading.Event()

        class CancelOnAcquire:
            def __init__(self):
                self.releases = 0

            def acquire(self, timeout=None):
                self.assert_timeout(timeout)
                ready.wait(3)
                holder["job"].cancel()
                return True

            def release(self):
                self.releases += 1

            @staticmethod
            def assert_timeout(timeout):
                if timeout != 0.1:
                    raise AssertionError(f"unexpected timeout: {timeout}")

        worker_slots = CancelOnAcquire()
        on_finished = Mock()
        with patch("local_server.ensure_image_cached") as ensure_image_cached:
            job = local_server.ImagePrefetchJob(
                "1", ["1.jpg"], self.servers, 1, worker_slots, 1, on_finished,
            )
            holder["job"] = job
            ready.set()
            self.assertTrue(_wait_until(lambda: job.completed))

        ensure_image_cached.assert_not_called()
        self.assertEqual(worker_slots.releases, 1)
        on_finished.assert_called_once_with()

    def test_stop_is_idempotent_cancels_jobs_and_rejects_new_work(self):
        manager = local_server.ImagePrefetchManager(max_active_jobs=1, max_workers=1)
        started = threading.Event()
        release = threading.Event()

        def blocked_download(*_args):
            started.set()
            release.wait(3)

        try:
            with patch("local_server.ensure_image_cached", side_effect=blocked_download):
                job = manager.enqueue("1", ["1.jpg"], self.servers, 1)
                self.assertTrue(started.wait(3))
                manager.stop()
                manager.stop()
                self.assertTrue(job.cancelled)
                self.assertIsNone(manager.get("1"))
                with self.assertRaisesRegex(local_server.ImageCacheError, "预取服务已停止"):
                    manager.enqueue("2", ["1.jpg"], self.servers, 1)
        finally:
            release.set()
            self.assertTrue(_wait_until(lambda: job.completed if "job" in locals() else True))


class ServerLifecycleTests(unittest.TestCase):
    def test_main_stops_prefetch_manager_during_shutdown(self):
        server = Mock()
        server.serve_forever.side_effect = KeyboardInterrupt

        with (
            patch.object(
                local_server.argparse.ArgumentParser,
                "parse_args",
                return_value=SimpleNamespace(host="127.0.0.1", port=8000),
            ),
            patch("local_server.ensure_runtime_files"),
            patch("local_server.cleanup_cache"),
            patch("local_server.cleanup_image_cache"),
            patch("local_server.ThreadingHTTPServer", return_value=server),
            patch.object(local_server.image_prefetch_manager, "stop") as stop_prefetch,
            patch.object(local_server.embedding_runtime, "stop") as stop_embeddings,
        ):
            local_server.main()

        stop_prefetch.assert_called_once_with()
        stop_embeddings.assert_called_once_with()
        server.server_close.assert_called_once_with()


class CacheWriteCounterTests(unittest.TestCase):
    def test_cache_write_counter_is_atomic(self):
        previous = local_server.LocalHandler.cache_writes
        local_server.LocalHandler.cache_writes = 0
        try:
            with patch("local_server.cleanup_cache") as cleanup:
                threads = [
                    threading.Thread(
                        target=lambda: [local_server.LocalHandler.record_cache_write() for _ in range(250)]
                    )
                    for _ in range(8)
                ]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()
            self.assertEqual(local_server.LocalHandler.cache_writes, 2000)
            self.assertEqual(cleanup.call_count, 80)
        finally:
            local_server.LocalHandler.cache_writes = previous


if __name__ == "__main__":
    unittest.main()
