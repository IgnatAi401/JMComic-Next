#!/usr/bin/env python3
"""Serve real UI modules with neutral in-memory data for local Safari checks.

Run: python3 tests/serve_ui_fixture.py
Open: http://127.0.0.1:48128/index.html (also setting/messages/reader/chapter/ai).
This server never starts the backend, reads project/data, or proxies requests.
"""

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import tempfile
from urllib.parse import parse_qs, unquote, urlsplit


ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT / "project"
PAGES = {"index", "setting", "messages", "reader", "chapter", "ai", "library", "search", "latest", "categories"}
LOGOS = {"1e1c27c3-4553-4d6d-ad8c-d06dacbbfb5a.png", "b5c2a091-eb74-4b78-99dd-b52dc2a1dfe5.png"}
REPORT = Path(tempfile.gettempdir()) / "jmcomic-ui-fixture-report.json"
ENTRY = re.compile(r'<script\s+type="module"\s+src="\./src/pages/[^\"]+"\s*></script>')


def illustration(index, reader=False):
    """Abstract shapes only; all sample covers and pages are generated here."""
    number = int(index) % 100
    height = 1050 if reader else 800
    colors = ["#716345", "#64706d", "#727189", "#a28057", "#536375"]
    accent = colors[number % len(colors)]
    label = "READING SAMPLE" if reader else "FIELD NOTES"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="600" height="{height}" viewBox="0 0 600 {height}">
<rect width="600" height="{height}" fill="#ede9dd"/><rect x="24" y="24" width="552" height="{height-48}" rx="8" fill="{accent}"/>
<circle cx="410" cy="240" r="128" fill="#dfc580"/><path d="M24 600 225 310 410 590 576 380v396H24Z" fill="#222c32"/>
<path d="M24 660 190 510 380 680 576 510v266H24Z" fill="#a8aaa0"/>
<text x="55" y="98" fill="#f8f2e4" font-size="22" letter-spacing="5" font-family="sans-serif">{label}</text>
<text x="55" y="156" fill="#f8f2e4" font-size="38" font-family="sans-serif">No. {number:02d}</text>
<text x="55" y="{height-64}" fill="#222c32" font-size="18" font-family="sans-serif">LOCAL UI FIXTURE / FICTIONAL CONTENT</text></svg>'''.encode()


class FixtureHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if urlsplit(self.path).path != "/__fixture__/report":
            return self.send_error(404)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 65536:
                return self.send_error(413)
            report = json.loads(self.rfile.read(length))
            if not isinstance(report, dict) or report.get("page") != "ui-check":
                return self.send_error(400)
            REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        except (ValueError, OSError):
            return self.send_error(400)
        self.respond(b'{"saved":true}', "application/json", False)

    def do_GET(self):
        self.serve(False)

    def do_HEAD(self):
        self.serve(True)

    def serve(self, head_only):
        request = urlsplit(self.path)
        path = unquote(request.path)
        if path == "/":
            path = "/index.html"
        if path == "/__fixture__/entry.js":
            return self.respond((ROOT / "tests" / "ui_fixture.js").read_bytes(), "text/javascript; charset=utf-8", head_only)
        if path in {"/__fixture__/cover.svg", "/image/cover.png"}:
            query = parse_qs(request.query)
            try:
                data = illustration(query.get("i", ["1"])[0], query.get("reader", ["0"])[0] == "1")
            except ValueError:
                return self.send_error(400)
            return self.respond(data, "image/svg+xml", head_only)

        relative = Path(path.lstrip("/"))
        check = path == "/ui-check.html"
        page = "setting" if check else relative.stem if len(relative.parts) == 1 and relative.suffix == ".html" else None
        if page in PAGES:
            source = (PROJECT / f"{page}.html").read_text(encoding="utf-8")
            source, count = ENTRY.subn(f'<script type="module" src="/__fixture__/entry.js?page={page}{"&check=1" if check else ""}"></script>', source)
            if count != 1:
                return self.send_error(500, "Page entry was not replaced; refusing to run live UI")
            badge = '<a href="/ui-check.html" style="position:fixed;left:12px;bottom:10px;z-index:100;padding:5px 10px;border:1px solid #c7922f;border-radius:8px;background:#111;color:#f4dfb3;font:11px/1.5 sans-serif">UI 测试 · 虚构数据 · 点击运行检查</a>'
            source = source.replace("</body>", badge + "</body>")
            return self.respond(source.encode(), "text/html; charset=utf-8", head_only)

        allowed = ((relative.parts[:1] == ("src",) and relative.suffix == ".js")
                   or (relative.parts[:1] == ("style",) and relative.suffix == ".css")
                   or (relative.parts[:1] == ("image",) and relative.name in LOGOS))
        candidate = (PROJECT / relative).resolve()
        if not allowed or not candidate.is_relative_to(PROJECT.resolve()) or not candidate.is_file():
            return self.send_error(404)
        # Reject traversal/symlinks into data/cache, including through an allowed prefix.
        resolved = candidate.relative_to(PROJECT.resolve())
        if resolved.parts[:1] != relative.parts[:1] or ".." in relative.parts:
            return self.send_error(404)
        mime = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png"}[relative.suffix]
        return self.respond(candidate.read_bytes(), mime, head_only)

    def respond(self, data, content_type, head_only):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'")
        self.end_headers()
        if not head_only:
            self.wfile.write(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=48128)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), FixtureHandler)
    print(f"Isolated UI fixture: http://127.0.0.1:{args.port}/index.html", flush=True)
    print(f"Browser checks: http://127.0.0.1:{args.port}/ui-check.html; report: {REPORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
