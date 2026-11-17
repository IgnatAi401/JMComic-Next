import { communityApi } from "../community/CommunityApi.js";
import { escapeHtml } from "./dom.js";
import { showToast } from "./toast.js";
import { Sheet } from "./overlay.js";

/*
 * Online history: a sheet with the current numbers and one line chart. The server cuts
 * days at midnight Beijing time, so every label here uses that zone as well.
 */
const RANGES = [["day", "24 小时"], ["week", "7 天"], ["month", "30 天"]];
const METRICS = [["average", "平均在线"], ["peak", "峰值"], ["visitors", "访客"]];
const ZONE = "Asia/Shanghai";
const HOUR = 3600;
const CHART_HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 24, left: 30 };

const parts = (t) => Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: ZONE, month: "numeric", day: "numeric", hour: "2-digit", hourCycle: "h23", weekday: "short",
}).formatToParts(new Date(t * 1000)).map(({ type, value }) => [type, value]));

const dayLabel = (p) => `${p.month}/${p.day}`;
const tipTime = (t, step) => {
    const p = parts(t);
    return step === HOUR ? `${dayLabel(p)} ${p.weekday} ${p.hour}:00–${p.hour}:59` : `${dayLabel(p)} ${p.weekday}`;
};
const number = (value) => (value == null ? "—" : String(Math.round(value * 10) / 10));

/** A round axis top with four integer steps. */
function axisMax(max) {
    const raw = Math.max(1, max / 4);
    const power = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * power).find((s) => s >= raw);
    return { top: Math.ceil(step) * 4, step: Math.ceil(step) };
}

/** Which buckets get an x-axis label: every 6 hours, every midnight, or every 5th day. */
function xTicks(points, range) {
    return points.map((point, index) => ({ point, index })).filter(({ point, index }) => {
        const p = parts(point.t);
        if (range === "day") return Number(p.hour) % 6 === 0;
        if (range === "week") return p.hour === "00";
        return (points.length - 1 - index) % 5 === 0;
    }).map(({ point, index }) => {
        const p = parts(point.t);
        return { index, label: range === "day" ? `${p.hour}:00` : dayLabel(p) };
    });
}

class OnlineStats {
    range = "day";
    metric = "average";
    data = null;
    cache = new Map();

    open(opener) {
        if (!this.sheet) {
            this.sheet = new Sheet({ name: "online-stats", title: "在线统计" });
            this.sheet.body.classList.add("online-stats");
            this.sheet.body.addEventListener("click", (event) => this.click(event));
            window.addEventListener("resize", () => { if (this.sheet.isOpen) this.drawChart(); });
        }
        this.sheet.open({ opener });
        this.load();
    }

    click(event) {
        const range = event.target.closest("[data-stats-range]")?.dataset.statsRange;
        const metric = event.target.closest("[data-stats-metric]")?.dataset.statsMetric;
        if (range && range !== this.range) { this.range = range; this.load(); }
        else if (metric && metric !== this.metric) { this.metric = metric; this.render(); }
        else if (event.target.closest("[data-stats-retry]")) this.load();
    }

    /**
     * Switching never blanks the sheet: a range seen before shows its last data at once,
     * a new one keeps the current chart dimmed until its data arrives. Either way the
     * data is fetched again in the background.
     */
    async load() {
        const ticket = (this.ticket = Symbol("load"));
        const range = this.range;
        const body = this.sheet.body;
        if (this.cache.has(range)) {
            this.data = this.cache.get(range);
            this.render();
        } else if (this.data) {
            body.querySelectorAll("[data-stats-range]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.statsRange === range)));
            body.classList.add("is-loading");
        } else {
            this.render("loading");
        }
        try {
            const data = await communityApi.stats(range);
            this.cache.set(range, data);
            if (ticket !== this.ticket) return;
            this.data = data;
            this.render();
        } catch (error) {
            if (ticket !== this.ticket) return;
            const message = error?.disabled ? "社区功能已关闭，可在设置中开启" : error?.message;
            if (this.data && this.cache.has(range)) showToast(message || "刷新失败", "warning");
            else { this.data = null; this.render("error", message); }
        } finally {
            if (ticket === this.ticket) body.classList.remove("is-loading");
        }
    }

    render(state = "ready", message = "") {
        const tabs = (items, current, attr, label, kind) => `<div class="${kind === "chip" ? "chip-row" : "segmented is-block"}" role="group" aria-label="${label}">${items.map(([key, text]) => `<button type="button"${kind === "chip" ? ' class="chip"' : ""} data-${attr}="${key}" aria-pressed="${key === current}">${text}</button>`).join("")}</div>`;
        const points = this.data?.points || [];
        const present = (key) => points.map((p) => p[key]).filter((v) => v != null);
        const peaks = present("peak");
        const averages = present("average");
        const tile = (label, value) => `<div class="stats-tile"><span>${label}</span><b class="num">${value}</b></div>`;
        let main;
        if (state === "loading") main = `<p class="stats-status">加载中…</p>`;
        else if (state === "error") main = `<p class="stats-status">${escapeHtml(message || "暂时无法连接服务器，请稍后再试")}<button class="btn btn-outline" type="button" data-stats-retry>重试</button></p>`;
        else main = `
            <div class="stats-tiles">
                ${tile("当前在线", number(this.data.online))}
                ${tile("今日访客", number(this.data.today))}
                ${tile("区间峰值", number(peaks.length ? Math.max(...peaks) : null))}
                ${tile("平均在线", number(averages.length ? averages.reduce((a, b) => a + b, 0) / averages.length : null))}
            </div>
            ${tabs(METRICS, this.metric, "stats-metric", "图表指标", "chip")}
            <div class="stats-chart" data-stats-chart></div>`;
        this.sheet.body.innerHTML = `${tabs(RANGES, this.range, "stats-range", "时间范围")}${main}`;
        if (state === "ready") this.drawChart();
    }

    drawChart() {
        const box = this.sheet.body.querySelector("[data-stats-chart]");
        if (!box || !this.data) return;
        const { points, step } = this.data;
        const key = this.metric;
        const values = points.map((p) => p[key]);
        if (values.every((v) => v == null)) {
            box.innerHTML = `<p class="stats-status">这段时间还没有数据</p>`;
            return;
        }
        const width = Math.max(240, box.clientWidth);
        const plotW = width - PAD.left - PAD.right;
        const plotH = CHART_HEIGHT - PAD.top - PAD.bottom;
        const { top, step: yStep } = axisMax(Math.max(...values.filter((v) => v != null)));
        const x = (i) => PAD.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
        const y = (v) => PAD.top + plotH - (v / top) * plotH;
        const base = PAD.top + plotH;

        // Runs of consecutive known values; a gap (server down, no data yet) breaks the line.
        const runs = [];
        values.forEach((v, i) => {
            if (v == null) return;
            const last = runs[runs.length - 1];
            if (last && last[last.length - 1] === i - 1) last.push(i);
            else runs.push([i]);
        });
        const line = (run) => run.map((i, n) => `${n ? "L" : "M"}${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`).join("");
        const area = runs.filter((r) => r.length > 1).map((r) => `${line(r)}L${x(r[r.length - 1]).toFixed(1)},${base}L${x(r[0]).toFixed(1)},${base}Z`).join("");
        const lines = runs.filter((r) => r.length > 1).map(line).join("");
        const dots = runs.filter((r) => r.length === 1).map(([i]) => `<circle cx="${x(i)}" cy="${y(values[i])}" r="3" class="stats-dot"/>`).join("");
        const grid = Array.from({ length: 5 }, (_, n) => n * yStep).map((v) => `<line x1="${PAD.left}" x2="${width - PAD.right}" y1="${y(v)}" y2="${y(v)}" class="stats-grid${v ? "" : " is-base"}"/><text x="${PAD.left - 8}" y="${y(v)}" class="stats-axis" text-anchor="end" dominant-baseline="middle">${v}</text>`).join("");
        const ticks = xTicks(points, this.range).map(({ index, label }) => `<text x="${x(index)}" y="${CHART_HEIGHT - 6}" class="stats-axis" text-anchor="middle">${label}</text>`).join("");
        const label = METRICS.find(([k]) => k === key)[1];
        box.innerHTML = `
            <svg viewBox="0 0 ${width} ${CHART_HEIGHT}" width="${width}" height="${CHART_HEIGHT}" role="img" aria-label="${label}走势">
                ${grid}${ticks}
                <path d="${area}" class="stats-area"/>
                <path d="${lines}" class="stats-line"/>
                ${dots}
                <line class="stats-cross" y1="${PAD.top}" y2="${base}" visibility="hidden"/>
                <circle class="stats-focus" r="4" visibility="hidden"/>
                <rect x="${PAD.left}" y="0" width="${plotW}" height="${CHART_HEIGHT}" fill="transparent" data-stats-hit/>
            </svg>
            <div class="stats-tip" hidden></div>`;

        const svg = box.querySelector("svg");
        const cross = svg.querySelector(".stats-cross");
        const focus = svg.querySelector(".stats-focus");
        const tip = box.querySelector(".stats-tip");
        const show = (event) => {
            const rect = svg.getBoundingClientRect();
            const px = (event.clientX - rect.left) * (width / rect.width);
            const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - PAD.left) / plotW) * (points.length - 1))));
            const p = points[i];
            cross.setAttribute("x1", x(i));
            cross.setAttribute("x2", x(i));
            cross.setAttribute("visibility", "visible");
            focus.setAttribute("visibility", values[i] == null ? "hidden" : "visible");
            if (values[i] != null) { focus.setAttribute("cx", x(i)); focus.setAttribute("cy", y(values[i])); }
            tip.innerHTML = `<strong>${tipTime(p.t, step)}</strong>${p.average == null && p.visitors == null ? "<span>无数据</span>" : METRICS.map(([k, text]) => `<span class="${k === key ? "is-current" : ""}">${text}<b class="num">${number(p[k])}</b></span>`).join("")}`;
            tip.hidden = false;
            const left = (x(i) / width) * rect.width;
            tip.style.left = `${Math.max(0, Math.min(rect.width - tip.offsetWidth, left - tip.offsetWidth / 2))}px`;
        };
        const hide = () => { cross.setAttribute("visibility", "hidden"); focus.setAttribute("visibility", "hidden"); tip.hidden = true; };
        const hit = svg.querySelector("[data-stats-hit]");
        hit.addEventListener("pointermove", show);
        hit.addEventListener("pointerdown", show);
        hit.addEventListener("pointerleave", (event) => { if (event.pointerType === "mouse") hide(); });
    }
}

const onlineStats = new OnlineStats();
export const openOnlineStats = (opener) => onlineStats.open(opener);
