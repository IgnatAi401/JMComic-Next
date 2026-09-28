"""Durable, idempotent recommendation handoff; no browser-owned LLM calls."""
import json
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

from content_evidence import ContentEvidence, normalize_source

TERMINAL = {"success", "failed", "cancelled", "interrupted"}


class RecommendationJobs:
    def __init__(self, store):
        self.store = store
        self.path = store.data_dir / "recommendation_jobs.sqlite3"
        self.lock = threading.RLock()
        self.workers = set()
        self.initialized = False

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path)
        try:
            with db:
                db.execute("PRAGMA synchronous=FULL")
                yield db
        finally:
            db.close()

    def initialize(self):
        if self.initialized:
            return
        with self.connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
            for key, raw in db.execute("SELECT id, data FROM jobs").fetchall():
                job = json.loads(raw)
                if job["status"] in {"planning", "running", "cancelling"}:
                    job.update(status="interrupted", error="服务已重启，任务中断；候选和内容证据保留。若中断发生在排序阶段，请先检查推荐历史。", updated_at=time.time())
                    db.execute("UPDATE jobs SET data=? WHERE id=?", (json.dumps(job), key))
            db.commit()
        self.initialized = True
        with self.connection() as db:
            waiting = [json.loads(row[0]) for row in db.execute("SELECT data FROM jobs")]
        for job in waiting:
            if job["status"] == "awaiting_comments" and len(job["sources"]) == len(job["plan"]):
                self.launch(job["id"], self.execute)

    def read(self, key):
        with self.connection() as db:
            row = db.execute("SELECT data FROM jobs WHERE id=?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def save(self, job):
        job["updated_at"] = time.time()
        with self.connection() as db:
            db.execute("INSERT OR REPLACE INTO jobs VALUES (?, ?)", (job["id"], json.dumps(job, ensure_ascii=False)))
            db.commit()  # Only committed data may be acknowledged to the browser.

    def public(self, job):
        if not job:
            return None
        return {k: v for k, v in job.items() if k not in {"payload", "sources"}} | {
            "received_ids": list(job["sources"]), "accepted": True,
        }

    def get(self, key=None):
        with self.lock:
            self.initialize()
            if key:
                return self.public(self.read(key))
            with self.connection() as db:
                jobs = [json.loads(r[0]) for r in db.execute("SELECT data FROM jobs")]
            jobs.sort(key=lambda j: j["created_at"], reverse=True)
            active = [j for j in jobs if j["status"] not in TERMINAL]
            return {"jobs": [self.public(j) for j in active + [j for j in jobs if j["status"] in TERMINAL][:10]]}

    def launch(self, key, operation):
        if key in self.workers:
            return
        self.workers.add(key)
        def run():
            try:
                operation(key)
            except Exception:
                with self.lock:
                    job = self.read(key)
                    job.update(status="failed", error="后台任务失败；候选已保留，请检查服务日志或重新生成。")
                    self.save(job)
            finally:
                with self.lock:
                    self.workers.discard(key)
                    job = self.read(key)
                    if job["status"] == "awaiting_comments" and len(job["sources"]) == len(job["plan"]):
                        self.launch(key, self.execute)
        threading.Thread(target=run, daemon=True, name=f"recommendation-{key}").start()

    def submit(self, value):
        key = value.get("id", "")
        payload = value.get("payload")
        if not isinstance(key, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{16,80}", key):
            raise ValueError("任务编号无效")
        if not isinstance(payload, dict):
            raise ValueError("推荐参数无效")
        candidates = payload.get("candidates")
        if not isinstance(candidates, list) or not 1 <= len(candidates) <= 300:
            raise ValueError("候选数量无效")
        if any(not isinstance(item, dict) or not str(item.get("id", "")).isdigit() for item in candidates):
            raise ValueError("候选编号无效")
        budget = payload.get("budget", 0)
        if not isinstance(budget, int) or not 0 <= budget <= 500:
            raise ValueError("分析额度无效")
        with self.lock:
            self.initialize()
            job = self.read(key)
            if job:
                if job["payload"] != payload:
                    raise ValueError("任务编号已被其他数据使用")
                return self.public(job)
            job = dict(id=key, payload=payload, sources={}, plan=[], status="planning",
                       created_at=time.time(), finished=0, prepared=0, failed=0, remaining=0)
            self.save(job)
            self.launch(key, self.plan)
            return self.public(job)

    def plan(self, key):
        with self.lock:
            job = self.read(key)
        plan = ContentEvidence(self.store).plan(job["payload"]["candidates"])
        pending, seen = [], set()
        if plan["configured"]:
            for i in range(max(len(plan["training"]), len(plan["candidates"]))):
                for group in (plan["training"], plan["candidates"]):
                    if i < len(group) and str(group[i]["id"]) not in seen:
                        item = dict(group[i], id=str(group[i]["id"]))
                        pending.append(item)
                        seen.add(item["id"])
        with self.lock:
            job = self.read(key)
            if job["status"] in TERMINAL:
                return
            job.update(plan=pending[:job["payload"]["budget"]], remaining=len(pending), status="awaiting_comments")
            self.save(job)
        if not job["plan"]:
            self.execute(key)

    def upload(self, key, value):
        with self.lock:
            self.initialize()
            job = self.read(key)
            if not job:
                raise ValueError("任务不存在")
            comic_id = str(value.get("id", ""))
            item = next((i for i in job["plan"] if i["id"] == comic_id), None)
            if not item:
                raise ValueError("内容不属于该任务")
            if job["status"] in TERMINAL or job["status"] == "cancelling":
                return self.public(job)
            if comic_id not in job["sources"]:
                if job["status"] != "awaiting_comments":
                    raise ValueError("任务已不再接收评论")
                # Store bounded, plain-text comments; never accept browser-supplied training metadata.
                source = normalize_source(value)
                job["sources"][comic_id] = dict(item, comments=[{"id": c["id"], "content": c["text"]} for c in source["comments"]],
                    comments_status=source["comments_status"], comments_total=source["platform_total"])
                self.save(job)
            if job["status"] == "awaiting_comments" and len(job["sources"]) == len(job["plan"]):
                self.launch(key, self.execute)
            return self.public(job)

    def cancel(self, key):
        with self.lock:
            self.initialize()
            job = self.read(key)
            if not job:
                raise ValueError("任务不存在")
            if job["status"] not in TERMINAL:
                job["status"] = "cancelling" if job["status"] in {"running", "cancelling"} else "cancelled"
                self.save(job)
            return self.public(job)

    def execute(self, key):
        with self.lock:
            job = self.read(key)
            if job["status"] != "awaiting_comments":
                return
            job.update(status="running", stage="analyzing")
            self.save(job)
            sources = list(job["sources"].values())
        def prepare(source):
            with self.lock:
                if self.read(key)["status"] != "running":
                    return
            try:
                ok = ContentEvidence(self.store).prepare(source).get("status") in {"ready", "cached"}
            except Exception:
                ok = False
            with self.lock:
                current = self.read(key)
                current["finished"] += 1
                current["prepared" if ok else "failed"] += 1
                current["remaining"] = max(0, current["remaining"] - 1)
                self.save(current)
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(prepare, sources))
        with self.lock:
            job = self.read(key)
            if job["status"] != "running":
                if job["status"] == "cancelling":
                    job["status"] = "cancelled"
                    self.save(job)
                return
            job["stage"] = "ranking"
            self.save(job)
        result = self.store.generate_recommendations(job["payload"])
        with self.lock:
            job = self.read(key)
            # Ranking may have committed a history entry before cancellation arrived.
            job.update(status="success", stage="done", result=result)
            self.save(job)
