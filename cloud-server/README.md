---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: eeb8e68d7345f06ffd04e87f0c6ec173_bc27794acf5611f1b37d525400248c00
    ReservedCode1: 4hY1cmWQysKBbE/bQfXTTTbVthdtL7GZd4+t7OH1QQy7ujW2UsbmoXud5zUebvpuRDkjP36GNTdeEid5h2HrKG5rbtRz81if6x6D1rdijK44/Wt9mEEBtu17Yyde0gmYXpVTYktWCXPmelzVgLmbC+M1bQ9HhRTUutAj2aeU/8jGBgm2XwMoUVKrJK4=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: eeb8e68d7345f06ffd04e87f0c6ec173_bc27794acf5611f1b37d525400248c00
    ReservedCode2: 4hY1cmWQysKBbE/bQfXTTTbVthdtL7GZd4+t7OH1QQy7ujW2UsbmoXud5zUebvpuRDkjP36GNTdeEid5h2HrKG5rbtRz81if6x6D1rdijK44/Wt9mEEBtu17Yyde0gmYXpVTYktWCXPmelzVgLmbC+M1bQ9HhRTUutAj2aeU/8jGBgm2XwMoUVKrJK4=
---

# Quick Phrase AI 云存档服务器

本目录为 quick-phrase-ai 扩展的云存档服务端。提供账户注册、登录与存档上传/下载接口，支持两种部署方式：

1. **本机服务器**（默认，零依赖，纯 Node 原生 http，无需安装任何 npm 包）
2. **免费云（Cloudflare Workers + KV）**（可选切换，供多设备跨网使用）

---

## 一、本机服务器（默认推荐）

### 启动方式

- 双击 `start.bat`，或命令行执行：

```bash
node server.js
```

默认监听 `http://127.0.0.1:8787`。可用环境变量覆盖：

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 监听端口 | `8787` |
| `HOST` | 监听地址 | `127.0.0.1` |
| `ALLOW_ORIGINS` | CORS 白名单（逗号分隔），默认 `*` | `*` |

示例（自定义端口并收紧来源）：

```bash
set PORT=9000
set ALLOW_ORIGINS=http://localhost,http://127.0.0.1
node server.js
```

> 数据持久化到 `data/users.json`（用户名、盐、scrypt 哈希、token、存档 JSON），首次运行自动创建。重启服务后账户数据仍在；token 随重启保留（已落盘）。

### 接口说明

所有接口返回 JSON。`Authorization: Bearer <token>` 用于存档读写。

| 方法 | 路径 | 说明 | 请求体 | 成功返回 |
|---|---|---|---|---|
| GET | `/api/health` | 健康检查 | - | `{ ok, service, version, time }` |
| POST | `/api/register` | 注册 | `{ username, password }` | `{ ok, username, token }` |
| POST | `/api/login` | 登录 | `{ username, password }` | `{ ok, username, token }` |
| GET | `/api/save` | 获取存档 | -（Bearer token） | `{ ok, username, save }` |
| PUT | `/api/save` | 保存存档 | 存档 JSON（Bearer token，≤5MB） | `{ ok, username }` |

错误返回示例：`{ ok: false, error: "密码错误" }`。常见错误码：`400` 参数不合法、`401` 密码错误 / token 无效、`404` 用户不存在 / 接口不存在、`409` 用户名已存在、`413` 请求体过大。

### 快速自测

```bash
curl http://127.0.0.1:8787/api/health
curl -X POST http://127.0.0.1:8787/api/register -H "Content-Type: application/json" -d "{\"username\":\"demo\",\"password\":\"123456\"}"
curl -X POST http://127.0.0.1:8787/api/login -H "Content-Type: application/json" -d "{\"username\":\"demo\",\"password\":\"123456\"}"
curl -X PUT http://127.0.0.1:8787/api/save -H "Content-Type: application/json" -H "Authorization: Bearer <token>" -d "{\"phrases\":[]}"
curl http://127.0.0.1:8787/api/save -H "Authorization: Bearer <token>"
```

---

## 二、让多设备使用（内网 / 公网）

本机服务器仅适合本机浏览器扩展使用。若要在手机或其他电脑使用，两种方式：

### 方式 1：局域网 IP（需在同一 WiFi）

1. 修改启动方式，监听局域网地址：

```bash
set HOST=0.0.0.0
node server.js
```

2. 查看本机局域网 IP（`ipconfig`，形如 `192.168.x.x`）。
3. 扩展配置页「服务器地址」改为 `http://192.168.x.x:8787`。

> 注意：Windows 防火墙首次运行会弹窗询问，请允许「专用网络」访问；不同设备需可互通。

### 方式 2：内网穿透（外网可访问）

使用 frp / ngrok / cpolar 等将本机 8787 端口映射为公网地址，再把扩展「服务器地址」改为公网地址。此方案最简单，适合临时使用。

---

## 三、免费云部署（Cloudflare Workers，推荐长期多设备使用）

Cloudflare 提供免费 Workers 与 KV 额度，无需绑卡即可部署，适合长期多设备跨网同步。

### 部署步骤

1. 注册 [Cloudflare](https://dash.cloudflare.com) 账号（免费）。
2. 进入 **Workers & Pages** → **Create Worker** → 起个名字（如 `quick-phrase-cloud`）。
3. 粘贴 `cloudflare-worker.js` 全部内容，点击 **Deploy**。
4. 创建 KV 存储：**Workers & Pages → KV** → **Create namespace**，名字如 `CLOUD_SAVE`。
5. 回到 Worker → **Settings → Bindings → Add binding**：变量名 `CLOUD_SAVE`，选择刚创建的 KV namespace。
6. 重新 **Deploy**（让绑定生效）。
7. 得到访问地址 `https://quick-phrase-cloud.<你的子域>.workers.dev`。

### 使用方式

- 扩展配置页「服务器地址」改为 `https://quick-phrase-cloud.<你的子域>.workers.dev`。
- 注册 / 登录 / 上传 / 下载 / 自动同步均与本地服务器一致。
- 免费额度：每天 10 万次请求、KV 每天 10 万次读 / 1000 次写，个人扩展使用完全足够。

### Worker 与本地服务器差异

- Worker 使用 Web Crypto `SHA-256` 加盐哈希（Workers 无 scrypt）；本地服务器使用 scrypt。两者不互通，请二选一使用。
- Worker 数据存于 KV，天然多区域访问，重启不丢数据。

---

## 四、安全说明

- 密码始终以加盐哈希存储，服务器不保存明文。
- token 为随机串，具备访问权限即等于该用户；请勿泄露。
- 本机服务器默认允许任意来源访问（CORS `*`），仅监听 `127.0.0.1` 时风险可控；如改为 `0.0.0.0` 或部署公网，建议设置 `ALLOW_ORIGINS` 白名单或使用 Worker 模板。
*（内容由AI生成，仅供参考）*
