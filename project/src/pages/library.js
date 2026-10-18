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
import { icon } from "../ui/icons.js";
import { createFavoriteFolderSheet, pickFavoriteFolder } from "../ui/favorite-folders.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

const CLEAR_LABELS = { history: "阅读历史", later: "稍后再看", random: "随机历史" };

class LibraryPage {
    view = "favorites";
    page = 1;
    folderId = "0";
    folders = [];
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
            const move = event.target.closest("[data-folder-move]");
            if (move) this.moveToFolder(move);
        });
        this.folderTabs.addEventListener("click", (event) => {
            const button = event.target.closest("button");
            if (!button) return;
            if (button.dataset.folderAction === "add") this.createFolder();
            else if (button.dataset.folderAction === "delete") this.deleteFolder();
            else if (button.dataset.id !== undefined) this.openFolder(button.dataset.id);
        });
        window.addEventListener("jm-auth-change", () => {
            const key = authSession.isConfigured ? String(authSession.user?.uid || authSession.configuredUsername || "") : "";
            if (key === this.accountKey) return;
            this.accountKey = key;
            this.remoteRequestVersion += 1;
            this.remoteItems = [];
            this.remoteTotal = 0;
            this.folders = [];
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
        this.notice.textContent = "";
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
            this.notice.textContent = "";
            document.querySelector(".sync-state").textContent = `本地评分 · ${ratings.length}`;
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
                this.notice.textContent = "";
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
        this.folders = folders.filter((folder) => String(folder.FID) !== "0").map((folder) => ({ id: String(folder.FID), name: String(folder.name ?? "") }));
        this.#paintFolders();
    }

    #paintFolders() {
        const tabs = [{ id: "0", name: "全部收藏" }, ...this.folders];
        const current = this.folders.find((folder) => folder.id === String(this.folderId));
        this.folderTabs.innerHTML = tabs.map((folder) =>
            `<button class="chip" aria-pressed="${folder.id === String(this.folderId)}" data-id="${escapeHtml(folder.id)}" type="button">${escapeHtml(folder.name)}</button>`
        ).join("") + `<button class="chip folder-tool" data-folder-action="add" type="button">${icon("plus")}新建收藏夹</button>`
            + (current ? `<button class="chip folder-tool" data-folder-action="delete" type="button">${icon("trash")}删除「${escapeHtml(current.name)}」</button>` : "");
    }

    openFolder(folderId) {
        const version = ++this.remoteRequestVersion;
        this.folderId = String(folderId);
        this.page = 1;
        this.remoteItems = [];
        this.#paintFolders();
        return this.loadRemotePage(1, false, { version, folderId: this.folderId });
    }

    async createFolder() {
        const folders = await createFavoriteFolderSheet();
        if (!folders) return;
        this.folders = folders;
        this.#paintFolders();
    }

    async deleteFolder() {
        const folder = this.folders.find((item) => item.id === String(this.folderId));
        if (!folder) return;
        if (!await confirmAction({ title: `删除收藏夹「${folder.name}」？`, message: "会删除 JM 账号里的这个收藏夹，操作不可撤销。", label: "确认删除" })) return;
        try {
            await jmApi.deleteFavoriteFolder(folder.id);
            this.folders = this.folders.filter((item) => item.id !== folder.id);
            showToast(`已删除收藏夹「${folder.name}」`);
            this.openFolder("0");
        } catch (error) {
            showToast(error.message || "删除收藏夹失败", "warning");
        }
    }

    async moveToFolder(button) {
        const albumId = button.dataset.folderMove;
        const target = await pickFavoriteFolder({ title: "移动到收藏夹", folders: this.folders, currentId: this.folderId === "0" ? "" : this.folderId });
        // The picker may have created a folder; keep the tabs in step with it.
        if (jmApi.favoriteFolders) { this.folders = jmApi.favoriteFolders; this.#paintFolders(); }
        if (target === null || target === String(this.folderId)) return;
        button.disabled = true;
        try {
            await jmApi.moveFavoriteToFolder(albumId, target);
            const name = target === "0" ? "默认收藏夹" : this.folders.find((folder) => folder.id === target)?.name || "收藏夹";
            showToast(`已移到「${name}」`);
            if (this.folderId !== "0") {
                this.remoteItems = this.remoteItems.filter((item) => String(item?.id) !== String(albumId));
                this.remoteTotal = Math.max(0, this.remoteTotal - 1);
                this.render();
            }
        } catch (error) {
            showToast(error.message || "移动收藏夹失败", "warning");
        } finally {
            button.disabled = false;
        }
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
            `<button type="button" data-rating="${value}" class="chip" aria-pressed="${this.ratingFilter === value}">${label}<span>${count}</span></button>`
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
            this.grid.innerHTML = stateHtml({ title: needsAccount ? "连接你的收藏" : "这里暂时没有作品", message: needsAccount ? "配置账号后，同步收藏到书架。" : "", action: needsAccount ? { label: "配置账号", attrs: 'data-open-account' } : { label: "去发现", href: "./index.html" } });
            return;
        }
        this.grid.innerHTML = items.map((item) => comicCardHtml(item, {
            meta: this.view === "ratings" ? `我的评分 ${item.rating} / 10` : item.savedAt ? new Date(item.savedAt).toLocaleDateString("zh-CN") : "",
            footer: this.view === "favorites" && item?.id ? `<button class="card-folder-move" type="button" data-folder-move="${escapeHtml(item.id)}">${icon("folder")}<span>移动收藏夹</span></button>` : "",
        })).join("");
        hydrateCovers(this.grid);
        hydrateRichCards(this.grid);
    }
}
new LibraryPage().init().catch((error) => renderPageError(".library-grid", error, { title: "书架加载失败" }));
