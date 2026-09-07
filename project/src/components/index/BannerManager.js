import { jmApi } from "../../api/JmcomicApi.js";
import { libraryStore } from "../../data/LibraryStore.js";

const MAX_RANDOM_ATTEMPTS = 12;
const RANDOM_BATCH_SIZE = 4;
const FALLBACK_IDS = ["1436985", "1433587", "1428159"];

const asText = (value, fallback = "") => {
    if (value == null || typeof value === "object") return fallback;
    return String(value).trim() || fallback;
};

const asTextList = (value) => (Array.isArray(value) ? value : [value])
    .map((item) => asText(item))
    .filter(Boolean);

export class BannerManager {
    detailsDom;
    showcaseDom;
    triggerDom;
    currentId = "";
    loading = false;
    history = [];
    currentIndex = -1;
    currentAlbum = null;
    transitionTimer = null;
    transitionId = 0;
    coverRequestId = 0;

    constructor() {
        this.detailsDom = document.querySelector(".random-comic-details");
        this.showcaseDom = document.querySelector(".random-showcase");
        this.triggerDom = document.querySelector("[data-random-trigger]");
        this.stackDom = document.querySelector("[data-random-stack]");
        this.previousDom = document.querySelector("[data-random-prev]");
        this.nextDom = document.querySelector("[data-random-next]");
    }

    async init() {
        if (!this.detailsDom || !this.showcaseDom || !this.triggerDom) return;
        this.history = libraryStore.getRandomHistory();
        this.triggerDom.addEventListener("click", () => this.loadRandomComic());
        this.previousDom?.addEventListener("click", () => this.#showHistoryAt(this.currentIndex + 1, "older"));
        this.nextDom?.addEventListener("click", () => this.#showHistoryAt(this.currentIndex - 1, "newer"));
        this.stackDom?.addEventListener("click", (event) => {
            const card = event.target.closest("[data-random-history-index]");
            if (card) this.#showHistoryAt(
                Number(card.dataset.randomHistoryIndex),
                card.dataset.randomDirection || "older",
            );
        });
        await this.loadRandomComic();
    }

    async loadRandomComic() {
        if (this.loading) return;
        this.#setLoading(true);
        try {
            const selection = await this.#findValidRandomAlbum();
            this.#renderAlbum(selection.album, selection.id, selection.attempts, selection.fallback, {
                record: true,
                direction: "newer",
            });
        } catch (error) {
            this.#renderError(error);
        } finally {
            this.#setLoading(false);
        }
    }

    async #findValidRandomAlbum() {
        const attempted = new Set();
        let lastError;

        for (let offset = 0; offset < MAX_RANDOM_ATTEMPTS; offset += RANDOM_BATCH_SIZE) {
            const candidates = [];
            while (candidates.length < RANDOM_BATCH_SIZE) {
                const id = this.#generateCandidateId();
                if (id === this.currentId || attempted.has(id)) continue;
                attempted.add(id);
                candidates.push({ id, attempt: offset + candidates.length + 1 });
            }
            this.#showCandidate(candidates[0].id, offset / RANDOM_BATCH_SIZE + 1);
            try {
                return await Promise.any(candidates.map(async ({ id, attempt }) => {
                    const album = await jmApi.getComicAlbum(id, { maxServers: 1, timeoutMs: 5000 });
                    if (!this.#isValidAlbum(album, id)) throw new Error(`漫画 ${id} 无效`);
                    return { album, id, attempts: attempt, fallback: false };
                }));
            } catch (error) {
                lastError = error;
            }
        }

        for (const id of FALLBACK_IDS) {
            if (id === this.currentId) continue;
            try {
                const album = await jmApi.getComicAlbum(id, { maxServers: 2, timeoutMs: 8000 });
                if (this.#isValidAlbum(album, id)) {
                    return { album, id, attempts: MAX_RANDOM_ATTEMPTS, fallback: true };
                }
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error("暂时没有找到有效的随机漫画");
    }

    #generateCandidateId() {
        const digits = Math.random() < .5 ? 6 : 7;
        const min = digits === 6 ? 100000 : 1000000;
        const max = digits === 6 ? 999999 : 1499999;
        return String(min + Math.floor(Math.random() * (max - min + 1)));
    }

    #isValidAlbum(album, id) {
        return Boolean(
            album
            && !Array.isArray(album)
            && typeof album === "object"
            && String(album.id) === id
            && asText(album.name),
        );
    }

    #showCandidate(id, batch) {
        this.detailsDom.querySelector("[data-random-id]").textContent = id;
        this.detailsDom.querySelector("[data-random-status]").textContent = `第 ${batch} 批并行验证中`;
    }

    #renderAlbum(album, id, attempts, fallback, { record = false, direction = "newer", status = "" } = {}) {
        const title = asText(album.name, `漫画 #${id}`);
        const authors = asTextList(album.author || album.authors);
        const tags = asTextList(album.tags).slice(0, 7);
        const chapters = Number(album.chapters || (Array.isArray(album.series) && album.series.length) || 1);
        const description = asText(album.description, "这本作品暂时没有简介，点进详情页继续探索。");
        const timestamp = Number(album.addtime);
        const date = timestamp ? new Date(timestamp * 1000).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit" }) : "未知";
        const coverUrl = asText(album.cover_url || album.coverUrl, jmApi.getCoverImageURL(id));
        const targetUrl = `./chapter.html?id=${encodeURIComponent(id)}&v=20260827-7`;

        if (this.currentId && this.currentId !== id) this.#animateTransition(direction);
        this.currentId = id;
        if (record) {
            libraryStore.recordRandomHistory({
                ...album,
                id,
                name: title,
                author: authors,
                tags,
                chapters,
                cover_url: coverUrl,
            });
            this.history = libraryStore.getRandomHistory();
            this.currentIndex = this.history.findIndex((item) => String(item.id) === id);
        }
        this.currentAlbum = record ? this.history[this.currentIndex] : album;

        this.detailsDom.querySelector("[data-random-id]").textContent = id;
        this.detailsDom.querySelector("[data-random-status]").textContent = status || (fallback
            ? "随机验证超时 · 已回退到有效精选"
            : `第 ${attempts} 次验证通过`);
        this.detailsDom.querySelector("[data-random-title]").textContent = title;
        this.detailsDom.querySelector("[data-random-author]").textContent = authors.length ? authors.join(" · ") : "未知作者";
        this.detailsDom.querySelector("[data-random-description]").textContent = description;
        this.detailsDom.querySelector("[data-random-chapters]").textContent = String(chapters);
        this.detailsDom.querySelector("[data-random-pages]").textContent = String(album.total_photos ?? "—");
        this.detailsDom.querySelector("[data-random-comments]").textContent = String(album.comment_total ?? "0");
        this.detailsDom.querySelector("[data-random-date]").textContent = date;
        this.#renderTags(tags);

        const open = this.detailsDom.querySelector("[data-random-open]");
        open.href = targetUrl;
        open.removeAttribute("aria-disabled");

        const cover = this.showcaseDom.querySelector("[data-random-cover]");
        const backdrop = this.showcaseDom.querySelector(".random-backdrop");
        cover.href = targetUrl;
        cover.removeAttribute("aria-disabled");
        cover.setAttribute("aria-label", `查看《${title}》详情`);
        this.#mountCoverImage(cover, {
            src: coverUrl,
            fallbackSrc: jmApi.getCoverImageURL(id),
            alt: `${title}封面`,
            backdrop,
        });
        this.#renderHistoryDeck();
    }

    #mountCoverImage(container, { src, fallbackSrc = "", alt = "", backdrop = null }) {
        const requestId = String(++this.coverRequestId);
        const sources = [...new Set([src, fallbackSrc].map((value) => asText(value)).filter(Boolean))];
        container.dataset.coverRequest = requestId;
        container.classList.remove("is-cover-ready", "is-cover-error");
        container.classList.add("is-cover-loading");
        container.replaceChildren();

        if (backdrop) {
            backdrop.dataset.coverRequest = requestId;
            backdrop.classList.remove("is-ready");
            backdrop.removeAttribute("src");
        }

        const trySource = (index) => {
            if (container.dataset.coverRequest !== requestId) return;
            const source = sources[index];
            if (!source) {
                container.replaceChildren();
                container.classList.remove("is-cover-loading", "is-cover-ready");
                container.classList.add("is-cover-error");
                return;
            }

            const image = document.createElement("img");
            image.alt = alt;
            image.decoding = "async";
            image.loading = "eager";
            image.width = 3;
            image.height = 4;
            image.addEventListener("load", () => {
                if (container.dataset.coverRequest !== requestId) return;
                container.classList.remove("is-cover-loading", "is-cover-error");
                container.classList.add("is-cover-ready");
                if (!backdrop || backdrop.dataset.coverRequest !== requestId) return;
                backdrop.onload = () => {
                    if (backdrop.dataset.coverRequest === requestId) backdrop.classList.add("is-ready");
                };
                backdrop.onerror = () => {
                    if (backdrop.dataset.coverRequest !== requestId) return;
                    backdrop.classList.remove("is-ready");
                    backdrop.removeAttribute("src");
                };
                backdrop.src = source;
            }, { once: true });
            image.addEventListener("error", () => {
                if (container.dataset.coverRequest === requestId) trySource(index + 1);
            }, { once: true });
            container.replaceChildren(image);
            image.src = source;
        };

        trySource(0);
    }

    #showHistoryAt(index, direction) {
        if (this.loading || index < 0 || index >= this.history.length || index === this.currentIndex) return;
        const item = this.history[index];
        this.currentIndex = index;
        this.#renderAlbum(item, String(item.id), 0, false, {
            direction,
            status: `随机历史 · ${new Date(item.savedAt).toLocaleString("zh-CN")}`,
        });
    }

    #renderHistoryDeck() {
        if (!this.stackDom) return;
        const cards = [];
        const sides = [
            { name: "older", direction: "older", indexStep: 1, xDirection: -1, label: "较早" },
            { name: "newer", direction: "newer", indexStep: -1, xDirection: 1, label: "较新" },
        ];
        sides.forEach((side) => {
            for (let offset = 0; offset < 3; offset += 1) {
                const index = this.currentIndex + side.indexStep * (offset + 1);
                if (index < 0 || index >= this.history.length) continue;
                const item = this.history[index];
                const x = side.xDirection * (102 + offset * 58);
                const button = document.createElement("button");
                button.type = "button";
                button.className = `random-stack-card is-${side.name}`;
                button.dataset.randomHistoryIndex = String(index);
                button.dataset.randomDirection = side.direction;
                button.dataset.stackSide = side.name;
                button.setAttribute("aria-label", `查看${side.label}的随机漫画：${asText(item.name, `漫画 #${item.id}`)}`);
                button.style.setProperty("--stack-x", `${x}px`);
                button.style.setProperty("--stack-y", `${12 + offset * 8}px`);
                button.style.setProperty("--stack-scale", String(.96 - offset * .04));
                button.style.setProperty("--stack-hover-x", `${x + side.xDirection * 7}px`);
                const rotation = side.xDirection * (2.8 + offset * 1.35);
                button.style.setProperty("--stack-rotate", `${rotation}deg`);
                button.style.setProperty("--stack-hover-rotate", `${rotation + side.xDirection * .8}deg`);
                button.style.zIndex = String(3 - offset);
                this.#mountCoverImage(button, {
                    src: asText(item.cover_url, jmApi.getCoverImageURL(item.id)),
                    fallbackSrc: jmApi.getCoverImageURL(item.id),
                });
                cards.push(button);
            }
        });
        this.stackDom.replaceChildren(...cards);
        const total = this.history.length;
        if (this.previousDom) this.previousDom.disabled = this.loading || this.currentIndex + 1 >= total;
        if (this.nextDom) this.nextDom.disabled = this.loading || this.currentIndex <= 0;
    }

    #animateTransition(direction) {
        const transitionId = ++this.transitionId;
        window.clearTimeout(this.transitionTimer);
        this.showcaseDom.querySelectorAll(".random-cover-ghost").forEach((ghost) => ghost.remove());
        const cover = this.showcaseDom.querySelector("[data-random-cover]");
        const ghost = cover.cloneNode(true);
        ghost.removeAttribute("data-random-cover");
        ghost.removeAttribute("href");
        ghost.setAttribute("aria-hidden", "true");
        ghost.tabIndex = -1;
        ghost.classList.remove("is-entering");
        ghost.classList.add("random-cover-ghost", `leaving-${direction}`);
        this.showcaseDom.append(ghost);
        this.showcaseDom.dataset.transitionDirection = direction;
        cover.classList.remove("is-entering");
        void cover.offsetWidth;
        cover.classList.add("is-entering");
        const finishTransition = () => {
            ghost.remove();
            if (transitionId !== this.transitionId) return;
            cover.classList.remove("is-entering");
            delete this.showcaseDom.dataset.transitionDirection;
            window.clearTimeout(this.transitionTimer);
            this.transitionTimer = null;
        };
        ghost.addEventListener("animationend", finishTransition, { once: true });
        this.transitionTimer = window.setTimeout(finishTransition, 560);
    }

    #renderTags(tags) {
        const container = this.detailsDom.querySelector("[data-random-tags]");
        const entries = tags.map((tag) => {
            const link = document.createElement("a");
            link.href = `./search.html?sq=${encodeURIComponent(tag)}&v=20260827-7`;
            link.textContent = tag;
            return link;
        });
        container.replaceChildren(...entries);
        container.classList.toggle("is-empty", entries.length === 0);
        if (entries.length) container.removeAttribute("aria-hidden");
        else container.setAttribute("aria-hidden", "true");
    }

    #renderError(error) {
        const status = this.detailsDom.querySelector("[data-random-status]");
        status.textContent = error?.message || "随机验证失败，请再试一次";
        if (!this.currentId) {
            this.detailsDom.querySelector("[data-random-title]").textContent = "这次没有找到有效作品";
            this.detailsDom.querySelector("[data-random-author]").textContent = "点击“随机一本”重新验证";
        }
    }

    #setLoading(loading) {
        this.loading = loading;
        this.detailsDom.setAttribute("aria-busy", String(loading));
        this.showcaseDom.classList.toggle("is-loading", loading);
        this.detailsDom.classList.toggle("is-loading", loading);
        this.triggerDom.disabled = loading;
        this.triggerDom.querySelector("b").textContent = loading ? "验证中…" : "随机一本";
        if (this.previousDom) this.previousDom.disabled = loading || this.currentIndex + 1 >= this.history.length;
        if (this.nextDom) this.nextDom.disabled = loading || this.currentIndex <= 0;
    }
}
