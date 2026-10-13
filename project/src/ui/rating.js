import { jmApi } from "../api/JmcomicApi.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { comicPayload } from "./dom.js";
import { showToast } from "./toast.js";
import { confirmAction } from "./confirm.js";

/** One 1–10 score per comic, saved to the local library as soon as it is picked; tapping the current score clears it. */
export class RatingEditor {
    constructor(root, album) { this.root = root; this.album = album; this.score = null; }

    async mount() {
        this.root.innerHTML = `<div class="section-head"><h2 class="section-title">我的评分</h2></div>
            <fieldset class="rating-fieldset"><legend class="visually-hidden">总评分，1 至 10 分，再次点选当前分数可清除</legend><div class="rating-buttons">${Array.from({ length: 10 }, (_, i) => `<button type="button" data-score="${i + 1}" aria-pressed="false" aria-label="${i + 1} 分">${i + 1}</button>`).join("")}</div></fieldset>
            <p class="status-line warning" data-rating-status role="status" hidden></p>`;
        this.root.addEventListener("click", async (event) => {
            const button = event.target.closest("[data-score]");
            if (!button) return;
            const score = Number(button.dataset.score);
            if (score !== this.score) return this.save(score);
            if (await confirmAction({ title: "清除这本作品的评分？", message: "评分记录会从本地资料库删除。", label: "清除评分" })) this.save(null);
        });
        await this.load();
    }

    async load() {
        this.setBusy(true);
        try {
            this.score = (await localRuntime.getRating(this.album.id))?.rating ?? null;
            this.loadFailed = false;
            this.status("");
            this.render();
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
    }

    /** Only failures are shown inline; successful saves are confirmed with a toast. */
    status(message) {
        const line = this.root.querySelector("[data-rating-status]");
        line.textContent = message;
        line.hidden = !message;
    }

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
            this.status("");
            this.render();
            window.dispatchEvent(new CustomEvent("jm-library-change"));
            showToast(this.score ? `已评 ${this.score} 分` : "评分已清除", "success");
        } catch (error) { this.status(`保存失败：${error.message}`); }
        finally { this.saving = false; this.setBusy(false); }
    }
}
