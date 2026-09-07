import { readLocalStorage, removeLocalStorage, writeLocalStorage } from "../utils/BrowserStorage.js";

const HISTORY_KEY = "jm_reading_history_v2";
const RANDOM_HISTORY_KEY = "jm_random_history_v1";
const RANDOM_HISTORY_LIMIT = 200;

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
    getHistory() { return readList(HISTORY_KEY); }

    recordHistory(album) {
        const item = normalizeAlbum(album);
        const list = this.getHistory().filter((entry) => entry.id !== item.id);
        list.unshift(item);
        writeLocalStorage(HISTORY_KEY, JSON.stringify(list.slice(0, 100)));
        this.#notify();
    }

    clearHistory() {
        removeLocalStorage(HISTORY_KEY);
        this.#notify();
    }

    getRandomHistory() { return readList(RANDOM_HISTORY_KEY); }

    recordRandomHistory(album) {
        const item = normalizeRandomAlbum(album);
        const list = this.getRandomHistory().filter((entry) => String(entry.id) !== item.id);
        list.unshift(item);
        writeLocalStorage(RANDOM_HISTORY_KEY, JSON.stringify(list.slice(0, RANDOM_HISTORY_LIMIT)));
        this.#notify();
        return item;
    }

    clearRandomHistory() {
        removeLocalStorage(RANDOM_HISTORY_KEY);
        this.#notify();
    }

    #notify() { window.dispatchEvent(new CustomEvent("jm-library-change")); }
}

export const libraryStore = new LibraryStore();
