import { jmApi } from "../api/JmcomicApi.js";
import { mountShell } from "./shell.js";
import { ListingFilterPanel, ListingResults } from "./listing.js";
import { renderPageError } from "./states.js";
import { showToast } from "./toast.js";
import { searchUrl } from "./dom.js";
export async function mountListing(search = false) {
    mountShell();
    const query = search ? new URLSearchParams(location.search).get("sq") || "" : "";
    if (search) {
        document.querySelector("[data-query-title]").textContent = query ? `“${query}”` : "搜索作品";
        const form = document.querySelector(".listing-search");
        form.elements.q.value = query;
        form.addEventListener("submit", (event) => { event.preventDefault(); if (form.elements.q.value.trim()) location.assign(searchUrl(form.elements.q.value.trim())); });
    }
    try {
        await jmApi.init();
        const results = new ListingResults({ grid: document.querySelector("[data-results]"), footer: document.querySelector("[data-feed]"), state: document.querySelector("[data-result-state]"), query });
        const filters = new ListingFilterPanel({ panel: document.querySelector(".filter-panel"), toggle: document.querySelector("[data-filter-toggle]"), reset: document.querySelector("[data-filter-reset]"), onChange: (value) => results.setFilters(value) });
        filters.init();
        filters.loadCategories().catch((error) => showToast(`分类暂时不可用：${error.message}`, "warning"));
        await results.feed.restart();
    } catch (error) { renderPageError("[data-results]", error); }
}
