import { jmApi } from "../api/JmcomicApi.js";
import { localRuntime } from "../local/LocalRuntime.js";

class AuthSession {
    user = null;
    configured = false;
    configuredUsername = "";
    configPromise = null;
    loginPromise = null;
    configLoaded = false;

    get isLoggedIn() { return Boolean(this.user?.uid); }
    get isConfigured() { return this.configured; }

    setProfile(profile, fallbackUsername = "") {
        this.user = profile?.uid ? {
            uid: String(profile.uid),
            username: profile.username || fallbackUsername,
            photo: profile.photo || "",
            levelName: profile.level_name || "会员",
        } : null;
        return this.user;
    }

    async loadLocalConfig(force = false) {
        if (this.configLoaded && !force) {
            return {
                configured: this.configured,
                username: this.configuredUsername,
                authenticated: this.isLoggedIn,
                user: this.user,
            };
        }
        if (this.configPromise && !force) return this.configPromise;
        this.configPromise = localRuntime.getAccountSummary().then((summary) => {
            this.configured = Boolean(summary?.configured);
            this.configuredUsername = String(summary?.username || "");
            this.setProfile(summary?.authenticated ? summary.user : null, this.configuredUsername);
            this.configLoaded = true;
            this.dispatchChange();
            return summary;
        }).catch((error) => {
            this.configured = false;
            this.configuredUsername = "";
            throw new Error(error.message || "请使用本地服务启动 WebUI");
        }).finally(() => {
            this.configPromise = null;
        });
        return this.configPromise;
    }

    async configure(username, password) {
        const cleanUsername = String(username || "").trim();
        const cleanPassword = String(password || "");
        if (!cleanUsername || !cleanPassword) throw new Error("账号和密码不能为空");

        await this.login(cleanUsername, cleanPassword);
        this.configured = true;
        this.configuredUsername = cleanUsername;
        this.configLoaded = true;
        this.dispatchChange();
        return this.user;
    }

    async login(username, password) {
        const profile = await jmApi.login(username, password);
        this.setProfile(profile, username);
        this.dispatchChange();
        return this.user;
    }

    async loginFromLocalConfig() {
        if (this.isLoggedIn) return this.user;
        if (this.loginPromise) return this.loginPromise;
        this.loginPromise = (async () => {
            if (!this.configured) await this.loadLocalConfig();
            if (!this.configured) throw new Error("请先在右上角配置账号和密码");
            const profile = await jmApi.ensureAuthenticated();
            this.configured = true;
            this.setProfile(profile, this.configuredUsername);
            this.dispatchChange();
            return this.user;
        })().finally(() => {
            this.loginPromise = null;
        });
        return this.loginPromise;
    }

    async clearLocalConfig() {
        await localRuntime.clearAccount();
        this.user = null;
        this.configured = false;
        this.configuredUsername = "";
        this.configLoaded = true;
        jmApi.clearAuthServer();
        this.dispatchChange();
    }

    dispatchChange() {
        window.dispatchEvent(new CustomEvent("jm-auth-change", {
            detail: {
                user: this.user,
                configured: this.configured,
                username: this.configuredUsername,
            },
        }));
    }
}

export const authSession = new AuthSession();
