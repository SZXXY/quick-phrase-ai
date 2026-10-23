# Quick Phrase AI

常用语管理 + AI 自动识别网页输入场景并推荐候选词，帮助用户快速输入常用短语。支持 Microsoft Edge / Chrome（Manifest V3）。

## 项目简介

Quick Phrase AI 是一款浏览器扩展（MV3）：你提前在扩展弹窗中维护一份「常用语」清单（可打标签），浏览网页时，只要聚焦输入框并开始输入，扩展就会自动识别当前输入场景，以浮层形式推荐最贴合的候选短语，点击即可一键填入。

推荐采用「本地优先 + AI 兜底」策略：

- 本地关键词匹配毫秒级返回，命中即显示，完全离线、不消耗 API；
- 本地无命中时才调用 AI 模型，结合输入框上下文与常用语清单生成推荐；
- 未配置 AI 或 AI 不可用时，自动兜底展示常用语，保证始终有候选可用。

## 功能特性

1. **本地优先匹配**：基于输入值、placeholder、aria-label、label、name/id、父级上下文文本分词打分，毫秒级返回候选，命中即显示，不依赖网络、不调用 AI。
2. **AI 智能推荐**：本地无命中时才请求 AI，等待期间浮层显示「AI 推荐中...」，避免「没反应」的错觉。
3. **智能兜底**：AI 未配置 / 请求失败 / 返回空候选时，自动降级展示常用语（有标签的优先、按创建时间倒序）；常用语列表为空时显示引导提示而非静默无反应。
4. **候选数量克制**：浮层最多展示 2 条候选（本地匹配与 AI 推荐均按相关度取前 2），避免遮挡页面内容。
5. **浮层可拖动并锁定位置**：按住浮层顶部标签即可拖动，松手后锁定到当前位置（不再跟随输入框），可避开输入框自带的选择菜单或页面元素；拖动范围限制在视口内。
6. **精准的输入场景识别**：仅检测通用文本输入（`input[type=text/search]`、无 type 的 input、`textarea`、`contenteditable`），自动排除带 `datalist` 的输入框（避免浮层遮挡其原生下拉菜单）以及无任何场景信号的输入框。
7. **Shadow DOM 渲染隔离**：候选浮层渲染在 Shadow DOM 中，页面样式不会污染浮层，浮层样式也不会影响页面。
8. **前端框架兼容**：点击候选以原生 setter 写入值并派发 `input` / `change` 事件，兼容 React、Vue 等现代前端框架的受控组件。
9. **数据本地持久化**：常用语与 AI 配置均存于 `chrome.storage.local`，弹窗保存后内容脚本实时同步，无需刷新页面。

## 安装方法

1. 打开 Edge 浏览器，地址栏访问 `edge://extensions`（Chrome 访问 `chrome://extensions`）。
2. 打开页面右上角的「开发人员模式」开关。
3. 点击「加载解压缩的扩展」，选择本项目文件夹 `quick-phrase-ai`。
4. 扩展加载成功后，工具栏出现 Quick Phrase AI 图标，即可开始使用。

> 修改代码后，需回到扩展管理页点击该扩展的「重新加载」按钮，再刷新已打开的网页，改动才会生效。

## 使用方法

1. 点击工具栏的 Quick Phrase AI 图标，在弹窗中添加常用语（支持填写标签，如「工作 / 回复 / 邮件」）；点击已有常用语可编辑或删除。按 `Ctrl + Enter` 可快速保存。
2. 浏览网页时聚焦任意输入框（输入框 / 搜索框 / 文本域 / 可编辑区域）并输入内容，浮层自动弹出候选词。
3. 点击候选词，内容即填入输入框；浮层同时关闭。
4. 浮层顶部标签可拖动，松手后位置被锁定；再次聚焦输入框后浮层在锁定位置展示。
5. 按 `Esc` 或点击页面其他区域即可关闭浮层。

## AI 配置

在扩展弹窗的「AI 配置」区完成以下配置：

| 配置项 | 说明 |
| --- | --- |
| Provider | 选择服务商：OpenAI / DeepSeek / Moonshot (Kimi) / 通义千问 / 自定义 |
| API Key | 对应服务商的 API Key（`sk-...`） |
| Model | 模型名，如 `gpt-4o-mini`、`deepseek-chat`、`moonshot-v1-8k` 等 |
| Base URL（可选） | API 根地址，默认 `https://api.openai.com/v1`；兼容三种写法：根地址、含 `/v1`、完整的 `/chat/completions` 地址 |

- 接口兼容 OpenAI Chat Completions 格式，OpenAI / DeepSeek / Moonshot / 通义千问等均适用。
- 点击「测试连接」可验证配置：成功显示「连接成功 · 延迟 xx ms · 模型 xxx」，失败显示具体错误（含超时、HTTP 状态码等提示）。测试每次读取最新保存的配置。
- **重要**：使用自定义 Base URL 时，对应域名必须同步加入 `manifest.json` 的 `host_permissions`（如 `"https://your-api.example.com/*"`），并在扩展页重新加载，否则 MV3 会拦截 Service Worker 的跨域请求。

## 项目结构

```
quick-phrase-ai/
├── manifest.json        # MV3 清单：权限、host_permissions、内容脚本与弹窗声明
├── background.js        # Service Worker：AI 请求转发、连通性测试、缓存管理
├── content.js           # 内容脚本：输入控件识别、场景信号采集、本地匹配、Shadow DOM 浮层
├── popup.html           # 扩展弹窗：常用语管理 + AI 配置界面
├── popup.js             # 弹窗逻辑：常用语增删改查、配置保存、测试连接
├── popup.css            # 弹窗样式
└── assets/
    ├── README.md        # 图标目录说明
    ├── icon16.png       # 16x16 图标
    ├── icon48.png       # 48x48 图标
    └── icon128.png      # 128x128 图标
```

## 技术要点

- **AI 请求经 Service Worker 转发**：内容脚本不直接 fetch AI API，而是通过 `chrome.runtime.sendMessage` 将场景上下文发给 background.js 处理，规避页面 CORS 限制；请求带 `AbortController` 8 秒超时，错误响应体截断读取。
- **chrome.storage.local 存储**：常用语（`phrases` 数组）与 AI 配置（`aiConfig` 对象）统一本地持久化；`PHRASES_UPDATED` 消息与 `storage.onChanged` 双通道保证内容脚本与后台缓存实时同步。
- **本地关键词匹配与兜底逻辑**：收集输入值 / placeholder / aria-label / label / name/id / 父级文本等信号分词打分（标签命中加权），`focusin` + 400ms 防抖触发；无信号不弹浮层，本地无命中才走 AI，AI 不可用再兜底常用语，三层保障始终有候选。
- **消息协议**：`AI_SUGGEST`（推荐）、`AI_TEST`（连通性测试）、`PHRASES_UPDATED`（缓存刷新），均基于 Promise 风格消息通道。
- **AI 输出容错解析**：对 AI 返回文本依次做去代码块围栏、截取 JSON 数组、`JSON.parse`、正则逐行提取四级解析，最终按相关度取前 2 条候选展示。
- **浮层生命周期**：Shadow DOM + `position:fixed` 视口坐标系渲染；`focusout` 延迟 200ms 关闭（避免点击候选误关），`Esc` / 点击外部（`composedPath` 穿透 Shadow DOM 判断）均可关闭；滚动、缩放自动重定位；拖拽后锁定手动位置不再跟随输入框。
- **安全填入**：候选点击通过原生 value setter + 派发 `input` / `change` 事件完成，兼容 React / Vue 受控组件，不依赖 `document.execCommand`。
