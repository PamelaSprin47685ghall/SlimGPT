# SlimGPT

SlimGPT is a Svelte 5 + Framework7 9 WebExtension takeover frontend for rendering your own ChatGPT web conversations with much less visible UI work than the official page.

SlimGPT is an unofficial community project and is not affiliated with or endorsed by OpenAI.

It has three browser-only build targets from the same UI codebase. There is no Android Studio, Gradle, Xcode, Capacitor, Cordova, native signing, or developer-account requirement:

- **Chrome / Chromium desktop** — `dist-extension/`.
- **Firefox desktop + Firefox Android** — `dist-firefox/`.
- **Orion on macOS + iOS/iPadOS** — `dist-orion/`, using the smallest practical WebExtension API surface.

There is no PWA target, no `chrome.debugger`, and no background transport. The actual `chatgpt.com` page remains the host: SlimGPT injects a full-screen extension frame above the official UI and talks to one page-world observer. The only extension permission is `storage`, used for a local compact observation ledger so recent tool/reasoning traffic survives reloads. SlimGPT does **not** request `cookies`, `tabs`, `webRequest`, or debugger permissions and does not read, copy, export, or persist ChatGPT cookies/access tokens.

## Stack

- Svelte 5
- Framework7 + Framework7 Svelte 9
- Vite
- WebExtension content scripts + page-world interception
- Chrome MV3 / Firefox MV3 / Orion-compatible packaging

## Install

- Chrome/Chromium: open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, then select `dist-extension/`.
- Firefox desktop: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, then select `dist-firefox/manifest.json`. Normal Firefox/Firefox Android installation requires Mozilla signing; submit `release/slimgpt-firefox-0.3.0.xpi` to AMO for signing.
- Orion: import `release/slimgpt-orion-0.3.0.zip` from Orion's extension manager. Orion's WebExtension layer is browser-controlled and remains the least certain target; test the package on the intended Orion release before relying on it.

Log into ChatGPT in that browser first. On login, cookie-consent, Cloudflare, or other pages without a usable ChatGPT composer, SlimGPT deliberately stays hidden so the official page remains actionable.

## Development and verification

```bash
npm install
npm test
npm run test:markdown
npm run check
npm run build
npm run live:smoke
```

`npm run live:smoke` builds Chrome and exercises a deterministic intercepted `chatgpt.com` fixture in the installed unpacked extension. It verifies fail-open startup, canonical conversation rendering, current web-mobile partial HTML, credential stripping, composer success/failure, draft preservation, and official/SlimGPT switching.

Real-site read-only smoke:

```bash
npm run live:smoke:real
```

To verify parsing of one existing conversation without submitting a message:

```bash
npm run build:extension
node scripts/live-smoke.mjs --live --clone-profile --read-history
```

The history check waits for a complete canonical sync and reports counts, not
conversation text. It exits unsuccessfully when login, a verification page,
or incomplete history prevents the check. `--read-history` cannot be combined
with `--send-live`. The source Chrome cookie database is opened read-only;
only ChatGPT/OpenAI cookies and the encryption settings needed by Chrome are
copied into a private temporary profile. Passwords, browsing history,
extensions, and unrelated cookies are not copied. This helper uses Node's
built-in `node:sqlite` module.

Unit tests cover snapshot replacement/deletion versus explicit deltas,
UTF-8 and arbitrary SSE chunk boundaries, both standalone protocol parsers,
out-of-order tool ownership, partial-history retention, restored observations,
citations, clipboard failures, input composition, and nested scrolling.
The browser fixture pins a copy of the built extension for the entire run so
that a concurrent build cannot invalidate its lazy-loaded assets.

### Streaming Markdown and optional formatting

`npm run test:markdown` builds the production Markdown renderer and tool
component into a temporary fixture, then runs assertions in a clean Chromium
DOM. It serves only local test data, denies remote content through CSP, and
does not access the user's Chrome profile. Set `CHROME_PATH` when Chromium is
not installed at one of the runner's standard Linux locations.

The renderer explicitly finalizes open code blocks and tables at the end of a
message. Unfinished inline markup or formulas retain their literal delimiters;
code keeps its real trailing newline without gaining an artificial EOF newline.
CRLF boundaries work even when split across updates. Broken or disallowed
image URLs retain a visible description. Code above 200,000 characters bypasses
syntax highlighting without discarding any text.

TOML conversion/highlighting loads only when a tool card is mounted, rather
than being part of the initial application bundle. Raw content is immediately
available while that module loads, and remains readable/copyable if loading or
formatting fails. Browser tests include an actual HTTP failure of the formatter
chunk; a loader failure does not make the conversation disappear.

### Complete-history synchronization

History publication is transactional at both ends of the bridge. The page hook
checks every response's conversation identity, message shape and pagination
boundary. A mapping with `current_node` is not a complete history when its
`page_info` says older pages remain. The receiver verifies contiguous zero-based
page indices, consistent page counts and a matching final boundary. Replayed
pages do not reset staging; missing/conflicting pages retire the transaction
without replacing the previous history or selected branch. A sender's end
notification cannot certify pages that never reached the receiver.

Reads have a 30-second per-request deadline covering headers and body, the
existing per-page body budget, a 64 MiB aggregate body budget and a 100-page
ceiling. No more than three histories fetch concurrently. Reaching any limit
while history is incomplete is a visible failure, never a silently shortened
successful history. Oversized or rejected bodies are canceled. Server-requested
`Retry-After` intervals are not shortened to an arbitrary one-minute cap.

The interface reports sync/authentication/rate-limit failures and provides
**重试同步** without navigating away, discarding the draft or retrying a message
submission. Existing content remains readable. Retries are driven by explicit
user actions or subsequent protocol events, not a polling timer. Empty, valid
histories can complete normally instead of remaining in a loading state.

### Turn-session ownership across asynchronous requests

Submission sessions are reserved at interception entry and become active only
after request scope/identity parsing succeeds. Fetch and XHR share a monotonic
registration order, so a slow older request cannot replace a newer active turn
or revive after it has finished. This order is local transport bookkeeping, not
a historical turn identifier. The reservation ledger retains at most 256 small
identity records and never retains request bodies or credentials.

Conversation broadcasts do not claim a pending new chat merely because they
arrive first or name an unseen conversation. Binding requires a matching user
message or semantic turn identity; transport trace ids are not semantic aliases.
The pending UI checks correlation before adopting any fields, including when a
foreign notification repeats. Captured response metadata can enrich the exact
session that owns its transport without guessing from another tab's broadcast.

A delayed or unidentified stop notification cannot stop/clear a different active
turn. Resume requests consult their own explicit request identity first; without
one, they use the session snapshot taken when interception began, not whichever
turn becomes active after asynchronous parsing. Ambiguous same-user regenerated
requests remain unbound. Cross-window status publication preserves `unknown`
rather than converting it to `stopped`, and retains normalized ownership fields.

### Cache and export integrity

The observation cache has a 4 MiB UTF-8 payload budget and a maximum of 24
conversations. It no longer shortens individual text fields, result arrays,
or objects to fit. A conversation that cannot be stored intact is omitted as
a whole; an omission manifest survives reload and produces a visible notice.
The in-memory conversation is not cropped. Credential-shaped fields remain
excluded, and affected cached items are labelled instead of being presented
as untouched raw payloads. A failed legacy-cache migration write does not
discard the content that was successfully read.

Peer snapshots with comparable protocol revisions replace older observations
without using wall-clock arrival time. Cleared text/errors remain cleared;
status-only updates after reload do not erase restored text or invent raw
transport data.

Markdown export includes reasoning, tool calls/results with their call IDs,
and ordinary answers from the selected branch, including collapsed/offscreen
items. Tool strings retain their original whitespace and large numeric
literals; export fences cannot be closed by backticks inside a tool result.
Unresolved groups are separate from the preceding user turn. Exporting partial
history is allowed, but both the file and the UI explicitly label it incomplete.
Pending unsent drafts are excluded. Errors while preparing or starting a
download produce an error rather than a success message; the browser's later
save/cancel decision is not observable by this export path.

Additional regressions exercise regenerated answers that share a user turn,
actual previous/next branch controls, and a damaged stream followed by a
canonical recovery read. Known sibling-branch observations are excluded from
the selected branch; unknown provenance remains visible. Progress labels alone
do not reclassify a user message, final answer, or tool result as reasoning.

The live SSE reader processes incoming lines incrementally and bounds the
unfinished event buffer. A decoding failure quarantines that transport's
subsequent deltas and requests a canonical history refresh; it does not resume
against state from before a missing operation. Completed snapshots already
received remain visible. A real later response uses a fresh decoder.

Canonical view projections are cached against immutable history payloads,
with at most three selected-branch projections per payload. A history refresh
invalidates the cache without a timer. Run the synthetic, network-free parsing
benchmark with:

```bash
node scripts/benchmark-parsing.mjs
```

It checks 300 turns / 1,200 messages plus a large event delivered in 256-character
chunks. Reported cold/warm timings compare projection reconstruction with cache
reuse on the same code; they are not a prior-release or real-account benchmark.

To exercise a real send from an isolated clone of the current Chrome profile, close normal Chrome first, then run:

```bash
npm run build:extension
node scripts/live-smoke.mjs --live --clone-profile --headed --send-live
```

This clone is temporary, Chrome consumes it directly, and the runner removes it on exit. `--send-live` creates an actual ChatGPT conversation; it is therefore intentionally not part of the default automated command.

Outputs:

- `dist-extension/` — load this directory from `chrome://extensions` → Developer mode → Load unpacked.
- `dist-firefox/` — Firefox desktop/Android package source.
- `dist-orion/` — Orion-oriented package source for macOS/iOS/iPadOS testing.
- `release/slimgpt-chrome-0.3.0.zip` — Chrome package archive.
- `release/slimgpt-firefox-0.3.0.xpi` — Firefox unsigned package for validation/signing.
- `release/slimgpt-orion-0.3.0.zip` — Orion import package.

Production builds omit source maps to keep extension packages small. Set `SLIMGPT_SOURCEMAP=1` only when debugging SlimGPT itself.

## Unified takeover flow

1. Install the package for the current browser.
2. Open `https://chatgpt.com` and log in normally.
3. At `document_start`, SlimGPT installs the page observer and mounts a hidden Svelte/Framework7 frame. It becomes visible only after the official composer exists.
4. The original ChatGPT page remains underneath and handles authentication, network traffic and product writes. While SlimGPT is visible, the official body is removed from layout (`display: none`) to avoid hidden layout/paint work.
5. Sending a message from SlimGPT fills and submits the official composer in that same page. The draft is cleared only after that submit is confirmed. SlimGPT never queues or automatically retries a send after a disconnect.

Use **暂时显示官方界面** to hide the takeover frame. A small SlimGPT restore pill remains on the page.

## Built-in reading layout

The main interface has no feature toggles for its core reading behavior; these are always enabled:

- Wide display: desktop uses a permanent left / center / right layout and expands the center reading area on large monitors.
- Complete response: when the official ChatGPT page presents a clear `Continue` / `Continue generating` control, the page-world bridge clicks it automatically until the control no longer appears.
- Rich history: the left conversation list shows title, latest captured message preview, date + weekday, and the captured model when known.
- Distinct bubbles: user and ChatGPT messages use clearly different alignment, avatar, shape, and surface treatment.
- Turn paging: the center pane renders exactly one **question + following response(s)** turn at a time. A long turn has its own visible scrollbar. Home/End jump to the active turn's start/end; arrows and PageUp/PageDown stay inside the active turn until its boundary. Crossing a turn boundary first expands a full-viewport blank runway/hint and moves the old content out; only an additional scroll/key action flips to the adjacent turn. Downward flips land at the next turn start and upward flips land at the previous turn end.
- Tail following: streaming content follows the viewport only while the reader is at the end of the latest turn. Scrolling away disables following until the reader returns to the tail.
- Thinking state: transient "thinking" activity is presented after tool calls/results at the end of the current turn, rather than at its canonical graph position in the middle of the visible stream.
- Thinking level: the five reasoning levels use a responsive Framework7 segmented control on desktop and mobile, with arrow/Home/End keyboard selection.
- Overview: the right pane shows one single-line row per question/response turn and jumps the center pane to that turn when clicked.
- Mobile: the center pane remains primary while both the conversation list and overview become independent slide-out drawers.
- Tool traffic: structured tool calls/results bypass Markdown, use separate tool avatars, serialize JSON as TOML (including `[[array-of-tables]]` where applicable), and render highlighted monospace TOML code.

## Platform strategy: no native builds

- Android: Firefox WebExtension.
- iOS/iPadOS: Orion WebExtension compatibility layer.
- macOS: Orion, Chrome, or Firefox can use the same takeover core.
- Windows/Linux: Chrome/Chromium or Firefox.
- No Android Studio, Gradle, Xcode, Capacitor, Cordova, APK, IPA, or PWA runtime is part of SlimGPT.

## Performance design

- Only the active question/response turn is mounted in the center pane; the overview stores compact one-line labels for the other turns.
- Markdown uses [`streaming-markdown`](https://github.com/thetarnav/streaming-markdown) directly. New source suffixes append through its parser/DOM renderer; completed paragraphs, code blocks, tables, and math nodes retain their DOM identity instead of being regenerated for every chunk.
- Page synchronization is event-driven: fetch stream chunks, XHR progress, WebSocket messages, and official DOM child/character-data mutations all feed the same live message pipeline. There is no interval polling loop for message synchronization.
- While takeover is active, SlimGPT consumes the real conversation/resume stream and supplies the hidden official consumer with a lightweight structural projection. The projection retains user/final identity and abnormal-EOF resume controls without forwarding heavy content or fabricating transport completion. The response passes through unchanged while the official UI is visible.
- While takeover is active, hidden official-page autofocus is suppressed so it cannot steal focus from SlimGPT. Official focus is temporarily permitted only while SlimGPT submits through the real composer or explicitly reveals the official UI.
- The official conversation graph stays in UI memory. A compact local observation ledger persists normalized recent tool/reasoning/message observations using WebExtension `storage.local`; credential-shaped fields and raw transport envelopes are excluded. Persistence is bounded by whole conversations rather than a per-message sliding window, so one conversation is never silently reduced to its newest few tool calls.
- The official server conversation graph (`mapping` + `current_node`) is treated as canonical. Local branch switching only selects a different graph leaf for presentation.
- Current `text/vnd.openai.web-mobile-partial+html` streams are converted to incremental assistant messages. Only the final `data-conversation` payload crosses into the extension frame; conduit/resume tokens and unrelated Sentinel responses stay in the page world.

## Current phase

`0.3.0` keeps the official ChatGPT conversation graph canonical: SlimGPT never rewrites or truncates the response data it captures. During takeover it does terminate the hidden official consumer's resume stream after cloning that stream for SlimGPT, preventing duplicate parsing; normal product writes and official-visible traffic remain owned by ChatGPT. The page bridge also clicks an explicit Continue/Continue-generating control to finish an interrupted long response. Chrome, Firefox and Orion share the same page-hook + takeover architecture; there is no CDP/debugger transport in the extension.

The takeover bridge temporarily wakes the hidden official body for composer submission, automatic Continue handling, or when the user explicitly chooses to show the official UI, then returns it to render sleep.

## Known limits

- Projects, Memory management, custom GPT configuration, file uploads, voice, image tools, settings, renaming/deleting chats, and other unsupported product controls stay in the official UI.
- Logged-out ChatGPT uses `/uc/` conversations that are temporary to that browser session. SlimGPT renders them, but persistence remains ChatGPT's responsibility.
- Local branch controls are read-only. SlimGPT blocks sending while a non-current branch is selected because the official composer still owns branch writes.
- ChatGPT is an undocumented moving web surface. `npm run live:smoke` protects known contracts; a changed official composer or response format fails visibly and preserves the draft rather than guessing or resending.
