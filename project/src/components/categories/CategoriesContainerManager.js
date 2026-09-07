import { jmApi } from "../../api/JmcomicApi.js";
import { lazyLoader } from "../../dom/LazyLoader.js";
import { keepSingleChapterComics } from "../../utils/ComicChapterFilter.js";
import { listingFilterSummary } from "../../utils/ListingFilters.js";
import { InfinityScrollContainer } from "../general/InfinityScrollContainer.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

export class CategoriesContainerManager {
    constructor() {
        this.containerDom = document.querySelector(".categories-body");
        this.stateDom = document.querySelector(".ranking-state");
        this.scrollContainer = new InfinityScrollContainer({
            container: this.containerDom,
            threshold: 120,
            coolingTime: 500,
            loadContent: (page) => this.loadContent(page),
        });
        this.requestVersion = 0;
    }

    init() {
        this.scrollContainer.init({ loadInitial: false });
    }

    setFilters(filters) {
        this.filters = filters;
    }

    research() {
        clearTimeout(this.researchTimer);
        const version = ++this.requestVersion;
        this.scrollContainer.reset({ maxPageIndex: 0 });
        this.researchTimer = setTimeout(() => {
            if (version !== this.requestVersion) return;
            this.containerDom.innerHTML = '<div class="loading-icon"><i></i><span>正在载入分类内容</span></div>';
            this.stateDom.textContent = `正在读取 · ${listingFilterSummary(this.filters)}`;
            lazyLoader.clear();
            this.scrollContainer.resetAndLoad();
        }, 180);
    }

    async loadContent(page, version = this.requestVersion) {
        if (!this.filters) return;
        const filters = { ...this.filters };
        if (page === 1 && !this.containerDom.querySelector(".loading-icon")) {
            this.containerDom.innerHTML = '<div class="loading-icon"><i></i><span>正在载入分类内容</span></div>';
        }
        try {
            const list = await jmApi.getFilteredComics("", page, filters);
            if (version !== this.requestVersion) return;
            const content = Array.isArray(list?.content) ? list.content : [];
            if (filters.hideSerial && content.length) this.stateDom.textContent = "正在核对章节数";
            const visibleContent = await keepSingleChapterComics(content, filters.hideSerial);
            if (version !== this.requestVersion) return;
            this.containerDom.querySelector(".loading-icon")?.remove();
            const total = Number(list?.total || content.length);
            this.scrollContainer.maxPageIndex = Math.max(1, Math.ceil(total / 80));
            const summary = listingFilterSummary(filters);
            this.stateDom.textContent = filters.hideSerial
                ? `${summary} · ${total.toLocaleString("zh-CN")} 条候选 · 本页 ${visibleContent.length} 个单章`
                : `${summary} · ${total.toLocaleString("zh-CN")} 条作品`;
            if (!visibleContent.length && page === 1) {
                this.containerDom.innerHTML = '<div class="category-empty">当前组合下没有符合条件的作品</div>';
                return;
            }
            this.appendComics(visibleContent);
        } catch (error) {
            if (version !== this.requestVersion) return;
            this.stateDom.textContent = "分类内容暂时不可用";
            if (page === 1) this.containerDom.innerHTML = `<div class="category-empty">${escapeHtml(error.message || "请稍后重试")}</div>`;
            throw error;
        }
    }

    appendComics(list) {
        this.containerDom.querySelector(".category-empty")?.remove();
        const container = document.createElement("div");
        container.className = "comics-cr";
        container.innerHTML = list.map((comic) => `<div class="comic-item">
            <a class="cover" data-src="${jmApi.getCoverImageURL(comic.id)}" href="./chapter.html?id=${encodeURIComponent(comic.id)}&v=20260827-7"><img alt="${escapeHtml(comic.name || "漫画封面")}" /><div class="tags"></div></a>
            <h1 class="c-title">${escapeHtml(comic.name)}</h1><h2 class="c-sr-title">${escapeHtml(Array.isArray(comic.author) ? comic.author.join(" · ") : comic.author)}</h2>
        </div>`).join("");
        this.containerDom.appendChild(container);
        container.querySelectorAll(".cover").forEach((cover) => lazyLoader.addCover(cover));
    }
}
