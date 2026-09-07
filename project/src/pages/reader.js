import { jmApi } from "../api/JmcomicApi.js";
import { CleanCommentManager } from "../components/chapter/CleanCommentManager.js";
import { LocalRatingManager } from "../components/chapter/LocalRatingManager.js";
import { ReaderImageManager } from "../components/chapter/ReaderImageManager.js";
import { ImageLoadBatchManager } from "../components/general/ImageLoadBatchManager.js";
import { setting } from "../components/general/Setting.js";
import { SwitchServerBtnManager } from "../components/general/SwitchServerBtnManager.js";
import { libraryStore } from "../data/LibraryStore.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { hasMissingComicChapterNames, mergeComicChapterNames } from "../utils/ComicChapterNames.js";
import { writeLocalStorage } from "../utils/BrowserStorage.js";
import { renderPageError } from "../utils/PageError.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

class ReaderPage {
    async init() {
        const params = new URLSearchParams(location.search);
        this.chapterId = params.get("id");
        this.albumId = params.get("album");
        this.readMilestones = new Set();
        this.readSessionReady = false;
        this.pendingReadProgress = null;
        if (!this.chapterId || !/^\d+$/.test(this.chapterId)) throw new Error("章节 ID 无效");
        if (this.albumId && !/^\d+$/.test(this.albumId)) throw new Error("漫画 ID 无效");
        this.setupSidebarToggle();

        await Promise.all([setting.init(), jmApi.init()]);
        new SwitchServerBtnManager().init();
        new ImageLoadBatchManager(document.querySelector(".reader-batch-setting")).init();

        try {
            const chapterPromise = jmApi.getComicChapter(this.chapterId);
            const knownAlbumPromise = this.albumId
                ? jmApi.getComicAlbum(this.albumId).catch(() => null)
                : null;
            const chapter = await chapterPromise;
            this.albumId = this.albumId || String(chapter.series_id || chapter.id);

            this.chapter = chapter;
            new ReaderImageManager().init(chapter, (progress) => this.recordReadProgress(progress));
            document.querySelector(".reader-loading").hidden = true;
            document.querySelector(".comic-content-cr").hidden = false;
            document.querySelector(".progress-cr").hidden = false;

            const fallbackAlbum = {
                id: this.albumId,
                name: chapter.name,
                author: [],
                series: chapter.series || [],
            };
            const album = (knownAlbumPromise
                ? await knownAlbumPromise
                : await jmApi.getComicAlbum(this.albumId).catch(() => null)) || fallbackAlbum;
            this.album = album;
            this.chapters = this.getChapters(album, chapter);
            this.currentIndex = Math.max(0, this.chapters.findIndex((item) => String(item.id) === String(this.chapterId)));
            this.renderToolbar();
            this.setupComments();
            this.hydrateChapterNames();
            const ratingPanel = document.querySelector(".reader-local-rating");
            ratingPanel.hidden = false;
            await new LocalRatingManager().init(album);
            this.readStartPromise = localRuntime.recordInteraction({
                event_type: "read_start",
                comic_id: String(album.id),
                source: "reader",
                metadata: { chapter_id: String(this.chapterId) },
                comic: {
                    id: String(album.id),
                    title: album.name || "未命名作品",
                    authors: Array.isArray(album.author) ? album.author : (album.author ? [album.author] : []),
                    tags: Array.isArray(album.tags) ? album.tags : [],
                    cover_url: jmApi.getCoverImageURL(album.id),
                },
            });
            this.readStartPromise.finally(() => {
                this.readSessionReady = true;
                if (this.pendingReadProgress) {
                    const pendingProgress = this.pendingReadProgress;
                    this.pendingReadProgress = null;
                    this.recordReadProgress(pendingProgress);
                }
            });
            libraryStore.recordHistory(album);
            writeLocalStorage(`jm_last_chapter_${album.id}`, String(this.chapterId));

            document.querySelector(".reader-end").hidden = false;
        } catch (error) {
            const loading = document.querySelector(".reader-loading");
            loading.hidden = false;
            document.querySelector(".comic-content-cr").hidden = true;
            document.querySelector(".reader-end").hidden = true;
            document.querySelector(".progress-cr").hidden = true;
            loading.innerHTML = `<div class="reader-error glass-card"><strong>章节加载失败</strong><p>${escapeHtml(error.message || "请稍后重试")}</p><a class="ghost-btn" href="./chapter.html?id=${encodeURIComponent(this.albumId || this.chapterId)}&v=20260827-7">返回漫画主页</a></div>`;
        }
    }

    recordReadProgress(value) {
        if (!value || !Number.isFinite(value.progress)) return;
        if (!this.album?.id || !this.readSessionReady) {
            this.pendingReadProgress = value;
            return;
        }
        const milestone = [1, 0.75, 0.5, 0.25].find((threshold) => value.progress >= threshold);
        if (!milestone || this.readMilestones.has(milestone)) return;
        this.readMilestones.add(milestone);
        localRuntime.recordInteraction({
            event_type: milestone === 1 ? "read_complete" : "read_progress",
            comic_id: String(this.album.id),
            source: "reader",
            metadata: {
                chapter_id: String(this.chapterId),
                progress: milestone,
                page: Number(value.page) || null,
                pages: Number(value.pages) || null,
            },
        });
    }

    setupSidebarToggle() {
        const readingSurface = document.querySelector(".comic-content-cr");
        const sideStack = document.querySelector(".reader-side-stack");
        if (!readingSurface || !sideStack) return;

        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
        let sidebarHidden = document.body.classList.contains("reader-sidebar-hidden");
        let motionEndHandler = null;
        let motionFallback = 0;

        const commitHiddenState = (hidden) => {
            document.body.classList.toggle("reader-sidebar-hidden", hidden);
        };

        const clearMotion = () => {
            if (motionEndHandler) {
                sideStack.removeEventListener("animationend", motionEndHandler);
                motionEndHandler = null;
            }
            if (motionFallback) {
                window.clearTimeout(motionFallback);
                motionFallback = 0;
            }
            sideStack.classList.remove("reader-sidebar-entering", "reader-sidebar-leaving");
        };

        const finishMotion = () => {
            clearMotion();
            commitHiddenState(sidebarHidden);
        };

        const setHidden = (hidden) => {
            sidebarHidden = hidden;
            sideStack.setAttribute("aria-hidden", String(hidden));
            if (hidden && sideStack.contains(document.activeElement)) {
                document.activeElement.blur();
            }

            clearMotion();
            if (reducedMotion.matches) {
                commitHiddenState(hidden);
                return;
            }

            // Use the same directional clip for entry and its reverse exit.
            document.body.classList.remove("reader-sidebar-hidden");
            sideStack.classList.add(hidden ? "reader-sidebar-leaving" : "reader-sidebar-entering");
            motionEndHandler = (event) => {
                if (event.target !== sideStack || event.animationName !== "reader-sidebar-reveal") return;
                finishMotion();
            };
            sideStack.addEventListener("animationend", motionEndHandler);
            motionFallback = window.setTimeout(finishMotion, 420);
        };

        readingSurface.addEventListener("click", (event) => {
            if (!(event.target instanceof Element) || event.defaultPrevented) return;
            if (event.target.closest("a, button, input, select, textarea, label, summary, [contenteditable], [role], [tabindex]")) return;
            setHidden(!sidebarHidden);
        });
    }

    getChapters(album, chapter, webChapters = []) {
        const series = album.series?.length ? album.series : chapter.series;
        const chapters = series?.length ? series : [{ id: chapter.id, name: "", sort: "1" }];
        const seen = new Set();
        const normalized = [...chapters]
            .sort((a, b) => Number(a.sort) - Number(b.sort))
            .filter((item) => {
                const key = String(item.sort || item.id);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        return mergeComicChapterNames(normalized, webChapters);
    }

    chapterName(item) {
        return item.name?.trim() || `第${item.sort}话`;
    }

    async hydrateChapterNames() {
        const series = this.album?.series?.length ? this.album.series : this.chapter?.series;
        if (!hasMissingComicChapterNames(series)) return;
        try {
            const result = await localRuntime.getWebChapterNames(this.album.id);
            this.chapters = this.getChapters(this.album, this.chapter, result?.chapters);
            this.currentIndex = Math.max(0, this.chapters.findIndex((item) => String(item.id) === String(this.chapterId)));
            this.renderToolbar();
            const context = document.querySelector(".reader-comment-context");
            if (context) context.textContent = this.chapterName(this.chapters[this.currentIndex]);
        } catch {
            // Mobile API names and numbered fallbacks remain usable offline.
        }
    }

    url(item) {
        return `./reader.html?id=${encodeURIComponent(item.id)}&album=${encodeURIComponent(this.album.id)}&v=20260827-7`;
    }

    setLink(element, item) {
        if (item) {
            element.href = this.url(item);
            element.removeAttribute("aria-disabled");
        } else {
            element.removeAttribute("href");
            element.setAttribute("aria-disabled", "true");
        }
    }

    renderToolbar() {
        const current = this.chapters[this.currentIndex];
        const previous = this.chapters[this.currentIndex - 1];
        const next = this.chapters[this.currentIndex + 1];
        document.querySelector(".reader-back").href = `./chapter.html?id=${encodeURIComponent(this.album.id)}&v=20260827-7`;
        document.querySelector(".reader-title strong").textContent = this.album.name || "漫画阅读";
        document.querySelector(".reader-title span").textContent = `${this.chapterName(current)} · ${this.currentIndex + 1} / ${this.chapters.length}`;
        document.querySelector(".end-title").textContent = this.chapterName(current);
        document.title = `${this.chapterName(current)} · ${this.album.name || "JMComic"}`;

        const select = document.querySelector(".reader-chapter-select");
        select.innerHTML = this.chapters.map((item) => `<option value="${escapeHtml(item.id)}" ${String(item.id) === String(current.id) ? "selected" : ""}>${escapeHtml(this.chapterName(item))}</option>`).join("");
        select.onchange = () => {
            const selected = this.chapters.find((item) => String(item.id) === String(select.value));
            if (selected) location.href = this.url(selected);
        };

        this.setLink(document.querySelector(".prev-chapter"), previous);
        this.setLink(document.querySelector(".next-chapter"), next);
        this.setLink(document.querySelector(".end-prev"), previous);
        this.setLink(document.querySelector(".end-next"), next);
        document.querySelector(".end-prev").textContent = previous ? `← ${this.chapterName(previous)}` : "已经是第一章";
        document.querySelector(".end-next").textContent = next ? `${this.chapterName(next)} →` : "已经是最后一章";
    }

    setupComments() {
        const current = this.chapters[this.currentIndex];
        const section = document.querySelector(".reader-comments");
        const loadButton = section.querySelector(".comment-load");
        const commentInner = section.querySelector(".comment-inner");
        section.querySelector(".reader-comment-context").textContent = this.chapterName(current);
        section.hidden = false;

        let manager = null;
        loadButton.addEventListener("click", async () => {
            loadButton.disabled = true;
            loadButton.textContent = "正在载入…";
            commentInner.hidden = false;
            manager ||= new CleanCommentManager(section);
            const loaded = await manager.init(this.chapter, {
                commentId: this.chapterId,
                title: "本话评论",
                total: null,
            });
            loadButton.hidden = loaded;
            loadButton.disabled = false;
            loadButton.textContent = loaded ? "查看本话评论" : "重新载入评论";
        });
    }
}

new ReaderPage().init().catch((error) => {
    document.querySelector(".comic-content-cr").hidden = true;
    document.querySelector(".reader-end").hidden = true;
    document.querySelector(".progress-cr").hidden = true;
    renderPageError(".reader-loading", error, {
        title: "章节加载失败",
        className: "reader-error glass-card",
        linkHref: "./index.html",
        linkLabel: "返回首页",
    });
});
