import { jmApi } from "../api/JmcomicApi.js";
import { NavManager } from "../components/general/NavManager.js";
import { setting } from "../components/general/Setting.js";
import { SwitchServerBtnManager } from "../components/general/SwitchServerBtnManager.js";
import { SearchContainerManager } from "../components/search/SearchContainerManager.js";
import { renderPageError } from "../utils/PageError.js";

class SearchPage {
    navManager
    searchContainerManager
    searchQuery
    switchServerBtnManager
    constructor() {}
    async init() {
        const sq = new URLSearchParams(location.search).get("sq");
        if (typeof sq !== "string" || sq.trim()==="")
            throw new Error("搜索关键词无效");

        this.searchQuery = sq;
        setting.init()
        this.navManager=new NavManager()
        this.navManager.init()
        this.switchServerBtnManager=new SwitchServerBtnManager()
        this.switchServerBtnManager.init()
        await jmApi.init();
        const searchContainerManager=new SearchContainerManager(this.searchQuery)
        await searchContainerManager.init()
    }
}
const app = new SearchPage();
app.init().catch((error) => renderPageError(".search-cr", error, { title: "搜索加载失败" }));
