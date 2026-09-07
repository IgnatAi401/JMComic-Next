import { jmApi } from "../api/JmcomicApi.js";
import { BannerManager } from "../components/index/BannerManager.js";
import { NavManager } from "../components/general/NavManager.js";
import { RecommendationsManager } from "../components/index/RecommendationsManager.js";
import { TagContainerManager } from "../components/index/TagContainerManager.js";
import { setting } from "../components/general/Setting.js";
import { SwitchServerBtnManager } from "../components/general/SwitchServerBtnManager.js";
import { renderPageError } from "../utils/PageError.js";

class MainPage {
    navManager;
    switchServerBtnManager;
    bannerManager;
    tagContainerManager;
    recommendationsManager;
    /**
     * 初始化方法，用于初始化页面所有组件
     * 此方法按顺序初始化设置、API以及各个UI管理器
     */
    async init() {
        // 初始化全局设置
        setting.init();

        // 创建导航栏管理器实例
        this.navManager = new NavManager();

        // 创建切换服务器按钮管理器实例
        this.switchServerBtnManager = new SwitchServerBtnManager();

        // 创建横幅管理器实例（处理页面顶部轮播图或横幅内容）
        this.bannerManager = new BannerManager();

        // 创建标签容器管理器实例（处理页面标签展示）
        this.tagContainerManager = new TagContainerManager();

        // 创建推荐内容管理器实例（处理首页推荐内容展示）
        this.recommendationsManager = new RecommendationsManager();

        // 初始化导航栏管理器
        this.navManager.init();

        // 初始化切换服务器按钮管理器
        this.switchServerBtnManager.init();

        // 初始化禁漫天堂API
        await jmApi.init();

        // 初始化标签容器管理器
        this.tagContainerManager.init();

        // 随机漫画验证与书架数据互不依赖，并行加载以缩短首屏等待。
        await Promise.all([
            this.bannerManager.init(),
            this.recommendationsManager.init(),
        ]);
    }
}
const app = new MainPage();
app.init().catch((error) => renderPageError(".home-main", error, { title: "首页加载失败" }));
