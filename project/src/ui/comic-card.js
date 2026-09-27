import { authorsOf, asText, detailUrl, escapeHtml } from "./dom.js";
import { coverHtml } from "./covers.js";

/** The standard catalogue tile: cover, two-line title, one-line author. */
export const comicCardHtml = (comic, { index = "", meta = "" } = {}) => {
    const id = String(comic?.id ?? "").trim();
    const title = asText(comic?.name ?? comic?.title, "未命名作品");
    const href = detailUrl(id);
    const line = meta || authorsOf(comic).join(" · ") || "作者未标注";
    return `<article class="comic-card" data-comic-id="${escapeHtml(id)}">
        ${coverHtml(comic, { href, index })}
        <h3 class="comic-title"><a href="${href}">${escapeHtml(title)}</a></h3>
        <p class="comic-meta">${escapeHtml(line)}</p>
    </article>`;
};
