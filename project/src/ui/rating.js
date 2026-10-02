import { jmApi } from "../api/JmcomicApi.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { comicPayload } from "./dom.js";
import { showToast } from "./toast.js";
import { confirmAction } from "./confirm.js";

const SCORE_LABELS = ["不值得读", "雷点明显", "中规中矩", "值得一看", "非常优秀"];
const IDLE_CAPTION = "按整体阅读体验评分，点选即保存";

/** One 1–10 score per comic, saved to the local library as soon as it is picked. */
export class RatingEditor {
    constructor(root, album) { this.root = root; this.album = album; this.score = null; }

    async mount() {
        this.root.innerHTML = `<div class="section-head"><h2 class="section-title">我的评分</h2><span class="rating-value num">— <small>/ 10</small></span></div>
            <fieldset class="rating-fieldset"><legend class="visually-hidden">总评分，1 至 10 分</legend><div class="rating-buttons">${Array.from({ length: 10 }, (_, i) => `<button type="button" data-score="${i + 1}" aria-pressed="false" aria-label="${i + 1} 分">${i + 1}</button>`).join("")}</div></fieldset>
            <p class="rating-caption picker-note">${IDLE_CAPTION}</p>
            <details class="disclosure rating-rules"><summary>评分参考</summary><ul><li>1–2 分：垃圾作品，看了浪费时间</li><li>3–4 分：有严重雷点</li><li>5–6 分：中规中矩</li><li>7–8 分：整体及格且有亮点</li><li>9–10 分：全方面优秀</li></ul></details>
            <div class="page-actions"><button class="btn btn-ghost btn-sm" type="button" data-clear-rating hidden>清除评分</button></div>
            <p class="status-line" data-rating-status role="status">正在读取评分…</p>`;
        this.root.addEventListener("click", (event) => {
            const score = event.target.closest("[data-score]");
            if (score) this.save(Number(score.dataset.score));
        });
        this.root.querySelector("[data-clear-rating]").onclick = async () => {
            if (await confirmAction({ title: "清除这本作品的评分？", message: "评分记录会从本地资料库删除。", label: "清除评分" })) this.save(null);
        };
        await this.load();
    }

    async load() {
        this.setBusy(true);
        try {
            this.score = (await localRuntime.getRating(this.album.id))?.rating ?? null;
            this.loadFailed = false;
            this.render();
            this.status(this.score ? "评分保存在本地资料库" : "尚未评分");
        } catch (error) {
            this.loadFailed = true;
            this.status(`评分读取失败：${error.message}`);
            const retry = document.createElement("button");
            retry.dataset.retryRating = "true";
            retry.className = "btn btn-outline btn-sm"; retry.type = "button"; retry.textContent = "重新读取";
            retry.onclick = () => { retry.remove(); this.load(); };
            this.root.append(retry);
        } finally { this.setBusy(false); }
    }

    render() {
        this.root.querySelectorAll("[data-score]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.score) === this.score)));
        this.root.querySelector(".rating-value").innerHTML = `${this.score || "—"} <small>/ 10</small>`;
        this.root.querySelector(".rating-caption").textContent = this.score ? SCORE_LABELS[Math.ceil(this.score / 2) - 1] : IDLE_CAPTION;
        this.root.querySelector("[data-clear-rating]").hidden = !this.score;
    }

    status(message) { this.root.querySelector("[data-rating-status]").textContent = message; }

    setBusy(busy) {
        this.root.setAttribute("aria-busy", String(busy));
        this.root.querySelectorAll("button").forEach((el) => { el.disabled = busy || (this.loadFailed && !el.dataset.retryRating); });
    }

    async save(score) {
        if (this.saving || this.loadFailed || score === this.score) return;
        this.saving = true; this.setBusy(true);
        try {
            const saved = await localRuntime.saveRating({ ...comicPayload(this.album, jmApi.getCoverImageURL(this.album.id)), rating: score });
            this.score = saved?.rating ?? null;
            this.render();
            this.status(this.score ? "已保存到本地资料库" : "评分已清除");
            window.dispatchEvent(new CustomEvent("jm-library-change"));
            showToast(this.score ? `已评 ${this.score} 分` : "评分已清除", "success");
        } catch (error) { this.status(`保存失败：${error.message}`); }
        finally { this.saving = false; this.setBusy(false); }
    }
}
