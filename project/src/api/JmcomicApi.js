import { setting } from "../core/Setting.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { readLocalStorage, removeLocalStorage, writeLocalStorage } from "../utils/BrowserStorage.js";
import { crypto, parseJsonText } from "./Crypto.js";
import { listingApiOrder, listingCategoryPath, normalizeListingFilters } from "../utils/ListingFilters.js";

/* A browser-direct API line itself failed (blocked, reset, timed out, refused or broken), not the request. */
const isLineFailure = (error) => error?.name === "AbortError"
    || error instanceof TypeError
    || error?.status === 403
    || error?.status === 429
    || error?.status >= 500
    || error?.lineFailure === true;

const normalizeFavoriteFolders = (list) => list
    .map((folder) => ({ id: String(folder?.FID ?? folder?.id ?? ""), name: String(folder?.name ?? "").trim() }))
    .filter((folder) => folder.id && folder.id !== "0");

/** Browser client for the JM mobile API. */
class JmcomicApi {
    accessToken = null;
    currentKey = null;
    servers = [];
    initPromise = null;
    sessionUserId = "";
    albumRequests = new Map();
    // Albums last answered from the persistent cache, so a page can fetch a fresh copy behind them.
    albumCacheHits = new Set();
    chapterRequests = new Map();
    accountAlbumRequests = new Map();
    favoriteIds = null;
    favoriteSnapshotPromise = null;
    favoriteFolders = null;
    albumMemoryLimit = 500;
    chapterMemoryLimit = 120;
    bootstrapFromCache = false;
    bootstrapMaxAge = 6 * 60 * 60 * 1000;
    bootstrapStorageKey = "jm_api_bootstrap_v1";
    // Lines that recently failed on this browser's network are tried last, so requests that
    // only try one or two lines (cards, random pick) skip lines this network blocks.
    lineFailureStorageKey = "jm_api_line_failures_v1";
    lineFailureTtl = 30 * 60 * 1000;

    imgServers = [
        "cdn-msp.jmapiproxy1.cc",
        "cdn-msp.jmapiproxy2.cc",
        "cdn-msp2.jmapiproxy2.cc",
        "cdn-msp3.jmapiproxy2.cc",
        "cdn-msp.jmapinodeudzn.net",
        "cdn-msp3.jmapinodeudzn.net",
    ];

    normalizeServers(value) {
        return (Array.isArray(value) ? value : [])
            .map((server) => String(server || "").trim().toLowerCase())
            .filter((server, index, all) => /^[a-z0-9.-]+$/.test(server) && server.includes(".") && all.indexOf(server) === index)
            .slice(0, 12);
    }

    readBrowserBootstrap() {
        try {
            const cached = JSON.parse(readLocalStorage(this.bootstrapStorageKey, "null"));
            if (Date.now() - Number(cached?.savedAt || 0) > this.bootstrapMaxAge) return [];
            return this.normalizeServers(cached?.servers);
        } catch {
            return [];
        }
    }

    readLineFailures() {
        try {
            const stored = JSON.parse(readLocalStorage(this.lineFailureStorageKey, "null"));
            const now = Date.now();
            return Object.fromEntries(Object.entries(stored && typeof stored === "object" ? stored : {})
                .filter(([, failedAt]) => now - Number(failedAt) < this.lineFailureTtl));
        } catch {
            return {};
        }
    }

    markLine(server, failed) {
        if (!server) return;
        const failures = this.readLineFailures();
        if (failed) failures[server] = Date.now();
        else if (server in failures) delete failures[server];
        else return;
        if (Object.keys(failures).length) writeLocalStorage(this.lineFailureStorageKey, JSON.stringify(failures));
        else removeLocalStorage(this.lineFailureStorageKey);
    }

    /** Lines in bootstrap order, recently failed ones last (longest-ago failure first). */
    orderedServers() {
        const failures = this.readLineFailures();
        const healthy = this.servers.filter((server) => !(server in failures));
        const failed = this.servers.filter((server) => server in failures)
            .sort((a, b) => failures[a] - failures[b]);
        return [...healthy, ...failed];
    }

    saveBootstrap(servers) {
        const normalized = this.normalizeServers(servers);
        if (!normalized.length) return;
        writeLocalStorage(this.bootstrapStorageKey, JSON.stringify({ savedAt: Date.now(), servers: normalized }));
        localRuntime.writeCache("bootstrap", "servers", normalized);
    }

    async init(force = false) {
        if (force) {
            this.servers = [];
            this.bootstrapFromCache = false;
            removeLocalStorage(this.bootstrapStorageKey);
        }
        if (this.servers.length) return this.servers;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            if (!force) {
                const browserCached = this.readBrowserBootstrap();
                if (browserCached.length) {
                    this.bootstrapFromCache = true;
                    this.servers = browserCached;
                    return this.servers;
                }
                const fileCached = this.normalizeServers(await localRuntime.readCache("bootstrap", "servers", 6 * 60 * 60));
                if (fileCached.length) {
                    this.bootstrapFromCache = true;
                    this.servers = fileCached;
                    this.saveBootstrap(fileCached);
                    return this.servers;
                }
            }
            const body = await this.retryFetch(
                "https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt",
                {},
                2,
                (response) => response.text(),
            );
            const text = body.replace(/^\uFEFF/, "").trim();
            this.servers = this.normalizeServers(crypto.decryptCurrentApi(text).Server);
            if (!this.servers.length) throw new Error("未获取到可用 API 线路");
            this.bootstrapFromCache = false;
            this.saveBootstrap(this.servers);
            return this.servers;
        })();

        try {
            return await this.initPromise;
        } finally {
            this.initPromise = null;
        }
    }

    async #fetchWithTimeout(url, init = {}, timeoutMs = 12000, readBody = null) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { ...init, signal: controller.signal });
            // Keep the timeout active until the response body finishes arriving.
            return readBody ? await readBody(response) : response;
        } finally {
            clearTimeout(timer);
        }
    }

    #createRequestAuth() {
        const key = Math.floor(Date.now() / 1000);
        const accessToken = {
            token: crypto.calculateMD5(key + "185Hcomic3PAPP7R"),
            tokenParam: `${key},3.2.0`,
        };
        this.currentKey = key;
        this.accessToken = accessToken;
        return { key, accessToken };
    }

    async retryFetch(getUrl, init = {}, count = 1, readBody = null) {
        if (typeof init === "number") {
            count = init;
            init = {};
        }
        const urlFactory = typeof getUrl === "function" ? getUrl : () => getUrl;
        let lastError;
        for (let attempt = 0; attempt < Math.max(1, count); attempt++) {
            try {
                return await this.#fetchWithTimeout(urlFactory(attempt), init, 12000, async (response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return readBody ? await readBody(response) : response;
                });
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error("网络请求失败");
    }

    async #requestApi(path, {
        method = "GET",
        data = null,
        authenticated = false,
        validate = null,
        retryBootstrap = true,
        maxServers = 5,
        timeoutMs = 12000,
    } = {}) {
        await this.init();
        const candidates = authenticated ? [null] : this.orderedServers().slice(0, Math.max(1, Math.min(5, Number(maxServers) || 5)));
        let lastError;
        const readResponse = async (response) => {
            let payload;
            try {
                payload = typeof response.text === "function"
                    ? parseJsonText(await response.text())
                    : await response.json();
            } catch (error) {
                if (error?.name === "AbortError") throw error;
                if (response.ok) throw Object.assign(new Error("当前 API 线路返回了无效数据"), { lineFailure: true });
                payload = {};
            }
            if (!response.ok) {
                const detail = payload?.error || payload?.msg || payload?.message;
                throw Object.assign(new Error(`HTTP ${response.status}${typeof detail === "string" ? `：${detail}` : ""}`), { status: response.status });
            }
            return { response, payload };
        };

        for (const server of candidates) {
            const { key, accessToken } = this.#createRequestAuth();
            const headers = { token: accessToken.token, tokenParam: accessToken.tokenParam };
            const options = {
                method,
                headers,
                credentials: "include",
                redirect: "follow",
            };
            if (data) {
                headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
                options.body = new URLSearchParams(data).toString();
            }

            try {
                // Account calls may re-login across several API lines first, so they run as a
                // server job: remote access through a proxy never holds one long request.
                const { response, payload } = authenticated
                    ? await readResponse(await localRuntime.fetchJob("./local-api/jm-proxy", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        cache: "no-store",
                        body: JSON.stringify({
                            servers: this.servers.slice(0, 5),
                            path,
                            method,
                            data,
                            token: accessToken.token,
                            tokenParam: accessToken.tokenParam,
                        }),
                    }, 240000))
                    : await this.#fetchWithTimeout(`https://${server}${path}`, options, timeoutMs, readResponse);
                const result = typeof payload.data === "string"
                    ? crypto.decryptData(key, payload.data)
                    : (payload.data ?? payload);
                if (validate && !validate(result)) {
                    throw new Error("当前 API 线路返回了空数据");
                }
                if (!authenticated) this.markLine(server, false);
                let responseServer = server;
                if (!authenticated && response.url) {
                    try { responseServer = new URL(response.url).hostname || server; } catch {}
                }
                if (!authenticated && responseServer) {
                    const index = this.servers.indexOf(responseServer);
                    if (index > 0) {
                        this.servers.splice(index, 1);
                        this.servers.unshift(responseServer);
                        this.saveBootstrap(this.servers);
                    }
                }
                return { result, server: responseServer, payload };
            } catch (error) {
                lastError = error;
                if (authenticated) break;
                if (isLineFailure(error)) this.markLine(server, true);
            }
        }
        if (!authenticated && retryBootstrap && this.bootstrapFromCache) {
            await this.init(true);
            return this.#requestApi(path, { method, data, authenticated, validate, retryBootstrap: false, maxServers, timeoutMs });
        }
        throw lastError || new Error("所有 API 线路均请求失败");
    }

    async getSearchResults(searchQuery, page, {
        order = "mv",
        time = "a",
        category = "0",
        mainTag = "0",
    } = {}) {
        const effectiveOrder = listingApiOrder({ order, time });
        const query = new URLSearchParams({
            search_query: searchQuery,
            o: effectiveOrder,
            t: time,
            c: category,
            main_tag: mainTag,
            page,
        });
        return (await this.#requestApi(`/search?${query}`)).result;
    }

    async getFilteredComics(searchQuery, page, filters = {}) {
        const normalized = normalizeListingFilters(filters);
        const keyword = String(searchQuery || "").trim();
        if (keyword) return this.getSearchResults(keyword, page, normalized);
        return this.getCategoriesFilter(
            listingCategoryPath(normalized),
            page,
            listingApiOrder(normalized),
        );
    }

    async getLatestContent(page) {
        return (await this.#requestApi(`/latest?page=${page}`)).result;
    }

    async getPromotionContent() {
        const cached = await localRuntime.readCache("promotion", "home", 24 * 60 * 60);
        if (Array.isArray(cached)) return cached;
        const data = (await this.#requestApi("/promote?page=1")).result;
        localRuntime.writeCache("promotion", "home", data);
        return data;
    }

    #rememberRequest(cache, key, request, limit) {
        cache.set(key, request);
        while (cache.size > limit) {
            const oldestKey = cache.keys().next().value;
            cache.delete(oldestKey);
        }
        request.catch(() => {
            if (cache.get(key) === request) cache.delete(key);
        });
        return request;
    }

    async getComicAlbum(comicId, { refresh = false, maxServers = 5, timeoutMs = 12000 } = {}) {
        const id = String(comicId ?? "").trim();
        if (!id) throw new Error("漫画 ID 无效");
        const requestKey = Number(maxServers) === 5 && Number(timeoutMs) === 12000
            ? id
            : `${id}|${maxServers}|${timeoutMs}`;
        if (refresh) {
            this.albumRequests.delete(id);
            this.albumRequests.delete(requestKey);
        }
        if (!this.albumRequests.has(requestKey)) {
            const request = (async () => {
                if (!refresh) {
                    const cached = await localRuntime.readCache("album", id, 7 * 24 * 60 * 60);
                    if (cached && !Array.isArray(cached) && cached.id != null) {
                        this.albumCacheHits.add(id);
                        return { ...cached, is_favorite: false, liked: false, purchased: "" };
                    }
                }
                const { result } = await this.#requestApi(`/album?id=${encodeURIComponent(id)}`, {
                    validate: (value) => Boolean(
                        value
                        && !Array.isArray(value)
                        && typeof value === "object"
                        && value.id != null,
                    ),
                    maxServers,
                    timeoutMs,
                });
                this.albumCacheHits.delete(id);
                localRuntime.writeCache("album", id, {
                    ...result,
                    is_favorite: false,
                    liked: false,
                    purchased: "",
                });
                return result;
            })();
            this.#rememberRequest(this.albumRequests, requestKey, request, this.albumMemoryLimit);
        }
        return this.albumRequests.get(requestKey);
    }

    /** The last read of this album came from the persistent cache rather than JM. */
    isAlbumFromCache(comicId) { return this.albumCacheHits.has(String(comicId ?? "").trim()); }

    async getComicChapter(comicId) {
        const id = String(comicId ?? "").trim();
        if (!id) throw new Error("章节 ID 无效");
        if (!this.chapterRequests.has(id)) {
            const request = (async () => {
                const cached = await localRuntime.readCache("chapter", id, 3 * 24 * 60 * 60);
                if (cached && !Array.isArray(cached) && cached.id != null) return cached;
                const { result } = await this.#requestApi(`/chapter?id=${encodeURIComponent(id)}`, {
                    validate: (value) => Boolean(
                        value
                        && !Array.isArray(value)
                        && typeof value === "object"
                        && value.id != null,
                    ),
                });
                localRuntime.writeCache("chapter", id, result);
                return result;
            })();
            this.#rememberRequest(this.chapterRequests, id, request, this.chapterMemoryLimit);
        }
        return this.chapterRequests.get(id);
    }

    async getComicComments(subjectId, page = 1) {
        const id = String(subjectId ?? "").trim();
        if (!id) throw new Error("评论对象 ID 无效");
        const query = new URLSearchParams({ page: Math.max(1, Number(page) || 1), mode: "all", aid: id });
        const data = (await this.#requestApi(`/forum?${query}`)).result;
        const result = {
            list: Array.isArray(data?.list) ? data.list : [],
            total: Math.max(0, Number(data?.total) || 0),
        };
        // The first page is reused by the reader so its comments show without another request.
        if (Number(page) <= 1) localRuntime.writeCache("comments", id, result);
        return result;
    }

    async getCachedComicComments(subjectId, maxAgeSeconds = 6 * 60 * 60) {
        const id = String(subjectId ?? "").trim();
        if (!id) return null;
        const cached = await localRuntime.readCache("comments", id, maxAgeSeconds);
        return cached && Array.isArray(cached.list) ? cached : null;
    }

    async getCategories() {
        const cached = await localRuntime.readCache("categories", "all", 24 * 60 * 60);
        if (cached?.categories) return cached;
        const data = (await this.#requestApi("/categories")).result;
        localRuntime.writeCache("categories", "all", data);
        return data;
    }

    async getCategoriesFilter(category, page, order) {
        const query = new URLSearchParams({ page, c: category, o: order || "" });
        return (await this.#requestApi(`/categories/filter?${query}`)).result;
    }

    async login(username, password) {
        await this.init();
        const response = await localRuntime.loginAccount(username, password, this.servers.slice(0, 5));
        const profile = response?.user;
        if (!profile?.uid) throw new Error("账号或密码错误");
        const nextUserId = String(profile.uid);
        if (this.sessionUserId && this.sessionUserId !== nextUserId) {
            this.favoriteIds = null;
            this.favoriteSnapshotPromise = null;
            this.favoriteFolders = null;
            this.accountAlbumRequests.clear();
        }
        this.sessionUserId = nextUserId;
        return profile;
    }

    async ensureAuthenticated({ refresh = false } = {}) {
        await this.init();
        const response = await localRuntime.ensureAccountSession(this.servers.slice(0, 5), { refresh });
        const profile = response?.user;
        if (!profile?.uid) throw new Error("账号会话建立失败");
        const nextUserId = String(profile.uid);
        if (this.sessionUserId && this.sessionUserId !== nextUserId) {
            this.favoriteIds = null;
            this.favoriteSnapshotPromise = null;
            this.favoriteFolders = null;
            this.accountAlbumRequests.clear();
        }
        this.sessionUserId = nextUserId;
        return profile;
    }

    async getFavorites(page = 1, folderId = "0", order = "mr") {
        const query = new URLSearchParams({ page, folder_id: folderId, o: order });
        const result = (await this.#requestApi(`/favorite?${query}`, { authenticated: true })).result;
        if (Array.isArray(result?.folder_list)) this.favoriteFolders = normalizeFavoriteFolders(result.folder_list);
        return result;
    }

    /** Named folders of the account ({ id, name }); the default folder "0" is not listed. */
    async getFavoriteFolders(force = false) {
        if (this.favoriteFolders && !force) return this.favoriteFolders;
        await this.getFavorites(1, "0", "mr");
        return this.favoriteFolders || [];
    }

    async #favoriteFolderRequest(data, fallbackError) {
        const { result } = await this.#requestApi("/favorite_folder", { method: "POST", data, authenticated: true });
        const status = String(result?.status ?? "ok").toLowerCase();
        if (status !== "ok") throw new Error(result?.msg || fallbackError);
        this.favoriteFolders = null;
        return result;
    }

    createFavoriteFolder(name) {
        const folderName = String(name ?? "").trim();
        if (!folderName) throw new Error("请输入收藏夹名称");
        return this.#favoriteFolderRequest({ type: "add", folder_name: folderName }, "新建收藏夹失败");
    }

    async deleteFavoriteFolder(folderId) {
        const result = await this.#favoriteFolderRequest({ type: "del", folder_id: String(folderId) }, "删除收藏夹失败");
        // JM may drop the folder's albums with it, so the favourite-id snapshot is rebuilt next time.
        this.favoriteIds = null;
        await localRuntime.writeCache("favorites", "account", null);
        return result;
    }

    /** Moves an album that is already favourited into `folderId` ("0" is the default folder). */
    moveFavoriteToFolder(albumId, folderId) {
        return this.#favoriteFolderRequest({ type: "move", folder_id: String(folderId), aid: String(albumId) }, "移动收藏夹失败");
    }

    async getFavoriteIds(force = false) {
        if (this.favoriteIds && !force) return this.favoriteIds;
        if (this.favoriteSnapshotPromise && !force) return this.favoriteSnapshotPromise;
        this.favoriteSnapshotPromise = (async () => {
            if (!force) {
                const cached = await localRuntime.readCache("favorites", "account", 6 * 60 * 60);
                if (Array.isArray(cached)) {
                    this.favoriteIds = new Set(cached.map(String));
                    return this.favoriteIds;
                }
            }
            const first = await this.getFavorites(1, "0", "mr");
            const firstList = Array.isArray(first?.list) ? first.list : [];
            const total = Math.max(firstList.length, Number(first?.total) || 0);
            const pageSize = Math.max(1, Number(first?.count) || firstList.length || 20);
            const pageCount = Math.max(1, Math.ceil(total / pageSize));
            const remaining = [];
            for (let start = 2; start <= pageCount; start += 4) {
                const batch = Array.from(
                    { length: Math.min(4, pageCount - start + 1) },
                    (_, index) => this.getFavorites(start + index, "0", "mr"),
                );
                remaining.push(...await Promise.all(batch));
            }
            const ids = [first, ...remaining]
                .flatMap((page) => Array.isArray(page?.list) ? page.list : [])
                .map((item) => String(item?.id || ""))
                .filter(Boolean);
            this.favoriteIds = new Set(ids);
            localRuntime.writeCache("favorites", "account", ids);
            return this.favoriteIds;
        })().finally(() => {
            this.favoriteSnapshotPromise = null;
        });
        return this.favoriteSnapshotPromise;
    }

    async getFavoriteState(albumId, force = false) {
        const cacheKey = String(albumId);
        if (!force) {
            const cached = await localRuntime.readCache("account_album", cacheKey, 30 * 60);
            if (typeof cached === "boolean") return cached;
        }
        try {
            const result = await this.getAccountAlbum(albumId, force);
            if (Object.prototype.hasOwnProperty.call(result, "is_favorite")) {
                const value = result.is_favorite;
                const saved = value === true || value === 1 || value === "1";
                localRuntime.writeCache("account_album", cacheKey, saved);
                return saved;
            }
        } catch {
            // Older API lines may not expose account state on the album endpoint.
        }
        return (await this.getFavoriteIds(force)).has(String(albumId));
    }

    async getAccountAlbum(albumId, force = false) {
        const id = String(albumId ?? "").trim();
        if (!id) throw new Error("漫画 ID 无效");
        if (force) this.accountAlbumRequests.delete(id);
        if (!this.accountAlbumRequests.has(id)) {
            const request = this.#requestApi(`/album?id=${encodeURIComponent(id)}`, {
                authenticated: true,
                validate: (value) => Boolean(value && !Array.isArray(value) && typeof value === "object"),
            }).then(({ result }) => result);
            this.#rememberRequest(this.accountAlbumRequests, id, request, this.albumMemoryLimit);
        }
        return this.accountAlbumRequests.get(id);
    }

    async getLikeState(albumId, force = false) {
        const cacheKey = String(albumId);
        if (!force) {
            const cached = await localRuntime.readCache("account_like", cacheKey, 30 * 60);
            if (typeof cached === "boolean") return cached;
        }
        const result = await this.getAccountAlbum(albumId, force);
        if (!Object.prototype.hasOwnProperty.call(result, "liked")) return false;
        const value = result.liked;
        const liked = value === true || value === 1 || value === "1";
        localRuntime.writeCache("account_like", cacheKey, liked);
        return liked;
    }

    setLikeState(albumId, liked) {
        localRuntime.writeCache("account_like", String(albumId), Boolean(liked));
    }

    setFavoriteState(albumId, saved) {
        const id = String(albumId);
        if (this.favoriteIds) {
            if (saved) this.favoriteIds.add(id);
            else this.favoriteIds.delete(id);
            localRuntime.writeCache("favorites", "account", [...this.favoriteIds]);
        }
        localRuntime.writeCache("account_album", id, Boolean(saved));
    }

    async toggleFavorite(albumId) {
        const { result } = await this.#requestApi("/favorite", {
            method: "POST",
            data: { aid: albumId },
            authenticated: true,
        });
        if (String(result?.status || "").toLowerCase() !== "ok") {
            throw new Error(result?.msg || "收藏接口未确认操作成功");
        }
        this.accountAlbumRequests.delete(String(albumId));
        this.favoriteIds = null;
        await localRuntime.writeCache("favorites", "account", null);
        return result;
    }

    async updateFavoriteState(albumId, desiredState) {
        const id = String(albumId ?? "").trim();
        if (!id) throw new Error("漫画 ID 无效");
        const desired = Boolean(desiredState);
        const current = await this.getFavoriteState(id, true);
        if (current === desired) {
            this.setFavoriteState(id, current);
            return { saved: current, changed: false };
        }

        await this.toggleFavorite(id);
        let confirmed;
        try {
            confirmed = await this.getFavoriteState(id, true);
        } catch {
            throw new Error("远端已响应，但暂时无法确认收藏状态，请稍后重试");
        }
        this.setFavoriteState(id, confirmed);
        if (confirmed !== desired) {
            const error = new Error("远端没有更新收藏状态，请稍后重试");
            error.actualState = confirmed;
            throw error;
        }
        return { saved: confirmed, changed: true };
    }

    async addFavorite(albumId) {
        return this.toggleFavorite(albumId);
    }

    async toggleLike(albumId) {
        const { result } = await this.#requestApi("/like", {
            method: "POST",
            data: { id: albumId },
            authenticated: true,
        });
        if (result?.status && String(result.status).toLowerCase() !== "success") {
            throw new Error(result.msg || "喜欢失败");
        }
        return result;
    }

    async likeAlbum(albumId) {
        return this.toggleLike(albumId);
    }

    async getNotifications() {
        return (await this.#requestApi("/notifications", { authenticated: true })).result;
    }

    async getUnreadNotificationCount(force = false) {
        if (!force) {
            const cached = await localRuntime.readCache("notifications", "unread", 60);
            if (typeof cached === "number") return Math.max(0, cached);
        }
        const value = (await this.#requestApi("/notifications/unreadCount", { authenticated: true })).result;
        const count = typeof value === "number" || typeof value === "string"
            ? Math.max(0, Number(value) || 0)
            : Math.max(0, Number(value?.unreadCount ?? value?.unread_count ?? value?.count) || 0);
        localRuntime.writeCache("notifications", "unread", count);
        return count;
    }

    async markNotification(id, read = true) {
        const result = (await this.#requestApi("/notifications", {
            method: "POST",
            data: { id, read: read ? "1" : "0" },
            authenticated: true,
        })).result;
        localRuntime.writeCache("notifications", "unread", null);
        return result;
    }

    async getAlbumTrackingState(albumId) {
        const query = new URLSearchParams({ id: albumId });
        const value = (await this.#requestApi(`/album_sertracking?${query}`, { authenticated: true })).result;
        if (typeof value === "boolean") return value;
        if (typeof value === "string") return value.toLowerCase() === "true" || value === "1";
        return Boolean(value?.tracking ?? (value?.status === "true" || value?.status === true));
    }

    async toggleAlbumTracking(albumId) {
        return (await this.#requestApi("/album_sertracking", {
            method: "POST",
            data: { id: albumId },
            authenticated: true,
        })).result;
    }

    async getAlbumTrackingList(page = 1) {
        return (await this.#requestApi("/album_tracking", {
            method: "POST",
            data: { page: Math.max(1, Number(page) || 1) },
            authenticated: true,
        })).result;
    }

    clearAuthServer() {
        this.sessionUserId = "";
        this.favoriteIds = null;
        this.favoriteSnapshotPromise = null;
        this.accountAlbumRequests.clear();
    }

    getUserPhotoURL(path) {
        return `https://${this.imgServers[Number(setting.using_imgserver_index)]}/media/users/${path}`;
    }

    getCoverImageURL(id) {
        return `https://${this.imgServers[Number(id) % 5]}/media/albums/${id}_3x4.jpg`;
    }

    getChapterImageServers() {
        const selected = Number(setting.using_imgserver_index);
        const startIndex = Number.isInteger(selected) && selected >= 0 && selected < this.imgServers.length ? selected : 0;
        return [...this.imgServers.slice(startIndex), ...this.imgServers.slice(0, startIndex)];
    }

    getChapterImageURLs(id, pathName) {
        const servers = this.getChapterImageServers();
        const safePath = String(pathName).split("/").map(encodeURIComponent).join("/");
        return servers.map((server) => `https://${server}/media/photos/${encodeURIComponent(id)}/${safePath}`);
    }

}

export const jmApi = new JmcomicApi();
