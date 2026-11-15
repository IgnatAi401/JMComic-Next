import { authorSubscriptions } from "../data/AuthorSubscriptions.js";
import { mountShell } from "../ui/shell.js";
import { comicCardHtml } from "../ui/comic-card.js";
import { hydrateCovers } from "../ui/covers.js";
import { hydrateRichCards } from "../ui/rich-cards.js";
import { stateHtml, renderPageError } from "../ui/states.js";
import { confirmAction } from "../ui/confirm.js";
import { showToast } from "../ui/toast.js";
import { escapeHtml, formatDateTime } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { checkResultMessage } from "../ui/subscriptions.js";
import { ActionMenu } from "../ui/action-menu.js";

/** 今天的时间只显示时分，手机工具栏放得下。 */
const shortTime = (time) => {
    const date = new Date(time);
    return date.toDateString() === new Date().toDateString()
        ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
        : formatDateTime(time);
};

class SubscriptionsPage {
    renderedUpdates = "";
    author = "";

    async init() {
        mountShell();
        this.status = document.querySelector(".subscription-status");
        this.grid = document.querySelector(".subscription-grid");
        this.filter = document.querySelector(".subscription-filter");
        this.checkButton = document.querySelector("[data-check-updates]");
        this.checkButton.innerHTML = icon("refresh");
        this.checkButton.addEventListener("click", () => this.check());
        this.menu = new ActionMenu();
        document.querySelector(".toolbar-actions").append(this.menu.root);
        this.filter.addEventListener("change", () => {
            this.author = this.filter.value;
            this.render();
        });
        this.grid.addEventListener("click", (event) => {
            const button = event.target.closest("[data-dismiss-update]");
            if (!button) return;
            authorSubscriptions.dismiss(button.dataset.dismissUpdate);
            showToast("已移出");
        });
        window.addEventListener("jm-subscriptions-change", () => this.render());
        this.render();
    }

    render() {
        this.renderFilters();
        this.renderStatus();
        this.renderUpdates();
    }

    /** 作者下拉框：全部，以及有待看新作的作者（附数量），和书架的收藏夹、评分筛选一致。 */
    renderFilters() {
        const updates = authorSubscriptions.updates;
        const counts = new Map();
        for (const item of updates) for (const name of item.sources) counts.set(name, (counts.get(name) || 0) + 1);
        if (this.author && !counts.has(this.author)) this.author = "";
        this.filter.hidden = counts.size < 2;
        const option = (value, label, count) => `<option value="${escapeHtml(value)}">${escapeHtml(label)} · ${count}</option>`;
        this.filter.innerHTML = option("", "全部作者", updates.length) + [...counts].map(([name, count]) => option(name, name, count)).join("");
        this.filter.value = this.author;
    }

    renderStatus() {
        const { authors, updates, lastRunAt } = authorSubscriptions.state;
        const progress = authorSubscriptions.progress;
        const running = authorSubscriptions.isRunning;
        this.checkButton.disabled = running || !authors.length;
        this.checkButton.classList.toggle("is-spinning", running);
        this.menu.setItems([
            { label: "管理订阅", icon: "sliders", onSelect: () => { location.href = "./setting.html#settings-subscriptions"; } },
            updates.length ? { label: "清空新作列表", icon: "trash", danger: true, onSelect: () => this.clear() } : null,
        ]);
        if (progress) this.status.textContent = `检查中 ${progress.index}/${progress.total} · ${progress.name}`;
        else if (!authors.length) this.status.textContent = "未订阅作者";
        else {
            // 下拉框选项里已有新作数量，这时只显示检查时间。
            const checked = lastRunAt ? `${shortTime(lastRunAt)} 检查` : "尚未检查";
            this.status.textContent = this.filter.hidden ? `${updates.length} 部新作 · ${checked}` : checked;
        }
    }

    renderUpdates() {
        const author = this.author;
        const updates = authorSubscriptions.updates.filter((item) => !author || item.sources.includes(author));
        // 只在列表真正变化时重绘，检查进度刷新时卡片不闪。
        const signature = updates.map((item) => `${item.id}:${item.sources.join(",")}:${item.via || ""}`).join("|") + `#${author}`;
        if (signature === this.renderedUpdates && this.grid.childElementCount) return;
        this.renderedUpdates = signature;
        if (!updates.length) {
            const hasAuthors = authorSubscriptions.authors.length;
            this.grid.innerHTML = stateHtml(hasAuthors
                ? { title: "暂无新作", message: "看过的作品会自动移出" }
                : { title: "还没有订阅作者", message: "在作品详情或搜索结果里订阅", action: { label: "管理订阅", href: "./setting.html#settings-subscriptions" } });
            return;
        }
        this.grid.innerHTML = updates.map((item) => comicCardHtml(item, {
            // 作者行已显示作者；只有标题匹配（作者字段对不上）时才注明来自哪位订阅作者。
            meta: `${formatDateTime(item.foundAt)} 发现${item.via === "title" ? ` · 标题匹配 ${item.sources.join("、")}` : ""}`,
            footer: `<button class="card-folder-move" type="button" data-dismiss-update="${escapeHtml(item.id)}">${icon("check")}<span>移出</span></button>`,
        })).join("");
        hydrateCovers(this.grid);
        hydrateRichCards(this.grid);
    }

    async check() {
        try {
            const result = await authorSubscriptions.checkAll();
            showToast(checkResultMessage(result), result.failed.length ? "warning" : result.added ? "success" : "default");
        } catch (error) {
            showToast(error.message || "检查失败", "warning");
        }
    }

    async clear() {
        const count = authorSubscriptions.updates.length;
        if (!await confirmAction({ title: "清空新作列表？", message: `移出 ${count} 部作品，订阅不受影响。`, label: "清空" })) return;
        authorSubscriptions.clearUpdates();
        showToast("已清空");
    }
}

new SubscriptionsPage().init().catch((error) => renderPageError(".subscription-grid", error, { title: "作者订阅加载失败" }));
