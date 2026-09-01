# SlimGPT

SlimGPT is a Svelte 5 + Framework7 9 WebExtension takeover frontend for rendering your own ChatGPT web conversations with much less visible UI work than the official page.

SlimGPT is an unofficial community project and is not affiliated with or endorsed by OpenAI.

It has three browser-only build targets from the same UI codebase. There is no Android Studio, Gradle, Xcode, Capacitor, Cordova, native signing, or developer-account requirement:

- **Chrome / Chromium desktop** — `dist-extension/`.
- **Firefox desktop + Firefox Android** — `dist-firefox/`.
- **Orion on macOS + iOS/iPadOS** — `dist-orion/`, using the smallest practical WebExtension API surface.

There is no PWA target, no `chrome.debugger`, and no background transport. The actual `chatgpt.com` page remains the host: SlimGPT injects a full-screen extension frame above the official UI and talks to one page-world observer. SlimGPT does **not** request `cookies` permission and does not read, copy, export, or persist ChatGPT cookies/access tokens.

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
npm run check
npm run build
npm run live:smoke
```

`npm run live:smoke` builds Chrome and exercises a deterministic intercepted `chatgpt.com` fixture in the installed unpacked extension. It verifies fail-open startup, canonical conversation rendering, current web-mobile partial HTML, credential stripping, composer success/failure, draft preservation, and official/SlimGPT switching.

Real-site read-only smoke:

```bash
npm run live:smoke:real
```

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
4. The original ChatGPT page remains underneath and handles authentication, network traffic and product writes. While SlimGPT is visible, the official body is put into render sleep (`content-visibility: hidden`) to avoid unnecessary layout/paint work.
5. Sending a message from SlimGPT fills and submits the official composer in that same page. The draft is cleared only after that submit is confirmed. SlimGPT never queues or automatically retries a send after a disconnect.

Use **暂时显示官方界面** to hide the takeover frame. A small SlimGPT restore pill remains on the page.

## Platform strategy: no native builds

- Android: Firefox WebExtension.
- iOS/iPadOS: Orion WebExtension compatibility layer.
- macOS: Orion, Chrome, or Firefox can use the same takeover core.
- Windows/Linux: Chrome/Chromium or Firefox.
- No Android Studio, Gradle, Xcode, Capacitor, Cordova, APK, IPA, or PWA runtime is part of SlimGPT.

## Performance design

- Message DOM is virtualized: visible rows plus an 8-message buffer on each side are mounted.
- Markdown rendering runs in a Worker and caches stable blocks, so streaming text does not reparse the entire message every token.
- The full conversation payload is kept in the open SlimGPT UI memory; only compact conversation metadata is persisted locally.
- The official server conversation graph (`mapping` + `current_node`) is treated as canonical. Local branch switching only selects a different graph leaf for presentation.
- Current `text/vnd.openai.web-mobile-partial+html` streams are converted to incremental assistant messages. Only the final `data-conversation` payload crosses into the extension frame; conduit/resume tokens and unrelated Sentinel responses stay in the page world.

## Current phase

`0.3.0` remains observe-only: it captures a canonical copy for SlimGPT but never rewrites or truncates the response seen by the official page. Chrome, Firefox and Orion share the same page-hook + takeover architecture; there is no CDP/debugger transport in the extension.

The takeover bridge temporarily wakes the hidden official body only for composer submission or when the user explicitly chooses to show the official UI, then returns it to render sleep.

## Known limits

- Projects, Memory management, custom GPT configuration, file uploads, voice, image tools, settings, renaming/deleting chats, and other unsupported product controls stay in the official UI.
- Logged-out ChatGPT uses `/uc/` conversations that are temporary to that browser session. SlimGPT renders them, but persistence remains ChatGPT's responsibility.
- Local branch controls are read-only. SlimGPT blocks sending while a non-current branch is selected because the official composer still owns branch writes.
- ChatGPT is an undocumented moving web surface. `npm run live:smoke` protects known contracts; a changed official composer or response format fails visibly and preserves the draft rather than guessing or resending.
