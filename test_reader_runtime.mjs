import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Run the browser modules with explicit DOM/network substitutes. No requests,
// browser storage, local library data, or third-party packages are used.
function loadModule(path, exported, globals = {}) {
    const source = readFileSync(new URL(`./project/src/${path}`, import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "")
        .replace(/^export /gm, "");
    const context = vm.createContext({
        AbortController, URL, URLSearchParams, Blob, setTimeout, clearTimeout,
        fetch: () => { throw new Error("Unexpected network request"); },
        ...globals,
    });
    return vm.runInContext(`${source}\n;(${exported});`, context, { filename: path });
}

function fakeTimers() {
    const callbacks = new Map();
    let nextId = 0;
    return {
        callbacks,
        setTimeout(callback) { callbacks.set(++nextId, callback); return nextId; },
        clearTimeout(id) { callbacks.delete(id); },
        fire() {
            const pending = [...callbacks.values()];
            callbacks.clear();
            pending.forEach((callback) => callback());
        },
    };
}

async function settle() {
    for (let count = 0; count < 30; count++) await Promise.resolve();
}

class Element {
    constructor(tagName = "div") {
        this.tagName = tagName;
        this.dataset = {};
        this.style = { setProperty(name, value) { this[name] = value; } };
        this.children = [];
        this.events = new Map();
        this.naturalWidth = 600;
        this.naturalHeight = 900;
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    removeAttribute(name) { delete this[name]; }
    getBoundingClientRect() { return { height: 900 }; }
    addEventListener(name, callback) { this.events.set(name, callback); }
    querySelectorAll(tagName) {
        return this.children.flatMap((child) => [
            ...(child.tagName === tagName ? [child] : []),
            ...child.querySelectorAll(tagName),
        ]);
    }
}

function readerHarness({ sources = ["https://fixture.invalid/"], batchSize = 1, count = 3, onLayoutChange = null } = {}) {
    const timers = fakeTimers();
    const frames = fakeTimers();
    const listeners = new Map();
    const EagerComicImageLoader = loadModule("reader/EagerComicImageLoader.js", "EagerComicImageLoader", {
        ...timers,
        requestAnimationFrame: frames.setTimeout,
        cancelAnimationFrame: frames.clearTimeout,
        navigator: { userAgent: "Version/18.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 0 },
        window: { addEventListener: (name, callback) => listeners.set(name, callback) },
        document: { createElement: (name) => new Element(name) },
        ImageCutter: class { cutImage() { throw new Error("Unexpected image cutting"); } },
        jmApi: {
            getChapterImageURLs: (_, path) => sources.map((source) => `${source}${path}`),
        },
    });
    const loader = new EagerComicImageLoader("100", { onLayoutChange, batchSize });
    const containers = Array.from({ length: count }, (_, index) => {
        const element = new Element();
        element.dataset = { index: String(index), path: `${index}.jpg`, state: "pending" };
        return element;
    });
    return { loader, containers, timers, frames, listeners };
}

test("direct image failure can recover through retry without a backend request", async () => {
    const h = readerHarness();
    h.loader.start(h.containers);
    const first = h.containers[0].children[0];
    assert.equal(first.src, "https://fixture.invalid/0.jpg");
    assert.equal(first.crossOrigin, undefined);
    first.onerror();
    await settle();
    assert.equal(h.containers[0].dataset.state, "error");
    h.loader.updateRenderWindow();
    assert.equal(h.containers[0].dataset.state, "error");
    h.containers[0].children[0].children[1].events.get("click")();
    h.containers[1].children[0].onload();
    await settle();
    h.containers[0].children[0].onload();
    await settle();
    assert.equal(h.containers[0].dataset.state, "loaded");
    h.loader.suspend();
    await settle();
    assert.equal(h.timers.callbacks.size, 0);
});

test("failed or timed-out sources switch once and stale callbacks cannot finish the replacement", async () => {
    const h = readerHarness({ sources: ["https://first.invalid/", "https://second.invalid/", "https://third.invalid/"] });
    h.loader.start(h.containers);
    const first = h.containers[0].children[0];
    const staleLoad = first.onload;
    first.onerror();
    const second = h.containers[0].children[0];
    assert.equal(second.src, "https://second.invalid/0.jpg");
    staleLoad();
    assert.equal(h.containers[0].dataset.state, "rendering");
    h.timers.fire();
    const third = h.containers[0].children[0];
    assert.equal(third.src, "https://third.invalid/0.jpg");
    assert.equal(second.src, undefined);
    third.onload();
    await settle();
    assert.equal(h.containers[0].dataset.state, "loaded");
    h.loader.suspend();
    await settle();
});

test("jumping cancels old loads, respects concurrency and prioritizes the new page", async () => {
    const h = readerHarness({ batchSize: 2, count: 100 });
    h.loader.start(h.containers);
    assert.equal(h.loader.activeLoads, 2);
    const first = h.containers[0].children[0];
    const staleLoad = first.onload;
    h.loader.setCurrent(70);
    await settle();
    assert.equal(first.src, undefined);
    assert.equal(h.loader.activeLoads, 2);
    assert.equal(h.containers[70].dataset.state, "rendering");
    assert.equal(h.containers[71].dataset.state, "rendering");
    assert.equal(h.containers[99].children.length, 0);
    staleLoad();
    assert.equal(h.containers[0].dataset.state, "pending");
    h.loader.setBatchSize(1);
    h.containers[70].children[0].onload();
    await settle();
    assert.equal(h.loader.activeLoads, 1);
    h.listeners.get("jm-image-server-change")();
    await settle();
    assert.equal(h.containers[70].dataset.state, "rendering");
    h.loader.suspend();
    await settle();
    assert.equal(h.loader.activeLoads, 0);
    assert.equal(h.timers.callbacks.size, 0);
});

test("Safari back/forward restores interrupted image decoding and keeps placeholder height", async () => {
    const h = readerHarness();
    h.loader.start(h.containers);
    await settle();
    const oldImage = h.containers[0].children[0];
    const lateLoad = oldImage.onload;
    assert.equal(h.containers[0].dataset.state, "rendering");

    h.listeners.get("pagehide")({ persisted: true });
    await settle();
    assert.equal(oldImage.src, undefined);
    assert.equal(oldImage.onload, null);
    assert.equal(h.containers[0].style.height, "900px");
    assert.equal(h.timers.callbacks.size, 0);
    lateLoad();
    assert.equal(h.containers[0].dataset.state, "pending");

    h.listeners.get("pageshow")({ persisted: true });
    await settle();
    const restoredImage = h.containers[0].children[0];
    assert.notEqual(restoredImage, oldImage);
    restoredImage.onload();
    await settle();
    assert.equal(h.containers[0].dataset.state, "loaded");
    assert.equal(h.containers[0].style.height, "");
    h.loader.suspend();
    await settle();
});

test("hiding a reader releases canvas backing stores and pending layout callbacks", async () => {
    let layoutCalls = 0;
    const h = readerHarness({ onLayoutChange: () => { layoutCalls++; } });
    h.loader.start(h.containers);
    await settle();
    h.containers[0].children[0].onload();
    await settle();
    const canvas = new Element("canvas");
    canvas.width = 600;
    canvas.height = 900;
    h.containers[0].append(canvas);
    h.loader.suspend();
    await settle();
    h.frames.fire();
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
    assert.equal(layoutCalls, 0);
    assert.equal(h.frames.callbacks.size, 0);
    assert.equal(h.timers.callbacks.size, 0);
});

test("a decode timeout detaches the failed image and allows the next page to load", async () => {
    const h = readerHarness();
    h.loader.start(h.containers);
    await settle();
    const image = h.containers[0].children[0];
    h.timers.fire();
    await settle();
    assert.equal(h.containers[0].dataset.state, "error");
    assert.equal(image.src, undefined);
    assert.equal(image.onload, null);
    assert.equal(h.containers[1].dataset.state, "rendering");
    h.loader.suspend();
    await settle();
});

test("reader page indexes are clamped to integers", async () => {
    const h = readerHarness();
    h.loader.start(h.containers);
    h.loader.setCurrent(1.8);
    assert.equal(h.loader.currentIndex, 1);
    h.loader.setCurrent(Infinity);
    assert.equal(h.loader.currentIndex, 2);
    h.loader.suspend();
    await settle();
});

function hangingJsonResponse(signal) {
    return {
        ok: true,
        status: 200,
        json: () => new Promise((_, reject) => {
            const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
        }),
    };
}

test("local JSON-body timeouts reject instead of returning an empty success", async () => {
    const timers = fakeTimers();
    const runtime = loadModule("local/LocalRuntime.js", "localRuntime", {
        ...timers,
        fetch: async (_, { signal }) => hangingJsonResponse(signal),
    });
    const request = runtime.request("fixture:local");
    const rejected = assert.rejects(request, /本地服务响应超时/);
    await settle();
    assert.equal(timers.callbacks.size, 1);
    timers.fire();
    await rejected;
    assert.equal(timers.callbacks.size, 0);
});

test("invalid successful local JSON is an error, while missing optional cache remains supported", async () => {
    let response = { ok: true, status: 200, json: async () => { throw new SyntaxError("invalid JSON"); } };
    const runtime = loadModule("local/LocalRuntime.js", "localRuntime", { fetch: async () => response });
    await assert.rejects(runtime.request("fixture:local"), /无效数据/);
    response = { ok: false, status: 404 };
    assert.equal(await runtime.request("fixture:cache", { allowMissing: true }), null);
    response = { ok: false, status: 503, json: async () => { throw new SyntaxError("HTML error response"); } };
    await assert.rejects(runtime.request("fixture:local"), /503/);
});

test("reader concurrency is local to the device and rejects unreasonable values", async () => {
    const stored = new Map();
    const events = [];
    const setting = loadModule("core/Setting.js", "setting", {
        readLocalStorage: (key) => stored.get(key) ?? null,
        writeLocalStorage: (key, value) => stored.set(key, value),
        installNavigationPolicy() {},
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
        window: { dispatchEvent: (event) => events.push(event) },
    });
    await setting.init();
    assert.equal(setting.image_load_batch_size, 5);
    for (const value of [1, 2, 5, 10, 20, 50, 100]) {
        await setting.setImageLoadBatchSize(value);
        assert.equal(stored.get("jm_reader_concurrency"), String(value));
        await setting.init();
        assert.equal(setting.image_load_batch_size, value);
    }
    for (const value of [0, 3, 4, 6, 7, 8, 9, 101, 500, 1.5, "bad"]) await assert.rejects(setting.setImageLoadBatchSize(value));
    stored.set("jm_reader_concurrency", "3");
    await setting.init();
    assert.equal(setting.image_load_batch_size, 5);
    setting.setOption("using_imgserver_index", 2);
    assert.equal(events.at(-1).type, "jm-image-server-change");
});

function apiHarness(fetch, timers = fakeTimers()) {
    const api = loadModule("api/JmcomicApi.js", "jmApi", {
        ...timers, fetch,
        setting: {},
        localRuntime: { readCache: async () => null, writeCache: async () => {} },
        readLocalStorage: () => "null", writeLocalStorage() {}, removeLocalStorage() {},
        crypto: { calculateMD5: () => "fixture-token" },
    });
    api.servers = ["first.invalid", "second.invalid"];
    return { api, timers };
}

test("JM JSON-body timeout advances to the next server", async () => {
    const urls = [];
    const h = apiHarness(async (url, { signal }) => {
        urls.push(url);
        return urls.length === 1 ? hangingJsonResponse(signal) : {
            ok: true, status: 200, url,
            json: async () => ({ data: { id: "42", name: "Fixture" } }),
        };
    });
    const request = h.api.getComicAlbum("42");
    await settle();
    assert.equal(h.timers.callbacks.size, 1);
    h.timers.fire();
    assert.equal((await request).name, "Fixture");
    assert.equal(urls.length, 2);
    assert.equal(h.timers.callbacks.size, 0);
});

test("JM rejects malformed successful JSON and uses the next server", async () => {
    let attempts = 0;
    const h = apiHarness(async () => ({
        ok: true, status: 200,
        json: async () => {
            if (++attempts === 1) throw new SyntaxError("HTML response");
            return { data: { list: [{ id: "42" }] } };
        },
    }));
    const result = await h.api.getLatestContent(1);
    assert.equal(result.list[0].id, "42");
    assert.equal(attempts, 2);
    assert.equal(h.timers.callbacks.size, 0);
});

test("bootstrap text bodies retain their timeout and retry after an interrupted download", async () => {
    let attempts = 0;
    const h = apiHarness(async (_, { signal }) => ({
        ok: true, status: 200,
        text: () => ++attempts === 1 ? hangingJsonResponse(signal).json() : Promise.resolve("fixture-bootstrap"),
    }));
    const request = h.api.retryFetch("fixture:bootstrap", {}, 2, (response) => response.text());
    await settle();
    assert.equal(h.timers.callbacks.size, 1);
    h.timers.fire();
    assert.equal(await request, "fixture-bootstrap");
    assert.equal(attempts, 2);
    assert.equal(h.timers.callbacks.size, 0);
});

function cutterHarness(failure = null) {
    const canvases = [];
    const ImageCutter = loadModule("reader/ImageCutter.js", "ImageCutter", {
        crypto: { calculateMD5: () => { throw new Error("Unexpected hashing"); } },
        document: {
            createDocumentFragment: () => new Element("fragment"),
            createElement: () => {
                const canvas = new Element("canvas");
                const position = canvases.length;
                canvas.getContext = (kind, options) => {
                    assert.equal(kind, "2d");
                    assert.equal(options.alpha, false);
                    if (failure === "context" && position === 2) return null;
                    return { drawImage: (...args) => {
                        if (failure === "drawing" && position === 2) throw new Error("drawing failed");
                        canvas.drawArguments = args;
                    } };
                };
                canvases.push(canvas);
                return canvas;
            },
        },
    });
    return { cutter: new ImageCutter(), canvases };
}

test("successful image restoration preserves reversed slice order and remainder pixels", () => {
    const h = cutterHarness();
    const image = { naturalWidth: 60, naturalHeight: 103 };
    const fragment = h.cutter.cutImage(image, 220980, "00001.jpg");
    assert.equal(fragment.children.length, 10);
    assert.equal(fragment.children.reduce((sum, canvas) => sum + canvas.height, 0), 103);
    fragment.children.forEach((canvas, index) => {
        const height = index === 0 ? 13 : 10;
        const sourceY = 90 - index * 10;
        assert.equal(canvas.width, 60);
        assert.equal(canvas.height, height);
        assert.deepEqual(canvas.drawArguments, [image, 0, sourceY, 60, height, 0, 0, 60, height]);
    });
});

test("image restoration frees every allocated canvas when a later slice fails", () => {
    for (const failure of ["context", "drawing"]) {
        const h = cutterHarness(failure);
        assert.throws(
            () => h.cutter.cutImage({ naturalWidth: 60, naturalHeight: 103 }, 220980, "00001.jpg"),
            failure === "context" ? /浏览器无法创建图片画布/ : /drawing failed/,
        );
        assert.equal(h.canvases.length, 3);
        h.canvases.forEach((canvas) => {
            assert.equal(canvas.width, 0);
            assert.equal(canvas.height, 0);
        });
    }
});

function checkInHarness(replies) {
    const requests = [];
    const api = loadModule('api/JmcomicApi.js', 'jmApi', {
        crypto: { calculateMD5: () => 'test', decryptData: (_key, value) => JSON.parse(value) },
        fetch: async (_url, options) => {
            const request = JSON.parse(options.body);
            requests.push(request);
            const next = replies.shift();
            if (next instanceof Error) throw next;
            if (!next) throw new Error('Unexpected request');
            return { ok: true, status: 200, json: async () => next };
        },
    });
    api.servers = ['fixture.invalid'];
    return { api, requests };
}
const dailyActivity = () => ({ code: 200, data: { daily_id: 68 } });

test('check-in distinguishes confirmed success, already checked in, and ambiguous rewards', async () => {
    for (const status of [1, true, 'success', 'ok', 200, '200']) {
        const { api, requests } = checkInHarness([dailyActivity(), { code: 200, data: { status, msg: '[EXP:10] [COIN:2]' } }]);
        const result = await api.dailyCheckIn('42');
        assert.equal(result.status, 'success');
        assert.match(result.message, /获得 10 经验.*获得 2 金币/);
        assert.equal(requests[0].path, '/daily?user_id=42');
        assert.deepEqual(requests[1].data, { user_id: '42', daily_id: '68' });
    }
    for (const msg of ['今天已经签到', '今日已經簽到', '重复签到', 'already checked in']) {
        const { api } = checkInHarness([dailyActivity(), { code: 200, data: { status: 0, msg } }]);
        assert.equal((await api.dailyCheckIn('42')).status, 'already');
    }
    for (const data of [{}, { msg: '[EXP:10]' }, { status: 'unknown', msg: '签到成功' }]) {
        const { api } = checkInHarness([dailyActivity(), { code: 200, data }]);
        await assert.rejects(api.dailyCheckIn('42'), /未确认成功/);
    }
});

test('check-in does not let success or reward text hide explicit failures', async () => {
    for (const data of [
        { status: 0, msg: '签到成功' },
        { status: 'success', msg: '签到失败 [EXP:10]' },
        { status: 1, msg: '尚未签到成功' },
        { status: 1, error: '登录失效' },
        { status: 1, msg: '没有签到成功' },
    ]) {
        const { api } = checkInHarness([dailyActivity(), { code: 200, data }]);
        await assert.rejects(api.dailyCheckIn('42'), /返回失败/);
    }
    const { api } = checkInHarness([dailyActivity(), { code: 500, msg: '服务繁忙', data: { status: 1 } }]);
    await assert.rejects(api.dailyCheckIn('42'), /服务繁忙/);
});

test('check-in preserves envelope messages and decodes encrypted responses', async () => {
    const { api } = checkInHarness([dailyActivity(), { code: 200, msg: '签到成功', data: {} }]);
    assert.equal((await api.dailyCheckIn('42')).status, 'success');
    const encrypted = checkInHarness([dailyActivity(), { code: 200, data: JSON.stringify({ status: 1, msg: '簽到成功' }) }]);
    assert.equal((await encrypted.api.dailyCheckIn('42')).status, 'success');
});

test('check-in identifies the failed stage and never retries an ambiguous POST', async () => {
    const before = checkInHarness([new Error('Failed to fetch')]);
    await assert.rejects(before.api.dailyCheckIn('42'), /尚未提交签到.*网络/);
    assert.equal(before.requests.length, 1);
    const after = checkInHarness([dailyActivity(), Object.assign(new Error('aborted'), { name: 'AbortError' })]);
    await assert.rejects(after.api.dailyCheckIn('42'), /结果未确认.*超时.*可能已生效/);
    assert.equal(after.requests.length, 2);
    assert.equal(after.api.dailyCheckInPromise, null);
    const invalid = checkInHarness([{ code: 200, data: {} }]);
    await assert.rejects(invalid.api.dailyCheckIn('42'), /尚未提交签到.*活动 ID/);
    assert.equal(invalid.requests.length, 1);
});

test('check-in coalesces same-account clicks, rejects cross-account overlap and permits later attempts', async () => {
    const { api, requests } = checkInHarness([dailyActivity(), { data: { status: 1 } }, dailyActivity(), { data: { msg: '今天已签到' } }]);
    const first = api.dailyCheckIn('42');
    const second = api.dailyCheckIn('42');
    await assert.rejects(api.dailyCheckIn('43'), /另一个账号/);
    await Promise.all([first, second]);
    assert.equal(requests.length, 2);
    assert.equal((await api.dailyCheckIn('42')).status, 'already');
    assert.equal(requests.length, 4);
});


test('check-in UI shows distinct tones and restores controls after every outcome', async () => {
    const labels = [{ textContent: '每日签到' }];
    const buttons = [{ disabled: false }];
    let result;
    const toasts = [];
    const shell = loadModule('ui/shell.js', 'new AppShell()', {
        icon: () => '',
        document: { querySelectorAll: selector => selector === '[data-checkin-label]' ? labels : buttons },
        authSession: { loadLocalConfig: async () => {}, isConfigured: true, loginFromLocalConfig: async () => ({ uid: '42' }) },
        jmApi: { dailyCheckIn: async () => { if (result instanceof Error) throw result; return result; } },
        showToast: (...args) => toasts.push(args),
    });
    for (const [value, tone] of [
        [{ status: 'success', message: '签到成功' }, 'success'],
        [{ status: 'already', message: '今天已签到' }, 'default'],
        [new Error('签到结果未确认：请求超时'), 'warning'],
        [new Error('签到接口返回失败：登录失效'), 'warning'],
    ]) {
        result = value;
        await shell.checkIn();
        assert.equal(toasts.at(-1)[1], tone);
        assert.equal(labels[0].textContent, '每日签到');
        assert.equal(buttons[0].disabled, false);
        assert.equal(shell.checkingIn, false);
    }
});
