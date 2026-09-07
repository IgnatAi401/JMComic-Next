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
            if (!response.ok) throw new Error(data.error || `本地服务错误 ${response.status}`);
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

    getSettings() {
        return this.request("./local-api/settings");
    }

    saveSettings(settings) {
        return this.request("./local-api/settings", {
            method: "POST",
            body: settings,
        });
    }

    getWebChapterNames(albumId) {
        return this.request(`./local-api/chapter-names?id=${encodeURIComponent(albumId)}`, {
            timeoutMs: 90000,
        });
    }

    getAiConfig() { return this.request("./local-api/ai/config"); }

    saveAiConfig(config) {
        return this.request("./local-api/ai/config", { method: "POST", body: config });
    }

    testAiConfig(config) {
        return this.request("./local-api/ai/test", {
            method: "POST", body: config, timeoutMs: 130000,
        });
    }

    clearAiConfig() { return this.request("./local-api/ai/config", { method: "DELETE" }); }

    translateTitleWithAi(title) {
        return this.request("./local-api/ai/translate", {
            method: "POST", body: { title }, timeoutMs: 130000,
        });
    }

    getLocalComic(id) {
        return this.request(`./local-api/library/comic?id=${encodeURIComponent(id)}`);
    }

    saveLocalComic(comic) {
        return this.request("./local-api/library/comic", { method: "POST", body: comic });
    }

    getLocalComics(mode = "all") {
        return this.request(`./local-api/library/comics?mode=${encodeURIComponent(mode)}`);
    }

    getComicFeedbackStates(ids) {
        return this.request("./local-api/library/feedback/states", {
            method: "POST", body: { ids },
        });
    }

    syncLocalFavorites(comics) {
        return this.request("./local-api/library/favorites/sync", {
            method: "POST", body: { comics }, timeoutMs: 30000,
        });
    }

    getAiProfile() { return this.request("./local-api/ai/profile"); }

    generateAiProfile() {
        return this.request("./local-api/ai/profile/generate", {
            method: "POST", body: {}, timeoutMs: 130000,
        });
    }

    getRecommendedIds() { return this.request("./local-api/ai/recommended-ids"); }

    getDiscoveryExcludedIds() { return this.request("./local-api/ai/discovery-excluded-ids"); }

    getRecommendationHistory() { return this.request("./local-api/ai/recommendations"); }

    getEmbeddingStatus() { return this.request("./local-api/ai/embeddings/status"); }

    getEmbeddingConfig() { return this.request("./local-api/ai/embeddings/config"); }

    saveEmbeddingConfig(value) {
        return this.request("./local-api/ai/embeddings/config", {
            method: "POST", body: value,
        });
    }

    testEmbeddingConfig(value) {
        return this.request("./local-api/ai/embeddings/test", {
            method: "POST", body: value, timeoutMs: 130000,
        });
    }

    clearEmbeddingConfig() {
        return this.request("./local-api/ai/embeddings/config", { method: "DELETE" });
    }

    generateRecommendations(value) {
        return this.request("./local-api/ai/recommendations/generate", {
            method: "POST", body: value, timeoutMs: 30 * 60 * 1000,
        });
    }

    saveRecommendationFeedback(value) {
        return this.request("./local-api/ai/recommendations/feedback", {
            method: "POST", body: value,
        });
    }

    async recordInteraction(value) {
        try {
            const response = await fetch("./local-api/ai/interactions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(value),
                cache: "no-store",
                keepalive: true,
            });
            if (!response.ok) return null;
            return await response.json().catch(() => ({ saved: true }));
        } catch {
            // Passive analytics must never block navigation or reading.
            return null;
        }
    }

    cacheChapterImages(chapter, paths, servers, concurrency) {
        return this.request("./local-api/image-cache/chapter", {
            method: "POST",
            body: { chapter, paths, servers, concurrency },
            timeoutMs: 10000,
        });
    }

    cancelChapterImages(chapter) {
        const body = JSON.stringify({ chapter });
        const url = "./local-api/image-cache/chapter/cancel";
        if (typeof navigator.sendBeacon === "function") {
            try {
                if (navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return true;
            } catch {
                // Safari may reject a beacon while navigating or when its queue is full.
            }
        }
        fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            cache: "no-store",
            keepalive: true,
        }).catch(() => {});
        return true;
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
