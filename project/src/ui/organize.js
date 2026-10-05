import { localRuntime } from "../local/LocalRuntime.js";
import { comicCardHtml } from "./comic-card.js";
import { hydrateCovers } from "./covers.js";
import { authorsOf, asText, escapeHtml } from "./dom.js";
import { hydrateRichCards } from "./rich-cards.js";
import { showToast } from "./toast.js";
import { DEFAULT_LISTING_FILTERS } from "../utils/ListingFilters.js";

const CACHE_KIND = "organize";
const CACHE_AGE = 7 * 24 * 60 * 60;
const FILTER_KEYS = ["order", "time", "category", "mainTag", "hideSerial"];
// Filters that narrow the result set; the sort order only reorders the same set.
const MATCH_KEYS = ["time", "category", "mainTag", "hideSerial"];

/** Two FNV-1a passes give a short, path-safe cache key for a keyword + filter combination. */
const hashKey = (text) => {
    const pass = (seed) => {
        let hash = seed;
        for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
        return hash.toString(16).padStart(8, "0");
    };
    return `s${pass(2166136261)}${pass(3141592653)}`;
};

/** One grouping per keyword; default filter values keep the keys of groupings saved before filters were decoupled. */
export const organizeCacheKey = (query) => hashKey(JSON.stringify([
    String(query || "").trim().toLowerCase(),
    ...FILTER_KEYS.map((key) => String(DEFAULT_LISTING_FILTERS[key])),
]));

/**
 * Search-page "AI 整理": sends every known result to the configured model, which
 * groups them by series and writes a section title plus a note for each comic.
 * The grouping is cached for 7 days per keyword and restored on the next visit.
 * The sort order never changes the grouping; it only orders the trailing "未整理"
 * section of comics loaded after it. Time / category / single-chapter filters apply
 * to both: an organized comic stays visible only once the filtered feed returns it.
 */
export class ResultOrganizer {
    constructor({ button, view, results, hide }) {
        this.button = button;
        this.view = view;
        this.results = results;
        this.hide = hide;
        this.label = button.textContent.trim();
        this.generation = 0;
        this.key = "";
        this.organized = null;
        this.busy = false;
        this.filters = { ...DEFAULT_LISTING_FILTERS };
        this.matchKey = "";
        // Ids the feed returned under the current non-order filters.
        this.matched = new Set();
        button.addEventListener("click", () => {
            if (this.active) this.exit();
            else if (this.organized) this.show();
            else this.organize();
        });
        view.addEventListener("click", (event) => {
            if (event.target.closest("[data-reorganize]")) this.organize();
        });
        results.onAppend = (list) => {
            list.forEach((comic) => this.matched.add(String(comic.id)));
            this.applyFilters();
            this.appendUnorganized(list);
        };
    }

    get active() { return !this.view.hidden; }

    get filtering() {
        return MATCH_KEYS.some((key) => String(this.filters[key]) !== String(DEFAULT_LISTING_FILTERS[key]));
    }

    /** Restore the keyword's cached grouping, if any. */
    async restore() {
        const generation = ++this.generation;
        this.organized = null;
        this.setBusy(false);
        this.exit();
        this.key = organizeCacheKey(this.results.query);
        const cached = await localRuntime.readCache(CACHE_KIND, this.key, CACHE_AGE);
        if (generation !== this.generation || !Array.isArray(cached?.groups) || !Array.isArray(cached?.comics)) return;
        this.organized = this.normalize(cached, cached.comics);
        if (this.organized.groups.length) this.show();
        else this.organized = null;
    }

    /** Every comic we can show: the previous grouping (possibly from cache) plus everything loaded since. */
    knownComics() {
        const byId = new Map(this.organized?.comics ?? []);
        this.results.comics.forEach((comic) => byId.set(String(comic.id), comic));
        return [...byId.values()];
    }

    async organize() {
        if (this.busy) return;
        const comics = this.knownComics();
        if (!comics.length) {
            showToast("还没有可整理的作品", "warning");
            return;
        }
        const generation = ++this.generation;
        const key = this.key;
        this.setBusy(true, comics.length);
        try {
            const result = await localRuntime.organizeComics(comics.map((comic) => ({
                id: String(comic.id),
                title: asText(comic.name ?? comic.title),
                author: authorsOf(comic).join(" / "),
            })), this.results.query, { cacheKey: key, comics, force: Boolean(this.organized) });
            if (generation !== this.generation) return;
            this.organized = this.normalize(result, comics);
            this.setBusy(false);
            this.show();
            // The server saves the grouping (not this browser) so every device sees it.
            if (!result.cached) showToast("整理结果未能保存到服务器，其他设备看不到这次整理", "warning");
        } catch (error) {
            if (generation !== this.generation) return;
            this.setBusy(false);
            const message = error.message || "请稍后重试";
            showToast(/配置/.test(message) ? "请先在账号设置里配置 AI 模型（与 AI 标题翻译共用）" : `整理失败：${message}`, "error");
        }
    }

    /** Keep only groups/items whose comic data we hold; `comics` maps id → listing comic. */
    normalize(result, comics) {
        const byId = new Map(comics.map((comic) => [String(comic.id), comic]));
        const groups = (Array.isArray(result?.groups) ? result.groups : [])
            .map((group) => ({
                title: asText(group?.title, "未命名系列"),
                items: (Array.isArray(group?.items) ? group.items : [])
                    .filter((item) => byId.has(String(item?.id)))
                    .map((item) => ({ id: String(item.id), note: asText(item.note) })),
            }))
            .filter((group) => group.items.length);
        const placed = new Set(groups.flatMap((group) => group.items.map((item) => item.id)));
        for (const id of byId.keys()) if (!placed.has(id)) byId.delete(id);
        const savedAt = Number(result?.savedAt) || Date.now();
        return { groups, comics: byId, model: asText(result?.model), savedAt };
    }

    /** Call after the results were reset for new filters; the grouping itself is kept. */
    setFilters(filters) {
        this.filters = { ...filters };
        const matchKey = JSON.stringify(MATCH_KEYS.map((key) => String(filters[key] ?? "")));
        // A new sort order returns the same set, so earlier matches stay valid.
        if (matchKey !== this.matchKey) this.matched.clear();
        this.matchKey = matchKey;
        if (!this.active) return;
        const section = this.view.querySelector("[data-unorganized]");
        section.hidden = true;
        section.querySelector(".comic-grid").innerHTML = "";
        this.applyFilters();
    }

    unorganizedComics() {
        return this.results.comics.filter((comic) => !this.organized.comics.has(String(comic.id)));
    }

    show() {
        if (!this.organized) return;
        const { groups, comics, model, savedAt } = this.organized;
        const cards = (items) => items.map((item) => comicCardHtml(comics.get(item.id), { meta: item.note })).join("");
        const age = Date.now() - savedAt > 60 * 1000 ? ` · 整理于 ${new Date(savedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "";
        this.view.innerHTML = `<div class="organized-head">
                <p class="organized-summary">已将 ${comics.size} 部作品整理为 ${groups.length} 个栏目${model ? ` · ${escapeHtml(model)}` : ""}${age}<span data-filter-note></span></p>
                <button class="btn btn-outline btn-sm" type="button" data-reorganize>重新整理</button>
            </div>
            <p class="organized-hint" data-organized-empty hidden>当前筛选下还没有载入已整理的作品。</p>
            ${groups.map((group) => `<section class="section organized-group" data-group>
                <div class="section-head"><h2 class="section-title">${escapeHtml(group.title)}</h2><span class="section-meta" data-group-count>${group.items.length} 部</span></div>
                <div class="comic-grid">${cards(group.items)}</div>
            </section>`).join("")}
            <section class="section organized-group" data-unorganized hidden>
                <div class="section-head"><h2 class="section-title">未整理</h2><span class="section-meta" data-unorganized-count></span></div>
                <p class="organized-hint">这些作品在整理之后才载入，点击“重新整理”可纳入栏目。</p>
                <div class="comic-grid"></div>
            </section>`;
        this.view.hidden = false;
        this.hide.forEach((node) => { node.hidden = true; });
        this.button.textContent = "原始列表";
        this.button.setAttribute("aria-pressed", "true");
        this.applyFilters();
        this.appendUnorganized(this.unorganizedComics());
        hydrateCovers(this.view);
        hydrateRichCards(this.view);
        this.syncBusy();
    }

    /** Hide organized comics the current filters exclude, and groups left empty. */
    applyFilters() {
        if (!this.active || !this.organized) return;
        const filtering = this.filtering;
        let shown = 0;
        this.view.querySelectorAll("[data-group]").forEach((group) => {
            let count = 0;
            group.querySelectorAll(".comic-card").forEach((card) => {
                card.hidden = filtering && !this.matched.has(card.dataset.comicId);
                if (!card.hidden) count++;
            });
            group.hidden = !count;
            group.querySelector("[data-group-count]").textContent = `${count} 部`;
            shown += count;
        });
        this.view.querySelector("[data-filter-note]").textContent = filtering ? ` · 当前筛选显示 ${shown} 部` : "";
        this.view.querySelector("[data-organized-empty]").hidden = !filtering || shown > 0;
    }

    /** Newly loaded comics that the current grouping does not cover. */
    appendUnorganized(list) {
        if (!this.active || !this.organized) return;
        const fresh = list.filter((comic) => !this.organized.comics.has(String(comic.id)));
        if (!fresh.length) return;
        const section = this.view.querySelector("[data-unorganized]");
        const grid = section.querySelector(".comic-grid");
        grid.insertAdjacentHTML("beforeend", fresh.map((comic) => comicCardHtml(comic)).join(""));
        section.hidden = false;
        section.querySelector("[data-unorganized-count]").textContent = `${grid.children.length} 部`;
        hydrateCovers(grid);
        hydrateRichCards(grid);
    }

    /** Return to the plain grid; the grouping stays available for the toolbar button. */
    exit() {
        this.view.hidden = true;
        this.view.innerHTML = "";
        this.hide.forEach((node) => { node.hidden = false; });
        this.button.setAttribute("aria-pressed", "false");
        this.syncBusy();
    }

    setBusy(busy, count = 0) {
        this.busy = busy;
        this.busyCount = count;
        this.syncBusy();
    }

    syncBusy() {
        const label = this.busy ? `正在整理 ${this.busyCount} 部…` : "";
        this.button.disabled = this.busy;
        this.button.setAttribute("aria-busy", String(this.busy));
        this.button.textContent = label || (this.active ? "原始列表" : this.organized ? "整理视图" : this.label);
        const again = this.view.querySelector("[data-reorganize]");
        if (again) {
            again.disabled = this.busy;
            again.textContent = label || "重新整理";
        }
    }
}
