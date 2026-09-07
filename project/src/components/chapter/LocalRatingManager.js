import { jmApi } from "../../api/JmcomicApi.js";
import { localRuntime } from "../../local/LocalRuntime.js";
import { showToast } from "../general/Toast.js";

const albumPayload = (album) => ({
    id: String(album.id),
    title: album.name || "未命名作品",
    authors: Array.isArray(album.author) ? album.author : (album.author ? [album.author] : []),
    tags: Array.isArray(album.tags) ? album.tags : [],
    cover_url: jmApi.getCoverImageURL(album.id),
});

const TAG_STATES = [0, 1, -1, -2];
const TAG_STATE_LABELS = {
    0: "未表态",
    1: "喜欢",
    "-1": "软回避",
    "-2": "硬屏蔽",
};

const SCORE_COPY = [
    { max: 2, title: "不值得读", description: "体验很差，不会推荐" },
    { max: 4, title: "雷点明显", description: "有影响体验的严重问题" },
    { max: 6, title: "中规中矩", description: "可以读，但没有太多惊喜" },
    { max: 8, title: "值得一看", description: "整体及格，而且有亮点" },
    { max: 10, title: "非常优秀", description: "各方面都很出色" },
];

export class LocalRatingManager {
    async init(album) {
        this.album = album;
        this.root = document.querySelector(".local-rating-panel");
        if (!this.root) return;
        this.score = null;
        this.tags = albumPayload(album).tags.map(String).filter(Boolean);
        this.tagFeedback = {};
        this.bindEvents();
        try {
            const result = await localRuntime.getLocalComic(album.id);
            this.render(result?.comic || null);
        } catch (error) {
            this.setState(error.message || "本地评价读取失败", true);
        }
    }

    bindEvents() {
        this.root.querySelector(".rating-buttons").addEventListener("click", (event) => {
            const button = event.target.closest("[data-score]");
            if (!button) return;
            this.score = Number(button.dataset.score);
            this.renderScore();
            this.setState("尚未保存");
        });
        this.root.querySelector("textarea").addEventListener("input", () => this.setState("尚未保存"));
        this.root.querySelector(".tag-feedback-list").addEventListener("click", (event) => {
            const button = event.target.closest("[data-tag]");
            if (!button) return;
            const tag = button.dataset.tag;
            const current = Number(this.tagFeedback[tag] || 0);
            const next = TAG_STATES[(TAG_STATES.indexOf(current) + 1) % TAG_STATES.length];
            if (next) this.tagFeedback[tag] = next;
            else delete this.tagFeedback[tag];
            this.renderTagFeedback(tag);
            this.setState("尚未保存");
        });
        this.root.querySelector(".save-local-rating").addEventListener("click", () => this.save());
        this.root.querySelector(".clear-local-rating").addEventListener("click", () => this.clear());
    }

    render(comic) {
        this.score = comic?.rating ?? null;
        this.tagFeedback = comic?.tag_feedback && typeof comic.tag_feedback === "object"
            ? { ...comic.tag_feedback }
            : {};
        this.root.querySelector("textarea").value = comic?.review || "";
        this.renderScore();
        this.renderTagFeedback();
        const hasFeedback = Object.keys(this.tagFeedback).length > 0;
        this.setState(comic?.rating || comic?.review || hasFeedback ? "已从本地资料库载入" : "还没有本地评价");
    }

    renderScore() {
        this.root.querySelectorAll("[data-score]").forEach((button) => {
            const buttonScore = Number(button.dataset.score);
            const active = buttonScore === this.score;
            button.classList.toggle("active", active);
            button.classList.toggle("is-before", Boolean(this.score && buttonScore < this.score));
            button.setAttribute("aria-pressed", String(active));
        });
        const ratingValue = this.root.querySelector(".rating-value");
        const ratingNumber = ratingValue.querySelector(".rating-value-number");
        const descriptor = this.score ? SCORE_COPY.find((entry) => this.score <= entry.max) : null;
        ratingNumber.textContent = this.score || "—";
        ratingValue.classList.toggle("has-score", Boolean(this.score));
        ratingValue.setAttribute("aria-label", this.score ? `${this.score} 分，${descriptor.title}` : "未评分");
        this.root.querySelector(".rating-caption strong").textContent = descriptor?.title || "选择 1–10 分";
        this.root.querySelector(".rating-caption span").textContent = descriptor?.description || "按你的整体阅读体验评分";
    }

    renderTagFeedback(focusTag = null) {
        const section = this.root.querySelector(".tag-feedback");
        const list = this.root.querySelector(".tag-feedback-list");
        section.hidden = !this.tags.length;
        list.replaceChildren(...this.tags.map((tag) => {
            const state = Number(this.tagFeedback[tag] || 0);
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.tag = tag;
            button.dataset.sentiment = String(state);
            button.title = `${tag}：${TAG_STATE_LABELS[state]}`;
            button.setAttribute("aria-label", button.title);
            button.setAttribute("aria-pressed", String(state !== 0));
            const name = document.createElement("span");
            name.textContent = tag;
            const label = document.createElement("small");
            label.textContent = TAG_STATE_LABELS[state];
            button.append(name, label);
            return button;
        }));
        if (focusTag !== null) {
            Array.from(list.querySelectorAll("[data-tag]")).find((button) => button.dataset.tag === focusTag)?.focus({ preventScroll: true });
        }
    }

    setState(message, warning = false) {
        const state = this.root.querySelector(".local-rating-state");
        state.textContent = message;
        state.classList.toggle("warning", warning);
        state.setAttribute("role", warning ? "alert" : "status");
        state.setAttribute("aria-live", warning ? "assertive" : "polite");
    }

    async save() {
        const button = this.root.querySelector(".save-local-rating");
        button.disabled = true;
        try {
            const result = await localRuntime.saveLocalComic({
                ...albumPayload(this.album),
                rating: this.score,
                review: this.root.querySelector("textarea").value.trim(),
                tag_feedback: this.tagFeedback,
            });
            this.render(result.comic);
            showToast("评分和评语已保存到本地", "success");
        } catch (error) {
            this.setState(error.message || "保存失败", true);
        } finally {
            button.disabled = false;
        }
    }

    async clear() {
        this.score = null;
        this.tagFeedback = {};
        this.root.querySelector("textarea").value = "";
        await this.save();
    }
}
