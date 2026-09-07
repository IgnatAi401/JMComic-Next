import { jmApi } from "../api/JmcomicApi.js";
import { CategoriesContainerManager } from "../components/categories/CategoriesContainerManager.js";
import { CategoriesHeadManager } from "../components/categories/CategoriesHeadManager.js";
import { NavManager } from "../components/general/NavManager.js";
import { setting } from "../components/general/Setting.js";
import { SwitchServerBtnManager } from "../components/general/SwitchServerBtnManager.js";
import { renderPageError } from "../utils/PageError.js";

class CategoriesPage {
    async init() {
        setting.init();
        new NavManager().init();
        new SwitchServerBtnManager().init();
        await jmApi.init();

        const container = new CategoriesContainerManager();
        const filters = new CategoriesHeadManager();
        filters.onFilterUpdate = (value) => {
            container.setFilters(value);
            container.research();
        };
        container.init();
        await filters.init();
    }
}

new CategoriesPage().init().catch((error) => renderPageError(".categories-body", error, { title: "分类加载失败" }));
