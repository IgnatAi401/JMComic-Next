import { jmApi } from "../api/JmcomicApi.js";
import { NavManager } from "../components/general/NavManager.js";
import { setting } from "../components/general/Setting.js";
import { SwitchServerBtnManager } from "../components/general/SwitchServerBtnManager.js";
import { LatestContainerManager } from "../components/latest/LatestContainerManager.js";
import { renderPageError } from "../utils/PageError.js";

class LatestPage {
    navManager
    latestContainerManager
    switchServerBtnManager
    constructor() {}
    async init() {
        setting.init()
        this.navManager=new NavManager()
        this.navManager.init()
        this.switchServerBtnManager=new SwitchServerBtnManager()
        this.switchServerBtnManager.init()
        await jmApi.init();
        this.latestContainerManager=new LatestContainerManager()
        this.latestContainerManager.init()
    }
}
const app = new LatestPage();
app.init().catch((error) => renderPageError(".latest-cr", error, { title: "最新内容加载失败" }));
