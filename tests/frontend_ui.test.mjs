import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const { prepareContent } = await import('data:text/javascript;base64,' + Buffer.from(
    await readFile(new URL('../project/src/local/ContentPreparation.js', import.meta.url), 'utf8')
).toString('base64'));

test('content preparation balances training/candidates, deduplicates and respects budget', async () => {
    const prepared = [], requests = [];
    const result = await prepareContent({
        runtime: {
            planContent: async () => ({ configured: true,
                training: [{ id: '1' }, { id: '2' }], candidates: [{ id: '1' }, { id: '3' }] }),
            prepareContent: async item => { prepared.push(item); return { status: 'ready' }; },
        },
        api: { getComicComments: async (id, page) => { requests.push([id, page]); return { total: 100, list: [{ content: 'test' }] }; } },
        candidates: [], budget: 2, stopped: () => false, progress() {},
    });
    assert.equal(prepared.length, 2);
    assert.equal(new Set(prepared.map(r => r.id)).size, 2);
    assert.equal(requests.length, 4);
    assert.equal(result.remaining, 1);
});

test('content failure is recorded without discarding candidates; stop launches no further calls', async () => {
    let stopped = false, calls = 0;
    const plan = { configured: true, training: [], candidates: [{ id: '1' }, { id: '2' }] };
    const runtime = { planContent: async () => plan, prepareContent: async item => {
        assert.equal(item.comments_status, 'error'); calls++; return { status: 'error' };
    } };
    const api = { getComicComments: async () => { throw Error('network'); } };
    const result = await prepareContent({ runtime, api, candidates: [], budget: 1, stopped: () => stopped, progress() {} });
    assert.equal(calls, 1);
    assert.equal(result.failed, 1);
    stopped = true;
    await prepareContent({ runtime, api, candidates: [], budget: 2, stopped: () => stopped, progress() {} });
    assert.equal(calls, 1);
});

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
    removeAttribute(name) { delete this.attributes[name]; }
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
        jmApi, authSession, mountShell() {}, openAccount() {}, icon() { return ""; }, setting: { init() {} },
        SwitchServerBtnManager: class {}, showToast: (...args) => toasts.push(args),
        renderPageError() {}, localRuntime: {}, openInNewPage() {},
        escapeHtml: value => String(value ?? ''), comicPayload: album => ({id:String(album.id)}),
        textList: value => Array.isArray(value) ? value : [], confirmAction: async () => true,
        EagerComicImageLoader: class {},
    };
    const context = vm.createContext({ document, window, location: { pathname: '/messages.html' },
        setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 0), console,
        CustomEvent: class {}, IntersectionObserver: class { observe() {} disconnect() {} },
    });
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
    return { exports: module.namespace, document, window, jmApi, authSession, localRuntime: dependencies.localRuntime, toasts, runTimers };
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

test('opening a sheet twice and closing it restores scroll position and focus', async () => {
    const { exports, document, window, runTimers } = await environment('ui/overlay.js');
    const sheet = new exports.Sheet({name: 'account', title: 'Account'});
    sheet.open(); sheet.open();
    assert.equal(document.body.style.position, 'fixed');
    sheet.close();
    assert.notEqual(document.body.style.position, 'fixed');
    assert.equal(window.restoredY, 420);
    assert.equal(document.activeElement.focused, true);
    assert.equal(sheet.root.inert, true);
    runTimers(80);
    assert.equal(sheet.body.querySelector('a').focused, undefined);
});

test('closing before the focus timer and rapidly reopening keeps one scroll lock', async () => {
    const { exports, document, runTimers } = await environment('ui/overlay.js');
    const sheet = new exports.Sheet({name:'more'});
    sheet.open(); sheet.close(); sheet.open(); runTimers(80);
    assert.equal(sheet.isOpen, true);
    assert.equal(document.body.style.position, 'fixed');
    document.dispatch('keydown', {key:'Escape'});
    assert.equal(sheet.isOpen, false);
    assert.notEqual(document.body.style.position, 'fixed');
});

test('nested sheets keep background inert and preserve the parent scroll lock', async () => {
    const { exports, document } = await environment('ui/overlay.js');
    const main = new Element(); main.inert = false; document.body.appendChild(main);
    const first = new exports.Sheet({name:'account'});
    const second = new exports.Sheet({name:'confirm'});
    first.open(); second.open();
    assert.equal(main.inert, true);
    assert.equal(first.root.inert, true);
    assert.equal(second.root.inert, false);
    document.dispatch('keydown', {key:'Escape'});
    assert.equal(first.root.inert, false);
    assert.equal(document.body.style.position, 'fixed');
    document.dispatch('keydown', {key:'Escape'});
    assert.equal(main.inert, false);
    assert.notEqual(document.body.style.position, 'fixed');
});

test('toast is removed even if Safari emits no transitionend', async () => {
    const { exports, document, runTimers } = await environment('ui/toast.js');
    exports.showToast('offline');
    const toast = document.querySelector('.toast-region').children[0];
    runTimers(0);
    runTimers(3200);
    assert.equal(toast.isConnected, true);
    runTimers(400);
    assert.equal(toast.isConnected, false);
});


test('a reset discards the late result of an older feed page', async () => {
    const {exports} = await environment('ui/feed.js');
    const old = deferred(); let first = true; const rendered = [];
    const feed = new exports.Feed({footer:new Element(), loadPage:async (page, current) => {
        const value = first ? (first = false, await old.promise) : 'fresh';
        if (current()) rendered.push(value);
        return {done:true,count:1};
    }});
    const pending = feed.loadNext();
    await feed.restart(); old.resolve('stale'); await pending;
    assert.deepEqual(rendered,['fresh']);
    assert.equal(feed.page,1); assert.equal(feed.loading,false);
});

test('feed retry keeps the failed page number and prevents concurrent duplicate loads', async () => {
    const {exports} = await environment('ui/feed.js');
    const requested=[]; let fail = true;
    const feed = new exports.Feed({footer:new Element(), loadPage:async page => { requested.push(page); if(fail) throw new Error('offline'); return {done:true,count:2}; }});
    await feed.loadNext(); assert.equal(feed.page,0); assert.equal(feed.failed,true);
    fail=false; await Promise.all([feed.loadNext(),feed.loadNext()]);
    assert.deepEqual(requested,[1,1]); assert.equal(feed.done,true); assert.equal(feed.failed,false);
});

test('interest feedback clears only the selected dimension and keeps other states', async () => {
    const {exports,localRuntime} = await environment('ui/interest.js');
    const feedback = new exports.InterestFeedback(new Element(),{id:'42'});
    feedback.states={cover:{action:'interested'},title:{action:'not_interested'}};
    const requests=[];
    localRuntime.saveRecommendationFeedback=async value => {
        requests.push(value);
        return {interest_feedback:{title:{action:'not_interested'}}};
    };
    await feedback.save('cover','interested');
    assert.equal(requests[0].action,'clear'); assert.equal(requests[0].reason,'cover');
    assert.equal(feedback.states.cover,undefined); assert.equal(feedback.states.title.action,'not_interested');
});

test('failed interest loads do not overwrite an unknown saved state', async () => {
    const {exports,localRuntime} = await environment('ui/interest.js');
    const root=new Element();const feedback=new exports.InterestFeedback(root,{id:'42'});
    localRuntime.getLocalComic=async()=>{throw new Error('offline');};
    let writes=0; localRuntime.saveRecommendationFeedback=async()=>{writes++;};
    await feedback.load(); await feedback.save('cover','interested');
    assert.equal(writes,0); assert.equal(root.querySelector('[data-retry-interest]').hidden,false);
    localRuntime.getLocalComic=async()=>({comic:{interest_feedback:{cover:{action:'interested'}}}});
    await feedback.load();assert.equal(feedback.loadFailed,false);assert.equal(feedback.states.cover.action,'interested');
});

test('a failed rating save preserves the score, review and tag draft for retry', async () => {
    const {exports,localRuntime} = await environment('ui/rating.js');
    const root=new Element(); const editor=new exports.RatingEditor(root,{id:'42'});
    editor.score=9; editor.tagFeedback={travel:1};root.querySelector('textarea').value='my review';
    localRuntime.saveLocalComic=async()=>{throw new Error('offline');};
    await editor.save();
    assert.equal(editor.score,9);assert.equal(editor.tagFeedback.travel,1);assert.equal(root.querySelector('textarea').value,'my review');assert.equal(editor.saving,false);
    assert.match(root.querySelector('[data-rating-status]').textContent,/offline/);
});

test('rating summary displays complete model text safely and labels stale output', async () => {
    const {exports} = await environment('ui/rating.js');
    const root = new Element(); const editor = new exports.RatingEditor(root, {id:'42'});
    editor.watchSemantics({status:'ready', current:true, text:'评价总结\n<img src=x onerror=alert(1)>\n完整返回'});
    assert.equal(root.querySelector('[data-summary-text]').textContent, '评价总结\n<img src=x onerror=alert(1)>\n完整返回');
    assert.equal(root.querySelector('[data-summary-text]').innerHTML, '');
    editor.watchSemantics({status:'stale', current:false, text:'旧总结'});
    assert.match(root.querySelector('[data-summary-text]').textContent, /上次总结/);
    editor.watchSemantics({status:'unrated', current:false, text:''});
    assert.equal(root.querySelector('[data-summary-text]').textContent, '');
});

test('a late summary poll cannot replace a newer saved review result', async () => {
    const {exports, localRuntime, runTimers} = await environment('ui/rating.js');
    const root = new Element(); const editor = new exports.RatingEditor(root, {id:'42'});
    const old = deferred();
    localRuntime.getRatingSemantics = () => old.promise;
    editor.watchSemantics({status:'running', current:false, text:''});
    runTimers(1500);
    editor.watchSemantics({status:'ready', current:true, text:'新评语的总结'});
    old.resolve({status:'ready', current:true, text:'旧评语的总结'});
    await old.promise;
    assert.equal(root.querySelector('[data-summary-text]').textContent, '新评语的总结');
});

test('seeking clamps page numbers and realigns after earlier images change height', async () => {
    const {exports,window} = await environment('reader/ReaderViewport.js');
    const viewport=Object.create(exports.ReaderViewport.prototype);
    let scrollY=0, stable=false;const offsets=[0,1000,2000];
    window.scrollBy=({top})=>{scrollY+=top;};
    viewport.nodes=offsets.map((_,i)=>({getBoundingClientRect:()=>({top:offsets[i]-scrollY})}));
    viewport.loader={setCurrent(){},isLayoutStableBefore:()=>stable};
    viewport.seek(99);assert.equal(viewport.current,2);assert.equal(scrollY,2000);assert.equal(viewport.seeking,2);
    offsets[2]=2500;viewport.realign();assert.equal(scrollY,2500);
    stable=true;viewport.realign();assert.equal(viewport.seeking,null);
    viewport.seek(-4);assert.equal(viewport.current,0);
});
