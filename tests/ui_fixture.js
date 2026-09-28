/* Local-only visual fixture. Real page/component modules run against these fakes. */
const page = new URL(import.meta.url).searchParams.get("page") || "index";
const allowedPages = new Set(["index", "setting", "messages", "reader", "chapter", "ai", "library", "search", "latest", "categories", "history-migration"]);
if (!allowedPages.has(page)) throw new Error("Unknown UI fixture page");
const fixture = window.__uiFixture = { page, errors: [], blockedRequests: [], stubbedCalls: [] };
const nativeFetch = window.fetch.bind(window);
window.addEventListener("error", (event) => fixture.errors.push(String(event.message)));
window.addEventListener("unhandledrejection", (event) => fixture.errors.push(String(event.reason)));
// External XHR/beacon connections are also blocked by the server's CSP header.
window.fetch = async (input) => {
    fixture.blockedRequests.push(String(input?.url || input));
    throw new Error("UI fixture: network requests are disabled");
};
document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (link && new URL(link.href, location.href).origin !== location.origin) event.preventDefault();
}, true);

const [{ jmApi }, { localRuntime }, { authSession }, { libraryStore }] = await Promise.all([
    import("/src/api/JmcomicApi.js"), import("/src/local/LocalRuntime.js"),
    import("/src/auth/AuthSession.js"), import("/src/data/LibraryStore.js"),
]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const constant = (value) => async () => clone(value);
const stamp = 1788566400;
const cover = (id = 1, reader = false) => `/__fixture__/cover.svg?i=${Number(id) % 100 || 1}${reader ? "&reader=1" : ""}`;
const titles = ["山间来信", "沿海的漫长一天", "城市观察手记", "雨后的图书馆", "穿过森林的列车", "旅途中的微小发现"];
const series = [
    { id: "100101", name: "第一章 · 清晨出发", sort: "1" },
    { id: "100102", name: "第二章 · 海边来信", sort: "2" },
    { id: "100103", name: "第三章 · 返回山间", sort: "3" },
];
const album = (id = "100100") => ({
    id: String(id), name: titles[Number(id) % titles.length], author: ["示例作者", "观察工作室"],
    tags: ["旅行", "日常", "自然", "短篇"], actors: ["旅人"], works: ["风景手记"], related_list: [],
    description: "这是一份完全虚构的界面测试资料。旅人沿着海岸与山间小路，记录日常生活里温柔而细小的发现，用于检查标题、简介、评分与阅读布局。",
    series: clone(series), chapters: 3, total_photos: 6, total_views: 12580, likes: 328, comment_total: 2,
    addtime: stamp, update_at: stamp, cover_url: cover(id), liked: false, is_favorite: false,
});
const comics = Array.from({ length: 12 }, (_, index) => album(100100 + index));
const categories = [{ type: "slug", slug: "daily", name: "日常", sub_categories: [{ CID: "11", slug: "travel", name: "旅行" }, { CID: "12", slug: "nature", name: "自然" }] }, { type: "slug", slug: "short", name: "短篇", sub_categories: [] }];
const profile = {
    summary: "示例偏好更倾向旅行、自然与生活观察题材。这里的评分、标签和作者均为虚构测试内容。",
    rating_summary: { mean: 7.8, sample_count: 12, confidence: 0.82 },
    preferred_tags: ["旅行", "自然", "日常"], preferred_authors: ["示例作者"],
    structured_stats: { evidence_count: 24, rated_count: 12, interaction_count: 48 },
};
const recommendations = comics.slice(0, 4).map((item, index) => ({ ...item, title: item.name, authors: item.author, score: 8.8 - index * .4, reason: "自然题材与日常观察符合示例偏好，叙事轻松，适合继续阅读。", evidence: [{ label: "具体设定", source: "comment:0", quote: "自然观察的独特设定" }], score_breakdown: [{ key: "preference", label: "喜欢门槛匹配", contribution: 65 }, { key: "novelty", label: "探索", contribution: 3 }] }));
const run = { id: 1, status: "success", created_at: stamp, recommendations };
const user = { uid: "1", username: "本地测试", level_name: "体验用户" };
const account = { configured: true, authenticated: true, username: user.username, user };
const semanticText = '内容概括：旅人沿海岸与山间记录自然观察。\n参与推荐的内容特征：\n具体设定：0.8（读者评论）\n依据：自然观察的独特设定';
const semanticState = comic => ({ status: comic?.rating != null ? "ready" : "unrated", current: comic?.rating != null, text: comic?.rating != null ? semanticText : "" });
const semanticOverview = () => { const items = [...memory.values()].filter(c => c.rating != null).map(c => ({ id: c.id, title: c.title, rating: c.rating, ...semanticState(c) })); return { configured: true, counts: {ready:items.length,queued:0,running:0,error:0,missing:0,stale:0,unconfigured:0}, items: [] }; };
const memory = new Map(comics.slice(0, 3).map((item, i) => [item.id, { ...item, title: item.name, authors: item.author, rating: 8 - i, review: "虚构的本地阅读评价", tag_feedback: { "旅行": 1 } }]));

// Default stubs keep newly added calls local; named fakes below supply useful shapes.
for (const object of [jmApi, localRuntime]) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(object)))) {
        if (name !== "constructor" && typeof descriptor.value === "function") {
            object[name] = async () => { fixture.stubbedCalls.push(name); return {}; };
        }
    }
}
Object.assign(jmApi, {
    init: constant({}), servers: ["fixture.invalid"], imgServers: Array(6).fill("fixture.invalid"),
    getComicAlbum: async (id) => ({ ...album(id), related_list: comics.slice(1, 5) }),
    getComicChapter: async (id) => ({ id: String(Number(id) < 220980 ? id : 100101), series_id: "100100", name: "风景手记 · 清晨出发", series: clone(series), images: ["01.svg", "02.svg", "03.svg", "04.svg", "05.svg", "06.svg"] }),
    getCoverImageURL: cover, getUserPhotoURL: () => cover(2),
    getChapterImageURLs: (_id, path) => [cover(parseInt(path, 10), true)],
    getChapterImageServers: () => [],
    getComicComments: constant({ total: 2, list: [{ CID: 1, username: "山间读者", content: "示例评论：喜欢这里的风景描写。", photo: "" }, { CID: 2, username: "沿海旅人", content: "示例评论：布局清楚，阅读过程轻松。", photo: "" }] }),
    getPromotionContent: constant([{ slug: "推荐", title: "本周精选", content: comics.slice(0, 8) }, { slug: "短篇", title: "轻松阅读", content: comics.slice(4) }]),
    getCategories: constant({ categories }), getCategoriesFilter: constant({ content: comics, total: 12 }),
    getSearchResults: constant({ content: comics, total: 12 }), getFilteredComics: async (_query, requestedPage) => ({ content: requestedPage > 1 ? [] : clone(comics), total: 12 }),
    getLatestContent: constant({ content: comics, total: 12 }),
    login: constant(user), ensureAuthenticated: constant(user), clearAuthServer() {},
    getFavorites: constant({ list: comics.slice(0, 6), total: 6, folder_list: [{ FID: "0", name: "全部收藏" }] }), getAllFavorites: constant(comics.slice(0, 6)),
    getFavoriteIds: async () => new Set(), getFavoriteState: constant(false), getLikeState: constant(false),
    updateFavoriteState: async (_id, saved) => ({ saved }), toggleLike: constant({ liked: true }), setLikeState() {},
    getAlbumTrackingState: constant(false), toggleAlbumTracking: constant({ tracked: true }),
    dailyCheckIn: constant({ status: "success", message: "示例签到成功" }), getDailyCheckInStatus: constant({ checked: false }),
    getUnreadNotificationCount: constant(2), markNotification: constant({ saved: true }),
    getNotifications: constant({ total: 3, list: [{ id: 1, title: "阅读记录已同步", content: "这是一条虚构通知，用于检查已读状态与长文本排版。", read: false, date: "2026-09-05" }, { id: 2, title: "示例连载更新", content: "旅途手记更新了一个新章节，可以从右侧追踪列表继续阅读。", read: false, date: "2026-09-04" }, { id: 3, title: "欢迎回来", content: "所有内容均来自本机测试数据。", read: true, date: "2026-09-03" }] }),
    getAlbumTrackingList: constant({ item: comics.slice(0, 4), totalCnt: 4 }),
});
const fixtureJobs = new Map();
Object.assign(localRuntime, {
    getAccountSummary: constant(account), loginAccount: constant(user), ensureAccountSession: constant(user),
    getAiConfig: constant({ configured: true, model: "fixture-model", base_url: "https://example.invalid/v1", api_key_configured: true, use_ai_translation: true }),
    getEmbeddingConfig: constant({ configured: true, model: "fixture-embedding", api_key_configured: true, dimension: 1024 }),
    getEmbeddingStatus: constant({ available: true, model: "fixture-embedding", dimension: 1024 }),
    testAiConfig: constant({ success: true }), testEmbeddingConfig: constant({ success: true }),
    translateTitleWithAi: async (title) => ({ translated: title, translation: title, title }),
    getLocalComic: async (id) => ({ comic: memory.get(String(id)) || null, content_analysis: semanticState(memory.get(String(id))) }),
    getContentAnalysis: async id => id ? semanticState(memory.get(String(id))) : semanticOverview(),
    updateContentAnalysis: async () => semanticOverview(),
    saveLocalComic: async (value) => { const comic = { ...memory.get(String(value.id)), ...clone(value) }; memory.set(String(value.id), comic); return { comic: clone(comic), saved: true, content_analysis: semanticState(comic) }; },
    getLocalComics: async () => ({ comics: [...memory.values()] }), getComicFeedbackStates: constant({ states: {} }),
    syncLocalFavorites: constant({ synced: 6 }),
    getAiProfile: constant({ stats: { favorites: 6, rated: 12, tag_feedback: 18, interactions: 48 }, profile }), generateAiProfile: constant({ profile }),
    getRecommendedIds: constant({ ids: [] }), getDiscoveryExcludedIds: constant({ ids: [] }),
    getRecommendationHistory: constant({ runs: [run] }), generateRecommendations: constant(run),
    getRecommendationJobs: async () => ({ jobs: [...fixtureJobs.values()] }),
    getRecommendationJob: async id => fixtureJobs.get(id) || { id, accepted: true, status: "success", result: run, prepared: 0 },
    submitRecommendationJob: async ({ id }) => {
        const job = { id, accepted: true, status: "success", result: run, prepared: 3, failed: 0, remaining: 0 };
        fixtureJobs.set(id, job); return job;
    },
    cancelRecommendationJob: async id => ({ id, status: "cancelled" }),
    planContent: async candidates => ({ configured: true, training: [], candidates }),
    prepareContent: constant({ status: "ready" }),
    saveRecommendationFeedback: async ({comic_id, action, reason, comic}) => {
        const record = { ...comic, ...memory.get(String(comic_id)) };
        const states = { ...record.interest_feedback };
        if (action === "clear") delete states[reason]; else states[reason] = { action, reason };
        record.interest_feedback = states; memory.set(String(comic_id), record);
        return { saved: true, interest_feedback: clone(states) };
    }, recordInteraction: async (value) => { fixture.stubbedCalls.push(value.event_type); return { saved: true }; },
    readCache: constant(null), writeCache: constant(null), getWebChapterNames: constant({ chapters: series }),
});
authSession.setProfile(user);
authSession.configured = true;
authSession.configuredUsername = user.username;
authSession.configLoaded = true;
authSession.loadLocalConfig = constant(account);
authSession.loginFromLocalConfig = constant(user);
authSession.configure = async () => { authSession.dispatchChange(); return user; };
authSession.clearLocalConfig = async () => { authSession.configured = false; authSession.user = null; authSession.dispatchChange(); };
let readingHistory = comics.slice(0, 5).map((item) => ({...item, savedAt: stamp * 1000}));
let randomHistory = comics.slice(0, 5).map((item) => ({ ...item, savedAt: stamp * 1000 }));
Object.assign(libraryStore, {
    init: async () => {},
    getHistory: () => clone(readingHistory), async recordHistory() {}, async clearHistory() { readingHistory = []; },
    getRandomHistory: () => clone(randomHistory),
    recordRandomHistory: (item) => { randomHistory = [item, ...randomHistory.filter((old) => old.id !== item.id)].slice(0, 20); return item; },
    clearRandomHistory: () => { randomHistory = []; },
});
const current = new URL(location.href);
if ((page === "reader" || page === "chapter") && !current.searchParams.has("id")) {
    current.searchParams.set("id", page === "reader" ? "100101" : "100100");
    if (page === "reader") current.searchParams.set("album", "100100");
    history.replaceState(null, "", current);
}
await import(`/src/pages/${page}.js`);
fixture.ready = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function runChecks(shellOnly = false) {
    const report = window.__uiReport = { page: "ui-check", route: page, viewport: { width: innerWidth, height: innerHeight }, checks: [], errors: fixture.errors, blockedRequests: fixture.blockedRequests };
    const check = (name, passed, detail = "") => report.checks.push({ name, passed: Boolean(passed), detail });
    const click = (selector, root = document) => { const node = root.querySelector(selector); if (!node) throw new Error(`Missing control: ${selector}`); node.click(); return node; };
    try {
        await sleep(400);
        check("页面无横向溢出", document.documentElement.scrollWidth <= innerWidth + 1);
        check("主内容与入口已挂载", !!document.querySelector("main") && fixture.ready);
        if (page === "reader") {
            const tools = document.querySelector(".reader-tools");
            const rect = tools.getBoundingClientRect();
            check("合并工具栏位于底部并留出边缘", rect.left >= 12 && rect.right <= innerWidth - 12 && rect.top >= 8 && rect.bottom <= innerHeight - 8);
            check("标题返回与操作合并，移除小眼睛", tools.contains(document.querySelector(".reader-heading")) && !document.querySelector("[data-toggle-tools]"));
            check("正文顶部不再预留工具栏空白", getComputedStyle(document.querySelector(".app-main")).paddingTop === "0px");
        } else if (innerWidth < 700) {
            const toggle = document.querySelector("[data-toggle-menu]");
            const menu = document.querySelector(".mobile-navigation");
            check("首页不再显示底部悬浮导航", !document.querySelector(".tab-bar"));
            click("[data-toggle-menu]");
            // Safari may suspend animation timelines in an automated/background window.
            menu.closest(".sheet-panel").getAnimations().forEach((animation) => animation.finish());
            const panel = menu.closest(".sheet-panel").getBoundingClientRect();
            check("菜单覆盖全屏且导航完整", toggle.getAttribute("aria-expanded") === "true" && menu.querySelectorAll("a").length === 7 && Math.abs(panel.left) < 1 && Math.abs(panel.width - innerWidth) < 1 && panel.height >= innerHeight - 1 && document.body.style.position === "fixed", JSON.stringify({left: panel.left, width: panel.width, height: panel.height, viewport: [innerWidth, innerHeight], position: document.body.style.position}));
            menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            check("Escape 收起菜单并恢复焦点", !menu.closest(".sheet").classList.contains("is-open") && toggle.getAttribute("aria-expanded") === "false" && document.activeElement === toggle);
            click(".mobile-header [data-open-search]"); await sleep(80);
            check("顶部搜索可打开", !!document.querySelector('[data-sheet="search"].is-open'));
            click('[data-sheet="search"] .sheet-close');
        }
        if (shellOnly) {
            const { appShell } = await import("/src/ui/shell.js");
            const { Sheet } = await import("/src/ui/overlay.js");
            const { showToast } = await import("/src/ui/toast.js");
            const originalStyle = document.body.style.cssText;
            appShell.openAccount(); await sleep(150);
            const sheet = document.querySelector('[data-sheet="account"]');
            const panel = sheet.querySelector('.sheet-panel');
            check("账号弹层锁定背景滚动与焦点", document.body.style.position === "fixed" && document.querySelector("main").inert);
            sheet.querySelector('.auth-error').textContent = `测试错误：https://example.invalid/${"long-message-".repeat(60)}`;
            sheet.querySelector('[data-block="llm"]').open = true;
            await sleep(100);
            const rect = panel.getBoundingClientRect();
            check("长文本与配置表单保持视口内", panel.scrollWidth <= panel.clientWidth + 1 && rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1);
            const nested = new Sheet({title:"嵌套弹层"}); nested.open(); nested.close();
            check("关闭上层仍保留原弹层滚动锁", document.body.style.position === "fixed" && !sheet.inert);
            appShell.accountSheet.close();
            check("关闭全部弹层恢复滚动", document.body.style.cssText === originalStyle && !document.querySelector("main").inert);
            appShell.openMore(); await sleep(50);
            check("更多入口完整", document.querySelectorAll('[data-sheet="more"] .action-tile').length === 6);
            appShell.moreSheet.close();
            showToast(`测试提示：https://example.invalid/${"long-message-".repeat(160)}`, "warning"); await sleep(100);
            const toast = document.querySelector('.toast'); const box = document.querySelector('.toast-region').getBoundingClientRect();
            check("长提示不溢出视口", toast.scrollWidth <= toast.clientWidth + 1 && box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1);
            await sleep(3650); check("提示自动清理", !document.querySelector('.toast'));
        } else if (page === "chapter") {
            check("详情与章节完整", !!document.querySelector('.detail-title')?.textContent && document.querySelectorAll('.chapter-item').length === 3);
            check("阅读链接同页打开", document.querySelector('[data-start-read]').target === '_self');
            click('[data-score="9"]');
            const review = document.querySelector('.rating-editor textarea'); review.value = '虚构测试评语';
            click('[data-save-rating]'); await sleep(100);
            check("评价可保存并读回", (await localRuntime.getLocalComic('100100')).comic.rating === 9);
            check("评分后的内容分析可读且无原始JSON", document.querySelector("[data-summary-text]").textContent.includes("内容概括") && !document.querySelector("[data-summary-text]").textContent.includes("assertions"));
            click('[data-feedback-reason="cover"] [data-interest="interested"]'); await sleep(80);
            click('[data-feedback-reason="title"] [data-interest="not_interested"]'); await sleep(80);
            let saved = (await localRuntime.getLocalComic('100100')).comic;
            check("不同兴趣维度独立保存", saved.interest_feedback.cover?.action === 'interested' && saved.interest_feedback.title?.action === 'not_interested');
            click('[data-feedback-reason="cover"] [data-interest="interested"]'); await sleep(80);
            saved = (await localRuntime.getLocalComic('100100')).comic;
            check("再次点击只清除对应维度", !saved.interest_feedback.cover && saved.interest_feedback.title?.action === 'not_interested');
            click('[data-translate]'); await sleep(80);
            check("标题翻译可切换", document.querySelector('[data-translate]').getAttribute('aria-pressed') === 'true');
            for (const action of ['favorite','like','track']) { click(`[data-account-action="${action}"]`); await sleep(80); check(`${action} 操作可用`, document.querySelector(`[data-account-action="${action}"]`).getAttribute('aria-pressed') === 'true'); }
            check("评论显示", document.querySelectorAll('.comment-item').length === 2);
        } else if (page === "reader") {
            check("图片已还原或载入", document.querySelectorAll('.reader-images [data-state="loaded"]').length > 0);
            click('[data-reader-progress]'); await sleep(50);
            const form = document.querySelector('.reader-progress-form'); form.elements.page.value = 4; form.requestSubmit(); await sleep(200);
            check("进度可跳转至指定页", document.querySelector('[data-page-current]').textContent === '4');
            click('[data-reader-chapters]'); await sleep(50);
            check("目录保留同页阅读", document.querySelectorAll('.reader-chapter-list a[target="_self"]').length === 3);
            click('[data-sheet="chapters"] .sheet-close');
            click('[data-reader-settings]'); await sleep(50);
            click('[data-sheet="reading"] [data-batch="100"]'); await sleep(50);
            check("并发选择生效", document.querySelector('[data-sheet="reading"] [data-batch="100"]').getAttribute('aria-checked') === 'true');
            click('[data-sheet="reading"] .sheet-close');
            click('.reader-images'); check("专注模式隐藏工具并移出焦点", document.body.classList.contains('reader-focus') && document.querySelector('.reader-tools').inert);
            check("专注模式面板不参与边缘绘制", [".reader-heading", ".reader-tools"].every((selector) => getComputedStyle(document.querySelector(selector)).visibility === "hidden"));
            document.querySelector('.reader-images').dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
            check("空格恢复阅读工具", !document.body.classList.contains('reader-focus') && !document.querySelector('.reader-tools').inert);
            click('[data-more-comments]'); await sleep(80); check("本话评论按需载入", document.querySelectorAll('.comment-item').length === 2);
            check("阅读开始先于进度事件", fixture.stubbedCalls.indexOf('read_start') >= 0 && fixture.stubbedCalls.indexOf('read_progress') > fixture.stubbedCalls.indexOf('read_start'));
        } else if (page === "library") {
            click('[data-view="ratings"]'); await sleep(100); check("读取本地评价", document.querySelectorAll('.library-grid .comic-card').length === 3);
            click('[data-rating="8"]'); check("评分筛选准确", document.querySelectorAll('.library-grid .comic-card').length === 1);
            click('[data-view="history"]'); check("阅读历史可见", document.querySelectorAll('.library-grid .comic-card').length === 5);
            click('[data-view="random"]'); check("随机历史可见", document.querySelectorAll('.library-grid .comic-card').length === 5);
            click('[data-view="favorites"]'); await sleep(100); check("账号收藏可见", document.querySelectorAll('.library-grid .comic-card').length === 6);
        } else if (page === "ai") {
            const form = document.querySelector('.recommend-form'); form.elements.candidate_count.value = 3; form.elements.limit.value = 3;
            form.requestSubmit(); await sleep(250);
            check("推荐生成并显示评分依据", document.querySelectorAll('.ai-result-item').length > 0 && !!document.querySelector('.score-breakdown'));
            check("内容证据可读", document.querySelector(".recommend-results").textContent.includes("自然观察的独特设定"));
            click("[data-run]"); check("新格式历史可读", document.querySelectorAll(".ai-result-item").length > 0);
        } else if (page === "messages") {
            check("通知与追更分别显示", document.querySelectorAll('.notification-item').length === 3 && document.querySelectorAll('.tracking-item').length === 4);
            click('.notification-item.unread'); await sleep(50); check("标记已读生效", document.querySelectorAll('.notification-item.unread').length === 1);
            click('.refresh-messages'); await sleep(100); check("刷新后保留追更", document.querySelectorAll('.tracking-item').length === 4);
        } else if (page === "search" || page === "categories") {
            check("列表已显示", document.querySelectorAll('[data-results] .comic-card').length === 12);
            if (innerWidth < 700) click('[data-filter-toggle]');
            const box = document.querySelector('[data-hide-serial]'); box.checked = true; box.dispatchEvent(new Event('change', {bubbles:true})); await sleep(250);
            check("单章过滤展示空状态", !document.querySelector('[data-results] .comic-card') && !!document.querySelector('[data-results] .state'));
            click(innerWidth < 700 ? '[data-sheet-reset]' : '[data-filter-reset]'); await sleep(250); check("重置恢复列表", document.querySelectorAll('[data-results] .comic-card').length === 12);
            if (innerWidth < 700) click('[data-sheet="filters"] .sheet-close');
        } else if (page === "index") {
            check("随机与书架完整", !!document.querySelector('[data-random-open]').href && document.querySelectorAll('.shelf').length === 2);
            const id = document.querySelector('[data-random-id]').textContent; click('[data-random-prev]'); await sleep(80); check("随机历史可翻页", document.querySelector('[data-random-id]').textContent !== id);
        } else if (page === "latest") check("最新列表去重", document.querySelectorAll('[data-results] .comic-card').length === 12);
        else if (page === "setting") { click('#settings-reading [data-source="2"]'); check("图片线路可切换", document.querySelector('#settings-reading [data-source="2"]').getAttribute('aria-checked') === 'true'); click("[data-update-content-analysis]"); await sleep(80); check("设置不展示已完成项目", !document.querySelector("[data-analysis-list] details") && document.querySelector("[data-analysis-list]").textContent.includes("没有待处理")); }
        else if (page === "history-migration") check("历史迁移完成", document.querySelector('[data-migration-status]').textContent.includes('已合并'));
        check("操作后页面不横向溢出", document.documentElement.scrollWidth <= innerWidth + 1);
        check("无脚本异常或意外请求", !fixture.errors.length && !fixture.blockedRequests.length, JSON.stringify(fixture.errors));
    } catch (error) { check("交互检查完成", false, String(error)); }
    report.done = true;
    await nativeFetch("/__fixture__/report", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(report) });
    if (shellOnly) {
        const output = document.createElement('pre'); output.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;padding:24px;font:13px/1.8 monospace';
        output.textContent = report.checks.map((item) => `${item.passed ? 'PASS' : 'FAIL'} · ${item.name} ${item.detail}`).join('\n'); document.querySelector('.page').append(output);
    }
}
if (new URL(import.meta.url).searchParams.has("check")) runChecks(true);
else if (new URL(location.href).searchParams.has("verify")) runChecks();
