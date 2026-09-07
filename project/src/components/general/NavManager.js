import { authSession } from "../../auth/AuthSession.js";
import { jmApi } from "../../api/JmcomicApi.js";
import { ImageLoadBatchManager } from "./ImageLoadBatchManager.js";
import { showToast } from "./Toast.js";
import { localRuntime } from "../../local/LocalRuntime.js";
import { openInNewPage } from "../../utils/NavigationPolicy.js";

const pageName = () => location.pathname.split("/").pop()?.replace(".html", "") || "index";

const dockIcons = {
    home: '<path d="M3 10.5 12 3l9 7.5v9a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H4.5A1.5 1.5 0 0 1 3 19.5z"/><path d="M8 21v-7h8v7"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    latest: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>',
    categories: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    library: '<path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    messages: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    ai: '<path d="m12 3 1.25 3.75L17 8l-3.75 1.25L12 13l-1.25-3.75L7 8l3.75-1.25z"/><path d="m18.5 13 .75 2.25L21.5 16l-2.25.75L18.5 19l-.75-2.25L15.5 16l2.25-.75z"/><path d="m6 14 1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1v.1H9.55V21a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.05 15a1.7 1.7 0 0 0-1.6-1H2.4V10h.05a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.5 4.2l.06.06A1.7 1.7 0 0 0 8.45 4a1.7 1.7 0 0 0 1.1-1.6v-.1h4.05v.1A1.7 1.7 0 0 0 14.7 4a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.1 8.4a1.7 1.7 0 0 0 1.6 1h.1v4.05h-.1a1.7 1.7 0 0 0-1.3 1.55z"/>',
    checkin: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4M16 3v4M4 9h16M8.5 14l2 2 4-4"/>',
    account: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-4 3.1-6 7-6s6.2 2 7 6"/>',
};

const dockIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${dockIcons[name]}</svg>`;

const scrollLocks = new Set();
let scrollLockY = 0;
let previousBodyStyles = null;

const lockPageScroll = (owner) => {
    if (scrollLocks.has(owner)) return;
    scrollLocks.add(owner);
    if (scrollLocks.size > 1) return;
    scrollLockY = window.scrollY;
    previousBodyStyles = {
        position: document.body.style.position,
        top: document.body.style.top,
        left: document.body.style.left,
        right: document.body.style.right,
        width: document.body.style.width,
        overflow: document.body.style.overflow,
    };
    Object.assign(document.body.style, {
        position: "fixed",
        top: `-${scrollLockY}px`,
        left: "0",
        right: "0",
        width: "100%",
        overflow: "hidden",
    });
};

const unlockPageScroll = (owner) => {
    if (!scrollLocks.delete(owner) || scrollLocks.size) return;
    Object.assign(document.body.style, previousBodyStyles || {});
    previousBodyStyles = null;
    const root = document.documentElement;
    const scrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(0, scrollLockY);
    root.style.scrollBehavior = scrollBehavior;
};

export class NavManager {
    constructor() {
        this.navDom = document.querySelector(".nav");
        this.mobileNavDom = document.querySelector(".mob-nav");
        this.renderShell();
    }

    init() {
        this.bindEvents();
        this.bindTopBarScroll();
        this.batchManager = new ImageLoadBatchManager(this.navDom.querySelector(".batch-setting"));
        this.batchManager.init();
        this.renderAccount();
        window.addEventListener("jm-auth-change", () => {
            this.renderAccount();
        });
        authSession.loadLocalConfig()
            .then(() => this.scheduleUnreadRefresh())
            .catch(() => this.renderAccount());
        window.addEventListener("jm-notification-change", () => this.scheduleUnreadRefresh(true));
    }

    bindTopBarScroll() {
        const rampDistance = 120;
        let framePending = false;

        const updateTopBar = () => {
            const linearProgress = Math.min(1, Math.max(0, window.scrollY / rampDistance));
            const smoothProgress = linearProgress * linearProgress * (3 - 2 * linearProgress);
            this.navDom.style.setProperty("--nav-scroll-progress", smoothProgress.toFixed(4));
            this.navDom.style.setProperty("--nav-top-progress", (1 - smoothProgress).toFixed(4));
            this.navDom.style.setProperty("--nav-fog-opacity", (0.8 + 0.2 * smoothProgress).toFixed(4));
            framePending = false;
        };

        const scheduleUpdate = () => {
            if (framePending) return;
            framePending = true;
            requestAnimationFrame(updateTopBar);
        };

        updateTopBar();
        window.addEventListener("scroll", scheduleUpdate, { passive: true });
    }

    renderShell() {
        const current = pageName();
        const isLibrary = current === "library";
        const isMessages = current === "messages";
        const active = (name) => current === name ? "active" : "";
        const sourcePicker = document.querySelector(".switch-server");
        this.navDom.innerHTML = `
            <div class="nav-inner">
                <button class="page-list-btn" type="button" aria-label="打开菜单"><span></span><span></span></button>
                <a class="logo nav-brand-logo" href="./index.html" aria-label="JMComic 首页"><img src="./image/1e1c27c3-4553-4d6d-ad8c-d06dacbbfb5a.png" alt="JMComic" /></a>
                <div class="pages" aria-label="主导航">
                    <a class="p-item ${active("index")}" href="./index.html">发现</a>
                    <a class="p-item ${active("latest")}" href="./latest.html">最新</a>
                    <a class="p-item ${active("categories")}" href="./categories.html">分类</a>
                    <a class="p-item ${active("ai")}" href="./ai.html">AI 推荐</a>
                </div>
                <div class="search"><form role="search"><span class="nav-search-icon">${dockIcon("search")}</span><input type="search" autocomplete="off" placeholder="搜索作品、作者或番号" aria-label="搜索" /></form></div>
                <div class="nav-actions">
                    <div class="batch-setting nav-batch-setting"></div>
                    <button class="checkin-trigger" type="button" aria-label="每日签到"><i aria-hidden="true">${dockIcon("checkin")}</i><span>签到</span></button>
                    <a class="messages-link ${isMessages ? "active" : ""}" href="./messages.html" aria-label="消息与追更"><span>消息</span><b hidden>0</b></a>
                    <a class="library-link ${isLibrary ? "active" : ""}" href="./library.html" aria-label="收藏与历史"><span>收藏</span></a>
                    <button class="account-trigger" type="button" aria-label="账号配置"><span class="account-dot" aria-hidden="true">${dockIcon("account")}</span><span class="account-label">账号配置</span></button>
                </div>
            </div>`;
        if (sourcePicker) {
            sourcePicker.classList.add("nav-server");
            this.navDom.querySelector(".nav-actions").prepend(sourcePicker);
        }

        if (!document.querySelector(".app-dock")) {
            document.body.insertAdjacentHTML("beforeend", `
            <aside class="app-dock" data-current="${current}" aria-label="快捷导航">
                <span class="app-dock-glass" aria-hidden="true"></span>
                <span class="app-dock-ambient" aria-hidden="true"></span>
                <div class="app-dock-content">
                    <a class="app-dock-item" data-dock="index" href="./index.html" aria-label="发现"><span class="app-dock-glyph icon-home" aria-hidden="true"></span><span class="app-dock-label">发现</span></a>
                    <button class="app-dock-item dock-search-trigger" data-dock="search" type="button" aria-label="搜索"><span class="app-dock-glyph icon-search" aria-hidden="true"></span><span class="app-dock-label">搜索</span></button>
                    <a class="app-dock-item" data-dock="latest" href="./latest.html" aria-label="最新"><span class="app-dock-glyph icon-latest" aria-hidden="true"></span><span class="app-dock-label">最新</span></a>
                    <a class="app-dock-item" data-dock="categories" href="./categories.html" aria-label="分类"><span class="app-dock-glyph icon-categories" aria-hidden="true"></span><span class="app-dock-label">分类</span></a>
                    <a class="app-dock-item" data-dock="library" href="./library.html" aria-label="收藏与历史"><span class="app-dock-glyph icon-library" aria-hidden="true"></span><span class="app-dock-label">收藏与历史</span></a>
                    <a class="app-dock-item app-dock-messages" data-dock="messages" href="./messages.html" aria-label="消息与追更"><span class="app-dock-glyph icon-messages" aria-hidden="true"></span><b class="dock-messages-badge" hidden>0</b><span class="app-dock-label">消息与追更</span></a>
                    <a class="app-dock-item" data-dock="ai" href="./ai.html" aria-label="AI 推荐"><span class="app-dock-glyph icon-ai" aria-hidden="true"></span><span class="app-dock-label">AI 推荐</span></a>
                    <span class="app-dock-divider" aria-hidden="true"></span>
                    <a class="app-dock-item app-dock-settings" data-dock="setting" href="./setting.html" aria-label="设置"><span class="app-dock-glyph icon-settings" aria-hidden="true"></span><span class="app-dock-label">设置</span></a>
                </div>
            </aside>`);
        }
        this.dockDom = document.querySelector(".app-dock");
        this.dockDom.dataset.current = current;
        this.dockDom.querySelectorAll("[data-dock]").forEach((item) => {
            if (item.dataset.dock === current) item.setAttribute("aria-current", "page");
            else item.removeAttribute("aria-current");
        });

        this.mobileNavDom.innerHTML = `
            <div class="mn-inner">
                <div class="mn-head"><a class="logo nav-brand-logo" href="./index.html" aria-label="JMComic 首页"><img src="./image/1e1c27c3-4553-4d6d-ad8c-d06dacbbfb5a.png" alt="JMComic" /></a><button class="drawer-close" type="button" aria-label="关闭菜单"><span aria-hidden="true">×</span></button></div>
                <div class="mn-items-cr">
                    <a class="mn-item ${active("index")}" href="./index.html">发现 <span>01</span></a>
                    <a class="mn-item ${active("latest")}" href="./latest.html">最新 <span>02</span></a>
                    <a class="mn-item ${active("categories")}" href="./categories.html">分类 <span>03</span></a>
                    <a class="mn-item ${active("ai")}" href="./ai.html">AI 推荐 <span>04</span></a>
                    <a class="mn-item ${isMessages ? "active" : ""}" href="./messages.html">消息与追更 <span>05</span></a>
                    <a class="mn-item ${isLibrary ? "active" : ""}" href="./library.html">收藏与历史 <span>06</span></a>
                    <a class="mn-item ${active("setting")}" href="./setting.html">设置 <span>07</span></a>
                </div>
                <button class="mobile-account account-trigger primary-btn" type="button">配置账号密码</button>
            </div>`;

        if (!document.querySelector(".auth-modal")) {
            document.body.insertAdjacentHTML("beforeend", `
                <div class="auth-modal" aria-hidden="true">
                    <button class="modal-backdrop" type="button" aria-label="关闭登录窗口"></button>
                    <section class="auth-panel" role="dialog" aria-modal="true" aria-labelledby="auth-title">
                        <button class="modal-close" type="button" aria-label="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
                        <div class="auth-mark"><i></i></div>
                        <p class="eyebrow">本地账号</p>
                        <h2 id="auth-title">配置账号密码</h2>
                        <p class="auth-copy">配置会以明文写入项目内的 <code>project/data/account.json</code>，登录会话由本地服务统一持有并在页面之间复用。</p>
                        <form class="auth-form">
                            <label><span>账号</span><input name="username" autocomplete="username" required placeholder="用户名或邮箱" /></label>
                            <label><span>密码</span><input name="password" type="password" autocomplete="current-password" required placeholder="输入密码" /></label>
                            <p class="auth-error" role="alert"></p>
                            <button class="primary-btn auth-submit" type="submit">验证并保存配置</button>
                            <button class="ghost-btn clear-config-btn" type="button" hidden>清除本地账号配置</button>
                        </form>
                        <details class="ai-config-section embedding-config-section">
                            <summary>Qwen 多模态 Embedding（推荐必需）</summary>
                            <form class="embedding-config-form">
                                <label><span>百炼 API Key</span><input name="api_key" type="password" autocomplete="off" placeholder="留空表示继续使用已保存的 Key" /></label>
                                <label><span>DashScope Base URL</span><input name="api_base_url" type="url" required placeholder="从下载配置的 dashScope 字段复制" /></label>
                                <label><span>模型</span><input value="qwen3-vl-embedding" readonly /></label>
                                <label><span>向量维度</span><input value="1024" readonly /></label>
                                <p class="embedding-config-state ai-config-state" role="status"></p>
                                <button class="primary-btn embedding-config-save" type="submit">保存 Embedding 配置</button>
                                <button class="ghost-btn embedding-config-test" type="button">测试 Qwen 连接</button>
                                <button class="ghost-btn embedding-config-clear" type="button" hidden>清除 Embedding 配置</button>
                            </form>
                        </details>
                        <details class="ai-config-section llm-config-section">
                            <summary>OpenAI 兼容 LLM（可选）</summary>
                            <form class="ai-config-form">
                                <label><span>API Key</span><input name="api_key" type="password" autocomplete="off" placeholder="留空表示继续使用已保存的 Key" /></label>
                                <label><span>Base URL</span><input name="base_url" type="url" required placeholder="https://api.example.com/v1" /></label>
                                <label><span>模型</span><input name="model" required placeholder="模型名称" /></label>
                                <label class="ai-translation-toggle"><input name="use_ai_translation" type="checkbox" /><span><strong>使用 AI 翻译标题</strong><small>开启后漫画详情页的“译”按钮将调用当前模型</small></span></label>
                                <p class="ai-config-state" role="status"></p>
                                <button class="primary-btn ai-config-save" type="submit">保存 AI 配置</button>
                                <button class="ghost-btn ai-config-test" type="button">测试连接</button>
                                <button class="ghost-btn ai-config-clear" type="button" hidden>清除 AI 配置</button>
                            </form>
                        </details>
                    </section>
                </div>`);
        }
    }

    bindEvents() {
        this.mobileNavDom.style.display = "none";
        const menuButton = this.navDom.querySelector(".page-list-btn");
        menuButton.setAttribute("aria-expanded", "false");
        let drawerOpen = false;
        let drawerHideTimer = 0;
        const openDrawer = () => {
            if (drawerOpen) return;
            drawerOpen = true;
            clearTimeout(drawerHideTimer);
            this.mobileNavDom.style.display = "block";
            menuButton.setAttribute("aria-expanded", "true");
            lockPageScroll(this.mobileNavDom);
            requestAnimationFrame(() => {
                if (drawerOpen) this.mobileNavDom.classList.add("show");
            });
        };
        const closeDrawer = () => {
            if (!drawerOpen) return;
            drawerOpen = false;
            this.mobileNavDom.classList.remove("show");
            menuButton.setAttribute("aria-expanded", "false");
            unlockPageScroll(this.mobileNavDom);
            drawerHideTimer = setTimeout(() => { this.mobileNavDom.style.display = "none"; }, 240);
        };
        menuButton.addEventListener("click", openDrawer);
        this.mobileNavDom.querySelector(".drawer-close").addEventListener("click", closeDrawer);
        this.mobileNavDom.addEventListener("click", (event) => {
            if (event.target === this.mobileNavDom) closeDrawer();
        });

        this.navDom.querySelector(".search form").addEventListener("submit", (event) => {
            event.preventDefault();
            const value = event.currentTarget.querySelector("input").value.trim();
            if (!value) return;
            const searchUrl = `./search.html?sq=${encodeURIComponent(value)}&v=20260827-7`;
            if (pageName() === "search") window.location.assign(searchUrl);
            else openInNewPage(searchUrl);
        });

        this.dockDom?.querySelector(".dock-search-trigger")?.addEventListener("click", () => {
            const input = this.navDom.querySelector('.search input[type="search"]');
            input?.focus({ preventScroll: true });
            input?.select();
            this.navDom.querySelector(".search form")?.classList.add("dock-focus-pulse");
            window.setTimeout(() => this.navDom.querySelector(".search form")?.classList.remove("dock-focus-pulse"), 620);
        });

        this.navDom.querySelector(".checkin-trigger").addEventListener("click", () => this.handleCheckIn());

        document.querySelectorAll(".account-trigger").forEach((button) => {
            button.addEventListener("click", () => this.openAuthModal(button.dataset.openAi === "true"));
        });
        const modal = document.querySelector(".auth-modal");
        const closeModal = () => {
            if (!modal.classList.contains("show")) return;
            modal.classList.remove("show");
            modal.setAttribute("aria-hidden", "true");
            modal.querySelector('[name="password"]').value = "";
            clearTimeout(this.authFocusTimer);
            unlockPageScroll(modal);
            if (this.authOpener?.isConnected) this.authOpener.focus({ preventScroll: true });
        };
        modal.querySelector(".modal-close").addEventListener("click", closeModal);
        modal.querySelector(".modal-backdrop").addEventListener("click", closeModal);
        modal.querySelector(".clear-config-btn").addEventListener("click", async () => {
            try {
                await authSession.clearLocalConfig();
                modal.querySelector(".auth-form").reset();
                this.renderAccount();
                showToast("本地账号配置已清除");
            } catch (error) {
                modal.querySelector(".auth-error").textContent = error.message || "配置清除失败";
            }
        });
        modal.querySelector(".auth-form").addEventListener("submit", (event) => this.handleLogin(event));
        modal.querySelector(".embedding-config-form").addEventListener("submit", (event) => this.handleEmbeddingConfig(event));
        modal.querySelector(".embedding-config-test").addEventListener("click", () => this.testEmbeddingConfig());
        modal.querySelector(".embedding-config-clear").addEventListener("click", () => this.clearEmbeddingConfig());
        modal.querySelector(".ai-config-form").addEventListener("submit", (event) => this.handleAiConfig(event));
        modal.querySelector(".ai-config-test").addEventListener("click", () => this.testAiConfig());
        modal.querySelector(".ai-config-clear").addEventListener("click", () => this.clearAiConfig());
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            if (modal.classList.contains("show")) closeModal();
            else closeDrawer();
        });
    }

    async openAuthModal(openAi = false) {
        const modal = document.querySelector(".auth-modal");
        if (modal.classList.contains("show")) {
            if (openAi) modal.querySelector(".llm-config-section").open = true;
            return;
        }
        this.authOpener = document.activeElement;
        this.renderAccount();
        modal.classList.add("show");
        modal.setAttribute("aria-hidden", "false");
        lockPageScroll(modal);
        const errorDom = modal.querySelector(".auth-error");
        errorDom.textContent = "";
        modal.querySelector('[name="username"]').value = authSession.configuredUsername;
        modal.querySelector('[name="password"]').value = "";
        modal.querySelector(".clear-config-btn").hidden = !authSession.isConfigured;
        if (openAi) modal.querySelector(".llm-config-section").open = true;
        this.loadEmbeddingConfig();
        this.loadAiConfig();
        this.authFocusTimer = setTimeout(() => {
            if (modal.classList.contains("show")) modal.querySelector('[name="username"]').focus({ preventScroll: true });
        }, 100);
    }

    async loadEmbeddingConfig() {
        const form = document.querySelector(".embedding-config-form");
        try {
            const config = await localRuntime.getEmbeddingConfig();
            form.elements.api_key.value = "";
            form.elements.api_base_url.value = config.api_base_url || "https://dashscope.aliyuncs.com/api/v1";
            form.querySelector(".embedding-config-state").textContent = config.configured
                ? `已配置 · ${config.api_key_masked || "使用 DASHSCOPE_API_KEY 环境变量"}`
                : "尚未配置；推荐功能需要百炼 API Key";
            form.querySelector(".embedding-config-clear").hidden = !config.configured || config.source === "environment";
        } catch (error) {
            form.querySelector(".embedding-config-state").textContent = error.message || "Embedding 配置读取失败";
        }
    }

    async handleEmbeddingConfig(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector(".embedding-config-save");
        const state = form.querySelector(".embedding-config-state");
        button.disabled = true;
        state.textContent = "正在保存…";
        try {
            await localRuntime.saveEmbeddingConfig({
                api_key: form.elements.api_key.value.trim(),
                api_base_url: form.elements.api_base_url.value.trim(),
            });
            await this.loadEmbeddingConfig();
            showToast("Qwen Embedding 配置已保存", "success");
        } catch (error) {
            state.textContent = error.message || "Embedding 配置保存失败";
        } finally {
            button.disabled = false;
        }
    }

    async testEmbeddingConfig() {
        const form = document.querySelector(".embedding-config-form");
        const button = form.querySelector(".embedding-config-test");
        const state = form.querySelector(".embedding-config-state");
        button.disabled = true;
        state.textContent = "正在调用 Qwen Embedding API…";
        try {
            const apiKey = form.elements.api_key.value.trim();
            const value = { api_base_url: form.elements.api_base_url.value.trim() };
            if (apiKey) value.api_key = apiKey;
            const result = await localRuntime.testEmbeddingConfig(value);
            state.textContent = `连接成功 · ${result.model} · ${result.dimension} 维`;
            await this.loadEmbeddingConfig();
            showToast("Qwen Embedding API 连接成功", "success");
        } catch (error) {
            state.textContent = error.message || "Qwen Embedding API 连接失败";
        } finally {
            button.disabled = false;
        }
    }

    async clearEmbeddingConfig() {
        const form = document.querySelector(".embedding-config-form");
        try {
            await localRuntime.clearEmbeddingConfig();
            form.reset();
            await this.loadEmbeddingConfig();
            showToast("Qwen Embedding 配置已清除");
        } catch (error) {
            form.querySelector(".embedding-config-state").textContent = error.message || "Embedding 配置清除失败";
        }
    }

    async loadAiConfig() {
        const form = document.querySelector(".ai-config-form");
        try {
            const config = await localRuntime.getAiConfig();
            form.elements.base_url.value = config.base_url || "";
            form.elements.model.value = config.model || "";
            form.elements.api_key.value = "";
            form.elements.use_ai_translation.checked = Boolean(config.use_ai_translation);
            form.querySelector(".ai-config-state").textContent = config.configured
                ? `已配置 · ${config.api_key_masked || "API Key 已保存"}` : "尚未配置";
            form.querySelector(".ai-config-clear").hidden = !config.configured;
        } catch (error) {
            form.querySelector(".ai-config-state").textContent = error.message || "AI 配置读取失败";
        }
    }

    aiFormValue() {
        const form = document.querySelector(".ai-config-form");
        return {
            api_key: form.elements.api_key.value.trim(),
            base_url: form.elements.base_url.value.trim(),
            model: form.elements.model.value.trim(),
            use_ai_translation: form.elements.use_ai_translation.checked,
        };
    }

    async handleAiConfig(event) {
        event.preventDefault();
        const button = event.currentTarget.querySelector(".ai-config-save");
        const state = event.currentTarget.querySelector(".ai-config-state");
        button.disabled = true;
        state.textContent = "正在保存…";
        try {
            await localRuntime.saveAiConfig(this.aiFormValue());
            await this.loadAiConfig();
            showToast("AI 配置已保存到项目目录", "success");
        } catch (error) {
            state.textContent = error.message || "AI 配置保存失败";
        } finally {
            button.disabled = false;
        }
    }

    async testAiConfig() {
        const form = document.querySelector(".ai-config-form");
        const button = form.querySelector(".ai-config-test");
        const state = form.querySelector(".ai-config-state");
        button.disabled = true;
        state.textContent = "正在连接模型…";
        try {
            const result = await localRuntime.testAiConfig(this.aiFormValue());
            state.textContent = `连接成功 · ${result.model}`;
            form.querySelector(".ai-config-clear").hidden = false;
            showToast("AI 接口连接成功", "success");
        } catch (error) {
            state.textContent = error.message || "AI 接口连接失败";
        } finally {
            button.disabled = false;
        }
    }

    async clearAiConfig() {
        const form = document.querySelector(".ai-config-form");
        try {
            await localRuntime.clearAiConfig();
            form.reset();
            await this.loadAiConfig();
            showToast("AI 配置已清除");
        } catch (error) {
            form.querySelector(".ai-config-state").textContent = error.message || "AI 配置清除失败";
        }
    }

    async handleLogin(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const submit = form.querySelector(".auth-submit");
        const errorDom = form.querySelector(".auth-error");
        const formData = new FormData(form);
        errorDom.textContent = "";
        submit.disabled = true;
        submit.textContent = "正在验证…";
        try {
            await authSession.configure(String(formData.get("username")).trim(), String(formData.get("password")));
            this.renderAccount();
            this.scheduleUnreadRefresh(true);
            this.syncConfiguredFavorites();
            form.querySelector(".clear-config-btn").hidden = false;
            showToast("账号配置已验证并保存到项目目录", "success");
        } catch (error) {
            errorDom.textContent = error.message || "登录失败，请稍后重试";
        } finally {
            submit.disabled = false;
            submit.textContent = "验证并保存配置";
        }
    }

    async syncConfiguredFavorites() {
        try {
            const items = await jmApi.getAllFavorites();
            const result = await localRuntime.syncLocalFavorites(items.map((item) => ({
                id: item.id,
                title: item.name,
                authors: Array.isArray(item.author) ? item.author : (item.author ? [item.author] : []),
                tags: Array.isArray(item.tags) ? item.tags : [],
                cover_url: jmApi.getCoverImageURL(item.id),
            })));
            showToast(`本地收藏已更新 · ${result.synced} 本`, "success");
        } catch (error) {
            showToast(error.message || "账号已切换，但本地收藏同步失败", "warning");
        }
    }

    async handleCheckIn() {
        const button = this.navDom.querySelector(".checkin-trigger");
        if (!button || button.disabled) return;
        button.disabled = true;
        button.classList.add("busy");
        button.querySelector("span").textContent = "签到中…";
        try {
            await authSession.loadLocalConfig();
            if (!authSession.isConfigured) {
                this.openAuthModal();
                throw new Error("请先配置账号和密码");
            }
            const user = await authSession.loginFromLocalConfig();
            const result = await jmApi.dailyCheckIn(user?.uid);
            showToast(result.message || "签到成功", "success");
        } catch (error) {
            showToast(error.message || "签到失败，请稍后重试");
        } finally {
            button.disabled = false;
            button.classList.remove("busy");
            button.querySelector("span").textContent = "签到";
        }
    }

    renderAccount() {
        const label = this.navDom.querySelector(".account-label");
        const dot = this.navDom.querySelector(".account-dot");
        const mobile = this.mobileNavDom.querySelector(".mobile-account");
        label.textContent = "账号配置";
        if (authSession.isConfigured) {
            dot.classList.add("has-user");
            mobile.textContent = `账号配置 · ${authSession.configuredUsername}`;
        } else {
            dot.classList.remove("has-user");
            mobile.textContent = "配置账号密码";
        }
        this.navDom.querySelector(".account-trigger")?.setAttribute(
            "aria-label",
            authSession.isConfigured ? `账号配置，已配置 ${authSession.configuredUsername}` : "账号配置，尚未配置",
        );

        const modal = document.querySelector(".auth-modal");
        modal.querySelector(".clear-config-btn").hidden = !authSession.isConfigured;
    }

    scheduleUnreadRefresh(force = false) {
        const run = () => this.refreshUnreadCount(force).catch(() => {});
        if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1500 });
        else setTimeout(run, 250);
    }

    async refreshUnreadCount(force = false) {
        const badges = [
            this.navDom.querySelector(".messages-link b"),
            this.dockDom?.querySelector(".dock-messages-badge"),
        ].filter(Boolean);
        if (!badges.length || !authSession.isConfigured) {
            badges.forEach((badge) => { badge.hidden = true; });
            return;
        }
        try {
            if (!authSession.isLoggedIn) await authSession.loginFromLocalConfig();
            const count = await jmApi.getUnreadNotificationCount(force);
            badges.forEach((badge) => {
                badge.textContent = count > 99 ? "99+" : String(count);
                badge.hidden = count <= 0;
            });
        } catch {
            badges.forEach((badge) => { badge.hidden = true; });
        }
    }

}
