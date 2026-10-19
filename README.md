# SlimGPT

SlimGPT 是一个浏览器扩展：在你自己已登录的 chatgpt.com 页面上覆盖一层轻量界面——会话列表 + 单列消息流 + 输入框。官方页面仍是宿主，负责登录、发送和流式生成；SlimGPT 只**旁听**官方的两类数据并重新渲染，不改写任何官方请求或响应。

非官方社区项目，与 OpenAI 无关，也未获其认可。

## 构建目标

| 浏览器 | 输出目录 | 发布包 |
|---|---|---|
| Chrome / Chromium（MV3） | `dist-extension/` | `release/slimgpt-chrome-<版本>.zip` |
| Firefox 桌面 + Firefox Android（MV3，≥ 142） | `dist-firefox/` | `release/slimgpt-firefox-<版本>.xpi` |
| Orion（macOS / iOS / iPadOS） | `dist-orion/` | `release/slimgpt-orion-<版本>.zip` |

权限只有 `storage`，host 只有 `https://chatgpt.com/*`。没有 background、没有 `chrome.debugger`，不读 cookie。

## 安装

- Chrome：`chrome://extensions` → 开发者模式 → “加载已解压的扩展程序” → 选 `dist-extension/`。
- Firefox：`about:debugging#/runtime/this-firefox` → “临时载入附加组件” → 选 `dist-firefox/manifest.json`（正式安装需 Mozilla 签名）。
- Orion：在扩展管理里导入 `release/slimgpt-orion-<版本>.zip`。Orion 的 WebExtension 兼容层最不确定，请在目标设备上实测。

登录 ChatGPT 后使用完整功能（服务器历史、分支、继续生成）；不登录也能用官方的免费模式（见下）。登录页、Cloudflare 校验、Cookie 同意框等没有可用输入框或有官方弹窗的页面上，SlimGPT 会自动让开，保证官方页面可操作。右下角 “SlimGPT” 按钮可从官方界面切回。

## 架构

```
chatgpt.com 页面
├─ isolated-bridge.js  (ISOLATED world, src/page/bridge.js)
│    挂载全屏 iframe；代理 storage（精确 origin 校验）；Orion 上注入页面钩子
├─ main-hook.js        (MAIN world, src/page/hook.js)
│    fetch 旁听：只匹配 5 个官方端点，response.clone() 后原样转发正文
│      POST /backend-api/(f/)conversation[/resume]  → SSE 流
│      GET  /backend-api/conversation/<uuid>         → 完整历史
│      GET  /backend-api/conversations               → 会话列表
│      POST /unauth-mweb/conversation/updates        → 免费模式 NDJSON 流
│    自行拉取历史（分页、合并、退避）；按 UI 指令驱动官方输入框
│    （发送 / 停止 / 继续生成 / 切换分支 / 推理强度）
└─ iframe: index.html  (扩展页面, src/ui)
     Svelte 5 + Framework7 9 界面；所有解析只在这里通过 src/protocol 完成
```

- `src/protocol/`：纯函数解析核心。一个消息模型（Conversation → Node → Message → Block[]），一个 SSE 解析器 + 一个 delta 解码器，只做快照替换，不做文本猜测合并；对任何输入都不抛异常，未知内容显示为可折叠的 “未知” 块。
- `src/shared/bridge-protocol.js`：页面 ⇄ UI 的线协议（v2），两跳都做精确 origin 校验，凭据不跨桥。
- `src/page/`：页面钩子与隔离桥。无 DOM 消息抓取、无 web-mobile HTML、无 XHR/WebSocket 钩子、无自动 “继续生成”。
- `src/ui/`：界面，基于 Framework7（左侧 Panel 会话列表，宽屏常驻、手机端抽屉；Navbar + 单列消息流 + 输入框；Popover 菜单；Toast 提示；跟随系统深色模式），只按需引入用到的 F7 组件。思考过程、工具调用/结果默认折叠；图片/文件/音频显示为中性卡片；引用显示为编号链接；分支切换只读（非当前分支禁止发送）。

## 未登录（免费模式）

不登录时 chatgpt.com 提供免费模式（页面路径 `/uc/<id>`）。它没有服务器历史和会话列表，所以 SlimGPT：

- 根据 URL 判断模式（出现 `/unauth-mweb/`、`/backend-anon/` 的同源请求/资源，或 `/uc/<id>` 路由；一旦看到带 Authorization 的官方请求即视为已登录），状态栏显示 “未登录：使用免费模式，对话仅保存在本机”；
- 旁听 `POST /unauth-mweb/conversation/updates` 的 `conversation-source+ndjson` 流，由 `createConversationSourceDecoder` 按 revision / baseRevision 校验后还原；链条断裂时保留已收到的文字并标为 “回答未完成”，绝不猜测拼接；
- 只从请求表单里读取 `prompt`、`userMessageId`、`conversationState`（公开的会话 id / 父消息 id），各种 token 一律不读不转发；
- 对话只保存在本机（扩展存储键 `localConversations`，最多 50 个、约 150 万字符，旧的先淘汰），侧栏标记 “本机”；登录模式下不显示、也不保存任何对话内容；
- 打开本机对话 = 真正跳转到 `/uc/<id>`（官方页面据此续接上下文）；免费模式下隐藏分支切换和 “继续生成”。

## 开发

```bash
npm ci
npm test               # node:test：tests/protocol + tests/page + tests/ui
npm run check          # 语法检查 + manifest 版本一致性
npm run build          # 三个目标 + release 包
npm run test:markdown  # 无头 Chromium 里的 Markdown 渲染冒烟测试（可设 CHROME_PATH）
npm run dev            # Vite 开发服务器（只用于看界面）
```

## 已知限制

- 推理强度选择器默认隐藏：官方控件的驱动方式尚未在真实页面上验证。
- 图片/音频只显示为卡片，暂不解析成可显示的 URL。
- 流里非消息类的服务端错误事件（如 `{"error": …}`）目前不单独提示；流结束后会自动重新同步完整历史。
- 免费模式的对话只在本机；清除扩展数据或换设备后无法找回。官方免费模式出现登录墙（`data-conversation-gated`）时 SlimGPT 会让开，需在官方界面处理。
- 页面钩子依赖官方端点路径和输入框/按钮选择器；官方改版后可能需要更新 `src/page/endpoints.js`、`src/page/composer.js`。

## English (short)

SlimGPT is an unofficial WebExtension (Chrome MV3, Firefox MV3 incl. Android, Orion) that overlays a lightweight Svelte 5 + Framework7 UI on your own logged-in chatgpt.com tab. The page hook only *observes* the official SSE stream and full-history fetch (exact endpoint allowlist, `response.clone()`, never rewritten), forwards raw bodies to the extension frame over an exact-origin bridge, and drives the official composer only for explicit commands. All parsing happens in the pure `src/protocol` core (one message model, snapshot replacement, total parser). Logged-out free mode (`/uc/<id>`) is supported too: the hook tees the `POST /unauth-mweb/conversation/updates` NDJSON stream (revision-checked decoder, a broken chain is marked interrupted, never guessed), reads only the prompt and public ids from the form body (no tokens), and the UI keeps those conversations on the device only (`localConversations`, capped); signed-in mode stays server-truth only. Permissions: `storage` only; host `https://chatgpt.com/*`.

Commands: `npm ci && npm test && npm run check && npm run build && npm run test:markdown`. Load `dist-extension/` (Chrome) or `dist-firefox/manifest.json` (Firefox) unpacked.
