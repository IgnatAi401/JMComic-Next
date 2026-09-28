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
local_server.CACHE_DIR = local_server.DATA_DIR / "cache" / "api"


def tearDownModule():
    local_server.embedding_runtime.stop()
    local_server.content_analysis.stop()
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
    def test_rating_save_is_committed_before_summary_and_survives_summary_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LocalFeatureStore(Path(directory))
            def fail_after_commit(comic_id):
                self.assertEqual(store.get_comic(comic_id)["rating"], 8)
                self.assertEqual(store.get_comic(comic_id)["review"], "我的评语")
                raise RuntimeError("unavailable")
            runtime = Mock()
            runtime.enqueue.side_effect = fail_after_commit
            handler = _handler_with_body({"id": "99", "rating": 8, "review": "我的评语"})
            handler.path = "/local-api/library/comic"
            with patch.object(local_server, "local_features", store), patch.object(local_server, "content_analysis", runtime), \
                 patch.object(local_server.embedding_runtime, "enqueue_background"):
                handler.do_POST()
            result = handler.send_json.call_args.args[0]
            self.assertEqual(result["comic"]["rating"], 8)
            self.assertEqual(result["content_analysis"]["status"], "error")

    def test_recommendation_route_does_not_require_embeddings(self):
        handler = _handler_with_body({"candidates": [{"id": "1", "title": "候选"}]})
        handler.path = "/local-api/ai/recommendations/generate"
        expected = {"recommendations": [{"id": "1"}]}
        with patch.object(local_server.local_features, "generate_recommendations", return_value=expected), \
             patch.object(local_server.embedding_runtime, "prepare_candidates", side_effect=AssertionError("not needed")):
            handler.do_POST()
        handler.send_json.assert_called_once_with(expected)

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


class ServerLifecycleTests(unittest.TestCase):
    def test_main_stops_embeddings_and_closes_server_during_shutdown(self):
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
            patch("local_server.ThreadingHTTPServer", return_value=server),
            patch.object(local_server.embedding_runtime, "stop") as stop_embeddings,
        ):
            local_server.main()

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


class LibraryHistoryRouteTests(unittest.TestCase):
    def test_history_api_import_read_clear_and_invalid_kind(self):
        with tempfile.TemporaryDirectory() as directory:
            store = LocalFeatureStore(Path(directory))
            with patch.object(local_server, "local_features", store):
                handler = _handler_with_body({"items": [{"id": "123", "savedAt": 10}], "legacy": True})
                handler.path = "/local-api/library/history?kind=reading"
                handler.do_POST()
                self.assertEqual(handler.send_json.call_args.args[0]["items"][0]["id"], "123")
                handler.do_GET()
                self.assertEqual(len(handler.send_json.call_args.args[0]["items"]), 1)
                handler.do_DELETE()
                self.assertEqual(handler.send_json.call_args.args[0]["items"], [])
                handler.path = "/local-api/library/history?kind=invalid"
                handler.do_GET()
                self.assertEqual(handler.send_json.call_args.kwargs["status"], HTTPStatus.BAD_REQUEST)


class RecommendationJobRouteTests(unittest.TestCase):
    def test_committed_job_ack_and_storage_failure_are_distinct(self):
        handler = _handler_with_body({'id': 'task-1234567890123456', 'payload': {}})
        handler.path = '/local-api/ai/recommendation-jobs'
        with patch.object(local_server, 'recommendation_jobs') as jobs:
            jobs.submit.return_value = {'id': 'task-1234567890123456', 'accepted': True}
            handler.do_POST()
            self.assertTrue(handler.send_json.call_args.args[0]['accepted'])
            jobs.submit.side_effect = OSError('disk full')
            handler.rfile.seek(0)
            handler.do_POST()
            self.assertEqual(handler.send_json.call_args.kwargs['status'], HTTPStatus.SERVICE_UNAVAILABLE)
            self.assertNotIn('accepted', handler.send_json.call_args.args[0])

    def test_missing_job_is_not_reported_as_running(self):
        handler = _handler_with_body({})
        handler.path = '/local-api/ai/recommendation-jobs?id=missing'
        with patch.object(local_server, 'recommendation_jobs') as jobs:
            jobs.get.return_value = None
            handler.do_GET()
            self.assertEqual(handler.send_json.call_args.kwargs['status'], HTTPStatus.NOT_FOUND)

    def test_task_database_cannot_be_downloaded_as_static_file(self):
        handler = _handler_with_body({})
        handler.directory = str(local_server.PROJECT_DIR)
        handler.send_error = Mock()
        for path in ['/data/recommendation_jobs.sqlite3', '/data/recommendation_jobs.sqlite3-journal',
                     '/data/%72ecommendation_jobs.sqlite3']:
            handler.path = path
            self.assertIsNone(handler.send_head())
            handler.send_error.assert_called_with(HTTPStatus.NOT_FOUND)


class AnalysisSourceTests(unittest.TestCase):
    def test_fetches_album_and_two_pages(self):
        responses = [{"id": 123, "description": "虚构简介"},
                     {"list": [{"content": "第一条评论"}], "total": "3"},
                     {"list": [{"content": "第二条评论"}], "total": "3"}]
        with tempfile.TemporaryDirectory() as directory, patch.object(local_server, "CACHE_DIR", Path(directory)):
            target = Path(directory) / "bootstrap" / "servers.json"
            target.parent.mkdir()
            target.write_text('{"data":["example.invalid"]}')
            with patch.object(local_server, "normalize_proxy_servers", return_value=["example.invalid"]), patch.object(
                local_server, "urlopen", side_effect=[_ProxyResponse(json.dumps({"data": v}).encode()) for v in responses]
            ) as remote:
                value = local_server.fetch_analysis_source("123")
            self.assertEqual(remote.call_count, 3)
            self.assertIn("/forum?", remote.call_args.args[0].full_url)
            self.assertEqual(value["description"], "虚构简介")
            self.assertEqual(len(value["comments"]), 2)
            self.assertEqual(value["comments_status"], "ready")
