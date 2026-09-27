"""Source contracts for the V2 entry graph and privacy-sensitive frontend behavior.
Visual layout and user flows are checked in tests/ui_fixture.js using WebKit.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT_DIR = ROOT / "project"
SOURCE_DIR = PROJECT_DIR / "src"
PAGES = {"index", "latest", "categories", "search", "chapter", "reader", "library", "ai", "messages", "setting", "history-migration"}

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
        for event in ["read_start", "read_progress", "read_complete"]: self.assertIn(event, reader)
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
        for token in ["translationCacheKey", "ai:${", '\"google\"', "translateTitleWithAi", "translateTitleToSimplifiedChinese"]: self.assertIn(token, page)

    def test_interest_feedback_is_dimension_scoped_and_detail_only(self):
        feedback = source("ui/interest.js")
        for key in ["overall", "cover", "title", "tag_mix", "author"]: self.assertIn(key + ":", feedback)
        self.assertIn(' ? "clear" : action', feedback)
        self.assertIn("interest_feedback", feedback)
        self.assertIn("saveRecommendationFeedback", feedback)
        self.assertIn("InterestFeedback", source("pages/chapter.js"))
        self.assertNotIn("InterestFeedback", source("pages/reader.js"))
        self.assertNotIn("saveRecommendationFeedback", source("pages/ai.js"))

    def test_one_total_rating_retains_rules_and_explicit_tag_feedback(self):
        rating = source("ui/rating.js")
        for rule in ["垃圾作品，看了浪费时间", "有严重雷点", "中规中矩", "整体及格且有亮点", "全方面优秀"]: self.assertIn(rule, rating)
        self.assertIn("[0, 1, -1, -2]", rating)
        for page in ["chapter", "reader"]: self.assertIn("RatingEditor", source(f"pages/{page}.js"))
        self.assertNotIn("aspect_scores", rating)

    def test_recommendation_impressions_require_visibility_and_keep_explanations(self):
        ai = source("pages/ai.js")
        self.assertIn("entry.intersectionRatio < 0.45", ai)
        self.assertIn("评分依据", ai)
        self.assertIn("score_breakdown", ai)
        self.assertIn("getDiscoveryExcludedIds", ai)

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
        self.assertIn('const message = String(result?.msg ?? result?.message ?? (typeof result === "string" ? result : "")).trim()', api)
        self.assertIn("签到响应异常，未确认成功", api)
        self.assertIn("获得 $1 经验", api)


if __name__ == "__main__":
    unittest.main()
