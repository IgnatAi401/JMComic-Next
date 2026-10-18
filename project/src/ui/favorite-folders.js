import { jmApi } from "../api/JmcomicApi.js";
import { Sheet } from "./overlay.js";
import { escapeHtml } from "./dom.js";
import { showToast } from "./toast.js";

/** The account's default folder; JM lists only named folders, so it is added here. */
export const DEFAULT_FOLDER = { id: "0", name: "默认收藏夹" };

const createFormHtml = (label) => `<form class="folder-create">
    <input class="input" name="name" maxlength="40" placeholder="新收藏夹名称" autocomplete="off" aria-label="新收藏夹名称">
    <button class="btn btn-outline" type="submit">${escapeHtml(label)}</button>
</form>`;

/** Submits the sheet's "新建" form; resolves to the new folder list, or null when nothing was created. */
const bindCreateForm = (form, onCreated) => {
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = form.elements.name;
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        const button = form.querySelector("button");
        button.disabled = input.disabled = true;
        try {
            await jmApi.createFavoriteFolder(name);
            const folders = await jmApi.getFavoriteFolders(true);
            showToast(`已新建收藏夹「${name}」`);
            onCreated(folders, folders.find((folder) => folder.name === name));
        } catch (error) {
            showToast(error.message || "新建收藏夹失败", "warning");
        } finally {
            button.disabled = input.disabled = false;
        }
    });
};

/**
 * Asks which folder an album goes into. Resolves to a folder id, "remove" when
 * `removable` and the user un-favourites, or null when the sheet is dismissed.
 */
export function pickFavoriteFolder({ title = "放入收藏夹", folders = [], currentId = "", removable = false } = {}) {
    return new Promise((resolve) => {
        let choice = null;
        const sheet = new Sheet({ title, onClose: () => {
            resolve(choice);
            setTimeout(() => sheet.root.remove(), 400);
        } });
        const render = (list) => {
            sheet.body.innerHTML = `<div class="chip-row folder-pick">${[DEFAULT_FOLDER, ...list].map((folder) =>
                `<button class="chip" type="button" data-folder="${escapeHtml(folder.id)}" aria-pressed="${folder.id === String(currentId)}">${escapeHtml(folder.name)}</button>`
            ).join("")}</div>${createFormHtml("新建")}${removable ? `<div class="page-actions confirm-actions"><button class="btn btn-danger" type="button" data-remove>取消收藏</button></div>` : ""}`;
            sheet.body.querySelectorAll("[data-folder]").forEach((button) => {
                button.onclick = () => { choice = button.dataset.folder; sheet.close(); };
            });
            const remove = sheet.body.querySelector("[data-remove]");
            if (remove) remove.onclick = () => { choice = "remove"; sheet.close(); };
            bindCreateForm(sheet.body.querySelector(".folder-create"), (next, created) => {
                if (created) { choice = created.id; sheet.close(); } else render(next);
            });
        };
        render(folders);
        sheet.open();
    });
}

/** Creates a folder from a small sheet; resolves to the new folder list, or null when cancelled. */
export function createFavoriteFolderSheet() {
    return new Promise((resolve) => {
        let result = null;
        const sheet = new Sheet({ title: "新建收藏夹", onClose: () => {
            resolve(result);
            setTimeout(() => sheet.root.remove(), 400);
        } });
        sheet.body.innerHTML = createFormHtml("创建");
        sheet.body.querySelector("input").dataset.autofocus = "";
        bindCreateForm(sheet.body.querySelector(".folder-create"), (folders) => { result = folders; sheet.close(); });
        sheet.open();
    });
}
