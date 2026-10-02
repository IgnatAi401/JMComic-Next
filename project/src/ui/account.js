import { authSession } from "../auth/AuthSession.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { escapeHtml, setBusy } from "./dom.js";
import { icon } from "./icons.js";
import { showToast } from "./toast.js";

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
 * Account + optional translation model configuration. Rendered inside the shell's account sheet
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
        const translationBody = `
            <form class="form translation-config-form" novalidate>
                <label class="field"><span class="field-label">API Key</span><input class="input" name="api_key" type="password" autocomplete="off" spellcheck="false" placeholder="留空表示继续使用已保存的 Key" /></label>
                <label class="field"><span class="field-label">Base URL</span><input class="input" name="base_url" type="url" required autocapitalize="none" spellcheck="false" placeholder="https://api.example.com/v1" /></label>
                <label class="field"><span class="field-label">模型</span><input class="input" name="model" required autocapitalize="none" spellcheck="false" placeholder="模型名称" /></label>
                <label class="switch"><input name="use_ai_translation" type="checkbox" /><span class="switch-copy"><strong>用 AI 翻译标题</strong><small>开启后详情页的“翻译标题”改为调用此模型，关闭时使用默认翻译</small></span></label>
                <p class="status-line translation-config-state" role="status"></p>
                <div class="form-actions">
                    <button class="btn btn-primary translation-config-save" type="submit">保存</button>
                    <button class="btn btn-outline translation-config-test" type="button">测试连接</button>
                    <button class="btn btn-ghost btn-danger translation-config-clear" type="button" hidden>清除</button>
                </div>
            </form>`;

        this.container.innerHTML = [
            block(false, { key: "account", title: "禁漫账号", note: "收藏、签到、消息与追更都依赖账号登录。", body: accountBody }),
            block(this.collapsible, { key: "translation", title: "AI 标题翻译", note: "可选 · OpenAI 兼容接口", body: translationBody }),
        ].join("");
        if (this.collapsible) {
            // Inside the sheet the account block reads as a plain section, not a card.
            this.container.querySelector('[data-block="account"]').classList.remove("panel");
        }
        this.authForm = this.container.querySelector(".auth-form");
        this.translationForm = this.container.querySelector(".translation-config-form");
        this.bind();
        this.renderAccount();
        window.addEventListener("jm-auth-change", () => this.renderAccount());
        return this;
    }

    bind() {
        this.authForm.addEventListener("submit", (event) => this.handleLogin(event));
        this.authForm.querySelector(".clear-config-btn").addEventListener("click", () => this.clearAccount());
        this.translationForm.addEventListener("submit", (event) => this.saveTranslation(event));
        this.translationForm.querySelector(".translation-config-test").addEventListener("click", () => this.testTranslation());
        this.translationForm.querySelector(".translation-config-clear").addEventListener("click", () => this.clearTranslation());
    }

    /** Refresh everything from the local service; call whenever the panel becomes visible. */
    load() {
        this.authForm.querySelector(".auth-error").textContent = "";
        this.authForm.elements.username.value = authSession.configuredUsername;
        this.authForm.elements.password.value = "";
        this.renderAccount();
        this.loadTranslation();
    }

    reveal(section) {
        const target = this.container.querySelector(`[data-block="${section}"]`);
        if (!target) return;
        if (target.tagName === "DETAILS") target.open = true;
        requestAnimationFrame(() => target.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }));
    }

    clearSecrets() {
        this.authForm.elements.password.value = "";
        this.translationForm.elements.api_key.value = "";
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
        } catch (error) {
            errorNode.textContent = error.message || "登录失败，请稍后重试";
        } finally {
            setBusy(submit, false);
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

    translationFormValue() {
        const form = this.translationForm;
        return {
            api_key: form.elements.api_key.value.trim(),
            base_url: form.elements.base_url.value.trim(),
            model: form.elements.model.value.trim(),
            use_ai_translation: form.elements.use_ai_translation.checked,
        };
    }

    async loadTranslation() {
        const form = this.translationForm;
        try {
            const config = await localRuntime.getTranslationConfig();
            form.elements.api_key.value = "";
            form.elements.base_url.value = config.base_url || "";
            form.elements.model.value = config.model || "";
            form.elements.use_ai_translation.checked = Boolean(config.use_ai_translation);
            this.setState(form, ".translation-config-state", config.configured
                ? `已配置 · ${config.api_key_masked || "API Key 已保存"}`
                : "尚未配置", config.configured ? "success" : "");
            form.querySelector(".translation-config-clear").hidden = !config.configured;
        } catch (error) {
            this.setState(form, ".translation-config-state", error.message || "翻译模型配置读取失败", "error");
        }
    }

    async saveTranslation(event) {
        event.preventDefault();
        const form = this.translationForm;
        const button = form.querySelector(".translation-config-save");
        setBusy(button, true);
        this.setState(form, ".translation-config-state", "正在保存…");
        try {
            await localRuntime.saveTranslationConfig(this.translationFormValue());
            await this.loadTranslation();
            showToast("翻译模型配置已保存", "success");
        } catch (error) {
            this.setState(form, ".translation-config-state", error.message || "翻译模型配置保存失败", "error");
        } finally {
            setBusy(button, false);
        }
    }

    async testTranslation() {
        const form = this.translationForm;
        const button = form.querySelector(".translation-config-test");
        setBusy(button, true);
        this.setState(form, ".translation-config-state", "正在连接模型…");
        try {
            const result = await localRuntime.testTranslationConfig(this.translationFormValue());
            this.setState(form, ".translation-config-state", `连接成功 · ${result.model || form.elements.model.value}`, "success");
            form.querySelector(".translation-config-clear").hidden = false;
            showToast("翻译模型连接成功", "success");
        } catch (error) {
            this.setState(form, ".translation-config-state", error.message || "翻译模型连接失败", "error");
        } finally {
            setBusy(button, false);
        }
    }

    async clearTranslation() {
        const form = this.translationForm;
        try {
            await localRuntime.clearTranslationConfig();
            form.reset();
            await this.loadTranslation();
            showToast("翻译模型配置已清除");
        } catch (error) {
            this.setState(form, ".translation-config-state", error.message || "翻译模型配置清除失败", "error");
        }
    }
}
