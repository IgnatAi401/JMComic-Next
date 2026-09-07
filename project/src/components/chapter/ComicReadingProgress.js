export class ComicReadingProgress {
    constructor() {
        this.container = document.querySelector(".progress-cr");
        this.track = this.container.querySelector(".progress");
        this.fill = this.container.querySelector(".progress-inner");
        this.thumb = this.container.querySelector(".progress-thumb");
        this.currentInput = this.container.querySelector(".progress-current");
        this.totalLabel = this.container.querySelector(".progress-total");
        this.images = document.querySelector(".comic-img-cr");
    }

    init(maxIndex, onSeek = null) {
        this.maxIndex = Math.max(0, maxIndex);
        this.onSeek = typeof onSeek === "function" ? onSeek : null;
        this.viewportIndex = 0;
        this.seekingIndex = null;
        this.seekLayoutStable = false;
        this.seekCompletionTimer = null;
        this.totalLabel.textContent = String(this.maxIndex + 1);
        this.currentInput.max = String(this.maxIndex + 1);
        this.currentInput.setAttribute("aria-label", `当前页码，共 ${this.maxIndex + 1} 页；编辑后跳转`);
        this.thumb.setAttribute("role", "slider");
        this.thumb.setAttribute("aria-valuemin", "1");
        this.thumb.setAttribute("aria-valuemax", String(this.maxIndex + 1));
        this.setProgress(0);
        this.bindPointer();
        this.bindKeyboard();
        this.bindPageInput();
        this.bindSeekCancellation();
        window.addEventListener("resize", () => this.setProgress(this.currentIndex || 0));
    }

    indexFromPointer(event) {
        const rect = this.track.getBoundingClientRect();
        const rawRatio = (event.clientY - rect.top) / rect.height;
        const ratio = Math.min(1, Math.max(0, rawRatio));
        return Math.round(ratio * this.maxIndex);
    }

    bindPointer() {
        let dragging = false;
        let activePointerId = null;
        const update = (event) => {
            if (!dragging || event.pointerId !== activePointerId) return;
            this.pendingIndex = this.indexFromPointer(event);
            this.setProgress(this.pendingIndex);
        };
        const finish = (event, shouldJump) => {
            if (!dragging || event.pointerId !== activePointerId) return;
            dragging = false;
            if (this.track.hasPointerCapture?.(event.pointerId)) {
                this.track.releasePointerCapture(event.pointerId);
            }
            activePointerId = null;
            if (shouldJump) this.jumpTo(this.pendingIndex ?? 0);
        };
        this.track.addEventListener("pointerdown", (event) => {
            dragging = true;
            activePointerId = event.pointerId;
            try {
                this.track.setPointerCapture(event.pointerId);
            } catch (_) {
                // Older WebKit can reject capture while the page is settling.
            }
            this.pendingIndex = this.indexFromPointer(event);
            this.setProgress(this.pendingIndex);
        });
        this.track.addEventListener("pointermove", update);
        this.track.addEventListener("pointerup", (event) => finish(event, true));
        this.track.addEventListener("pointercancel", (event) => finish(event, false));
        this.track.addEventListener("lostpointercapture", (event) => finish(event, false));
    }

    bindPageInput() {
        const commit = () => {
            const page = Math.min(this.maxIndex + 1, Math.max(1, Math.trunc(Number(this.currentInput.value) || 1)));
            const index = page - 1;
            this.currentInput.value = String(page);
            this.setProgress(index);
            this.jumpTo(index);
        };
        this.currentInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                this.currentInput.blur();
            } else if (event.key === "Escape") {
                this.cancelInputCommit = true;
                this.currentInput.value = String((this.currentIndex || 0) + 1);
                this.currentInput.blur();
            }
        });
        this.currentInput.addEventListener("blur", () => {
            if (this.cancelInputCommit) {
                this.cancelInputCommit = false;
                return;
            }
            commit();
        });
    }

    bindKeyboard() {
        this.thumb.addEventListener("keydown", (event) => {
            let next = null;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") next = this.currentIndex + 1;
            else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = this.currentIndex - 1;
            else if (event.key === "PageDown") next = this.currentIndex + 10;
            else if (event.key === "PageUp") next = this.currentIndex - 10;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = this.maxIndex;
            if (next === null) return;
            event.preventDefault();
            const safeIndex = Math.min(this.maxIndex, Math.max(0, next));
            this.setProgress(safeIndex);
            this.jumpTo(safeIndex);
        });
    }

    bindSeekCancellation() {
        const cancel = () => this.cancelSeek();
        window.addEventListener("wheel", cancel, { passive: true });
        window.addEventListener("touchstart", (event) => {
            if (!this.container.contains(event.target)) cancel();
        }, { passive: true });
        window.addEventListener("pointerdown", (event) => {
            if (!this.container.contains(event.target)) cancel();
        }, { passive: true });
        window.addEventListener("keydown", (event) => {
            if (
                !this.container.contains(event.target)
                && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
            ) cancel();
        });
    }

    setProgress(index) {
        const safeIndex = Math.min(this.maxIndex, Math.max(0, index));
        this.currentIndex = safeIndex;
        const ratio = this.maxIndex ? safeIndex / this.maxIndex : 0;
        this.fill.style.height = `${ratio * 100}%`;
        this.fill.style.width = "";
        this.thumb.style.top = `${ratio * 100}%`;
        this.thumb.style.left = "";
        if (document.activeElement !== this.currentInput) {
            this.currentInput.value = String(safeIndex + 1);
        }
        this.thumb.setAttribute("aria-orientation", "vertical");
        this.thumb.setAttribute("aria-valuenow", String(safeIndex + 1));
        this.thumb.setAttribute("aria-valuetext", `第 ${safeIndex + 1} 页，共 ${this.maxIndex + 1} 页`);
    }

    setProgressFromViewport(index) {
        const safeIndex = Math.min(this.maxIndex, Math.max(0, index));
        this.viewportIndex = safeIndex;
        if (this.seekingIndex !== null && safeIndex !== this.seekingIndex) return false;
        if (this.seekLayoutStable) this.completeSeek();
        this.setProgress(safeIndex);
        return true;
    }

    getSeekingIndex() {
        return this.seekingIndex;
    }

    cancelSeek() {
        this.seekingIndex = null;
        this.seekLayoutStable = false;
        window.clearTimeout(this.seekCompletionTimer);
    }

    completeSeek() {
        if (this.seekingIndex === null) return;
        this.viewportIndex = this.seekingIndex;
        this.seekingIndex = null;
        this.seekLayoutStable = false;
        window.clearTimeout(this.seekCompletionTimer);
    }

    scrollToIndex(index) {
        const target = this.images.children[index];
        if (!target) return;
        const root = document.documentElement;
        const previousScrollBehavior = root.style.scrollBehavior;
        root.style.scrollBehavior = "auto";
        target.scrollIntoView({ behavior: "auto", block: "start" });
        root.style.scrollBehavior = previousScrollBehavior;
    }

    realignSeekingTarget(layoutStable = false) {
        if (this.seekingIndex === null) return;
        const targetIndex = this.seekingIndex;
        this.seekLayoutStable = layoutStable;
        this.scrollToIndex(targetIndex);
        this.setProgress(targetIndex);
        if (layoutStable) {
            window.clearTimeout(this.seekCompletionTimer);
            this.seekCompletionTimer = window.setTimeout(() => {
                if (this.seekingIndex === targetIndex) this.completeSeek();
            }, 250);
        }
    }

    jumpTo(index) {
        const safeIndex = Math.min(this.maxIndex, Math.max(0, index));
        if (!this.images.children[safeIndex]) return;
        this.seekingIndex = safeIndex === this.viewportIndex ? null : safeIndex;
        this.seekLayoutStable = false;
        window.clearTimeout(this.seekCompletionTimer);
        this.setProgress(safeIndex);
        const layoutStable = this.onSeek?.(safeIndex) === true;
        if (this.seekingIndex === null) this.scrollToIndex(safeIndex);
        else this.realignSeekingTarget(layoutStable);
    }
}
