"""Source contracts for the V2 entry graph and privacy-sensitive frontend behavior.
Visual layout and user flows are checked in tests/ui_fixture.js using WebKit.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT_DIR = ROOT / "project"
SOURCE_DIR = PROJECT_DIR / "src"
PAGES = {"index", "latest", "categories", "search", "chapter", "reader", "library", "messages", "setting", "history-migration"}

def source(path):
    return (SOURCE_DIR / path).read_text(encoding="utf-8")

class FrontendStabilityTests(unittest.TestCase):
    def test_all_product_routes_have_resolvable_entries_styles_and_safe_areas(self):
        self.assertEqual({p.stem for p in PROJECT_DIR.glob("*.html")}, PAGES)
        for name in PAGES:
            with self.subTest(page=name):
                html = (PROJECT_DIR / f"{name}.html").read_text()
                self.assertIn("viewport-fit=cover", html)
                self.assertIn('content="#0c0c0e"', html)
                entries = re.findall(r'<script type="module" src="([^"]+)"', html)
                self.assertEqual(len(entries), 1)
                paths = entries + re.findall(r'<link rel="stylesheet" href="([^"]+)"', html)
                self.assertGreater(len(paths), 1)
                for path in paths:
                    self.assertTrue((PROJECT_DIR / path.split("?")[0]).is_file(), path)

    def test_relative_module_imports_are_unversioned_and_exist(self):
        for file in SOURCE_DIR.rglob("*.js"):
            for specifier in re.findall(r"\bfrom\s+['\"]([^'\"]+)['\"]", file.read_text()):
                if not specifier.startswith("."): continue
                self.assertNotIn("?", specifier)
                self.assertTrue((file.parent / specifier).is_file(), f"{file}: {specifier}")

    def test_safari_sizing_and_accessibility_preferences_are_available(self):
        css = (PROJECT_DIR / "style/app.css").read_text()
        for token in ["safe-area-inset-top", "safe-area-inset-right", "safe-area-inset-bottom", "safe-area-inset-left", "100dvh", "@supports not", "prefers-reduced-motion", "prefers-reduced-transparency", "focus-visible", "font-size: 16px"]:
            self.assertIn(token, css)
        self.assertIn("visualViewport", source("ui/overlay.js"))
        self.assertIn("aria-modal", source("ui/overlay.js"))
        self.assertNotIn("background-attachment: fixed", css)

    def test_reader_keeps_image_lifecycle_separate_from_navigation(self):
        reader = source("pages/reader.js")
        loader = source("reader/EagerComicImageLoader.js")
        self.assertNotIn("recordInteraction", reader)
        for value in ["pagehide", "pageshow", "isIOSWebKit", "memoryBudget", "cancelDecode", "renderError"]: self.assertIn(value, loader)
        self.assertNotIn("backdrop-filter", (PROJECT_DIR / "style/reader.css").read_text())

    def test_navigation_preserves_comic_tabs_and_same_tab_reader_flow(self):
        policy = source("utils/NavigationPolicy.js")
        self.assertIn('anchor.target = "_blank"', policy)
        self.assertIn('rel.add("noopener")', policy)
        self.assertIn('data-navigation-scope="same-tab"', policy)
        self.assertIn('data-navigation="same-tab"', source("pages/chapter.js"))
        self.assertIn("installNavigationPolicy();", source("core/Setting.js"))

    def test_translation_cache_is_scoped_to_provider(self):
        page = source("pages/chapter.js")
        for token in ["translationCacheKey", "ai:${", '\"google\"', "localRuntime.translateTitle(", "translateTitleToSimplifiedChinese"]: self.assertIn(token, page)

    def test_recommendation_features_are_fully_removed(self):
        frontend = "\n".join(path.read_text(encoding="utf-8") for path in SOURCE_DIR.rglob("*.js"))
        backend = "\n".join(path.read_text(encoding="utf-8") for path in ROOT.glob("*.py") if not path.name.startswith("test_"))
        for retired in [r"recommend", r"interest_feedback", r"recordinteraction", r"content-analysis", r"embedding", r"tag_feedback", r"\breview\b"]:
            self.assertNotRegex(frontend.lower(), retired)
            self.assertNotRegex(backend.lower(), retired)
        for retired in ["qwen_embeddings.py", "recommender.py", "content_evidence.py", "content_analysis.py", "recommendation_jobs.py", "local_features.py"]:
            self.assertFalse((ROOT / retired).exists(), retired)

    def test_one_total_rating_retains_rules_and_saves_only_the_score(self):
        rating = source("ui/rating.js")
        for rule in ["垃圾作品，看了浪费时间", "有严重雷点", "中规中矩", "整体及格且有亮点", "全方面优秀"]: self.assertIn(rule, rating)
        self.assertIn("saveRating({ ...comicPayload(", rating)
        self.assertNotIn("textarea", rating)
        for page in ["chapter", "reader"]: self.assertIn("RatingEditor", source(f"pages/{page}.js"))

    def test_preferences_are_edited_on_settings_and_colour_home_and_detail(self):
        self.assertIn("PreferenceEditor", source("pages/setting.js"))
        self.assertNotIn("savePreference", source("pages/chapter.js") + source("pages/index.js"))
        for page in ["pages/index.js", "pages/chapter.js", "ui/rich-cards.js"]:
            self.assertIn("preferenceAuthorsHtml", source(page), page)
            self.assertIn("preferenceTagsHtml", source(page), page)
        css = (PROJECT_DIR / "style/app.css").read_text()
        for level in ["like", "fond", "avoid", "dislike"]: self.assertIn(f'[data-preference="{level}"]', css)

    def test_migration_utility_does_not_bootstrap_remote_accounts(self):
        page = source("pages/history-migration.js")
        for unwanted in ["mountShell", "jmApi", "authSession"]: self.assertNotIn(unwanted, page)
        self.assertIn("libraryStore.init", page)

    def test_checkin_fetches_current_daily_id_without_using_cache(self):
        frontend = "\n".join(
            path.read_text(encoding="utf-8")
            for path in SOURCE_DIR.rglob("*.js")
        )
        server = (ROOT / "local_server.py").read_text(encoding="utf-8")

        for forbidden in (
            'readCache("checkin"',
            "readCache('checkin'",
            'writeCache("checkin"',
            "writeCache('checkin'",
        ):
            self.assertNotIn(forbidden, frontend)

        self.assertIn("getDailyCheckInStatus", frontend)
        self.assertRegex(frontend, r"`/daily\?\$\{query\}`")
        self.assertIn('"/daily_chk"', frontend)
        self.assertIn("daily_id: daily.dailyId", frontend)
        self.assertRegex(server, r"['\"]/daily['\"]\s*:")
        self.assertNotRegex(server, r"['\"]checkin['\"]")

    def test_checkin_requires_an_explicit_success_response(self):
        api = (SOURCE_DIR / "api" / "JmcomicApi.js").read_text(encoding="utf-8")
        self.assertIn("签到响应异常，未确认成功", api)
        self.assertIn("DAILY_REWARD_PATTERN", api)
        self.assertIn("没有收到签到参数", api)


if __name__ == "__main__":
    unittest.main()
