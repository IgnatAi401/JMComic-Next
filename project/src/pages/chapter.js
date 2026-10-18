import { jmApi } from "../api/JmcomicApi.js";
import { authSession } from "../auth/AuthSession.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { translateTitleToSimplifiedChinese } from "../api/GoogleTranslateApi.js";
import { hasMissingComicChapterNames } from "../utils/ComicChapterNames.js";
import { libraryStore } from "../data/LibraryStore.js";
import { mountShell, openAccount } from "../ui/shell.js";
import { asText, authorsOf, escapeHtml, formatCount, formatDate, isApiTrue, readerUrl, searchUrl, textList } from "../ui/dom.js";
import { coverHtml, hydrateCovers } from "../ui/covers.js";
import { comicCardHtml } from "../ui/comic-card.js";
import { hydrateRichCards } from "../ui/rich-cards.js";
import { chaptersOf } from "../ui/chapters.js";
import { Comments } from "../ui/comments.js";
import { RatingEditor } from "../ui/rating.js";
import { PagePreview } from "../ui/page-preview.js";
import { AUTHOR_LEVELS, TAG_LEVELS, loadPreferences, nextLevel, preferenceAuthorsHtml, preferenceMaps, preferenceTagsHtml } from "../ui/preferences.js";
import { icon } from "../ui/icons.js";
import { renderPageError } from "../ui/states.js";
import { showToast } from "../ui/toast.js";
import { watchLaterButtonHtml } from "../ui/watch-later.js";
import { pickFavoriteFolder } from "../ui/favorite-folders.js";

// Chapters shown before the list folds below the two-column layout (1280px); matches the nth-child rule in workspace.css.
const CHAPTER_FOLD = 12;
const compactQuery = window.matchMedia("(max-width: 699px)");

const links = (values) => textList(values).map((value) => `<a class="tag" href="${searchUrl(value)}">${escapeHtml(value)}</a>`).join("");

class ChapterPage {
    async init() {
        mountShell();
        const id = new URLSearchParams(location.search).get("id");
        if (!/^\d+$/.test(id || "")) throw new Error("漫画 ID 无效");
        await jmApi.init();
        const album = await jmApi.getComicAlbum(id);
        if (!album?.id || !asText(album.name)) throw new Error("没有找到这本作品");
        this.album = album;
        this.chapters = chaptersOf(album);
        this.originalTitle = album.name;
        this.root = document.querySelector(".detail-content");
        document.title = `${album.name} · JMComic`;
        this.render();
        this.bind();
        this.renderAuthors();
        this.syncTagFold();
        this.renderChapters();
        libraryStore.init().then(() => this.renderChapters()).catch(() => {});
        loadPreferences().then((preferences) => { this.preferences = preferences; this.renderPreferences(); });
        const first = this.chapters[0];
        new PagePreview(this.root.querySelector(".detail-preview"), album, { id: first.id, label: this.chapters.length > 1 ? "第 1 章" : "全篇" }).mount();
        new RatingEditor(this.root.querySelector(".rating-editor"), album).mount();
        new Comments(this.root.querySelector(".detail-comments"), id, { total: album.comment_total }).mount();
        this.hydrateNames();
        this.refreshAccount();
        window.addEventListener("jm-auth-change", () => {
            const key = authSession.isConfigured ? String(authSession.user?.uid || authSession.configuredUsername) : "";
            if (key === this.accountKey) return;
            this.accountKey = key;
            this.refreshAccount();
        });
    }

    render() {
        const album = this.album;
        this.root.innerHTML = `<header class="detail-hero">
            <div class="detail-cover">${coverHtml(album, { eager: true })}</div>
            <div class="detail-copy"><p class="eyebrow">JM ${escapeHtml(album.id)} · ${this.chapters.length > 1 ? "系列作品" : "单篇作品"}</p>
                <h1 class="detail-title">${escapeHtml(album.name)}</h1>
                <div class="detail-byline"><span class="detail-authors is-folded"></span><span class="detail-byline-actions"><button class="btn btn-ghost btn-sm" type="button" data-manage-preferences aria-pressed="false">${icon("sliders")}<span>管理偏好</span></button><button class="btn btn-ghost btn-sm" type="button" data-translate aria-pressed="false">${icon("translate")}<span>翻译标题</span></button></span></div>
                <div class="tag-list detail-tags">${preferenceTagsHtml(album.tags)}</div>
                <button class="detail-fold" type="button" data-fold-tags aria-expanded="false" hidden>展开全部标签</button>
                ${asText(album.description) ? `<p class="detail-description">${escapeHtml(asText(album.description))}</p>` : ""}
                <dl class="detail-stats"><div><dt>章节</dt><dd>${this.chapters.length}</dd></div><div><dt>页数</dt><dd>${escapeHtml(album.total_photos ?? "—")}</dd></div><div><dt>观看</dt><dd>${formatCount(album.total_views)}</dd></div><div><dt>喜欢</dt><dd>${formatCount(album.likes)}</dd></div></dl>
                <div class="detail-actions"><a class="btn btn-primary" data-start-read data-navigation="same-tab">${icon("play")}<span>开始阅读</span></a><div class="detail-toggles">${watchLaterButtonHtml(album)}<button class="btn btn-outline" data-account-action="favorite" type="button" aria-pressed="false">${icon("bookmark")}<span>收藏</span></button><button class="btn btn-outline" data-account-action="like" type="button" aria-pressed="false">${icon("heart")}<span>喜欢</span></button>${this.chapters.length > 1 ? `<button class="btn btn-outline" data-account-action="track" type="button" aria-pressed="false">${icon("track")}<span>追踪连载</span></button>` : ""}</div></div>
            </div></header>
            <div class="detail-layout"><div class="detail-primary">
                <section class="section detail-preview" aria-labelledby="preview-title"><div class="section-head"><h2 class="section-title" id="preview-title">内容预览</h2><span class="section-meta" data-preview-meta></span></div><div class="preview-strip" data-navigation-scope="same-tab"><span class="preview-page" data-state="loading"></span><span class="preview-page" data-state="loading"></span><span class="preview-page" data-state="loading"></span></div></section>
                <section class="section"><div class="section-head"><h2 class="section-title">目录</h2><span class="section-meta">${this.chapters.length} 章</span></div><div class="chapter-list" data-navigation-scope="same-tab"></div><button class="detail-fold chapter-fold" type="button" data-fold-chapters aria-expanded="false" hidden>显示全部 ${this.chapters.length} 章</button></section>
                <section class="section rating-editor"></section>
                <section class="section detail-comments"></section>
            </div><aside class="detail-secondary">
                <section class="section detail-info"><h2 class="section-title">作品资料</h2><dl>${[["发布", formatDate(album.addtime) || "未知"], ["评论", album.comment_total ?? 0], ["编号", album.id], ["类型", isApiTrue(album.is_aids) ? "章节合集" : this.chapters.length > 1 ? "系列" : "单篇"], ["价格", album.price], ["购买状态", album.purchased], ["原始链接", album.real_link]].filter(([, value]) => !["", "0"].includes(asText(value))).map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>${[["关联作品", links(album.works)], ["角色", links(album.actors)]].map(([label, html]) => html ? `<h3>${label}</h3><div class="tag-list">${html}</div>` : "").join("")}</section>
            </aside></div>
            <section class="section related"><div class="section-head"><h2 class="section-title">相关作品</h2></div><div class="comic-grid">${(Array.isArray(album.related_list) ? album.related_list : []).map((item) => comicCardHtml(item)).join("")}</div></section>`;
        this.root.querySelector(".related").hidden = !album.related_list?.length;
        hydrateCovers(this.root);
        hydrateRichCards(this.root);
    }

    bind() {
        this.root.querySelector("[data-translate]").onclick = () => this.translate();
        this.root.querySelector("[data-manage-preferences]").onclick = () => this.toggleManaging();
        this.root.querySelector("[data-fold-tags]").onclick = () => this.setTagsExpanded(!this.tagsExpanded);
        this.root.querySelector("[data-fold-chapters]").onclick = () => this.setChaptersExpanded(!this.chaptersExpanded, { scroll: true });
        compactQuery.addEventListener?.("change", () => this.syncTagFold());
        // The folded author line is cut to whatever fits, so it is re-measured when its width changes.
        const authors = this.root.querySelector(".detail-authors");
        if (typeof ResizeObserver === "function") {
            new ResizeObserver(() => {
                if (!this.managing && !this.authorsExpanded && authors.clientWidth !== this.authorsWidth) this.renderAuthors();
            }).observe(authors);
        }
        this.root.querySelector(".detail-copy").addEventListener("click", (event) => {
            if (event.target.closest("[data-expand-authors]")) {
                this.authorsExpanded = !this.authorsExpanded;
                this.renderAuthors();
                this.root.querySelector("[data-expand-authors]")?.focus({ preventScroll: true });
                return;
            }
            const target = event.target.closest("[data-manage-preference]");
            if (target) this.cyclePreference(target.dataset.managePreference, target.dataset.name);
        });
        this.root.querySelectorAll("[data-account-action]").forEach((button) => { button.onclick = () => this.accountAction(button); });
    }

    renderPreferences() {
        const preferences = this.preferences || preferenceMaps(null);
        const manage = Boolean(this.managing);
        // The class moves the author line, so it is set before the line is measured.
        this.root.querySelector(".detail-copy").classList.toggle("is-managing-preferences", manage);
        this.renderAuthors();
        this.root.querySelector(".detail-tags").innerHTML = preferenceTagsHtml(this.album.tags, preferences.tags, { manage });
        const button = this.root.querySelector("[data-manage-preferences]");
        button.setAttribute("aria-pressed", String(manage));
        // Same length as the idle label, so the button keeps its width.
        button.querySelector("span").textContent = manage ? "退出管理" : "管理偏好";
        this.syncTagFold();
    }

    /**
     * Folded, the authors take one line on phones and two elsewhere: as many names as fit
     * (stance hits first) and a "+N" button that lists them all. Managing shows them all.
     */
    renderAuthors() {
        const box = this.root.querySelector(".detail-authors");
        const preferences = (this.preferences || preferenceMaps(null)).authors;
        const values = authorsOf(this.album);
        const total = new Set(values).size;
        const folded = !this.managing && !this.authorsExpanded;
        box.classList.toggle("is-folded", folded);
        box.classList.toggle("is-expanded", !this.managing && Boolean(this.authorsExpanded));
        if (!folded) {
            box.innerHTML = preferenceAuthorsHtml(values, preferences, { link: true, manage: this.managing });
            if (this.authorsExpanded) box.insertAdjacentHTML("beforeend", ' <button class="author-more" type="button" data-expand-authors aria-expanded="true">收起</button>');
            return;
        }
        const fits = () => box.scrollWidth <= box.clientWidth + 1 && box.scrollHeight <= box.clientHeight + 1;
        let limit = total;
        this.authorsWidth = box.clientWidth;
        box.innerHTML = preferenceAuthorsHtml(values, preferences, { link: true });
        while (limit > 1 && !fits()) {
            limit -= 1;
            box.innerHTML = preferenceAuthorsHtml(values, preferences, { link: true, limit, expandable: true });
        }
    }

    /** On phones a long tag list folds to three rows behind a toggle. */
    setTagsExpanded(expanded) {
        this.tagsExpanded = expanded;
        this.root.querySelector(".detail-tags").classList.toggle("is-folded", !expanded);
        this.syncTagFold();
    }

    syncTagFold() {
        const tags = this.root.querySelector(".detail-tags");
        const toggle = this.root.querySelector("[data-fold-tags]");
        tags.classList.toggle("is-folded", !this.tagsExpanded);
        const overflowing = tags.scrollHeight > tags.clientHeight + 1;
        toggle.hidden = this.managing || (!this.tagsExpanded && !overflowing) || (this.tagsExpanded && !compactQuery.matches);
        toggle.setAttribute("aria-expanded", String(Boolean(this.tagsExpanded)));
        toggle.textContent = this.tagsExpanded ? "收起标签" : `展开全部标签（${tags.children.length}）`;
    }

    /** Below the two-column layout the chapter list shows its head and the last-read chapter until expanded. */
    setChaptersExpanded(expanded, { scroll = false } = {}) {
        this.chaptersExpanded = expanded;
        const list = this.root.querySelector(".chapter-list");
        const toggle = this.root.querySelector("[data-fold-chapters]");
        list.classList.toggle("is-folded", !expanded);
        toggle.hidden = this.chapters.length <= CHAPTER_FOLD;
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.textContent = expanded ? "收起目录" : `显示全部 ${this.chapters.length} 章`;
        // Collapsing from far down the list would leave the reader in the comments.
        if (scroll && !expanded && list.getBoundingClientRect().top < 0) list.closest(".section").scrollIntoView({ block: "start" });
    }

    toggleManaging() {
        this.managing = !this.managing;
        // Every tag must be reachable while managing; leaving restores the earlier fold.
        if (this.managing) this.tagsBeforeManaging = this.tagsExpanded;
        this.tagsExpanded = this.managing || this.tagsBeforeManaging;
        this.renderPreferences();
        if (this.managing) showToast("点击标签或作者切换偏好");
    }

    /** Step a tag or author to its next stance (… → no stance → first stance) and save it. */
    async cyclePreference(kind, name) {
        if (!name || this.savingPreference) return;
        const map = (this.preferences || preferenceMaps(null))[`${kind}s`];
        const level = nextLevel(map.get(name), kind === "tag" ? TAG_LEVELS : AUTHOR_LEVELS);
        this.savingPreference = true;
        try {
            this.preferences = preferenceMaps(await localRuntime.savePreference({ kind, name, level }));
            this.renderPreferences();
            this.root.querySelector(`[data-manage-preference="${kind}"][data-name="${CSS.escape(name)}"]`)?.focus({ preventScroll: true });
        } catch (error) { showToast(`保存失败：${error.message}`, "warning"); }
        finally { this.savingPreference = false; }
    }

    renderChapters() {
        const last = libraryStore.lastChapter(this.album.id);
        const selected = this.chapters.find((item) => String(item.id) === last) || this.chapters[0];
        this.root.querySelector(".chapter-list").innerHTML = this.chapters.map((item, index) => `<a href="${readerUrl(item.id, this.album.id)}" class="chapter-item"${String(item.id) === last ? ' aria-current="true"' : ""}><span class="mono">${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(item.name)}</strong>${icon("chevronRight")}</a>`).join("");
        const start = this.root.querySelector("[data-start-read]");
        start.href = readerUrl(selected.id, this.album.id);
        start.querySelector("span").textContent = last ? "继续阅读" : "开始阅读";
        this.setChaptersExpanded(Boolean(this.chaptersExpanded));
    }

    async hydrateNames() {
        if (!hasMissingComicChapterNames(this.album.series)) return;
        try { this.chapters = chaptersOf(this.album, null, (await localRuntime.getWebChapterNames(this.album.id))?.chapters); this.renderChapters(); }
        catch { /* Numbered chapter names remain usable. */ }
    }

    async translate() {
        const button = this.root.querySelector("[data-translate]");
        if (button.disabled) return;
        button.disabled = true;
        button.classList.add("is-busy");
        try {
            if (this.translated) this.translated = false;
            else {
                const config = await localRuntime.getTranslationConfig().catch(() => null);
                const translationCacheKey = config?.use_ai_translation ? `ai:${String(config.model || "configured")}` : "google";
                if (!this.translation || this.translationCacheKey !== translationCacheKey) {
                    this.translation = config?.use_ai_translation ? (await localRuntime.translateTitle(this.originalTitle)).translation : await translateTitleToSimplifiedChinese(this.originalTitle);
                    this.translationCacheKey = translationCacheKey;
                }
                this.translated = Boolean(this.translation);
            }
            const title = this.translated ? this.translation : this.originalTitle;
            this.root.querySelector(".detail-title").textContent = title;
            document.title = `${title} · JMComic`;
            button.querySelector("span").textContent = this.translated ? "显示原文" : "翻译标题";
            button.setAttribute("aria-pressed", String(this.translated));
        } catch (error) { showToast(error.message || "翻译失败", "warning"); }
        finally { button.disabled = false; button.classList.remove("is-busy"); }
    }

    renderAccountStates() {
        const states = { like: [this.liked, "喜欢", "已喜欢"], favorite: [this.favorite, "收藏", "已收藏"], track: [this.tracking, "追踪连载", "正在追更"] };
        Object.entries(states).forEach(([action, [active, off, on]]) => {
            const button = this.root.querySelector(`[data-account-action="${action}"]`);
            // Single works have no tracking button.
            if (!button) return;
            button.setAttribute("aria-pressed", String(Boolean(active))); button.querySelector("span").textContent = active ? on : off;
        });
    }

    async refreshAccount() {
        const version = this.accountVersion = (this.accountVersion || 0) + 1;
        this.favorite = this.liked = this.tracking = false;
        this.renderAccountStates();
        try {
            await authSession.loadLocalConfig();
            if (!authSession.isConfigured) return;
            await authSession.loginFromLocalConfig();
            const states = await Promise.allSettled([jmApi.getFavoriteState(this.album.id), jmApi.getLikeState(this.album.id), this.chapters.length > 1 ? jmApi.getAlbumTrackingState(this.album.id) : Promise.resolve(false)]);
            if (version !== this.accountVersion) return;
            ["favorite", "liked", "tracking"].forEach((key, i) => { if (states[i].status === "fulfilled") this[key] = isApiTrue(states[i].value); });
            this.renderAccountStates();
        } catch { /* Detail remains readable; actions offer a retry. */ }
    }

    /**
     * Without named folders the button simply toggles. With folders, adding asks which
     * folder to use, and an already favourited work offers "move" or "取消收藏".
     */
    async favoriteAction(button) {
        const id = this.album.id;
        const saved = isApiTrue(await jmApi.getFavoriteState(id));
        const folders = await jmApi.getFavoriteFolders().catch(() => []);
        const pick = async (options) => {
            button.classList.remove("is-busy");
            try { return await pickFavoriteFolder({ folders, ...options }); } finally { button.classList.add("is-busy"); }
        };
        const moveTo = async (folderId) => {
            await jmApi.moveFavoriteToFolder(id, folderId);
            const name = folderId === "0" ? "默认收藏夹" : (jmApi.favoriteFolders || folders).find((folder) => folder.id === folderId)?.name || "收藏夹";
            showToast(`已放入「${name}」`);
        };
        if (!saved) {
            // JM can only favourite into the default folder, so the choice comes first and the
            // move follows the favourite; dismissing the picker leaves the work unfavourited.
            const target = folders.length ? await pick({ title: "收藏到" }) : "0";
            if (!target) return;
            this.favorite = (await jmApi.updateFavoriteState(id, true)).saved;
            this.renderAccountStates();
            if (!this.favorite) return;
            if (target === "0") { if (folders.length) showToast("已放入「默认收藏夹」"); return; }
            try {
                await moveTo(target);
            } catch (error) {
                throw new Error(`已收藏，但未能放入所选收藏夹（${error.message || "移动失败"}），现在在默认收藏夹`);
            }
            return;
        }
        if (!folders.length) {
            this.favorite = (await jmApi.updateFavoriteState(id, false)).saved;
            return;
        }
        const choice = await pick({ title: "已收藏 · 移动或取消", removable: true });
        if (choice === "remove") this.favorite = (await jmApi.updateFavoriteState(id, false)).saved;
        else if (choice) await moveTo(choice);
    }

    async accountAction(button) {
        if (this.accountBusy) return;
        this.accountBusy = true;
        const buttons = [...this.root.querySelectorAll("[data-account-action]")];
        buttons.forEach((item) => { item.disabled = true; });
        // Account requests take a moment; a spinner replaces the label so the button keeps its size.
        button.classList.add("is-busy");
        try {
            await authSession.loadLocalConfig();
            if (!authSession.isConfigured) { openAccount(); return; }
            await authSession.loginFromLocalConfig();
            this.accountVersion = (this.accountVersion || 0) + 1;
            const action = button.dataset.accountAction;
            if (action === "favorite") {
                await this.favoriteAction(button);
            } else if (action === "like") {
                const current = await jmApi.getLikeState(this.album.id);
                await jmApi.toggleLike(this.album.id);
                this.liked = !isApiTrue(current); jmApi.setLikeState(this.album.id, this.liked);
            } else {
                const current = await jmApi.getAlbumTrackingState(this.album.id);
                await jmApi.toggleAlbumTracking(this.album.id);
                this.tracking = !isApiTrue(current);
                window.dispatchEvent(new CustomEvent("jm-notification-change"));
            }
            this.renderAccountStates();
        } catch (error) {
            if (typeof error.actualState === "boolean") { this.favorite = error.actualState; this.renderAccountStates(); }
            showToast(error.message || "操作失败，请重试", "warning");
        } finally { this.accountBusy = false; button.classList.remove("is-busy"); buttons.forEach((item) => { item.disabled = false; }); }
    }
}

new ChapterPage().init().catch((error) => renderPageError(".detail-content", error, { title: "作品加载失败", action: { href: location.href, label: "重新载入" } }));
