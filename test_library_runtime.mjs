import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./project/src/pages/library.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/new LibraryPage\(\)\.init\(\)\.catch\([^\n]+\);/, "");
const LibraryPage = vm.runInNewContext(`${source}\nLibraryPage;`);

test("rating filters include every comic with the selected score", () => {
    const page = new LibraryPage();
    page.localRatings = [
        ...Array.from({ length: 5001 }, (_, id) => ({ id, rating: 10 })),
        { id: "low", rating: 1 },
    ];
    assert.equal(page.filteredRatings().length, 5002);
    page.ratingFilter = "10";
    assert.equal(page.filteredRatings().length, 5001);
    page.ratingFilter = "1";
    assert.equal(page.filteredRatings()[0].id, "low");
    page.ratingFilter = "5";
    assert.equal(page.filteredRatings().length, 0);
    page.ratingFilters = { innerHTML: "" };
    page.renderRatingFilters();
    assert.match(page.ratingFilters.innerHTML, /10 分<span>5001<\/span>/);
    assert.match(page.ratingFilters.innerHTML, /data-rating="5" class="active" aria-pressed="true">5 分<span>0<\/span>/);
    assert.doesNotMatch(page.ratingFilters.innerHTML, /unrated|未评分/);
});

const storeSource = readFileSync(new URL("./project/src/data/LibraryStore.js", import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "").replace("export const libraryStore", "const libraryStore");
function createStore(request, storage) {
    return vm.runInNewContext(`${storeSource}\nlibraryStore;`, {
        localRuntime: { request },
        readLocalStorage: (key, fallback = null) => storage.get(key) ?? fallback,
        removeLocalStorage: (key) => storage.delete(key),
        window: { dispatchEvent() {} }, CustomEvent: class {},
    });
}
test("legacy history survives failed import, retries and only removes acknowledged data", async () => {
    const key = "jm_reading_history_v2";
    const item = { id: "1", savedAt: 10 };
    const storage = new Map([[key, JSON.stringify([item])]]);
    let fail = true;
    const store = createStore(async (url, options) => {
        if (fail) throw new Error("offline");
        return { items: options?.body?.items || [] };
    }, storage);
    await assert.rejects(store.init(), /offline/);
    assert.ok(storage.has(key));
    fail = false;
    await store.init();
    assert.equal(storage.has(key), false);
    assert.equal(store.getHistory()[0].id, "1");
});
test("concurrent legacy edits remain and failed clear does not erase loaded history", async () => {
    const key = "jm_reading_history_v2";
    const storage = new Map([[key, JSON.stringify([{ id: "1", savedAt: 10 }])]]);
    const store = createStore(async (url, options) => {
        if (options?.method === "DELETE") throw new Error("offline");
        if (options?.body?.legacy) storage.set(key, JSON.stringify([{ id: "2", savedAt: 20 }]));
        return { items: options?.body?.items || [] };
    }, storage);
    await store.init();
    assert.ok(storage.has(key));
    await assert.rejects(store.clearHistory(), /offline/);
    assert.equal(store.getHistory()[0].id, "1");
});
test("writes are serialized and another browser reads the same backend history", async () => {
    const lists = { reading: [], random: [], later: [] };
    const request = async (url, options) => {
        const kind = url.split("=")[1];
        if (options?.method === "DELETE") lists[kind] = [];
        else if (options?.body) lists[kind] = [...options.body.items, ...lists[kind]];
        return { items: [...lists[kind]] };
    };
    const store = createStore(request, new Map());
    await Promise.all([store.recordHistory({ id: "1" }), store.recordHistory({ id: "2" })]);
    const other = createStore(request, new Map());
    await other.init();
    assert.equal(other.getHistory().length, 2);
    await other.clearHistory();
    const third = createStore(request, new Map());
    await third.init();
    assert.equal(third.getHistory().length, 0);
});
test("watch later adds, reports membership and removes a single comic", async () => {
    const lists = { reading: [], random: [], later: [] };
    const calls = [];
    const store = createStore(async (url, options) => {
        const params = new URLSearchParams(url.split("?")[1]);
        const kind = params.get("kind");
        calls.push([options?.method || "GET", url]);
        if (options?.method === "DELETE") lists[kind] = params.has("id") ? lists[kind].filter((item) => item.id !== params.get("id")) : [];
        else if (options?.body) lists[kind] = [...options.body.items, ...lists[kind]];
        return { items: [...lists[kind]] };
    }, new Map());
    await store.addWatchLater({ id: 7, name: "示例", author: ["作者"] });
    await store.addWatchLater({ id: 8 });
    assert.equal(store.isWatchLater("7"), true);
    assert.deepEqual(Array.from(store.getWatchLater()[1].author), ["作者"]);
    await store.removeWatchLater(7);
    assert.equal(store.isWatchLater("7"), false);
    assert.equal(store.getWatchLater().length, 1);
    assert.ok(calls.some(([method, url]) => method === "DELETE" && url.endsWith("kind=later&id=7")));
});
