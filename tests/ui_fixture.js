/* Local-only visual fixture. Real page/component modules run against these fakes. */
const page = new URL(import.meta.url).searchParams.get("page") || "index";
const allowedPages = new Set(["index", "setting", "messages", "reader", "chapter", "library", "search", "latest", "categories", "history-migration"]);
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
    tags: Number(id) % 2 ? ["旅行", "日常", "自然", "短篇", "海岸线", "山间小路", "夜行列车", "图书馆", "城市观察", "雨天", "旅途手记", "长篇连载", "季节变化", "风景速写", "港口", "灯塔", "晨雾", "溪流", "老街", "书店", "车站", "黄昏", "星空", "远行"] : ["旅行", "日常", "自然", "短篇"], actors: ["旅人"], works: ["风景手记"], related_list: [],
    description: "这是一份完全虚构的界面测试资料。旅人沿着海岸与山间小路，记录日常生活里温柔而细小的发现，用于检查标题、简介、评分与阅读布局。",
    series: clone(series), chapters: 3, total_photos: 6, total_views: 12580, likes: 328, comment_total: 2,
    addtime: stamp, update_at: stamp, cover_url: cover(id), liked: false, is_favorite: false,
});
const comics = Array.from({ length: 12 }, (_, index) => album(100100 + index));
const categories = [{ type: "slug", slug: "daily", name: "日常", sub_categories: [{ CID: "11", slug: "travel", name: "旅行" }, { CID: "12", slug: "nature", name: "自然" }] }, { type: "slug", slug: "short", name: "短篇", sub_categories: [] }];
const user = { uid: "1", username: "本地测试", level_name: "体验用户" };
const account = { configured: true, authenticated: true, username: user.username, user };
const ratings = new Map(comics.slice(0, 3).map((item, i) => [item.id, { id: item.id, title: item.name, authors: item.author, cover_url: item.cover_url, rating: 8 - i }]));
let searchHistory = [{ query: "旅行", savedAt: stamp * 1000 }, { query: "山间来信", savedAt: stamp * 1000 - 1 }];
let preferences = { tags: { "旅行": "like", "自然": "fond", "短篇": "avoid", "日常": "dislike" }, authors: { "示例作者": "like", "观察工作室": "dislike" } };

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
    getFavorites: constant({ list: comics.slice(0, 6), total: 6, folder_list: [{ FID: "0", name: "全部收藏" }] }),
    getFavoriteIds: async () => new Set(), getFavoriteState: constant(false), getLikeState: constant(false),
    updateFavoriteState: async (_id, saved) => ({ saved }), toggleLike: constant({ liked: true }), setLikeState() {},
    getAlbumTrackingState: constant(false), toggleAlbumTracking: constant({ tracked: true }),
    dailyCheckIn: constant({ status: "success", message: "示例签到成功" }), getDailyCheckInStatus: constant({ checked: false }),
    getUnreadNotificationCount: constant(2), markNotification: constant({ saved: true }),
    getNotifications: constant({ total: 3, list: [{ id: 1, title: "阅读记录已同步", content: "这是一条虚构通知，用于检查已读状态与长文本排版。", read: false, date: "2026-09-05" }, { id: 2, title: "示例连载更新", content: "旅途手记更新了一个新章节，可以从右侧追踪列表继续阅读。", read: false, date: "2026-09-04" }, { id: 3, title: "欢迎回来", content: "所有内容均来自本机测试数据。", read: true, date: "2026-09-03" }] }),
    getAlbumTrackingList: constant({ item: comics.slice(0, 4), totalCnt: 4 }),
});
const fixtureCache = new Map();
Object.assign(localRuntime, {
    getAccountSummary: constant(account), loginAccount: constant(user), ensureAccountSession: constant(user),
    getTranslationConfig: constant({ configured: true, model: "fixture-model", base_url: "https://example.invalid/v1", api_key_masked: "sk-…test", use_ai_translation: true }),
    testTranslationConfig: constant({ ok: true, model: "fixture-model" }),
    translateTitle: async (title) => ({ translation: `${title}（译）`, model: "fixture-model" }),
    // Groups only the first 8 so the trailing "未整理" section is exercised too.
    organizeComics: async (items) => ({ model: "fixture-model", groups: [
        { title: "示例系列上篇", items: items.slice(0, 5).map((item, index) => ({ id: item.id, note: `第 ${index + 1} 话` })) },
        { title: "其他", items: items.slice(5, 8).map((item) => ({ id: item.id, note: "" })) },
    ] }),
    getRating: async (id) => clone(ratings.get(String(id)) ?? null),
    getRatings: async () => clone([...ratings.values()]),
    saveRating: async (value) => {
        if (value.rating === null) { ratings.delete(String(value.id)); return null; }
        ratings.set(String(value.id), clone(value)); return clone(value);
    },
    getPreferences: async () => clone(preferences),
    savePreference: async ({ kind, name, level, previous }) => {
        const group = { ...preferences[`${kind}s`] };
        if (previous && previous !== name) delete group[previous];
        if (level === null) delete group[name]; else group[name] = level;
        preferences = { ...preferences, [`${kind}s`]: group };
        return clone(preferences);
    },
    getSearchHistory: async () => clone(searchHistory),
    recordSearch: async (query) => { searchHistory = [{ query, savedAt: Date.now() }, ...searchHistory.filter((item) => item.query !== query)]; return clone(searchHistory); },
    removeSearchHistory: async (query) => { searchHistory = query == null ? [] : searchHistory.filter((item) => item.query !== query); return clone(searchHistory); },
    readCache: async (kind, key) => clone(fixtureCache.get(`${kind}/${key}`) ?? null),
    writeCache: async (kind, key, data) => { if (kind === "organize") fixtureCache.set(`${kind}/${key}`, clone(data)); }, getWebChapterNames: constant({ chapters: series }),
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
let watchLater = comics.slice(6, 9).map((item) => ({ ...item, savedAt: stamp * 1000 }));
const libraryChanged = () => window.dispatchEvent(new CustomEvent("jm-library-change"));
Object.assign(libraryStore, {
    init: async () => {},
    getHistory: () => clone(readingHistory), async recordHistory() {}, async clearHistory() { readingHistory = []; },
    getRandomHistory: () => clone(randomHistory),
    recordRandomHistory: (item) => { randomHistory = [item, ...randomHistory.filter((old) => old.id !== item.id)].slice(0, 20); return item; },
    clearRandomHistory: () => { randomHistory = []; },
    getWatchLater: () => clone(watchLater),
    isWatchLater: (id) => watchLater.some((item) => String(item.id) === String(id)),
    addWatchLater: async (item) => { watchLater = [{ ...item, savedAt: Date.now() }, ...watchLater.filter((old) => old.id !== item.id)]; libraryChanged(); },
    removeWatchLater: async (id) => { watchLater = watchLater.filter((item) => String(item.id) !== String(id)); libraryChanged(); },
    clearWatchLater: async () => { watchLater = []; libraryChanged(); },
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
            check("菜单覆盖全屏且导航完整", toggle.getAttribute("aria-expanded") === "true" && menu.querySelectorAll("a").length === 6 && Math.abs(panel.left) < 1 && Math.abs(panel.width - innerWidth) < 1 && panel.height >= innerHeight - 1 && document.body.style.position === "fixed", JSON.stringify({left: panel.left, width: panel.width, height: panel.height, viewport: [innerWidth, innerHeight], position: document.body.style.position}));
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
            sheet.querySelector('[data-block="translation"]').open = true;
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
            for (let wait = 0; wait < 40 && document.querySelectorAll('.preview-page[data-state="ready"] canvas').length < 3; wait++) await sleep(50);
            const previews = [...document.querySelectorAll('.preview-page')];
            check("详情页三页预览已还原", previews.length === 3 && previews.every((tile) => tile.dataset.state === "ready" && tile.querySelector('canvas')?.width > 0), previews.map((tile) => tile.dataset.state).join());
            check("预览跳转到对应页", previews.map((tile) => new URL(tile.href).searchParams.get('page')).join() === "2,4,5");
            check("详情标签按偏好着色", !!document.querySelector('.detail-tags .tag[data-preference="like"]'));
            check("详情作者按偏好着色", !!document.querySelector('.detail-authors .author-name[data-preference="like"]') && !!document.querySelector('.detail-authors .author-name[data-preference="dislike"]'));
            check("详情页不再有兴趣反馈与评语", !document.querySelector('[data-interest], .rating-editor textarea, [data-summary-text]'));
            click('.rating-editor [data-score="9"]'); await sleep(100);
            check("评分点选即保存", (await localRuntime.getRating('100100'))?.rating === 9 && document.querySelector('.rating-editor [data-score="9"]').getAttribute('aria-pressed') === 'true');
            click('[data-translate]'); await sleep(80);
            check("标题翻译可切换", document.querySelector('[data-translate]').getAttribute('aria-pressed') === 'true');
            const later = document.querySelector('.detail-actions [data-watch-later]');
            click('.detail-actions [data-watch-later]'); await sleep(80);
            check("详情页可加入稍后再看", libraryStore.isWatchLater('100100') && later.getAttribute('aria-pressed') === 'true');
            click('.detail-actions [data-watch-later]'); await sleep(80);
            check("详情页可移出稍后再看", !libraryStore.isWatchLater('100100') && later.getAttribute('aria-pressed') === 'false');
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
            check("阅读页保留评分", !!document.querySelector('.reader-rating [data-score="10"]'));
        } else if (page === "library") {
            click('[data-view="ratings"]'); await sleep(100); check("读取本地评价", document.querySelectorAll('.library-grid .comic-card').length === 3);
            click('[data-rating="8"]'); check("评分筛选准确", document.querySelectorAll('.library-grid .comic-card').length === 1);
            click('[data-view="history"]'); check("阅读历史可见", document.querySelectorAll('.library-grid .comic-card').length === 5);
            click('[data-view="later"]'); check("稍后再看可见", document.querySelectorAll('.library-grid .comic-card').length === 3 && [...document.querySelectorAll('.library-grid .later-toggle')].every((button) => button.getAttribute('aria-pressed') === 'true'));
            click('.library-grid .later-toggle'); await sleep(80); check("书架卡片可移出稍后再看", document.querySelectorAll('.library-grid .comic-card').length === 2);
            click('[data-view="random"]'); check("随机历史可见", document.querySelectorAll('.library-grid .comic-card').length === 5);
            click('[data-view="favorites"]'); await sleep(100); check("账号收藏可见", document.querySelectorAll('.library-grid .comic-card').length === 6);
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
            if (page === "search") {
                const input = document.querySelector('.listing-search input'); input.value = ""; input.focus(); input.dispatchEvent(new Event('input')); await sleep(50);
                const pop = document.querySelector('.listing-search .search-history-pop');
                const arrived = new URLSearchParams(location.search).get("sq");
                check("进入搜索页即记录关键词", !arrived || (await localRuntime.getSearchHistory())[0]?.query === arrived);
                const before = pop.querySelectorAll('[data-history-pick]').length;
                check("搜索框显示搜索记录", !pop.hidden && before >= 2);
                click('[data-history-remove="山间来信"]', pop); await sleep(50);
                check("可删除单条搜索记录", (await localRuntime.getSearchHistory()).length === before - 1 && pop.querySelectorAll('[data-history-pick]').length === before - 1);
                input.value = "不存在"; input.dispatchEvent(new Event('input')); check("搜索记录按输入筛选", pop.hidden);
                input.blur(); await sleep(250); input.value = "";
                click('[data-organize]'); await sleep(150);
                const organized = document.querySelector('[data-organized]');
                check("AI 整理分栏显示", organized.querySelectorAll('.organized-group:not([hidden])').length === 3 && organized.querySelectorAll('.comic-card').length === 12 && document.querySelector('[data-results]').hidden);
                check("整理备注显示在卡片上", organized.querySelector('.rich-note')?.textContent === "第 1 话");
                check("未覆盖作品进入未整理栏目", organized.querySelectorAll('[data-unorganized] .comic-card').length === 4 && !document.querySelector('[data-feed]').hidden);
                click('[data-reorganize]', organized); await sleep(150);
                check("可重新整理", !document.querySelector('[data-organized]').hidden && !!document.querySelector('[data-organized] [data-reorganize]'));
                click('[data-organize]'); check("可返回原始列表", document.querySelector('[data-organized]').hidden && !document.querySelector('[data-results]').hidden);
                const serial = document.querySelector('[data-hide-serial]');
                serial.checked = true; serial.dispatchEvent(new Event('change', { bubbles: true })); await sleep(250);
                serial.checked = false; serial.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300);
                check("同一关键词自动使用整理缓存", !document.querySelector('[data-organized]').hidden && document.querySelectorAll('[data-organized] .organized-group:not([hidden]) .comic-card').length === 12);
            }
        } else if (page === "index") {
            check("随机与书架完整", !!document.querySelector('[data-random-open]').href && document.querySelectorAll('.shelf').length === 2);
            check("书架卡片在可见前不请求资料", document.querySelector('.shelf:last-child .rich-card').dataset.details === "pending");
            document.querySelector('.shelf .rich-card').scrollIntoView({ block: "center" });
            for (let wait = 0; wait < 40 && !document.querySelector('.rich-card[data-details="ready"]'); wait++) await sleep(50);
            const richCard = document.querySelector('.rich-card[data-details="ready"]');
            check("书架大卡片显示统计", !!richCard && richCard.querySelector('[data-detail="views"]').textContent === "1.3万" && richCard.querySelector('[data-detail="pages"]').textContent === "6");
            check("卡片标签按偏好着色并附说明", !!richCard?.querySelector('.tag[data-preference="like"]') && !!richCard?.querySelector('.tag[data-preference="dislike"]') && !!richCard?.querySelector('.author-name[data-preference="like"]') && !!document.querySelector('.shelves > .tag-legend'));
            const tagRows = [...document.querySelectorAll('.rich-card[data-details="ready"] .rich-tags')].map((list) => new Set([...list.children].filter((tag) => !tag.hidden).map((tag) => tag.offsetTop)).size);
            check("卡片标签最多两行", tagRows.length > 1 && tagRows.every((rows) => rows <= 2), tagRows.join());
            const longTags = document.querySelector('.rich-card[data-comic-id="100101"][data-details="ready"] .rich-tags');
            check("超出两行的标签折叠为计数", !!longTags?.querySelector('.tag-more') && [...longTags.children].some((tag) => tag.hidden));
            const firstCard = document.querySelector('.rich-card');
            check("标签横跨整张卡片", Math.abs(firstCard.querySelector('.rich-tags').getBoundingClientRect().left - firstCard.querySelector('.cover').getBoundingClientRect().left) < 1);
            const side = [...document.querySelectorAll('.home-side > .continue')];
            check("稍后再看位于继续阅读上方", side[0]?.classList.contains('later') && !side[0].hidden && side[0].querySelectorAll('.later-item').length === 3 && !side[1].hidden);
            check("卡片作者为搜索链接", !!richCard?.querySelector('.comic-meta a.author-name[href*="search.html?sq="]') && !!document.querySelector('.continue-meta a.author-name'));
            const shelfCard = document.querySelector('.shelf .rich-card[data-comic-id="100100"]');
            click('.later-toggle', shelfCard); await sleep(80);
            check("卡片可加入稍后再看", document.querySelectorAll('.later-item').length === 4 && shelfCard.querySelector('.later-toggle').getAttribute('aria-pressed') === 'true');
            click('.later-item [data-later-remove]'); await sleep(80);
            check("首页可移除稍后再看", document.querySelectorAll('.later-item').length === 3 && shelfCard.querySelector('.later-toggle').getAttribute('aria-pressed') === 'false');
            check("随机作品标签按偏好着色", !!document.querySelector('[data-random-tags] .tag[data-preference="avoid"]'));
            const id = document.querySelector('[data-random-id]').textContent; click('[data-random-prev]'); await sleep(80); check("随机历史可翻页", document.querySelector('[data-random-id]').textContent !== id);
        } else if (page === "latest") check("最新列表去重", document.querySelectorAll('[data-results] .comic-card').length === 12);
        else if (page === "setting") {
            click('#settings-reading [data-source="2"]'); check("图片线路可切换", document.querySelector('#settings-reading [data-source="2"]').getAttribute('aria-checked') === 'true');
            await sleep(50);
            const tags = document.querySelector('#settings-tag-preferences');
            check("标签偏好按四类分组", tags.querySelectorAll('.preference-group').length === 4 && tags.querySelectorAll('.preference-chip').length === 4);
            check("作者偏好只有喜欢与不喜欢", document.querySelectorAll('#settings-author-preferences .preference-group').length === 2);
            tags.querySelector('input[name="name"]').value = '港口'; click('[data-level="fond"]', tags); click('[data-preference-submit]', tags); await sleep(50);
            check("可新增标签", (await localRuntime.getPreferences()).tags['港口'] === 'fond' && !!tags.querySelector('[data-edit="港口"]'));
            click('[data-edit="港口"]', tags); tags.querySelector('input[name="name"]').value = '灯塔'; click('[data-level="dislike"]', tags); click('[data-preference-submit]', tags); await sleep(50);
            const renamed = (await localRuntime.getPreferences()).tags;
            check("可编辑标签名称与分类", renamed['灯塔'] === 'dislike' && !('港口' in renamed));
            click('[data-remove="灯塔"]', tags); await sleep(50);
            check("可删除标签", !('灯塔' in (await localRuntime.getPreferences()).tags) && !tags.querySelector('[data-edit="灯塔"]'));
        }
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
