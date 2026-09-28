import { jmApi } from "../api/JmcomicApi.js";
import { mountShell } from "../ui/shell.js";
import { mountReadingControls } from "../ui/reading-controls.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { escapeHtml } from "../ui/dom.js";
mountShell();
mountReadingControls(document.querySelector("#settings-reading"));

const updateButton = document.querySelector("[data-update-content-analysis]");
const summaryStatus = document.querySelector("[data-analysis-status]");
const summaryList = document.querySelector("[data-analysis-list]");
let timer, revision = 0, stopped = false;
const labels = { ready: "已完成", queued: "排队中", running: "生成中", error: "失败待重试", missing: "未生成", stale: "待更新", unconfigured: "未配置模型" };

function render(data) {
    const c = data.counts;
    summaryStatus.textContent = `${data.configured ? "" : "请先配置语言模型。"}已完成 ${c.ready} · 排队 ${c.queued} · 生成中 ${c.running} · 失败 ${c.error} · 待补全 ${c.missing + c.stale + c.unconfigured}`;
    // Preserve opened summaries while polling replaces updated result text.
    const opened = new Set([...summaryList.querySelectorAll("details[open]")].map(node => node.dataset.comicId));
    const pendingItems = data.items.filter(item => item.status !== "ready");
    summaryList.innerHTML = pendingItems.length ? pendingItems.map(item => `<details class="disclosure" data-comic-id="${escapeHtml(item.id)}" ${opened.has(item.id) ? "open" : ""}><summary>${escapeHtml(item.title || item.id)} · ${item.rating}分 · ${labels[item.status] || "待更新"}</summary><a href="./chapter.html?id=${encodeURIComponent(item.id)}">打开作品与评价</a><p>${escapeHtml(item.error || "")}</p><div style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(item.text ? `${item.current ? "" : "上次分析（待更新）：\n"}${item.text}` : "尚无分析")}</div></details>`).join("") : "<p>没有待处理的已评分作品。</p>";
    if (c.queued + c.running > 0 && !stopped) timer = setTimeout(() => refresh(), 2000);
}

async function refresh(update = false) {
    clearTimeout(timer);
    const token = ++revision;
    if (update) { updateButton.disabled = true; summaryStatus.textContent = "正在查找未完成或评价已变更的作品…"; }
    try {
        if (update) { await jmApi.init(); await localRuntime.writeCache("bootstrap", "servers", jmApi.servers); }
        const data = await (update ? localRuntime.updateContentAnalysis() : localRuntime.getContentAnalysis());
        if (token === revision && !stopped) render(data);
    } catch (error) { if (token === revision) summaryStatus.textContent = `读取或更新失败：${error.message}`; }
    finally { if (update) updateButton.disabled = false; }
}
updateButton.addEventListener("click", () => refresh(true));
window.addEventListener("pagehide", () => { stopped = true; revision++; clearTimeout(timer); });
window.addEventListener("pageshow", () => { stopped = false; refresh(); });
refresh();
