import { localRuntime } from "../local/LocalRuntime.js";

/**
 * The anonymous community ID and the on/off switch live in project/data on the server
 * (`/local-api/community`), so every device of this deployment shares them.
 * JMComic-Web keeps its own version of this file that stores them in the browser.
 */
class CommunityIdentity {
    #pending = null;

    get() {
        this.#pending ||= localRuntime.request("./local-api/community")
            .then((data) => ({ clientId: String(data.client_id), enabled: data.enabled !== false }))
            .catch((error) => { this.#pending = null; throw error; });
        return this.#pending;
    }

    async setEnabled(enabled) {
        const data = await localRuntime.request("./local-api/community", { method: "POST", body: { enabled: Boolean(enabled) } });
        const state = { clientId: String(data.client_id), enabled: data.enabled !== false };
        this.#pending = Promise.resolve(state);
        window.dispatchEvent(new CustomEvent("jm-community-change", { detail: state }));
        return state;
    }
}

export const communityIdentity = new CommunityIdentity();
