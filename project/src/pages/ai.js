import { mountShell } from "../ui/shell.js";
import { hydrateCovers, coverHtml } from "../ui/covers.js";
import { jmApi } from "../api/JmcomicApi.js";
import { isSingleChapterComic, keepSingleChapterComics } from "../utils/ComicChapterFilter.js";
import { RecommendationTask } from "../local/RecommendationTask.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { reconcileListingFilters } from "../utils/ListingFilters.js";
import { showToast } from "../ui/toast.js";
import { renderPageError } from "../ui/states.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
})[char]);
const asList = (value) => Array.isArray(value) ? value : (value ? [value] : []);

const PROFILE_STAT_LABELS = {
    evidence_count: "有效样本",
    rated_count: "总体评分",
    interaction_count: "行为记录",
    positive_count: "正向反馈",
    negative_count: "负向反馈",
    author_count: "作者样本",
    tag_count: "标签样本",
};

const finiteNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
};

const formatConfidence = (value) => {
    const number = finiteNumber(value);
    if (number !== null) {
        const percent = number <= 1 ? number * 100 : number;
        return `置信 ${Math.max(0, Math.min(100, Math.round(percent)))}%`;
    }
    return value ? `置信 ${String(value)}` : "";
};


class AiPage {
    async init() {
        mountShell();
        this.form = document.querySelector(".recommend-form");
        this.categories = [];
        this.task = new RecommendationTask({ runtime: localRuntime, api: jmApi,
            progress: text => { document.querySelector(".recommend-state").textContent = text; } });
        this.bindEvents();
        this.restoreRecommendationTask();
        await Promise.all([
            jmApi.init().catch(error => showToast(`漫画接口暂不可用：${error.message}`, "warning")),
            this.loadProfile(),
            this.loadHistory(),
            this.loadCategories().catch((error) => showToast(`分类暂时不可用：${error.message}`, "warning")),
            this.loadRecommendationStatus(),
        ]);
    }

    async restoreRecommendationTask() {
        if (this.generating) return;
        this.generating = true;
        document.querySelector(".generate-recommendations").disabled = true;
        try {
            if (await this.task.retry(() => this.task.restore())) {
                await this.generateRecommendations(true);
            }
        } catch (error) {
            document.querySelector(".recommend-state").textContent = `任务恢复失败：${error.message}；缓存保留，刷新可重试。`;
        } finally {
            this.generating = false;
            document.querySelector(".generate-recommendations").disabled = false;
        }
    }

    async loadRecommendationStatus() {
        const state = document.querySelector(".recommend-state");
        try {
            const config = await localRuntime.getAiConfig();
            if (this.generating || this.task.record) return;
            state.textContent = config.configured
                ? "内容证据增强已就绪 · 以7分为喜欢门槛"
                : "以7分为喜欢门槛 · 配置语言模型后可提取标题和评论证据";
        } catch (error) {
            if (!this.generating && !this.task.record) state.textContent = error.message;
        }
    }

    bindEvents() {
        document.querySelector(".cancel-recommendations").addEventListener("click", () => {
            this.stopRequested = true;
            if (this.taskActive) {
                try { this.task.cancel(); } catch (error) { showToast(error.message, "warning"); }
            }
            document.querySelector(".recommend-state").textContent = "正在停止；已发出的请求结束后不再继续，已缓存证据保留。";
        });
        document.querySelector(".generate-profile").addEventListener("click", () => this.generateProfile());
        this.form.addEventListener("submit", (event) => {
            event.preventDefault();
            this.generateRecommendations();
        });
        this.form.elements.category.addEventListener("change", () => this.renderSubcategories());
        this.form.elements.order.addEventListener("change", () => this.syncSelectCompatibility("order"));
        this.form.elements.time.addEventListener("change", () => this.syncSelectCompatibility("time"));
        this.form.elements.random_mode.addEventListener("change", () => this.syncRandomMode());
        this.form.elements.limit_all.addEventListener("change", (event) => {
            this.form.elements.limit.disabled = event.currentTarget.checked;
        });
        document.querySelector(".recommend-history").addEventListener("click", (event) => {
            const button = event.target.closest("[data-run]");
            if (!button) return;
            const run = this.history.find((item) => String(item.id) === button.dataset.run);
            if (run) this.renderResults(
                run.recommendations,
                `历史推荐 #${run.id}`,
                run.id,
                "recommendation_history",
            );
        });
        document.querySelector(".recommend-results").addEventListener("click", (event) => {
            const link = event.target.closest("[data-recommendation-open]");
            if (link) this.recordRecommendationOpen(link);
        });
        this.syncRandomMode();
    }

    syncRandomMode() {
        const enabled = this.form.elements.random_mode.checked;
        this.form.querySelectorAll("[data-recommend-filter]").forEach((label) => {
            const disabled = enabled && !label.hasAttribute("data-random-compatible");
            label.classList.toggle("filter-disabled", disabled);
            const control = label.querySelector("input, select");
            if (control) control.disabled = disabled;
        });
        this.form.elements.subcategory.disabled = enabled
            || !this.form.elements.subcategory.options.length
            || this.form.elements.subcategory.options.length === 1;
        const button = document.querySelector(".generate-recommendations");
        button.textContent = enabled ? "随机抽取并生成推荐" : "筛选并生成推荐";
        this.syncSelectCompatibility();
    }

    syncSelectCompatibility(changedFilter = "") {
        const filters = reconcileListingFilters({
            order: this.form.elements.order.value,
            time: this.form.elements.time.value,
        }, changedFilter);
        this.form.elements.order.value = filters.order;
        this.form.elements.time.value = filters.time;
        Array.from(this.form.elements.order.options).forEach((option) => {
            option.disabled = filters.time !== "a" && option.value !== "mv";
        });
        Array.from(this.form.elements.time.options).forEach((option) => {
            option.disabled = filters.order !== "mv" && option.value !== "a";
        });
    }

    async loadCategories() {
        const data = await jmApi.getCategories();
        this.categories = Array.isArray(data?.categories)
            ? data.categories.filter((item) => item?.type === "slug" && item.slug)
            : [];
        this.form.elements.category.innerHTML = '<option value="0">全部</option>' + this.categories.map((item) =>
            `<option value="${escapeHtml(item.slug)}">${escapeHtml(item.name)}</option>`
        ).join("");
        this.renderSubcategories();
    }

    renderSubcategories() {
        const selected = this.categories.find((item) => String(item.slug) === this.form.elements.category.value);
        const values = Array.isArray(selected?.sub_categories) ? selected.sub_categories : [];
        const select = this.form.elements.subcategory;
        select.disabled = this.form.elements.random_mode.checked || !values.length;
        select.innerHTML = '<option value="">全部</option>' + values.map((item) =>
            `<option value="${escapeHtml(item.CID || "")}" data-slug="${escapeHtml(item.slug || "")}">${escapeHtml(item.name)}</option>`
        ).join("");
    }

    async loadProfile() {
        try {
            const data = await localRuntime.getAiProfile();
            Object.entries(data.stats || {}).forEach(([key, value]) => {
                const target = document.querySelector(`[data-stat="${key}"]`);
                if (target) target.textContent = value;
            });
            this.profileStats = data.stats || {};
            this.profile = data.profile;
            this.renderProfile(data.profile);
        } catch (error) {
            document.querySelector(".profile-content").innerHTML = `<p>${escapeHtml(error.message || "偏好模型读取失败")}</p>`;
        }
    }

    renderProfile(saved) {
        const root = document.querySelector(".profile-content");
        const directProfile = saved && typeof saved === "object" ? saved : null;
        const profile = directProfile?.profile && typeof directProfile.profile === "object"
            ? directProfile.profile
            : directProfile;
        const hasStructuredPreference = profile && (
            profile.summary
            || profile.rating_summary
            || profile.tag_preferences
            || profile.preferred_tags
            || profile.preferred_authors
            || profile.stats
            || profile.structured_stats
        );
        if (!hasStructuredPreference) {
            const evidenceCount = Number(this.profileStats?.evidence) || 0;
            if (evidenceCount > 0) {
                root.innerHTML = `<h3>反馈已经生效</h3><p>排序器会实时读取现有的 ${escapeHtml(evidenceCount)} 本行为或评价证据；点击“重新计算偏好”可生成一份便于阅读的结构化摘要。</p>`;
                document.querySelector(".profile-state").textContent = `已有 ${evidenceCount} 本证据 · 实时排序已启用`;
            } else {
                root.innerHTML = "<h3>从你的反馈开始</h3><p>记录作品的 1–10 分总评后，系统会自动形成结构化偏好。现在也可以直接生成推荐，系统会先进行中性探索。</p>";
                document.querySelector(".profile-state").textContent = "暂无有效偏好证据";
            }
            return;
        }
        const list = (title, value, searchable = false) => {
            const items = asList(value).filter(Boolean);
            return items.length ? `<h3>${title}</h3><ul>${items.map((item) => {
                const text = String(item);
                return `<li>${searchable ? `<a href="./search.html?sq=${encodeURIComponent(text)}">${escapeHtml(text)}</a>` : escapeHtml(text)}</li>`;
            }).join("")}</ul>` : "";
        };
        const ratingSummary = profile.rating_summary && typeof profile.rating_summary === "object"
            ? profile.rating_summary
            : null;
        const ratingMean = finiteNumber(ratingSummary?.mean);
        const ratingCount = finiteNumber(ratingSummary?.sample_count);
        const ratingConfidence = formatConfidence(ratingSummary?.confidence);
        const ratingMarkup = ratingMean !== null
            ? `<h3>总评概况</h3><div class="profile-rating-summary"><span>平均总分</span><strong>${escapeHtml(`${ratingMean.toFixed(1)} / 10`)}</strong><small>${escapeHtml([ratingConfidence, ratingCount !== null ? `${ratingCount} 次评分` : ""].filter(Boolean).join(" · "))}</small></div>`
            : "";
        const structuredStats = profile.structured_stats || profile.stats || directProfile?.structured_stats;
        const statsEntries = structuredStats && typeof structuredStats === "object" && !Array.isArray(structuredStats)
            ? Object.entries(structuredStats).map(([key, raw]) => {
                const value = raw && typeof raw === "object"
                    ? raw.value ?? raw.count ?? raw.mean ?? raw.score
                    : raw;
                return [key, value];
            }).filter(([, value]) => ["string", "number"].includes(typeof value))
            : [];
        const statsMarkup = statsEntries.length
            ? `<section class="profile-detail-section"><h3>模型统计</h3><div class="profile-model-stats">${statsEntries.slice(0, 8).map(([key, value]) => `<span>${escapeHtml(PROFILE_STAT_LABELS[key] || humanizeKey(key))}<b>${escapeHtml(value)}</b></span>`).join("")}</div></section>`
            : "";
        const signals = asList(profile.tag_preferences).filter((item) => item && typeof item === "object");
        const signalMarkup = signals.length ? `<section class="profile-detail-section"><h3>标签结论</h3><div class="profile-signals">${signals.map((item) => {
            const weight = Number(item.weight) || 0;
            const confidence = Math.round((Number(item.confidence) || 0) * 100);
            const direction = item.constraint === "hard" && weight < 0
                ? "硬屏蔽"
                : (weight >= 0 ? "偏好" : "软回避");
            const source = item.source === "explicit"
                ? "用户明确"
                : (item.source === "review_explicit" ? "评语明确" : "跨作品推断");
            return `<a class="profile-signal ${weight >= 0 ? "positive" : "negative"}" href="./search.html?sq=${encodeURIComponent(item.tag)}"><strong>${escapeHtml(item.tag)}</strong><span>${escapeHtml(direction)} · ${weight > 0 ? "+" : ""}${weight.toFixed(2)}</span><small>${escapeHtml(source)} · 置信度 ${confidence}%</small></a>`;
        }).join("")}</div></section>` : `${list("偏好标签", profile.preferred_tags, true)}${list("回避倾向", profile.avoided_tags)}`;
        const summaryMarkup = profile.summary
            ? `<div class="profile-summary"><h3>偏好概述</h3><p>${escapeHtml(profile.summary)}</p></div>`
            : "";
        const guidanceMarkup = profile.recommendation_guidance
            ? `<h3>推荐指引</h3><p>${escapeHtml(profile.recommendation_guidance)}</p>`
            : "";
        const detailMarkup = `${statsMarkup}${signalMarkup}${list("证据不足的标签", profile.uncertain_tags)}${list("偏好作者", profile.preferred_authors, true)}${profile.rating_pattern ? `<h3>评分模式</h3><p>${escapeHtml(profile.rating_pattern)}</p>` : ""}${guidanceMarkup}`;
        const detailLabels = [
            signals.length ? `${signals.length} 个标签结论` : "",
            statsEntries.length ? `${Math.min(statsEntries.length, 8)} 项模型统计` : "",
            asList(profile.preferred_authors).length ? `${asList(profile.preferred_authors).length} 位偏好作者` : "",
        ].filter(Boolean);
        const details = detailMarkup
            ? `<details class="profile-details"><summary><span><b>完整偏好</b><small>${escapeHtml(detailLabels.join(" · ") || "查看模型依据与推荐指引")}</small></span><i aria-hidden="true"></i></summary><div class="profile-details-body">${detailMarkup}</div></details>`
            : "";
        root.innerHTML = `<div class="profile-overview">${summaryMarkup}${ratingMarkup}</div>${details}`;
        const metadata = [];
        const evidenceCount = finiteNumber(directProfile?.evidence_count ?? profile.evidence_count);
        if (evidenceCount !== null) metadata.push(`使用 ${evidenceCount} 条记录`);
        const generatedAt = finiteNumber(directProfile?.generated_at ?? profile.generated_at);
        if (generatedAt !== null) metadata.push(new Date(generatedAt * 1000).toLocaleString("zh-CN"));
        const model = directProfile?.model || profile.model;
        if (model) metadata.push(String(model));
        document.querySelector(".profile-state").textContent = metadata.join(" · ") || "结构化偏好已载入";
    }

    async generateProfile() {
        const button = document.querySelector(".generate-profile");
        const state = document.querySelector(".profile-state");
        button.disabled = true;
        state.textContent = "正在重新计算结构化偏好…";
        try {
            const result = await localRuntime.generateAiProfile();
            this.profile = result.profile;
            this.renderProfile(result.profile);
            await this.loadProfile();
            showToast("偏好模型已更新", "success");
        } catch (error) {
            state.textContent = error.message || "偏好计算失败";
        } finally {
            button.disabled = false;
        }
    }

    async collectCandidates(target, state) {
        if (this.form.elements.random_mode.checked) {
            return this.collectRandomCandidates(target, state);
        }
        const keyword = this.form.elements.keyword.value.trim();
        const category = this.form.elements.category.value;
        const subSelect = this.form.elements.subcategory;
        const subOption = subSelect.options[subSelect.selectedIndex];
        const subCid = subSelect.value;
        const subSlug = subOption?.dataset.slug || "";
        const order = this.form.elements.order.value;
        const time = this.form.elements.time.value;
        const hideSerial = this.form.elements.hide_serial.checked;
        const excluded = new Set(((await localRuntime.getDiscoveryExcludedIds()).ids || []).map(String));
        const candidates = [];
        const seen = new Set(excluded);
        for (let page = 1; page <= 30 && !this.stopRequested && candidates.length < target; page += 1) {
            state.textContent = `正在初筛第 ${page} 页 · 已收集 ${candidates.length} / ${target}`;
            const result = await jmApi.getFilteredComics(keyword, page, {
                order,
                time,
                category,
                mainTag: subCid || "0",
                subcategorySlug: subSlug,
            });
            const content = Array.isArray(result?.content) ? result.content : [];
            if (!content.length) break;
            const newItems = content.filter((item) => {
                const id = String(item?.id || "");
                if (!id || seen.has(id)) return false;
                seen.add(id);
                return true;
            });
            const visible = await keepSingleChapterComics(newItems, hideSerial);
            candidates.push(...visible.slice(0, target - candidates.length));
        }
        if (!candidates.length) throw new Error("当前条件下没有近期可推荐的候选漫画");
        state.textContent = `正在补齐 ${candidates.length} 本候选的作者和标签…`;
        const enriched = new Array(candidates.length);
        let cursor = 0;
        const worker = async () => {
            while (!this.stopRequested && cursor < candidates.length) {
                const index = cursor++;
                const item = candidates[index];
                try {
                    const album = await jmApi.getComicAlbum(item.id);
                    enriched[index] = {
                        id: String(album.id), title: album.name || item.name || "未命名作品",
                        authors: asList(album.author), tags: asList(album.tags),
                        description: typeof album.description === "string" ? album.description : "",
                        cover_url: jmApi.getCoverImageURL(album.id),
                    };
                } catch {
                    enriched[index] = {
                        id: String(item.id), title: item.name || "未命名作品",
                        authors: asList(item.author), tags: asList(item.tags),
                        cover_url: jmApi.getCoverImageURL(item.id),
                    };
                }
                state.textContent = `正在补齐候选资料 · ${enriched.filter(Boolean).length} / ${candidates.length}`;
            }
        };
        await Promise.all(Array.from({ length: Math.min(5, candidates.length) }, worker));
        return { candidates: enriched.filter(Boolean), keyword, filters: { category, subcategory: subCid, order, time, hide_serial: hideSerial, candidate_count: target } };
    }

    randomComicId() {
        const digits = Math.random() < 0.5 ? 6 : 7;
        const minimum = 10 ** (digits - 1);
        return String(minimum + Math.floor(Math.random() * minimum * 9));
    }

    async collectRandomCandidates(target, state) {
        const hideSerial = this.form.elements.hide_serial.checked;
        const excluded = new Set(((await localRuntime.getDiscoveryExcludedIds()).ids || []).map(String));
        const attempted = new Set(excluded);
        const candidates = [];
        const maxAttempts = Math.min(6000, Math.max(120, target * 12));
        let attempts = 0;
        let completed = 0;

        const worker = async () => {
            while (!this.stopRequested && candidates.length < target && attempts < maxAttempts) {
                let id = "";
                for (let retry = 0; retry < 20 && !id; retry += 1) {
                    const generated = this.randomComicId();
                    if (!attempted.has(generated)) id = generated;
                }
                if (!id) break;
                attempted.add(id);
                attempts += 1;
                try {
                    const album = await jmApi.getComicAlbum(id);
                    const validId = String(album?.id ?? "");
                    if (validId !== id || !String(album?.name || "").trim() || candidates.length >= target) continue;
                    if (hideSerial && !isSingleChapterComic(album)) continue;
                    candidates.push({
                        id,
                        title: album.name,
                        authors: asList(album.author),
                        tags: asList(album.tags),
                        cover_url: jmApi.getCoverImageURL(id),
                    });
                } catch {
                    // 不存在的随机编号会由接口拒绝；继续尝试下一个编号。
                } finally {
                    completed += 1;
                    state.textContent = `正在验证随机编号 · 已找到 ${candidates.length} / ${target} · 已检查 ${completed}`;
                }
            }
        };

        await Promise.all(Array.from({ length: Math.min(8, target) }, worker));
        if (!candidates.length) throw new Error("随机编号校验后没有找到近期可推荐的有效漫画，请稍后重试");
        if (candidates.length < target) {
            const condition = hideSerial ? "有效、近期可推荐且非连载的漫画" : "有效且近期可推荐的漫画";
            throw new Error(`已检查 ${completed} 个随机编号，仅找到 ${candidates.length} 本${condition}，请重试`);
        }
        return {
            candidates: candidates.slice(0, target),
            keyword: "",
            filters: { random_mode: true, hide_serial: hideSerial, candidate_count: target, checked_ids: completed },
        };
    }

    async generateRecommendations(resuming = false) {
        if (this.generating && !resuming) return;
        this.generating = true;
        this.stopRequested = false;
        const button = document.querySelector(".generate-recommendations");
        const state = document.querySelector(".recommend-state");
        const target = Math.min(300, Math.max(1, Number(this.form.elements.candidate_count.value) || 50));
        const controls = [...this.form.elements].map((control) => [control, control.disabled]);
        controls.forEach(([control]) => { control.disabled = true; });
        button.disabled = true;
        const cancel = document.querySelector(".cancel-recommendations");
        cancel.hidden = false;
        cancel.disabled = false;
        try {
            if (!resuming) {
                const previous = this.task.pending() || this.task.read();
                const previousJob = previous && !previous.payload
                    ? await this.task.retry(() => localRuntime.getRecommendationJob(previous.id)) : null;
                if (previous?.payload || (previousJob && !["success", "failed", "cancelled", "interrupted"].includes(previousJob.status))) {
                    this.task.record = previous;
                } else {
                    const collected = await this.collectCandidates(target, state);
                    if (this.stopRequested) return;
                    this.task.create({ ...collected,
                        budget: Math.min(500, Math.max(0, Number(this.form.elements.content_budget.value) || 0)),
                        limit: this.form.elements.limit_all.checked ? "all"
                            : Math.min(100, Math.max(1, Number(this.form.elements.limit.value) || 10)),
                    });
                }
            }
            this.taskActive = true;
            const job = await this.task.run();
            if (job.status !== "success") {
                state.textContent = job.error || "任务已停止，候选和已完成的证据保留。";
                return;
            }
            const result = job.result;
            const preparation = job;
            const blocked = Number(result.blocked_by_preferences) || 0;
            state.textContent = `完成 · 推荐 ${result.recommendations.length} 本 · 新增证据 ${preparation.prepared} 本${preparation.failed ? ` · 提取失败 ${preparation.failed} 本` : ""}${preparation.remaining ? ` · 尚有 ${preparation.remaining} 本待补充` : ""}${blocked ? ` · 屏蔽 ${blocked} 本` : ""}`;
            this.renderResults(result.recommendations, `本次推荐 #${result.id}`, result.id);
            await this.loadHistory();
            showToast("推荐已生成并留档", "success");
        } catch (error) {
            state.textContent = error.message || "推荐生成失败";
            await this.loadHistory().catch(() => {});
        } finally {
            if (this.stopRequested && !this.taskActive) state.textContent = "已停止初筛。";
            this.taskActive = false;
            cancel.hidden = true;
            this.generating = false;
            controls.forEach(([control, disabled]) => { control.disabled = disabled; });
            button.disabled = false;
        }
    }

    renderScoreBreakdown(breakdown) {
        const markup = breakdown.map(item => {
            const value = item.contribution;
            return `<div class="score-breakdown-item ${value >= 0 ? "positive" : "negative"}"><div><strong>${escapeHtml(item.label)}</strong><em>${value > 0 ? "+" : ""}${value.toFixed(2)}</em></div>${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}</div>`;
        }).join("");
        return `<details class="score-breakdown"><summary><span>评分依据</span><small>${breakdown.length} 项</small></summary><div>${markup}</div></details>`;
    }

    renderResults(items, label, runId = null, source = "recommendation_results") {
        const root = document.querySelector(".recommend-results");
        this.resultObserver?.disconnect();
        if (!items?.length) {
            root.innerHTML = `<div class="ai-empty">${escapeHtml(label || "本次没有符合当前偏好的推荐")}</div>`;
            return;
        }
        root.innerHTML = items.map((item, index) => {
            const score = finiteNumber(item.score);
            const metadata = [label, `#${index + 1}`];
            if (score !== null) metadata.push(`总推荐分 ${Number.isInteger(score) ? score : score.toFixed(1)}`);
            const reason = item.reason;
            return `<article class="ai-result-item" data-recommendation-card="${escapeHtml(item.id)}" data-run-id="${escapeHtml(runId ?? "")}" data-position="${index + 1}" data-recommendation-source="${escapeHtml(source)}">
            ${coverHtml(item, { href: `./chapter.html?id=${encodeURIComponent(item.id)}` }).replace('class="cover"', 'class="cover" data-recommendation-open')}
            <div class="ai-result-copy"><small>${escapeHtml(metadata.join(" · "))}</small><h3><a data-recommendation-open href="./chapter.html?id=${encodeURIComponent(item.id)}">${escapeHtml(item.title)}</a></h3><p>${escapeHtml(reason)}</p>${this.renderScoreBreakdown(item.score_breakdown)}${item.evidence.length ? `<details class="score-breakdown"><summary>内容证据 · ${item.evidence.length} 项</summary>${item.evidence.map(e => `<p><strong>${escapeHtml(e.label)}</strong>（${e.source === "user_review" ? "你的评语" : e.source.startsWith("comment:") ? "读者评论" : "作品资料"}）：${escapeHtml(e.quote)}</p>`).join("")}</details>` : ""}${asList(item.tags).length ? `<div class="ai-result-tags">${asList(item.tags).slice(0, 8).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}</div>
        </article>`;
        }).join("");
        hydrateCovers(root);
        this.observeResultImpressions();
        document.querySelector(".recommend-output").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    }

    observeResultImpressions() {
        if (!("IntersectionObserver" in window)) return;
        this.resultObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting || entry.intersectionRatio < 0.45) return;
                const card = entry.target;
                if (card.dataset.impressionRecorded === "true") return;
                card.dataset.impressionRecorded = "true";
                observer.unobserve(card);
                localRuntime.recordInteraction({
                    event_type: "recommendation_impression",
                    comic_id: card.dataset.recommendationCard,
                    run_id: card.dataset.runId || null,
                    source: card.dataset.recommendationSource || "recommendation_results",
                    position: Number(card.dataset.position) || null,
                    metadata: { position: Number(card.dataset.position) || null },
                });
            });
        }, { threshold: [0.45] });
        document.querySelectorAll("[data-recommendation-card]").forEach((card) => this.resultObserver.observe(card));
    }

    recordRecommendationOpen(link) {
        const card = link.closest("[data-recommendation-card]");
        if (!card) return;
        localRuntime.recordInteraction({
            event_type: "recommendation_open",
            comic_id: card.dataset.recommendationCard,
            run_id: card.dataset.runId || null,
            source: card.dataset.recommendationSource || "recommendation_results",
            position: Number(card.dataset.position) || null,
            metadata: { position: Number(card.dataset.position) || null },
        });
    }

    async loadHistory() {
        try {
            const data = await localRuntime.getRecommendationHistory();
            this.history = data.runs || [];
            const root = document.querySelector(".recommend-history");
            root.innerHTML = this.history.length ? this.history.map((run) => {
                const count = run.recommendations?.length || 0;
                return `<div class="history-run-group"><button class="history-run ${run.status}" data-run="${run.id}" type="button">#${run.id} · ${new Date(run.created_at * 1000).toLocaleString("zh-CN")} · ${run.status === "success" ? `${count} 本` : "失败"}</button></div>`;
            }).join("") : '<p class="ai-empty">还没有推荐记录。</p>';
        } catch (error) {
            document.querySelector(".recommend-history").innerHTML = `<p class="ai-empty">${escapeHtml(error.message || "历史读取失败")}</p>`;
        }
    }
}

new AiPage().init().catch((error) => renderPageError(".ai-page", error, { title: "AI 推荐页面加载失败" }));
