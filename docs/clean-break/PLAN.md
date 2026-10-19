# SlimGPT clean-break overhaul plan

> 中文摘要：现有代码约 2.4 万行，其中解析核心 `core.js`(3.5k 行) + 页面钩子 `main-mitm.js`(4.1k 行) + 主页面 `HomePage.svelte`(2.8k 行) 高度耦合。消息同时来自 5 个来源（完整历史、SSE、XHR、DOM 抓取、web-mobile HTML 抓取），再用一套“别名/身份兼容/渐进文本合并”的启发式拼起来，这正是解析 BUG 层出不穷的根源。大修方案：**只保留两个可信数据源（官方完整历史 + 官方 SSE 流），一个统一消息模型，一个纯函数解析层，快照替换、不做文本猜测合并**；界面砍掉翻页跑道、概览栏、快捷键弹窗、横幅堆栈等，回到“会话列表 + 单列消息流 + 输入框”。分三条互不冲突的工作线并行：A 解析核心+测试，B 界面，C 页面钩子/打包/清理。

Repo: `PamelaSprin47685ghall/SlimGPT`, default branch `main` @ `11cbb34`.
Work branch: `clean-break-overhaul` (local; scaffolding commit on top of `main`).

---

## 1. Current state (main @ 11cbb34)

### Stack
- Browser WebExtension (Chrome MV3, Firefox MV3 incl. Android, Orion). Only permission `storage`, host `https://chatgpt.com/*`.
- UI: Svelte 5.57 + Framework7 9.1.3 (+ framework7-svelte), Vite 8.2 (rolldown). Markdown: `streaming-markdown` 0.2.15, `highlight.js`, `katex`, `smol-toml` (tool payloads as TOML).
- Node 20.19 / npm 11 on the box. Plain JS (no TypeScript), `node:test` for unit tests, a Chromium-driven markdown smoke test.

### Runtime architecture
1. `isolated-bridge.js` (ISOLATED world content script, 292 lines): mounts a full-screen `<iframe src=index.html?takeover=1>` over chatgpt.com, relays postMessage between page and frame, proxies `chrome.storage.local`, publishes a cross-window "execution pulse".
2. `main-mitm.js` (MAIN world, classic script, 4086 lines): wraps `fetch`, XHR and WebSocket; tees streams; **re-writes the official SSE response** into a "lightweight structural projection" for the hidden official app; terminates resume streams; scrapes the official DOM for messages (`installDomMessageObserver`); scrapes web-mobile partial HTML; fetches canonical history itself (reusing captured auth headers, paging, back-off); drives the official composer (types text, clicks send, waits for confirmation); auto-clicks "Continue generating"; drives the official thinking-level slider; render-sleeps the official UI.
3. UI frame: `src/main.js` → `App.svelte` (Framework7 App/View) → `pages/HomePage.svelte` (2822 lines; owns transport handling, capture parsing dispatch, records, pending turns, banners, shortcuts, export, drafts…) + components `ConversationSidebar` (974), `ConversationTurnStage` (1260), `MessageBubble` (1218), `MessageOverview` (305), `Composer` (563), `ToolPayloadBlock` (351), `IncrementalMarkdown` (47); `src/lib/*` helpers; `theme.css` (1475).
4. Parsing core `core.js` (3538 lines, imported by the UI): SSE framing, v1 delta decoding, payload discovery by deep object walk, canonical merge, live observation merge with protocol-identity "compatibility" rules, turn ownership graph (`src/lib/ownership-graph.js`), view projection.

Message sources merged today: canonical history, SSE (fetch), XHR, DOM scrape, web-mobile HTML scrape (+ WebSocket notifications for state). Each has its own merge rules.

### Build / test status (all run on the box, fresh `npm ci`)
| Command | Result |
|---|---|
| `npm ci` | OK |
| `npm test` (53 files, 440 tests) | **439 pass, 0 fail, 1 skipped** (`cookie-profile` needs `node:sqlite`) |
| `npm run check` (syntax + manifest JSON) | OK |
| `npm run build` (chrome/firefox/orion) | OK; warning: main chunk 612 kB (187 kB gz), CSS 253 kB — Framework7 + KaTeX dominate |
| `npm run test:markdown` (headless Chromium) | OK (all cases pass) |
| `npm run live:smoke` | not run (needs installed extension in a real Chrome profile) |

Green tests do not mean correct behaviour: most tests pin internal heuristics (alias graph, "converge2/4/5" UI passes), and 9 test files extract functions from `main-mitm.js` **by string-slicing the source** (`tests/mitm-protocol.test.js:9-19`), so they freeze the implementation rather than the behaviour.

---

## 2. Diagnosed bugs (evidence on main @ 11cbb34)

Probes are in `/workspace/probe/p1.mjs … p6.mjs` (run with `node` from the repo root).

1. **Partial pages re-parent the tree, hide tool steps and invent a branch** (confirmed, `probe/p3.mjs`).
   `webMobileConversationToCanonical` (`core.js:54-89`) chains every message linearly to the previous visible one; `mergeConversationNode` (`core.js:620-636`) lets `incoming.parent` override the known parent and unions children. Result after merging a web-mobile page into a full history: answer `a1` moves under the user, the web search call/result disappear from the visible path, `u1` gets children `[c1, a1]` → a fake "2 versions" branch arrow, and the answer's citations are replaced by flat text (`parts:[item.content]`, metadata reset).
2. **DOM-scraped copy of a user message with an image detaches the whole reply** (confirmed, `probe/p6.mjs`).
   The DOM observer (`main-mitm.js:318-368`) emits `content_type:"text"`; `observationIdentitiesCompatible` (`core.js:1597-1605`) compares `itemKind` (`text` vs `multimodal_text`) and declares a different item, so the reply lands in `turn-canonical-unassigned-root` (`core.js:2757`) and the UI shows "对话关系同步未完成 / 解析待修复" (`ConversationTurnStage.svelte:888-889`). Same for attachments/audio user messages.
3. **DOM / web-mobile fallback text loses Markdown and includes official UI labels.** `roleNode.textContent` (`main-mitm.js:328`) and `block.textContent` (`main-mitm.js:1977`) flatten code blocks/tables/lists and pick up button text such as "Copy code"; when no SSE copy exists this is what the user sees.
4. **Heuristic text merging corrupts text** (confirmed, `probe/p1.mjs`). `mergeProgressiveText` (`core.js:397-422`): `("aa","a") → "aa"`, `("x = 1\n","\n") → "x = 1\n"`, `("Hello wor","rld") → "Hello world"` (overlap guessing). It is still applied unconditionally to `thought/reasoning/initial_text/finished_text` via `mergeObservedMetadata` in `mergeCanonicalAndObservedView` (`core.js:3483`, `508-523`), in tool payload merges (`core.js:2352-2362`) and in hydration (`core.js:2600-2603`).
5. **Streaming citations leak private-use characters / inject placeholder prose** (confirmed). `renderContentReferences` (`src/lib/content-references.js:23`) only matches complete `\uE200…\uE201` markers, so a half-received marker renders as tofu + "citeturn0"; unresolved markers become the literal text "〔来源信息未同步〕" / "〔官方卡片：暂未展开〕" inside the answer (`content-references.js:28-44`). Citations are converted into Markdown links inside the parser (`[来源 1](url)`), mixing presentation into parsing. Legacy `【4:0†source】` markers are not handled at all.
6. **`system_error` is not an error.** `messageNodeToView` (`core.js:1668-1669`) only checks `status`/`metadata.is_error`; a `system_error` message renders as a normal system bubble with `error:false`.
7. **Media rendered as fake text.** Images become `🖼️ [图片: image (10×10)]` and audio pointers `📎 [附件: sediment://…]` inside the Markdown text (`core.js:1981-2003`), leaking internal asset pointers and making copy/export/search noisy; generated images show as a TOML tool card.
8. **Three SSE framers and two delta decoders** (`core.js:91-298`, `src/lib/conversation-stream.js`, `main-mitm.js:1553-1692`) must stay byte-identical; parity is enforced only by source-slicing tests.
9. **Over-broad capture filters.** `interesting()` (`main-mitm.js:98-106`) matches any path containing `conversation`, `messages`, `history`, `models`, or `/backend-api/me` (so also `/backend-api/memories`, …), and `looksLikeMessage` (`core.js:1117`) treats any object with `id` + `content` as a chat message, while `findConversationPayload`/`findMessageEvents` deep-walk arbitrary bodies (up to 12 000 objects). Foreign objects can become messages; correctness depends on later scope checks.
10. **The page hook rewrites official responses** (`createOfficialSemanticStream`, `completeOfficialStream`, `main-mitm.js:1389-1812`) and redefines `Response.prototype` readers on live responses. Any official protocol change can break the official app itself, not just SlimGPT.

Root cause shared by 1–4 and most historical fixes: multiple low-fidelity sources + identity heuristics + text merging. The overhaul removes the sources instead of adding more rules.

---

## 3. Target design

### 3.1 Principles
- **Two sources only**: (a) canonical history JSON from `GET /backend-api/conversation/{id}` (and paged variant), (b) the official SSE stream of `POST /backend-api/(f/)conversation[/resume]`. No DOM scraping, no web-mobile HTML scraping, no WebSocket parsing.
- **Observe, never rewrite.** The page hook tees responses (`response.clone()` / stream tee) and forwards raw text. It does not alter what the official app receives.
- **One model** (`src/protocol/types.js`): `Conversation → Node → Message → Block[]`.
- **Snapshot replace only.** The stream decoder applies v1 deltas internally and emits full message snapshots; consumers replace by id. No text concatenation heuristics anywhere.
- **Parent chain decides ownership.** A turn = a visible user message + following visible messages on the selected path until the next user message. No alias/exchange/trace-id graph. Live messages without a parent use the submitted user message id from the request body.
- **Precedence**: canonical `done` message is final; live may update canonical `streaming`/`interrupted` nodes; a later canonical ingest replaces live data. After every stream end the UI requests a canonical refresh.
- **Pure + total parser**: no DOM/timers/globals; never throws; unknown content → `UnknownBlock` (visible, collapsed), never dropped and never turned into placeholder prose.

### 3.2 Module layout and ownership
```
src/protocol/              [A]  pure parsing core (imported only by the UI)
  types.js                 contract (scaffolded, frozen)
  index.js                 public API (scaffolded stubs)
  sse.js                   the only SSE framer
  delta.js                 the only delta_encoding v1 decoder
  stream.js                createStreamDecoder (sse + delta → StreamEvent)
  message.js               normalizeMessage + block classifiers
  citations.js             marker stripping → Citation spans
  conversation.js          create/parse/merge/applyLiveMessage
  turns.js                 selectTurns / switchBranch
  text.js                  messageToPlainText / conversationToMarkdown
  conversation-list.js     parseConversationList
src/shared/bridge-protocol.js  [C]  page⇄UI wire contract (scaffolded)
src/page/                  [C]  extension runtime
  hook.js                  MAIN-world entry (bundled to IIFE main-hook.js)
  fetch-tee.js             strict allowlist tee of fetch (+XHR if still needed)
  history.js               canonical + list fetch, paging, back-off
  composer.js              drive official composer (send/stop), confirmation
  takeover.js              frame visibility, render-sleep, focus guard, "show official"
  bridge.js                ISOLATED-world entry: frame mount, relay, storage proxy
src/ui/                    [B]  extension frame
  main.js, App.svelte, theme.css
  bridge-client.js         postMessage client using bridge-protocol.js
  state.svelte.js          app state (conversations, list, current, streams, drafts, settings)
  components/              Sidebar, Thread, Turn, Message, Composer, StatusLine
  components/blocks/       TextBlock (markdown + citations), ReasoningBlock, ToolBlock, MediaBlock (image/file), ErrorBlock, UnknownBlock
  markdown/                streaming markdown renderer (ported copy of src/lib/incremental-markdown.js)
index.html                 [B]
manifest*.json, vite.config.js, scripts/build.mjs, package.json, README.md  [C]
tests/protocol/**, tests/fixtures/**   [A]
tests/page/**                          [C]
tests/ui/**, tests/browser/**, scripts/markdown-smoke.mjs  [B]
```
Legacy files (`core.js`, `main-mitm.js`, `isolated-bridge.js`, `src/main.js`, `src/App.svelte`, `src/pages/**`, `src/components/**`, `src/lib/**`, `src/theme.css`, `tests/*.test.js`, `scripts/{benchmark-parsing,visual-verify,live-smoke,cookie-profile}.mjs`) stay untouched until the **cutover step owned by C**. A and B may *copy* code out of them but must not edit or import them.

### 3.3 Protocol contract (A provides; B consumes) — see `src/protocol/index.js`
```
normalizeMessage(raw, {parentId?, source?}) → Message|null
parseConversation(body: string|object) → Conversation|null      // mapping + paged formats
mergeConversation(prev|null, incoming) → Conversation             // never rewrites known parents
createConversation(id) → Conversation
applyLiveMessage(conv, raw, {fallbackParentId?}) → Conversation   // snapshot replace, precedence rule
selectTurns(conv, leafId?) → Turn[]                               // parent chain only, hidden excluded
switchBranch(conv, nodeId, ±1) → leafId
createStreamDecoder({maxBufferedChars?}) → {push(chunk) → StreamEvent[], end() → StreamEvent[]}
parseConversationList(body) → [{id,title,updatedAt}]|null
messageToPlainText(message) → string
conversationToMarkdown(conv, {leafId?, includeReasoning?, includeTools?}) → string
```
Block kinds: `text{markdown,citations[]}`, `reasoning{markdown,summary,durationSec}`, `tool_call{tool,callId,input,language}`, `tool_result{tool,callId,output,isError}`, `image{assetPointer,width,height}`, `file{name,size,mime}`, `error{message}`, `unknown{contentType,raw}`.
Status mapping: `in_progress`→streaming; `finished_successfully`/`end_turn`→done; `finished_partial_completion` or `finish_details.type=max_tokens|interrupted`→interrupted; `failed`, `is_error`, `system_error`→error.
StreamEvent: `message{conversationId,raw}` (full snapshot), `conversation-id`, `title`, `done`, `error{code}`; after `error` nothing more is emitted. EOF inside an event → `error:truncated`.

### 3.4 Wire contract (C provides; B consumes) — see `src/shared/bridge-protocol.js`
Page→UI: `hello`, `location`, `conversation-list{body}`, `conversation{conversationId,body,page,pages}`, `conversation-error{code,retryAfterSec}`, `stream-start{streamId,conversationId,userMessageId,parentMessageId,resume}`, `stream-chunk{streamId,chunk}`, `stream-end{streamId,ok}`, `send-result{commandId,ok,error}`, `takeover{visible}`, `storage-result`.
UI→Page: `open{conversationId|null}`, `send{commandId,text}`, `stop`, `refresh{conversationId}`, `show-official`, `set-effort{effort}`, `storage-get`, `storage-set`.
All bodies are raw strings; the page never parses chat content (it may read the *request* body to fill `stream-start` ids). Origins are checked exactly on both hops. Credentials never cross the bridge.

### 3.5 Test plan
- **A (unit, node:test, `tests/protocol/`)** — scaffolded `contract.test.js` (28 cases, reported TODO until implemented):
  - one fixture per content type (`tests/fixtures/protocol/messages.json`: text, streaming, thoughts, reasoning_recap, analysis channel, python call/output, web.run call/result, multimodal user image, attachments, literal user text, image-gen result, audio transcript, resolved citation, truncated/unresolved citation, system_error, hidden system / user_editable_context, unknown type, max_tokens interruption); input immutability; totality on garbage.
  - stream decoder fixture at **every chunk size 1..64 × LF/CRLF/CR**, repeated characters and bare newlines preserved; delta-before-encoding → error; EOF mid-event → truncated.
  - regressions for bugs 1 and 2 (fixtures included); precedence (`done` never downgraded).
  - A adds: paged-history merge, branch switching (regenerate + edited user), tool call/result pairing by callId, conversation list parsing, export Markdown fences that contain backticks, a 1 200-message performance budget (< 50 ms parse+selectTurns on the box).
- **C (`tests/page/`)**: import `src/page/*.js` modules directly (no source slicing): allowlist matcher, request-body id extraction, history paging/back-off state machine, bridge origin checks, composer driver against a jsdom-free fake DOM where feasible; `npm run check` + build of all three targets; manifest permission test (port `tests/architecture.test.js`).
- **B (`tests/ui/`, `tests/browser/`)**: pure state reducer tests for `state.svelte.js` logic (extract reducers to plain functions); keep/port the Chromium markdown smoke (`scripts/markdown-smoke.mjs`, `tests/browser/markdown.spec.js`) against `src/ui/markdown/`.
- Final: `npm test` runs `node --test tests/protocol tests/page tests/ui`; `npm run build`; `npm run test:markdown`; bundle-size check (target: main JS < 300 kB, CSS < 40 kB excl. KaTeX fonts).

---

## 4. UI simplification

Keep (core):
- Conversation list: titles, current highlight, running indicator, "新对话", title filter (client-side, titles only).
- Single scrolling thread of the selected branch (all turns, native scroll, auto-follow only while at bottom, one "回到底部" button).
- Message rendering: streaming Markdown + code highlight + KaTeX; citations as small numbered links from `Citation` spans; reasoning as a collapsed "思考 · Ns" block; tool call/result as one collapsed card each (raw text / pretty JSON, copy); image/file as neutral cards; unknown/error blocks visible.
- Branch switcher `‹ 2/3 ›` on user message and first reply (read-only, sending disabled off the current branch with one clear notice).
- Composer: textarea, Enter send / Shift+Enter newline, Stop while running, per-conversation draft persistence, failure keeps the draft and shows one inline error.
- One status line: bridge not ready / not logged in / sync failed + "重试同步" / offline. No stack.
- "显示官方界面" toggle (and the existing restore button on the host page).
- Copy message; export current conversation as Markdown (one action, in a small menu).
- Reasoning effort: one plain `<select>` (only if C confirms the official control can be driven reliably; otherwise hidden).

Cut:
- Turn paging stage with blank "runway", Home/End/arrow turn semantics, ±5 turn jumps (`ConversationTurnStage.svelte`).
- Right-hand overview pane + filter + mobile overview drawer (`MessageOverview.svelte`).
- Keyboard shortcuts modal and global shortcuts beyond Enter/Shift+Enter/Esc.
- Banner stack, banner priority/expansion, persisted dismissals, staleness tracker (`shell-helpers.js`), capture-warning toasts.
- "纯净问答" export toggle, per-turn Markdown copy, quote-selection-into-composer, image preview modal, regenerate-with-effort menu, 改写/放弃 failure cards.
- Sidebar body-text search and "正文命中" badges.
- Protocol-diagnostic UI ("解析待修复", "重新同步关联", unassigned buckets) — impossible by construction now.
- Cross-window execution pulse, emoji/placeholder text for media, TOML conversion of tool payloads (`smol-toml`), hard-coded "GPT-5.6" model table in `core.js:792-871`.
- Framework7 (replace with plain Svelte + ~1 small CSS file; system font, light/dark via `prefers-color-scheme`).
- Page-hook features: DOM message scraping, web-mobile scraping, WebSocket observation, official stream projection/rewrite, resume-stream termination, automatic "Continue generating" clicks (replace with an explicit "继续生成" button on an interrupted message that sends a UI→page command — add `continue` to the wire contract if B/C agree).

---

## 5. Workstreams (parallel, disjoint file ownership)

Each worker branches from `clean-break-overhaul` (`cbo/protocol`, `cbo/ui`, `cbo/page`), commits only inside its owned paths, and opens/merges back into `clean-break-overhaul`. Contract files (`src/protocol/types.js`, `src/protocol/index.js` signatures, `src/shared/bridge-protocol.js`) change only with a note in the PR description; additive changes preferred.

### A — Protocol core + tests
- Owns: `src/protocol/**`, `tests/protocol/**`, `tests/fixtures/**`.
- Deliver: implementation of every `index.js` export per §3.3; all contract tests passing (remove the TODO gate by implementing, not by editing expectations); extra tests listed in §3.5; JSDoc on every export.
- May read/copy from `core.js`, `src/lib/content-references.js`, `src/lib/conversation-stream.js`; must not import them.
- Done when: `node --test tests/protocol` green, no imports outside `src/protocol`, no DOM globals referenced.

### B — UI shell
- Owns: `src/ui/**`, `index.html`, `tests/ui/**`, `tests/browser/**`, `scripts/markdown-smoke.mjs`.
- Deliver: new Svelte app per §4 using only `src/protocol/index.js` and `src/shared/bridge-protocol.js`. Until A lands, develop against the stub signatures with local fixture data (`tests/fixtures/protocol`), behind a tiny adapter in `src/ui/state.svelte.js`.
- `index.html` switches its script to `/src/ui/main.js` in B's final commit.
- Must not touch `vite.config.js`/`package.json` — request dependency removals/additions from C (expected: drop `framework7`, `framework7-svelte`, `smol-toml`; keep `svelte`, `streaming-markdown`, `highlight.js`, `katex`).
- Done when: `npm run build` (after C's config) produces a working frame; markdown smoke green; no Framework7 imports.

### C — Page integration, build, cutover
- Owns: `src/page/**`, `src/shared/**`, `tests/page/**`, `manifest*.json`, `vite.config.js`, `scripts/build.mjs`, `package.json`, `package-lock.json`, `README.md`, `.gitignore`, and all legacy-file deletions.
- Deliver: observe-only page hook per §3.1/§3.4 (strict allowlist: `^/backend-api/(f/)?conversation$`, `…/conversation/resume$`, `^/backend-api/conversation/[^/]+$`, `^/backend-api/conversations$`); composer send/stop; takeover/render-sleep/focus guard; history fetch with paging and back-off; isolated bridge with exact-origin relay and storage proxy; build bundles `src/page/hook.js` → `main-hook.js` (IIFE) and `src/page/bridge.js` → `isolated-bridge.js`, same three targets, permissions unchanged (`storage` only).
- Cutover (last, after A and B are merged): delete legacy files listed in §3.2, set `"test": "node --test tests/protocol tests/page tests/ui"`, drop unused deps, bump version to `0.4.0` in package + 3 manifests, rewrite README (short: what it is, install, dev commands, architecture diagram, known limits).
- Done when: `npm ci && npm test && npm run check && npm run build && npm run test:markdown` all green on the box; extension loads in Chromium with the frame showing the hello/not-logged-in state.

### Integration order
1. Scaffolding (this branch) → A, B, C start in parallel.
2. Merge A → merge C (page + build, legacy still present) → merge B (switch `index.html`) → C cutover commit → full verification → push `clean-break-overhaul`, open PR to `main`.

---

## 6. Open decisions for Ashley (defaults in bold)
1. Stop rewriting the official stream (**yes**; hidden official UI may use a bit more CPU while generating).
2. Replace auto "Continue generating" with an explicit button (**yes**).
3. Remove Framework7 (**yes**).
4. Keep reasoning-effort selector (**keep as simple select if reliable**).
5. Version `0.4.0` (**yes**).
