import { jmApi } from "../../api/JmcomicApi.js";
import { localRuntime } from "../../local/LocalRuntime.js";
import { showToast } from "../general/Toast.js";

const FEEDBACK_ACTIONS = new Set(["interested", "not_interested"]);
const FEEDBACK_REASONS = new Set(["overall", "cover", "title", "tag_mix", "author"]);

const asArray = (value) => Array.isArray(value)
    ? value.filter((item) => item != null)
    : (value == null || value === "" ? [] : [value]);

const comicPayload = (album) => ({
    id: String(album.id),
    title: album.name || "未命名作品",
    authors: asArray(album.author).map(String).filter(Boolean),
    tags: asArray(album.tags).map(String).filter(Boolean),
    cover_url: jmApi.getCoverImageURL(album.id),
});

export class DetailRecommendationFeedbackManager {
    async init(album) {
        this.album = album;
        this.root = document.querySelector(".detail-recommendation-feedback");
        if (!this.root) return;

        this.rows = [...this.root.querySelectorAll("[data-feedback-reason]")];
        this.buttons = [...this.root.querySelectorAll("[data-detail-feedback]")];
        this.states = {};
        this.saving = false;
        this.buttons.forEach((button) => {
            button.addEventListener("click", () => this.save(button));
        });
        window.addEventListener("focus", () => this.load());
        await this.load();
    }

    async load() {
        if (this.saving) return;
        this.setBusy(true);
        try {
            const result = await localRuntime.getLocalComic(this.album.id);
            this.render(result?.comic || null);
        } catch {
            this.render(null);
        } finally {
            this.setBusy(false);
        }
    }

    render(comic) {
        this.states = comic?.interest_feedback && typeof comic.interest_feedback === "object"
            ? { ...comic.interest_feedback }
            : {};
        this.rows.forEach((row) => {
            const reason = row.dataset.feedbackReason;
            const state = this.states[reason] || null;
            row.querySelectorAll("[data-detail-feedback]").forEach((button) => {
                const selected = button.dataset.detailFeedback === state?.action;
                button.classList.toggle("is-selected", selected);
                button.setAttribute("aria-pressed", String(selected));
            });
            const status = row.querySelector(".detail-feedback-state");
            status.textContent = state
                ? (state.action === "interested" ? "已记录感兴趣" : "已记录不感兴趣")
                : "未设置";
        });
    }

    async save(button) {
        const row = button.closest("[data-feedback-reason]");
        const action = button.dataset.detailFeedback;
        const reason = row?.dataset.feedbackReason;
        if (this.saving || !FEEDBACK_ACTIONS.has(action) || !FEEDBACK_REASONS.has(reason)) return;
        const nextAction = this.states[reason]?.action === action ? "clear" : action;
        this.saving = true;
        this.setBusy(true);
        try {
            const result = await localRuntime.saveRecommendationFeedback({
                comic_id: String(this.album.id),
                action: nextAction,
                reason,
                comic: comicPayload(this.album),
            });
            this.render({ interest_feedback: result.interest_feedback });
            const label = row.querySelector(".detail-feedback-label strong")?.textContent || "该维度";
            const message = nextAction === "clear"
                ? "已取消选择"
                : (nextAction === "interested" ? "已记录感兴趣" : "已记录不感兴趣");
            showToast(`${label}：${message}`, "success");
        } catch (error) {
            showToast(error.message || "反馈保存失败", "warning");
        } finally {
            this.saving = false;
            this.setBusy(false);
        }
    }

    setBusy(busy) {
        this.root.setAttribute("aria-busy", String(busy));
        this.buttons.forEach((button) => { button.disabled = busy; });
    }
}
