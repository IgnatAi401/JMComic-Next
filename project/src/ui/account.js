import { jmApi } from "../api/JmcomicApi.js";
import { authSession } from "../auth/AuthSession.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { escapeHtml, setBusy } from "./dom.js";
import { icon } from "./icons.js";
import { showToast } from "./toast.js";

const DEFAULT_DASHSCOPE_URL = "https://dashscope.aliyuncs.com/api/v1";

const block = (collapsible, { key, title, note, body, open = false }) => collapsible
    ? `<details class="disclosure account-block" data-block="${key}"${open ? " open" : ""}>
            <summary><span>${title}</span><small>${note}</small>${icon("chevronDown", "chevron")}</summary>
            <div class="account-block-body">${body}</div>
        </details>`
    : `<section class="panel account-block" data-block="${key}" id="${key}">
            <div class="panel-head"><div><h2 class="panel-title">${title}</h2><p class="panel-sub">${note}</p></div></div>
            ${body}
        </section>`;

/**
 * Account + AI service configuration. Rendered inside the shell's account sheet
 * and inline on the settings page. Secrets are write-only: saved keys are never
 * read back, only their masked form is shown.
 */
export class AccountPanel {
    constructor(container, { collapsible = true } = {}) {
        this.container = container;
        this.collapsible = collapsible;
    }

    mount() {
        const accountBody = `
            <div class="account-identity">
                <span class="avatar" data-account-avatar>${icon("user")}</span>
                <div><strong data-account-name>未配置账号</strong><small data-account-state>配置后自动登录，并同步收藏、消息与追更。</small></div>
            </div>
            <form class="form auth-form" novalidate>
                <label class="field"><span class="field-label">账号</span><input class="input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required placeholder="用户名或邮箱" /></label>
                <label class="field"><span class="field-label">密码</span><input class="input" name="password" type="password" autocomplete="current-password" required placeholder="输入密码" /></label>
                <p class="status-line is-error auth-error" role="alert"></p>
                <div class="form-actions">
                    <button class="btn btn-primary auth-submit" type="submit">验证并保存</button>
                    <button class="btn btn-ghost btn-danger clear-config-btn" type="button" hidden>清除账号配置</button>
                </div>
                <p class="field-hint">账号密码以明文保存在本机，请只在自己的设备上使用。</p>
            </form>`;
        const embeddingBody = `
            <form class="form embedding-config-form" novalidate>
                <label class="field"><span class="field-label">百炼 API Key</span><input class="input" name="api_key" type="password" autocomplete="off" spellcheck="false" placeholder="留空表示继续使用已保存的 Key" /></label>
                <label class="field"><span class="field-label">DashScope Base URL</span><input class="input" name="api_base_url" type="url" required autocapitalize="none" spellcheck="false" placeholder="${DEFAULT_DASHSCOPE_URL}" /></label>
                <div class="form-grid">
                    <label class="field"><span class="field-label">模型</span><input class="input" value="qwen3-vl-embedding" readonly /></label>
                    <label class="field"><span class="field-label">向量维度</span><input class="input" value="1024" readonly /></label>
                </div>
                <p class="status-line embedding-config-state" role="status"></p>
                <div class="form-actions">
                    <button class="btn btn-primary embedding-config-save" type="submit">保存</button>
                    <button class="btn btn-outline embedding-config-test" type="button">测试连接</button>
                    <button class="btn btn-ghost btn-danger embedding-config-clear" type="button" hidden>清除</button>
                </div>
            </form>`;
        const llmBody = `
            <form class="form ai-config-form" novalidate>
                <label class="field"><span class="field-label">API Key</span><input class="input" name="api_key" type="password" autocomplete="off" spellcheck="false" placeholder="留空表示继续使用已保存的 Key" /></label>
                <label class="field"><span class="field-label">Base URL</span><input class="input" name="base_url" type="url" required autocapitalize="none" spellcheck="false" placeholder="https://api.example.com/v1" /></label>
                <label class="field"><span class="field-label">模型</span><input class="input" name="model" required autocapitalize="none" spellcheck="false" placeholder="模型名称" /></label>
                <label class="switch"><input name="use_ai_translation" type="checkbox" /><span class="switch-copy"><strong>用 AI 翻译标题</strong><small>开启后详情页的“译”按钮改为调用当前模型</small></span></label>
                <p class="status-line ai-config-state" role="status"></p>
                <div class="form-actions">
                    <button class="btn btn-primary ai-config-save" type="submit">保存</button>
                    <button class="btn btn-outline ai-config-test" type="button">测试连接</button>
                    <button class="btn btn-ghost btn-danger ai-config-clear" type="button" hidden>清除</button>
                </div>
            </form>`;

        this.container.innerHTML = [
            block(false, { key: "account", title: "禁漫账号", note: "收藏、签到、消息与追更都依赖账号登录。", body: accountBody }),
            block(this.collapsible, { key: "embedding", title: "Qwen 多模态向量", note: "AI 推荐必需", body: embeddingBody }),
            block(this.collapsible, { key: "llm", title: "OpenAI 兼容 LLM", note: "可选 · 偏好概述与标题翻译", body: llmBody }),
        ].join("");
        if (this.collapsible) {
            // Inside the sheet the account block reads as a plain section, not a card.
            this.container.querySelector('[data-block="account"]').classList.remove("panel");
        }
        this.authForm = this.container.querySelector(".auth-form");
        this.embeddingForm = this.container.querySelector(".embedding-config-form");
        this.aiForm = this.container.querySelector(".ai-config-form");
        this.bind();
        this.renderAccount();
        window.addEventListener("jm-auth-change", () => this.renderAccount());
        return this;
    }

    bind() {
        this.authForm.addEventListener("submit", (event) => this.handleLogin(event));
        this.authForm.querySelector(".clear-config-btn").addEventListener("click", () => this.clearAccount());
        this.embeddingForm.addEventListener("submit", (event) => this.saveEmbedding(event));
        this.embeddingForm.querySelector(".embedding-config-test").addEventListener("click", () => this.testEmbedding());
        this.embeddingForm.querySelector(".embedding-config-clear").addEventListener("click", () => this.clearEmbedding());
        this.aiForm.addEventListener("submit", (event) => this.saveAi(event));
        this.aiForm.querySelector(".ai-config-test").addEventListener("click", () => this.testAi());
        this.aiForm.querySelector(".ai-config-clear").addEventListener("click", () => this.clearAi());
    }

    /** Refresh everything from the local service; call whenever the panel becomes visible. */
    load() {
        this.authForm.querySelector(".auth-error").textContent = "";
        this.authForm.elements.username.value = authSession.configuredUsername;
        this.authForm.elements.password.value = "";
        this.renderAccount();
        this.loadEmbedding();
        this.loadAi();
    }

    reveal(section) {
        const target = this.container.querySelector(`[data-block="${section}"]`);
        if (!target) return;
        if (target.tagName === "DETAILS") target.open = true;
        requestAnimationFrame(() => target.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }));
    }

    clearSecrets() {
        this.authForm.elements.password.value = "";
        this.embeddingForm.elements.api_key.value = "";
        this.aiForm.elements.api_key.value = "";
    }

    renderAccount() {
        const configured = authSession.isConfigured;
        const name = authSession.user?.username || authSession.configuredUsername;
        const avatar = this.container.querySelector("[data-account-avatar]");
        avatar.classList.toggle("is-configured", configured);
        avatar.innerHTML = configured && name ? escapeHtml(name.slice(0, 1).toUpperCase()) : icon("user");
        this.container.querySelector("[data-account-name]").textContent = configured ? name : "未配置账号";
        this.container.querySelector("[data-account-state]").textContent = configured
            ? (authSession.isLoggedIn ? `已登录 · ${authSession.user.levelName || "会员"}` : "已保存 · 使用时自动登录")
            : "配置后自动登录，并同步收藏、消息与追更。";
        this.authForm.querySelector(".clear-config-btn").hidden = !configured;
    }

    async handleLogin(event) {
        event.preventDefault();
        const form = this.authForm;
        const submit = form.querySelector(".auth-submit");
        const errorNode = form.querySelector(".auth-error");
        const username = form.elements.username.value.trim();
        const password = form.elements.password.value;
        errorNode.textContent = "";
        if (!username || !password) {
            errorNode.textContent = "请填写账号和密码";
            return;
        }
        setBusy(submit, true);
        try {
            await authSession.configure(username, password);
            form.elements.password.value = "";
            this.renderAccount();
            window.dispatchEvent(new CustomEvent("jm-notification-change"));
            showToast("账号已验证并保存", "success");
            this.syncFavorites();
        } catch (error) {
            errorNode.textContent = error.message || "登录失败，请稍后重试";
        } finally {
            setBusy(submit, false);
        }
    }

    async syncFavorites() {
        const accountKey = String(authSession.user?.uid || authSession.configuredUsername || "");
        try {
            const items = await jmApi.getAllFavorites();
            if (!authSession.isConfigured || accountKey !== String(authSession.user?.uid || authSession.configuredUsername || "")) return;
            const result = await localRuntime.syncLocalFavorites(items.map((item) => ({
                id: item.id,
                title: item.name,
                authors: Array.isArray(item.author) ? item.author : (item.author ? [item.author] : []),
                tags: Array.isArray(item.tags) ? item.tags : [],
                cover_url: jmApi.getCoverImageURL(item.id),
            })));
            showToast(`本地收藏已更新 · ${result.synced} 本`, "success");
        } catch (error) {
            showToast(error.message || "账号已保存，但本地收藏同步失败", "warning");
        }
    }

    async clearAccount() {
        const button = this.authForm.querySelector(".clear-config-btn");
        setBusy(button, true);
        try {
            await authSession.clearLocalConfig();
            this.authForm.reset();
            this.renderAccount();
            showToast("本地账号配置已清除");
        } catch (error) {
            this.authForm.querySelector(".auth-error").textContent = error.message || "配置清除失败";
        } finally {
            setBusy(button, false);
        }
    }

    setState(form, selector, message, tone = "") {
        const node = form.querySelector(selector);
        node.textContent = message;
        node.className = `status-line ${selector.slice(1)}${tone ? ` is-${tone}` : ""}`;
    }

    async loadEmbedding() {
        const form = this.embeddingForm;
        try {
            const config = await localRuntime.getEmbeddingConfig();
            form.elements.api_key.value = "";
            form.elements.api_base_url.value = config.api_base_url || DEFAULT_DASHSCOPE_URL;
            this.setState(form, ".embedding-config-state", config.configured
                ? `已配置 · ${config.api_key_masked || "使用 DASHSCOPE_API_KEY 环境变量"}`
                : "尚未配置；AI 推荐需要百炼 API Key", config.configured ? "success" : "");
            form.querySelector(".embedding-config-clear").hidden = !config.configured || config.source === "environment";
        } catch (error) {
            this.setState(form, ".embedding-config-state", error.message || "向量接口配置读取失败", "error");
        }
    }

    async saveEmbedding(event) {
        event.preventDefault();
        const form = this.embeddingForm;
        const button = form.querySelector(".embedding-config-save");
        setBusy(button, true);
        this.setState(form, ".embedding-config-state", "正在保存…");
        try {
            await localRuntime.saveEmbeddingConfig({
                api_key: form.elements.api_key.value.trim(),
                api_base_url: form.elements.api_base_url.value.trim(),
            });
            await this.loadEmbedding();
            showToast("Qwen 向量配置已保存", "success");
        } catch (error) {
            this.setState(form, ".embedding-config-state", error.message || "向量接口配置保存失败", "error");
        } finally {
            setBusy(button, false);
        }
    }

    async testEmbedding() {
        const form = this.embeddingForm;
        const button = form.querySelector(".embedding-config-test");
        setBusy(button, true);
        this.setState(form, ".embedding-config-state", "正在调用 Qwen 向量接口…");
        try {
            const value = { api_base_url: form.elements.api_base_url.value.trim() };
            const apiKey = form.elements.api_key.value.trim();
            if (apiKey) value.api_key = apiKey;
            const result = await localRuntime.testEmbeddingConfig(value);
            await this.loadEmbedding();
            this.setState(form, ".embedding-config-state", `连接成功 · ${result.model || "qwen3-vl-embedding"} · ${result.dimension || 1024} 维`, "success");
            showToast("Qwen 向量接口连接成功", "success");
        } catch (error) {
            this.setState(form, ".embedding-config-state", error.message || "Qwen 向量接口连接失败", "error");
        } finally {
            setBusy(button, false);
        }
    }

    async clearEmbedding() {
        const form = this.embeddingForm;
        try {
            await localRuntime.clearEmbeddingConfig();
            form.reset();
            await this.loadEmbedding();
            showToast("Qwen 向量配置已清除");
        } catch (error) {
            this.setState(form, ".embedding-config-state", error.message || "向量接口配置清除失败", "error");
        }
    }

    aiFormValue() {
        const form = this.aiForm;
        return {
            api_key: form.elements.api_key.value.trim(),
            base_url: form.elements.base_url.value.trim(),
            model: form.elements.model.value.trim(),
            use_ai_translation: form.elements.use_ai_translation.checked,
        };
    }

    async loadAi() {
        const form = this.aiForm;
        try {
            const config = await localRuntime.getAiConfig();
            form.elements.api_key.value = "";
            form.elements.base_url.value = config.base_url || "";
            form.elements.model.value = config.model || "";
            form.elements.use_ai_translation.checked = Boolean(config.use_ai_translation);
            this.setState(form, ".ai-config-state", config.configured
                ? `已配置 · ${config.api_key_masked || "API Key 已保存"}`
                : "尚未配置", config.configured ? "success" : "");
            form.querySelector(".ai-config-clear").hidden = !config.configured;
        } catch (error) {
            this.setState(form, ".ai-config-state", error.message || "LLM 配置读取失败", "error");
        }
    }

    async saveAi(event) {
        event.preventDefault();
        const form = this.aiForm;
        const button = form.querySelector(".ai-config-save");
        setBusy(button, true);
        this.setState(form, ".ai-config-state", "正在保存…");
        try {
            await localRuntime.saveAiConfig(this.aiFormValue());
            await this.loadAi();
            showToast("LLM 配置已保存", "success");
        } catch (error) {
            this.setState(form, ".ai-config-state", error.message || "LLM 配置保存失败", "error");
        } finally {
            setBusy(button, false);
        }
    }

    async testAi() {
        const form = this.aiForm;
        const button = form.querySelector(".ai-config-test");
        setBusy(button, true);
        this.setState(form, ".ai-config-state", "正在连接模型…");
        try {
            const result = await localRuntime.testAiConfig(this.aiFormValue());
            this.setState(form, ".ai-config-state", `连接成功 · ${result.model || form.elements.model.value}`, "success");
            form.querySelector(".ai-config-clear").hidden = false;
            showToast("LLM 接口连接成功", "success");
        } catch (error) {
            this.setState(form, ".ai-config-state", error.message || "LLM 接口连接失败", "error");
        } finally {
            setBusy(button, false);
        }
    }

    async clearAi() {
        const form = this.aiForm;
        try {
            await localRuntime.clearAiConfig();
            form.reset();
            await this.loadAi();
            showToast("LLM 配置已清除");
        } catch (error) {
            this.setState(form, ".ai-config-state", error.message || "LLM 配置清除失败", "error");
        }
    }
}
