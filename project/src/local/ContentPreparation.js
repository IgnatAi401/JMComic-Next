// Bounded preparation shared by the page and offline tests. Cancellation stops
// scheduling new requests; already dispatched provider calls may finish/cache.
export async function prepareContent({ runtime, api, candidates, budget, stopped, progress }) {
    const plan = await runtime.planContent(candidates);
    if (!plan.configured || stopped()) return { prepared: 0, failed: 0, remaining: plan.training.length + plan.candidates.length, configured: plan.configured };
    const pending = [];
    const seen = new Set();
    for (let i = 0; i < Math.max(plan.training.length, plan.candidates.length); i++) {
        for (const item of [plan.training[i], plan.candidates[i]]) {
            if (item && !seen.has(item.id)) { pending.push(item); seen.add(item.id); }
        }
    }
    const queue = pending.slice(0, Math.max(0, Math.min(500, budget)));
    let cursor = 0, prepared = 0, failed = 0, finished = 0;
    const worker = async () => {
        while (!stopped() && cursor < queue.length) {
            const item = queue[cursor++];
            const comments = [];
            let total = null, status = 'ready';
            for (let page = 1; page <= 2 && !stopped(); page++) {
                try {
                    const result = await api.getComicComments(item.id, page);
                    comments.push(...result.list);
                    total = result.total;
                    if (!result.list.length || comments.length >= total) break;
                } catch { status = 'error'; break; }
            }
            if (stopped()) break;
            try {
                const result = await runtime.prepareContent({ ...item, comments, comments_total: total, comments_status: status });
                if (result.status === 'ready' || result.status === 'cached') prepared++;
                else failed++;
            } catch { failed++; }
            finished++;
            progress({ finished, total: queue.length, failed, remaining: pending.length - finished });
        }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    return { prepared, failed, remaining: pending.length - finished, configured: true };
}
