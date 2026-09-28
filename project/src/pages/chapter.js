import { jmApi } from "../api/JmcomicApi.js";
import { authSession } from "../auth/AuthSession.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { translateTitleToSimplifiedChinese } from "../api/GoogleTranslateApi.js";
import { hasMissingComicChapterNames } from "../utils/ComicChapterNames.js";
import { readLocalStorage } from "../utils/BrowserStorage.js";
import { mountShell, openAccount } from "../ui/shell.js";
import { asText, authorsOf, comicPayload, escapeHtml, formatCount, formatDate, isApiTrue, readerUrl, searchUrl, textList } from "../ui/dom.js";
import { coverHtml, hydrateCovers } from "../ui/covers.js";
import { comicCardHtml } from "../ui/comic-card.js";
import { chaptersOf } from "../ui/chapters.js";
import { Comments } from "../ui/comments.js";
import { RatingEditor } from "../ui/rating.js";
import { InterestFeedback } from "../ui/interest.js";
import { icon } from "../ui/icons.js";
import { renderPageError } from "../ui/states.js";
import { showToast } from "../ui/toast.js";

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
        this.renderChapters();
        new RatingEditor(this.root.querySelector(".rating-editor"), album).mount();
        new InterestFeedback(this.root.querySelector(".interest-feedback"), album).mount();
        new Comments(this.root.querySelector(".detail-comments"), id, { total: album.comment_total }).mount();
        this.hydrateNames();
        this.refreshAccount();
        window.addEventListener("jm-auth-change", () => {
            const key = authSession.isConfigured ? String(authSession.user?.uid || authSession.configuredUsername) : "";
            if (key === this.accountKey) return;
            this.accountKey = key;
            this.refreshAccount();
        });
        localRuntime.recordInteraction({ event_type: "detail_view", comic_id: String(id), source: "chapter", comic: comicPayload(album, jmApi.getCoverImageURL(id)) });
    }

    render() {
        const album = this.album;
        this.root.innerHTML = `<header class="detail-hero">
            <div class="detail-cover">${coverHtml(album, { eager: true })}</div>
            <div class="detail-copy"><p class="eyebrow">JM ${escapeHtml(album.id)} · ${this.chapters.length > 1 ? "系列作品" : "单篇作品"}</p>
                <h1 class="detail-title">${escapeHtml(album.name)}</h1>
                <div class="detail-byline"><span>${authorsOf(album).map((author) => `<a href="${searchUrl(author)}">${escapeHtml(author)}</a>`).join(" · ") || "作者未标注"}</span><button class="btn btn-ghost btn-sm" type="button" data-translate aria-pressed="false">${icon("translate")}<span>翻译标题</span></button></div>
                <div class="tag-list detail-tags">${links(album.tags)}</div>
                <p class="detail-description">${escapeHtml(asText(album.description, "暂无作品简介"))}</p>
                <dl class="detail-stats"><div><dt>章节</dt><dd>${this.chapters.length}</dd></div><div><dt>页数</dt><dd>${escapeHtml(album.total_photos ?? "—")}</dd></div><div><dt>观看</dt><dd>${formatCount(album.total_views)}</dd></div><div><dt>喜欢</dt><dd>${formatCount(album.likes)}</dd></div></dl>
                <div class="detail-actions"><a class="btn btn-primary" data-start-read data-navigation="same-tab">${icon("play")}开始阅读</a><button class="btn btn-outline" data-account-action="favorite" type="button" aria-pressed="false">${icon("bookmark")}<span>收藏</span></button><button class="btn btn-outline" data-account-action="like" type="button" aria-pressed="false">${icon("heart")}<span>喜欢</span></button><button class="btn btn-ghost" data-account-action="track" type="button" aria-pressed="false" ${this.chapters.length <= 1 ? "hidden" : ""}>${icon("track")}<span>追踪连载</span></button></div>
            </div></header>
            <div class="detail-layout"><div class="detail-primary">
                <section class="section"><div class="section-head"><h2 class="section-title">目录</h2><span class="section-meta">${this.chapters.length} 章</span></div><div class="chapter-list" data-navigation-scope="same-tab"></div></section>
                <section class="section panel interest-feedback"></section>
                <section class="section rating-editor"></section>
                <section class="section detail-comments"></section>
            </div><aside class="detail-secondary">
                <section class="section detail-info"><h2 class="section-title">作品资料</h2><dl>${[["发布", formatDate(album.addtime) || "未知"], ["评论", album.comment_total ?? 0], ["编号", album.id], ["类型", isApiTrue(album.is_aids) ? "章节合集" : this.chapters.length > 1 ? "系列" : "单篇"], ["价格", album.price || "免费"], ["购买状态", album.purchased || "无需购买"], ["原始链接", album.real_link || "无"]].map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl><h3>关联作品</h3><div class="tag-list">${links(album.works) || "暂无"}</div><h3>角色</h3><div class="tag-list">${links(album.actors) || "暂无"}</div></section>
            </aside></div>
            <section class="section related"><div class="section-head"><h2 class="section-title">相关作品</h2></div><div class="comic-grid">${(Array.isArray(album.related_list) ? album.related_list : []).map((item) => comicCardHtml(item)).join("")}</div></section>`;
        this.root.querySelector(".related").hidden = !album.related_list?.length;
        hydrateCovers(this.root);
    }

    bind() {
        this.root.querySelector("[data-translate]").onclick = () => this.translate();
        this.root.querySelectorAll("[data-account-action]").forEach((button) => { button.onclick = () => this.accountAction(button); });
    }

    renderChapters() {
        const last = readLocalStorage(`jm_last_chapter_${this.album.id}`);
        const selected = this.chapters.find((item) => String(item.id) === last) || this.chapters[0];
        this.root.querySelector(".chapter-list").innerHTML = this.chapters.map((item, index) => `<a href="${readerUrl(item.id, this.album.id)}" class="chapter-item"${String(item.id) === last ? ' aria-current="true"' : ""}><span class="mono">${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(item.name)}</strong>${icon("chevronRight")}</a>`).join("");
        const start = this.root.querySelector("[data-start-read]");
        start.href = readerUrl(selected.id, this.album.id);
        start.innerHTML = `${icon("play")}${last ? "继续阅读" : "开始阅读"}`;
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
        try {
            if (this.translated) this.translated = false;
            else {
                const config = await localRuntime.getAiConfig().catch(() => null);
                const translationCacheKey = config?.use_ai_translation ? `ai:${String(config.model || "configured")}` : "google";
                if (!this.translation || this.translationCacheKey !== translationCacheKey) {
                    this.translation = config?.use_ai_translation ? (await localRuntime.translateTitleWithAi(this.originalTitle)).translation : await translateTitleToSimplifiedChinese(this.originalTitle);
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
        finally { button.disabled = false; }
    }

    renderAccountStates() {
        const states = { like: [this.liked, "喜欢", "已喜欢"], favorite: [this.favorite, "收藏", "已收藏"], track: [this.tracking, "追踪连载", "正在追更"] };
        Object.entries(states).forEach(([action, [active, off, on]]) => {
            const button = this.root.querySelector(`[data-account-action="${action}"]`);
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
            if (states[0].status === "fulfilled") {
                const stored = this.favorite || (await localRuntime.getLocalComic(this.album.id))?.comic;
                if (stored && version === this.accountVersion) await localRuntime.saveLocalComic({ ...comicPayload(this.album, jmApi.getCoverImageURL(this.album.id)), favorite: this.favorite });
            }
        } catch { /* Detail remains readable; actions offer a retry. */ }
    }

    async accountAction(button) {
        if (this.accountBusy) return;
        this.accountBusy = true;
        const buttons = [...this.root.querySelectorAll("[data-account-action]")];
        buttons.forEach((item) => { item.disabled = true; });
        try {
            await authSession.loadLocalConfig();
            if (!authSession.isConfigured) { openAccount(); return; }
            await authSession.loginFromLocalConfig();
            this.accountVersion = (this.accountVersion || 0) + 1;
            const action = button.dataset.accountAction;
            if (action === "favorite") {
                const current = await jmApi.getFavoriteState(this.album.id);
                const result = await jmApi.updateFavoriteState(this.album.id, !isApiTrue(current));
                this.favorite = result.saved;
                this.renderAccountStates();
                try {
                    // An unfavorite must not create an otherwise absent local record.
                    if (result.saved || (await localRuntime.getLocalComic(this.album.id))?.comic) await localRuntime.saveLocalComic({ ...comicPayload(this.album, jmApi.getCoverImageURL(this.album.id)), favorite: result.saved });
                } catch { showToast("账号收藏已更新，本地资料同步暂时失败", "warning"); }
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
        } finally { this.accountBusy = false; buttons.forEach((item) => { item.disabled = false; }); }
    }
}

new ChapterPage().init().catch((error) => renderPageError(".detail-content", error, { title: "作品加载失败", action: { href: location.href, label: "重新载入" } }));
