import { readLocalStorage, writeLocalStorage } from "../utils/BrowserStorage.js";

const ENABLED_KEY = "jm_auto_checkin";
const DONE_KEY = "jm_auto_checkin_done";
const ATTEMPT_KEY = "jm_auto_checkin_attempt";
/* Skip auto check-in when another tab/page tried recently, so failures are not retried on every navigation. */
const RETRY_INTERVAL_MS = 10 * 60 * 1000;

/* JM 的签到日按 UTC+8 切换，与设备时区无关。 */
const checkInDay = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const accountKey = (username) => String(username || "").trim().toLowerCase();

const readDone = () => {
    try {
        return JSON.parse(readLocalStorage(DONE_KEY, "null")) || null;
    } catch {
        return null;
    }
};

export const autoCheckIn = {
    get enabled() {
        return readLocalStorage(ENABLED_KEY) !== "0";
    },

    setEnabled(enabled) {
        writeLocalStorage(ENABLED_KEY, enabled ? "1" : "0");
    },

    /** Whether the page should try an automatic check-in for this account now. */
    shouldRun(username) {
        if (!this.enabled || !accountKey(username)) return false;
        const done = readDone();
        if (done?.day === checkInDay() && done?.account === accountKey(username)) return false;
        const lastAttempt = Number(readLocalStorage(ATTEMPT_KEY, "0")) || 0;
        return Math.abs(Date.now() - lastAttempt) >= RETRY_INTERVAL_MS;
    },

    markAttempt() {
        writeLocalStorage(ATTEMPT_KEY, String(Date.now()));
    },

    /** Record that today's check-in is confirmed (succeeded or already done). */
    markDone(username) {
        writeLocalStorage(DONE_KEY, JSON.stringify({ day: checkInDay(), account: accountKey(username) }));
    },
};
