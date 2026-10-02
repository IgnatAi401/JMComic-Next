#!/usr/bin/env python3
"""Optional title translation through an OpenAI-compatible chat completions API."""

from __future__ import annotations

import json
import re
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from local_library import atomic_json_write

MAX_RESPONSE_BYTES = 8 * 1024 * 1024
LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
SYSTEM_PROMPT = (
    "你是标题翻译器。把输入的漫画标题翻译成简体中文，保留作者名、社团名、作品名、编号、"
    "括号和版本信息；已有中文不要重复翻译。只输出翻译后的完整标题本身。"
    "不要输出JSON、解释、说明、前缀、引号、Markdown或代码块，也不要复述原始标题。"
)
MAX_ORGANIZE_ITEMS = 300
ORGANIZE_PROMPT = (
    "你是漫画搜索结果整理助手。输入第一行可能给出用户的搜索关键词，之后每行一部漫画：ID、标题，可能附带作者，用制表符分隔。"
    "整理的目的是把搜索结果拆分成更细的栏目，方便浏览，因此必须按系列拆分，而不是按作者归总："
    "同一原作/同一系列/同一作品的不同话数、前后篇、续作、总集篇或汉化版本归入同一栏目。"
    "搜索结果通常大多来自同一作者或社团（尤其是关键词就是作者名时），作者相同不能作为归为一栏的理由；"
    "禁止使用“某某作品集”“某某合集”“全部作品”这类按作者概括所有作品的栏目。"
    "不属于任何系列的单篇，按题材、原作（同人作品的原作）、角色或类型（如短篇、单行本收录、彩色版、CG集）合并为合理栏目，"
    "避免出现大量只有一本的栏目；除非结果总数很少，栏目数一般不应少于3个。"
    "栏目标题和备注必须全部用简体中文书写，不得直接照抄日文、英文、韩文或繁体原文。"
    "栏目标题简短说明系列或主题（例如原作名或作者名）：原作名、角色名有通行中文译名时使用译名，没有时意译成中文；"
    "作者或社团名为日文假名或英文时，写常见中文译名或音译，必要时可在中文后用括号附原名。"
    "每本的备注不超过30字，说明它在该栏目中的定位，例如第几话、前后篇、续作、总集篇、汉化组或版本差异。"
    "栏目内按阅读顺序排列。每个ID必须且只能出现一次，不要编造ID。"
    '只输出JSON对象，格式为 {"groups":[{"title":"栏目标题","items":[{"id":"ID","note":"备注"}]}]}，不要输出其他文字。'
)


class TranslationError(RuntimeError):
    pass


def _text(value: object, maximum: int) -> str:
    return str(value or "").strip()[:maximum]


class TitleTranslator:
    def __init__(self, config_path: Path) -> None:
        self.config_path = config_path

    def read_config(self, include_key: bool = False) -> dict:
        try:
            value = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            value = {}
        if not isinstance(value, dict):
            raise TranslationError("翻译配置格式无效")
        api_key = _text(value.get("api_key"), 2000)
        result = {
            "base_url": _text(value.get("base_url"), 1000),
            "model": _text(value.get("model"), 200),
            "use_ai_translation": bool(value.get("use_ai_translation")),
            "configured": bool(api_key and value.get("base_url") and value.get("model")),
        }
        if include_key:
            result["api_key"] = api_key
        elif api_key:
            result["api_key_masked"] = f"{api_key[:3]}…{api_key[-4:]}" if len(api_key) > 8 else "已保存"
        return result

    def save_config(self, value: object) -> dict:
        data = value if isinstance(value, dict) else {}
        current = self.read_config(include_key=True)
        base_url = _text(data.get("base_url"), 1000).rstrip("/")
        model = _text(data.get("model"), 200)
        api_key = _text(data.get("api_key"), 2000) or current["api_key"]
        try:
            parsed = urlparse(base_url)
            parsed.port
        except ValueError as error:
            raise TranslationError("Base URL 必须是有效的 HTTP 或 HTTPS 地址") from error
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise TranslationError("Base URL 必须是有效的 HTTP 或 HTTPS 地址")
        if not model or not api_key:
            raise TranslationError("API Key、Base URL 和模型名称不能为空")
        if parsed.scheme == "http" and parsed.hostname not in LOCAL_HOSTS:
            raise TranslationError("远程接口必须使用 HTTPS；HTTP 仅允许本机地址")
        atomic_json_write(self.config_path, {
            "api_key": api_key,
            "base_url": base_url,
            "model": model,
            "use_ai_translation": bool(data.get("use_ai_translation", current["use_ai_translation"])),
        }, private=True)
        return self.read_config()

    def clear_config(self) -> dict:
        try:
            self.config_path.unlink(missing_ok=True)
        except OSError as error:
            raise TranslationError("翻译配置清除失败") from error
        return self.read_config()

    def _complete(self, messages: list[dict], max_tokens: int, timeout: int = 120) -> str:
        config = self.read_config(include_key=True)
        if not config["configured"]:
            raise TranslationError("请先配置翻译模型")
        request_data = {"model": config["model"], "messages": messages, "temperature": 0.25, "max_tokens": max_tokens}
        hostname = (urlparse(config["base_url"]).hostname or "").lower()
        if hostname == "deepseek.com" or hostname.endswith(".deepseek.com"):
            # DeepSeek defaults to thinking mode, which can spend the whole output
            # budget on reasoning and leave message.content empty.
            request_data["thinking"] = {"type": "disabled"}
        base_url = config["base_url"].rstrip("/")
        request = Request(
            base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions",
            data=json.dumps(request_data, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {config['api_key']}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "JMComic-WebUI-Local/1.0",
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise TranslationError("模型接口响应过大")
            envelope = json.loads(raw.decode("utf-8"))
        except HTTPError as error:
            detail = error.read(4096).decode("utf-8", errors="replace")
            try:
                detail = json.loads(detail).get("error", {}).get("message", detail)
            except (ValueError, AttributeError):
                pass
            raise TranslationError(f"模型接口返回 HTTP {error.code}: {_text(detail, 500)}") from error
        except (URLError, OSError) as error:
            raise TranslationError(f"模型接口连接失败: {_text(error, 300)}") from error
        except (ValueError, UnicodeDecodeError) as error:
            raise TranslationError("模型接口返回了无效 JSON") from error
        try:
            content = envelope["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as error:
            raise TranslationError("模型响应中缺少 choices[0].message.content") from error
        if isinstance(content, list):
            content = "".join(str(item.get("text") or "") for item in content if isinstance(item, dict))
        content = re.sub(r"^\s*<think>.*?</think>\s*", "", str(content or ""), flags=re.DOTALL | re.IGNORECASE).strip()
        if not content:
            raise TranslationError("模型没有返回正文")
        return content

    def test(self) -> dict:
        self._complete([{"role": "user", "content": "只回复 OK"}], max_tokens=20)
        return {"ok": True, "model": self.read_config()["model"]}

    def translate(self, value: object) -> dict:
        title = _text(value, 1000)
        if not title:
            raise TranslationError("没有可翻译的标题")
        config = self.read_config()
        if not config["use_ai_translation"]:
            raise TranslationError("AI 标题翻译尚未开启")
        result = self._complete([
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": title},
        ], max_tokens=800)
        fenced = re.fullmatch(r"```(?:text)?\s*(.*?)\s*```", result, re.DOTALL | re.IGNORECASE)
        return {"translation": _text(fenced.group(1) if fenced else result, 2000), "model": config["model"]}

    def organize(self, value: object, query: object = "") -> dict:
        """Group listing comics by series; titles and per-comic notes come from the model."""
        items, seen = [], set()
        for entry in value if isinstance(value, list) else []:
            if not isinstance(entry, dict):
                continue
            comic_id = _text(entry.get("id"), 40)
            title = _text(entry.get("title"), 300)
            if not comic_id or not title or comic_id in seen:
                continue
            seen.add(comic_id)
            items.append({"id": comic_id, "title": title, "author": _text(entry.get("author"), 120)})
        if not items:
            raise TranslationError("没有可整理的作品")
        if len(items) > MAX_ORGANIZE_ITEMS:
            raise TranslationError(f"一次最多整理 {MAX_ORGANIZE_ITEMS} 部作品")
        listing = "\n".join(
            f"{item['id']}\t{item['title']}" + (f"\t作者:{item['author']}" if item["author"] else "") for item in items
        )
        keyword = _text(query, 200)
        if keyword:
            listing = f"搜索关键词：{keyword}\n{listing}"
        result = self._complete([
            {"role": "system", "content": ORGANIZE_PROMPT},
            {"role": "user", "content": listing},
        ], max_tokens=min(16000, 1000 + 80 * len(items)), timeout=240)
        fenced = re.search(r"```(?:json)?\s*(.*?)\s*```", result, re.DOTALL | re.IGNORECASE)
        text = fenced.group(1) if fenced else result
        start, end = text.find("{"), text.rfind("}")
        try:
            data = json.loads(text[start:end + 1]) if start >= 0 and end > start else None
        except ValueError:
            data = None
        if not isinstance(data, dict) or not isinstance(data.get("groups"), list):
            raise TranslationError("模型没有返回有效的整理结果")
        known = {item["id"] for item in items}
        placed: set[str] = set()
        groups = []
        for group in data["groups"]:
            if not isinstance(group, dict):
                continue
            entries = []
            for entry in group.get("items") if isinstance(group.get("items"), list) else []:
                comic_id = _text(entry.get("id") if isinstance(entry, dict) else entry, 40)
                if comic_id not in known or comic_id in placed:
                    continue
                placed.add(comic_id)
                entries.append({"id": comic_id, "note": _text(entry.get("note") if isinstance(entry, dict) else "", 200)})
            if entries:
                groups.append({"title": _text(group.get("title"), 100) or "未命名系列", "items": entries})
        # Comics the model skipped stay visible instead of silently disappearing.
        missing = [{"id": item["id"], "note": ""} for item in items if item["id"] not in placed]
        if missing:
            groups.append({"title": "其他", "items": missing})
        return {"groups": groups, "model": self.read_config()["model"]}
