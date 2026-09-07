import { jmApi } from "../api/JmcomicApi.js";
import { authSession } from "../auth/AuthSession.js";
import { NavManager } from "../components/general/NavManager.js";
import { setting } from "../components/general/Setting.js";
import { SwitchServerBtnManager } from "../components/general/SwitchServerBtnManager.js";
import { showToast } from "../components/general/Toast.js";
import { renderPageError } from "../utils/PageError.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);

const plainText = (value) => {
    const template = document.createElement("template");
    template.innerHTML = String(value ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/div\s*>/gi, "\n");
    return (template.content.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
};

const asList = (value) => Array.isArray(value) ? value : [];
const isRead = (value) => value === true || value === 1 || value === "1" || value === "true";

export class MessagesPage {
    trackingPage = 1;
    trackingItems = [];
    trackingTotal = 0;
    requestVersion = 0;
    trackingRequest = null;
    accountKey = null;
    notificationsLoaded = false;
    trackingLoaded = false;

    async init() {
        setting.init();
        new NavManager().init();
        new SwitchServerBtnManager().init();
        this.status = document.querySelector(".message-status");
        this.notificationList = document.querySelector(".notification-list");
        this.trackingList = document.querySelector(".tracking-list");
        this.moreButton = document.querySelector(".tracking-more");
        this.bindEvents();
        await this.loadAll();
    }

    bindEvents() {
        document.querySelector(".refresh-messages").addEventListener("click", () => this.loadAll());
        this.moreButton.addEventListener("click", () => this.loadMoreTracking());
        this.notificationList.addEventListener("click", async (event) => {
            const item = event.target.closest(".notification-item.unread");
            if (!item?.dataset.id || item.dataset.saving === "true") return;
            item.dataset.saving = "true";
            try {
                await jmApi.markNotification(item.dataset.id, true);
                item.classList.remove("unread");
                window.dispatchEvent(new CustomEvent("jm-notification-change"));
            } catch (error) {
                showToast(error.message || "消息状态更新失败", "warning");
            } finally {
                delete item.dataset.saving;
            }
        });
        this.notificationList.addEventListener("keydown", (event) => {
            if ((event.key === "Enter" || event.key === " ") && event.target.matches(".notification-item")) {
                event.preventDefault();
                event.target.click();
            }
        });
        document.addEventListener("click", (event) => {
            if (event.target.closest(".message-login")) document.querySelector(".account-trigger")?.click();
        });
    }

    async loadAll() {
        const version = ++this.requestVersion;
        const refresh = document.querySelector(".refresh-messages");
        refresh.disabled = true;
        this.moreButton.disabled = true;
        this.status.textContent = "正在读取账号消息…";
        try {
            await authSession.loadLocalConfig();
            if (version !== this.requestVersion) return;
            if (!authSession.isConfigured) {
                this.renderConfigGate();
                return;
            }
            await jmApi.init();
            await authSession.loginFromLocalConfig();
            if (version !== this.requestVersion) return;
            const accountKey = String(authSession.user?.uid || authSession.configuredUsername || "");
            if (accountKey !== this.accountKey) {
                this.accountKey = accountKey;
                this.notificationList.replaceChildren();
                this.trackingList.replaceChildren();
                this.moreButton.hidden = true;
                this.resetTotals();
            }
            const results = await Promise.allSettled([
                this.loadNotifications(version), this.loadTracking(1, false, version),
            ]);
            if (version !== this.requestVersion) return;
            const failures = [];
            results.forEach((result, index) => {
                if (result.status !== "rejected") return;
                const label = index === 0 ? "通知" : "连载追踪";
                failures.push(`${label}：${result.reason?.message || "读取失败"}`);
                const container = index === 0 ? this.notificationList : this.trackingList;
                // Keep a previously loaded panel readable if only its refresh failed.
                if (!(index === 0 ? this.notificationsLoaded : this.trackingLoaded)) {
                    container.innerHTML = `<div class="message-empty"><p>${label}暂时无法读取，请点击刷新重试。</p></div>`;
                }
            });
            this.status.textContent = failures.length ? failures.join("；") : "消息与连载追踪已同步";
        } catch (error) {
            if (version !== this.requestVersion) return;
            this.status.textContent = error.message || "消息暂时无法读取";
            this.renderError();
        } finally {
            if (version === this.requestVersion) {
                refresh.disabled = false;
                this.moreButton.disabled = false;
            }
        }
    }

    async loadMoreTracking() {
        const version = this.requestVersion;
        if (this.moreButton.disabled || document.querySelector(".refresh-messages").disabled) return;
        try {
            await this.loadTracking(this.trackingPage + 1, true, version);
        } catch (error) {
            if (version !== this.requestVersion) return;
            this.status.textContent = error.message || "连载追踪加载失败，请重试";
            showToast(this.status.textContent, "warning");
        }
    }

    renderConfigGate() {
        const html = '<div class="message-empty"><p>配置账号密码后，才能读取通知和连载追踪。</p><button class="primary-btn message-login" type="button">配置账号</button></div>';
        this.notificationList.innerHTML = html;
        this.trackingList.innerHTML = html;
        this.status.textContent = "尚未配置账号";
        this.moreButton.hidden = true;
        this.resetTotals();
    }

    renderError() {
        const html = '<div class="message-empty"><p>暂时无法读取账号消息，请检查账号配置或网络连接。</p></div>';
        this.notificationList.innerHTML = html;
        this.trackingList.innerHTML = html;
        this.moreButton.hidden = true;
        this.resetTotals();
    }

    resetTotals() {
        this.notificationsLoaded = false;
        this.trackingLoaded = false;
        this.trackingPage = 1;
        this.trackingItems = [];
        this.trackingTotal = 0;
        document.querySelector(".notification-total").textContent = "0";
        document.querySelector(".tracking-total").textContent = "0";
    }

    async loadNotifications(version = this.requestVersion) {
        const raw = await jmApi.getNotifications();
        if (version !== this.requestVersion) return;
        this.notificationsLoaded = true;
        const list = Array.isArray(raw) ? raw : asList(raw?.list);
        document.querySelector(".notification-total").textContent = String(Number(raw?.total) || list.length);
        this.notificationList.innerHTML = list.length
            ? list.map((item) => this.notificationHtml(item)).join("")
            : '<div class="message-empty"><p>目前没有账号通知。</p></div>';
    }

    notificationHtml(item) {
        const unread = !isRead(item?.read);
        const content = this.notificationContent(item?.content);
        return `<article class="notification-item${unread ? " unread" : ""}" data-id="${escapeHtml(item?.id)}" role="button" tabindex="0"><i></i><span class="notification-copy"><strong>${escapeHtml(item?.title || "账号通知")}</strong><p>${content || "暂无详细内容"}</p></span><time>${escapeHtml(item?.date || item?.time || "")}</time></article>`;
    }

    notificationContent(value) {
        let parsed = value;
        if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
            try { parsed = JSON.parse(value); } catch { parsed = value; }
        }
        if (Array.isArray(parsed)) {
            return parsed.map((entry) => {
                if (!entry || typeof entry !== "object") return escapeHtml(plainText(entry));
                const id = entry.aid || entry.album_id || entry.id;
                const label = entry.name || entry.title || entry.content || `漫画 ${id || "更新"}`;
                return id
                    ? `<a href="./chapter.html?id=${encodeURIComponent(id)}">${escapeHtml(plainText(label))}</a>`
                    : escapeHtml(plainText(label));
            }).filter(Boolean).join(" · ");
        }
        if (parsed && typeof parsed === "object") return escapeHtml(plainText(parsed.content || parsed.name || parsed.title || JSON.stringify(parsed)));
        return escapeHtml(plainText(parsed));
    }

    async loadTracking(page, append, version = this.requestVersion) {
        if (this.trackingRequest?.version === version) return;
        const request = { version, page };
        this.trackingRequest = request;
        this.moreButton.disabled = true;
        try {
            const raw = await jmApi.getAlbumTrackingList(page);
            if (version !== this.requestVersion || this.trackingRequest !== request) return;
            this.trackingLoaded = true;
            const list = asList(raw?.item ?? raw?.list);
            this.trackingPage = page;
            this.trackingTotal = Math.max(Number(raw?.totalCnt ?? raw?.total) || 0, list.length);
            this.trackingItems = append ? [...this.trackingItems, ...list] : list;
            document.querySelector(".tracking-total").textContent = String(this.trackingTotal);
            this.trackingList.innerHTML = this.trackingItems.length
                ? this.trackingItems.map((item) => this.trackingHtml(item)).join("")
                : '<div class="message-empty"><p>还没有追踪连载。可在多章节漫画详情页开启追踪。</p></div>';
            this.moreButton.hidden = !list.length || this.trackingItems.length >= this.trackingTotal;
        } finally {
            if (this.trackingRequest === request) {
                this.trackingRequest = null;
                if (version === this.requestVersion) this.moreButton.disabled = false;
            }
        }
    }

    trackingHtml(item) {
        const timestamp = Number(item?.update_at ?? item?.updateAt);
        const updated = timestamp ? new Date(timestamp * 1000).toLocaleString("zh-CN") : "更新时间未知";
        return `<a class="tracking-item" href="./chapter.html?id=${encodeURIComponent(item?.id)}"><span class="tracking-cover"><img loading="lazy" src="${jmApi.getCoverImageURL(item?.id)}" alt="" /></span><span class="tracking-copy"><strong>${escapeHtml(item?.name || `漫画 ${item?.id}`)}</strong><small>最近更新 · ${escapeHtml(updated)}</small></span></a>`;
    }
}

new MessagesPage().init().catch((error) => {
    const status = document.querySelector(".message-status");
    if (status) status.textContent = "消息页面加载失败";
    renderPageError(".notification-list", error, { title: "通知加载失败" });
    renderPageError(".tracking-list", error, { title: "连载追踪加载失败" });
});
