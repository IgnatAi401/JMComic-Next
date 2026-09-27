import { localRuntime } from "../local/LocalRuntime.js";
import { readLocalStorage, removeLocalStorage } from "../utils/BrowserStorage.js";

const HISTORY_KEY = "jm_reading_history_v2";
const RANDOM_HISTORY_KEY = "jm_random_history_v1";

function readList(key) {
    try {
        const value = JSON.parse(readLocalStorage(key, "[]"));
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

function normalizeAlbum(album) {
    return {
        id: String(album.id),
        name: album.name || "未命名作品",
        author: Array.isArray(album.author) ? album.author.join(" & ") : (album.author || "未知作者"),
        savedAt: Date.now(),
    };
}

function normalizeRandomAlbum(album) {
    const authors = Array.isArray(album.author)
        ? album.author.filter(Boolean).map(String)
        : (Array.isArray(album.authors)
            ? album.authors.filter(Boolean).map(String)
            : (album.author || album.authors ? [String(album.author || album.authors)] : []));
    const tags = Array.isArray(album.tags) ? album.tags.filter(Boolean).map(String) : [];
    return {
        id: String(album.id),
        name: album.name || album.title || `漫画 #${album.id}`,
        author: authors,
        tags,
        description: album.description || "",
        chapters: Number(album.chapters || (Array.isArray(album.series) && album.series.length) || 1),
        total_photos: album.total_photos ?? null,
        comment_total: album.comment_total ?? 0,
        addtime: Number(album.addtime) || 0,
        cover_url: album.cover_url || album.coverUrl || "",
        savedAt: Number(album.savedAt) || Date.now(),
    };
}

class LibraryStore {
    lists = { reading: [], random: [] };
    pending = null;
    queue = Promise.resolve();

    init() {
        if (this.pending) return this.pending;
        this.pending = this.#load().catch((error) => {
            this.pending = null;
            throw error;
        });
        return this.pending;
    }

    async #load() {
        for (const [kind, key] of [["reading", HISTORY_KEY], ["random", RANDOM_HISTORY_KEY]]) {
            const original = readLocalStorage(key);
            const items = readList(key);
            const result = await localRuntime.request(`./local-api/library/history?kind=${kind}`, items.length
                ? { method: "POST", body: { items, legacy: true } } : {});
            this.lists[kind] = result.items;
            // Keep legacy data on failure or if another tab changed it during import.
            if (items.length && readLocalStorage(key) === original) removeLocalStorage(key);
        }
        this.#notify();
    }

    getHistory() { return this.lists.reading; }
    getRandomHistory() { return this.lists.random; }

    #mutate(kind, items, clear = false) {
        const operation = this.queue.then(async () => {
            await this.init();
            const result = await localRuntime.request(`./local-api/library/history?kind=${kind}`, clear
                ? { method: "DELETE" } : { method: "POST", body: { items } });
            this.lists[kind] = result.items;
            this.#notify();
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    recordHistory(album) { return this.#mutate("reading", [normalizeAlbum(album)]); }
    recordRandomHistory(album) { return this.#mutate("random", [normalizeRandomAlbum(album)]); }
    clearHistory() { return this.#mutate("reading", [], true); }
    clearRandomHistory() { return this.#mutate("random", [], true); }
    #notify() { window.dispatchEvent(new CustomEvent("jm-library-change")); }
}

export const libraryStore = new LibraryStore();
