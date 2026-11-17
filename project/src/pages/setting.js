import { autoCheckIn } from "../auth/AutoCheckIn.js";
import { localRuntime } from "../local/LocalRuntime.js";
import { communityIdentity } from "../community/identity.js";
import { mountShell } from "../ui/shell.js";
import { showToast } from "../ui/toast.js";
import { mountReadingControls } from "../ui/reading-controls.js";
import { openOnlineStats } from "../ui/online-stats.js";
import { PreferenceEditor } from "../ui/preference-editor.js";
import { SubscriptionEditor } from "../ui/subscriptions.js";
import { AUTHOR_LEVELS, TAG_LEVELS, preferenceMaps } from "../ui/preferences.js";

mountShell();
mountReadingControls(document.querySelector("#settings-reading"));

const autoCheckInSwitch = document.querySelector("[data-auto-checkin]");
// 开关保存在服务器上，所有设备共用；读到之前先禁用，避免误操作。
autoCheckInSwitch.disabled = true;
autoCheckIn.status().then((state) => {
    autoCheckInSwitch.checked = state.enabled;
    autoCheckInSwitch.disabled = false;
}).catch((error) => showToast(`读取自动签到设置失败：${error.message}`, "warning"));
autoCheckInSwitch.addEventListener("change", () => {
    const wanted = autoCheckInSwitch.checked;
    autoCheckIn.setEnabled(wanted).catch((error) => {
        autoCheckInSwitch.checked = !wanted;
        showToast(`保存自动签到设置失败：${error.message}`, "warning");
    });
});

const communitySwitch = document.querySelector("[data-community-enabled]");
communitySwitch.disabled = true;
communityIdentity.get().then((state) => {
    communitySwitch.checked = state.enabled;
    communitySwitch.disabled = false;
}).catch((error) => showToast(`读取社区设置失败：${error.message}`, "warning"));
communitySwitch.addEventListener("change", () => {
    const wanted = communitySwitch.checked;
    communitySwitch.disabled = true;
    communityIdentity.setEnabled(wanted)
        .then(() => showToast(wanted ? "已开启社区功能" : "已关闭社区功能"))
        .catch((error) => {
            communitySwitch.checked = !wanted;
            showToast(`保存社区设置失败：${error.message}`, "warning");
        })
        .finally(() => { communitySwitch.disabled = false; });
});

const statsButton = document.querySelector("[data-open-online-stats]");
statsButton.addEventListener("click", () => openOnlineStats(statsButton));

const editors = [
    new PreferenceEditor(document.querySelector("#settings-tag-preferences"), { kind: "tag", levels: TAG_LEVELS, noun: "标签" }).mount(),
    new PreferenceEditor(document.querySelector("#settings-author-preferences"), { kind: "author", levels: AUTHOR_LEVELS, noun: "作者" }).mount(),
];
localRuntime.getPreferences().then((data) => {
    const { tags, authors } = preferenceMaps(data);
    editors[0].render(tags);
    editors[1].render(authors);
}).catch((error) => editors.forEach((editor) => editor.status(`偏好读取失败：${error.message}`)));

new SubscriptionEditor(document.querySelector("#settings-subscription-list")).mount();
// 从作者更新页的“在设置中管理”进来时滚到订阅区。
if (location.hash === "#settings-subscriptions") document.querySelector(location.hash)?.scrollIntoView({ block: "start" });
