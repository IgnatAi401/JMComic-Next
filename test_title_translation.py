import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from title_translation import TitleTranslator, TranslationError


class _Response:
    def __init__(self, value):
        self.payload = json.dumps(value).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return self.payload


class TitleTranslatorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "translation.json"
        self.translator = TitleTranslator(self.path)

    def configure(self, base_url="https://api.example.com/v1", enabled=True):
        return self.translator.save_config({
            "api_key": "sk-test-secret-key", "base_url": base_url, "model": "demo", "use_ai_translation": enabled,
        })

    def test_saved_key_is_masked_and_kept_when_omitted(self):
        config = self.configure()
        self.assertNotIn("api_key", config)
        self.assertEqual(config["api_key_masked"], "sk-…-key")
        self.translator.save_config({"base_url": "https://api.example.com/v2", "model": "next"})
        self.assertEqual(self.translator.read_config(include_key=True)["api_key"], "sk-test-secret-key")
        self.assertTrue(self.translator.read_config()["use_ai_translation"])
        self.assertFalse(self.translator.clear_config()["configured"])
        self.assertFalse(self.path.exists())

    def test_invalid_config_is_rejected(self):
        self.path.write_text("[]", encoding="utf-8")
        with self.assertRaisesRegex(TranslationError, "格式无效"):
            self.translator.read_config()
        self.path.unlink()
        for base_url, message in (
            ("https://example.com:bad/v1", "Base URL"),
            ("ftp://example.com/v1", "Base URL"),
            ("http://example.com/v1", "HTTPS"),
        ):
            with self.subTest(base_url=base_url), self.assertRaisesRegex(TranslationError, message):
                self.configure(base_url)
        self.assertEqual(self.configure("http://127.0.0.1:11434/v1")["base_url"], "http://127.0.0.1:11434/v1")

    def test_translation_requires_the_switch_and_strips_wrappers(self):
        self.configure(enabled=False)
        with self.assertRaisesRegex(TranslationError, "尚未开启"):
            self.translator.translate("Title")
        self.configure(base_url="https://api.deepseek.com/v1")
        reply = {"choices": [{"message": {"content": "<think>x</think>```text\n译名\n```"}}]}
        with patch("title_translation.urlopen", return_value=_Response(reply)) as remote:
            self.assertEqual(self.translator.translate("Title"), {"translation": "译名", "model": "demo"})
        request = remote.call_args.args[0]
        self.assertEqual(request.full_url, "https://api.deepseek.com/v1/chat/completions")
        self.assertEqual(json.loads(request.data)["thinking"], {"type": "disabled"})

    def test_empty_model_reply_is_an_error(self):
        self.configure()
        with patch("title_translation.urlopen", return_value=_Response({"choices": [{"message": {"content": ""}}]})), \
                self.assertRaisesRegex(TranslationError, "没有返回正文"):
            self.translator.test()


    def test_organize_groups_known_ids_and_keeps_skipped_comics(self):
        self.configure(enabled=False)
        reply = {"choices": [{"message": {"content": "```json\n" + json.dumps({"groups": [
            {"title": "某系列", "items": [{"id": "2", "note": "后篇"}, {"id": "1", "note": "前篇"}, {"id": "999", "note": "编造"}]},
            {"title": "重复", "items": [{"id": "1", "note": "重复"}]},
        ]}, ensure_ascii=False) + "\n```"}}]}
        with patch("title_translation.urlopen", return_value=_Response(reply)) as remote:
            result = self.translator.organize([
                {"id": "1", "title": "A 前篇", "author": "X"}, {"id": "2", "title": "A 后篇"}, {"id": "3", "title": "B"}, {"id": "", "title": "C"},
            ], query="X")
        self.assertTrue(json.loads(remote.call_args.args[0].data)["messages"][1]["content"].startswith("搜索关键词：X\n1\tA 前篇\t作者:X"))
        self.assertEqual(result["groups"], [
            {"title": "某系列", "items": [{"id": "2", "note": "后篇"}, {"id": "1", "note": "前篇"}]},
            {"title": "其他", "items": [{"id": "3", "note": ""}]},
        ])
        with patch("title_translation.urlopen", return_value=_Response({"choices": [{"message": {"content": "无法整理"}}]})), \
                self.assertRaisesRegex(TranslationError, "有效的整理结果"):
            self.translator.organize([{"id": "1", "title": "A"}])
        with self.assertRaisesRegex(TranslationError, "没有可整理"):
            self.translator.organize([])


if __name__ == "__main__":
    unittest.main()
