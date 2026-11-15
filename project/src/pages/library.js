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
import { ActionMenu } from "../ui/action-menu.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

const CLEAR_LABELS = { history: "阅读历史", later: "稍后再看", random: "随机历史" };
const EMPTY_TITLES = { favorites: "收藏夹是空的", ratings: "还没有评分", history: "还没有阅读记录", later: "没有稍后再看的作品", random: "还没有随机记录" };

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
        this.folderSelect = document.querySelector(".folder-select");
        this.loadMoreButton = document.querySelector(".load-more");
        this.ratingSelect = document.querySelector(".rating-select");
        this.syncButton = document.querySelector(".sync-btn");
        this.syncButton.innerHTML = icon("refresh");
        this.menu = new ActionMenu();
        document.querySelector(".toolbar-actions").append(this.menu.root);
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
            this.setNotice(error.message || "请通过本地服务启动", true);
        }
    }

    bindEvents() {
        this.ratingSelect.addEventListener("change", () => {
            this.ratingFilter = this.ratingSelect.value;
            this.render();
        });
        this.folderSelect.addEventListener("change", () => this.openFolder(this.folderSelect.value));
        document.querySelectorAll(".library-tabs button").forEach((button) => {
            button.addEventListener("click", () => {
                this.selectView(button.dataset.view, { updateUrl: true });
            });
        });

        this.syncButton.addEventListener("click", async () => {
            try {
                await authSession.loadLocalConfig();
            } catch (error) {
                this.setNotice(error.message || "请通过本地服务启动", true);
                return;
            }
            if (!authSession.isConfigured) {
                openAccount();
                return;
            }
            this.syncRemote();
        });
        this.loadMoreButton.addEventListener("click", () => this.loadRemotePage(this.page + 1, true));
        this.grid.addEventListener("click", (event) => {
            if (event.target.closest(".login-library")) openAccount();
            const move = event.target.closest("[data-folder-move]");
            if (move) this.moveToFolder(move);
        });
        window.addEventListener("jm-auth-change", () => {
            const key = authSession.isConfigured ? String(authSession.user?.uid || authSession.configuredUsername || "") : "";
            if (key === this.accountKey) return;
            this.accountKey = key;
            this.remoteRequestVersion += 1;
            this.remoteItems = [];
            this.remoteTotal = 0;
            this.folders = [];
            this.folderId = "0";
            this.#paintFolders();
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
        this.syncButton.hidden = view !== "favorites";
        this.folderSelect.hidden = view !== "favorites" || !this.folders.length;
        this.ratingSelect.hidden = view !== "ratings";
        this.loadMoreButton.hidden = view !== "favorites" || this.remoteItems.length >= this.remoteTotal;
        this.noticeText = "";
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
        if (this.view === "ratings") this.setNotice("读取中…");
        try {
            const ratings = await localRuntime.getRatings();
            if (version !== this.ratingsRequestVersion || this.view !== "ratings") return;
            this.localRatings = ratings;
            this.noticeText = "";
            this.render();
        } catch (error) {
            if (version === this.ratingsRequestVersion && this.view === "ratings") {
                this.setNotice(error.message || "评分读取失败", true);
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
            this.setNotice("读取中…");
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
                this.noticeText = "";
                this.loadMoreButton.hidden = !list.length || this.remoteItems.length >= this.remoteTotal;
                this.render();
            }
            return true;
        } catch (error) {
            if (version === this.remoteRequestVersion && String(folderId) === String(this.folderId) && this.view === "favorites") {
                this.loadMoreButton.hidden = true;
                this.render();
                this.setNotice(error.message || "收藏读取失败，请检查账号", true);
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
        this.syncButton.disabled = loading;
        this.syncButton.classList.toggle("is-spinning", loading);
        this.loadMoreButton.disabled = loading;
    }

    renderFolders(folders) {
        this.folders = folders.filter((folder) => String(folder.FID) !== "0").map((folder) => ({ id: String(folder.FID), name: String(folder.name ?? "") }));
        this.#paintFolders();
    }

    /** 收藏夹下拉框：只有一个默认收藏夹时不显示。 */
    #paintFolders() {
        const options = [{ id: "0", name: "全部收藏" }, ...this.folders];
        this.folderSelect.innerHTML = options.map((folder) => `<option value="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</option>`).join("");
        this.folderSelect.value = String(this.folderId);
        this.folderSelect.hidden = this.view !== "favorites" || !this.folders.length;
        this.#paintMenu();
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
        if (!await confirmAction({ title: `删除收藏夹「${folder.name}」？`, message: "JM 账号里的这个收藏夹会被删除，无法撤销。", label: "删除" })) return;
        try {
            await jmApi.deleteFavoriteFolder(folder.id);
            this.folders = this.folders.filter((item) => item.id !== folder.id);
            showToast("已删除");
            this.openFolder("0");
        } catch (error) {
            showToast(error.message || "删除失败", "warning");
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
            showToast(error.message || "移动失败", "warning");
        } finally {
            button.disabled = false;
        }
    }

    /** ⋯ 菜单里的操作随视图变化：收藏页管理收藏夹，历史类列表可以清空。 */
    #paintMenu(count = null) {
        const current = this.folders.find((folder) => folder.id === String(this.folderId));
        const items = [];
        if (this.view === "favorites" && authSession.isConfigured) {
            items.push({ label: "新建收藏夹", icon: "plus", onSelect: () => this.createFolder() });
            if (current) items.push({ label: `删除「${current.name}」`, icon: "trash", danger: true, onSelect: () => this.deleteFolder() });
        }
        if (CLEAR_LABELS[this.view] && count) items.push({ label: `清空${CLEAR_LABELS[this.view]}`, icon: "trash", danger: true, onSelect: () => this.clearList() });
        this.menu.setItems(items);
    }

    async clearList() {
        const name = CLEAR_LABELS[this.view];
        if (!name || !await confirmAction({ title: `清空${name}？`, message: "所有设备同步清空，评分和收藏不受影响。", label: "清空" })) return;
        try {
            if (this.view === "random") await libraryStore.clearRandomHistory();
            else if (this.view === "later") await libraryStore.clearWatchLater();
            else await libraryStore.clearHistory();
            this.render();
            showToast("已清空");
        } catch (error) {
            showToast(error.message || "清空失败", "warning");
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
        this.ratingSelect.innerHTML = options.map(({ value, label, count }) => `<option value="${value}">${label} · ${count}</option>`).join("");
        this.ratingSelect.value = this.ratingFilter;
    }

    filteredRatings() {
        if (this.ratingFilter === "all") return this.localRatings;
        return this.localRatings.filter((item) => item.rating === Number(this.ratingFilter));
    }

    /** 工具栏上的状态：读取中或出错时显示提示，否则显示当前列表的数量。 */
    setNotice(text, warning = false) {
        this.noticeText = text;
        this.noticeWarning = warning;
        this.#paintNotice();
    }

    #paintNotice() {
        // 下拉框的选项里已带数量，这时只在读取中或出错时显示文字。
        const hasSelect = !this.folderSelect.hidden || !this.ratingSelect.hidden;
        const text = this.noticeText || (hasSelect ? "" : this.summary) || "";
        this.notice.textContent = text;
        this.notice.classList.toggle("warning", Boolean(this.noticeText && this.noticeWarning));
    }

    render() {
        if (this.view === "ratings") this.renderRatingFilters();
        const items = this.view === "random" ? libraryStore.getRandomHistory() : this.view === "history" ? libraryStore.getHistory() : this.view === "later" ? libraryStore.getWatchLater() : this.view === "ratings" ? this.filteredRatings() : this.remoteItems;
        const total = this.view === "favorites" ? Math.max(this.remoteTotal, items.length) : items.length;
        this.summary = `${total} 部`;
        this.#paintMenu(items.length);
        this.#paintNotice();
        if (!items.length) {
            const needsAccount = this.view === "favorites" && !authSession.isConfigured;
            this.grid.innerHTML = stateHtml(needsAccount
                ? { title: "未登录账号", message: "登录后同步 JM 收藏", action: { label: "登录", attrs: "data-open-account" } }
                : { title: EMPTY_TITLES[this.view], action: { label: "去发现", href: "./index.html" } });
            return;
        }
        this.grid.innerHTML = items.map((item) => comicCardHtml(item, {
            meta: this.view === "ratings" ? `评分 ${item.rating}/10` : item.savedAt ? new Date(item.savedAt).toLocaleDateString("zh-CN") : "",
            footer: this.view === "favorites" && item?.id ? `<button class="card-folder-move" type="button" data-folder-move="${escapeHtml(item.id)}">${icon("folder")}<span>移动</span></button>` : "",
        })).join("");
        hydrateCovers(this.grid);
        hydrateRichCards(this.grid);
    }
}
new LibraryPage().init().catch((error) => renderPageError(".library-grid", error, { title: "书架加载失败" }));
