const JOB_POLL_DELAYS = [250, 500, 1000];
const JOB_POLL_INTERVAL = 2000;
const JOB_POLL_RETRIES = 8;

class LocalRuntime {
    /**
     * `job: true` runs a slow route as a server-side job (see `fetchJob`); `timeoutMs` is then
     * the overall deadline rather than the time one connection may stay open.
     */
    async request(path, { method = "GET", body = null, allowMissing = false, timeoutMs = 3000, job = false } = {}) {
        const init = {
            method,
            headers: body ? { "Content-Type": "application/json" } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            cache: "no-store",
        };
        if (job) return this.readResponse(await this.fetchJob(path, init, timeoutMs), allowMissing);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await this.readResponse(await fetch(path, { ...init, signal: controller.signal }), allowMissing, controller.signal);
        } catch (error) {
            if (error?.name === "AbortError") throw new Error("本地服务响应超时");
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    async readResponse(response, allowMissing = false, signal = null) {
        if (allowMissing && response.status === 404) return null;
        let data;
        try {
            data = await response.json();
        } catch (error) {
            if (error?.name === "AbortError" || signal?.aborted) throw error;
            if (response.ok) throw new Error("本地服务返回了无效数据，请稍后重试");
            data = {};
        }
        if (!response.ok) {
            const error = new Error(data.error || `本地服务错误 ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return data;
    }

    /**
     * Run a slow local route as a server job: one short submit, then short polls. Reverse
     * proxies, tunnels and sleeping phones cut a single multi-minute request but not these,
     * and the server finishes the work even if the page goes away. Resolves to the final
     * Response exactly as the direct route would have answered it.
     */
    async fetchJob(path, init = {}, deadlineMs = 180000) {
        const deadline = Date.now() + deadlineMs;
        const start = await this.fetchWithin(path, { ...init, headers: { ...init.headers, "X-Local-Job": "start" } }, 30000);
        // Validation errors, a busy server or an older server answer directly.
        if (start.headers?.get?.("X-Local-Job") !== "accepted") return start;
        const { job } = await start.json();
        let failures = 0;
        for (let poll = 0; Date.now() < deadline; poll++) {
            await new Promise((resolve) => setTimeout(resolve, JOB_POLL_DELAYS[poll] ?? JOB_POLL_INTERVAL));
            let response;
            try {
                response = await this.fetchWithin(`./local-api/jobs?id=${encodeURIComponent(job)}`, { cache: "no-store" }, 15000);
            } catch (error) {
                if (++failures >= JOB_POLL_RETRIES) throw error;
                continue;
            }
            const state = response.headers?.get?.("X-Local-Job");
            if (state === "done" || state === "missing") return response;
            // "running", or a proxy error page in place of our answer: the job keeps going, so poll again.
            failures = state === "running" ? 0 : failures + 1;
            if (failures >= JOB_POLL_RETRIES) return response;
        }
        throw new Error("本地服务处理超时，请稍后重试");
    }

    async fetchWithin(path, init, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(path, { ...init, signal: controller.signal });
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
            timeoutMs: 180000,
            job: true,
        });
    }

    ensureAccountSession(servers, { refresh = false } = {}) {
        return this.request("./local-api/auth/session", {
            method: "POST",
            body: refresh ? { servers, refresh: true } : { servers },
            timeoutMs: 180000,
            job: true,
        });
    }

    clearAccount() {
        return this.request("./local-api/account", { method: "DELETE" });
    }

    getWebChapterNames(albumId) {
        return this.request(`./local-api/chapter-names?id=${encodeURIComponent(albumId)}`, {
            timeoutMs: 120000,
            job: true,
        });
    }

    getTranslationConfig() { return this.request("./local-api/translation/config"); }

    saveTranslationConfig(config) {
        return this.request("./local-api/translation/config", { method: "POST", body: config });
    }

    testTranslationConfig(config) {
        return this.request("./local-api/translation/test", {
            method: "POST", body: config, timeoutMs: 180000, job: true,
        });
    }

    clearTranslationConfig() { return this.request("./local-api/translation/config", { method: "DELETE" }); }

    translateTitle(title) {
        return this.request("./local-api/translation", {
            method: "POST", body: { title }, timeoutMs: 180000, job: true,
        });
    }

    /**
     * Ask the configured model to group listing comics by series; `items` are `{ id, title, author }`.
     * The server also saves the result under `cacheKey` so other devices can reuse it.
     */
    organizeComics(items, query = "", { cacheKey = "", comics = [], force = false } = {}) {
        return this.request("./local-api/organize", {
            method: "POST", body: { items, query, cache_key: cacheKey, comics, force }, timeoutMs: 6 * 60 * 1000, job: true,
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
