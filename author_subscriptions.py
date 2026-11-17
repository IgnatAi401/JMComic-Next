"""Server-side author subscription checks.

The subscription document lives in the library (see `LocalLibrary.author_subscriptions`); browsers edit
it and this module fills in what each check finds. Checks run in one background thread, so they keep
going when every page is closed or reloaded; browsers start one and follow it through `status()`.

New works: search results come newest first, but ids are not strictly increasing (re-uploaded old works
get new ids), so a result counts as new when it was updated after the last check (with slack for JM's
indexing delay) or its id is above the highest id seen. Ids already seen are never added twice.
"""

from __future__ import annotations

import re
import threading
import time
import unicodedata

from local_library import LibraryError

CHECK_INTERVAL = 24 * 60 * 60
RETRY_AFTER_FAILURE = 60 * 60
# Newly uploaded works take a while to show up in search; look three days further back.
INDEX_LAG = 3 * 24 * 60 * 60
REQUEST_GAP = 1.5
MAX_PAGES = 3
MAX_SEEN = 400
# How often the scheduler looks for authors whose daily check is due.
SCHEDULE_TICK = 10 * 60
SCHEDULE_FIRST_DELAY = 30
WRITE_ATTEMPTS = 8

# Author fields look like "Circle (Author)", "A、B", "A & B"; split them and compare whole parts so a word
# that merely appears in a title or tag does not count.
AUTHOR_SEPARATORS = re.compile(r"[()（）\[\]【】「」、,，&＆/／|｜;；+＋]+")
TITLE_BYLINE = re.compile(r"^\s*\[([^\]]+)\]")


def now_ms() -> int:
    return int(time.time() * 1000)


def normalize_author(value: object) -> str:
    """Compare names ignoring full/half width, case and extra spaces."""
    text = unicodedata.normalize("NFKC", str(value if value is not None else ""))
    return re.sub(r"\s+", " ", text).strip().lower()


def raw_author_parts(value: object) -> list[str]:
    items = value if isinstance(value, list) else [value]
    parts = []
    for item in items:
        for part in AUTHOR_SEPARATORS.split(str(item if item is not None else "")):
            part = re.sub(r"\s+", " ", part).strip()
            if part:
                parts.append(part)
    return parts


def author_parts(value: object) -> list[str]:
    return [part for part in (normalize_author(raw) for raw in raw_author_parts(value)) if part]


def title_byline(title: object) -> str:
    """The leading byline of "[Circle (Author)] Title (Source) [Language]"; only the first bracket counts."""
    match = TITLE_BYLINE.match(unicodedata.normalize("NFKC", str(title or "")))
    return match.group(1) if match else ""


def matches_author(item: dict, names: set[str]) -> bool:
    return any(part in names for part in author_parts(item.get("author")))


def matches_title(item: dict, names: set[str]) -> bool:
    return any(part in names for part in author_parts(title_byline(item.get("name"))))


def alias_list(value: object) -> list[dict]:
    """Old documents stored aliases as plain strings; use { name, source } throughout."""
    aliases = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, str):
            item = {"name": item, "source": "auto"}
        if isinstance(item, dict) and item.get("name"):
            aliases.append(item)
    return aliases


def guess_alias(content: list, rejected: set[str]) -> str:
    """When nothing matches (e.g. variant characters JM search treats as equal), take a clearly dominant
    author spelling from the results as an alias."""
    counts: dict[str, list] = {}
    for item in content:
        parts = {normalize_author(raw): raw for raw in raw_author_parts(item.get("author") if isinstance(item, dict) else None)}
        for key, raw in parts.items():
            if key in rejected:
                continue
            entry = counts.setdefault(key, [raw, 0])
            entry[1] += 1
    if not counts:
        return ""
    raw, count = max(counts.values(), key=lambda entry: entry[1])
    return raw if count >= max(3, len(content) * 0.3) else ""


def to_number(value: object) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return number if number == number else 0  # NaN


def find_author(state: dict, name: str) -> dict | None:
    key = normalize_author(name)
    for author in state.get("authors") or []:
        if isinstance(author, dict) and normalize_author(author.get("name")) == key:
            return author
    return None


def is_due(author: dict, current: int) -> bool:
    failed_at = to_number(author.get("failedAt"))
    if failed_at and current - failed_at < RETRY_AFTER_FAILURE * 1000:
        return False
    checked_at = to_number(author.get("checkedAt"))
    return not checked_at or current - checked_at >= CHECK_INTERVAL * 1000


def comic_from_search(item: dict, source: str, found_at: int, via: str) -> dict:
    category = item.get("category")
    comic = {
        "id": str(item["id"]),
        "name": str(item.get("name") or f"漫画 #{item['id']}"),
        "author": [str(item.get("author"))] if author_parts(item.get("author")) else [],
        "updateAt": int(to_number(item.get("update_at"))),
        "sources": [source],
        "foundAt": found_at,
    }
    if isinstance(category, dict) and category.get("title"):
        comic["category"] = {"title": str(category["title"])}
    if via == "title":
        comic["via"] = via
    return comic


class SubscriptionChecker:
    """One background worker checks queued authors one by one and saves after each of them.

    `search(query, page) -> dict` returns JM's decrypted search result ({"content": [...]}).
    """

    def __init__(self, library, search, sleep=time.sleep) -> None:
        self.library = library
        self.search = search
        self.sleep = sleep
        self.lock = threading.Lock()
        self.queue: list[str] = []
        self.done: set[str] = set()
        self.current = ""
        self.thread: threading.Thread | None = None
        self.run_id = 0
        self.run: dict | None = None
        self.last_run: dict | None = None
        self.scheduler: threading.Thread | None = None

    # ----- state shown to browsers -----

    def status(self) -> dict:
        with self.lock:
            return self._status()

    def _status(self) -> dict:
        running = self.thread is not None
        run = self.run if running else None
        progress = None
        if run and run.get("progress"):
            # Authors queued after this one started still count toward the total.
            progress = {**run["progress"], "total": run["progress"]["index"] + len(self.queue)}
        return {
            "running": running,
            "runId": self.run_id,
            "progress": progress,
            "startedAt": run["startedAt"] if run else 0,
            "auto": bool(run and run["auto"]),
            "lastRun": dict(self.last_run) if self.last_run else None,
            "revision": self.library.author_subscriptions_revision(),
        }

    # ----- starting checks -----

    def request(self, names: list[str] | None = None, everyone: bool = False, auto: bool = False) -> dict:
        """Queue a check. `names` are always (re)checked; `everyone` adds the authors not yet checked
        in the current run; neither means only authors whose daily check is due."""
        state = self.library.author_subscriptions().get("state") or {}
        authors = [author for author in state.get("authors") or [] if isinstance(author, dict) and author.get("name")]
        current = now_ms()
        with self.lock:
            if self.thread is None:
                self.done = set()
            if names:
                wanted = [str(name) for name in names if find_author(state, str(name))]
                forced = True
            elif everyone:
                wanted = [author["name"] for author in authors]
                forced = False
            else:
                wanted = [author["name"] for author in authors if is_due(author, current)]
                forced = False
            queued = {normalize_author(name) for name in self.queue}
            for name in wanted:
                key = normalize_author(name)
                # The author being checked right now counts as done unless asked for by name.
                if key in queued or (not forced and (key in self.done or key == self.current)):
                    continue
                queued.add(key)
                self.queue.append(name)
            if self.queue and self.thread is None:
                self._start_run(auto)
            elif self.thread is not None and not auto and self.run:
                # Someone asked while a scheduled run was going: report it as theirs too.
                self.run["auto"] = False
            return self._status()

    def _start_run(self, auto: bool) -> None:
        # Called with the lock held.
        self.run_id += 1
        self.done = set()
        self.run = {
            "id": self.run_id, "auto": auto, "startedAt": now_ms(),
            "added": 0, "checked": 0, "failed": [], "progress": None,
        }
        self.thread = threading.Thread(target=self._work, name="author-subscriptions", daemon=True)
        self.thread.start()

    def start_scheduler(self) -> None:
        if self.scheduler is not None:
            return

        def loop() -> None:
            self.sleep(SCHEDULE_FIRST_DELAY)
            while True:
                try:
                    self.request(auto=True)
                except Exception as error:  # Keep scheduling after an unexpected failure.
                    print(f"作者订阅定时检查失败: {error}")
                self.sleep(SCHEDULE_TICK)

        self.scheduler = threading.Thread(target=loop, name="author-subscriptions-schedule", daemon=True)
        self.scheduler.start()

    # ----- the worker -----

    def _work(self) -> None:
        first = True
        try:
            while True:
                with self.lock:
                    if not self.queue:
                        break
                    name = self.queue.pop(0)
                    self.current = normalize_author(name)
                    run = self.run
                    run["progress"] = {"index": run["checked"] + len(run["failed"]) + 1,
                                       "total": run["checked"] + len(run["failed"]) + 1 + len(self.queue),
                                       "name": name}
                if not first:
                    self.sleep(REQUEST_GAP)
                first = False
                try:
                    added = self._check_author(name)
                    with self.lock:
                        run["added"] += added
                        run["checked"] += 1
                except Exception as error:
                    message = str(error)[:200] or "检查失败"
                    with self.lock:
                        run["failed"].append(name)
                    self._update(lambda state: self._mark_failed(state, name, message))
                with self.lock:
                    self.done.add(normalize_author(name))
                    self.current = ""
            self._update(lambda state: state.__setitem__("lastRunAt", now_ms()))
        finally:
            with self.lock:
                run = self.run or {}
                self.last_run = {
                    "id": run.get("id", self.run_id), "auto": bool(run.get("auto")),
                    "startedAt": run.get("startedAt", 0), "finishedAt": now_ms(),
                    "added": run.get("added", 0), "checked": run.get("checked", 0),
                    "failed": list(run.get("failed", [])),
                }
                self.run = None
                self.thread = None
                # Names queued while this run was saving its result start the next run right away.
                if self.queue:
                    self._start_run(auto=False)

    @staticmethod
    def _mark_failed(state: dict, name: str, message: str) -> None:
        author = find_author(state, name)
        if author is not None:
            author.update(error=message, failedAt=now_ms())

    def _update(self, mutate):
        """Apply `mutate(state)` to the stored document, replaying it if a browser saved in between."""
        for _ in range(WRITE_ATTEMPTS):
            current = self.library.author_subscriptions()
            state = current.get("state")
            if not isinstance(state, dict):
                state = {"version": 1, "authors": [], "updates": [], "lastRunAt": 0, "fuzzy": True}
            state.setdefault("authors", [])
            state.setdefault("updates", [])
            result = mutate(state)
            saved = self.library.author_subscriptions(state, current.get("revision", 0))
            if not saved.get("conflict"):
                return result
        raise LibraryError("订阅数据一直被其他设备改写，稍后重试")

    def _check_author(self, name: str) -> int:
        state = self.library.author_subscriptions().get("state") or {}
        subscription = find_author(state, name)
        if subscription is None:
            return 0
        subscription_name = str(subscription["name"])
        checked_at = to_number(subscription.get("checkedAt"))
        baseline = not checked_at
        seen = {str(item) for item in subscription.get("seen") or []}
        since = checked_at - INDEX_LAG * 1000
        started_at = now_ms()
        found: list[dict] = []
        page_ids: list[str] = []
        max_id = int(to_number(subscription.get("maxId")))
        fuzzy = state.get("fuzzy") is not False
        aliases = alias_list(subscription.get("aliases"))
        rejected = set(subscription.get("rejected") or [])

        def names() -> set[str]:
            # With fuzzy matching off aliases are kept but unused: only the subscribed name counts.
            return {normalize_author(subscription_name), *([normalize_author(item["name"]) for item in aliases] if fuzzy else [])}

        def select(content: list) -> list[tuple[dict, str]]:
            matched = []
            current = names()
            for item in content:
                if not isinstance(item, dict) or not item.get("id"):
                    continue
                if matches_author(item, current):
                    matched.append((item, "author"))
                elif fuzzy and matches_title(item, current):
                    matched.append((item, "title"))
            return matched

        page = 1
        while page <= (1 if baseline else MAX_PAGES):
            if page > 1:
                self.sleep(REQUEST_GAP)
            response = self.search(subscription_name, page)
            content = response.get("content") if isinstance(response, dict) else None
            content = content if isinstance(content, list) else []
            matched = select(content)
            # Learn an alias only when no author field matched at all; byline matches still count as works.
            if fuzzy and page == 1 and not any(via == "author" for _, via in matched):
                alias = guess_alias(content, rejected)
                if alias:
                    aliases.append({"name": alias, "source": "auto"})
                    # Matching changed and these works were never recorded: treat this run as a new baseline.
                    baseline = True
                    matched = select(content)
            fresh = 0
            for item, via in matched:
                comic_id = str(item["id"])
                page_ids.append(comic_id)
                if baseline or comic_id in seen:
                    continue
                updated_at = to_number(item.get("update_at")) * 1000
                # Ids only count once something has matched before; with maxId 0 every old work would be "new".
                id_number = to_number(comic_id)
                if updated_at > since or (max_id > 0 and id_number > max_id):
                    found.append(comic_from_search(item, subscription_name, started_at, via))
                    fresh += 1
            # A page of nothing but new works may continue on the next page; otherwise stop here.
            if not matched or fresh < len(matched) or len(content) < 20:
                break
            page += 1
        for comic_id in page_ids:
            max_id = max(max_id, int(to_number(comic_id)))

        def apply(state: dict) -> int:
            author = find_author(state, name)
            if author is None:
                return 0
            # Keep alias changes made during the check; an auto alias never overrides a rejected one.
            current = alias_list(author.get("aliases"))
            refused = set(author.get("rejected") or [])
            for alias in aliases:
                key = normalize_author(alias["name"])
                if key not in refused and not any(normalize_author(item["name"]) == key for item in current):
                    current.append(alias)
            author["aliases"] = current
            known = list(dict.fromkeys([*page_ids, *(str(item) for item in author.get("seen") or [])]))[:MAX_SEEN]
            author.update(checkedAt=started_at, maxId=max_id, seen=known, error="", failedAt=0)
            updates = state["updates"]
            added = 0
            for comic in found:
                existing = next((item for item in updates if isinstance(item, dict) and item.get("id") == comic["id"]), None)
                if existing is not None:
                    sources = existing.setdefault("sources", [])
                    if comic["sources"][0] not in sources:
                        sources.append(comic["sources"][0])
                    continue
                updates.insert(0, comic)
                added += 1
            updates.sort(key=lambda item: (-(to_number(item.get("updateAt")) if isinstance(item, dict) else 0),
                                           -(to_number(item.get("id")) if isinstance(item, dict) else 0)))
            return added

        return self._update(apply)
