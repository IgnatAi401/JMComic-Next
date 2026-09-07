import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
    style = {};
    dataset = {};
    attributes = {};
    listeners = new Map();
    nodes = new Map();
    children = [];
    hidden = false;
    disabled = false;
    textContent = '';
    value = '';
    isConnected = true;
    classes = new Set();
    classList = {
        add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)),
        contains: name => this.classes.has(name),
    };
    querySelector(selector) {
        if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
        return this.nodes.get(selector);
    }
    querySelectorAll() { return []; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(callback);
    }
    dispatch(name, event = {}) { this.listeners.get(name)?.forEach(callback => callback(event)); }
    appendChild(node) { this.children.push(node); }
    replaceChildren(...nodes) { this.children = nodes; this.html = ''; }
    remove() { this.isConnected = false; }
    focus() { this.focused = true; }
    set innerHTML(value) { this.html = value; this.children = value ? [{}] : []; }
    get innerHTML() { return this.html || ''; }
}

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
};

async function environment(file, bootstrap = '') {
    const document = new Element();
    document.body = new Element();
    document.documentElement = new Element();
    document.activeElement = new Element();
    document.createElement = () => new Element();
    const window = new Element();
    window.scrollY = 420;
    window.scrollTo = (_x, y) => { window.restoredY = y; };
    const timers = new Map();
    let timerId = 0;
    const setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
    const clearTimeout = id => timers.delete(id);
    const jmApi = { init: async () => {}, getCoverImageURL: () => '/fixture.svg' };
    const authSession = { loadLocalConfig: async () => {}, loginFromLocalConfig: async () => {}, isConfigured: true };
    const toasts = [];
    const dependencies = {
        jmApi, authSession, NavManager: class {}, setting: { init() {} },
        SwitchServerBtnManager: class {}, showToast: (...args) => toasts.push(args),
        renderPageError() {}, ImageLoadBatchManager: class {}, localRuntime: {}, openInNewPage() {},
    };
    const context = vm.createContext({ document, window, location: { pathname: '/messages.html' },
        setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 0), console });
    let source = await readFile(new URL(`../project/src/${file}`, import.meta.url), 'utf8');
    if (bootstrap) source = source.slice(0, source.indexOf(bootstrap));
    const module = new vm.SourceTextModule(source, { context });
    await module.link(() => new vm.SyntheticModule(Object.keys(dependencies), function () {
        for (const [key, value] of Object.entries(dependencies)) this.setExport(key, value);
    }, { context }));
    await module.evaluate();
    const runTimers = delay => {
        for (const [id, timer] of [...timers]) {
            if (timer.delay !== delay || !timers.has(id)) continue;
            timers.delete(id);
            timer.callback();
        }
    };
    return { exports: module.namespace, document, window, jmApi, authSession, toasts, runTimers };
}

async function messages() {
    const env = await environment('pages/messages.js', '\nnew MessagesPage()');
    const page = new env.exports.MessagesPage();
    page.status = env.document.querySelector('.message-status');
    page.notificationList = env.document.querySelector('.notification-list');
    page.trackingList = env.document.querySelector('.tracking-list');
    page.moreButton = env.document.querySelector('.tracking-more');
    env.jmApi.getNotifications = async () => [];
    env.jmApi.getAlbumTrackingList = async () => ({ list: [], total: 0 });
    return { ...env, page };
}

const tracking = id => ({ list: [{ id, name: id }], total: 5 });

test('refresh replaces an in-flight tracking pagination without accepting its late result', async () => {
    const { page, jmApi } = await messages();
    const old = deferred();
    jmApi.getAlbumTrackingList = n => n === 2 ? old.promise : Promise.resolve(tracking('fresh'));
    const pending = page.loadTracking(2, true);
    await page.loadAll();
    assert.equal(page.trackingItems[0].id, 'fresh');
    old.resolve(tracking('stale'));
    await pending;
    assert.deepEqual(Array.from(page.trackingItems, item => item.id), ['fresh']);
    assert.equal(page.trackingPage, 1);
    assert.equal(page.moreButton.disabled, false);
});

test('a notification failure preserves successful tracking and reports partial failure', async () => {
    const { page, jmApi } = await messages();
    jmApi.getNotifications = async () => { throw new Error('offline'); };
    jmApi.getAlbumTrackingList = async () => tracking('available');
    await page.loadAll();
    assert.match(page.trackingList.innerHTML, /available/);
    assert.match(page.status.textContent, /通知：offline/);
    assert.doesNotMatch(page.status.textContent, /已同步/);
    assert.match(page.notificationList.innerHTML, /刷新重试/);
});

test('failed refresh retains a previously loaded panel', async () => {
    const { page, jmApi } = await messages();
    await page.loadAll();
    page.notificationList.innerHTML = '<article>existing</article>';
    jmApi.getNotifications = async () => { throw new Error('offline'); };
    await page.loadAll();
    assert.match(page.notificationList.innerHTML, /existing/);
});

test('changing accounts clears stale panels and pagination before a partial failure', async () => {
    const { page, jmApi, authSession } = await messages();
    authSession.user = { uid: 'account-a' };
    jmApi.getAlbumTrackingList = async () => tracking('account-a-item');
    await page.loadAll();
    await page.loadMoreTracking();
    assert.equal(page.trackingPage, 2);
    authSession.user = { uid: 'account-b' };
    jmApi.getAlbumTrackingList = async () => { throw new Error('offline'); };
    await page.loadAll();
    assert.equal(page.trackingPage, 1);
    assert.equal(page.trackingItems.length, 0);
    assert.doesNotMatch(page.trackingList.innerHTML, /account-a-item/);
    assert.match(page.trackingList.innerHTML, /刷新重试/);
    assert.equal(page.moreButton.hidden, true);
});

test('load more failure is handled and leaves the page available for retry', async () => {
    const { page, jmApi, toasts } = await messages();
    jmApi.getAlbumTrackingList = async () => { throw new Error('retry me'); };
    await page.loadMoreTracking();
    assert.equal(page.trackingPage, 1);
    assert.equal(page.moreButton.disabled, false);
    assert.equal(page.status.textContent, 'retry me');
    assert.equal(toasts.length, 1);
    jmApi.getAlbumTrackingList = async () => tracking('retried');
    await page.loadMoreTracking();
    assert.equal(page.trackingPage, 2);
});

async function navigation() {
    const env = await environment('components/general/NavManager.js');
    const nav = Object.create(env.exports.NavManager.prototype);
    nav.navDom = new Element(); nav.mobileNavDom = new Element(); nav.dockDom = new Element();
    nav.renderAccount = () => {};
    nav.loadEmbeddingConfig = () => {};
    nav.loadAiConfig = () => {};
    nav.bindEvents();
    return { ...env, nav };
}

test('opening a modal twice and closing it restores scrolling and focus', async () => {
    const { nav, document, window, runTimers } = await navigation();
    await nav.openAuthModal();
    await nav.openAuthModal();
    assert.equal(document.body.style.position, 'fixed');
    document.querySelector('.auth-modal').querySelector('.modal-close').dispatch('click');
    assert.notEqual(document.body.style.position, 'fixed');
    assert.equal(window.restoredY, 420);
    assert.equal(document.activeElement.focused, true);
    runTimers(100);
    assert.equal(document.querySelector('.auth-modal').querySelector('[name="username"]').focused, undefined);
});

test('drawer close before its first frame and rapid reopen do not leave a scroll lock', async () => {
    const { nav, document, runTimers } = await navigation();
    const open = nav.navDom.querySelector('.page-list-btn');
    const close = nav.mobileNavDom.querySelector('.drawer-close');
    open.dispatch('click');
    close.dispatch('click');
    open.dispatch('click');
    runTimers(240);
    runTimers(0);
    assert.equal(nav.mobileNavDom.style.display, 'block');
    assert.equal(nav.mobileNavDom.classList.contains('show'), true);
    document.dispatch('keydown', { key: 'Escape' });
    assert.notEqual(document.body.style.position, 'fixed');
});

test('closing a nested modal keeps the drawer scroll lock until Escape closes the drawer', async () => {
    const { nav, document, runTimers } = await navigation();
    nav.navDom.querySelector('.page-list-btn').dispatch('click');
    runTimers(0);
    await nav.openAuthModal();
    document.dispatch('keydown', { key: 'Escape' });
    assert.equal(document.body.style.position, 'fixed');
    document.dispatch('keydown', { key: 'Escape' });
    assert.notEqual(document.body.style.position, 'fixed');
});

test('toast is removed even if Safari emits no transitionend', async () => {
    const { exports, document, runTimers } = await environment('components/general/Toast.js');
    exports.showToast('offline');
    const toast = document.querySelector('.toast-region').children[0];
    runTimers(0);
    runTimers(3200);
    assert.equal(toast.isConnected, true);
    runTimers(400);
    assert.equal(toast.isConnected, false);
});
