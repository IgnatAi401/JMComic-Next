import { jmApi } from "../../api/JmcomicApi.js";
import { DEFAULT_LISTING_FILTERS, reconcileListingFilters } from "../../utils/ListingFilters.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

export class CategoriesHeadManager {
    constructor() {
        this.headDom = document.querySelector(".categories-head");
        this.categoryDom = this.headDom.querySelector('[data-filter="category"] .filter-options');
        this.subcategoryRow = this.headDom.querySelector(".category-subcategory-row");
        this.subcategoryDom = this.headDom.querySelector(".category-subcategories");
        this.filters = { ...DEFAULT_LISTING_FILTERS };
        this.categories = [];
    }

    async init() {
        const data = await jmApi.getCategories();
        this.categories = Array.isArray(data?.categories) ? data.categories : [];
        this.renderCategories();
        this.bindEvents();
        this.syncFilterControls();
        this.emitChange();
    }

    renderCategories() {
        this.categoryDom.innerHTML = '<button class="filter-choice active" data-value="0" type="button">全部</button>'
            + this.categories.filter((item) => item?.type === "slug" && item.slug).map((item) =>
                `<button class="filter-choice" data-value="${escapeHtml(item.slug)}" type="button">${escapeHtml(item.name)}</button>`
            ).join("");
    }

    bindEvents() {
        this.headDom.addEventListener("click", (event) => {
            const button = event.target.closest(".filter-choice");
            if (!button || button.disabled || button.classList.contains("active")) return;
            const row = button.closest("[data-filter]");
            if (!row) return;
            const filter = row.dataset.filter;
            if (filter === "mainTag") {
                this.filters.mainTag = button.dataset.value;
                this.filters.subcategorySlug = button.dataset.slug || "";
            } else {
                this.filters[filter] = button.dataset.value;
            }
            if (filter === "category") {
                this.filters.mainTag = "0";
                this.filters.subcategorySlug = "";
                this.renderSubcategories();
            }
            this.filters = reconcileListingFilters(this.filters, filter);
            this.syncFilterControls();
            this.emitChange();
        });
        this.headDom.querySelector(".serial-toggle").addEventListener("change", (event) => {
            this.filters.hideSerial = event.currentTarget.checked;
            this.emitChange();
        });
        document.querySelector(".clear-category-filters").addEventListener("click", () => this.reset());
    }

    renderSubcategories() {
        const category = this.categories.find((item) => String(item.slug) === this.filters.category);
        const subcategories = Array.isArray(category?.sub_categories) ? category.sub_categories : [];
        this.subcategoryRow.hidden = !subcategories.length;
        this.subcategoryDom.innerHTML = subcategories.length
            ? `<button class="filter-choice active" data-value="0" data-slug="" type="button">全部</button>${subcategories.map((item) => `<button class="filter-choice" data-value="${escapeHtml(item.CID)}" data-slug="${escapeHtml(item.slug || "")}" type="button">${escapeHtml(item.name)}</button>`).join("")}`
            : "";
    }

    syncFilterControls() {
        this.headDom.querySelectorAll("[data-filter]").forEach((row) => {
            const filter = row.dataset.filter;
            const value = String(this.filters[filter] ?? "");
            row.querySelectorAll(".filter-choice").forEach((button) => {
                button.classList.toggle("active", button.dataset.value === value);
            });
        });
        const periodActive = this.filters.time !== "a";
        this.headDom.querySelectorAll('[data-filter="order"] .filter-choice').forEach((button) => {
            button.disabled = periodActive && button.dataset.value !== "mv";
        });
        const nonViewOrder = this.filters.order !== "mv";
        this.headDom.querySelectorAll('[data-filter="time"] .filter-choice').forEach((button) => {
            button.disabled = nonViewOrder && button.dataset.value !== "a";
        });
    }

    reset() {
        this.filters = { ...DEFAULT_LISTING_FILTERS };
        this.subcategoryRow.hidden = true;
        this.subcategoryDom.innerHTML = "";
        this.headDom.querySelector(".serial-toggle").checked = false;
        this.syncFilterControls();
        this.emitChange();
    }

    emitChange() {
        this.onFilterUpdate({ ...this.filters });
    }

    onFilterUpdate() {}
}
