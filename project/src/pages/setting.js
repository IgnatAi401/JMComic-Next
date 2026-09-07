import { jmApi } from "../api/JmcomicApi.js";
import { NavManager } from "../components/general/NavManager.js";
import { setting } from "../components/general/Setting.js";
import { SwitchServerBtnManager } from "../components/general/SwitchServerBtnManager.js";
import { renderPageError } from "../utils/PageError.js";

class SettingPage {
    navManager
    switchServerBtnManager
    constructor() {}
    async init() {
        setting.init()
        this.navManager=new NavManager()
        this.navManager.init()
        this.switchServerBtnManager=new SwitchServerBtnManager()
        this.switchServerBtnManager.init()
        await jmApi.init();
    }
}
const app = new SettingPage();
app.init().catch((error) => renderPageError(".setting-body", error, { title: "设置页面加载失败" }));
