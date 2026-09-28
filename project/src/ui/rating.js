import { jmApi } from "../api/JmcomicApi.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { comicPayload, escapeHtml, textList } from "./dom.js";
import { showToast } from "./toast.js";
import { confirmAction } from "./confirm.js";

const TAG_STATES = [0, 1, -1, -2];
const TAG_LABELS = { 0: "未表态", 1: "喜欢", "-1": "软回避", "-2": "硬屏蔽" };
const SCORE_LABELS = ["不值得读", "雷点明显", "中规中矩", "值得一看", "非常优秀"];

export class RatingEditor {
    constructor(root, album) { this.root = root; this.album = album; this.score = null; this.tagFeedback = {}; }

    async mount() {
        this.root.innerHTML = `<div class="section-head"><h2 class="section-title">我的评价</h2><span class="rating-value num">— <small>/ 10</small></span></div>
            <fieldset class="rating-fieldset"><legend class="visually-hidden">总评分，1 至 10 分</legend><div class="rating-buttons">${Array.from({ length: 10 }, (_, i) => `<button type="button" data-score="${i + 1}" aria-pressed="false" aria-label="${i + 1} 分">${i + 1}</button>`).join("")}</div></fieldset>
            <p class="rating-caption picker-note">按整体阅读体验评分</p>
            <details class="disclosure rating-rules"><summary>评分参考</summary><ul><li>1–2 分：垃圾作品，看了浪费时间</li><li>3–4 分：有严重雷点</li><li>5–6 分：中规中矩</li><li>7–8 分：整体及格且有亮点</li><li>9–10 分：全方面优秀</li></ul></details>
            <div class="rating-tags"><h3 class="field-label">标签偏好</h3><p class="picker-note">点击依次切换：未表态 → 喜欢 → 软回避 → 硬屏蔽。总评分不会自动应用到标签。</p><div class="tag-feedback-list chip-row"></div></div>
            <label class="field"><span class="field-label">评语</span><textarea class="input" rows="4" maxlength="5000" placeholder="哪些地方打动了你，或影响了阅读体验？"></textarea></label>
            <div class="page-actions"><button class="btn btn-primary" type="button" data-save-rating>保存评价</button><button class="btn btn-ghost" type="button" data-clear-rating>清除评价</button></div><p class="status-line" data-rating-status role="status">正在读取评价…</p>
            <section class="panel" data-rating-summary><h3>LLM 内容分析</h3><p class="picker-note">保存评分或更新评语后，会将评语及作品资料发送到已配置的语言模型，每次更新最多调用一次，分析结果用于推荐排序。</p><p data-summary-status role="status"></p><div data-summary-text style="white-space:pre-wrap;overflow-wrap:anywhere"></div></section>`;
        this.root.addEventListener("click", (event) => {
            if (this.saving || this.loadFailed) return;
            const score = event.target.closest("[data-score]");
            const tag = event.target.closest("[data-tag]");
            if (score) { this.score = Number(score.dataset.score); this.renderScore(); this.status("尚未保存"); }
            if (tag) {
                const key = tag.dataset.tag;
                const next = TAG_STATES[(TAG_STATES.indexOf(Number(this.tagFeedback[key] || 0)) + 1) % TAG_STATES.length];
                if (next) this.tagFeedback[key] = next;
                else delete this.tagFeedback[key];
                this.renderTags(key); this.status("尚未保存");
            }
        });
        this.root.querySelector("textarea").oninput = () => this.status("尚未保存");
        this.root.querySelector("[data-save-rating]").onclick = () => this.save();
        this.root.querySelector("[data-clear-rating]").onclick = async () => {
            if (await confirmAction({ title: "清除这本作品的评价？", message: "总评分、评语和标签偏好将被清空。", label: "清除评价" })) this.save(true);
        };
        await this.load();
    }

    async load() {
        this.setBusy(true);
        try {
            const result = await localRuntime.getLocalComic(this.album.id);
            this.loadFailed = false;
            this.apply(result?.comic);
            this.watchAnalysis(result.content_analysis);
            this.status("评价保存在本地资料库");
        } catch (error) {
            this.loadFailed = true;
            this.status(`评价读取失败：${error.message}`);
            const retry = document.createElement("button");
            retry.dataset.retryRating = "true";
            retry.className = "btn btn-outline btn-sm"; retry.type = "button"; retry.textContent = "重新读取";
            retry.onclick = () => { retry.remove(); this.load(); };
            this.root.append(retry);
        } finally { this.setBusy(false); }
    }

    apply(comic) {
        this.score = comic?.rating ?? null;
        this.tagFeedback = { ...comic?.tag_feedback };
        this.root.querySelector("textarea").value = comic?.review || "";
        this.renderScore(); this.renderTags();
    }

    renderScore() {
        this.root.querySelectorAll("[data-score]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.score) === this.score)));
        this.root.querySelector(".rating-value").innerHTML = `${this.score || "—"} <small>/ 10</small>`;
        this.root.querySelector(".rating-caption").textContent = this.score ? SCORE_LABELS[Math.ceil(this.score / 2) - 1] : "按整体阅读体验评分";
    }

    renderTags(focusTag) {
        const tags = textList(this.album.tags);
        this.root.querySelector(".rating-tags").hidden = !tags.length;
        this.root.querySelector(".tag-feedback-list").innerHTML = tags.map((tag) => {
            const state = Number(this.tagFeedback[tag] || 0);
            return `<button class="chip" type="button" data-tag="${escapeHtml(tag)}" data-sentiment="${state}" aria-pressed="${state !== 0}" aria-label="${escapeHtml(tag)}：${TAG_LABELS[state]}">${escapeHtml(tag)} <small>${TAG_LABELS[state]}</small></button>`;
        }).join("");
        if (focusTag) [...this.root.querySelectorAll("[data-tag]")].find((button) => button.dataset.tag === focusTag)?.focus({ preventScroll: true });
    }

    status(message) { this.root.querySelector("[data-rating-status]").textContent = message; }
    watchAnalysis(state) {
        clearTimeout(this.summaryTimer);
        const revision = this.summaryRevision = (this.summaryRevision || 0) + 1;
        const render = (value) => {
            const labels = { unrated: "保存总评分后生成内容分析", unconfigured: "请先在设置中配置语言模型，再点击补全内容分析", missing: "尚未生成，可在设置中统一补全", stale: "评分或评语已更新，旧分析待重新生成", queued: "已保存评价，正在等待 LLM 分析", running: "LLM 正在分析，离开页面也会继续", ready: "内容分析已更新", error: "内容分析失败，可在设置中重试；评分和评语不受影响" };
            this.root.querySelector("[data-summary-status]").textContent = labels[value?.status] || "尚未生成内容分析";
            const text = value?.text || "";
            this.root.querySelector("[data-summary-text]").textContent = text ? `${value.current ? "" : "上次分析（尚未对应最新评价）：\n"}${text}` : "";
        };
        const poll = async () => {
            if (revision !== this.summaryRevision || !this.root.isConnected) return;
            try {
                const value = await localRuntime.getContentAnalysis(this.album.id);
                if (revision !== this.summaryRevision || !this.root.isConnected) return;
                render(value);
                if (["queued", "running"].includes(value.status)) this.summaryTimer = setTimeout(poll, 1500);
            } catch {
                if (revision === this.summaryRevision) this.root.querySelector("[data-summary-status]").textContent = "分析状态读取失败，可重新打开作品或到设置查看；评分已保留。";
            }
        };
        render(state);
        if (["queued", "running"].includes(state?.status)) this.summaryTimer = setTimeout(poll, 1500);
    }
    setBusy(busy) {
        this.root.setAttribute("aria-busy", String(busy));
        this.root.querySelectorAll("button, textarea").forEach((el) => { el.disabled = busy || (this.loadFailed && !el.dataset.retryRating); });
    }

    async save(clear = false) {
        if (this.saving || this.loadFailed) return;
        this.saving = true; this.setBusy(true);
        clearTimeout(this.summaryTimer);
        this.summaryRevision = (this.summaryRevision || 0) + 1;
        try {
            const result = await localRuntime.saveLocalComic({ ...comicPayload(this.album, jmApi.getCoverImageURL(this.album.id)), rating: clear ? null : this.score, review: clear ? "" : this.root.querySelector("textarea").value.trim(), tag_feedback: clear ? {} : { ...this.tagFeedback } });
            this.apply(result.comic);
            this.watchAnalysis(result.content_analysis);
            this.status("已保存到本地资料库");
            window.dispatchEvent(new CustomEvent("jm-library-change"));
            showToast(clear ? "评价已清除" : "评价已保存", "success");
        } catch (error) { this.status(`保存失败：${error.message}`); }
        finally { this.saving = false; this.setBusy(false); }
    }
}
