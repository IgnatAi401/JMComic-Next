import { localRuntime } from "../local/LocalRuntime.js";
import { readLocalStorage, writeLocalStorage } from "../utils/BrowserStorage.js";

/**
 * 作者订阅：订阅数据存在服务器的资料库里，换设备、换访问地址都是同一份；
 * 检查新作由服务器在后台完成（每天自动一次，也可在这里要求立即检查），
 * 浏览器只发起检查并短轮询进度，刷新或关闭页面都不影响后台的检查。
 */
const API_PATH = "./local-api/library/subscriptions";
const CHECK_PATH = "./local-api/library/subscriptions/check";
/* 同一浏览器的其他标签页保存后写这个键，借 storage 事件通知本页重新读取。 */
const SYNC_KEY = "jm_author_subscriptions_sync";
/* 已提示过的自动检查结果（结束时间），每次结果只提示一次。 */
const RESULT_KEY = "jm_author_subscriptions_result_seen";
const POLL_MS = 2000;
const POLL_RETRY_MS = 5000;
const SAVE_RETRY_MS = [2000, 5000, 15000, 60000];
const EMPTY_RESULT = Object.freeze({ added: 0, failed: [], checked: 0 });

const now = () => Date.now();

/** 名称比较时忽略全半角、大小写和多余空格。 */
export const normalizeAuthor = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** 旧版本别名是字符串数组，统一成 { name, source }。 */
const aliasList = (value) => (Array.isArray(value) ? value : [])
    .map((item) => typeof item === "string" ? { name: item, source: "auto" } : item)
    .filter((item) => item?.name);

const emptyState = () => ({ version: 1, authors: [], updates: [], lastRunAt: 0, fuzzy: true });

/** 服务器返回的文档可能为空（还没订阅过），统一成完整结构；同时深拷贝，避免改到原对象。 */
function normalizeState(value) {
    if (!value || typeof value !== "object") return emptyState();
    const copy = JSON.parse(JSON.stringify(value));
    return {
        version: 1,
        authors: Array.isArray(copy.authors) ? copy.authors.filter((item) => item?.name) : [],
        updates: Array.isArray(copy.updates) ? copy.updates.filter((item) => item?.id) : [],
        lastRunAt: Number(copy.lastRunAt) || 0,
        fuzzy: copy.fuzzy !== false,
    };
}

/**
 * 改动先在本地生效（界面立即更新），再排队保存到服务器。保存时带上读到的版本号；
 * 如果其他设备或标签页先存了，服务器会退回最新数据，这里把尚未保存的改动在它上面重放一遍再存，
 * 两边的改动都不会丢。
 */
class AuthorSubscriptions {
    /** 后台检查进行中时是一个 Promise，结束后得到 { added, failed, checked }。 */
    running = null;
    progress = null;
    /** 最近一次保存失败的原因；保存成功后清空。 */
    saveError = "";
    #state = emptyState();
    #revision = 0;
    #loading = null;
    #loaded = false;
    #pending = [];
    #saving = null;
    #retryTimer = 0;
    #failures = 0;
    #checkStatus = null;
    #waiters = [];
    #pollTimer = 0;
    #polling = false;

    constructor() {
        if (typeof window === "undefined") return;
        window.addEventListener("storage", (event) => {
            if (event.key === SYNC_KEY) this.refresh().catch(() => {});
        });
        // 切回页面时重新读取，拿到其他设备的改动和后台检查的进度。
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") return;
            this.refresh().catch(() => {});
            this.#poll();
        });
        this.ready().catch(() => {});
        // 打开页面时读一次后台检查状态：检查进行中就接着显示进度。
        this.#poll();
    }

    /** 第一次从服务器读取订阅；失败后下次调用会重试。 */
    ready() {
        if (this.#loaded) return Promise.resolve();
        if (!this.#loading) {
            this.#loading = this.#fetch().finally(() => { this.#loading = null; });
        }
        return this.#loading;
    }

    /** 重新读取服务器数据；有未保存的改动时交给保存流程合并。 */
    async refresh() {
        if (!this.#loaded) return this.ready();
        if (this.#pending.length || this.#saving) return;
        await this.#fetch();
    }

    async #fetch() {
        const result = await localRuntime.request(API_PATH);
        if (this.#loaded && (this.#pending.length || this.#saving || result.revision <= this.#revision)) return;
        this.#revision = Number(result.revision) || 0;
        this.#rebase(result.state);
        this.#loaded = true;
        this.#notify();
    }

    /** 以服务器数据为底，重放尚未保存的改动。 */
    #rebase(serverState) {
        const state = normalizeState(serverState);
        for (const mutator of this.#pending) {
            try { mutator(state); } catch { /* 在新数据上已不适用的改动（如作者已被别处删除）直接略过 */ }
        }
        this.#state = state;
    }

    #save() {
        clearTimeout(this.#retryTimer);
        if (this.#saving) return this.#saving;
        this.#saving = this.#flush()
            .then(() => {
                this.#failures = 0;
                this.saveError = "";
            }, (error) => {
                this.saveError = error?.message || "订阅保存失败";
                const delay = SAVE_RETRY_MS[Math.min(this.#failures, SAVE_RETRY_MS.length - 1)];
                this.#failures += 1;
                this.#retryTimer = setTimeout(() => this.#save(), delay);
                console.warn("作者订阅保存失败，稍后重试", error);
            })
            .finally(() => {
                this.#saving = null;
                this.#notify();
            });
        return this.#saving;
    }

    async #flush() {
        await this.ready();
        while (this.#pending.length) {
            const count = this.#pending.length;
            const result = await localRuntime.request(API_PATH, {
                method: "POST",
                body: { state: this.#state, revision: this.#revision },
                timeoutMs: 15000,
            });
            this.#revision = Number(result.revision) || 0;
            if (result.conflict) {
                this.#rebase(result.state);
                this.#notify();
                continue;
            }
            this.#pending.splice(0, count);
            writeLocalStorage(SYNC_KEY, String(this.#revision));
        }
    }

    get state() { return this.#state; }
    get authors() { return this.state.authors; }
    get updates() { return this.state.updates; }
    get lastRunAt() { return this.state.lastRunAt; }
    /** 模糊匹配：识别作者的其他写法，并收录标题署名为该作者的作品。 */
    get fuzzy() { return this.state.fuzzy; }

    setFuzzy(enabled) { this.#update((state) => { state.fuzzy = Boolean(enabled); }); }

    /** 每位作者的别名，含来源（auto 自动识别 / manual 手动添加）。 */
    aliasesOf(author) { return aliasList(author?.aliases); }

    #author(state, name) {
        return state.authors.find((item) => normalizeAuthor(item.name) === normalizeAuthor(name));
    }

    /** 手动添加别名；添加后立刻检查这位作者，把新写法下的已有作品记为见过。 */
    addAlias(authorName, alias) {
        const name = String(alias ?? "").replace(/\s+/g, " ").trim();
        const key = normalizeAuthor(name);
        if (!key) throw new Error("请输入别名");
        const result = this.#update((state) => {
            const author = this.#author(state, authorName);
            if (!author) throw new Error("请先订阅这位作者");
            if (key === normalizeAuthor(author.name)) return "same";
            const aliases = aliasList(author.aliases);
            if (aliases.some((item) => normalizeAuthor(item.name) === key)) return "exists";
            author.aliases = [...aliases, { name, source: "manual" }];
            author.rejected = (author.rejected || []).filter((item) => item !== key);
            return "added";
        });
        if (result === "added") this.check([authorName]).catch(() => {});
        return result;
    }

    /** 删除别名并记为“已拒绝”，以后不会再自动识别回来。 */
    removeAlias(authorName, alias) {
        const key = normalizeAuthor(alias);
        this.#update((state) => {
            const author = this.#author(state, authorName);
            if (!author) return;
            author.aliases = aliasList(author.aliases).filter((item) => normalizeAuthor(item.name) !== key);
            author.rejected = [...new Set([...(author.rejected || []), key])];
        });
    }

    find(name) {
        const key = normalizeAuthor(name);
        return this.authors.find((item) => normalizeAuthor(item.name) === key) || null;
    }

    isSubscribed(name) { return Boolean(this.find(name)); }

    /** 在本地数据上修改并立即通知界面，再排队保存到服务器；mutator 需可重放（冲突时会在新数据上再跑一次）。 */
    #update(mutator) {
        const result = mutator(this.#state);
        this.#pending.push(mutator);
        this.#notify();
        this.#save();
        return result;
    }

    #notify() {
        window.dispatchEvent(new CustomEvent("jm-subscriptions-change", { detail: { progress: this.progress } }));
    }

    /** 增量添加，已订阅的名字保持原样；返回实际新增的名字。 */
    subscribe(names) {
        const added = this.#update((state) => {
            const known = new Set(state.authors.map((item) => normalizeAuthor(item.name)));
            const fresh = [];
            for (const raw of Array.isArray(names) ? names : [names]) {
                const name = String(raw ?? "").replace(/\s+/g, " ").trim();
                const key = normalizeAuthor(name);
                if (!key || known.has(key)) continue;
                known.add(key);
                // checkedAt 为 0 表示还没建立基准：第一次检查只记下已有作品，不加入更新列表。
                fresh.push({ name, subscribedAt: now(), checkedAt: 0, maxId: 0, seen: [], error: "", failedAt: 0 });
            }
            state.authors.push(...fresh);
            return fresh.map((item) => item.name);
        });
        // 新订阅的作者马上记录已有作品（建立基准），之后每天由服务器检查。
        if (added.length) this.check(added).catch(() => {});
        return added;
    }

    /** 取消订阅；只来自这位作者的待看作品一并移出。 */
    unsubscribe(name) {
        const key = normalizeAuthor(name);
        this.#update((state) => {
            state.authors = state.authors.filter((item) => normalizeAuthor(item.name) !== key);
            state.updates = state.updates
                .map((item) => ({ ...item, sources: (item.sources || []).filter((source) => normalizeAuthor(source) !== key) }))
                .filter((item) => item.sources.length);
        });
    }

    toggle(name) {
        if (this.isSubscribed(name)) {
            this.unsubscribe(name);
            return false;
        }
        this.subscribe(name);
        return true;
    }

    /** 看过或手动移出。 */
    dismiss(id) {
        const target = String(id ?? "");
        if (!target || !this.updates.some((item) => item.id === target)) return;
        this.#update((state) => { state.updates = state.updates.filter((item) => item.id !== target); });
    }

    clearUpdates() { this.#update((state) => { state.updates = []; }); }

    /** 手动检查全部作者（后台检查进行中时，把还没查到的作者接在后面）。 */
    checkAll() { return this.#startCheck({ all: true }); }

    /** 立即检查这些作者（新订阅、改了别名）。 */
    check(names) { return this.#startCheck({ names }); }

    get isRunning() { return Boolean(this.running); }

    /** 先把本地改动存到服务器（服务器按存好的数据检查），再请求后台检查，返回检查结束时的结果。 */
    #startCheck(body) {
        const promise = (async () => {
            await this.#settled();
            const status = await localRuntime.request(CHECK_PATH, { method: "POST", body, timeoutMs: 15000 });
            const wait = status.running ? this.#waitForRun(status.runId) : Promise.resolve({ ...EMPTY_RESULT });
            this.#applyStatus(status);
            return wait;
        })();
        return this.#track(promise);
    }

    /** 等待尚未保存的改动存好；保存失败时不发起检查。 */
    async #settled() {
        await this.ready();
        while (this.#pending.length || this.#saving) {
            await (this.#saving || this.#save());
            if (this.saveError && this.#pending.length) throw new Error(`订阅还没保存到服务器（${this.saveError}）`);
        }
    }

    /** 记下进行中的检查，结束后清掉进度并通知界面。 */
    #track(promise) {
        this.running = promise;
        this.#notify();
        promise.catch(() => {}).finally(() => {
            if (this.running !== promise) return;
            this.running = null;
            this.progress = null;
            this.#notify();
        });
        return promise;
    }

    #waitForRun(runId) {
        return new Promise((resolve) => {
            this.#waiters.push({ runId, resolve });
            this.#schedulePoll(POLL_MS);
        });
    }

    #schedulePoll(delay) {
        if (this.#pollTimer || this.#polling) return;
        this.#pollTimer = setTimeout(() => {
            this.#pollTimer = 0;
            this.#poll();
        }, delay);
    }

    /** 读后台检查状态；进行中或有人在等结果时继续短轮询。 */
    async #poll() {
        if (this.#polling) return;
        clearTimeout(this.#pollTimer);
        this.#pollTimer = 0;
        this.#polling = true;
        let status = null;
        try {
            status = await localRuntime.request(CHECK_PATH, { timeoutMs: 10000 });
        } catch {
            // 网络断开时稍后再试，后台检查不受影响。
        } finally {
            this.#polling = false;
        }
        if (status) this.#applyStatus(status);
        else if (this.#waiters.length || this.#checkStatus?.running) this.#schedulePoll(POLL_RETRY_MS);
    }

    #applyStatus(status) {
        if (!status || typeof status !== "object") return;
        const previous = this.#checkStatus;
        this.#checkStatus = status;
        const last = status.lastRun;
        // 后台每查完一位作者就保存一次；版本号变了就重新读取，新作随检查进度出现。
        if ((Number(status.revision) || 0) > this.#revision || (last && last.id !== previous?.lastRun?.id)) {
            this.refresh().catch(() => {});
        }
        // 服务器重启后旧的检查不会再结束，这时也放行等待的人。
        const finished = (waiter) => !status.running || (last && last.id >= waiter.runId);
        for (const waiter of this.#waiters.filter(finished)) {
            waiter.resolve(last && last.id >= waiter.runId
                ? { added: last.added || 0, failed: last.failed || [], checked: last.checked || 0 }
                : { ...EMPTY_RESULT });
        }
        this.#waiters = this.#waiters.filter((waiter) => !finished(waiter));
        this.#announce(last);
        if (status.running) {
            this.progress = status.progress || null;
            // 打开页面时检查已在进行（别的设备或每天的自动检查发起）：同样显示进度。
            if (!this.running) this.#track(this.#waitForRun(status.runId));
            this.#schedulePoll(POLL_MS);
        } else {
            this.progress = null;
        }
        this.#notify();
    }

    /** 自动检查发现新作时提示一次（手动检查由发起的页面自己提示）。 */
    #announce(last) {
        if (!last?.finishedAt) return;
        const seen = Number(readLocalStorage(RESULT_KEY, "0")) || 0;
        if (last.finishedAt <= seen) return;
        writeLocalStorage(RESULT_KEY, String(last.finishedAt));
        // 第一次用这个版本时不提示以前的结果。
        if (!seen || !last.auto || !last.added) return;
        window.dispatchEvent(new CustomEvent("jm-subscriptions-result", { detail: { ...last } }));
    }
}

export const authorSubscriptions = new AuthorSubscriptions();
