---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: eeb8e68d7345f06ffd04e87f0c6ec173_5abcaa76cef511f1a443525400393706
    ReservedCode1: 1/Hf6i8CW3PhFl9B37LSC59P//wtu21AydXdK0rON/la3Amt8dv7hkr0i7IYL6tmO4utROljf3MkPKHJeBnPDk/Lqnlco0fc6EsIHrgOQ4CUPmWWoF/kmg+lELD+ONA2/0G/bj2R50IxlAIuH1MdqjcX8Tzx2Caof1WJ1pGRN3svjYK8Z66pOZ+k1gs=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: eeb8e68d7345f06ffd04e87f0c6ec173_5abcaa76cef511f1a443525400393706
    ReservedCode2: 1/Hf6i8CW3PhFl9B37LSC59P//wtu21AydXdK0rON/la3Amt8dv7hkr0i7IYL6tmO4utROljf3MkPKHJeBnPDk/Lqnlco0fc6EsIHrgOQ4CUPmWWoF/kmg+lELD+ONA2/0G/bj2R50IxlAIuH1MdqjcX8Tzx2Caof1WJ1pGRN3svjYK8Z66pOZ+k1gs=
---

# assets 目录说明

存放扩展图标资源，包括三个尺寸的 PNG 图标：

- `icon16.png` — 工具栏/地址栏小图标（16x16）
- `icon48.png` — 扩展管理页图标（48x48）
- `icon128.png` — 应用商店/安装图标（128x128）

图标为程序化生成的蓝色圆角方块（Quick Phrase AI 品牌色 #2563eb）。

如需更换图标，请替换同名文件并保持尺寸一致，然后到
`edge://extensions` 点击扩展的「重新加载」即可生效。

> 提示：修改 `manifest.json` 中的 `host_permissions` 时，若使用自定义 AI
> baseUrl 域名，必须同步把对应域名加入 host_permissions，否则 MV3 会拦截
> Service Worker 的跨域 fetch 请求。
*（内容由AI生成，仅供参考）*
