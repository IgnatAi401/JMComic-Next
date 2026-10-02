class LocalRuntime {
    async request(path, { method = "GET", body = null, allowMissing = false, timeoutMs = 3000 } = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(path, {
                method,
                headers: body ? { "Content-Type": "application/json" } : undefined,
                body: body ? JSON.stringify(body) : undefined,
                cache: "no-store",
                signal: controller.signal,
            });
            if (allowMissing && response.status === 404) return null;
            let data;
            try {
                data = await response.json();
            } catch (error) {
                if (error?.name === "AbortError" || controller.signal.aborted) throw error;
                if (response.ok) throw new Error("本地服务返回了无效数据，请稍后重试");
                data = {};
            }
            if (!response.ok) {
                const error = new Error(data.error || `本地服务错误 ${response.status}`);
                error.status = response.status;
                throw error;
            }
            return data;
        } catch (error) {
            if (error?.name === "AbortError") throw new Error("本地服务响应超时");
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    getAccountSummary() {
        return this.request("./local-api/account");
    }

    loginAccount(username, password, servers) {
        return this.request("./local-api/auth/login", {
            method: "POST",
            body: { username, password, servers },
            timeoutMs: 130000,
        });
    }

    ensureAccountSession(servers) {
        return this.request("./local-api/auth/session", {
            method: "POST",
            body: { servers },
            timeoutMs: 130000,
        });
    }

    clearAccount() {
        return this.request("./local-api/account", { method: "DELETE" });
    }

    getWebChapterNames(albumId) {
        return this.request(`./local-api/chapter-names?id=${encodeURIComponent(albumId)}`, {
            timeoutMs: 90000,
        });
    }

    getTranslationConfig() { return this.request("./local-api/translation/config"); }

    saveTranslationConfig(config) {
        return this.request("./local-api/translation/config", { method: "POST", body: config });
    }

    testTranslationConfig(config) {
        return this.request("./local-api/translation/test", {
            method: "POST", body: config, timeoutMs: 130000,
        });
    }

    clearTranslationConfig() { return this.request("./local-api/translation/config", { method: "DELETE" }); }

    translateTitle(title) {
        return this.request("./local-api/translation", {
            method: "POST", body: { title }, timeoutMs: 130000,
        });
    }

    /** Ask the configured model to group listing comics by series; `items` are `{ id, title, author }`. */
    organizeComics(items, query = "") {
        return this.request("./local-api/organize", {
            method: "POST", body: { items, query }, timeoutMs: 250000,
        });
    }

    async getRating(id) {
        return (await this.request(`./local-api/ratings?id=${encodeURIComponent(id)}`)).rating;
    }

    async getRatings() {
        return (await this.request("./local-api/ratings")).ratings;
    }

    /** Save a 1–10 score, or remove the rating with `rating: null`. Resolves to the stored record or null. */
    async saveRating(value) {
        return (await this.request("./local-api/ratings", { method: "POST", body: value })).rating;
    }

    getPreferences() { return this.request("./local-api/preferences"); }

    /** Upsert `{ kind, name, level }`; `level: null` deletes, `previous` renames. Resolves to every preference. */
    savePreference(value) {
        return this.request("./local-api/preferences", { method: "POST", body: value });
    }

    async getSearchHistory() {
        return (await this.request("./local-api/search-history")).items || [];
    }

    /** Move `query` to the top of the recent searches. Resolves to the updated list. */
    async recordSearch(query) {
        return (await this.request("./local-api/search-history", { method: "POST", body: { query } })).items || [];
    }

    /** Remove one keyword, or every recent search when `query` is omitted. */
    async removeSearchHistory(query) {
        const target = query == null ? "" : `?q=${encodeURIComponent(query)}`;
        return (await this.request(`./local-api/search-history${target}`, { method: "DELETE" })).items || [];
    }

    async readCache(kind, key, maxAgeSeconds) {
        try {
            const data = await this.request(`./local-api/cache/${encodeURIComponent(kind)}/${encodeURIComponent(key)}?max_age=${Number(maxAgeSeconds) || 0}`, { allowMissing: true });
            return data?.hit ? data.data : null;
        } catch {
            return null;
        }
    }

    async writeCache(kind, key, data) {
        try {
            await this.request(`./local-api/cache/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`, {
                method: "POST",
                body: { data },
            });
        } catch {
            // Remote API data remains usable if the local cache is unavailable.
        }
    }
}

export const localRuntime = new LocalRuntime();
