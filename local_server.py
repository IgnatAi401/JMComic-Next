#!/usr/bin/env python3
"""Local-only server for JMComic WebUI, account configuration and bounded caches."""

from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import os
import re
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

from local_features import LocalFeatureError, LocalFeatureStore
from qwen_embeddings import QwenEmbeddingError, QwenEmbeddingRuntime


ROOT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = ROOT_DIR / "project"
DATA_DIR = PROJECT_DIR / "data"
CACHE_DIR = PROJECT_DIR / ".runtime-cache" / "api"
ACCOUNT_FILE = DATA_DIR / "account.json"
local_features = LocalFeatureStore(DATA_DIR)
embedding_runtime = QwenEmbeddingRuntime(local_features)

CACHE_KINDS = {"album", "chapter", "categories", "promotion", "favorites", "account_album", "account_like", "bootstrap", "notifications"}
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
CACHE_CLEANUP_LOCK = threading.Lock()
PROXY_DNS_CACHE_TTL = 5 * 60
PROXY_DNS_CACHE = {}
PROXY_DNS_CACHE_LOCK = threading.Lock()
jm_web_origin = ""
jm_web_origin_expires = 0.0
jm_web_origin_lock = threading.Lock()


def comic_has_explicit_embedding_evidence(comic: object) -> bool:
    """Avoid loading Qwen for a metadata-only save or a cleared evaluation."""

    if not isinstance(comic, dict):
        return False
    if comic.get("rating") is not None or str(comic.get("review") or "").strip():
        return True
    if comic.get("interest_feedback"):
        return True
    if isinstance(comic.get("tag_feedback"), dict) and comic["tag_feedback"]:
        return True
    return False


def atomic_json_write(path: Path, value: object, private: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    replaced = False
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        replaced = True
        if private:
            try:
                path.chmod(0o600)
            except OSError:
                pass
        descriptor = None
        try:
            descriptor = os.open(path.parent, os.O_RDONLY)
            os.fsync(descriptor)
        except OSError:
            pass
        finally:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
    finally:
        if not replaced:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


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

    def end_headers(self) -> None:
        if self.path.startswith("/local-api/"):
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/local-api/library/history":
            kind = parse_qs(parsed.query).get("kind", [""])[0]
            try:
                self.send_json(local_features.library_history(kind))
            except (LocalFeatureError, ValueError) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
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
                album_id = parse_qs(parsed.query).get("id", [""])[0]
                self.send_json(get_web_chapter_names(album_id))
            except ChapterNameError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path == "/local-api/ai/config":
            try:
                self.send_json(local_features.read_ai_config())
            except (LocalFeatureError, QwenEmbeddingError) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if parsed.path == "/local-api/ai/embeddings/config":
            try:
                self.send_json(local_features.read_embedding_config())
            except (LocalFeatureError, QwenEmbeddingError) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if parsed.path == "/local-api/library/comic":
            try:
                comic = local_features.get_comic(parse_qs(parsed.query).get("id", [""])[0])
                self.send_json({"comic": comic})
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/library/comics":
            mode = str(parse_qs(parsed.query).get("mode", ["all"])[0])
            self.send_json({"comics": local_features.list_comics(mode), "stats": local_features.stats()})
            return
        if parsed.path == "/local-api/library/stats":
            self.send_json(local_features.stats())
            return
        if parsed.path == "/local-api/ai/profile":
            self.send_json({"profile": local_features.read_profile(), "stats": local_features.stats()})
            return
        if parsed.path == "/local-api/ai/recommended-ids":
            self.send_json({"ids": local_features.recommended_ids()})
            return
        if parsed.path == "/local-api/ai/discovery-excluded-ids":
            self.send_json({"ids": local_features.discovery_excluded_ids()})
            return
        if parsed.path == "/local-api/ai/recommendations":
            self.send_json({"runs": local_features.recommendation_history()})
            return
        if parsed.path == "/local-api/ai/interactions":
            try:
                query = parse_qs(parsed.query)
                comic_id = query.get("comic_id", [None])[0]
                raw_limit = query.get("limit", [200])[0]
                self.send_json({
                    "interactions": local_features.list_interactions(
                        comic_id=comic_id,
                        limit=raw_limit,
                    )
                })
            except (LocalFeatureError, TypeError, ValueError) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/ai/features/stats":
            self.send_json(local_features.feature_cache_stats())
            return
        if parsed.path == "/local-api/ai/embeddings/status":
            try:
                self.send_json(embedding_runtime.status())
            except (LocalFeatureError, QwenEmbeddingError) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        cache_target = self.parse_cache_target(parsed.path)
        if cache_target:
            kind, key = cache_target
            query = parse_qs(parsed.query)
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
        if parsed.path == "/local-api/library/history":
            kind = parse_qs(parsed.query).get("kind", [""])[0]
            body = self.read_json_body()
            if body is None:
                return
            try:
                self.send_json(local_features.library_history(kind, body.get("items", []), legacy=body.get("legacy") is True))
            except (LocalFeatureError, ValueError) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/jm-proxy":
            body = self.read_json_body()
            if body is not None:
                self.proxy_jm_request(body)
            return
        if parsed.path in {"/local-api/auth/login", "/local-api/auth/session"}:
            body = self.read_json_body()
            if body is None:
                return
            try:
                servers = normalize_proxy_servers(body.get("servers"))
                if parsed.path == "/local-api/auth/login":
                    username = str(body.get("username") or "").strip()
                    password = str(body.get("password") or "")
                    if not username or not password:
                        self.send_json({"error": "账号和密码不能为空"}, status=HTTPStatus.BAD_REQUEST)
                        return
                    state = jm_session.configure(username, password, servers)
                else:
                    state = jm_session.ensure(servers)
                self.send_json({"authenticated": True, "user": state["user"]})
            except JmSessionError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.UNAUTHORIZED)
            return
        if parsed.path == "/local-api/ai/config":
            body = self.read_json_body()
            if body is None:
                return
            try:
                self.send_json(local_features.save_ai_config(body))
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/ai/embeddings/config":
            body = self.read_json_body()
            if body is None:
                return
            try:
                self.send_json(local_features.save_embedding_config(body))
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/ai/embeddings/test":
            body = self.read_json_body()
            if body is None:
                return
            try:
                if any(key in body for key in ("api_key", "api_base_url")):
                    local_features.save_embedding_config(body)
                self.send_json(embedding_runtime.test_connection())
            except (LocalFeatureError, QwenEmbeddingError) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path == "/local-api/ai/test":
            body = self.read_json_body()
            if body is None:
                return
            try:
                if any(key in body for key in ("api_key", "base_url", "model")):
                    local_features.save_ai_config(body)
                self.send_json(local_features.test_ai())
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path == "/local-api/ai/translate":
            body = self.read_json_body()
            if body is None:
                return
            try:
                self.send_json(local_features.translate_title(body.get("title")))
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path == "/local-api/library/comic":
            body = self.read_json_body()
            if body is None:
                return
            try:
                comic = local_features.upsert_comic(body)
                if comic_has_explicit_embedding_evidence(comic):
                    embedding_runtime.enqueue_background(comic)
                self.send_json({"comic": comic})
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/library/feedback/states":
            body = self.read_json_body()
            if body is None:
                return
            self.send_json(local_features.feedback_states(body.get("ids")))
            return
        if parsed.path == "/local-api/library/favorites/sync":
            body = self.read_json_body()
            if body is None:
                return
            try:
                comics = body.get("comics")
                result = local_features.sync_favorites(comics)
                self.send_json(result)
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/ai/profile/generate":
            body = self.read_json_body()
            if body is None:
                return
            try:
                self.send_json({"profile": local_features.generate_profile()})
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path == "/local-api/ai/recommendations/generate":
            body = self.read_json_body()
            if body is None:
                return
            try:
                prepared = embedding_runtime.prepare_candidates(body.get("candidates"))
                ready_ids = set(prepared["ready_ids"])
                request_body = {
                    **body,
                    "candidates": [
                        item for item in body.get("candidates", [])
                        if isinstance(item, dict) and str(item.get("id") or "") in ready_ids
                    ],
                }
                result = local_features.generate_recommendations(request_body)
                result["embeddings"] = prepared
                self.send_json(result)
            except QwenEmbeddingError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            except (LocalFeatureError, TypeError, ValueError) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
            return
        if parsed.path == "/local-api/ai/recommendations/feedback":
            body = self.read_json_body()
            if body is None:
                return
            try:
                self.send_json(local_features.save_recommendation_feedback(body))
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/ai/interactions":
            body = self.read_json_body()
            if body is None:
                return
            try:
                saved = local_features.record_interaction(body)
                comic = body.get("comic") if isinstance(body.get("comic"), dict) else body
                if saved.get("event_type") == "read_start":
                    embedding_runtime.enqueue_background(comic)
                self.send_json(saved)
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        if parsed.path == "/local-api/ai/features":
            body = self.read_json_body()
            if body is None:
                return
            try:
                self.send_json(local_features.save_item_features(body))
            except LocalFeatureError as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        cache_target = self.parse_cache_target(parsed.path)
        if cache_target:
            body = self.read_json_body()
            if body is None:
                return
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
        if method == "POST":
            normalized = data if isinstance(data, dict) else {}
            payload = urlencode({str(key): str(value) for key, value in normalized.items()}).encode("utf-8")
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
                    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8"
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
            kind = parse_qs(parsed.query).get("kind", [""])[0]
            try:
                self.send_json(local_features.library_history(kind, clear=True))
            except (LocalFeatureError, ValueError) as error:
                self.send_json({"error": str(error)}, status=HTTPStatus.BAD_REQUEST)
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
        if parsed.path == "/local-api/ai/config":
            self.send_json(local_features.clear_ai_config())
            return
        if parsed.path == "/local-api/ai/embeddings/config":
            self.send_json(local_features.clear_embedding_config())
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

    def send_json(self, value: object, status: int = HTTPStatus.OK) -> None:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_raw_json(payload, status)

    def send_raw_json(self, payload: bytes, status: int = HTTPStatus.OK) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Safari may cancel an in-flight request when a view is replaced.
            self.close_connection = True

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
        embedding_runtime.stop()
        server.server_close()


if __name__ == "__main__":
    main()
