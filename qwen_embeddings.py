#!/usr/bin/env python3
"""DashScope Qwen multimodal embeddings for comic recommendation.

The model runs entirely through Alibaba Cloud Model Studio.  This module keeps
only generated vectors in the existing feature store; it never downloads model
weights, creates a model environment, or writes cover images to disk.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from typing import Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from local_features import LocalFeatureError


DEFAULT_API_BASE_URL = "https://dashscope.aliyuncs.com/api/v1"
API_PATH = "/services/embeddings/multimodal-embedding/multimodal-embedding"
MODEL_ID = "qwen3-vl-embedding"
DIMENSION = 1024
PROVIDER_ID = "dashscope_multimodal_embedding"
PIPELINE_VERSION = "qwen3-vl-embedding-api-d1024-v1"
FEATURE_MODALITIES = ("cover", "title", "joint")
INSTRUCTION = "Represent this comic for personalized recommendation retrieval."
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
JM_COVER_HOSTS = frozenset({
    "cdn-msp.jmapiproxy1.cc",
    "cdn-msp.jmapiproxy2.cc",
    "cdn-msp2.jmapiproxy2.cc",
    "cdn-msp3.jmapiproxy2.cc",
    "cdn-msp.jmapinodeudzn.net",
    "cdn-msp3.jmapinodeudzn.net",
})


class QwenEmbeddingError(RuntimeError):
    pass


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _normalize_vector(value: object) -> list[float]:
    if not isinstance(value, list) or len(value) != DIMENSION:
        raise QwenEmbeddingError(f"Qwen API 未返回 {DIMENSION} 维向量")
    try:
        vector = [float(component) for component in value]
    except (TypeError, ValueError) as error:
        raise QwenEmbeddingError("Qwen API 返回了非数值向量") from error
    if any(not math.isfinite(component) for component in vector):
        raise QwenEmbeddingError("Qwen API 返回了非有限数值")
    norm = math.sqrt(sum(component * component for component in vector))
    if norm <= 0:
        raise QwenEmbeddingError("Qwen API 返回了全零向量")
    return [component / norm for component in vector]


def _validate_cover_url(comic_id: str, value: object) -> str:
    url = str(value or "").strip()
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError as error:
        raise QwenEmbeddingError("候选漫画封面地址无效") from error
    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").lower() not in JM_COVER_HOSTS
        or parsed.username
        or parsed.password
        or port not in (None, 443)
        or parsed.query
        or parsed.fragment
    ):
        raise QwenEmbeddingError("候选漫画封面地址无效")
    expected = re.compile(r"^/media/albums/{}_3x4\.jpg$".format(re.escape(comic_id)))
    if not expected.fullmatch(parsed.path):
        raise QwenEmbeddingError("候选漫画封面路径无效")
    return url


class QwenEmbeddingRuntime:
    """Cache-first Qwen API integration with a small background executor."""

    def __init__(self, feature_store) -> None:
        self.feature_store = feature_store
        self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="qwen-api")
        self._background_items: set[str] = set()
        self._inflight_candidates: dict[str, Future[str]] = {}
        self._outbound_slots = threading.BoundedSemaphore(4)
        self._lock = threading.Lock()
        self._stopped = False

    def status(self) -> dict:
        try:
            config = self.feature_store.read_embedding_config()
            config_error = ""
        except LocalFeatureError as error:
            config = {}
            config_error = str(error)[:500]
        with self._lock:
            background_running = len(self._background_items)
        return {
            "available": bool(config.get("configured")),
            "provider": PROVIDER_ID,
            "model": MODEL_ID,
            "dimension": DIMENSION,
            "api_base_url": config.get("api_base_url", DEFAULT_API_BASE_URL),
            "reason": config_error or (
                "" if config.get("configured") else "请先配置百炼 API Key"
            ),
            "api_key_masked": config.get("api_key_masked", ""),
            "feature_cache": self.feature_store.feature_cache_stats(),
            "background_running": background_running,
        }

    def _config(self) -> dict:
        config = self.feature_store.read_embedding_config(include_key=True)
        if not config.get("configured"):
            raise QwenEmbeddingError("请先在账号配置中填写百炼 API Key")
        return config

    @staticmethod
    def _api_url(config: Mapping[str, object]) -> str:
        return str(config.get("api_base_url") or DEFAULT_API_BASE_URL).rstrip("/") + API_PATH

    @staticmethod
    def _source(candidate: Mapping[str, object]) -> tuple[str, str, str, dict[str, str]]:
        comic_id = str(candidate.get("id") or candidate.get("comic_id") or "").strip()
        if not re.fullmatch(r"\d+", comic_id):
            raise QwenEmbeddingError("候选漫画 ID 无效")
        title = str(candidate.get("title") or candidate.get("name") or "").strip()
        if not title:
            raise QwenEmbeddingError("候选漫画标题为空")
        if len(title) > 500:
            title = title[:500]
        cover_url = _validate_cover_url(comic_id, candidate.get("cover_url"))
        title_hash = _sha256(title)
        cover_hash = _sha256(cover_url)
        return comic_id, title, cover_url, {
            "title": title_hash,
            "cover": cover_hash,
            "joint": _sha256(f"{title_hash}:{cover_hash}"),
        }

    @staticmethod
    def _feature_current(feature: object, content_hash: str) -> bool:
        return bool(
            isinstance(feature, dict)
            and feature.get("status") == "ready"
            and feature.get("provider") == PROVIDER_ID
            and feature.get("model") == MODEL_ID
            and feature.get("version") == PIPELINE_VERSION
            and feature.get("content_hash") == content_hash
            and feature.get("dimensions") == DIMENSION
        )

    def _call(self, contents: list[dict[str, str]], *, fusion: bool) -> list[list[float]]:
        config = self._config()
        payload = json.dumps({
            "model": MODEL_ID,
            "input": {"contents": contents},
            "parameters": {
                "dimension": DIMENSION,
                "instruct": INSTRUCTION,
                "enable_fusion": fusion,
            },
        }, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = Request(
            self._api_url(config),
            data=payload,
            headers={
                "Authorization": f"Bearer {config['api_key']}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "JMComic-WebUI/1.0",
            },
            method="POST",
        )
        try:
            with self._outbound_slots:
                with urlopen(request, timeout=120) as response:
                    raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as error:
            detail = error.read(4096).decode("utf-8", errors="replace")
            try:
                parsed_detail = json.loads(detail)
                message = (
                    parsed_detail.get("message") or detail
                    if isinstance(parsed_detail, dict) else detail
                )
            except (TypeError, ValueError):
                message = detail
            raise QwenEmbeddingError(
                f"Qwen API 返回 HTTP {error.code}: {str(message).strip()[:500]}"
            ) from error
        except (URLError, OSError, TimeoutError) as error:
            raise QwenEmbeddingError(f"Qwen API 连接失败: {str(error)[:300]}") from error
        if len(raw) > MAX_RESPONSE_BYTES:
            raise QwenEmbeddingError("Qwen API 响应过大")
        expected = 1 if fusion else len(contents)
        try:
            envelope = json.loads(raw.decode("utf-8"))
            if not isinstance(envelope, dict):
                raise QwenEmbeddingError("Qwen API 返回格式无效")
            if envelope.get("code"):
                raise QwenEmbeddingError(
                    "Qwen API 调用失败: {}".format(str(envelope.get("message") or envelope["code"])[:500])
                )
            output = envelope.get("output")
            rows = output.get("embeddings") if isinstance(output, dict) else None
            if not isinstance(rows, list):
                raise QwenEmbeddingError("Qwen API 返回格式无效")
            if len(rows) != expected:
                raise QwenEmbeddingError("Qwen API 返回的向量数量不正确")
            if any(
                not isinstance(item, dict) or type(item.get("index")) is not int
                for item in rows
            ):
                raise QwenEmbeddingError("Qwen API 返回的向量索引无效")
            rows = sorted(rows, key=lambda item: item["index"])
            if [item["index"] for item in rows] != list(range(expected)):
                raise QwenEmbeddingError("Qwen API 返回的向量索引无效")
            vectors = [_normalize_vector(item["embedding"]) for item in rows]
        except QwenEmbeddingError:
            raise
        except (AttributeError, KeyError, TypeError, ValueError, UnicodeDecodeError) as error:
            raise QwenEmbeddingError("Qwen API 返回格式无效") from error
        return vectors

    def test_connection(self) -> dict:
        vector = self._call([{"text": "连接测试"}], fusion=False)[0]
        return {"ok": True, "model": MODEL_ID, "dimension": len(vector)}

    @staticmethod
    def _singleflight_key(
        candidate: Mapping[str, object],
        comic_id: str,
        hashes: Mapping[str, str],
    ) -> str | None:
        try:
            serialized = json.dumps(
                dict(candidate),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
        except (TypeError, ValueError):
            return None
        return _sha256(
            f"{comic_id}:{hashes['title']}:{hashes['cover']}:{hashes['joint']}:{serialized}"
        )

    def _prepare_candidate(
        self,
        candidate: Mapping[str, object],
        source: tuple[str, str, str, dict[str, str]],
    ) -> str:
        comic_id, title, cover_url, hashes = source
        self.feature_store.upsert_comic({**dict(candidate), "id": comic_id, "cover_url": cover_url})
        cached = self.feature_store.get_item_features(comic_id)
        missing = [
            modality for modality in FEATURE_MODALITIES
            if not self._feature_current(cached.get(modality), hashes[modality])
        ]
        if not missing:
            return comic_id

        features: dict[str, dict] = {}
        if "cover" in missing or "title" in missing:
            title_vector, cover_vector = self._call(
                [{"text": title}, {"image": cover_url}], fusion=False
            )
            if "title" in missing:
                features["title"] = {"vector": title_vector}
            if "cover" in missing:
                features["cover"] = {"vector": cover_vector}
        if "joint" in missing:
            joint_vector = self._call(
                [{"text": title}, {"image": cover_url}], fusion=True
            )[0]
            features["joint"] = {"vector": joint_vector}
        for modality, feature in features.items():
            feature.update({
                "status": "ready",
                "provider": PROVIDER_ID,
                "model": MODEL_ID,
                "version": PIPELINE_VERSION,
                "content_hash": hashes[modality],
                "source_uri": cover_url if modality != "title" else "",
            })
        self.feature_store.save_item_features({
            "comic_id": comic_id,
            "comic": dict(candidate),
            "features": features,
        })
        return comic_id

    def prepare_candidate(self, candidate: Mapping[str, object]) -> str:
        source = self._source(candidate)
        comic_id, _title, _cover_url, hashes = source
        key = self._singleflight_key(candidate, comic_id, hashes)
        if key is None:
            return self._prepare_candidate(candidate, source)

        with self._lock:
            future = self._inflight_candidates.get(key)
            if future is None:
                future = Future()
                self._inflight_candidates[key] = future
                leader = True
            else:
                leader = False
        if not leader:
            return future.result()

        try:
            result = self._prepare_candidate(candidate, source)
        except BaseException as error:
            future.set_exception(error)
            raise
        else:
            future.set_result(result)
            return result
        finally:
            with self._lock:
                if self._inflight_candidates.get(key) is future:
                    del self._inflight_candidates[key]

    def prepare_candidates(self, values: object) -> dict:
        candidates = [item for item in values if isinstance(item, Mapping)] if isinstance(values, list) else []
        if not candidates:
            raise QwenEmbeddingError("没有可生成 Qwen 向量的候选漫画")
        self._config()
        ready: set[str] = set()
        failures: dict[str, str] = {}
        with ThreadPoolExecutor(max_workers=min(4, len(candidates))) as executor:
            futures = {executor.submit(self.prepare_candidate, item): item for item in candidates}
            for future in as_completed(futures):
                item = futures[future]
                comic_id = str(item.get("id") or item.get("comic_id") or "")
                try:
                    ready.add(future.result())
                except Exception as error:
                    failures[comic_id] = str(error)[:1000]
        ready_ids = [
            str(item.get("id") or item.get("comic_id") or "")
            for item in candidates
            if str(item.get("id") or item.get("comic_id") or "") in ready
        ]
        if not ready_ids:
            detail = next(iter(failures.values()), "没有候选完成向量生成")
            raise QwenEmbeddingError(f"Qwen 特征准备失败：{detail}")
        return {
            "model": MODEL_ID,
            "dimension": DIMENSION,
            "ready_ids": ready_ids,
            "ready": len(ready_ids),
            "failed": len(failures),
            "failures": failures,
            "total": len(candidates),
        }

    def enqueue_background(self, value: object) -> None:
        candidate = value if isinstance(value, Mapping) else {}
        comic_id = str(candidate.get("id") or candidate.get("comic_id") or "").strip()
        if not comic_id or not candidate.get("cover_url") or not (candidate.get("title") or candidate.get("name")):
            return
        try:
            configured = self.feature_store.read_embedding_config().get("configured")
        except LocalFeatureError:
            return
        if not configured:
            return

        def discard_background_item(_future=None) -> None:
            with self._lock:
                self._background_items.discard(comic_id)

        def run() -> None:
            try:
                self.prepare_candidate(candidate)
            except Exception:
                pass

        with self._lock:
            if self._stopped or comic_id in self._background_items:
                return
            self._background_items.add(comic_id)
            try:
                future = self._executor.submit(run)
            except RuntimeError:
                self._background_items.discard(comic_id)
                return
        # Only the Future callback owns cleanup, including cancellation. A
        # second cleanup in run() could remove a newer task's marker after
        # another enqueue slips between the callable return and this callback.
        future.add_done_callback(discard_background_item)

    def stop(self) -> None:
        with self._lock:
            if self._stopped:
                return
            self._stopped = True
        self._executor.shutdown(wait=False, cancel_futures=True)


__all__ = [
    "API_PATH",
    "DEFAULT_API_BASE_URL",
    "DIMENSION",
    "FEATURE_MODALITIES",
    "MODEL_ID",
    "PIPELINE_VERSION",
    "PROVIDER_ID",
    "QwenEmbeddingError",
    "QwenEmbeddingRuntime",
]
