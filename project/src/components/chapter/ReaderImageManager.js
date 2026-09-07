import { EagerComicImageLoader } from "./EagerComicImageLoader.js";
import { ComicReadingProgress } from "./ComicReadingProgress.js";
import { setting } from "../general/Setting.js";

export class ReaderImageManager {
    constructor() {
        this.imagesContainer = document.querySelector(".comic-img-cr");
    }

    init(chapter, onProgress = null) {
        const images = Array.isArray(chapter.images) ? chapter.images.filter(Boolean) : [];
        if (!this.imagesContainer) throw new Error("阅读图片容器不存在");
        if (!images.length) throw new Error("这一章没有可读取的图片");

        this.loader = new EagerComicImageLoader(chapter.id, {
            batchSize: setting.image_load_batch_size,
            onLayoutChange: (index) => this.handleImageLayoutChange(index),
        });
        this.onProgress = typeof onProgress === "function" ? onProgress : null;
        window.addEventListener("jm-settings-change", (event) => {
            this.loader.setBatchSize(event.detail?.imageLoadBatchSize);
        });
        this.progress = new ComicReadingProgress();
        this.progress.init(images.length - 1, (index) => {
            this.loader.setCurrent(index);
            return this.loader.isLayoutStableBefore(index);
        });
        this.imagesContainer.replaceChildren(...images.map((imagePathName, index) => {
            const container = document.createElement("div");
            container.className = "comic-img";
            container.dataset.path = String(imagePathName);
            container.dataset.index = String(index);
            container.dataset.state = "pending";
            container.setAttribute("aria-label", `第 ${index + 1} 页`);
            return container;
        }));

        const containers = [...this.imagesContainer.children];
        this.observeProgress(containers);
        this.loader.start(containers);
    }

    handleImageLayoutChange(index) {
        const targetIndex = this.progress?.getSeekingIndex();
        if (targetIndex === null || targetIndex === undefined || index >= targetIndex) return;
        this.progress.realignSeekingTarget(this.loader.isLayoutStableBefore(targetIndex));
    }

    observeProgress(containers) {
        const observer = new IntersectionObserver((entries) => {
            const current = entries
                .filter((entry) => entry.isIntersecting)
                .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top))[0];
            if (current) {
                const index = Number(current.target.dataset.index);
                if (!this.progress.setProgressFromViewport(index)) return;
                this.loader.setCurrent(index);
                this.onProgress?.({
                    index,
                    page: index + 1,
                    pages: containers.length,
                    progress: containers.length ? (index + 1) / containers.length : 0,
                });
            }
        }, { rootMargin: "-10% 0px -70%" });
        containers.forEach((container) => observer.observe(container));
    }
}
