export function renderPageError(selector, error, {
    title = "页面加载失败",
    className = "loading-icon",
    linkHref = "",
    linkLabel = "",
} = {}) {
    const root = document.querySelector(selector);
    if (!root) return;

    const card = document.createElement("div");
    card.className = className;
    const heading = document.createElement("strong");
    heading.textContent = title;
    const message = document.createElement("p");
    message.textContent = error?.message || "请稍后重试";
    card.append(heading, message);

    if (linkHref && linkLabel) {
        const link = document.createElement("a");
        link.className = "ghost-btn";
        link.href = linkHref;
        link.textContent = linkLabel;
        card.appendChild(link);
    }

    root.hidden = false;
    root.replaceChildren(card);
}
