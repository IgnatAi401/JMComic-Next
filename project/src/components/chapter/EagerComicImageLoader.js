import { jmApi } from "../../api/JmcomicApi.js";
import { localRuntime } from "../../local/LocalRuntime.js";
import { ImageCutter } from "../general/ImageCutter.js";

const MB = 1024 * 1024;
const userAgent = navigator.userAgent || "";
const isIOSWebKit = /iPad|iPhone|iPod/.test(userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isSafari = /Safari/.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|Android/.test(userAgent);

export class EagerComicImageLoader {
    constructor(id, { batchSize = 5, onLayoutChange = null } = {}) {
        this.id = String(id);
        this.cutter = new ImageCutter();
        this.onLayoutChange = typeof onLayoutChange === "function" ? onLayoutChange : null;
        this.containers = [];
        this.renderQueue = [];
        this.renderQueued = new Set();
        this.rendering = false;
        this.suspended = false;
        this.layoutFrames = new Set();
        this.currentIndex = 0;
        this.desiredIndexes = new Set();
        this.memoryBudget = (isIOSWebKit ? 112 : isSafari ? 160 : 256) * MB;
        this.unknownImageEstimate = (isIOSWebKit || isSafari ? 16 : 24) * MB;
        this.maxBefore = isIOSWebKit ? 2 : 4;
        this.maxAfter = isIOSWebKit ? 4 : 8;
        this.setBatchSize(batchSize);
    }

    start(containers) {
        this.containers = containers;
        this.startPrefetch();
        this.setCurrent(0);
        this.handlePageHide = () => this.suspend();
        this.handlePageShow = (event) => {
            if (!event.persisted || !this.suspended) return;
            this.suspended = false;
            this.startPrefetch();
            this.setCurrent(this.currentIndex);
        };
        window.addEventListener("pagehide", this.handlePageHide);
        window.addEventListener("pageshow", this.handlePageShow);
    }

    suspend() {
        if (this.suspended) return;
        this.suspended = true;
        this.renderQueue.length = 0;
        this.renderQueued.clear();
        this.layoutFrames.forEach((frame) => cancelAnimationFrame(frame));
        this.layoutFrames.clear();
        this.desiredIndexes.forEach((index) => this.release(this.containers[index]));
        this.desiredIndexes.clear();
        localRuntime.cancelChapterImages(this.id);
    }

    setBatchSize(value) {
        const number = Number(value);
        this.batchSize = Number.isInteger(number) && number >= 1 && number <= 500 ? number : 5;
        if (this.containers.length && !this.suspended) this.startPrefetch();
    }

    startPrefetch() {
        this.prefetchQueued = localRuntime.cacheChapterImages(
            this.id,
            this.containers.map((container) => container.dataset.path),
            jmApi.getChapterImageServers(),
            this.batchSize,
        );
        this.prefetchQueued.catch(() => {});
    }

    setCurrent(index) {
        if (!this.containers.length || this.suspended) return;
        this.currentIndex = Math.min(this.containers.length - 1, Math.max(0, Math.trunc(Number(index) || 0)));
        this.updateRenderWindow();
    }

    candidateIndexes() {
        const indexes = [this.currentIndex];
        for (let distance = 1; distance <= Math.max(this.maxBefore, this.maxAfter); distance++) {
            if (distance <= this.maxAfter && this.currentIndex + distance < this.containers.length) {
                indexes.push(this.currentIndex + distance);
            }
            if (distance <= this.maxBefore && this.currentIndex - distance >= 0) {
                indexes.push(this.currentIndex - distance);
            }
        }
        return indexes;
    }

    calculateDesiredIndexes() {
        const desired = new Set();
        let estimatedBytes = 0;
        for (const index of this.candidateIndexes()) {
            const storedEstimate = Number(this.containers[index].dataset.decodedBytes);
            const estimate = Number.isFinite(storedEstimate) && storedEstimate > 0
                ? storedEstimate
                : this.unknownImageEstimate;
            if (!desired.size || estimatedBytes + estimate <= this.memoryBudget) {
                desired.add(index);
                estimatedBytes += estimate;
            }
        }
        return desired;
    }

    updateRenderWindow() {
        if (this.suspended) return;
        const nextDesired = this.calculateDesiredIndexes();
        this.desiredIndexes.forEach((index) => {
            if (!nextDesired.has(index)) this.release(this.containers[index]);
        });
        this.desiredIndexes = nextDesired;
        [...nextDesired]
            .sort((a, b) => Math.abs(a - this.currentIndex) - Math.abs(b - this.currentIndex))
            .forEach((index) => {
                const container = this.containers[index];
                this.enqueueRender(container);
            });
    }

    enqueueRender(container) {
        const index = Number(container.dataset.index);
        if (
            container.dataset.state === "loaded"
            || container.dataset.state === "rendering"
            || container.dataset.state === "error"
            || this.renderQueued.has(index)
        ) return;
        this.renderQueued.add(index);
        this.renderQueue.push(container);
        this.renderQueue.sort((a, b) => (
            Math.abs(Number(a.dataset.index) - this.currentIndex)
            - Math.abs(Number(b.dataset.index) - this.currentIndex)
        ));
        this.pumpRenderQueue();
    }

    pumpRenderQueue() {
        if (this.rendering || this.suspended) return;
        const container = this.renderQueue.shift();
        if (!container) return;
        const index = Number(container.dataset.index);
        this.renderQueued.delete(index);
        if (!this.desiredIndexes.has(index) || container.dataset.state === "loaded") {
            this.pumpRenderQueue();
            return;
        }
        this.rendering = true;
        this.render(container).catch(() => {}).finally(() => {
            this.rendering = false;
            this.pumpRenderQueue();
        });
    }

    isLayoutStableBefore(index) {
        const targetIndex = Number(index);
        return [...this.desiredIndexes]
            .filter((candidate) => candidate < targetIndex)
            .every((candidate) => {
                const container = this.containers[candidate];
                return container.dataset.state === "loaded"
                    || container.dataset.state === "error";
            });
    }

    notifyLayoutChange(container) {
        const generation = container.dataset.generation;
        const frame = requestAnimationFrame(() => {
            this.layoutFrames.delete(frame);
            if (this.suspended || container.dataset.generation !== generation) return;
            const renderedHeight = container.getBoundingClientRect().height;
            if (renderedHeight > 0) container.dataset.renderedHeight = String(renderedHeight);
            this.onLayoutChange?.(Number(container.dataset.index));
        });
        this.layoutFrames.add(frame);
    }

    async render(container) {
        const index = Number(container.dataset.index);
        const generation = (Number(container.dataset.generation) || 0) + 1;
        container.dataset.generation = String(generation);
        container.dataset.state = "rendering";
        try {
            // This waits only until Python has registered the ordered chapter job.
            // It does not wait for the current batch or the whole chapter to download.
            await this.prefetchQueued;
            if (!this.desiredIndexes.has(index) || Number(container.dataset.generation) !== generation) return;
            await this.decodeIntoContainer(container, generation);
        } catch (error) {
            if (Number(container.dataset.generation) === generation) {
                container.dataset.state = "error";
                this.renderError(container, error);
            }
            throw error;
        }
    }

    renderError(container, error) {
        const panel = document.createElement("div");
        panel.className = "reader-image-error";
        const message = document.createElement("span");
        message.textContent = error?.message || `第 ${Number(container.dataset.index) + 1} 页加载失败`;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "重新加载";
        retry.addEventListener("click", () => {
            if (this.suspended) return;
            // A failed registration promise cannot recover on its own. Register
            // again so a temporary local-server outage does not poison retries.
            this.startPrefetch();
            container.dataset.state = "pending";
            container.replaceChildren();
            this.enqueueRender(container);
        }, { once: true });
        panel.append(message, retry);
        container.replaceChildren(panel);
        this.notifyLayoutChange(container);
    }

    decodeIntoContainer(container, generation) {
        const image = document.createElement("img");
        image.alt = "";
        image.decoding = "async";
        const source = jmApi.getCachedChapterImageURL(this.id, container.dataset.path);
        container.replaceChildren(image);

        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                image.onload = null;
                image.onerror = null;
                if (container.cancelDecode === cancelDecode) delete container.cancelDecode;
                if (callback === reject) image.removeAttribute("src");
                callback(value);
            };
            const cancelDecode = () => {
                finish(resolve, container);
                image.removeAttribute("src");
            };
            container.cancelDecode = cancelDecode;
            timer = setTimeout(() => finish(reject, new Error("本地图片解码超时")), 130000);
            image.onload = () => {
                if (!this.desiredIndexes.has(Number(container.dataset.index)) || Number(container.dataset.generation) !== generation) {
                    finish(resolve, container);
                    image.removeAttribute("src");
                    return;
                }
                const width = Math.max(1, image.naturalWidth);
                const height = Math.max(1, image.naturalHeight);
                const isGif = container.dataset.path.toLowerCase().endsWith(".gif");
                container.dataset.decodedBytes = String(width * height * 4 * (isGif ? 2 : 1));
                try {
                    if (Number(this.id) >= 220980 && !isGif) {
                        const restoredSlices = this.cutter.cutImage(image, this.id, container.dataset.path);
                        container.replaceChildren(restoredSlices);
                        image.onload = null;
                        image.onerror = null;
                        image.removeAttribute("src");
                    } else {
                        image.style.filter = "none";
                    }
                    container.style.height = "";
                    delete container.dataset.placeholder;
                    container.dataset.state = "loaded";
                    this.updateRenderWindow();
                    this.notifyLayoutChange(container);
                    finish(resolve, container);
                } catch (error) {
                    finish(reject, error);
                }
            };
            image.onerror = () => finish(reject, new Error(`图片 ${Number(container.dataset.index) + 1} 加载失败`));
            image.src = source;
        });
    }

    release(container) {
        if (!container) return;
        const height = container.getBoundingClientRect().height || Number(container.dataset.renderedHeight) || 0;
        if (height > 0) {
            container.dataset.renderedHeight = String(height);
            container.dataset.placeholder = "true";
            container.style.height = `${height}px`;
        }
        container.dataset.generation = String((Number(container.dataset.generation) || 0) + 1);
        if (typeof container.cancelDecode === "function") container.cancelDecode();
        container.querySelectorAll("img").forEach((image) => {
            image.onload = null;
            image.onerror = null;
            image.removeAttribute("src");
        });
        container.querySelectorAll("canvas").forEach((canvas) => {
            canvas.width = 0;
            canvas.height = 0;
        });
        container.replaceChildren();
        container.dataset.state = "pending";
    }
}
