#!/usr/bin/env python3
"""Durable local library: reading/random/watch-later history, search history, ratings and tag/author preferences."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path


class LibraryError(RuntimeError):
    pass


# "later" is the watch-later list; it shares the history storage and ordering.
HISTORY_KINDS = {"reading", "random", "later"}
# Display order is the order of these tuples: strongest liking first.
PREFERENCE_LEVELS = {
    "tag": ("like", "fond", "avoid", "dislike"),
    "author": ("like", "dislike"),
}
MAX_PREFERENCES_PER_KIND = 1000
MAX_SEARCH_HISTORY = 50
COMIC_ID = re.compile(r"\d{1,16}")
PREFERENCE_NAME = re.compile(r"[^\x00-\x1f\x7f]{1,80}")


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


def _comic_id(value: object) -> str:
    clean = str(value or "").strip()
    if not COMIC_ID.fullmatch(clean):
        raise LibraryError("漫画 ID 无效")
    return clean


def _text(value: object, maximum: int) -> str:
    return str(value or "").strip()[:maximum]


def _text_list(value: object, maximum: int = 20) -> list[str]:
    values = value if isinstance(value, list) else ([value] if value else [])
    result = []
    for item in values:
        clean = _text(item, 120)
        if clean and clean not in result:
            result.append(clean)
    return result[:maximum]


class LocalLibrary:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.database_path = data_dir / "user_library.sqlite3"
        self.lock = threading.RLock()
        self.ensure_schema()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=15)
        connection.row_factory = sqlite3.Row
        return connection

    @contextmanager
    def _connection(self):
        connection = self.connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def ensure_schema(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        with self.lock, self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS library_history (
                    kind TEXT NOT NULL, comic_id TEXT NOT NULL,
                    saved_at INTEGER NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY (kind, comic_id)
                );
                CREATE TABLE IF NOT EXISTS library_history_imports (
                    fingerprint TEXT PRIMARY KEY
                );
                CREATE TABLE IF NOT EXISTS ratings (
                    comic_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    authors TEXT NOT NULL,
                    cover_url TEXT NOT NULL,
                    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS preferences (
                    kind TEXT NOT NULL CHECK (kind IN ('tag', 'author')),
                    name TEXT NOT NULL,
                    level TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (kind, name)
                );
                CREATE TABLE IF NOT EXISTS search_history (
                    query TEXT PRIMARY KEY,
                    saved_at INTEGER NOT NULL
                );
                """
            )
        try:
            self.database_path.chmod(0o600)
        except OSError:
            pass

    def library_history(self, kind, items=None, *, legacy=False, clear=False, remove=None):
        if kind not in HISTORY_KINDS:
            raise LibraryError("历史类型无效")
        removed = _comic_id(remove) if remove is not None else None
        normalized = []
        if items is not None:
            if not isinstance(items, list) or len(items) > 1000:
                raise LibraryError("历史记录必须为列表且不超过 1000 条")
            for item in items:
                if not isinstance(item, dict) or not COMIC_ID.fullmatch(str(item.get("id", ""))):
                    raise LibraryError("历史记录编号无效")
                timestamp = item.get("savedAt", 0)
                if (isinstance(timestamp, bool) or not isinstance(timestamp, (int, float))
                        or not math.isfinite(timestamp) or not 0 <= timestamp <= 8640000000000000):
                    raise LibraryError("历史记录时间无效")
                value = dict(item, id=str(item["id"]), savedAt=int(timestamp))
                payload = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)
                if len(payload.encode("utf-8")) > 64000:
                    raise LibraryError("单条历史记录过大")
                normalized.append((value, payload))
        with self.lock, self._connection() as connection:
            if clear:
                connection.execute("DELETE FROM library_history WHERE kind=?", (kind,))
            if removed:
                connection.execute("DELETE FROM library_history WHERE kind=? AND comic_id=?", (kind, removed))
            for value, payload in normalized:
                if legacy:
                    fingerprint = hashlib.sha256((kind + payload).encode("utf-8")).hexdigest()
                    cursor = connection.execute("INSERT OR IGNORE INTO library_history_imports VALUES (?)", (fingerprint,))
                    if not cursor.rowcount:
                        continue
                connection.execute(
                    "INSERT INTO library_history VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(kind, comic_id) DO UPDATE SET saved_at=excluded.saved_at, payload=excluded.payload "
                    "WHERE excluded.saved_at >= library_history.saved_at",
                    (kind, value["id"], value["savedAt"], payload),
                )
            rows = connection.execute(
                "SELECT payload FROM library_history WHERE kind=? ORDER BY saved_at DESC, comic_id DESC",
                (kind,),
            ).fetchall()
        return {"items": [json.loads(row["payload"]) for row in rows]}

    def search_history(self, query=None, *, remove=None, clear=False) -> dict:
        """Recent search keywords, newest first; re-searching a keyword moves it to the top."""
        with self.lock, self._connection() as connection:
            if clear:
                connection.execute("DELETE FROM search_history")
            if remove is not None:
                connection.execute("DELETE FROM search_history WHERE query=?", (_text(remove, 200),))
            if query is not None:
                clean = _text(query, 200)
                if not PREFERENCE_NAME.fullmatch(clean):
                    raise LibraryError("搜索关键词不能为空，且不超过 80 个字符")
                saved_at = int(time.time() * 1000)
                latest = connection.execute("SELECT MAX(saved_at) FROM search_history").fetchone()[0]
                # Keep the newest search first even when two land in the same millisecond.
                saved_at = max(saved_at, (latest or 0) + 1)
                connection.execute(
                    "INSERT INTO search_history(query,saved_at) VALUES(?,?) "
                    "ON CONFLICT(query) DO UPDATE SET saved_at=excluded.saved_at",
                    (clean, saved_at),
                )
                connection.execute(
                    "DELETE FROM search_history WHERE query NOT IN "
                    "(SELECT query FROM search_history ORDER BY saved_at DESC LIMIT ?)",
                    (MAX_SEARCH_HISTORY,),
                )
            rows = connection.execute(
                "SELECT query,saved_at FROM search_history ORDER BY saved_at DESC LIMIT ?", (MAX_SEARCH_HISTORY,),
            ).fetchall()
        return {"items": [{"query": row["query"], "savedAt": row["saved_at"]} for row in rows]}

    @staticmethod
    def _rating_from_row(row: sqlite3.Row) -> dict:
        return {
            "id": row["comic_id"],
            "title": row["title"],
            "authors": json.loads(row["authors"]),
            "cover_url": row["cover_url"],
            "rating": row["rating"],
            "updated_at": row["updated_at"],
        }

    def get_rating(self, comic_id: object) -> dict | None:
        clean_id = _comic_id(comic_id)
        with self.lock, self._connection() as connection:
            row = connection.execute("SELECT * FROM ratings WHERE comic_id=?", (clean_id,)).fetchone()
        return self._rating_from_row(row) if row else None

    def list_ratings(self) -> list[dict]:
        with self.lock, self._connection() as connection:
            rows = connection.execute("SELECT * FROM ratings ORDER BY updated_at DESC, comic_id DESC").fetchall()
        return [self._rating_from_row(row) for row in rows]

    def save_rating(self, value: object) -> dict | None:
        """Store a 1–10 score; a null rating removes the record entirely."""
        data = value if isinstance(value, dict) else {}
        comic_id = _comic_id(data.get("id"))
        rating = data.get("rating")
        if rating is None:
            with self.lock, self._connection() as connection:
                connection.execute("DELETE FROM ratings WHERE comic_id=?", (comic_id,))
            return None
        if isinstance(rating, bool) or not isinstance(rating, int) or not 1 <= rating <= 10:
            raise LibraryError("评分必须是 1 到 10 的整数")
        with self.lock, self._connection() as connection:
            connection.execute(
                """INSERT INTO ratings(comic_id,title,authors,cover_url,rating,updated_at) VALUES(?,?,?,?,?,?)
                   ON CONFLICT(comic_id) DO UPDATE SET title=excluded.title,authors=excluded.authors,
                   cover_url=excluded.cover_url,rating=excluded.rating,updated_at=excluded.updated_at""",
                (
                    comic_id,
                    _text(data.get("title"), 500),
                    json.dumps(_text_list(data.get("authors")), ensure_ascii=False),
                    _text(data.get("cover_url"), 2000),
                    rating,
                    int(time.time()),
                ),
            )
            row = connection.execute("SELECT * FROM ratings WHERE comic_id=?", (comic_id,)).fetchone()
        return self._rating_from_row(row)

    def preferences(self) -> dict:
        """Every tag and author stance, grouped by kind as {name: level}."""
        with self.lock, self._connection() as connection:
            rows = connection.execute("SELECT kind,name,level FROM preferences ORDER BY kind,name").fetchall()
        result = {"tags": {}, "authors": {}}
        for row in rows:
            result[f"{row['kind']}s"][row["name"]] = row["level"]
        return result

    def set_preference(self, value: object) -> dict:
        """Upsert one stance; `level: null` deletes it and `previous` renames an entry."""
        data = value if isinstance(value, dict) else {}
        kind = data.get("kind")
        if kind not in PREFERENCE_LEVELS:
            raise LibraryError("偏好类型无效")
        name = _text(data.get("name"), 200)
        if not PREFERENCE_NAME.fullmatch(name):
            raise LibraryError("名称不能为空，且不超过 80 个字符")
        level = data.get("level")
        if level is not None and level not in PREFERENCE_LEVELS[kind]:
            raise LibraryError("偏好等级无效")
        previous = _text(data.get("previous"), 200)
        with self.lock, self._connection() as connection:
            if previous and previous != name:
                connection.execute("DELETE FROM preferences WHERE kind=? AND name=?", (kind, previous))
            if level is None:
                connection.execute("DELETE FROM preferences WHERE kind=? AND name=?", (kind, name))
            else:
                exists = connection.execute(
                    "SELECT 1 FROM preferences WHERE kind=? AND name=?", (kind, name),
                ).fetchone()
                count = connection.execute("SELECT COUNT(*) FROM preferences WHERE kind=?", (kind,)).fetchone()[0]
                if not exists and count >= MAX_PREFERENCES_PER_KIND:
                    raise LibraryError(f"每类偏好最多 {MAX_PREFERENCES_PER_KIND} 项")
                connection.execute(
                    """INSERT INTO preferences(kind,name,level,updated_at) VALUES(?,?,?,?)
                       ON CONFLICT(kind,name) DO UPDATE SET level=excluded.level,updated_at=excluded.updated_at""",
                    (kind, name, level, int(time.time())),
                )
        return self.preferences()
