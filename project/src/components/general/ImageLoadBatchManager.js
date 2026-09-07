import { setting } from "./Setting.js";
import { showToast } from "./Toast.js";

const PRESETS = [1, 5, 10, 20, 50, 100];
const BATCH_ICON = `
    <svg class="batch-setting-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 7h8M5 12h8M5 17h8"></path>
        <path d="m15 6 2-2 2 2M17 4v6"></path>
        <path d="m15 18 2 2 2-2M17 20v-6"></path>
    </svg>`;

export class ImageLoadBatchManager {
    constructor(root) {
        this.root = root;
    }

    async init() {
        if (!this.root) return;
        this.renderShell();
        this.bindEvents();
        await setting.init();
        this.renderValue(setting.image_load_batch_size);
        window.addEventListener("jm-settings-change", (event) => {
            this.renderValue(event.detail?.imageLoadBatchSize || setting.image_load_batch_size);
        });
    }

    renderShell() {
        this.root.innerHTML = `
            <button class="batch-setting-trigger" type="button" aria-haspopup="dialog" aria-controls="batch-setting-menu" aria-expanded="false" title="设置图片下载并发数量">
                ${BATCH_ICON}
            </button>
            <div class="batch-setting-menu" id="batch-setting-menu" role="dialog" aria-labelledby="batch-setting-title" hidden>
                <div class="batch-setting-head"><strong id="batch-setting-title">图片下载并发</strong><small>按页码分批，从前往后缓存</small></div>
                <div class="batch-presets">
                    ${PRESETS.map((value) => `<button type="button" data-batch-size="${value}">${value}</button>`).join("")}
                </div>
                <form class="batch-custom-form">
                    <label><span>自定义</span><input type="number" min="1" max="500" step="1" inputmode="numeric" placeholder="1–500" aria-label="自定义并发加载数量" /></label>
                    <button type="submit">保存</button>
                </form>
            </div>`;
        this.trigger = this.root.querySelector(".batch-setting-trigger");
        this.menu = this.root.querySelector(".batch-setting-menu");
        this.input = this.root.querySelector(".batch-custom-form input");
    }

    bindEvents() {
        this.trigger.addEventListener("click", () => this.setOpen(this.menu.hidden));
        this.root.querySelectorAll("[data-batch-size]").forEach((button) => {
            button.addEventListener("click", () => this.save(button.dataset.batchSize));
        });
        this.root.querySelector(".batch-custom-form").addEventListener("submit", (event) => {
            event.preventDefault();
            this.save(this.input.value);
        });
        document.addEventListener("click", (event) => {
            if (!this.root.contains(event.target)) this.setOpen(false);
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && !this.menu.hidden) this.setOpen(false);
        });
    }

    setOpen(open) {
        const shouldRestoreFocus = !open && this.menu.contains(document.activeElement);
        if (shouldRestoreFocus) this.trigger.focus({ preventScroll: true });
        this.menu.hidden = !open;
        this.root.classList.toggle("open", open);
        this.trigger.setAttribute("aria-expanded", String(open));
        if (open) {
            this.input.value = String(setting.image_load_batch_size);
            setTimeout(() => this.input.select(), 0);
        }
    }

    async save(value) {
        this.root.classList.add("saving");
        try {
            const batchSize = await setting.setImageLoadBatchSize(value);
            this.renderValue(batchSize);
            this.setOpen(false);
            showToast(`图片下载并发已设为 ${batchSize}`, "success");
        } catch (error) {
            showToast(error.message || "设置保存失败", "warning");
            this.input.focus();
        } finally {
            this.root.classList.remove("saving");
        }
    }

    renderValue(value) {
        const batchSize = Number(value) || 5;
        this.trigger.setAttribute("aria-label", `同时下载 ${batchSize} 张图片`);
        this.trigger.title = `图片下载并发：${batchSize}`;
        this.root.querySelectorAll("[data-batch-size]").forEach((button) => {
            const active = Number(button.dataset.batchSize) === batchSize;
            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", String(active));
        });
    }
}
