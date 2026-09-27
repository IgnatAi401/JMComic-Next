import { libraryStore } from "../data/LibraryStore.js";
import { setting } from "../core/Setting.js";
// This utility deliberately does not initialise the account shell or remote API.
setting.init();
const button = document.querySelector("[data-migrate]");
const status = document.querySelector("[data-migration-status]");
async function migrate() {
    button.disabled = true;
    status.textContent = "正在合并历史…";
    try {
        await libraryStore.init();
        document.querySelector("[data-reading-count]").textContent = libraryStore.getHistory().length;
        document.querySelector("[data-random-count]").textContent = libraryStore.getRandomHistory().length;
        status.textContent = "历史已合并，以上为服务端总数量。";
    } catch (error) { status.textContent = `迁移失败：${error.message}。旧记录仍保留，可点击重试。`; }
    finally { button.disabled = false; }
}
button.addEventListener("click", migrate);
migrate();
