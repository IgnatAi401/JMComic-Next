import { jmApi } from "../../api/JmcomicApi.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

const plainComment = (value) => {
    const template = document.createElement("template");
    template.innerHTML = String(value ?? "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/div\s*>/gi, "\n");
    return (template.content.textContent || "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
};

export class CleanCommentManager {
    constructor(commentDom = document.querySelector(".comment")) {
        this.commentDom = commentDom;
        this.commentTitleDom = this.commentDom.querySelector("h1");
        this.commentInnerDom = this.commentDom.querySelector(".comment-inner");
        this.moreButton = this.commentDom.querySelector(".comment-more");
        this.page = 1;
        this.comments = [];
    }

    init(subject, { commentId = subject?.id, title = "读者评论", total = subject?.comment_total } = {}) {
        this.commentId = String(commentId ?? "").trim();
        this.title = title;
        this.knownTotal = total != null && total !== "" && Number.isFinite(Number(total))
            ? Math.max(0, Number(total))
            : null;
        this.renderTitle(this.knownTotal);
        if (!this.moreButtonBound) {
            this.moreButton.addEventListener("click", () => this.loadComments(this.page + 1, true));
            this.moreButtonBound = true;
        }
        return this.loadComments(1, false);
    }

    renderTitle(total) {
        this.commentTitleDom.textContent = total == null ? this.title : `${this.title} · ${total}`;
    }

    async loadComments(page, append) {
        if (this.loading) return;
        this.loading = true;
        this.moreButton.disabled = true;
        this.moreButton.textContent = "正在载入…";
        try {
            const data = await jmApi.getComicComments(this.commentId, page);
            const incoming = data.list.filter((comment) => {
                const id = String(comment?.CID || comment?.id || "");
                return !id || !this.comments.some((item) => String(item?.CID || item?.id || "") === id);
            });
            this.comments = append ? [...this.comments, ...incoming] : incoming;
            this.page = page;
            const total = Math.max(data.total, this.knownTotal || 0);
            this.renderTitle(total);
            this.commentInnerDom.innerHTML = this.comments.length
                ? this.comments.map((comment) => this.commentHtml(comment)).join("")
                : '<div class="comment-empty">暂时没有评论</div>';
            this.moreButton.hidden = !incoming.length || this.comments.length >= total || data.list.length < 10;
        } catch {
            if (!append) this.commentInnerDom.innerHTML = '<div class="comment-empty">评论暂时无法载入</div>';
            this.moreButton.hidden = !append;
            this.moreButton.textContent = append ? "加载失败，点击重试" : "显示更多评论";
            return false;
        } finally {
            this.loading = false;
            this.moreButton.disabled = false;
        }
        this.moreButton.textContent = "显示更多评论";
        return true;
    }

    commentHtml(data) {
        const content = plainComment(data.content);
        const photo = String(data.photo ?? "").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
        return `<div class="comment-item">
            <div class="user-head"><img src="${jmApi.getUserPhotoURL(photo)}" alt="用户头像"></div>
            <div class="user-info"><h2>${escapeHtml(data.username)}</h2><p class="comment-text">${escapeHtml(content)}</p></div>
        </div>`;
    }
}
