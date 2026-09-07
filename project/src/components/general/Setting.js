import { localRuntime } from "../../local/LocalRuntime.js";
import { readLocalStorage, writeLocalStorage } from "../../utils/BrowserStorage.js";
import { installNavigationPolicy } from "../../utils/NavigationPolicy.js";

const normalizeBatchSize = (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 500) return null;
    return number;
};

class Setting {
    #settingValues = {
        using_imgserver_index: ["0", "1", "2", "3", "4", "5"],
    };

    #options = {
        using_imgserver_index: "0",
        image_load_batch_size: 5,
    };

    #settingsPromise = null;
    #settingsLoaded = false;

    init(force = false) {
        installNavigationPolicy();
        this.#loadBrowserOptions();
        return this.#loadFileSettings(force);
    }

    #loadBrowserOptions() {
        for (const key of Object.keys(this.#settingValues)) {
            const value = readLocalStorage(key);
            if (value === null) continue;
            if (this.#settingValues[key].includes(value)) {
                this.#options[key] = value;
            } else {
                writeLocalStorage(key, this.#options[key]);
            }
        }
    }

    async #loadFileSettings(force) {
        if (this.#settingsLoaded && !force) return this.#options;
        if (this.#settingsPromise && !force) return this.#settingsPromise;
        this.#settingsPromise = localRuntime.getSettings()
            .then((saved) => {
                const batchSize = normalizeBatchSize(saved?.image_load_batch_size);
                this.#options.image_load_batch_size = batchSize || 5;
                this.#settingsLoaded = true;
                this.#dispatchChange();
                return this.#options;
            })
            .catch(() => {
                this.#settingsLoaded = true;
                return this.#options;
            })
            .finally(() => {
                this.#settingsPromise = null;
            });
        return this.#settingsPromise;
    }

    setOption(key, value) {
        const values = this.#settingValues[key];
        const normalized = typeof value === "number" ? value.toString() : value;
        if (values?.includes(normalized)) {
            this.#options[key] = normalized;
            writeLocalStorage(key, normalized);
        }
    }

    async setImageLoadBatchSize(value) {
        const batchSize = normalizeBatchSize(value);
        if (batchSize == null) throw new Error("并发加载数量必须是 1 到 500 的整数");
        const saved = await localRuntime.saveSettings({ image_load_batch_size: batchSize });
        this.#options.image_load_batch_size = normalizeBatchSize(saved?.image_load_batch_size) || batchSize;
        this.#settingsLoaded = true;
        this.#dispatchChange();
        return this.#options.image_load_batch_size;
    }

    #dispatchChange() {
        window.dispatchEvent(new CustomEvent("jm-settings-change", {
            detail: { imageLoadBatchSize: this.#options.image_load_batch_size },
        }));
    }

    get using_imgserver_index() {
        return this.#options.using_imgserver_index;
    }

    get image_load_batch_size() {
        return this.#options.image_load_batch_size;
    }
}

export const setting = new Setting();
