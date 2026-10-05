import email
import email.policy
import io
import json
import tempfile
import threading
import unittest
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from local_library import LocalLibrary
from title_translation import TitleTranslator


# Importing the server normally initializes project/data. Keep every test run
# isolated, including unittest discovery, before that initialization happens.
_server_temporary = tempfile.TemporaryDirectory()
_server_library = LocalLibrary(Path(_server_temporary.name))
with patch("local_library.LocalLibrary", return_value=_server_library):
    import local_server
local_server.DATA_DIR = _server_library.data_dir
local_server.ACCOUNT_FILE = local_server.DATA_DIR / "account.json"
local_server.CACHE_DIR = local_server.DATA_DIR / "cache" / "api"
local_server.translator = TitleTranslator(local_server.DATA_DIR / "translation.json")


def tearDownModule():
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


def _handler_with_body(value, path="/"):
    payload = json.dumps(value).encode("utf-8")
    handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
    handler.path = path
    handler.headers = {"Content-Length": str(len(payload))}
    handler.rfile = io.BytesIO(payload)
    handler.send_json = Mock()
    return handler


class RuntimeFileReadTests(unittest.TestCase):
    def test_non_object_account_json_uses_empty_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "account.json"
            with patch.object(local_server, "ACCOUNT_FILE", target):
                for value in (None, [], "text", 3, True):
                    with self.subTest(value=value):
                        target.write_text(json.dumps(value), encoding="utf-8")
                        self.assertEqual(local_server.read_account(), {"username": "", "password": ""})


class TranslationConfigRouteTests(unittest.TestCase):
    def test_config_read_errors_are_returned_as_structured_json(self):
        handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
        handler.path = "/local-api/translation/config"
        handler.send_json = Mock()
        with patch.object(local_server.translator, "read_config", side_effect=local_server.TranslationError("配置读取失败")):
            handler.do_GET()
        handler.send_json.assert_called_once_with({"error": "配置读取失败"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)


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


class LibraryRouteTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        library_patch = patch.object(local_server, "library", LocalLibrary(Path(self.temporary.name)))
        library_patch.start()
        self.addCleanup(library_patch.stop)

    def request(self, method, path, body=None):
        handler = _handler_with_body(body or {}, path)
        getattr(handler, f"do_{method}")()
        return handler.send_json.call_args

    def test_history_api_import_read_clear_and_invalid_kind(self):
        call = self.request("POST", "/local-api/library/history?kind=reading", {"items": [{"id": "123", "savedAt": 10}], "legacy": True})
        self.assertEqual(call.args[0]["items"][0]["id"], "123")
        self.assertEqual(len(self.request("GET", "/local-api/library/history?kind=reading").args[0]["items"]), 1)
        self.assertEqual(self.request("DELETE", "/local-api/library/history?kind=reading").args[0]["items"], [])
        self.assertEqual(self.request("GET", "/local-api/library/history?kind=invalid").kwargs["status"], HTTPStatus.BAD_REQUEST)

    def test_watch_later_api_removes_one_entry(self):
        self.request("POST", "/local-api/library/history?kind=later", {"items": [{"id": "1", "savedAt": 1}, {"id": "2", "savedAt": 2}]})
        items = self.request("DELETE", "/local-api/library/history?kind=later&id=2").args[0]["items"]
        self.assertEqual([item["id"] for item in items], ["1"])

    def test_search_history_api_records_removes_and_clears(self):
        self.request("POST", "/local-api/search-history", {"query": "旅行"})
        self.request("POST", "/local-api/search-history", {"query": "日常"})
        self.assertEqual([item["query"] for item in self.request("GET", "/local-api/search-history").args[0]["items"]], ["日常", "旅行"])
        self.assertEqual(self.request("POST", "/local-api/search-history", {"query": ""}).kwargs["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(len(self.request("DELETE", "/local-api/search-history?q=%E6%97%A5%E5%B8%B8").args[0]["items"]), 1)
        self.assertEqual(self.request("DELETE", "/local-api/search-history").args[0]["items"], [])

    def test_rating_api_saves_reads_lists_and_clears(self):
        comic = {"id": "99", "title": "示例", "authors": ["作者"], "cover_url": "/c.jpg", "rating": 8}
        self.assertEqual(self.request("POST", "/local-api/ratings", comic).args[0]["rating"]["rating"], 8)
        self.assertEqual(self.request("GET", "/local-api/ratings?id=99").args[0]["rating"]["title"], "示例")
        self.assertEqual([item["id"] for item in self.request("GET", "/local-api/ratings").args[0]["ratings"]], ["99"])
        self.assertEqual(self.request("POST", "/local-api/ratings", {"id": "99", "rating": None}).args[0], {"rating": None})
        self.assertEqual(self.request("GET", "/local-api/ratings?id=99").args[0], {"rating": None})
        self.assertEqual(self.request("POST", "/local-api/ratings", {"id": "99", "rating": 11}).kwargs["status"], HTTPStatus.BAD_REQUEST)
        self.assertEqual(self.request("GET", "/local-api/ratings?id=x").kwargs["status"], HTTPStatus.BAD_REQUEST)

    def test_preference_api_returns_every_stance_after_each_change(self):
        self.request("POST", "/local-api/preferences", {"kind": "tag", "name": "旅行", "level": "fond"})
        call = self.request("POST", "/local-api/preferences", {"kind": "author", "name": "作者", "level": "like"})
        self.assertEqual(call.args[0], {"tags": {"旅行": "fond"}, "authors": {"作者": "like"}})
        self.assertEqual(self.request("GET", "/local-api/preferences").args[0], call.args[0])
        call = self.request("POST", "/local-api/preferences", {"kind": "author", "name": "作者", "level": "fond"})
        self.assertEqual(call.kwargs["status"], HTTPStatus.BAD_REQUEST)


class StaticPrivacyTests(unittest.TestCase):
    def test_private_data_and_caches_are_never_served_as_static_files(self):
        handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
        handler.directory = str(local_server.PROJECT_DIR)
        handler.send_error = Mock()
        for path in ["/data/account.json", "/DATA/user_library.sqlite3", "/data/%61ccount.json",
                     "/./data/translation.json", "/.runtime-cache/api/album/1.json"]:
            with self.subTest(path=path):
                handler.path = path
                self.assertIsNone(handler.send_head())
                handler.send_error.assert_called_with(HTTPStatus.NOT_FOUND)
        handler.path = "/index.html"
        with patch.object(SimpleHTTPRequestHandler, "send_head", return_value="page") as static:
            self.assertEqual(handler.send_head(), "page")
        static.assert_called_once_with()


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


class BackgroundJobTests(unittest.TestCase):
    """Slow routes run as jobs so remote access through a proxy never holds one long request."""

    def setUp(self):
        local_server.jobs.clear()
        self.addCleanup(local_server.jobs.clear)
        self.server = local_server.ThreadingHTTPServer(("127.0.0.1", 0), local_server.LocalHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def call(self, path, body=None, job=False):
        from urllib.error import HTTPError
        from urllib.request import Request, urlopen
        headers = {"Content-Type": "application/json"} | ({"X-Local-Job": "start"} if job else {})
        data = json.dumps(body).encode("utf-8") if body is not None else None
        try:
            with urlopen(Request(self.base + path, data=data, headers=headers), timeout=5) as response:
                return response.status, response.headers.get("X-Local-Job"), json.loads(response.read())
        except HTTPError as error:
            return error.code, error.headers.get("X-Local-Job"), json.loads(error.read())

    def poll(self, job_id):
        for _ in range(300):
            status, state, value = self.call(f"/local-api/jobs?id={job_id}")
            if state != "running":
                return status, state, value
            threading.Event().wait(0.01)
        self.fail("job did not finish")

    def test_fast_job_answers_inline_with_the_direct_route_result(self):
        with patch.object(local_server.translator, "translate", return_value={"translation": "译名", "model": "demo"}):
            self.assertEqual(self.call("/local-api/translation", {"title": "T"}, job=True), (200, "done", {"translation": "译名", "model": "demo"}))

    def test_slow_job_is_polled_and_replays_errors_and_proxy_status(self):
        release = threading.Event()

        def slow_translate(_title):
            release.wait(5)
            raise local_server.TranslationError("模型没有返回正文")

        with patch.object(local_server, "JOB_INLINE_WAIT", 0.05), \
                patch.object(local_server.translator, "translate", side_effect=slow_translate):
            status, state, value = self.call("/local-api/translation", {"title": "T"}, job=True)
            self.assertEqual((status, state), (202, "accepted"))
            self.assertEqual(self.call(f"/local-api/jobs?id={value['job']}")[:2], (202, "running"))
            release.set()
            self.assertEqual(self.poll(value["job"]), (502, "done", {"error": "模型没有返回正文"}))
        self.assertEqual(self.call("/local-api/jobs?id=missing")[:2], (404, "missing"))
        # Routes outside the allow-list ignore the header and answer directly.
        self.assertEqual(self.call("/local-api/preferences", job=True)[1], None)

    def test_organize_job_joins_duplicates_and_saves_cache_on_the_server(self):
        release = threading.Event()
        result = {"groups": [{"title": "某系列", "items": [{"id": "1", "note": "前篇"}]}], "model": "demo"}

        def slow_organize(_items, _query):
            release.wait(5)
            return result

        body = {"items": [{"id": "1", "title": "A"}], "query": "X", "cache_key": "skey1",
                "comics": [{"id": "1", "name": "A"}, {"id": "2", "name": "B"}, "bad"]}
        with patch.object(local_server, "JOB_INLINE_WAIT", 0.05), \
                patch.object(local_server.translator, "organize", side_effect=slow_organize) as organize:
            first = self.call("/local-api/organize", body, job=True)[2]["job"]
            self.assertEqual(self.call("/local-api/organize", body, job=True)[2]["job"], first)
            self.assertNotEqual(self.call("/local-api/organize", body | {"force": True}, job=True)[2]["job"], first)
            release.set()
            self.assertEqual(self.poll(first), (200, "done", result | {"cached": True}))
        self.assertEqual(organize.call_count, 2)
        saved = json.loads((local_server.CACHE_DIR / "organize" / "skey1.json").read_text(encoding="utf-8"))["data"]
        self.assertEqual((saved["groups"], saved["comics"]), (result["groups"], [{"id": "1", "name": "A"}]))

    def test_unexpected_worker_errors_finish_the_job(self):
        with patch.object(local_server.translator, "translate", side_effect=RuntimeError("boom")):
            status, state, value = self.call("/local-api/translation", {"title": "T"}, job=True)
        self.assertEqual((status, state), (500, "done"))
        self.assertIn("boom", value["error"])


class OrganizeCacheTests(unittest.TestCase):
    def test_organize_results_use_the_seven_day_local_cache(self):
        handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
        self.assertIn("organize", local_server.CACHE_KINDS)
        self.assertEqual(handler.parse_cache_target("/local-api/cache/organize/s0123abcd4567ef89"), ("organize", "s0123abcd4567ef89"))
        self.assertEqual(local_server.MAX_CACHE_AGE, 7 * 24 * 60 * 60)

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
            content_type = request.get_header("Content-type")
            self.assertTrue(content_type.startswith("multipart/form-data; boundary="))
            boundary = content_type.split("boundary=", 1)[1]
            message = email.message_from_bytes(
                f"Content-Type: {content_type}\r\n\r\n".encode() + request.data,
                policy=email.policy.HTTP,
            )
            fields = {part.get_param("name", header="content-disposition"): part.get_content() for part in message.iter_parts()}
            self.assertEqual(fields, {"user_id": "42", "daily_id": "68"})
            self.assertTrue(request.data.endswith(f"--{boundary}--\r\n".encode()))
        self.assertEqual(handler.send_raw_json.call_count, 2)
        handler.send_json.assert_not_called()

    def test_other_account_posts_stay_url_encoded(self):
        handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
        handler.send_json = Mock()
        handler.send_raw_json = Mock()
        state = {"server": "api.example.com", "session": "session", "user": {"uid": "42"}}
        with (
            patch.object(local_server.jm_session, "active", return_value=state),
            patch("local_server.urlopen", return_value=_ProxyResponse()) as urlopen,
        ):
            handler.proxy_jm_request({
                "path": "/like",
                "method": "POST",
                "data": {"id": "123"},
                "token": "token",
                "tokenParam": "1,3.2.0",
            })
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Content-type"), "application/x-www-form-urlencoded;charset=UTF-8")
        self.assertEqual(request.data, b"id=123")

    def test_blank_checkin_body_becomes_an_empty_result(self):
        state = {"server": "api.example.com", "session": "session", "user": {"uid": "42"}}
        for path, method, expected in (
            ("/daily_chk", "POST", b'{"code":200,"data":[]}'),
            ("/daily?user_id=42", "GET", b'{"code":200,"data":[]}'),
            ("/like", "POST", b" "),
        ):
            handler = local_server.LocalHandler.__new__(local_server.LocalHandler)
            handler.send_json = Mock()
            handler.send_raw_json = Mock()
            with (
                patch.object(local_server.jm_session, "active", return_value=state),
                patch("local_server.urlopen", return_value=_ProxyResponse(b" ")),
            ):
                handler.proxy_jm_request({
                    "path": path,
                    "method": method,
                    "data": {"user_id": "42", "daily_id": "68"},
                    "token": "token",
                    "tokenParam": "1,3.2.0",
                })
            handler.send_raw_json.assert_called_once_with(expected, status=HTTPStatus.OK)

    def test_session_refresh_logs_in_again_even_with_a_live_session(self):
        manager = local_server.JmSessionManager()
        manager.server, manager.session, manager.profile = "old.example.com", "stale", {"uid": "42"}
        login = Mock(return_value=("api.example.com", "fresh", {"uid": "42", "username": "u"}))
        with (
            patch("local_server.read_account", return_value={"username": "u", "password": "p"}),
            patch("local_server.request_jm_login", login),
        ):
            self.assertEqual(manager.ensure(["api.example.com"])["session"], "stale")
            login.assert_not_called()
            state = manager.refresh(["api.example.com"])
        login.assert_called_once_with("u", "p", ["api.example.com"])
        self.assertEqual((state["server"], state["session"]), ("api.example.com", "fresh"))

    def test_auth_session_route_forces_refresh_only_when_asked(self):
        for body, method in (({"servers": ["api.example.com"], "refresh": True}, "refresh"), ({"servers": ["api.example.com"]}, "ensure")):
            handler = _handler_with_body(body, "/local-api/auth/session")
            state = {"server": "s", "session": "x", "user": {"uid": "42"}}
            with (
                patch.object(local_server.jm_session, "refresh", return_value=state) as refresh,
                patch.object(local_server.jm_session, "ensure", return_value=state) as ensure,
            ):
                handler.do_POST()
            (refresh if method == "refresh" else ensure).assert_called_once()
            (ensure if method == "refresh" else refresh).assert_not_called()
            handler.send_json.assert_called_once_with({"authenticated": True, "user": {"uid": "42"}})


class ServerLifecycleTests(unittest.TestCase):
    def test_main_closes_server_during_shutdown(self):
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
        ):
            local_server.main()

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
