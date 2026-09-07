import { jmApi } from "../api/JmcomicApi.js";
import { CleanCommentManager } from "../components/chapter/CleanCommentManager.js";
import { DetailRecommendationFeedbackManager } from "../components/chapter/DetailRecommendationFeedbackManager.js";
import { HeadManager } from "../components/chapter/HeadManager.js";
import { RecommendationsComicManager } from "../components/chapter/RecommendedComicsManager.js";
import { NavManager } from "../components/general/NavManager.js";
import { setting } from "../components/general/Setting.js";
import { SwitchServerBtnManager } from "../components/general/SwitchServerBtnManager.js";
import { LocalRatingManager } from "../components/chapter/LocalRatingManager.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { renderPageError } from "../utils/PageError.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

class ChapterPage {
    async init() {
        const id = new URLSearchParams(location.search).get("id");
        if (!id || !/^\d+$/.test(id)) throw new Error("漫画 ID 无效");

        setting.init();
        new NavManager().init();
        new SwitchServerBtnManager().init();
        await jmApi.init();

        try {
            const album = await jmApi.getComicAlbum(id);
            if (!album || Array.isArray(album) || album.id == null) throw new Error("API 未返回有效的漫画资料");
            new HeadManager().init(album);
            new DetailRecommendationFeedbackManager().init(album);
            new CleanCommentManager().init(album);
            new RecommendationsComicManager().init(album);
            new LocalRatingManager().init(album);
            localRuntime.recordInteraction({
                event_type: "detail_view",
                comic_id: String(album.id),
                source: "chapter",
                comic: {
                    id: String(album.id),
                    title: album.name || "未命名作品",
                    authors: Array.isArray(album.author) ? album.author : (album.author ? [album.author] : []),
                    tags: Array.isArray(album.tags) ? album.tags : [],
                    cover_url: jmApi.getCoverImageURL(album.id),
                },
            });
            document.querySelector(".detail-loading").hidden = true;
            document.querySelector(".detail-hero").hidden = false;
            document.querySelector(".detail-layout").hidden = false;
        } catch (error) {
            const loading = document.querySelector(".detail-loading");
            loading.innerHTML = `<div class="detail-error"><strong>漫画信息加载失败</strong><p>${escapeHtml(error.message || "请稍后重试")}</p><a class="ghost-btn" href="./index.html">返回首页</a></div>`;
        }
    }

}

new ChapterPage().init().catch((error) => renderPageError(".detail-loading", error, {
    title: "漫画信息加载失败",
    className: "detail-error",
    linkHref: "./index.html",
    linkLabel: "返回首页",
}));
