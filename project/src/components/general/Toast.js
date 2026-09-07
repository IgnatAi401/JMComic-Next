export function showToast(message, tone = "default") {
    let region = document.querySelector(".toast-region");
    if (!region) {
        region = document.createElement("div");
        region.className = "toast-region";
        region.setAttribute("aria-live", "polite");
        document.body.appendChild(region);
    }
    const toast = document.createElement("div");
    toast.className = `toast ${tone}`;
    toast.textContent = message;
    region.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
        toast.classList.remove("show");
        // Safari can skip transitionend in background tabs or with reduced motion.
        const fallback = setTimeout(() => toast.remove(), 400);
        toast.addEventListener("transitionend", (event) => {
            if (event.target !== toast) return;
            clearTimeout(fallback);
            toast.remove();
        });
    }, 3200);
}
