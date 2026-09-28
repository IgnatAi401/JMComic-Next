"""Background preparation and presentation of the same evidence used by ranking."""
import hashlib
import json
import queue
import threading

from content_evidence import ContentEvidence
from recommender import DIMENSIONS

VERSION = "content-analysis-v2"


class ContentAnalysis:
    def __init__(self, store, source_loader=None):
        self.store = store
        self.source_loader = source_loader
        self.lock = threading.RLock()
        self.pending = set()
        self.queue = queue.Queue()
        self.worker = None
        self.stopping = False
        self.states = {}
        self.content = ContentEvidence(store)

    def snapshot(self, comic):
        config = self.config()
        # Rating/review deletion, score edits and model changes invalidate results.
        payload = self.content.revision(comic)
        identity = [VERSION, config.get("base_url"), config.get("model"), payload]
        digest = hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        return digest, payload, config

    def config(self):
        try:
            return self.store.read_ai_config()
        except Exception:
            return {"configured": False}

    def get(self, comic_id):
        comic = self.store.get_comic(comic_id)
        if not comic or comic["rating"] is None:
            return {"status": "unrated", "text": "", "current": False}
        digest, _, config = self.snapshot(comic)
        entry = self.content.cached(comic_id).get(str(comic_id)) if config.get("configured") else None
        current = bool(entry and self.content.current(entry, comic) and entry["status"] == "ready")
        if current and self.source_loader:
            current = bool(entry["source"].get("description_fetched") and entry["source"]["comments_status"] == "ready")
        with self.lock:
            active = (str(comic_id), digest) in self.pending
            state = self.states.get((str(comic_id), digest), "queued")
        if active:
            status = state
        elif not config.get("configured"):
            status = "unconfigured"
        elif current:
            status = "ready"
        elif state == "error" or (entry and entry["status"] == "error"):
            status = "error"
        else:
            status = "stale" if entry else "missing"
        text = ""
        if entry and entry.get("text"):
            parsed = json.loads(entry["text"])
            summary = parsed.get("summary", "")
            lines = [summary] if isinstance(summary, str) and summary else []
            lines.append("参与推荐的内容特征：")
            for name, assertion in entry["assertions"].items():
                origin = {"user_review": "你的评语", "title": "标题", "description": "简介"}.get(assertion["source"], "读者评论")
                lines.append(f'{DIMENSIONS[name]}：{assertion["value"]}（{origin}）\n依据：{assertion["quote"]}')
            if not entry["assertions"]:
                lines.append("暂无通过原文核验的特征。")

            text = "\n".join(lines)
        return {"status": status, "text": text, "current": current,
                "updated_at": entry["updated_at"] if entry else None,
                "error": "作品资料获取或内容分析失败，请在设置中重试；评分和评语已保留。" if status == "error" else ""}

    def enqueue(self, comic_id):
        comic = self.store.get_comic(comic_id)
        if not comic or comic["rating"] is None:
            return self.get(comic_id)
        digest, _, config = self.snapshot(comic)
        state = self.get(comic_id)
        task = (comic["id"], digest)
        with self.lock:
            if self.stopping or not config.get("configured") or state["current"] or task in self.pending:
                return state
            self.pending.add(task)
            self.states[task] = "queued"
            self.queue.put(task)
            if not self.worker or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._run, name="content-analysis", daemon=True)
                self.worker.start()
        return self.get(comic_id)

    def update_missing(self):
        rated = [c for c in self.store.list_comics("all") if c["rating"] is not None]
        queued = 0
        for comic in rated:
            before = self.get(comic["id"])
            if before["current"] or before["status"] in {"queued", "running"}:
                continue
            if self.enqueue(comic["id"])["status"] in {"queued", "running", "ready"}:
                queued += 1
        return {"queued": queued, **self.overview()}

    def overview(self):
        items = []
        counts = {key: 0 for key in ("ready", "queued", "running", "error", "missing", "stale", "unconfigured")}
        for comic in self.store.list_comics("all"):
            if comic["rating"] is None:
                continue
            state = self.get(comic["id"])
            if state["status"] == "unrated":
                continue
            counts["ready" if state["current"] and state["status"] not in {"running", "queued"} else state["status"]] += 1
            if state["status"] != "ready":
                items.append({"id": comic["id"], "title": comic["title"], "rating": comic["rating"], **state})
        return {"counts": counts, "items": items, "configured": bool(self.config().get("configured"))}

    def _run(self):
        while True:
            task = self.queue.get()
            if task is None:
                self.queue.task_done()
                return
            comic_id, digest = task
            try:
                if not self.stopping:
                    self._analyze(comic_id, digest)
            finally:
                with self.lock:
                    self.pending.discard(task)
                self.queue.task_done()

    def _analyze(self, comic_id, digest):
        def valid():
            comic = self.store.get_comic(comic_id)
            return bool(comic and comic["rating"] is not None and self.snapshot(comic)[0] == digest)
        try:
            if not valid():
                return
            with self.lock:
                self.states[(comic_id, digest)] = "running"
            comic = self.store.get_comic(comic_id)
            cached = self.content.cached(comic_id).get(comic_id)
            value = {"id": comic_id, "title": comic["title"], "description": comic.get("description", "")}
            if cached and cached["source"]["title"] == comic["title"]:
                source = cached["source"]
                value.update(description=value["description"] or source["description"],
                             comments=[{"id": c["id"], "content": c["text"]} for c in source["comments"]],
                             comments_status=source["comments_status"], comments_total=source["platform_total"])
            if self.source_loader:
                value.update(self.source_loader(comic_id))
            result = self.content.prepare(value, guard=valid)
            if result["status"] not in {"ready", "cached", "stale"}:
                raise ValueError("analysis failed")
        except Exception:
            with self.lock:
                self.states[(comic_id, digest)] = "error"

    def stop(self):
        with self.lock:
            self.stopping = True
            if self.worker and self.worker.is_alive():
                self.queue.put(None)
