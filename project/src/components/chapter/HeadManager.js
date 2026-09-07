import { jmApi } from "../../api/JmcomicApi.js";
import { translateTitleToSimplifiedChinese } from "../../api/GoogleTranslateApi.js";
import { authSession } from "../../auth/AuthSession.js";
import { localRuntime } from "../../local/LocalRuntime.js";
import { hasMissingComicChapterNames, mergeComicChapterNames } from "../../utils/ComicChapterNames.js";
import { readLocalStorage } from "../../utils/BrowserStorage.js";
import { showToast } from "../general/Toast.js";
import { SafeEvaluation } from "./SafeEvaluation.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

const apiFlag = (value) => value === true || value === 1 || value === "1";
const asArray = (value) => Array.isArray(value) ? value.filter((item) => item != null) : (value == null || value === "" ? [] : [value]);
const asText = (value, fallback = "") => {
    if (value == null) return fallback;
    if (typeof value === "object") return fallback;
    const text = String(value).trim();
    return text || fallback;
};
const localComicPayload = (album, favorite) => ({
    id: String(album.id),
    title: album.name || "未命名作品",
    authors: asArray(album.author).map((item) => asText(item)).filter(Boolean),
    tags: asArray(album.tags).map((item) => asText(item)).filter(Boolean),
    favorite: Boolean(favorite),
});
const syncLocalFavorite = async (album, favorite) => {
    if (!favorite) {
        const current = await localRuntime.getLocalComic(album.id);
        if (!current?.comic) return;
    }
    await localRuntime.saveLocalComic(localComicPayload(album, favorite));
};

export class HeadManager {
    init(album) {
        this.album = album;
        this.headDom = document.querySelector(".head");
        this.chapters = this.getChapters(album);
        this.setAlbum();
        this.setChapters();
        this.hydrateChapterNames();
        this.setMetadata();
        new SafeEvaluation().init(album);
        this.addTitleTranslationEvent();
        this.addLikeEvent();
        this.addFavoriteEvent();
        this.addTrackingEvent();
    }

    getChapters(album, webChapters = []) {
        const series = Array.isArray(album?.series)
            ? album.series.filter((chapter) => chapter && typeof chapter === "object" && chapter.id != null)
            : [];
        const chapters = series.length
            ? series
            : [{ id: String(album.id), name: "", sort: "1" }];
        const seen = new Set();
        const normalized = [...chapters]
            .sort((a, b) => Number(a.sort) - Number(b.sort))
            .filter((chapter) => {
                const key = String(chapter.sort || chapter.id);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        return mergeComicChapterNames(normalized, webChapters);
    }

    chapterName(chapter) {
        return asText(chapter?.name, `第${chapter?.sort}话`);
    }

    readerUrl(chapter) {
        return `./reader.html?id=${encodeURIComponent(chapter.id)}&album=${encodeURIComponent(this.album.id)}&v=20260827-7`;
    }

    setAlbum() {
        const coverUrl = jmApi.getCoverImageURL(this.album.id);
        this.headDom.querySelector(".cover img").src = coverUrl;
        this.headDom.style.setProperty("--cover-image", `url("${coverUrl}")`);
        this.originalTitle = asText(this.album.name, "未命名作品");
        this.translatedTitle = "";
        this.translationCacheKey = "";
        this.showingTranslatedTitle = false;
        this.renderTitle();
        const authors = asArray(this.album.author).map((author) => asText(author)).filter(Boolean);
        this.headDom.querySelector(".author").innerHTML = authors.length
            ? authors.map((author) => `<a href="./search.html?sq=${encodeURIComponent(author)}&v=20260827-7">${escapeHtml(author)}</a>`).join('<span aria-hidden="true"> · </span>')
            : "未知作者";
        this.headDom.querySelector(".introduction").textContent = asText(this.album.description, "暂无作品简介");
        this.headDom.querySelector(".chapter-count").textContent = `${this.chapters.length} 章`;
        this.headDom.querySelector(".content-state").textContent = this.chapters.length > 1 ? "系列漫画" : "单篇漫画";
        this.headDom.querySelector(".tags").innerHTML = asArray(this.album.tags).map((tag) => asText(tag)).filter(Boolean).map((tag) => `<a href="./search.html?sq=${encodeURIComponent(tag)}&v=20260827-7">${escapeHtml(tag)}</a>`).join("");
    }

    renderTitle() {
        const title = this.showingTranslatedTitle && this.translatedTitle
            ? this.translatedTitle
            : this.originalTitle;
        const button = this.headDom.querySelector(".title-translate");
        this.headDom.querySelector(".title-text").textContent = title;
        document.title = `${title} · JMComic`;
        button.textContent = this.showingTranslatedTitle ? "原" : "译";
        button.title = this.showingTranslatedTitle ? "显示原标题" : "翻译为简体中文";
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", String(this.showingTranslatedTitle));
    }

    addTitleTranslationEvent() {
        const button = this.headDom.querySelector(".title-translate");
        button.addEventListener("click", async () => {
            if (this.showingTranslatedTitle) {
                this.showingTranslatedTitle = false;
                this.renderTitle();
                return;
            }

            let aiConfig = null;
            try {
                aiConfig = await localRuntime.getAiConfig();
            } catch { /* Google translation remains available if local config cannot be read. */ }
            const useAiTranslation = Boolean(aiConfig?.use_ai_translation);
            const translationCacheKey = useAiTranslation
                ? `ai:${String(aiConfig?.model || "configured")}`
                : "google";

            if (this.translatedTitle && this.translationCacheKey === translationCacheKey) {
                this.showingTranslatedTitle = true;
                this.renderTitle();
                return;
            }

            button.disabled = true;
            button.classList.add("loading");
            button.textContent = "…";
            button.title = "正在翻译标题";
            button.setAttribute("aria-label", button.title);
            try {
                if (useAiTranslation) {
                    const result = await localRuntime.translateTitleWithAi(this.originalTitle);
                    this.translatedTitle = result.translation;
                } else {
                    this.translatedTitle = await translateTitleToSimplifiedChinese(this.originalTitle);
                }
                this.translationCacheKey = translationCacheKey;
                this.showingTranslatedTitle = true;
            } catch (error) {
                showToast(error.message || "标题翻译失败，请稍后重试", "warning");
            } finally {
                button.disabled = false;
                button.classList.remove("loading");
                this.renderTitle();
            }
        });
    }

    setChapters() {
        const list = document.querySelector(".chapter-list");
        list.innerHTML = this.chapters.map((chapter, index) => `
            <a class="chapter-item" href="${this.readerUrl(chapter)}" data-navigation="same-tab">
                <span>${String(index + 1).padStart(2, "0")}</span>
                <strong>${escapeHtml(this.chapterName(chapter))}</strong>
                <i>开始阅读</i>
            </a>`).join("");

        const start = this.headDom.querySelector(".start-read");
        const lastChapter = readLocalStorage(`jm_last_chapter_${this.album.id}`);
        const selectedChapter = this.chapters.find((item) => String(item.id) === lastChapter) || this.chapters[0];
        if (lastChapter && selectedChapter !== this.chapters[0]) start.textContent = "继续阅读";
        start.href = this.readerUrl(selectedChapter);
    }

    async hydrateChapterNames() {
        if (!hasMissingComicChapterNames(this.album?.series)) return;
        try {
            const result = await localRuntime.getWebChapterNames(this.album.id);
            this.chapters = this.getChapters(this.album, result?.chapters);
            this.setChapters();
        } catch {
            // Mobile API names and numbered fallbacks remain usable offline.
        }
    }

    setMetadata() {
        const date = Number(this.album.addtime);
        const fields = {
            addtime: date ? new Date(date * 1000).toLocaleDateString("zh-CN") : "未知",
            total_photos: this.album.total_photos ?? "—",
            comment_total: this.album.comment_total ?? "0",
            series_id: String(this.album.id ?? "—"),
            is_aids: apiFlag(this.album.is_aids) ? "章节合集" : (this.chapters.length > 1 ? "系列" : "单篇"),
            price: this.album.price || "免费",
            purchased: this.album.purchased || "无需购买",
            real_link: this.album.real_link || "无",
        };
        Object.entries(fields).forEach(([key, value]) => {
            const target = document.querySelector(`[data-field="${key}"]`);
            if (target) target.textContent = value;
        });
        const renderTaxonomy = (selector, values) => {
            const entries = asArray(values).map((value) => asText(value)).filter(Boolean);
            document.querySelector(selector).innerHTML = entries.length
                ? entries.map((value) => `<a href="./search.html?sq=${encodeURIComponent(value)}&v=20260827-7">${escapeHtml(value)}</a>`).join("")
                : "<span class=\"empty-value\">暂无</span>";
        };
        renderTaxonomy(".works-list", this.album.works);
        renderTaxonomy(".actors-list", this.album.actors);
    }

    addLikeEvent() {
        const button = this.headDom.querySelector(".like-action");
        const render = () => {
            const liked = apiFlag(this.album.liked);
            button.classList.toggle("saved", liked);
            button.textContent = liked ? "♥ 已喜欢 · 点击取消" : "♡ 喜欢";
            const field = document.querySelector('[data-field="liked"]');
            if (field) field.textContent = liked ? "已喜欢" : "未喜欢";
        };
        render();
        const refresh = async () => {
            button.disabled = true;
            await authSession.loadLocalConfig();
            if (!authSession.isConfigured) return;
            if (!authSession.isLoggedIn) await authSession.loginFromLocalConfig();
            this.album.liked = await jmApi.getLikeState(this.album.id);
            render();
        };
        refresh().catch(() => {}).finally(() => {
            button.disabled = false;
        });
        button.addEventListener("click", async () => {
            try {
                await authSession.loadLocalConfig();
            } catch (error) {
                showToast(error.message || "请通过本地服务启动 WebUI", "warning");
                return;
            }
            if (!authSession.isConfigured) {
                document.querySelector(".account-trigger")?.click();
                showToast("请先配置账号和密码", "warning");
                return;
            }
            button.disabled = true;
            try {
                await authSession.loginFromLocalConfig();
                const wasLiked = apiFlag(this.album.liked);
                await jmApi.toggleLike(this.album.id);
                this.album.liked = !wasLiked;
                jmApi.setLikeState(this.album.id, !wasLiked);
                render();
                showToast(wasLiked ? "已取消喜欢" : "已喜欢这部漫画", "success");
            } catch (error) {
                showToast(error.message || "喜欢失败，请稍后重试", "warning");
            } finally {
                button.disabled = false;
            }
        });
    }

    addFavoriteEvent() {
        const button = this.headDom.querySelector(".favorite-action");
        const render = () => {
            const saved = apiFlag(this.album.is_favorite);
            button.classList.toggle("saved", saved);
            button.textContent = saved ? "✓ 已收藏 · 点击取消" : "＋ 收藏";
            const field = document.querySelector('[data-field="is_favorite"]');
            if (field) field.textContent = saved ? "账号已收藏" : "未收藏";
        };
        render();
        const refresh = async () => {
            await authSession.loadLocalConfig();
            if (!authSession.isConfigured) return;
            button.disabled = true;
            if (!authSession.isLoggedIn) await authSession.loginFromLocalConfig();
            this.album.is_favorite = await jmApi.getFavoriteState(this.album.id);
            await syncLocalFavorite(this.album, apiFlag(this.album.is_favorite));
            render();
        };
        refresh().catch(() => {}).finally(() => { button.disabled = false; });
        button.addEventListener("click", async () => {
            try {
                await authSession.loadLocalConfig();
            } catch (error) {
                showToast(error.message || "请通过本地服务启动 WebUI", "warning");
                return;
            }
            if (!authSession.isConfigured) {
                document.querySelector(".account-trigger")?.click();
                showToast("请先配置账号和密码", "warning");
                return;
            }
            button.disabled = true;
            try {
                await authSession.loginFromLocalConfig();
                const wasSaved = apiFlag(this.album.is_favorite);
                const result = await jmApi.updateFavoriteState(this.album.id, !wasSaved);
                this.album.is_favorite = result.saved;
                await syncLocalFavorite(this.album, result.saved);
                render();
                if (result.changed) {
                    showToast(result.saved ? "已添加到账号收藏" : "已取消账号收藏", "success");
                } else {
                    showToast(result.saved ? "该漫画已经收藏，状态已同步" : "该漫画已取消收藏，状态已同步", "success");
                }
            } catch (error) {
                if (typeof error.actualState === "boolean") {
                    this.album.is_favorite = error.actualState;
                    syncLocalFavorite(this.album, error.actualState).catch(() => {});
                    render();
                }
                showToast(error.message || "收藏状态更新失败，请稍后重试", "warning");
            } finally {
                button.disabled = false;
            }
        });
    }

    addTrackingEvent() {
        const button = this.headDom.querySelector(".track-action");
        button.hidden = this.chapters.length <= 1;
        if (button.hidden) return;
        this.isTracking = false;
        const render = () => {
            button.classList.toggle("saved", this.isTracking);
            button.textContent = this.isTracking ? "✓ 已追踪 · 点击取消" : "追踪连载";
        };
        const refresh = async () => {
            await authSession.loadLocalConfig();
            if (!authSession.isConfigured) return;
            if (!authSession.isLoggedIn) await authSession.loginFromLocalConfig();
            this.isTracking = await jmApi.getAlbumTrackingState(this.album.id);
            render();
        };
        render();
        refresh().catch(() => {});
        button.addEventListener("click", async () => {
            try {
                await authSession.loadLocalConfig();
                if (!authSession.isConfigured) {
                    document.querySelector(".account-trigger")?.click();
                    showToast("请先配置账号和密码", "warning");
                    return;
                }
                button.disabled = true;
                await authSession.loginFromLocalConfig();
                await jmApi.toggleAlbumTracking(this.album.id);
                this.isTracking = !this.isTracking;
                render();
                window.dispatchEvent(new CustomEvent("jm-notification-change"));
                showToast(this.isTracking ? "已追踪这部连载" : "已取消连载追踪", "success");
            } catch (error) {
                showToast(error.message || "追踪状态更新失败", "warning");
            } finally {
                button.disabled = false;
            }
        });
    }
}
