import { jmApi } from "../../api/JmcomicApi.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

export class RecommendationsComicManager {
    album;
    recommendedComicsDom;
    recommendedComicsCrDom;
    constructor() {
        this.recommendedComicsDom = document.querySelector(
            ".recommended-comics",
        );
        this.recommendedComicsCrDom =
            this.recommendedComicsDom.querySelector(".rc-cr");
    }
    init(album) {
        this.album = album;
        const related = Array.isArray(this.album.related_list) ? this.album.related_list : [];
        this.recommendedComicsCrDom.innerHTML = related
            .map((data) => this.#getRCItemHTML(data))
            .join("");
    }
    #getRCItemHTML(data) {
        const id = String(data?.id ?? "").trim();
        return `
        <a class="rc-item" data-cid="${escapeHtml(id)}" href="./chapter.html?id=${encodeURIComponent(id)}&v=20260827-7">
            <div class="item-cover">
                <img src="${jmApi.getCoverImageURL(id)}" alt="${escapeHtml(data?.name || "漫画")}封面" />
            </div>
            <div class="item-info">
                <h1 class="item-title">${escapeHtml(data?.name)}</h1>
                <h2 class="item-aname">${escapeHtml(data?.author)}</h2>
            </div>
        </a>
        `;
    }
}
