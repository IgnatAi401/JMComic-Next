import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SOURCE_DIR = ROOT / "project" / "src"
PROJECT_DIR = ROOT / "project"
IMPORT_PATTERN = re.compile(r"\bfrom\s+['\"]([^'\"]+)['\"]")


class FrontendStabilityTests(unittest.TestCase):
    def test_every_page_loads_the_jmcomic_next_theme_last_and_supports_safe_areas(self):
        failures = []
        for page in PROJECT_DIR.glob("*.html"):
            text = page.read_text(encoding="utf-8")
            stylesheets = re.findall(r'<link[^>]+rel=["\']stylesheet["\'][^>]+href=["\']([^"\']+)', text)
            if not stylesheets or "style/jmcomic-next.css" not in stylesheets[-1]:
                failures.append(f"{page.name}: JMComic Next theme is not the final stylesheet")
            if "viewport-fit=cover" not in text:
                failures.append(f"{page.name}: viewport-fit=cover is missing")
        self.assertEqual(failures, [])

    def test_jmcomic_next_theme_contains_safari_fallbacks(self):
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")
        for required in (
            "-webkit-backdrop-filter",
            "@supports not",
            "env(safe-area-inset-top)",
            "env(safe-area-inset-right)",
            "env(safe-area-inset-bottom)",
            "100dvh",
            "-webkit-text-size-adjust: 100%",
            "font-size: 16px !important",
            "prefers-reduced-motion",
            "prefers-reduced-transparency",
        ):
            self.assertIn(required, theme)
        self.assertNotIn("background-attachment: fixed", theme)

    def test_simulated_glass_and_primary_buttons_have_opaque_paint_fallbacks(self):
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")

        depth_pass = theme[theme.index("/* Content surfaces use simulated glass"):]
        surface_rule = re.search(
            r"\.glass-card,.*?\.message-panel\s*\{(?P<body>.*?)\n\}",
            depth_pass,
            re.S,
        )
        self.assertIsNotNone(surface_rule)
        self.assertIn("background-color: #101010", surface_rule.group("body"))
        self.assertIn("background-image: linear-gradient", surface_rule.group("body"))

        primary_rule = re.search(
            r"\.primary-btn\s*\{(?P<body>.*?)\n\}",
            depth_pass,
            re.S,
        )
        self.assertIsNotNone(primary_rule)
        self.assertIn("background-color: #c7922f", primary_rule.group("body"))
        self.assertIn("background-image: linear-gradient", primary_rule.group("body"))

    def test_account_modal_controls_keep_visible_interaction_states(self):
        basic = (PROJECT_DIR / "style" / "basic.css").read_text(encoding="utf-8")
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")
        nav = (SOURCE_DIR / "components" / "general" / "NavManager.js").read_text(encoding="utf-8")

        self.assertIn('class="modal-close" type="button" aria-label="关闭"><svg', nav)
        self.assertIn('class="ai-config-section llm-config-section"', nav)
        self.assertIn('modal.querySelector(".llm-config-section").open = true', nav)
        self.assertRegex(basic, re.compile(r"\.modal-close svg\s*\{[^}]*display:\s*block;", re.S))
        self.assertRegex(
            theme,
            re.compile(
                r'\.ai-config-form \.ai-translation-toggle input\[type="checkbox"\]\s*'
                r'\{[^}]*appearance:\s*auto;[^}]*accent-color:',
                re.S,
            ),
        )

    def test_mobile_account_button_reuses_the_primary_action_material(self):
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")
        nav = (SOURCE_DIR / "components" / "general" / "NavManager.js").read_text(encoding="utf-8")

        self.assertIn('class="mobile-account account-trigger primary-btn"', nav)
        mobile_rule = re.search(
            r"\.mobile-account\.account-trigger\s*\{(?P<body>.*?)\n\}",
            theme,
            re.S,
        )
        self.assertIsNotNone(mobile_rule)
        for visual_property in ("border:", "border-radius:", "background:", "color:", "box-shadow:"):
            self.assertNotIn(visual_property, mobile_rule.group("body"))

    def test_mobile_navigation_keeps_the_search_field_visible(self):
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")

        self.assertRegex(
            theme,
            re.compile(
                r"@media \(max-width: 800px\).*?"
                r"\.nav-inner > \.search\s*\{[^}]*"
                r"display:\s*block;[^}]*"
                r"grid-column:\s*1\s*/\s*-1;[^}]*"
                r"grid-row:\s*2;",
                re.S,
            ),
        )
        self.assertIn("grid-template-rows: 60px 52px", theme)

    def test_high_contrast_shell_uses_the_floating_page_dock(self):
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")
        nav = (SOURCE_DIR / "components" / "general" / "NavManager.js").read_text(encoding="utf-8")

        for required in (
            "--bg: #030303",
            ".app-dock-glass",
            ".app-dock-content",
            ".app-dock-item[aria-current=\"page\"]",
            "dock-search-trigger",
            "dock-messages-badge",
        ):
            self.assertIn(required, theme + nav)

        self.assertNotIn("@keyframes dock-arrive", theme)
        self.assertRegex(theme, re.compile(r"\.app-dock-content\s*\{.*?animation:\s*none;", re.S))

        for old_tint in ("#17191e", "#25282e", "#30333b"):
            self.assertNotIn(old_tint, theme)

        self.assertLess(nav.index('class="app-dock-glass"'), nav.index('class="app-dock-content"'))
        self.assertIn('this.dockDom?.querySelector(".dock-messages-badge")', nav)

    def test_dock_hover_scales_from_center_and_keeps_the_active_accent(self):
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")

        item_rule = re.search(
            r"(?ms)^\.app-dock-item\s*\{(.*?)^\}",
            theme,
        )
        self.assertIsNotNone(item_rule)
        self.assertIn("transform-origin: center", item_rule.group(1))

        hover_rule = re.search(
            r"(?ms)^[ \t]*\.app-dock-item:hover\s*\{(.*?)^[ \t]*\}",
            theme,
        )
        self.assertIsNotNone(hover_rule)
        self.assertIn("transform: scale(1.1)", hover_rule.group(1))
        self.assertNotIn("translate", hover_rule.group(1))

        active_hover_rule = re.search(
            r'(?ms)^[ \t]*\.app-dock-item\[aria-current="page"\]:hover\s*\{(.*?)^[ \t]*\}',
            theme,
        )
        self.assertIsNotNone(active_hover_rule)
        self.assertIn("background: var(--accent-strong)", active_hover_rule.group(1))
        self.assertIn("color: var(--accent-ink)", active_hover_rule.group(1))

        active_glow_rule = re.search(
            r'(?ms)^[ \t]*\.app-dock-item\[aria-current="page"\]:hover::before\s*\{(.*?)^[ \t]*\}',
            theme,
        )
        self.assertIsNotNone(active_glow_rule)
        self.assertIn("opacity: .88", active_glow_rule.group(1))

    def test_logo_uses_the_large_hard_edged_wordmark(self):
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")
        logo_rules = re.findall(r"(?ms)^\.logo\s*\{(.*?)^\}", theme)
        self.assertTrue(logo_rules)
        final_logo_rule = logo_rules[-1]
        self.assertIn("font-family: Impact", final_logo_rule)
        self.assertIn('"Arial Black"', final_logo_rule)
        self.assertIn("font-size: 30px", final_logo_rule)
        self.assertIn("font-weight: 900", final_logo_rule)
        self.assertNotIn("Rounded", final_logo_rule)

    def test_navigation_dock_exists_before_modules_and_hydrates_in_place(self):
        nav_pages = (
            "index",
            "latest",
            "categories",
            "search",
            "library",
            "messages",
            "ai",
            "setting",
            "chapter",
        )
        for name in nav_pages:
            with self.subTest(page=name):
                html = (PROJECT_DIR / f"{name}.html").read_text(encoding="utf-8")
                self.assertEqual(html.count('<aside class="app-dock"'), 1)
                self.assertIn(f'data-current="{name}"', html)
                self.assertIn("app-dock-glyph icon-home", html)
                self.assertLess(
                    html.index('<aside class="app-dock"'),
                    html.index('<script type="module"'),
                )

        nav = (SOURCE_DIR / "components" / "general" / "NavManager.js").read_text(encoding="utf-8")
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")

        self.assertIn('if (!document.querySelector(".app-dock"))', nav)
        self.assertIn("this.dockDom.dataset.current = current", nav)
        self.assertIn("@view-transition { navigation: auto; }", theme)
        self.assertNotRegex(
            nav,
            r"querySelector\(\s*['\"]\.app-dock['\"]\s*\)\??\.remove\(",
        )

        unmounted_source_rule = re.search(
            r"\.root > \.switch-server\s*\{(.*?)\n\}",
            theme,
            re.S,
        )
        self.assertIsNotNone(unmounted_source_rule)
        self.assertIn("visibility: hidden", unmounted_source_rule.group(1))
        self.assertIn("pointer-events: none", unmounted_source_rule.group(1))

    def test_reader_side_stack_preserves_hooks_and_avoids_live_blur(self):
        reader = (PROJECT_DIR / "reader.html").read_text(encoding="utf-8")
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")

        for required in (
            "reader-side-stack",
            "reader-panel-head",
            "reader-chapter-controls",
            "reader-tool-controls",
            "reader-chapter-select",
            "reader-source",
            "reader-batch-setting",
            "progress-cr",
        ):
            self.assertIn(required, reader)

        stack_rule = re.search(
            r"(?ms)^\.reader-side-stack\s*\{(.*?)^\}",
            theme,
        )
        self.assertIsNotNone(stack_rule)
        self.assertIn("position: fixed", stack_rule.group(1))
        self.assertRegex(stack_rule.group(1), r"display:\s*(?:flex|grid)")
        self.assertTrue(
            "flex-direction: column" in stack_rule.group(1)
            or re.search(r"grid-template-columns:\s*(?:minmax\(0,\s*)?1fr", stack_rule.group(1)),
            "reader-side-stack must arrange controls and progress in one column",
        )

        self.assertNotIn("reader-rail-arrive", theme)
        self.assertNotIn(".reader-panel:focus-within", theme)
        self.assertIn(".reader-control-label", theme)
        self.assertIn("--reader-rail-panel-height: clamp(410px, 46vh, 430px)", theme)
        self.assertIn("--reader-rail-panel-height: calc((100dvh - 30px) / 2)", theme)
        self.assertIn("height: var(--reader-rail-panel-height)", theme)
        self.assertIn("flex: 0 1 var(--reader-rail-panel-height)", theme)
        self.assertNotIn("flex: 0 1 clamp(166px, 34vh, 238px)", theme)
        self.assertIn("--reader-control-size: 46px", stack_rule.group(1))
        self.assertIn("--reader-stack-width: 76px", stack_rule.group(1))
        self.assertIn("width: var(--reader-control-size)", theme)
        self.assertIn("place-content: center", theme)
        self.assertIn("transform: none !important", theme)
        self.assertIn("@media (max-width: 900px) and (max-height: 600px)", theme)
        self.assertIn("flex: 0 1 112px", theme)
        self.assertIn("min-height: 250px", theme)
        self.assertIn("flex: 0 0 112px", theme)
        self.assertRegex(
            theme,
            re.compile(
                r"\.reader-side-stack \.reader-panel-head,\s*"
                r"\.reader-side-stack \.reader-controls\s*\{\s*transform:\s*none;\s*\}"
            ),
        )
        self.assertRegex(
            theme,
            re.compile(
                r"\.reader-side-stack > \.reader-panel\s*\{[^}]*"
                r"justify-content:\s*center;",
                re.S,
            ),
        )
        self.assertIn("@media (max-width: 900px)", theme)
        reader_menu_rule = re.search(
            r"\.reader-side-stack \.switch-server\.reader-source \.sh-sr-cr,\s*\n"
            r"\.reader-side-stack \.reader-batch-setting \.batch-setting-menu\s*\{(.*?)\n\}",
            theme,
            re.S,
        )
        self.assertIsNotNone(reader_menu_rule)
        self.assertIn("position: fixed", reader_menu_rule.group(1))
        self.assertIn("top: 50%", reader_menu_rule.group(1))
        self.assertIn("max-height: calc(100dvh - 24px", reader_menu_rule.group(1))
        self.assertIn("-webkit-backdrop-filter: none", reader_menu_rule.group(1))

    def test_source_picker_and_reader_chapter_hint_use_transient_triggers(self):
        basic = (PROJECT_DIR / "style" / "basic.css").read_text(encoding="utf-8")
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")

        self.assertIn(".switch-server.open .sh-sr-cr", basic)
        self.assertNotRegex(
            basic,
            r"\.switch-server[^,{]*(?::hover|:focus-within)[^{,]*\.sh-sr-cr",
        )
        self.assertNotIn(".reader-select-control:focus-within::after", theme)

    def test_home_interest_grid_cannot_overflow_horizontally(self):
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")
        self.assertIn("repeat(8, minmax(0, 1fr))", theme)
        self.assertIn("overscroll-behavior-inline: contain", theme)
        self.assertIn("-webkit-user-drag: none", theme)
        self.assertRegex(theme, re.compile(r"\.tag-section\s*\{.*?overflow:\s*clip;", re.S))

    def test_home_recommendations_wrap_and_random_hero_validates_ids(self):
        banner = (SOURCE_DIR / "components" / "index" / "BannerManager.js").read_text(encoding="utf-8")
        recommendations = (
            SOURCE_DIR / "components" / "index" / "RecommendationsManager.js"
        ).read_text(encoding="utf-8")
        home_style = (PROJECT_DIR / "style" / "index.css").read_text(encoding="utf-8")

        for required in (
            "#generateCandidateId",
            "digits === 6 ? 100000 : 1000000",
            "jmApi.getComicAlbum",
            "#isValidAlbum",
            "Promise.any",
        ):
            self.assertIn(required, banner)
        self.assertIn("getPromotionContent", recommendations)
        self.assertIn("#prioritizeCuratedSection", recommendations)
        self.assertNotIn("FORMER_HERO_IDS", recommendations)
        self.assertNotIn("bindHorizontalScrollBounds", recommendations + banner)
        self.assertIn("grid-template-columns: repeat(6, minmax(0, 1fr))", home_style)
        self.assertRegex(
            home_style,
            re.compile(r"\.home-page \.recommendations \.sec-comics\s*\{.*?overflow:\s*visible;", re.S),
        )

    def test_random_hero_dynamic_content_uses_fixed_slots(self):
        home_style = (PROJECT_DIR / "style" / "index.css").read_text(encoding="utf-8")

        fixed_slots = {
            r"\.random-comic-details h1": "height: 3.21em",
            r"\.random-author": "height: 18px",
            r"\.random-comic-details \.hero-intro": "height: 5.25em",
            r"\.random-tags": "height: 60px",
            r"\.hero-notes\.random-meta": "height: 64px",
            r"\.random-comic-details \.hero-actions": "min-height: 46px",
        }
        for selector, declaration in fixed_slots.items():
            self.assertRegex(
                home_style,
                re.compile(rf"{selector}\s*\{{.*?{re.escape(declaration)}", re.S),
            )
        self.assertRegex(
            home_style,
            re.compile(r"\.random-tags\.is-empty\s*\{[^}}]*visibility:\s*hidden;"),
        )

    def test_random_history_has_deck_paging_and_library_subview_without_feedback(self):
        home = (PROJECT_DIR / "index.html").read_text(encoding="utf-8")
        library = (PROJECT_DIR / "library.html").read_text(encoding="utf-8")
        banner = (SOURCE_DIR / "components" / "index" / "BannerManager.js").read_text(encoding="utf-8")
        store = (SOURCE_DIR / "data" / "LibraryStore.js").read_text(encoding="utf-8")
        library_page = (SOURCE_DIR / "pages" / "library.js").read_text(encoding="utf-8")
        home_style = (PROJECT_DIR / "style" / "index.css").read_text(encoding="utf-8")

        for required in (
            "data-random-stack",
            "data-random-prev",
            "data-random-next",
            'href="./library.html?view=random"',
        ):
            self.assertIn(required, home)
        for required in (
            "recordRandomHistory",
            "getRandomHistory",
            "random-cover-ghost",
            "#mountCoverImage",
            'querySelectorAll(".random-cover-ghost").forEach',
            "transitionId !== this.transitionId",
            "image.width = 3",
            "image.height = 4",
            'name: "older"',
            'name: "newer"',
            "card.dataset.randomDirection",
        ):
            self.assertIn(required, banner + store)
        self.assertIn('data-view="random"', library)
        self.assertIn("random-history-grid", library_page)
        self.assertIn("repeat(5, minmax(0, 1fr))", (PROJECT_DIR / "style" / "library.css").read_text(encoding="utf-8"))
        self.assertIn(".random-stack-card", home_style)
        self.assertRegex(
            home_style,
            re.compile(r"\.random-stack-card\s*\{[^}]*opacity:\s*1;", re.S),
        )
        self.assertNotIn("--stack-opacity", banner + home_style)
        self.assertNotIn("random-turn", home_style)
        self.assertNotIn("反馈会用于改善本地推荐", home + banner)
        self.assertNotIn("data-random-feedback", home + banner)
        self.assertNotIn("saveRecommendationFeedback", banner)
        for decorative_text in (
            "random-cover-caption",
            "data-random-caption",
            "data-random-position",
            "VALIDATED COMIC",
            "SEARCHING",
            "hero-stroke",
        ):
            self.assertNotIn(decorative_text, home + banner + home_style)
        self.assertNotIn("18px 18px 0 rgba(var(--accent-rgb)", home_style)
        self.assertNotIn("12px 12px 0 rgba(var(--accent-rgb)", home_style)
        self.assertIn("height: calc(100% - 106px)", home_style)
        self.assertIn("is-cover-error", banner + home_style)
        self.assertIn("prefers-reduced-motion", home_style)

    def test_reader_progress_is_separate_and_utility_controls_are_icon_based(self):
        reader = (PROJECT_DIR / "reader.html").read_text(encoding="utf-8")
        progress = (
            SOURCE_DIR / "components" / "chapter" / "ComicReadingProgress.js"
        ).read_text(encoding="utf-8")
        reader_images = (
            SOURCE_DIR / "components" / "chapter" / "ReaderImageManager.js"
        ).read_text(encoding="utf-8")
        image_loader = (
            SOURCE_DIR / "components" / "chapter" / "EagerComicImageLoader.js"
        ).read_text(encoding="utf-8")
        source_switcher = (
            SOURCE_DIR / "components" / "general" / "SwitchServerBtnManager.js"
        ).read_text(encoding="utf-8")
        batch = (
            SOURCE_DIR / "components" / "general" / "ImageLoadBatchManager.js"
        ).read_text(encoding="utf-8")
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")

        self.assertRegex(
            reader,
            re.compile(
                r'<div class="reader-side-stack">\s*'
                r'<aside class="reader-panel.*?</nav>\s*</aside>\s*'
                r'<aside class="progress-cr reader-progress-panel.*?</aside>\s*'
                r"</div>",
                re.S,
            ),
        )
        self.assertRegex(reader, re.compile(r'prev-chapter.*?d="m6 15 6-6 6 6"', re.S))
        self.assertRegex(reader, re.compile(r'next-chapter.*?d="m6 9 6 6 6-6"', re.S))
        self.assertIn('class="progress-separator"', reader)
        self.assertIn('class="progress-total"', reader)
        self.assertIn('class="progress-separator" aria-hidden="true">/</span>', reader)

        self.assertIn('this.container.querySelector(".progress-total")', progress)
        self.assertIn("this.totalLabel.textContent = String(this.maxIndex + 1)", progress)
        self.assertNotIn("this.totalLabel.textContent = `/", progress)
        self.assertNotIn("isHorizontal()", progress)
        self.assertIn("(event.clientY - rect.top) / rect.height", progress)
        self.assertIn('this.thumb.setAttribute("role", "slider")', progress)
        self.assertIn('this.thumb.addEventListener("keydown"', progress)
        self.assertIn('this.thumb.setAttribute("aria-valuenow"', progress)
        self.assertNotIn("this.fill.style.width = `${ratio * 100}%`", progress)
        self.assertIn("this.fill.style.height = `${ratio * 100}%`", progress)
        self.assertIn('this.thumb.setAttribute("aria-orientation", "vertical")', progress)
        self.assertIn("setProgressFromViewport(index)", progress)
        self.assertIn("safeIndex !== this.seekingIndex", progress)
        self.assertIn("realignSeekingTarget(layoutStable = false)", progress)
        self.assertIn('root.style.scrollBehavior = "auto"', progress)
        self.assertIn(
            "return this.loader.isLayoutStableBefore(index)",
            reader_images,
        )
        self.assertIn("if (!this.progress.setProgressFromViewport(index)) return", reader_images)
        self.assertIn("onLayoutChange: (index) => this.handleImageLayoutChange(index)", reader_images)
        self.assertIn("isLayoutStableBefore(index)", image_loader)
        self.assertIn("this.onLayoutChange?.(Number(container.dataset.index))", image_loader)

        self.assertIn('class="server-trigger-icon"', source_switcher)
        self.assertIn('class="batch-setting-icon"', batch)
        self.assertNotIn('class="control-value"', source_switcher)
        self.assertNotIn('class="control-value"', batch)
        self.assertNotIn('querySelector(".control-value")', source_switcher)
        self.assertNotIn('querySelector(".control-value")', batch)
        self.assertNotIn("this.titleDom.textContent =", source_switcher)
        self.assertNotIn("this.trigger.textContent =", batch)
        self.assertIn('this.titleDom.setAttribute("aria-label"', source_switcher)
        self.assertIn('this.trigger.setAttribute("aria-label"', batch)
        self.assertIn('aria-haspopup="dialog"', batch)
        self.assertIn('setAttribute("role","listbox")', source_switcher)
        self.assertIn('option.setAttribute("aria-selected"', source_switcher)

        progress_count_rule = re.search(
            r"(?ms)^\.reader-progress-panel \.progress-count\s*\{(.*?)^\}",
            theme,
        )
        self.assertIsNotNone(progress_count_rule)
        self.assertIn("display: grid", progress_count_rule.group(1))
        self.assertIn("grid-template-columns:", progress_count_rule.group(1))
        self.assertRegex(
            progress_count_rule.group(1),
            r"grid-template-columns:[^;]*(?:1fr|minmax\()[^;]*auto[^;]*(?:1fr|minmax\()",
        )
        progress_count_widths = [
            int(width)
            for width in re.findall(
                r"\.reader-progress-panel \.progress-count\s*\{[^}]*\bwidth:\s*(\d+)px",
                theme,
            )
        ]
        self.assertTrue(progress_count_widths)
        self.assertGreaterEqual(min(progress_count_widths), 56)
        self.assertIn(
            'font: 900 14px/1 ui-monospace, "SFMono-Regular", Menlo, monospace !important',
            theme,
        )
        compact_current_sizes = re.findall(
            r"\.reader-progress-panel \.progress-current\s*\{[^}]*font-size:\s*(\d+)px",
            theme,
        )
        self.assertEqual(compact_current_sizes, ["12", "12"])
        self.assertIn("@media (orientation: portrait)", theme)
        self.assertIn("@media (orientation: portrait) and (max-width: 800px)", theme)
        self.assertIn("@media (orientation: portrait) and (max-height: 600px)", theme)
        self.assertIn(
            ".reader-progress-panel input.progress-current { font-size: 14px !important; }",
            theme,
        )
        self.assertIn(
            './style/jmcomic-next.css?v=20260902-reader-button-icons-only1',
            reader,
        )
        self.assertIn(
            ".reader-side-stack .reader-back svg { transform: translateX(-1px); }",
            theme,
        )
        self.assertNotIn(".reader-select-control:focus-within", theme)
        self.assertNotRegex(reader, r'class="(?:reader-panel|progress-cr reader-progress-panel)[^"]*glass-card')
        self.assertIn("--shell-field-bg:", theme)
        self.assertIn("--shell-button-bg:", theme)
        self.assertGreaterEqual(theme.count("background: var(--shell-field-bg);"), 3)
        self.assertGreaterEqual(theme.count("background: var(--shell-button-bg);"), 1)
        self.assertIn(
            "background: linear-gradient(145deg, rgba(255, 255, 255, .12)",
            theme,
        )
        self.assertIn("box-shadow: var(--shell-field-shadow);", theme)
        self.assertIn("box-shadow: var(--shell-button-shadow);", theme)
        self.assertNotIn("--reader-rail-glass", theme)
        self.assertNotIn("--reader-glass", theme)
        self.assertRegex(
            theme,
            re.compile(
                r"body\.reader-body::after\s*\{\s*content:\s*none;\s*display:\s*none;\s*\}",
                re.S,
            ),
        )
        self.assertNotIn("--reader-center-blur-mask", theme)
        self.assertNotIn("backdrop-filter: blur(4px)", theme)
        self.assertNotIn("mask-image: var(--reader-center-blur-mask)", theme)
        self.assertNotIn(".reader-side-stack > .reader-panel::after", theme)
        self.assertNotIn(".reader-side-stack > .reader-progress-panel::after", theme)
        self.assertIn("width: 22px;\n    height: 22px;\n    stroke-width: 2.2;", theme)

        reader_button_rule = re.search(
            r"\.reader-side-stack \.reader-back,\s*\n"
            r"\.reader-side-stack \.chapter-nav,\s*\n"
            r"\.reader-side-stack \.reader-select-control,\s*\n"
            r"\.reader-side-stack \.switch-server\.reader-source > span,\s*\n"
            r"\.reader-side-stack \.reader-batch-setting \.batch-setting-trigger\s*\{(.*?)\n\}",
            theme,
            re.S,
        )
        self.assertIsNotNone(reader_button_rule)
        self.assertNotIn("var(--reader-champagne-box-glow)", reader_button_rule.group(1))
        self.assertNotIn("var(--edge-glow)", reader_button_rule.group(1))
        self.assertIn("border-color: rgba(255, 255, 255, .12);", reader_button_rule.group(1))
        self.assertIn("box-shadow: 0 7px 14px rgba(0, 0, 0, .3);", reader_button_rule.group(1))
        self.assertIn("filter: var(--reader-champagne-icon-filter);", theme)

    def test_reader_landscape_sidebar_uses_translucent_shell_material_and_alignment(self):
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")

        self.assertIn("rgba(16, 16, 16, .66)", theme)
        self.assertIn("rgba(16, 16, 16, .5)", theme)
        self.assertIn("rgba(255, 255, 255, .035)", theme)
        self.assertIn("drop-shadow(0 0 30px rgba(199, 146, 47, .55))", theme)
        self.assertRegex(
            theme,
            re.compile(
                r"\.reader-side-stack \.reader-brand \.logo-mark\s*\{[^}]*"
                r"border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;",
                re.S,
            ),
        )
        landscape_rule = re.search(r"@media \(orientation: landscape\)\s*\{(.*?)\n\}", theme, re.S)
        self.assertIsNotNone(landscape_rule)
        self.assertIn(
            ".reader-side-stack > .reader-panel { justify-content: center; }",
            landscape_rule.group(1),
        )
        self.assertIn(
            ".reader-side-stack .reader-brand .logo-mark { transform: translateX(-1px); }",
            landscape_rule.group(1),
        )

    def test_reader_portrait_sidebar_overlays_and_toggles_from_the_reading_surface(self):
        reader_page = (SOURCE_DIR / "pages" / "reader.js").read_text(encoding="utf-8")
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")
        reader = (PROJECT_DIR / "reader.html").read_text(encoding="utf-8")

        portrait_rule = re.search(r"@media \(orientation: portrait\)\s*\{(.*?)\n\}", theme, re.S)
        self.assertIsNotNone(portrait_rule)
        self.assertIn(".reader-body { padding-right: 0; }", portrait_rule.group(1))
        self.assertIn(".reader-main { width: min(960px, 100%); }", portrait_rule.group(1))
        self.assertNotIn("backdrop-filter", portrait_rule.group(1))
        self.assertNotIn("--reader-rail", portrait_rule.group(1))
        self.assertNotIn(".reader-side-stack", portrait_rule.group(1))
        self.assertIn(".reader-body.reader-sidebar-hidden .reader-side-stack", theme)
        self.assertIn('this.setupSidebarToggle();', reader_page)
        self.assertIn('document.querySelector(".comic-content-cr")', reader_page)
        self.assertIn('readingSurface.addEventListener("click"', reader_page)
        self.assertIn('event.target.closest("a, button, input, select, textarea, label, summary, [contenteditable], [role], [tabindex]")', reader_page)
        self.assertIn('classList.toggle("reader-sidebar-hidden", hidden)', reader_page)
        self.assertIn('sideStack.setAttribute("aria-hidden", String(hidden))', reader_page)
        self.assertIn('@keyframes reader-sidebar-reveal', theme)
        self.assertIn('.reader-side-stack.reader-sidebar-entering', theme)
        self.assertIn('.reader-side-stack.reader-sidebar-leaving', theme)
        self.assertIn('animation: reader-sidebar-reveal .26s cubic-bezier(.4, 0, 1, 1) reverse both', theme)
        self.assertNotIn('transform: translate3d(calc(100% + 20px), 0, 0)', theme)
        self.assertIn('event.animationName !== "reader-sidebar-reveal"', reader_page)
        self.assertIn('setHidden(!sidebarHidden)', reader_page)
        self.assertIn(
            './src/pages/reader.js?v=20260902-reader-sidebar-no-blur2',
            reader,
        )

    def test_reader_sidebar_uses_plain_material_without_blur_mask(self):
        reader_page = (SOURCE_DIR / "pages" / "reader.js").read_text(encoding="utf-8")
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")
        reader = (PROJECT_DIR / "reader.html").read_text(encoding="utf-8")

        self.assertFalse((SOURCE_DIR / "components" / "chapter" / "ReaderLiquidGlass.js").exists())
        for removed in (
            "ReaderLiquidGlass",
            "setupLiquidGlass",
            "--reader-liquid-filter",
            "--reader-glass-x",
            "--reader-glass-y",
            "--reader-glass-intensity",
            "reader-liquid-native",
        ):
            self.assertNotIn(removed, reader_page + theme)
        self.assertNotRegex(reader, r'class="reader-panel[^"]*glass-card')
        self.assertNotRegex(reader, r'class="progress-cr reader-progress-panel[^"]*glass-card')
        for selector in (
            r"\.reader-side-stack > \.reader-panel",
            r"\.reader-side-stack > \.reader-progress-panel\.progress-cr",
        ):
            rule = re.search(rf"(?ms)^{selector}\s*\{{(.*?)^\}}", theme)
            self.assertIsNotNone(rule)
            self.assertIn("-webkit-backdrop-filter: none", rule.group(1))
            self.assertIn("backdrop-filter: none", rule.group(1))
            self.assertIn("filter: none", rule.group(1))
        stack_rule = re.search(r"(?ms)^\.reader-side-stack\s*\{(.*?)^\}", theme)
        self.assertIsNotNone(stack_rule)
        self.assertNotIn("backdrop-filter", stack_rule.group(1))
        self.assertNotIn("--reader-center-blur-mask", theme)
        self.assertNotIn("backdrop-filter: blur(4px)", theme)
        self.assertNotIn("mask-image: var(--reader-center-blur-mask)", theme)
        self.assertNotRegex(
            theme,
            r"\.reader-side-stack > \.(?:reader-panel|reader-progress-panel)::(?:before|after)",
        )

    def test_every_page_uses_a_neutral_dark_browser_chrome_color(self):
        failures = []
        for page in PROJECT_DIR.glob("*.html"):
            text = page.read_text(encoding="utf-8")
            colors = re.findall(r'<meta[^>]+name=["\']theme-color["\'][^>]+content=["\']([^"\']+)', text)
            if not colors or any(color.lower() not in {"#000000", "#030303"} for color in colors):
                failures.append(f"{page.name}: theme colors are {colors}")
        self.assertEqual(failures, [])

    def test_relative_module_imports_are_unversioned_and_exist(self):
        failures = []
        for source in SOURCE_DIR.rglob("*.js"):
            text = source.read_text(encoding="utf-8")
            for specifier in IMPORT_PATTERN.findall(text):
                if not specifier.startswith("."):
                    continue
                if "?" in specifier or "#" in specifier:
                    failures.append(f"{source.relative_to(ROOT)}: versioned import {specifier}")
                    continue
                target = (source.parent / specifier).resolve()
                if not target.is_file():
                    failures.append(f"{source.relative_to(ROOT)}: missing import {specifier}")
        self.assertEqual(failures, [])

    def test_navigation_policy_opens_comics_in_new_tabs_with_contextual_exceptions(self):
        policy = (SOURCE_DIR / "utils" / "NavigationPolicy.js").read_text(encoding="utf-8")
        settings = (SOURCE_DIR / "components" / "general" / "Setting.js").read_text(encoding="utf-8")
        nav = (SOURCE_DIR / "components" / "general" / "NavManager.js").read_text(encoding="utf-8")
        head = (SOURCE_DIR / "components" / "chapter" / "HeadManager.js").read_text(encoding="utf-8")
        recommendations = (SOURCE_DIR / "components" / "chapter" / "RecommendedComicsManager.js").read_text(encoding="utf-8")
        comic_lists = [
            (SOURCE_DIR / "components" / section / manager).read_text(encoding="utf-8")
            for section, manager in (
                ("categories", "CategoriesContainerManager.js"),
                ("search", "SearchContainerManager.js"),
                ("latest", "LatestContainerManager.js"),
            )
        ]
        home = (PROJECT_DIR / "index.html").read_text(encoding="utf-8")
        chapter = (PROJECT_DIR / "chapter.html").read_text(encoding="utf-8")
        reader = (PROJECT_DIR / "reader.html").read_text(encoding="utf-8")

        self.assertIn('anchor.target = "_blank"', policy)
        self.assertIn('anchor.closest(APP_DOCK_SCOPE)', policy)
        self.assertNotIn('isComicDetailNavigation(anchor)', policy)
        self.assertNotIn('destination.pathname.endsWith("/chapter.html")', policy)
        self.assertIn('rel.add("noopener")', policy)
        self.assertIn('new MutationObserver', policy)
        self.assertIn("installNavigationPolicy();", settings)
        self.assertIn('if (pageName() === "search") window.location.assign(searchUrl)', nav)
        self.assertIn("else openInNewPage(searchUrl)", nav)
        self.assertRegex(home, r'class="app-dock"[^>]+data-navigation-scope="same-tab"')
        self.assertRegex(chapter, r'class="primary-btn start-read"[^>]+data-navigation="same-tab"')
        self.assertRegex(head, r'class="chapter-item"[^>]+data-navigation="same-tab"')
        self.assertRegex(reader, r'class="reader-panel"[^>]+data-navigation-scope="same-tab"')
        self.assertRegex(recommendations, r'<a class="rc-item"[^>]+href="\./chapter\.html')
        self.assertNotIn('data-navigation="same-tab"', recommendations)
        self.assertNotIn('open(`./chapter.html', recommendations)
        for comic_list in comic_lists:
            self.assertIn('href="./chapter.html', comic_list)
            self.assertNotIn('data-navigation="same-tab"', comic_list)
            self.assertNotIn('target="_blank"', comic_list)

    def test_title_translation_cache_is_scoped_to_the_selected_provider(self):
        head = (SOURCE_DIR / "components" / "chapter" / "HeadManager.js").read_text(encoding="utf-8")

        self.assertIn('this.translationCacheKey = ""', head)
        self.assertIn('await localRuntime.getAiConfig()', head)
        self.assertIn('? `ai:${String(aiConfig?.model || "configured")}`', head)
        self.assertIn(': "google"', head)
        self.assertIn('this.translationCacheKey === translationCacheKey', head)
        self.assertIn('this.translationCacheKey = translationCacheKey', head)

    def test_detail_page_feedback_has_five_rows_above_evaluation(self):
        chapter = (PROJECT_DIR / "chapter.html").read_text(encoding="utf-8")
        page = (SOURCE_DIR / "pages" / "chapter.js").read_text(encoding="utf-8")
        manager = (
            SOURCE_DIR / "components" / "chapter" / "DetailRecommendationFeedbackManager.js"
        ).read_text(encoding="utf-8")
        style = (PROJECT_DIR / "style" / "chapter.css").read_text(encoding="utf-8")

        feedback_above_evaluation = re.search(
            r'<div class="detail-feedback-panel">\s*'
            r'<section class="detail-recommendation-feedback".*?</section>\s*'
            r'<div class="evaluation',
            chapter,
            re.S,
        )
        self.assertIsNotNone(feedback_above_evaluation)
        for reason in ("overall", "cover", "title", "tag_mix", "author"):
            self.assertEqual(chapter.count(f'data-feedback-reason="{reason}"'), 1)
        self.assertEqual(chapter.count('data-detail-feedback="interested"'), 5)
        self.assertEqual(chapter.count('data-detail-feedback="not_interested"'), 5)

        self.assertIn("new DetailRecommendationFeedbackManager().init(album)", page)
        self.assertIn("localRuntime.saveRecommendationFeedback", manager)
        self.assertIn("localRuntime.getLocalComic", manager)
        self.assertIn("interest_feedback", manager)
        self.assertIn("comic: comicPayload(this.album)", manager)
        self.assertIn(".detail-primary-actions", style)
        self.assertRegex(style, r"\.detail-recommendation-feedback\s*\{[^}]*display:\s*grid")
        self.assertIn("detail-feedback-state", chapter + manager + style)

    def test_detail_mobile_actions_share_one_four_column_row(self):
        chapter = (PROJECT_DIR / "chapter.html").read_text(encoding="utf-8")
        route_style = (PROJECT_DIR / "style" / "chapter.css").read_text(encoding="utf-8")
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")

        self.assertRegex(
            chapter,
            re.compile(
                r'<div class="detail-primary-actions">\s*'
                r'<a class="primary-btn start-read".*?</a>\s*'
                r'<div class="detail-secondary-actions">.*?'
                r'class="ghost-btn like-action".*?'
                r'class="ghost-btn favorite-action".*?'
                r'class="ghost-btn track-action"',
                re.S,
            ),
        )
        for stylesheet in (route_style, theme):
            self.assertRegex(
                stylesheet,
                re.compile(
                    r'@media \(max-width:\s*(?:760|800)px\).*?'
                    r'\.detail-primary-actions\s*\{[^}]*display:\s*grid;[^}]*'
                    r'grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);[^}]*\}.*?'
                    r'\.detail-secondary-actions\s*\{\s*display:\s*contents;\s*\}',
                    re.S,
                ),
            )

    def test_detail_hero_desktop_columns_align_and_constrain_copy(self):
        style = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")
        desktop = re.search(
            r"@media \(min-width:\s*761px\)\s*\{(?P<body>.*?)\n\}",
            style[style.index("/* Five independent interest dimensions"):],
            re.S,
        )
        self.assertIsNotNone(desktop)
        body = desktop.group("body")
        self.assertRegex(body, r"\.detail-hero\s*\{[^}]*grid-template-columns:\s*minmax\(190px, 250px\)\s+minmax\(0, 1fr\)\s+minmax\(330px, 390px\)")
        self.assertRegex(body, r"\.head\s*>\s*\.cover\s*\{[^}]*grid-row:\s*2")
        self.assertRegex(body, r"\.detail-kicker\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1")
        self.assertRegex(body, r"\.comic-info\s*\{[^}]*min-width:\s*0;[^}]*grid-column:\s*2;[^}]*grid-row:\s*2")
        self.assertRegex(body, r"\.detail-feedback-panel\s*\{[^}]*grid-column:\s*3;[^}]*grid-row:\s*1\s*/\s*span\s*2;[^}]*align-self:\s*start")
        self.assertRegex(body, r"\.comic-info\s+\.title,[^{]*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere")

    def test_ai_profile_is_collapsible_and_recommendations_use_large_single_rows(self):
        page = (SOURCE_DIR / "pages" / "ai.js").read_text(encoding="utf-8")
        style = (PROJECT_DIR / "style" / "ai.css").read_text(encoding="utf-8")
        theme = (PROJECT_DIR / "style" / "jmcomic-next.css").read_text(encoding="utf-8")

        self.assertIn('<details class="profile-details">', page)
        self.assertNotIn('<details class="profile-details" open>', page)
        self.assertIn('class="profile-overview"', page)
        self.assertRegex(
            style,
            re.compile(r"\.recommend-results\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)", re.S),
        )
        for stylesheet in (style, theme):
            self.assertRegex(
                stylesheet,
                re.compile(r"\.ai-result-item\s*\{[^}]*grid-template-columns:\s*180px\s+minmax\(0,\s*1fr\)", re.S),
            )

    def test_interest_feedback_is_detail_only_and_dimension_scoped(self):
        home = (PROJECT_DIR / "index.html").read_text(encoding="utf-8")
        ai_page = (SOURCE_DIR / "pages" / "ai.js").read_text(encoding="utf-8")
        detail = (SOURCE_DIR / "components" / "chapter" / "DetailRecommendationFeedbackManager.js").read_text(encoding="utf-8")
        banner = (SOURCE_DIR / "components" / "index" / "BannerManager.js").read_text(encoding="utf-8")
        runtime = (SOURCE_DIR / "local" / "LocalRuntime.js").read_text(encoding="utf-8")
        store = (SOURCE_DIR / "data" / "LibraryStore.js").read_text(encoding="utf-8")

        self.assertIn("getComicFeedbackStates", runtime)
        self.assertNotIn("data-recommendation-feedback", ai_page)
        self.assertNotIn("refreshRecommendationFeedback", ai_page)
        self.assertNotIn("data-random-feedback", home + banner)
        self.assertNotIn("saveRandomFeedback", banner + store)
        self.assertIn("dataset.feedbackReason", detail)
        self.assertIn("interest_feedback", detail)
        self.assertIn('? "clear" : action', detail)
        self.assertIn("已取消选择", detail)
        self.assertIn('window.addEventListener("focus"', detail)

    def test_collapsed_score_breakdown_is_a_compact_control(self):
        page = (SOURCE_DIR / "pages" / "ai.js").read_text(encoding="utf-8")
        style = (PROJECT_DIR / "style" / "ai.css").read_text(encoding="utf-8")

        self.assertIn('<span>评分依据</span>', page)
        self.assertRegex(style, re.compile(r"\.score-breakdown\s*\{[^}]*width:\s*fit-content", re.S))
        self.assertRegex(style, re.compile(r"\.score-breakdown\[open\]\s*\{[^}]*width:\s*100%", re.S))
        self.assertRegex(style, re.compile(r"\.score-breakdown summary\s*\{[^}]*border-radius:\s*999px", re.S))

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

    def test_local_evaluation_uses_one_total_score_and_shows_the_scale(self):
        manager = (SOURCE_DIR / "components" / "chapter" / "LocalRatingManager.js").read_text(encoding="utf-8")
        ai_page = (SOURCE_DIR / "pages" / "ai.js").read_text(encoding="utf-8")
        expected_rules = (
            "垃圾作品，看了浪费时间",
            "有严重雷点",
            "中规中矩",
            "整体及格且有亮点",
            "全方面优秀",
        )
        for page_name in ("chapter.html", "reader.html"):
            page = (PROJECT_DIR / page_name).read_text(encoding="utf-8")
            self.assertIn('class="rating-score-area"', page)
            self.assertIn('class="rating-rules"', page)
            for rule in expected_rules:
                self.assertIn(rule, page)

        combined = manager + ai_page + (PROJECT_DIR / "ai.html").read_text(encoding="utf-8")
        for removed in ("sexual_appeal", "story_artistry", "weird_humor", "aspect_scores", 'name="mode"'):
            self.assertNotIn(removed, combined)


if __name__ == "__main__":
    unittest.main()
