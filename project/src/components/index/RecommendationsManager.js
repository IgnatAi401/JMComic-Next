import { jmApi } from "../../api/JmcomicApi.js";
import { lazyLoader } from "../../dom/LazyLoader.js";

const HIDDEN_SECTIONS = new Set(["creator", "novels"]);
const CURATED_SECTION_PATTERN = /推荐|精选|本本/i;

const escapeHTML = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export class RecommendationsManager {
    recommendationsDom;

    constructor() {
        this.recommendationsDom = document.querySelector(".recommendations");
    }

    async init() {
        if (!this.recommendationsDom) return;
        const promotionData = await jmApi.getPromotionContent();
        const visibleSections = (Array.isArray(promotionData) ? promotionData : []).filter((section) => {
            const slug = String(section?.slug || "").trim().toLowerCase();
            const title = String(section?.title || "").trim();
            return !HIDDEN_SECTIONS.has(slug) && title !== "禁漫书库" && title !== "禁漫小说";
        });

        const sections = this.#prioritizeCuratedSection(visibleSections)
            .filter((section) => Array.isArray(section.content) && section.content.length);

        this.recommendationsDom.innerHTML = sections.length
            ? this.#getRecommendationsHTML(sections)
            : '<div class="home-empty">今天的书架暂时还是空的，稍后再来看看。</div>';
        this.recommendationsDom.setAttribute("aria-busy", "false");

        this.recommendationsDom.querySelectorAll(".cover").forEach((cover) => lazyLoader.addCover(cover));
    }

    #prioritizeCuratedSection(sections) {
        const curatedIndex = sections.findIndex((section) => CURATED_SECTION_PATTERN.test(
            `${section?.title || ""} ${section?.slug || ""}`,
        ));
        if (curatedIndex <= 0) return sections;
        return [
            sections[curatedIndex],
            ...sections.slice(0, curatedIndex),
            ...sections.slice(curatedIndex + 1),
        ];
    }

    #getRecommendationsHTML(data) {
        return data.map((sectionData, index) => {
            const title = this.#cleanSectionLabel(sectionData?.title);
            const content = Array.isArray(sectionData?.content) ? sectionData.content : [];
            const sectionNumber = String(index + 1).padStart(2, "0");
            const slug = this.#displaySlug(sectionData?.slug);
            const heading = slug || title || "精选";
            const kicker = slug && slug !== title ? title : "精选书架";
            return `
                <section class="section" aria-labelledby="shelf-${sectionNumber}">
                    <div class="s-title">
                        <div class="s-title-copy">
                            <span>${sectionNumber} / ${escapeHTML(kicker || "COLLECTION")}</span>
                            <h3 class="s-sr-title" id="shelf-${sectionNumber}">${escapeHTML(heading)}</h3>
                        </div>
                        <small class="section-count">${content.length} PICKS</small>
                    </div>
                    <div class="sec-comics" aria-label="${escapeHTML(title || "精选作品")}">
                        <div class="sc-inner">${this.#getSecComicsHTML(content)}</div>
                    </div>
                </section>
            `;
        }).join("");
    }

    #displaySlug(slug) {
        const value = this.#cleanSectionLabel(slug);
        if (/^hanman$/i.test(value)) return "韩漫";
        if (/^another$/i.test(value)) return "其他更新";
        return value;
    }

    #cleanSectionLabel(value) {
        return String(value || "")
            .replace(/[→>-]*右滑看更多[→>-]*/gi, "")
            .replace(/\s+/g, " ")
            .trim();
    }

    #getSecComicsHTML(data) {
        return data.map((comic, index) => {
            const id = String(comic?.id || "").trim();
            const cardNumber = String(index + 1).padStart(2, "0");
            const author = (Array.isArray(comic?.author) ? comic.author : [comic?.author])
                .map((item) => typeof item === "string" || typeof item === "number" ? String(item).trim() : "")
                .filter(Boolean)
                .join(" · ");
            return `
                <article class="comic-item">
                    <a class="cover" data-index="${cardNumber}" data-src="${escapeHTML(jmApi.getCoverImageURL(id))}" href="./chapter.html?id=${encodeURIComponent(id)}&amp;v=20260827-7">
                        <img alt="${escapeHTML(comic?.name || "漫画")}封面" />
                    </a>
                    <h4 class="c-title">${escapeHTML(comic?.name || "未命名作品")}</h4>
                    <p class="c-sr-title">${escapeHTML(author || "作者未标注")}</p>
                </article>
            `;
        }).join("");
    }
}
