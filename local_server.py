#!/usr/bin/env python3
"""Local-only server for JMComic WebUI: account session, library API and bounded caches."""

from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from html import unescape as html_unescape
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlencode, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

from local_library import LibraryError, LocalLibrary, atomic_json_write
from title_translation import TitleTranslator, TranslationError


ROOT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = ROOT_DIR / "project"
DATA_DIR = PROJECT_DIR / "data"
CACHE_DIR = PROJECT_DIR / ".runtime-cache" / "api"
ACCOUNT_FILE = DATA_DIR / "account.json"
library = LocalLibrary(DATA_DIR)
translator = TitleTranslator(DATA_DIR / "translation.json")

CACHE_KINDS = {"album", "chapter", "categories", "promotion", "favorites", "account_album", "account_like", "bootstrap", "notifications", "organize"}
CACHE_KEY = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
DEFAULT_MAX_AGE = 7 * 24 * 60 * 60
MAX_CACHE_AGE = 7 * 24 * 60 * 60
MAX_CACHE_FILES = 1200
MAX_CACHE_BYTES = 64 * 1024 * 1024
MAX_REQUEST_BYTES = 3 * 1024 * 1024
MAX_PROXY_RESPONSE_BYTES = 4 * 1024 * 1024
WEB_CHAPTER_CACHE_AGE = 24 * 60 * 60
JM_WEB_REDIRECT_URL = "https://jm365.work/3YeBdF"
JM_WEB_ORIGIN_TTL = 60 * 60
PROXY_HOST = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])?$", re.IGNORECASE)
PROXY_FAKE_IP_RANGE = ipaddress.ip_network("198.18.0.0/15")
PRIVATE_STATIC_ROOTS = {"data", ".runtime-cache"}
JM_TOKEN_SECRET = "185Hcomic3PAPP7R"
JM_DATA_SECRETS = ("185Hcomic3PAPP7R", "18comicAPPContent")
JM_APP_VERSION = "3.2.0"
PROXY_PATH_METHODS = {
    "/album": {"GET"},
    "/daily": {"GET"},
    "/daily_chk": {"POST"},
    "/favorite": {"GET", "POST"},
    "/like": {"POST"},
    "/notifications": {"GET", "POST"},
    "/notifications/unreadCount": {"GET"},
    "/album_sertracking": {"GET", "POST"},
    "/album_tracking": {"POST"},
}
# These endpoints ignore url-encoded bodies and silently answer code 200 with an empty list.
PROXY_MULTIPART_PATHS = {"/daily_chk"}
# A dead login session makes these answer 200 with a blank body; pass it on as JM's
# usual empty result so the browser re-logs in instead of reporting invalid JSON.
PROXY_BLANK_AS_EMPTY_PATHS = {"/daily", "/daily_chk"}
CACHE_CLEANUP_LOCK = threading.Lock()
PROXY_DNS_CACHE_TTL = 5 * 60
PROXY_DNS_CACHE = {}
PROXY_DNS_CACHE_LOCK = threading.Lock()
jm_web_origin = ""
jm_web_origin_expires = 0.0
jm_web_origin_lock = threading.Lock()


def ensure_runtime_files() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if not ACCOUNT_FILE.exists():
        atomic_json_write(ACCOUNT_FILE, {"username": "", "password": ""}, private=True)
    else:
        try:
            ACCOUNT_FILE.chmod(0o600)
        except OSError:
            pass


def read_account() -> dict[str, str]:
    try:
        data = json.loads(ACCOUNT_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    return {
        "username": str(data.get("username") or ""),
        "password": str(data.get("password") or ""),
    }


class JmSessionError(RuntimeError):
    pass


def validate_proxy_server(server: object) -> str:
    hostname = str(server or "").strip().lower()
    if not PROXY_HOST.fullmatch(hostname) or "." not in hostname:
        raise JmSessionError("账号接口域名无效")
    now = time.monotonic()
    with PROXY_DNS_CACHE_LOCK:
        if PROXY_DNS_CACHE.get(hostname, 0) > now:
            return hostname
    try:
        addresses = socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
        resolved = [ipaddress.ip_address(item[4][0]) for item in addresses]
        if not resolved or any(not (address.is_global or address in PROXY_FAKE_IP_RANGE) for address in resolved):
            raise ValueError
    except (OSError, ValueError) as error:
        raise JmSessionError("账号接口域名不可用") from error
    with PROXY_DNS_CACHE_LOCK:
        PROXY_DNS_CACHE[hostname] = now + PROXY_DNS_CACHE_TTL
    return hostname


def normalize_proxy_servers(value: object) -> list[str]:
    candidates = value if isinstance(value, list) else []
    servers = []
    for candidate in candidates[:5]:
        try:
            server = validate_proxy_server(candidate)
        except JmSessionError:
            continue
        if server not in servers:
            servers.append(server)
    if not servers:
        raise JmSessionError("没有可用的账号 API 线路")
    return servers


def decrypt_jm_data(ciphertext: str, timestamp: int) -> object:
    openssl = shutil.which("openssl")
    if not openssl:
        raise JmSessionError("本机缺少 OpenSSL，无法建立账号会话")
    try:
        encrypted = base64.b64decode(ciphertext, validate=True)
    except (ValueError, TypeError) as error:
        raise JmSessionError("登录接口返回了无效数据") from error
    for secret in JM_DATA_SECRETS:
        dynamic_key = hashlib.md5(f"{timestamp}{secret}".encode("utf-8")).hexdigest().encode("ascii")
        try:
            result = subprocess.run(
                [openssl, "enc", "-d", "-aes-256-ecb", "-K", dynamic_key.hex()],
                input=encrypted,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=True,
                timeout=6,
            )
            return json.loads(result.stdout.decode("utf-8"))
        except (OSError, subprocess.SubprocessError, UnicodeDecodeError, ValueError):
            continue
    raise JmSessionError("登录接口数据解密失败")


def encode_multipart_form(fields: dict) -> tuple[bytes, str]:
    boundary = f"----JMComicWebUI{secrets.token_hex(12)}"
    parts = []
    for key, value in fields.items():
        name = str(key).replace("\\", "\\\\").replace('"', '\\"').replace("\r", "").replace("\n", "")
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode("utf-8")
        )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def request_jm_login(username: str, password: str, servers: list[str]) -> tuple[str, str, dict]:
    last_error = None
    for candidate in servers:
        timestamp = int(time.time())
        token = hashlib.md5(f"{timestamp}{JM_TOKEN_SECRET}".encode("utf-8")).hexdigest()
        payload = urlencode({"username": username, "password": password}).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "token": token,
            "tokenParam": f"{timestamp},{JM_APP_VERSION}",
            "User-Agent": "JMComic-WebUI-Local/1.0",
        }
        request = Request(f"https://{candidate}/login", data=payload, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=20) as response:
                raw = response.read(MAX_PROXY_RESPONSE_BYTES + 1)
                if len(raw) > MAX_PROXY_RESPONSE_BYTES:
                    raise JmSessionError("登录接口响应过大")
                envelope = json.loads(raw.decode("utf-8"))
                data = envelope.get("data", envelope) if isinstance(envelope, dict) else envelope
                profile = decrypt_jm_data(data, timestamp) if isinstance(data, str) else data
                if not isinstance(profile, dict) or not profile.get("uid") or not profile.get("s"):
                    message = profile.get("msg") if isinstance(profile, dict) else ""
                    raise JmSessionError(str(message or "账号或密码错误"))
                response_server = validate_proxy_server(urlparse(response.geturl()).hostname or candidate)
                return response_server, str(profile["s"]), profile
        except HTTPError as error:
            last_error = JmSessionError(f"登录接口返回 HTTP {error.code}")
        except (URLError, OSError, ValueError, TypeError, JmSessionError) as error:
            last_error = error
    raise JmSessionError(str(last_error or "所有账号 API 线路均登录失败"))


def public_profile(profile: dict) -> dict:
    return {
        "uid": str(profile.get("uid") or ""),
        "username": str(profile.get("username") or ""),
        "photo": str(profile.get("photo") or ""),
        "level_name": str(profile.get("level_name") or "会员"),
    }


class JmSessionManager:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.server = ""
        self.session = ""
        self.profile = None

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "authenticated": bool(self.server and self.session and self.profile),
                "user": dict(self.profile) if self.profile else None,
            }

    def active(self):
        with self.lock:
            if not (self.server and self.session and self.profile):
                return None
            return self.current()

    def clear(self) -> None:
        with self.lock:
            self.server = ""
            self.session = ""
            self.profile = None

    def ensure(self, servers: list[str]) -> dict:
        with self.lock:
            if self.server and self.session and self.profile:
                return self.current()
            account = read_account()
            if not account["username"] or not account["password"]:
                raise JmSessionError("请先配置账号和密码")
            self.login(account["username"], account["password"], servers)
            return self.current()

    def configure(self, username: str, password: str, servers: list[str]) -> dict:
        with self.lock:
            server, session, raw_profile = request_jm_login(username, password, servers)
            profile = public_profile(raw_profile)
            atomic_json_write(ACCOUNT_FILE, {"username": username, "password": password}, private=True)
            clear_cache_kind("favorites")
            clear_cache_kind("account_album")
            clear_cache_kind("account_like")
            clear_cache_kind("notifications")
            self.server = server
            self.session = session
            self.profile = profile
            return self.current()

    def refresh(self, servers: list[str]) -> dict:
        # JM may answer requests on a dead session (expired, or replaced by a login
        # elsewhere) with code 200 and an empty body instead of 401, so callers that
        # detect this ask for a fresh login explicitly.
        with self.lock:
            self.server = ""
            self.session = ""
            self.profile = None
            return self.ensure(servers)

    def refresh_if_current(self, previous_session: str, servers: list[str]) -> dict:
        with self.lock:
            if self.session and self.session != previous_session and self.profile:
                return self.current()
            self.server = ""
            self.session = ""
            self.profile = None
            return self.ensure(servers)

    def login(self, username: str, password: str, servers: list[str]) -> None:
        server, session, raw_profile = request_jm_login(username, password, servers)
        self.server = server
        self.session = session
        self.profile = public_profile(raw_profile)

    def current(self) -> dict:
        return {
            "server": self.server,
            "session": self.session,
            "user": dict(self.profile) if self.profile else None,
        }


jm_session = JmSessionManager()


def cache_files() -> list[Path]:
    return [path for path in CACHE_DIR.glob("*/*.json") if path.is_file()]


def clear_cache_kind(kind: str) -> None:
    for path in (CACHE_DIR / kind).glob("*.json"):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def cleanup_cache() -> None:
    if not CACHE_CLEANUP_LOCK.acquire(blocking=False):
        return
    try:
        now = time.time()
        files = cache_files()
        for path in files:
            try:
                if now - path.stat().st_mtime > MAX_CACHE_AGE:
                    path.unlink(missing_ok=True)
            except OSError:
                continue

        files = cache_files()
        entries = []
        total_bytes = 0
        for path in files:
            try:
                stat = path.stat()
            except OSError:
                continue
            entries.append((stat.st_mtime, stat.st_size, path))
            total_bytes += stat.st_size
        entries.sort(key=lambda entry: entry[0])
        while entries and (len(entries) > MAX_CACHE_FILES or total_bytes > MAX_CACHE_BYTES):
            _, size, path = entries.pop(0)
            try:
                path.unlink(missing_ok=True)
                total_bytes -= size
            except OSError:
                pass
    finally:
        CACHE_CLEANUP_LOCK.release()


class ChapterNameError(RuntimeError):
    pass


def validate_jm_web_url(value: object) -> str:
    parsed = urlparse(str(value or ""))
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
    ):
        raise ChapterNameError("JM 网页地址无效")
    try:
        hostname = validate_proxy_server(parsed.hostname)
    except JmSessionError as error:
        raise ChapterNameError("JM 网页域名不可用") from error
    return f"https://{hostname}"


class SafeJmWebRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_jm_web_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


jm_web_opener = build_opener(SafeJmWebRedirectHandler())


def discover_jm_web_origin(force: bool = False) -> str:
    global jm_web_origin, jm_web_origin_expires
    now = time.monotonic()
    with jm_web_origin_lock:
        if not force and jm_web_origin and jm_web_origin_expires > now:
            return jm_web_origin
        request = Request(JM_WEB_REDIRECT_URL, headers={"User-Agent": "Mozilla/5.0"}, method="GET")
        try:
            with jm_web_opener.open(request, timeout=25) as response:
                origin = validate_jm_web_url(response.geturl())
        except (HTTPError, URLError, OSError, ValueError, ChapterNameError) as error:
            raise ChapterNameError("无法获取 JM 网页线路") from error
        jm_web_origin = origin
        jm_web_origin_expires = now + JM_WEB_ORIGIN_TTL
        return origin


def parse_web_chapter_names(raw_html: str) -> list[dict[str, str]]:
    encoded = re.search(r'const html = base64DecodeUtf8\("([A-Za-z0-9+/=]+)"\)', raw_html)
    if encoded:
        try:
            raw_html = base64.b64decode(encoded.group(1), validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            pass
    pattern = re.compile(
        r'data-album=["\'](\d+)["\'][^>]*>[\s\S]*?第(\d+)[话話]([\s\S]*?)<[\s\S]*?>',
    )
    chapters = []
    seen = set()
    for chapter_id, sort, fragment in pattern.findall(raw_html):
        if chapter_id in seen:
            continue
        name = re.sub(r"<[^>]+>", " ", fragment)
        name = re.sub(r"\s+", " ", html_unescape(name)).strip()[:500]
        chapters.append({"id": chapter_id, "sort": sort, "name": name})
        seen.add(chapter_id)
    return chapters


def get_web_chapter_names(album_id: object) -> dict:
    normalized_id = str(album_id or "").strip()
    if not re.fullmatch(r"\d{1,16}", normalized_id):
        raise ChapterNameError("漫画编号无效")
    cache_path = CACHE_DIR / "chapter_names" / f"{normalized_id}.json"
    try:
        wrapper = json.loads(cache_path.read_text(encoding="utf-8"))
        if not isinstance(wrapper, dict):
            raise ValueError("章节缓存格式无效")
        if time.time() - float(wrapper.get("saved_at") or 0) <= WEB_CHAPTER_CACHE_AGE:
            cached = wrapper.get("data")
            if isinstance(cached, dict) and isinstance(cached.get("chapters"), list):
                return cached
    except (OSError, ValueError, TypeError):
        pass

    last_error = None
    for attempt in range(2):
        try:
            origin = discover_jm_web_origin(force=attempt > 0)
            request = Request(
                f"{origin}/album/{normalized_id}/",
                headers={
                    "Accept": "text/html,application/xhtml+xml",
                    "Accept-Language": "zh-CN,zh;q=0.9",
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                },
                method="GET",
            )
            with jm_web_opener.open(request, timeout=25) as response:
                validate_jm_web_url(response.geturl())
                payload = response.read(MAX_PROXY_RESPONSE_BYTES + 1)
                if len(payload) > MAX_PROXY_RESPONSE_BYTES:
                    raise ChapterNameError("JM 网页响应过大")
                charset = response.headers.get_content_charset() or "utf-8"
                chapters = parse_web_chapter_names(payload.decode(charset, errors="replace"))
                if not chapters:
                    raise ChapterNameError("JM 网页未返回章节列表")
                result = {"album_id": normalized_id, "chapters": chapters}
                atomic_json_write(cache_path, {"saved_at": time.time(), "data": result})
                return result
        except (HTTPError, URLError, OSError, ValueError, ChapterNameError) as error:
            last_error = error
    raise ChapterNameError(str(last_error or "JM 网文章节名称读取失败"))


# Slow routes (JM login tries several API lines, account requests may re-login
# first, AI calls take minutes) can outlast the 60–100 s idle limit of reverse
# proxies and tunnels, and phones drop long requests when they sleep. A client
# may send `X-Local-Job: start` to run one of these routes in the background and
# poll /local-api/jobs?id=… with short requests. The finished job replays exactly
# what the direct route would have sent, so a check-in answer is not lost with a
# dropped connection.
JOB_PATHS = {
    "/local-api/jm-proxy", "/local-api/auth/login", "/local-api/auth/session", "/local-api/chapter-names",
    "/local-api/translation", "/local-api/translation/test", "/local-api/organize",
}
JOB_TTL = 15 * 60
# Most jobs finish in a second or two; answering those inline saves a poll round trip
# while still never holding a connection anywhere near a proxy's idle limit.
JOB_INLINE_WAIT = 8
MAX_RUNNING_JOBS = 8
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()


def job_dedupe_key(path: str, body: dict | None) -> str:
    # A retry or a second device asking for the same grouping joins the running job.
    if path == "/local-api/organize" and body and not body.get("force"):
        key = str(body.get("cache_key") or "")
        return f"organize:{key}" if CACHE_KEY.fullmatch(key) else ""
    return ""


def start_job(run, dedupe: str = "") -> str | None:
    """Run `run() -> (status, payload bytes)` in a thread; None when too many jobs are running."""
    now = time.time()
    with jobs_lock:
        for job_id, job in list(jobs.items()):
            if now - job.get("finished", now) > JOB_TTL:
                del jobs[job_id]
        running = [(job_id, job) for job_id, job in jobs.items() if "finished" not in job]
        for job_id, job in running:
            if dedupe and job["dedupe"] == dedupe:
                return job_id
        if len(running) >= MAX_RUNNING_JOBS:
            return None
        job_id = secrets.token_hex(12)
        jobs[job_id] = {"dedupe": dedupe, "created": now, "done": threading.Event()}

    def worker() -> None:
        try:
            status, payload = run()
        except Exception as error:  # Never leave a job "running" forever.
            status = HTTPStatus.INTERNAL_SERVER_ERROR
            payload = json.dumps({"error": f"后台任务意外失败: {str(error)[:200]}"}, ensure_ascii=False).encode("utf-8")
        with jobs_lock:
            jobs[job_id].update(status=int(status), payload=payload, finished=time.time())
            jobs[job_id]["done"].set()

    threading.Thread(target=worker, daemon=True).start()
    return job_id


def job_state(job_id: str) -> dict | None:
    with jobs_lock:
        job = jobs.get(job_id)
        return dict(job) if job else None


def save_organize_cache(key: str, result: dict, comics: object) -> None:
    placed = {item["id"] for group in result["groups"] for item in group["items"]}
    kept = [comic for comic in comics if isinstance(comic, dict) and str(comic.get("id")) in placed] if isinstance(comics, list) else []
    atomic_json_write(CACHE_DIR / "organize" / f"{key}.json", {
        "saved_at": time.time(),
        "data": {"model": result.get("model", ""), "savedAt": int(time.time() * 1000), "groups": result["groups"], "comics": kept},
    })
    LocalHandler.record_cache_write()


class LocalHandler(SimpleHTTPRequestHandler):
    cache_writes = 0
    cache_write_lock = threading.Lock()

    @classmethod
    def record_cache_write(cls) -> None:
        with cls.cache_write_lock:
            cls.cache_writes += 1
            should_cleanup = cls.cache_writes % 25 == 0
        if should_cleanup:
            cleanup_cache()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_DIR), **kwargs)

    def send_head(self):
        # Account, library and cache files sit under the served root but are never static content.
        # The comparison is case-insensitive because macOS volumes usually are.
        target = Path(self.translate_path(self.path)).resolve()
        root = Path(self.directory).resolve()
        parts = target.relative_to(root).parts if target.is_relative_to(root) else ()
        if parts and parts[0].casefold() in PRIVATE_STATIC_ROOTS:
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return super().send_head()

    def end_headers(self) -> None:
        if self.path.startswith("/local-api/"):
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def wants_job(self) -> bool:
        headers = getattr(self, "headers", None)
        return urlparse(self.path).path in JOB_PATHS and headers is not None and headers.get("X-Local-Job") == "start"

    def start_background(self, body: dict | None) -> None:
        recorder = JobRecorder(self.path, body)
        job_id = start_job(recorder.run, job_dedupe_key(urlparse(self.path).path, body))
        if job_id is None:
            self.send_json({"error": "后台任务过多，请稍后再试"}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            return
        job = job_state(job_id)
        if job and job["done"].wait(JOB_INLINE_WAIT):
            self.send_job_result(job_id)
        else:
            self.send_json({"job": job_id}, status=HTTPStatus.ACCEPTED, headers={"X-Local-Job": "accepted"})

    def send_job_result(self, job_id: str) -> None:
        job = job_state(job_id)
        if job is None:
            self.send_json({"error": "后台任务不存在或已过期（服务可能刚重启），请重试"}, status=HTTPStatus.NOT_FOUND, headers={"X-Local-Job": "missing"})
        elif "finished" not in job:
            self.send_json({"status": "running"}, status=HTTPStatus.ACCEPTED, headers={"X-Local-Job": "running"})
        else:
            self.send_raw_json(job["payload"], status=job["status"], headers={"X-Local-Job": "done"})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if self.wants_job():
            self.start_background(None)
            return
        if parsed.path == "/local-api/jobs":
            self.send_job_result(query.get("id", [""])[0])
            return
        if parsed.path == "/local-api/library/history":
            try:
                self.send_json(library.library_history(query.get("kind", [""])[0]))
            except LibraryError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/ratings":
            try:
                comic_id = query.get("id", [None])[0]
                self.send_json({"ratings": library.list_ratings()} if comic_id is None
                               else {"rating": library.get_rating(comic_id)})
            except LibraryError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/preferences":
            self.send_json(library.preferences())
            return
        if parsed.path == "/local-api/search-history":
            self.send_json(library.search_history())
            return
        if parsed.path == "/local-api/account":
            account = read_account()
            session_state = jm_session.snapshot()
            self.send_json({
                "configured": bool(account["username"] and account["password"]),
                "username": account["username"],
                **session_state,
            })
            return
        if parsed.path == "/local-api/chapter-names":
            try:
                self.send_json(get_web_chapter_names(query.get("id", [""])[0]))
            except ChapterNameError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path == "/local-api/translation/config":
            try:
                self.send_json(translator.read_config())
            except TranslationError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        cache_target = self.parse_cache_target(parsed.path)
        if cache_target:
            kind, key = cache_target
            try:
                requested_age = int(query.get("max_age", [DEFAULT_MAX_AGE])[0])
            except (TypeError, ValueError):
                requested_age = DEFAULT_MAX_AGE
            max_age = min(MAX_CACHE_AGE, max(0, requested_age))
            path = CACHE_DIR / kind / f"{key}.json"
            try:
                wrapper = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(wrapper, dict):
                    raise ValueError("接口缓存格式无效")
                saved_at = float(wrapper.get("saved_at") or 0)
                if not saved_at or time.time() - saved_at > max_age:
                    path.unlink(missing_ok=True)
                    self.send_json({"hit": False}, status=HTTPStatus.NOT_FOUND)
                    return
                os.utime(path, None)
                self.send_json({"hit": True, "data": wrapper.get("data")})
            except (OSError, ValueError, TypeError):
                self.send_json({"hit": False}, status=HTTPStatus.NOT_FOUND)
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        body = self.read_json_body()
        if body is None:
            return
        if self.wants_job():
            self.start_background(body)
            return
        if parsed.path == "/local-api/library/history":
            kind = parse_qs(parsed.query).get("kind", [""])[0]
            try:
                self.send_json(library.library_history(kind, body.get("items", []), legacy=body.get("legacy") is True))
            except LibraryError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/ratings":
            try:
                self.send_json({"rating": library.save_rating(body)})
            except LibraryError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/preferences":
            try:
                self.send_json(library.set_preference(body))
            except LibraryError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/search-history":
            try:
                self.send_json(library.search_history(body.get("query")))
            except LibraryError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/jm-proxy":
            self.proxy_jm_request(body)
            return
        if parsed.path in {"/local-api/auth/login", "/local-api/auth/session"}:
            try:
                servers = normalize_proxy_servers(body.get("servers"))
                if parsed.path == "/local-api/auth/login":
                    username = str(body.get("username") or "").strip()
                    password = str(body.get("password") or "")
                    if not username or not password:
                        self.send_json({"error": "账号和密码不能为空"}, status=HTTPStatus.BAD_REQUEST)
                        return
                    state = jm_session.configure(username, password, servers)
                elif body.get("refresh") is True:
                    state = jm_session.refresh(servers)
                else:
                    state = jm_session.ensure(servers)
                self.send_json({"authenticated": True, "user": state["user"]})
            except JmSessionError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.UNAUTHORIZED)
            return
        if parsed.path == "/local-api/translation/config":
            try:
                self.send_json(translator.save_config(body))
            except TranslationError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/translation/test":
            try:
                if any(key in body for key in ("api_key", "base_url", "model")):
                    translator.save_config(body)
                self.send_json(translator.test())
            except TranslationError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path == "/local-api/organize":
            try:
                result = translator.organize(body.get("items"), body.get("query"))
            except TranslationError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
                return
            # Saved here rather than by the browser so every device sees the grouping,
            # even when the requesting phone went to sleep before it finished.
            cached = False
            cache_key = str(body.get("cache_key") or "")
            if CACHE_KEY.fullmatch(cache_key):
                try:
                    save_organize_cache(cache_key, result, body.get("comics"))
                    cached = True
                except OSError:
                    pass
            self.send_json({**result, "cached": cached})
            return
        if parsed.path == "/local-api/translation":
            try:
                self.send_json(translator.translate(body.get("title")))
            except TranslationError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
            return
        cache_target = self.parse_cache_target(parsed.path)
        if cache_target:
            kind, key = cache_target
            atomic_json_write(CACHE_DIR / kind / f"{key}.json", {
                "saved_at": time.time(),
                "data": body.get("data"),
            })
            type(self).record_cache_write()
            self.send_json({"saved": True})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def proxy_jm_request(self, body: dict) -> None:
        path = str(body.get("path") or "")
        method = str(body.get("method") or "GET").upper()
        token = str(body.get("token") or "")
        token_param = str(body.get("tokenParam") or "")
        data = body.get("data")
        parsed_path = urlparse(path)

        if (
            parsed_path.scheme
            or parsed_path.netloc
            or parsed_path.fragment
            or PROXY_PATH_METHODS.get(parsed_path.path, set()).isdisjoint({method})
            or not token
            or not token_param
        ):
            self.send_json({"error": "账号接口请求无效"}, status=HTTPStatus.BAD_REQUEST)
            return
        payload = None
        content_type = ""
        if method == "POST":
            normalized = data if isinstance(data, dict) else {}
            fields = {str(key): str(value) for key, value in normalized.items()}
            if parsed_path.path in PROXY_MULTIPART_PATHS:
                payload, content_type = encode_multipart_form(fields)
            else:
                payload = urlencode(fields).encode("utf-8")
                content_type = "application/x-www-form-urlencoded;charset=UTF-8"
        try:
            servers = None
            state = jm_session.active()
            if state is None:
                servers = normalize_proxy_servers(body.get("servers"))
                state = jm_session.ensure(servers)
            for attempt in range(2):
                headers = {
                    "Accept": "application/json",
                    "token": token,
                    "tokenParam": token_param,
                    "Cookie": f"AVS={state['session']}",
                    "User-Agent": "JMComic-WebUI-Local/1.0",
                }
                if method == "POST":
                    headers["Content-Type"] = content_type
                request = Request(
                    f"https://{state['server']}{path}",
                    data=payload,
                    headers=headers,
                    method=method,
                )
                try:
                    with urlopen(request, timeout=20) as response:
                        response_body = response.read(MAX_PROXY_RESPONSE_BYTES + 1)
                        if len(response_body) > MAX_PROXY_RESPONSE_BYTES:
                            raise ValueError("响应过大")
                        if parsed_path.path in PROXY_BLANK_AS_EMPTY_PATHS and not response_body.strip():
                            response_body = b'{"code":200,"data":[]}'
                        self.send_raw_json(response_body, status=response.status)
                        return
                except HTTPError as error:
                    response_body = error.read(MAX_PROXY_RESPONSE_BYTES + 1)
                    if error.code == HTTPStatus.UNAUTHORIZED and attempt == 0:
                        if servers is None:
                            servers = normalize_proxy_servers(body.get("servers"))
                        state = jm_session.refresh_if_current(state["session"], servers)
                        continue
                    self.send_raw_json(response_body[:MAX_PROXY_RESPONSE_BYTES], status=error.code)
                    return
        except JmSessionError as error:
            self.send_json({"error": str(error)}, status=HTTPStatus.UNAUTHORIZED)
        except (URLError, OSError, ValueError):
            self.send_json({"error": "账号接口暂时无法连接"}, status=HTTPStatus.BAD_GATEWAY)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/local-api/library/history":
            query = parse_qs(parsed.query)
            # `id` removes one entry (watch later); without it the whole list is cleared.
            comic_id = query.get("id", [None])[0]
            try:
                self.send_json(library.library_history(query.get("kind", [""])[0], clear=comic_id is None, remove=comic_id))
            except LibraryError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/search-history":
            query = parse_qs(parsed.query).get("q", [None])[0]
            self.send_json(library.search_history(remove=query, clear=query is None))
            return
        if parsed.path == "/local-api/account":
            atomic_json_write(ACCOUNT_FILE, {"username": "", "password": ""}, private=True)
            clear_cache_kind("favorites")
            clear_cache_kind("account_album")
            clear_cache_kind("account_like")
            clear_cache_kind("notifications")
            jm_session.clear()
            self.send_json({"configured": False, "username": ""})
            return
        if parsed.path == "/local-api/translation/config":
            try:
                self.send_json(translator.clear_config())
            except TranslationError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if parsed.path == "/local-api/cache":
            for path in cache_files():
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
            self.send_json({"cleared": True})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def parse_cache_target(self, path: str):
        parts = [unquote(part) for part in path.split("/") if part]
        if len(parts) != 4 or parts[:2] != ["local-api", "cache"]:
            return None
        kind, key = parts[2], parts[3]
        if kind not in CACHE_KINDS or not CACHE_KEY.fullmatch(key):
            return None
        return kind, key

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_REQUEST_BYTES:
            self.send_json({"error": "请求内容大小无效"}, status=HTTPStatus.BAD_REQUEST)
            return None
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            self.send_json({"error": "请求内容不是有效 JSON"}, status=HTTPStatus.BAD_REQUEST)
            return None
        if not isinstance(value, dict):
            self.send_json({"error": "请求内容必须是 JSON 对象"}, status=HTTPStatus.BAD_REQUEST)
            return None
        return value

    def send_json(self, value: object, status: int = HTTPStatus.OK, headers: dict | None = None) -> None:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_raw_json(payload, status, headers)

    def send_raw_json(self, payload: bytes, status: int = HTTPStatus.OK, headers: dict | None = None) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Safari may cancel an in-flight request when a view is replaced.
            self.close_connection = True


class JobRecorder(LocalHandler):
    """Runs one LocalHandler route off the request thread and keeps what it would have sent."""

    def __init__(self, path: str, body: dict | None) -> None:  # No socket: skip the base initializer.
        self.path = path
        self.body = body
        self.result = (HTTPStatus.INTERNAL_SERVER_ERROR, '{"error":"后台任务没有返回结果"}'.encode("utf-8"))

    def wants_job(self) -> bool:
        return False

    def read_json_body(self):
        return self.body

    def send_raw_json(self, payload: bytes, status: int = HTTPStatus.OK, headers: dict | None = None) -> None:
        self.result = (int(status), payload)

    def send_error(self, code, message=None, explain=None) -> None:
        self.send_json({"error": message or "请求失败"}, status=code)

    def run(self) -> tuple[int, bytes]:
        (self.do_GET if self.body is None else self.do_POST)()
        return self.result

def main() -> None:
    parser = argparse.ArgumentParser(description="Run JMComic WebUI locally")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    ensure_runtime_files()
    cleanup_cache()
    server = ThreadingHTTPServer((args.host, args.port), LocalHandler)
    print(f"JMComic WebUI: http://{args.host}:{args.port}/")
    print(f"账号配置: {ACCOUNT_FILE}")
    print(f"缓存目录: {CACHE_DIR}（最多 {MAX_CACHE_FILES} 项 / {MAX_CACHE_BYTES // 1024 // 1024} MB / 7 天）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
