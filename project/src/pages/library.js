import { mountShell, openAccount } from "../ui/shell.js";
import { comicCardHtml } from "../ui/comic-card.js";
import { hydrateCovers } from "../ui/covers.js";
import { hydrateRichCards } from "../ui/rich-cards.js";
import { stateHtml } from "../ui/states.js";
import { confirmAction } from "../ui/confirm.js";
import { jmApi } from "../api/JmcomicApi.js";
import { authSession } from "../auth/AuthSession.js";
import { showToast } from "../ui/toast.js";
import { libraryStore } from "../data/LibraryStore.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { renderPageError } from "../ui/states.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

const CLEAR_LABELS = { history: "阅读历史", later: "稍后再看", random: "随机历史" };

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
        mountShell();
        this.grid = document.querySelector(".library-grid");
        this.notice = document.querySelector(".library-notice");
        this.folderTabs = document.querySelector(".folder-tabs");
        this.loadMoreButton = document.querySelector(".load-more");
        this.ratingFilters = document.querySelector(".rating-filters");
        this.bindEvents();
        window.addEventListener("jm-library-change", () => this.render());
        const requestedView = new URLSearchParams(window.location.search).get("view");
        this.selectView(["favorites", "ratings", "history", "later", "random"].includes(requestedView) ? requestedView : "favorites");
        try {
            await libraryStore.init();
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
                openAccount();
                return;
            }
            this.syncRemote();
        });
        document.querySelector(".clear-history").addEventListener("click", async (event) => {
            const button = event.currentTarget;
            const name = CLEAR_LABELS[this.view];
            if (!await confirmAction({ title: `清空${name}？`, message: "会清空本地服务中的对应列表，所有浏览器都会同步。评分与收藏不受影响。", label: "确认清空" })) return;
            button.disabled = true;
            try {
                if (this.view === "random") await libraryStore.clearRandomHistory();
                else if (this.view === "later") await libraryStore.clearWatchLater();
                else await libraryStore.clearHistory();
                this.render();
                showToast(`${name}已清空`);
            } catch (error) {
                showToast(error.message || "历史清空失败，请重试");
            } finally {
                button.disabled = false;
            }
        });
        this.loadMoreButton.addEventListener("click", () => this.loadRemotePage(this.page + 1, true));
        this.grid.addEventListener("click", (event) => {
            if (event.target.closest(".login-library")) openAccount();
        });
        window.addEventListener("jm-auth-change", () => {
            const key = authSession.isConfigured ? String(authSession.user?.uid || authSession.configuredUsername || "") : "";
            if (key === this.accountKey) return;
            this.accountKey = key;
            this.remoteRequestVersion += 1;
            this.remoteItems = [];
            this.remoteTotal = 0;
            this.folderTabs.replaceChildren();
            this.loadMoreButton.hidden = true;
            this.#syncRemoteButtons();
            this.render();
            if (key && this.view === "favorites") this.syncRemote();
        });
    }

    selectView(view, { updateUrl = false } = {}) {
        this.view = view;
        document.querySelectorAll(".library-tabs button").forEach((button) => {
            const active = button.dataset.view === view;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", String(active));
        });
        document.querySelector(".sync-btn").hidden = view !== "favorites";
        const clearButton = document.querySelector(".clear-history");
        clearButton.hidden = !CLEAR_LABELS[view];
        clearButton.textContent = `清空${CLEAR_LABELS[view] || "历史"}`;
        this.folderTabs.hidden = view !== "favorites";
        this.ratingFilters.hidden = view !== "ratings";
        this.loadMoreButton.hidden = view !== "favorites" || this.remoteItems.length >= this.remoteTotal;
        const labels = {
            favorites: `账号收藏 · ${this.remoteTotal || "—"}`,
            ratings: "本地评分",
            history: "最近阅读",
            later: "稍后再看",
            random: `随机发现 · ${libraryStore.getRandomHistory().length}`,
        };
        document.querySelector(".sync-state").textContent = labels[view];
        this.notice.className = "library-notice";
        this.notice.textContent = view === "random" ? "这里保留在发现页验证通过的随机作品。"
            : view === "later" ? "点卡片右上角的时钟按钮即可加入或移出稍后再看。" : "";
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
        await this.loadRemotePage(1, false, { version, folderId: "0" });
    }

    async loadLocalRatings() {
        const version = ++this.ratingsRequestVersion;
        if (this.view === "ratings") this.notice.textContent = "正在读取本地评分…";
        try {
            const ratings = await localRuntime.getRatings();
            if (version !== this.ratingsRequestVersion || this.view !== "ratings") return;
            this.localRatings = ratings;
            this.notice.textContent = `本地保存了 ${ratings.length} 本评分。`;
            this.render();
        } catch (error) {
            if (version === this.ratingsRequestVersion && this.view === "ratings") {
                this.notice.textContent = error.message || "本地评分读取失败";
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
                this.loadMoreButton.hidden = !list.length || this.remoteItems.length >= this.remoteTotal;
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
            { value: "all", label: "全部评分", count: this.localRatings.length },
            ...Array.from({ length: 10 }, (_, index) => {
                const score = 10 - index;
                return { value: String(score), label: `${score} 分`, count: this.localRatings.filter((item) => item.rating === score).length };
            }),
        ];
        this.ratingFilters.innerHTML = options.map(({ value, label, count }) =>
            `<button type="button" data-rating="${value}" class="${this.ratingFilter === value ? "active" : ""}" aria-pressed="${this.ratingFilter === value}">${label}<span>${count}</span></button>`
        ).join("");
    }

    filteredRatings() {
        if (this.ratingFilter === "all") return this.localRatings;
        return this.localRatings.filter((item) => item.rating === Number(this.ratingFilter));
    }

    render() {
        if (this.view === "ratings") this.renderRatingFilters();
        const items = this.view === "random" ? libraryStore.getRandomHistory() : this.view === "history" ? libraryStore.getHistory() : this.view === "later" ? libraryStore.getWatchLater() : this.view === "ratings" ? this.filteredRatings() : this.remoteItems;
        const names = { favorites: "账号收藏", ratings: "我的评分", history: "最近阅读", later: "稍后再看", random: "随机历史" };
        document.querySelector(".sync-state").textContent = `${names[this.view]} · ${items.length}`;
        if (!items.length) {
            const needsAccount = this.view === "favorites" && !authSession.isConfigured;
            this.grid.innerHTML = stateHtml({ title: needsAccount ? "连接你的收藏" : "这里暂时没有作品", message: needsAccount ? "配置账号后，同步收藏到书架。" : "开始阅读、给作品评分，或换一个筛选条件。", action: needsAccount ? { label: "配置账号", attrs: 'data-open-account' } : { label: "去发现", href: "./index.html" } });
            return;
        }
        this.grid.innerHTML = items.map((item) => comicCardHtml(item, {
            meta: this.view === "ratings" ? `我的评分 ${item.rating} / 10` : item.savedAt ? new Date(item.savedAt).toLocaleDateString("zh-CN") : "",
        })).join("");
        hydrateCovers(this.grid);
        hydrateRichCards(this.grid);
    }
}
new LibraryPage().init().catch((error) => renderPageError(".library-grid", error, { title: "书架加载失败" }));
