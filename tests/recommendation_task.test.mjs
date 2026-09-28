import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { RecommendationTask } = await import('data:text/javascript;base64,' + Buffer.from(
    await readFile(new URL('../project/src/local/RecommendationTask.js', import.meta.url), 'utf8')
).toString('base64'));
const storage = () => {
    const map = new Map();
    return { getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, v),
        get length() { return map.size; }, key: i => [...map.keys()][i] };
};

test('lost acknowledgement retries the same durable payload; only matching ack clears payload', async () => {
    const disk = storage();
    let attempts = 0, id;
    const task = new RecommendationTask({ storage: disk, sleep: async () => {}, api: {}, runtime: {
        submitRecommendationJob: async record => {
            attempts++;
            assert.deepEqual(task.read().payload, { candidates: [{ id: '1' }] });
            id ||= record.id;
            assert.equal(record.id, id);
            if (attempts < 3) throw Error('connection lost after commit');
            return { accepted: true, id };
        },
        getRecommendationJob: async () => ({ id, status: 'success', result: { id: 3 } }),
    } });
    task.create({ candidates: [{ id: '1' }] });
    assert.equal((await task.run()).status, 'success');
    assert.equal(attempts, 3);
    assert.equal(task.read().payload, undefined);
    assert.equal(task.read().id, id);
});

test('refresh restores unacknowledged payload; mismatched ack never removes it', async () => {
    const disk = storage();
    const before = new RecommendationTask({ storage: disk });
    before.create({ candidates: [{ id: '1' }] });
    const after = new RecommendationTask({ storage: disk, runtime: {
        submitRecommendationJob: async () => ({ accepted: true, id: 'wrong-task' }),
    } });
    assert.equal(await after.restore(), true);
    await assert.rejects(after.run(), /未确认/);
    assert.ok(after.read().payload);
});

test('refresh skips acknowledged comments and reconnects to a running backend task', async () => {
    const disk = storage();
    const initial = { id: 'existing', status: 'awaiting_comments', received_ids: ['1'], plan: [{ id: '1' }, { id: '2' }] };
    let polled = 0, uploaded = 0, fetched = 0;
    const task = new RecommendationTask({ storage: disk, sleep: async () => {}, api: {
        getComicComments: async id => { assert.equal(id, '2'); fetched++; return { list: [], total: 0 }; },
    }, runtime: {
        getRecommendationJobs: async () => ({ jobs: [initial] }),
        getRecommendationJob: async () => {
            polled++;
            if (polled === 2) throw Error('temporary outage');
            return polled === 1 ? initial : { id: 'existing', status: 'success' };
        },
        uploadRecommendationSource: async (id, source) => {
            assert.equal(source.id, '2'); uploaded++;
            return { id, received_ids: ['1', '2'] };
        },
    } });
    await task.restore();
    assert.equal((await task.run()).status, 'success');
    assert.equal(fetched, 1);
    assert.equal(uploaded, 1);
    assert.equal(polled, 3);
});

test('cancellation is persisted and sent after restoring connection', async () => {
    const disk = storage();
    const task = new RecommendationTask({ storage: disk });
    task.create({ candidates: [] });
    task.cancel();
    const next = new RecommendationTask({ storage: disk, runtime: {
        submitRecommendationJob: async ({ id }) => ({ id, accepted: true }),
        getRecommendationJob: async id => ({ id, status: 'running' }),
        cancelRecommendationJob: async id => ({ id, status: 'cancelled' }),
    } });
    await next.restore();
    assert.equal((await next.run()).status, 'cancelled');
});

test('permanent rejection preserves payload instead of silently dropping or retrying forever', async () => {
    const task = new RecommendationTask({ storage: storage(), runtime: {
        submitRecommendationJob: async () => { throw Object.assign(Error('invalid input'), { status: 400 }); },
    } });
    task.create({ candidates: [] });
    await assert.rejects(task.run(), /invalid input/);
    assert.ok(task.read().payload);
});

test('an old completed browser task does not hide an active server task', async () => {
    const disk = storage();
    const task = new RecommendationTask({ storage: disk, runtime: {
        getRecommendationJobs: async () => ({ jobs: [{ id: 'new', status: 'running' }] }),
        getRecommendationJob: async id => ({ id, status: 'success' }),
    } });
    task.save({ id: 'old' });
    await task.restore();
    assert.equal(task.record.id, 'new');
});

test('retry backs off to a bounded delay without a retry count limit', async () => {
    const delays = [];
    const task = new RecommendationTask({ storage: storage(), sleep: async ms => delays.push(ms) });
    let attempt = 0;
    assert.equal(await task.retry(async () => { if (++attempt < 8) throw Error('offline'); return 'ok'; }), 'ok');
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
});

test('another tab cannot overwrite unacknowledged candidate data', async () => {
    const disk = storage();
    const first = new RecommendationTask({ storage: disk });
    const a = first.create({ candidates: [{ id: '1' }] });
    const second = new RecommendationTask({ storage: disk });
    second.create({ candidates: [{ id: '2' }] });
    assert.deepEqual(first.read(a.id).payload.candidates, [{ id: '1' }]);
    const restored = new RecommendationTask({ storage: disk });
    await restored.restore();
    assert.equal(restored.record.id, a.id);
});
