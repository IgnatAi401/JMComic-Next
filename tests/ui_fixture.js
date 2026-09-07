/* Local-only visual fixture. Real page/component modules run against these fakes. */
const page = new URL(import.meta.url).searchParams.get("page") || "index";
const allowedPages = new Set(["index", "setting", "messages", "reader", "chapter", "ai", "library", "search", "latest", "categories"]);
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
const recommendations = comics.slice(0, 4).map((item, index) => ({ ...item, title: item.name, authors: item.author, score: 8.8 - index * .4, reason: "自然题材与日常观察符合示例偏好，叙事轻松，适合继续阅读。", score_breakdown: { tags: .8, author: .6, novelty: .4 } }));
const run = { id: 1, status: "success", created_at: stamp, recommendations, raw_outputs: [{ stage: "fixture", output: "中性虚构模型输出，用于检查长文本和弹窗布局。" }] };
const user = { uid: "1", username: "本地测试", level_name: "体验用户" };
const account = { configured: true, authenticated: true, username: user.username, user };
const memory = new Map();
let settings = { image_load_batch_size: 5 };

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
    getCachedChapterImageURL: (_id, path) => cover(parseInt(path, 10), true),
    getChapterImageURL: (_id, path) => cover(parseInt(path, 10), true),
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
    updateFavoriteState: async (_id, saved) => ({ saved }), toggleLike: constant({ liked: true }),
    getAlbumTrackingState: constant(false), toggleAlbumTracking: constant({ tracked: true }),
    dailyCheckIn: constant({ message: "示例签到成功" }), getDailyCheckInStatus: constant({ checked: false }),
    getUnreadNotificationCount: constant(2), markNotification: constant({ saved: true }),
    getNotifications: constant({ total: 3, list: [{ id: 1, title: "阅读记录已同步", content: "这是一条虚构通知，用于检查已读状态与长文本排版。", read: false, date: "2026-09-05" }, { id: 2, title: "示例连载更新", content: "旅途手记更新了一个新章节，可以从右侧追踪列表继续阅读。", read: false, date: "2026-09-04" }, { id: 3, title: "欢迎回来", content: "所有内容均来自本机测试数据。", read: true, date: "2026-09-03" }] }),
    getAlbumTrackingList: constant({ item: comics.slice(0, 4), totalCnt: 4 }),
});
Object.assign(localRuntime, {
    getAccountSummary: constant(account), loginAccount: constant(user), ensureAccountSession: constant(user),
    getSettings: async () => ({ ...settings }), saveSettings: async (value) => (settings = { ...settings, ...value }),
    getAiConfig: constant({ configured: true, model: "fixture-model", base_url: "https://example.invalid/v1", api_key_configured: true, use_ai_translation: true }),
    getEmbeddingConfig: constant({ configured: true, model: "fixture-embedding", api_key_configured: true, dimension: 1024 }),
    getEmbeddingStatus: constant({ available: true, model: "fixture-embedding", dimension: 1024 }),
    testAiConfig: constant({ success: true }), testEmbeddingConfig: constant({ success: true }),
    translateTitleWithAi: async (title) => ({ translated: title, translation: title, title }),
    getLocalComic: async (id) => ({ comic: memory.get(String(id)) || null }),
    saveLocalComic: async (value) => { memory.set(String(value.id), clone(value)); return { comic: clone(value), saved: true }; },
    getLocalComics: async () => ({ comics: [...memory.values()] }), getComicFeedbackStates: constant({ states: {} }),
    syncLocalFavorites: constant({ synced: 6 }),
    getAiProfile: constant({ stats: { favorites: 6, rated: 12, tag_feedback: 18, interactions: 48 }, profile }), generateAiProfile: constant({ profile }),
    getRecommendedIds: constant({ ids: [] }), getDiscoveryExcludedIds: constant({ ids: [] }),
    getRecommendationHistory: constant({ runs: [run] }), generateRecommendations: constant(run),
    saveRecommendationFeedback: constant({ saved: true, state: 1 }), recordInteraction: constant({ saved: true }),
    cacheChapterImages: constant({ queued: true }), cancelChapterImages: () => true,
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
let randomHistory = comics.slice(0, 5).map((item) => ({ ...item, savedAt: stamp * 1000 }));
Object.assign(libraryStore, {
    getHistory: () => clone(comics.slice(0, 5)), recordHistory() {}, clearHistory() {},
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

if (new URL(import.meta.url).searchParams.has("check")) {
    const { showToast } = await import("/src/components/general/Toast.js");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const main = document.querySelector("main");
    main.replaceChildren();
    const heading = document.createElement("h1");
    heading.textContent = "Safari 本机界面检查";
    const output = document.createElement("pre");
    output.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.8 monospace;padding:20px;border:1px solid #555;border-radius:14px;background:#111";
    main.append(heading, output);
    const report = { page: "ui-check", viewport: { width: innerWidth, height: innerHeight }, checks: [], errors: fixture.errors, blockedRequests: fixture.blockedRequests };
    const check = (name, passed, detail = "") => {
        report.checks.push({ name, passed: Boolean(passed), detail });
        output.textContent = report.checks.map((item) => `${item.passed ? "PASS" : "FAIL"} · ${item.name}${item.detail ? ` · ${item.detail}` : ""}`).join("\n");
    };
    try {
        await sleep(160);
        const bodyStyle = document.body.style.cssText;
        document.querySelector(".nav .account-trigger").click();
        await sleep(160);
        const modal = document.querySelector(".auth-modal");
        const panel = modal.querySelector(".auth-panel");
        check("账号配置框打开并锁定页面滚动", modal.classList.contains("show") && document.body.style.overflow === "hidden");
        modal.querySelector(".auth-error").textContent = `示例错误：https://example.invalid/${"very-long-fixture-token-".repeat(28)}`;
        modal.querySelector(".llm-config-section").open = true;
        await sleep(160);
        const rect = panel.getBoundingClientRect();
        check("配置框长文本不横向溢出且处于视口内", panel.scrollWidth <= panel.clientWidth + 1 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight + 1, `${Math.round(rect.width)} × ${Math.round(rect.height)}`);
        document.querySelector(".page-list-btn").click();
        modal.querySelector(".modal-close").click();
        check("抽屉与配置框重叠时保持滚动锁定", document.body.style.overflow === "hidden");
        document.querySelector(".drawer-close").click();
        check("关闭全部浮层恢复原 body 样式", document.body.style.cssText === bodyStyle);
        showToast(`示例提示：https://example.invalid/${"long-message-".repeat(160)}`, "warning");
        await sleep(160);
        const toast = document.querySelector(".toast");
        const region = document.querySelector(".toast-region");
        const box = region.getBoundingClientRect();
        check("超长 Toast 保持视口内并可换行", toast.scrollWidth <= toast.clientWidth + 1 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight + 1, `${Math.round(box.width)} × ${Math.round(box.height)}`);
        await sleep(3650);
        check("Toast 自动清理", !document.querySelector(".toast"));
        check("无页面脚本错误及意外网络请求", fixture.errors.length === 0 && fixture.blockedRequests.length === 0);
    } catch (error) {
        check("检查脚本完成", false, String(error));
    }
    await nativeFetch("/__fixture__/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
    output.textContent += "\n\n报告已保存到本机临时目录：jmcomic-ui-fixture-report.json";
}
