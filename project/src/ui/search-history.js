import { localRuntime } from "../local/LocalRuntime.js";
import { escapeHtml } from "./dom.js";
import { icon } from "./icons.js";

/**
 * Recent search keywords stored by the local backend. Every search box shares one
 * cached list; each change re-renders the open dropdowns and history sections.
 */
const MAX_SHOWN = 10;
let items = null;
let pending = null;
const listeners = new Set();

const notify = () => listeners.forEach((listener) => listener());
const set = (next) => { items = Array.isArray(next) ? next : []; notify(); };

function load() {
    pending ||= localRuntime.getSearchHistory().then(set).catch(() => set([]));
    return pending;
}

/** Store a searched keyword. Never rejects; a failed save leaves the list unchanged. */
export async function rememberSearch(query) {
    const clean = String(query || "").trim();
    if (!clean) return;
    try { set(await localRuntime.recordSearch(clean)); } catch { /* Searching still works without history. */ }
}

async function remove(query) {
    try { set(await localRuntime.removeSearchHistory(query)); } catch { /* Keep the list as it was. */ }
}

const matches = (filter) => {
    const needle = String(filter || "").trim().toLowerCase();
    return (items || []).filter((item) => !needle || item.query.toLowerCase().includes(needle)).slice(0, MAX_SHOWN);
};

const listHtml = (list) => `<ul class="search-history-list">${list.map(({ query }) => `<li>
    <button class="search-history-pick" type="button" data-history-pick="${escapeHtml(query)}">${icon("latest")}<span>${escapeHtml(query)}</span></button>
    <button class="search-history-remove" type="button" data-history-remove="${escapeHtml(query)}" aria-label="删除搜索记录 ${escapeHtml(query)}" title="删除">${icon("close")}</button>
</li>`).join("")}</ul>`;

function handleClick(event, onPick) {
    const removeButton = event.target.closest("[data-history-remove]");
    if (removeButton) { remove(removeButton.dataset.historyRemove); return true; }
    if (event.target.closest("[data-history-clear]")) { remove(null); return true; }
    const pick = event.target.closest("[data-history-pick]");
    if (pick) { onPick(pick.dataset.historyPick); return true; }
    return false;
}

/** Inline "最近搜索" block, used inside the search sheet. Hidden while the list is empty. */
export function mountSearchHistorySection(container, onPick) {
    const render = () => {
        const list = matches("");
        container.hidden = !list.length;
        container.innerHTML = list.length
            ? `<div class="search-history-head"><h3 class="sheet-section-title">最近搜索</h3><button class="btn btn-ghost btn-sm" type="button" data-history-clear>清空</button></div>${listHtml(list)}`
            : "";
    };
    container.addEventListener("click", (event) => handleClick(event, onPick));
    listeners.add(render);
    render();
    load();
}

/** A dropdown of recent searches under `form`'s input, filtered by what has been typed. */
export function attachSearchHistory(form, onPick) {
    const input = form.querySelector("input");
    const pop = document.createElement("div");
    pop.className = "search-history-pop";
    pop.hidden = true;
    form.append(pop);
    let open = false;
    const render = () => {
        const list = open ? matches(input.value) : [];
        pop.hidden = !list.length;
        pop.innerHTML = list.length
            ? `${listHtml(list)}<div class="search-history-foot"><span>最近搜索</span><button type="button" data-history-clear>清空记录</button></div>`
            : "";
    };
    let blurTimer = 0;
    const show = () => { clearTimeout(blurTimer); open = true; render(); load(); };
    const hide = () => { clearTimeout(blurTimer); open = false; render(); };
    input.addEventListener("focus", show);
    input.addEventListener("input", () => { if (open) render(); else show(); });
    // A short delay lets a tap on an entry land first; iOS may blur before the click.
    input.addEventListener("blur", () => { blurTimer = setTimeout(hide, 180); });
    input.addEventListener("keydown", (event) => { if (event.key === "Escape" && open) { event.stopPropagation(); hide(); } });
    pop.addEventListener("mousedown", (event) => event.preventDefault());
    pop.addEventListener("click", (event) => {
        let picked = false;
        if (!handleClick(event, (query) => { picked = true; input.value = query; hide(); onPick(query); })) return;
        if (!picked) { clearTimeout(blurTimer); input.focus(); }
    });
    listeners.add(render);
}
