const KEY = 'jm.recommendation.delivery.v1';
const TERMINAL = new Set(['success', 'failed', 'cancelled', 'interrupted']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A payload is removed only after a matching durable server acknowledgement.
export class RecommendationTask {
    constructor({ runtime, api, storage = localStorage, progress = () => {}, sleep = pause }) {
        Object.assign(this, { runtime, api, storage, progress, sleep });
    }
    read(id = null) {
        const raw = this.storage.getItem(id ? `${KEY}.${id}` : KEY);
        if (!raw) return null;
        const record = JSON.parse(raw);
        if (!record?.id) throw new Error('推荐恢复记录损坏，请保留浏览器数据并联系维护者');
        return id ? record : this.read(record.id) || record;
    }
    pending() {
        // Separate records prevent a second tab from overwriting an unsent payload.
        for (let i = 0; i < this.storage.length; i++) {
            const key = this.storage.key(i);
            if (key?.startsWith(`${KEY}.`)) {
                const record = JSON.parse(this.storage.getItem(key));
                if (record?.payload) return record;
            }
        }
        return null;
    }
    save(record) {
        try {
            this.storage.setItem(`${KEY}.${record.id}`, JSON.stringify(record));
            this.storage.setItem(KEY, JSON.stringify({ id: record.id }));
        }
        catch { throw new Error('无法保存推荐恢复数据（浏览器存储不可用或已满），请释放空间后重试'); }
    }
    create(payload) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        const record = { id: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''), payload };
        this.record = record;
        this.save(record);
        return record;
    }
    cancel() {
        if (!this.record) return;
        this.record.cancel = true;
        this.save(this.record);
    }
    async retry(operation) {
        let delay = 1000;
        for (;;) {
            try { return await operation(); }
            catch (error) {
                if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) throw error;
                this.progress(`连接中断，任务状态尚未确认；${Math.round(delay / 1000)} 秒后自动重连。待确认数据仍保留。`);
                await this.sleep(delay);
                delay = Math.min(15000, delay * 2);
            }
        }
    }
    async restore() {
        this.record = this.pending() || this.read();
        if (this.record?.payload) return true;
        const { jobs } = await this.runtime.getRecommendationJobs();
        const current = this.record && await this.runtime.getRecommendationJob(this.record.id);
        const job = (current && !TERMINAL.has(current.status) ? current : null)
            || jobs.find(j => !TERMINAL.has(j.status)) || current || jobs[0];
        if (!job) return false;
        this.record = { id: job.id };
        this.save(this.record);
        return true;
    }
    async run() {
        const record = this.record;
        let job;
        if (record.payload) {
            this.progress('初筛结果已缓存，正在等待服务器落盘确认…');
            job = await this.retry(() => this.runtime.submitRecommendationJob(record));
            if (!job.accepted || job.id !== record.id) throw new Error('服务器未确认接收同一任务，初筛缓存仍保留');
            delete record.payload;
            this.save(record);
        }
        for (;;) {
            job = await this.retry(() => this.runtime.getRecommendationJob(record.id));
            if (job.id !== record.id) throw new Error('服务器返回的任务编号不匹配');
            if (TERMINAL.has(job.status)) return job;
            // Read cancellation written by another tab too.
            record.cancel ||= this.read(record.id)?.cancel;
            if (record.cancel) {
                job = await this.retry(() => this.runtime.cancelRecommendationJob(record.id));
                this.progress('正在停止后台任务；已发出的分析会完成并保留缓存…');
                if (TERMINAL.has(job.status)) return job;
            } else if (job.status === 'awaiting_comments') {
                const received = new Set(job.received_ids);
                const pending = job.plan.filter(item => !received.has(item.id));
                this.progress(`候选已由服务器保存 · 收集评论 ${received.size}/${job.plan.length}（刷新后可继续）`);
                // Bounded uploads keep every request below the server body limit.
                let cursor = 0;
                const worker = async () => {
                    while (!record.cancel && cursor < pending.length) {
                        const item = pending[cursor++];
                        const comments = [];
                        let total = null, status = 'ready';
                        for (let page = 1; page <= 2 && !record.cancel; page++) {
                            try {
                                const result = await this.api.getComicComments(item.id, page);
                                comments.push(...result.list.slice(0, 60 - comments.length).map(c => ({
                                    id: String(c.id || '').slice(0, 100), content: String(c.content || '').slice(0, 2000),
                                })));
                                total = result.total;
                                if (!result.list.length || comments.length >= total || comments.length >= 60) break;
                            } catch { status = 'error'; break; }
                        }
                        if (record.cancel) return;
                        const ack = await this.retry(() => this.runtime.uploadRecommendationSource(record.id, {
                            id: item.id, comments, comments_total: total, comments_status: status,
                        }));
                        if (ack.id === record.id && (TERMINAL.has(ack.status) || ack.status === 'cancelling')) return;
                        if (ack.id !== record.id || !ack.received_ids.includes(item.id)) throw new Error('服务器未确认评论接收，任务保留待恢复');
                        this.progress(`候选已保存 · 评论已确认 ${ack.received_ids.length}/${job.plan.length}`);
                    }
                };
                await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
            } else {
                const label = job.status === 'planning' ? '后台正在规划分析任务' : job.status === 'cancelling'
                    ? '后台正在停止' : job.stage === 'ranking' ? '后台正在排序并保存推荐'
                    : `后台正在提取内容证据 · ${job.finished}/${job.plan.length} · 失败 ${job.failed}`;
                this.progress(`${label} · 连接正常 · ${new Date().toLocaleTimeString('zh-CN')}`);
            }
            await this.sleep(1500);
        }
    }
}
