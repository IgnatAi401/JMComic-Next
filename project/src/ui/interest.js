import { jmApi } from "../api/JmcomicApi.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { comicPayload } from "./dom.js";
import { showToast } from "./toast.js";

export const INTEREST_DIMENSIONS = { overall: "整体观感", cover: "封面", title: "标题", tag_mix: "标签组合", author: "作者" };

export class InterestFeedback {
    constructor(root, album) { this.root = root; this.album = album; this.states = {}; }
    async mount() {
        this.root.innerHTML = `<h2 class="section-title">感兴趣吗？</h2><p class="picker-note">帮助推荐了解你的第一印象。每项独立保存，再点一次取消。</p>${Object.entries(INTEREST_DIMENSIONS).map(([key, label]) => `<div class="interest-row" data-feedback-reason="${key}"><strong>${label}</strong><div class="segmented"><button type="button" data-interest="interested" aria-label="${label}，感兴趣" aria-pressed="false">感兴趣</button><button type="button" data-interest="not_interested" aria-label="${label}，不感兴趣" aria-pressed="false">不感兴趣</button></div></div>`).join("")}<p class="status-line" role="status"></p><button class="btn btn-outline btn-sm" type="button" data-retry-interest hidden>重新读取反馈</button>`;
        this.root.querySelector("[data-retry-interest]").onclick = () => this.load();
        this.root.addEventListener("click", (event) => {
            const button = event.target.closest("[data-interest]");
            if (button) this.save(button.closest("[data-feedback-reason]").dataset.feedbackReason, button.dataset.interest);
        });
        window.addEventListener("focus", () => this.load());
        await this.load();
    }
    async load() {
        if (this.busy) return;
        this.setBusy(true);
        try {
            this.states = (await localRuntime.getLocalComic(this.album.id))?.comic?.interest_feedback || {};
            this.loadFailed = false;
            this.root.querySelector(".status-line").textContent = "";
            this.render();
        } catch (error) {
            this.loadFailed = true;
            this.root.querySelector(".status-line").textContent = `未能读取反馈：${error.message}`;
        } finally {
            this.root.querySelector("[data-retry-interest]").hidden = !this.loadFailed;
            this.setBusy(false);
        }
    }
    render() {
        this.root.querySelectorAll("[data-feedback-reason]").forEach((row) => row.querySelectorAll("[data-interest]").forEach((button) => button.setAttribute("aria-pressed", String(this.states[row.dataset.feedbackReason]?.action === button.dataset.interest))));
    }
    setBusy(busy) {
        this.busy = busy;
        this.root.querySelectorAll("[data-interest]").forEach((button) => { button.disabled = busy || this.loadFailed; });
        this.root.querySelector("[data-retry-interest]").disabled = busy;
    }
    async save(reason, action) {
        if (this.busy || this.loadFailed || !(reason in INTEREST_DIMENSIONS) || !["interested", "not_interested"].includes(action)) return;
        const next = this.states[reason]?.action === action ? "clear" : action;
        this.setBusy(true);
        try {
            const result = await localRuntime.saveRecommendationFeedback({ comic_id: String(this.album.id), reason, action: next, comic: comicPayload(this.album, jmApi.getCoverImageURL(this.album.id)) });
            this.states = result.interest_feedback || {};
            this.render();
            const message = next === "clear" ? "已取消选择" : next === "interested" ? "已记录感兴趣" : "已记录不感兴趣";
            this.root.querySelector(".status-line").textContent = `${INTEREST_DIMENSIONS[reason]}：${message}`;
            showToast(message, "success");
        } catch (error) { showToast(error.message, "warning"); }
        finally { this.setBusy(false); }
    }
}
