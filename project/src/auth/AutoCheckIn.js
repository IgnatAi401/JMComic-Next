import { localRuntime } from "../local/LocalRuntime.js";
import { readLocalStorage, writeLocalStorage } from "../utils/BrowserStorage.js";

/* 签到由服务器完成（包括每天的自动签到）；页面只读取状态、切换开关和发起手动签到。 */
const SEEN_KEY = "jm_auto_checkin_seen";
const POLL_INTERVAL_MS = 1000;
const POLL_DEADLINE_MS = 90 * 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const autoCheckIn = {
    status() {
        return localRuntime.request("./local-api/checkin");
    },

    setEnabled(enabled) {
        return localRuntime.request("./local-api/checkin", { method: "POST", body: { enabled: Boolean(enabled) } });
    },

    /** Check in now on the server and wait for the result ({ status, message }). */
    async run() {
        let state = await localRuntime.request("./local-api/checkin", { method: "POST", body: { run: true } });
        const deadline = Date.now() + POLL_DEADLINE_MS;
        while (state.running) {
            if (Date.now() > deadline) throw new Error("签到仍在进行，请稍后查看结果");
            await wait(POLL_INTERVAL_MS);
            try {
                state = await this.status();
            } catch {
                /* 一次轮询失败（如隧道抖动）不影响服务器上的签到，继续等。 */
            }
        }
        const result = state.result;
        if (!result) throw new Error("签到结果未确认，请稍后重试");
        return result;
    },

    /** The server's automatic check-in result this browser has not shown yet, or null. */
    async unseenAutoResult() {
        const state = await this.status();
        const result = state?.result;
        if (!result?.auto || !result.at) return null;
        if (readLocalStorage(SEEN_KEY) === String(result.at)) return null;
        writeLocalStorage(SEEN_KEY, String(result.at));
        return result;
    },
};
