import { jmApi } from "../api/JmcomicApi.js";
import { authSession } from "../auth/AuthSession.js";
import { NavManager } from "../components/general/NavManager.js";
import { setting } from "../components/general/Setting.js";
import { SwitchServerBtnManager } from "../components/general/SwitchServerBtnManager.js";
import { showToast } from "../components/general/Toast.js";
import { libraryStore } from "../data/LibraryStore.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { renderPageError } from "../utils/PageError.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

class LibraryPage {
    view = "favorites";
    page = 1;
    folderId = "0";
    remoteItems = [];
    remoteTotal = 0;
    localRatings = [];
    ratingFilter = "all";
    remoteRequestVersion = 0;
    ratingsRequestVersion = 0;
    remoteRequests = new Set();

    async init() {
        setting.init();
        new NavManager().init();
        new SwitchServerBtnManager().init();
        this.grid = document.querySelector(".library-grid");
        this.notice = document.querySelector(".library-notice");
        this.folderTabs = document.querySelector(".folder-tabs");
        this.loadMoreButton = document.querySelector(".load-more");
        this.ratingFilters = document.querySelector(".rating-filters");
        this.bindEvents();
        const requestedView = new URLSearchParams(window.location.search).get("view");
        this.selectView(["favorites", "ratings", "history", "random"].includes(requestedView) ? requestedView : "favorites");
        try {
            await authSession.loadLocalConfig();
            this.render();
            if (authSession.isConfigured && this.view === "favorites") this.syncRemote();
        } catch (error) {
            this.notice.textContent = error.message || "请通过本地服务启动 WebUI";
            this.notice.classList.add("warning");
        }
    }

    bindEvents() {
        this.ratingFilters.addEventListener("click", (event) => {
            const button = event.target.closest("button[data-rating]");
            if (!button) return;
            this.ratingFilter = button.dataset.rating;
            this.render();
        });
        document.querySelectorAll(".library-tabs button").forEach((button) => {
            button.addEventListener("click", () => {
                this.selectView(button.dataset.view, { updateUrl: true });
            });
        });

        document.querySelector(".sync-btn").addEventListener("click", async () => {
            try {
                await authSession.loadLocalConfig();
            } catch (error) {
                this.notice.textContent = error.message || "请通过本地服务启动 WebUI";
                return;
            }
            if (!authSession.isConfigured) {
                document.querySelector(".account-trigger").click();
                return;
            }
            this.syncRemote();
        });
        document.querySelector(".clear-history").addEventListener("click", () => {
            if (this.view === "random") libraryStore.clearRandomHistory();
            else libraryStore.clearHistory();
            this.render();
            showToast(this.view === "random" ? "随机历史已清空" : "阅读历史已清空");
        });
        this.loadMoreButton.addEventListener("click", () => this.loadRemotePage(this.page + 1, true));
        this.grid.addEventListener("click", (event) => {
            if (event.target.closest(".login-library")) document.querySelector(".account-trigger").click();
        });
        window.addEventListener("jm-auth-change", () => {
            if (this.view === "favorites" && authSession.isConfigured && authSession.isLoggedIn && !this.#hasCurrentRemoteRequest() && !this.remoteItems.length) {
                this.syncRemote();
            } else if (!authSession.isConfigured) {
                this.remoteRequestVersion += 1;
                this.remoteItems = [];
                this.remoteTotal = 0;
                this.folderTabs.innerHTML = "";
                this.loadMoreButton.hidden = true;
                this.#syncRemoteButtons();
                this.render();
            }
        });
    }

    selectView(view, { updateUrl = false } = {}) {
        this.view = view;
        document.querySelectorAll(".library-tabs button").forEach((button) => {
            const active = button.dataset.view === view;
            button.classList.toggle("active", active);
            button.setAttribute("aria-selected", String(active));
        });
        document.querySelector(".sync-btn").hidden = view !== "favorites";
        const clearButton = document.querySelector(".clear-history");
        clearButton.hidden = !["history", "random"].includes(view);
        clearButton.textContent = view === "random" ? "清空随机历史" : "清空阅读历史";
        this.folderTabs.hidden = view !== "favorites";
        this.ratingFilters.hidden = view !== "ratings";
        this.loadMoreButton.hidden = view !== "favorites" || this.remoteItems.length >= this.remoteTotal;
        const labels = {
            favorites: `账号收藏 · ${this.remoteTotal || "—"}`,
            ratings: "本地评价",
            history: "最近阅读",
            random: `随机发现 · ${libraryStore.getRandomHistory().length}`,
        };
        document.querySelector(".sync-state").textContent = labels[view];
        this.notice.className = "library-notice";
        this.notice.textContent = view === "random" ? "这里保留主页验证通过的随机漫画，以及你为它们提交的兴趣反馈。" : "";
        if (updateUrl) {
            const url = new URL(window.location.href);
            url.searchParams.set("view", view);
            url.hash = "";
            window.history.replaceState({}, "", url);
        }
        this.render();
        if (view === "ratings") this.loadLocalRatings();
        if (view === "favorites" && authSession.isConfigured && !this.#hasCurrentRemoteRequest() && !this.remoteItems.length) {
            this.syncRemote();
        }
    }

    async syncRemote() {
        const version = ++this.remoteRequestVersion;
        this.page = 1;
        this.folderId = "0";
        this.remoteItems = [];
        const loaded = await this.loadRemotePage(1, false, { version, folderId: "0" });
        if (loaded && version === this.remoteRequestVersion) this.syncAllFavoritesToLocal(version);
    }

    async syncAllFavoritesToLocal(version = this.remoteRequestVersion) {
        try {
            const items = await jmApi.getAllFavorites();
            const result = await localRuntime.syncLocalFavorites(items.map((item) => ({
                id: item.id,
                title: item.name,
                authors: Array.isArray(item.author) ? item.author : (item.author ? [item.author] : []),
                tags: Array.isArray(item.tags) ? item.tags : [],
                cover_url: jmApi.getCoverImageURL(item.id),
            })));
            if (version === this.remoteRequestVersion && this.view === "favorites") this.notice.textContent = `账号收藏已同步，本地资料库更新 ${result.synced} 本。`;
        } catch (error) {
            if (version === this.remoteRequestVersion && this.view === "favorites") this.notice.textContent = error.message || "本地收藏资料同步失败";
        }
    }

    async loadLocalRatings() {
        const version = ++this.ratingsRequestVersion;
        if (this.view === "ratings") this.notice.textContent = "正在读取本地评价…";
        try {
            const result = await localRuntime.getLocalComics("rated");
            if (version !== this.ratingsRequestVersion || this.view !== "ratings") return;
            this.localRatings = result.comics || [];
            this.notice.textContent = `本地保存了 ${this.localRatings.length} 本评价。`;
            this.render();
        } catch (error) {
            if (version === this.ratingsRequestVersion && this.view === "ratings") {
                this.notice.textContent = error.message || "本地评价读取失败";
            }
        }
    }

    async loadRemotePage(page, append, {
        version = this.remoteRequestVersion,
        folderId = this.folderId,
    } = {}) {
        const requestKey = `${version}:${folderId}:${page}`;
        if (this.remoteRequests.has(requestKey)) return false;
        this.remoteRequests.add(requestKey);
        this.#syncRemoteButtons();
        if (version === this.remoteRequestVersion && this.view === "favorites") {
            this.notice.className = "library-notice";
            this.notice.textContent = "正在读取账号收藏…";
        }
        try {
            await jmApi.init();
            if (!authSession.isLoggedIn) await authSession.loginFromLocalConfig();
            const data = await jmApi.getFavorites(page, folderId, "mr");
            if (version !== this.remoteRequestVersion || String(folderId) !== String(this.folderId)) return false;
            const list = Array.isArray(data?.list) ? data.list : [];
            this.page = page;
            this.remoteTotal = Number(data?.total || list.length);
            this.remoteItems = append ? [...this.remoteItems, ...list] : list;
            this.renderFolders(data?.folder_list || []);
            if (this.view === "favorites") {
                document.querySelector(".sync-state").textContent = `账号收藏 · ${this.remoteTotal}`;
                this.notice.textContent = list.length ? "账号收藏已同步。" : "这个收藏夹暂时没有内容。";
                this.notice.classList.add("success");
                this.loadMoreButton.hidden = this.remoteItems.length >= this.remoteTotal;
                this.render();
            }
            return true;
        } catch (error) {
            if (version === this.remoteRequestVersion && String(folderId) === String(this.folderId) && this.view === "favorites") {
                this.notice.textContent = error.message || "账号收藏暂时无法读取，请检查本地账号配置。";
                this.notice.classList.add("warning");
                document.querySelector(".sync-state").textContent = "账号收藏";
                this.loadMoreButton.hidden = true;
                this.render();
            }
            return false;
        } finally {
            this.remoteRequests.delete(requestKey);
            this.#syncRemoteButtons();
        }
    }

    #hasCurrentRemoteRequest() {
        const prefix = `${this.remoteRequestVersion}:`;
        return [...this.remoteRequests].some((key) => key.startsWith(prefix));
    }

    #syncRemoteButtons() {
        const loading = this.#hasCurrentRemoteRequest();
        const syncButton = document.querySelector(".sync-btn");
        syncButton.disabled = loading;
        syncButton.textContent = loading ? "同步中…" : "同步账号收藏";
        this.loadMoreButton.disabled = loading;
    }

    renderFolders(folders) {
        const normalized = [{ FID: "0", name: "全部收藏" }, ...folders.filter((folder) => String(folder.FID) !== "0")];
        this.folderTabs.innerHTML = normalized.map((folder) => `
            <button class="${String(folder.FID) === String(this.folderId) ? "active" : ""}" data-id="${escapeHtml(folder.FID)}" type="button">${escapeHtml(folder.name)}</button>
        `).join("");
        this.folderTabs.querySelectorAll("button").forEach((button) => {
            button.addEventListener("click", () => {
                const version = ++this.remoteRequestVersion;
                this.folderId = button.dataset.id;
                this.page = 1;
                this.remoteItems = [];
                this.loadRemotePage(1, false, { version, folderId: this.folderId });
            });
        });
    }

    renderRatingFilters() {
        const options = [
            { value: "all", label: "全部评价", count: this.localRatings.length },
            ...Array.from({ length: 10 }, (_, index) => {
                const score = 10 - index;
                return { value: String(score), label: `${score} 分`, count: this.localRatings.filter((item) => Number(item.rating) === score).length };
            }),
            { value: "unrated", label: "未评分", count: this.localRatings.filter((item) => item.rating == null || item.rating === "").length },
        ];
        this.ratingFilters.innerHTML = options.map(({ value, label, count }) =>
            `<button type="button" data-rating="${value}" class="${this.ratingFilter === value ? "active" : ""}" aria-pressed="${this.ratingFilter === value}">${label}<span>${count}</span></button>`
        ).join("");
    }

    filteredRatings() {
        if (this.ratingFilter === "all") return this.localRatings;
        if (this.ratingFilter === "unrated") return this.localRatings.filter((item) => item.rating == null || item.rating === "");
        return this.localRatings.filter((item) => Number(item.rating) === Number(this.ratingFilter));
    }

    render() {
        if (this.view === "ratings") this.renderRatingFilters();
        const items = this.view === "random"
            ? libraryStore.getRandomHistory()
            : (this.view === "history" ? libraryStore.getHistory() : (this.view === "ratings" ? this.filteredRatings() : this.remoteItems));
        this.grid.classList.add("random-history-grid");
        if (this.view === "ratings") {
            document.querySelector(".sync-state").textContent = `本地评价 · ${items.length} 本`;
            if (!items.length && this.ratingFilter !== "all") {
                const label = this.ratingFilter === "unrated" ? "未评分" : `${this.ratingFilter} 分`;
                this.grid.innerHTML = `<div class="empty-library"><span>☆</span><h2>暂无${escapeHtml(label)}的漫画</h2><p>可以切换其他评分，或在漫画详情页保存评分后查看。</p></div>`;
                return;
            }
        }
        if (!items.length) {
            const favoriteCopy = authSession.isConfigured
                ? "这个账号还没有收藏内容。"
                : "配置账号密码后即可自动登录并同步收藏。";
            const isRatings = this.view === "ratings";
            const isRandom = this.view === "random";
            const action = this.view === "favorites" && !authSession.isConfigured
                ? '<button class="primary-btn login-library" type="button">配置账号</button>'
                : '<a class="primary-btn" href="./index.html">去发现作品</a>';
            this.grid.innerHTML = `<div class="empty-library"><span>${this.view === "favorites" ? "＋" : (isRatings ? "10" : "↺")}</span><h2>${this.view === "favorites" ? "账号收藏" : (isRatings ? "还没有本地评价" : (isRandom ? "还没有随机足迹" : "还没有阅读足迹"))}</h2><p>${this.view === "favorites" ? favoriteCopy : (isRatings ? "在漫画详情页评分、填写评语或设置标签偏好后会显示在这里。" : (isRandom ? "在主页点击“随机一本”，验证通过的作品会依次保存在这里。" : "开始阅读后，这里会记录最近打开的作品。"))}</p>${action}</div>`;
            return;
        }
        this.grid.innerHTML = items.map((item) => this.view === "random" ? this.randomHistoryItemHtml(item) : this.itemHtml(item)).join("");
    }

    itemHtml(item) {
        const author = Array.isArray(item.author) ? item.author.join(" & ") : item.author;
        const tagFeedback = item.tag_feedback && typeof item.tag_feedback === "object"
            ? Object.entries(item.tag_feedback)
            : [];
        const label = this.view === "history" && item.savedAt
            ? new Date(item.savedAt).toLocaleDateString("zh-CN")
            : (this.view === "ratings"
                ? (item.rating
                    ? `${item.rating} / 10`
                    : (item.review
                        ? "有评语"
                        : `${tagFeedback.length} 项标签反馈`))
                : "账号收藏");
        const review = this.view === "ratings" && item.review ? `<p class="local-review-copy">${escapeHtml(item.review)}</p>` : "";
        const feedback = this.view === "ratings" && tagFeedback.length
            ? `<div class="library-tag-feedback">${tagFeedback.slice(0, 8).map(([tag, sentiment]) => `<span data-sentiment="${Number(sentiment)}">${escapeHtml(tag)} · ${Number(sentiment) > 0 ? "喜欢" : (Number(sentiment) === -2 ? "屏蔽" : "回避")}</span>`).join("")}</div>`
            : "";
        const detailUrl = `./chapter.html?id=${encodeURIComponent(item.id)}&v=20260827-7`;
        return `<article class="random-history-item">
            <a class="random-history-cover" href="${detailUrl}"><img loading="lazy" src="${escapeHtml(item.cover_url || jmApi.getCoverImageURL(item.id))}" alt="${escapeHtml(item.name || item.title)}" /></a>
            <div class="random-history-copy"><small>${escapeHtml(label)}</small><h2><a href="${detailUrl}">${escapeHtml(item.name || item.title)}</a></h2><p>${escapeHtml(author || (item.authors || []).join(" & ") || "未知作者")}</p>${review}${feedback}</div>
        </article>`;
    }

    randomHistoryItemHtml(item) {
        const authors = Array.isArray(item.author) ? item.author : (Array.isArray(item.authors) ? item.authors : [item.author || item.authors].filter(Boolean));
        return `<article class="random-history-item" data-random-history-id="${escapeHtml(item.id)}">
            <a class="random-history-cover" href="./chapter.html?id=${encodeURIComponent(item.id)}&v=20260827-7"><img loading="lazy" src="${escapeHtml(item.cover_url || jmApi.getCoverImageURL(item.id))}" alt="${escapeHtml(item.name || item.title)}" /></a>
            <div class="random-history-copy"><small>RANDOM · ${escapeHtml(new Date(item.savedAt).toLocaleString("zh-CN"))}</small><h2><a href="./chapter.html?id=${encodeURIComponent(item.id)}&v=20260827-7">${escapeHtml(item.name || item.title)}</a></h2><p>${escapeHtml(authors.join(" & ") || "未知作者")}</p></div>
        </article>`;
    }

}

new LibraryPage().init().catch((error) => renderPageError(".library-grid", error, { title: "资料库加载失败" }));
