import { localRuntime } from "../local/LocalRuntime.js";
import { mountShell } from "../ui/shell.js";
import { mountReadingControls } from "../ui/reading-controls.js";
import { PreferenceEditor } from "../ui/preference-editor.js";
import { AUTHOR_LEVELS, TAG_LEVELS, preferenceMaps } from "../ui/preferences.js";

mountShell();
mountReadingControls(document.querySelector("#settings-reading"));

const editors = [
    new PreferenceEditor(document.querySelector("#settings-tag-preferences"), { kind: "tag", levels: TAG_LEVELS, noun: "标签" }).mount(),
    new PreferenceEditor(document.querySelector("#settings-author-preferences"), { kind: "author", levels: AUTHOR_LEVELS, noun: "作者" }).mount(),
];
localRuntime.getPreferences().then((data) => {
    const { tags, authors } = preferenceMaps(data);
    editors[0].render(tags);
    editors[1].render(authors);
}).catch((error) => editors.forEach((editor) => editor.status(`偏好读取失败：${error.message}`)));
