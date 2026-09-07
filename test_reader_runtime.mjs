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
        this.style = {};
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

function readerHarness({ cache = () => Promise.resolve({ queued: true }), onLayoutChange = null } = {}) {
    const timers = fakeTimers();
    const frames = fakeTimers();
    const listeners = new Map();
    const calls = { cache: 0, cancel: 0 };
    const EagerComicImageLoader = loadModule("components/chapter/EagerComicImageLoader.js", "EagerComicImageLoader", {
        ...timers,
        requestAnimationFrame: frames.setTimeout,
        cancelAnimationFrame: frames.clearTimeout,
        navigator: { userAgent: "Version/18.0 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 0 },
        window: { addEventListener: (name, callback) => listeners.set(name, callback) },
        document: { createElement: (name) => new Element(name) },
        ImageCutter: class { cutImage() { throw new Error("Unexpected image cutting"); } },
        jmApi: {
            getChapterImageServers: () => ["fixture.invalid"],
            getCachedChapterImageURL: (_, path) => `fixture:${path}`,
        },
        localRuntime: {
            cacheChapterImages: () => { calls.cache++; return cache(); },
            cancelChapterImages: () => { calls.cancel++; },
        },
    });
    const loader = new EagerComicImageLoader("100", { onLayoutChange });
    const containers = [0, 1, 2].map((index) => {
        const element = new Element();
        element.dataset = { index: String(index), path: `${index}.jpg`, state: "pending" };
        return element;
    });
    return { loader, containers, timers, frames, listeners, calls };
}

test("a failed chapter registration can recover through the existing retry button", async () => {
    let online = false;
    const h = readerHarness({ cache: () => online ? Promise.resolve({ queued: true }) : Promise.reject(new Error("offline")) });
    h.loader.start(h.containers);
    await settle();
    assert.equal(h.containers[0].dataset.state, "error");
    assert.equal(h.calls.cache, 1);

    // Neighboring page loads must not repeatedly retry an errored page.
    h.loader.updateRenderWindow();
    await settle();
    assert.equal(h.calls.cache, 1);
    assert.equal(h.containers[0].dataset.state, "error");

    online = true;
    h.containers[0].children[0].children[1].events.get("click")();
    await settle();
    assert.equal(h.calls.cache, 2);
    const image = h.containers[0].children[0];
    assert.equal(image.tagName, "img");
    image.onload();
    await settle();
    assert.equal(h.containers[0].dataset.state, "loaded");
    h.loader.suspend();
    await settle();
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
    assert.equal(h.calls.cancel, 1);
    assert.equal(oldImage.src, undefined);
    assert.equal(oldImage.onload, null);
    assert.equal(h.containers[0].style.height, "900px");
    assert.equal(h.timers.callbacks.size, 0);
    lateLoad();
    assert.equal(h.containers[0].dataset.state, "pending");

    h.listeners.get("pageshow")({ persisted: true });
    await settle();
    assert.equal(h.calls.cache, 2);
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

for (const beaconResult of [false, "throw", true]) {
    test(`chapter cancellation falls back only when a beacon is not queued (${beaconResult})`, async () => {
        const requests = [];
        const runtime = loadModule("local/LocalRuntime.js", "localRuntime", {
            navigator: { sendBeacon: () => {
                if (beaconResult === "throw") throw new Error("queue unavailable");
                return beaconResult;
            } },
            fetch: async (...args) => { requests.push(args); return { ok: true }; },
        });
        assert.equal(runtime.cancelChapterImages("123"), true);
        assert.equal(requests.length, beaconResult === true ? 0 : 1);
        if (requests.length) {
            assert.equal(requests[0][1].keepalive, true);
            assert.deepEqual(JSON.parse(requests[0][1].body), { chapter: "123" });
        }
        await settle();
    });
}

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
    const ImageCutter = loadModule("components/general/ImageCutter.js", "ImageCutter", {
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
