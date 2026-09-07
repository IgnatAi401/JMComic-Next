import { jmApi } from "../../api/JmcomicApi.js";
import { lazyLoader } from "../../dom/LazyLoader.js";
import { keepSingleChapterComics } from "../../utils/ComicChapterFilter.js";
import { DEFAULT_LISTING_FILTERS, reconcileListingFilters } from "../../utils/ListingFilters.js";
import { InfinityScrollContainer } from "../general/InfinityScrollContainer.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

export class SearchContainerManager {
    constructor(searchQuery) {
        this.searchQuery = searchQuery;
        this.filters = { ...DEFAULT_LISTING_FILTERS };
        this.categories = [];
        this.requestVersion = 0;
        this.renderedIds = new Set();
        this.containerDom = document.querySelector(".search-cr");
        this.loadingIconDom = this.containerDom.querySelector(".loading-icon");
        this.resultStateDom = document.querySelector(".result-state");
        this.scrollContainer = new InfinityScrollContainer({
            container: this.containerDom,
            threshold: 120,
            coolingTime: 500,
            loadContent: (page) => this.loadContent(page),
        });
    }

    init() {
        this.bindFilters();
        this.scrollContainer.init();
        this.loadCategories();
    }

    async loadCategories() {
        try {
            const data = await jmApi.getCategories();
            this.categories = Array.isArray(data.categories) ? data.categories : [];
            const categoryOptions = document.querySelector('[data-filter="category"] .filter-options');
            categoryOptions.innerHTML = '<button class="filter-choice active" data-value="0" type="button">全部</button>'
                + this.categories.filter((item) => item?.type === "slug" && item.slug).map((item) =>
                    `<button class="filter-choice" data-value="${escapeHtml(item.slug)}" type="button">${escapeHtml(item.name)}</button>`
                ).join("");
            if (this.filters.category !== "0") this.renderSubcategories(this.filters.category);
            this.syncFilterControls();
        } catch {
            // Keyword search remains usable even if the optional taxonomy request fails.
        }
    }

    bindFilters() {
        document.querySelector(".search-filter-card").addEventListener("click", (event) => {
            const button = event.target.closest(".filter-choice");
            if (!button) return;
            const row = button.closest("[data-filter]");
            const filter = row.dataset.filter;
            row.querySelector(".active")?.classList.remove("active");
            button.classList.add("active");
            if (filter === "mainTag") {
                this.filters.mainTag = button.dataset.value;
                this.filters.subcategorySlug = button.dataset.slug || "";
            } else {
                this.filters[filter] = button.dataset.value;
            }
            if (filter === "category") {
                this.filters.mainTag = "0";
                this.filters.subcategorySlug = "";
                this.renderSubcategories(button.dataset.value);
            }
            this.filters = reconcileListingFilters(this.filters, filter);
            this.syncFilterControls();
            this.research();
        });
        document.querySelector(".serial-toggle").addEventListener("change", (event) => {
            this.filters.hideSerial = event.currentTarget.checked;
            this.research();
        });
        document.querySelector(".clear-filters").addEventListener("click", () => this.resetFilters());
    }

    renderSubcategories(categorySlug) {
        const row = document.querySelector(".search-subcategory-row");
        const container = document.querySelector(".search-subcategories");
        const category = this.categories.find((item) => String(item.slug) === String(categorySlug));
        const subcategories = Array.isArray(category?.sub_categories) ? category.sub_categories : [];
        row.hidden = !subcategories.length;
        container.innerHTML = subcategories.length
            ? `<button class="filter-choice active" data-value="0" data-slug="" type="button">全部</button>${subcategories.map((item) => `<button class="filter-choice" data-value="${escapeHtml(item.CID)}" data-slug="${escapeHtml(item.slug || "")}" type="button">${escapeHtml(item.name)}</button>`).join("")}`
            : "";
    }

    syncFilterControls() {
        document.querySelectorAll(".search-filter-row[data-filter]").forEach((row) => {
            const filter = row.dataset.filter;
            const value = String(this.filters[filter] ?? "");
            row.querySelectorAll(".filter-choice").forEach((button) => {
                button.classList.toggle("active", button.dataset.value === value);
            });
        });
        const periodActive = this.filters.time !== "a";
        document.querySelectorAll('[data-filter="order"] .filter-choice').forEach((button) => {
            button.disabled = periodActive && button.dataset.value !== "mv";
        });
        const nonViewOrder = this.filters.order !== "mv";
        document.querySelectorAll('[data-filter="time"] .filter-choice').forEach((button) => {
            button.disabled = nonViewOrder && button.dataset.value !== "a";
        });
    }

    resetFilters() {
        this.filters = { ...DEFAULT_LISTING_FILTERS };
        document.querySelectorAll(".search-filter-row").forEach((row) => {
            row.querySelector(".active")?.classList.remove("active");
            const filter = row.dataset.filter;
            const defaultValue = filter === "order" ? "mv" : (filter === "time" ? "a" : "0");
            row.querySelector(`.filter-choice[data-value="${defaultValue}"]`)?.classList.add("active");
        });
        document.querySelector(".search-subcategory-row").hidden = true;
        document.querySelector(".search-subcategories").innerHTML = "";
        document.querySelector(".serial-toggle").checked = false;
        this.syncFilterControls();
        this.research();
    }

    research() {
        clearTimeout(this.researchTimer);
        const version = ++this.requestVersion;
        this.scrollContainer.reset({ maxPageIndex: 0 });
        this.researchTimer = setTimeout(() => {
            if (version !== this.requestVersion) return;
            this.containerDom.replaceChildren(this.loadingIconDom);
            this.loadingIconDom.style.display = "flex";
            this.resultStateDom.textContent = "正在应用筛选";
            this.renderedIds.clear();
            lazyLoader.clear();
            this.scrollContainer.resetAndLoad();
        }, 220);
    }

    async loadContent(page, version = this.requestVersion) {
        const filters = { ...this.filters };
        if (page === 1) this.containerDom.querySelector(".search-empty")?.remove();
        this.loadingIconDom.style.display = "flex";
        try {
            if (page === 1 && /^\d+$/.test(this.searchQuery) && Number(this.searchQuery) > 10 && filters.category === "0" && filters.time === "a") {
                try {
                    const album = await jmApi.getComicAlbum(this.searchQuery);
                    const direct = await keepSingleChapterComics([album], filters.hideSerial);
                    if (version === this.requestVersion && direct[0]?.name) this.appendComics(direct);
                } catch { /* Keyword results below remain authoritative. */ }
            }

            const list = await jmApi.getFilteredComics(this.searchQuery, page, filters);
            if (version !== this.requestVersion) return;
            const content = Array.isArray(list.content) ? list.content : [];
            if (filters.hideSerial && content.length) this.resultStateDom.textContent = "正在核对章节数";
            const visibleContent = await keepSingleChapterComics(content, filters.hideSerial);
            if (version !== this.requestVersion) return;
            this.scrollContainer.maxPageIndex = Math.max(1, Math.ceil(Number(list.total || content.length) / 80));
            const totalLabel = Number(list.total || content.length).toLocaleString("zh-CN");
            this.resultStateDom.textContent = filters.hideSerial
                ? `${totalLabel} 条候选 · 本页 ${visibleContent.length} 个单章`
                : `${totalLabel} 条结果`;
            this.loadingIconDom.style.display = "none";
            if (visibleContent.length) this.appendComics(visibleContent);
            else if (page === 1 && this.renderedIds.size === 0) this.containerDom.insertAdjacentHTML("beforeend", '<div class="search-empty">没有符合当前组合条件的作品</div>');
        } catch (error) {
            if (version !== this.requestVersion) return;
            this.loadingIconDom.style.display = "none";
            this.resultStateDom.textContent = "搜索暂时不可用";
            if (page === 1) {
                this.containerDom.querySelector(".search-empty")?.remove();
                this.containerDom.insertAdjacentHTML("beforeend", `<div class="search-empty">${escapeHtml(error.message || "请稍后重试")}</div>`);
            }
            throw error;
        }
    }

    appendComics(list) {
        const unique = list.filter((comic) => {
            const id = String(comic?.id ?? "");
            if (!id || this.renderedIds.has(id)) return false;
            this.renderedIds.add(id);
            return true;
        });
        if (!unique.length) return 0;
        const container = document.createElement("div");
        container.className = "comics-cr";
        container.innerHTML = unique.map((comic) => `<div class="comic-item">
            <a class="cover" data-src="${jmApi.getCoverImageURL(comic.id)}" href="./chapter.html?id=${encodeURIComponent(comic.id)}&v=20260827-7">
                <img alt="${escapeHtml(comic.name || "漫画封面")}" /><div class="tags"></div>
            </a>
            <h1 class="c-title">${escapeHtml(comic.name)}</h1>
            <h2 class="c-sr-title">${escapeHtml(Array.isArray(comic.author) ? comic.author.join(" · ") : comic.author)}</h2>
        </div>`).join("");
        this.containerDom.appendChild(container);
        container.querySelectorAll(".cover").forEach((cover) => lazyLoader.addCover(cover));
        return unique.length;
    }
}
