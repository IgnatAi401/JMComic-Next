# JMComic Next

为 JMComic 打造更清爽的网页体验，融入本地评分、标签与作者偏好管理。

## 功能

- **清爽的 WebUI**：重新设计首页、分类、搜索、详情与阅读页面，适配桌面和移动端，优先适配 Safari。
- **连续阅读**：浏览器直连图源，按需加载附近页面，失败自动换线。
- **评分与偏好**：1–10 分总评；标签与作者偏好会在卡片和详情页着色，只着色不过滤。
- **书架**：最近阅读、随机历史、稍后再看、我的评分、账号收藏与最近搜索。
- **账号功能**：收藏、消息、追踪与手动签到。
- **AI 标题翻译（可选）**：接入任意 OpenAI 兼容接口。

## 运行

需要 Python 3.10+，以及系统中可用的 `openssl` 命令。无需安装任何第三方依赖。在项目根目录运行：

```bash
python3 local_server.py
```

或使用 uv：

```bash
uv run --locked python local_server.py
```

浏览器打开 `http://127.0.0.1:8000/`，按 `Ctrl+C` 停止。端口被占用时加 `--port 8001`。

## 使用说明

- **账号**：在侧栏（手机为顶部菜单）的账号入口登录，配置保存在 `project/data/account.json`（明文密码，仅限自己的电脑使用）。
- **AI 翻译**：在“设置 → AI 标题翻译”填写 API Key、Base URL（如 `https://example.com/v1`）和模型名称。会把标题发送给该服务，可能产生费用。
- **偏好**：在“设置”页编辑标签（喜欢/较喜欢/软回避/不喜欢）与作者（喜欢/不喜欢）。

## 数据与隐私

- 服务默认只监听本机 `127.0.0.1`，请不要改成局域网或公网地址。
- 账号、API Key、评分、偏好和历史都保存在 `project/data/`，接口缓存在 `project/.runtime-cache/`，两者都不随源码发布。
- 缓存会自动限制大小并清理，可随时删除 `project/.runtime-cache/`。
- 迁移电脑时，停止服务后复制整个 `project/data/` 即可。

## 开发测试

```bash
uv run --locked python -m unittest discover -q
node --experimental-vm-modules --test test_reader_runtime.mjs test_library_runtime.mjs tests/frontend_ui.test.mjs
```

Node.js 需 22+。界面调试可启动虚构数据服务 `uv run --locked python tests/serve_ui_fixture.py`，访问 `http://127.0.0.1:48128/`，它不读取真实数据、不访问外部接口。

## 致谢

本项目基于 [hect0x7/JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python) 的接口方案开发，感谢上游项目及其贡献者。
