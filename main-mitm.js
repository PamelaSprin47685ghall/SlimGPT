(() => {
  if (window.__SLIMGPT_MITM_INSTALLED__) {
    window.postMessage({
      channel: "slimgpt-page-v1",
      direction: "page-to-extension",
      payload: { type: "page-hook-ready", timestamp: Date.now(), url: location.href },
    }, location.origin);
    return;
  }
  window.__SLIMGPT_MITM_INSTALLED__ = true;

  const CHANNEL = "slimgpt-page-v1";
  const UI_CHANNEL = "slimgpt-ui-v1";
  const FRAME_ID = "slimgpt-takeover-frame";
  const RESTORE_ID = "slimgpt-restore-button";
  const SLEEP_STYLE_ID = "slimgpt-render-sleep-style";
  const SLEEP_ATTR = "data-slimgpt-render-sleep";
  const MAX_NON_STREAM_BODY = 20 * 1024 * 1024;
  const INITIAL_SHELL_READY_TIMEOUT = 15_000;
  const COMPOSER_WAKE_TIMEOUT = 2_500;
  const SEND_CONTROL_TIMEOUT = 1_500;
  const BLOCKED_TAKEOVER_RETRY_MS = 500;
  const TAKEOVER_BLOCKER_GUARD_MS = 5_000;
  const COMPLETE_RESPONSE_RECLICK_MS = 1_250;
  let requestCounter = 0;
  let resleepTimer = null;
  let blockedTakeoverRetryTimer = null;
  let takeoverBlockerGuardTimer = null;
  let takeoverBlockerGuardDeadline = 0;
  let sendInFlight = false;
  let takeoverActive = false;
  let officialFocusPermitDepth = 0;
  let lastContinueControl = null;
  let lastContinueClickAt = 0;
  const observedFetchResponses = new WeakSet();
  const XHR_RESPONSE_OBSERVED = Symbol("slimgpt-xhr-response-observed");
  const WEBSOCKET_OBSERVED = Symbol("slimgpt-websocket-observed");

  const emit = (payload) => {
    window.postMessage(
      { channel: CHANNEL, direction: "page-to-extension", payload },
      location.origin,
    );
  };

  const interesting = (rawUrl) => {
    try {
      const url = new URL(String(rawUrl || ""), location.href);
      if (url.origin !== location.origin) return false;
      if (url.pathname.includes("/backend-api/sentinel/")) return false;
      if (/\/conversation\/(?:prepare|runtime)$/.test(url.pathname)) return false;
      return (
        url.pathname.includes("conversation") ||
        url.pathname.includes("messages") ||
        url.pathname.includes("history")
      );
    } catch {
      return false;
    }
  };

  const nextRequestId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;

  installRenderSleepStyle();
  installFocusGuard();
  installCompleteResponse();
  installDomMessageObserver();
  scheduleInitialTakeover();
  emit({ type: "page-hook-ready", timestamp: Date.now(), url: location.href });

  let observedFetch = null;
  installFetchObserver();

  function installFetchObserver() {
    const initialFetch = window.fetch;
    observedFetch = wrapFetch(initialFetch);
    try {
      Object.defineProperty(window, "fetch", {
        configurable: true,
        enumerable: true,
        get() {
          return observedFetch;
        },
        set(next) {
          if (next === observedFetch || typeof next !== "function") return;
          observedFetch = wrapFetch(next);
        },
      });
    } catch {
      window.fetch = observedFetch;
    }
  }

  function installCompleteResponse() {
    let scheduled = false;
    let observer = null;
    const scan = () => {
      if (!findComposerElement() || findBlockingOfficialUi()) return;
      const control = findContinueControl();
      if (!control) {
        lastContinueControl = null;
        return;
      }
      const now = Date.now();
      if (control === lastContinueControl && now - lastContinueClickAt < COMPLETE_RESPONSE_RECLICK_MS) return;
      lastContinueControl = control;
      lastContinueClickAt = now;
      const shouldResleep = takeoverActive;
      if (shouldResleep) wakeOfficialUi();
      try {
        control.click();
        emit({ type: "complete-response-continued", timestamp: now, url: location.href });
      } catch {
        // The host can remove the control between discovery and click.
      }
      if (shouldResleep) scheduleRenderSleep(450);
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        scan();
      });
    };

    const mount = () => {
      if (!document.documentElement || observer) return;
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      schedule();
    };
    if (document.documentElement) mount();
    else new MutationObserver((_, readyObserver) => {
      if (!document.documentElement) return;
      readyObserver.disconnect();
      mount();
    }).observe(document, { childList: true, subtree: true });
    addEventListener("popstate", schedule);
    addEventListener("pagehide", () => observer?.disconnect(), { once: true });
  }

  function findContinueControl() {
    const selectors = [
      'button[data-testid*="continue" i]',
      'button[aria-label*="continue" i]',
      'button[aria-label*="继续"]',
    ];
    for (const selector of selectors) {
      for (const button of document.querySelectorAll(selector)) {
        if (isCompleteResponseControl(button)) return button;
      }
    }
    for (const button of document.querySelectorAll('button')) {
      if (isCompleteResponseControl(button)) return button;
    }
    return null;
  }

  function isCompleteResponseControl(button) {
    if (!(button instanceof HTMLButtonElement) || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    const label = [button.textContent, button.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return /^(?:continue(?: generating| response)?|继续(?:生成|回答|回复)?)[.!。…\s]*$/i.test(label);
  }

  function installFocusGuard() {
    const nativeElementFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function slimgptGuardedFocus() {
      if (
        takeoverActive &&
        officialFocusPermitDepth === 0 &&
        this?.id !== FRAME_ID
      ) {
        return;
      }
      return Reflect.apply(nativeElementFocus, this, arguments);
    };

    const nativeWindowFocus = window.focus;
    try {
      window.focus = function slimgptGuardedWindowFocus() {
        if (takeoverActive && officialFocusPermitDepth === 0) return;
        return Reflect.apply(nativeWindowFocus, window, arguments);
      };
    } catch {
      // Some engines expose window.focus as non-writable. Element focus is the
      // important path for ChatGPT's composer/autofocus behavior.
    }
  }

  function focusTakeoverFrame() {
    if (!takeoverActive) return;
    const frame = document.getElementById(FRAME_ID);
    if (!frame || frame.dataset.slimgptVisible !== "1") return;
    try {
      frame.focus({ preventScroll: true });
    } catch {
      try { frame.focus(); } catch {}
    }
  }

  function installDomMessageObserver() {
    let observer = null;
    let scanScheduled = false;
    let currentConversationId = null;
    const seenText = new Map();

    const schedule = () => {
      if (scanScheduled) return;
      scanScheduled = true;
      requestAnimationFrame(() => {
        scanScheduled = false;
        scan();
      });
    };

    const scan = () => {
      const match = location.pathname.match(/\/(?:c|uc)\/([^/?#]+)/);
      const conversationId = match?.[1] || null;
      if (!conversationId) return;
      if (conversationId !== currentConversationId) {
        currentConversationId = conversationId;
        seenText.clear();
      }

      for (const roleNode of document.querySelectorAll('[data-message-author-role]')) {
        const role = String(roleNode.getAttribute('data-message-author-role') || '').toLowerCase();
        if (!['user', 'assistant', 'tool'].includes(role)) continue;
        const messageRoot = roleNode.closest('[data-message-id]') || roleNode.querySelector?.('[data-message-id]');
        const messageId = messageRoot?.getAttribute?.('data-message-id') || roleNode.getAttribute('data-message-id');
        if (!messageId) continue;
        const text = String(roleNode.textContent || '').replace(/\u00a0/g, ' ').trim();
        if (!text || seenText.get(messageId) === text) continue;
        seenText.set(messageId, text);
        emit({
          type: "page-capture",
          transport: "dom",
          phase: "message",
          requestId: `dom-${messageId}`,
          url: location.href,
          mimeType: "application/json",
          timestamp: Date.now(),
          data: JSON.stringify({
            conversation_id: conversationId,
            message: {
              id: messageId,
              author: { role },
              content: { content_type: "text", parts: [text] },
              status: role === 'assistant' ? "in_progress" : null,
              end_turn: false,
            },
          }),
        });
      }
    };

    const mount = () => {
      if (!document.documentElement || observer) return;
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-message-author-role', 'data-message-id'],
      });
      schedule();
    };
    if (document.documentElement) mount();
    else new MutationObserver((_, readyObserver) => {
      if (!document.documentElement) return;
      readyObserver.disconnect();
      mount();
    }).observe(document, { childList: true, subtree: true });
    addEventListener("popstate", schedule);
    addEventListener("pagehide", () => observer?.disconnect(), { once: true });
  }

  function wrapFetch(upstreamFetch) {
    return async function slimgptObservedFetch(input) {
      const response = await Reflect.apply(upstreamFetch, this, arguments);
      const url = response.url || (typeof input === "string" ? input : input?.url);
      if (!interesting(url)) return response;
      if (observedFetchResponses.has(response)) return response;
      observedFetchResponses.add(response);

      const requestId = nextRequestId("fetch");
      const mimeType = response.headers.get("content-type") || "";
      let clone;
      try {
        clone = response.clone();
      } catch {
        return response;
      }

      if (mimeType.includes("text/vnd.openai.web-mobile-partial+html") && clone.body) {
        void captureWebMobileStream(clone.body, {
          requestId,
          url,
          status: response.status,
          mimeType,
        });
      } else if (mimeType.includes("text/event-stream") && clone.body) {
        void captureReadableStream(clone.body, {
          requestId,
          url,
          status: response.status,
          mimeType,
        });
      } else {
        const declaredLength = Number(response.headers.get("content-length") || 0);
        if (!declaredLength || declaredLength <= MAX_NON_STREAM_BODY) {
          void captureBoundedResponse(clone, {
            requestId,
            url,
            status: response.status,
            mimeType,
          });
        }
      }

      return response;
    };
  }

  async function captureReadableStream(stream, meta) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const data = decoder.decode(value, { stream: true });
        if (!data) continue;
        emit({
          type: "page-capture",
          transport: "sse",
          phase: "chunk",
          timestamp: Date.now(),
          data,
          ...meta,
        });
      }
      const tail = decoder.decode();
      if (tail) {
        emit({
          type: "page-capture",
          transport: "sse",
          phase: "chunk",
          timestamp: Date.now(),
          data: tail,
          ...meta,
        });
      }
      emit({
        type: "page-capture",
        transport: "sse",
        phase: "complete",
        timestamp: Date.now(),
        data: "",
        ...meta,
      });
    } catch {
      // Observation must never break the product request.
    } finally {
      reader.releaseLock();
    }
  }

  async function captureWebMobileStream(stream, meta) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let source = "";
    let bytes = 0;
    let lastLiveText = "";
    let lastParseAt = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_NON_STREAM_BODY) {
          await reader.cancel();
          return;
        }
        const text = decoder.decode(value, { stream: true });
        if (text) source += text;
        const now = Date.now();
        if (now - lastParseAt >= 50) {
          lastParseAt = now;
          const snapshot = extractWebMobileLiveSnapshot(source);
          if (snapshot?.text && snapshot.text !== lastLiveText) {
            lastLiveText = snapshot.text;
            emitWebMobileLiveMessage(snapshot, meta);
          }
        }
      }
      const tail = decoder.decode();
      if (tail) source += tail;
      const safeConversation = extractWebMobileConversationMarkup(source);
      if (safeConversation) emitCompletedFetch(safeConversation, meta);
    } catch {
      // Observation must never break the product request.
    } finally {
      reader.releaseLock();
    }
  }

  function emitWebMobileLiveMessage(snapshot, meta) {
    emit({
      type: "page-capture",
      transport: "web-mobile",
      phase: "chunk",
      timestamp: Date.now(),
      data: JSON.stringify({
        conversation_id: snapshot.conversationId,
        message: {
          id: snapshot.messageId,
          author: { role: "assistant" },
          content: { content_type: "text", parts: [snapshot.text] },
          status: "in_progress",
          end_turn: false,
        },
      }),
      ...meta,
    });
  }

  function extractWebMobileLiveSnapshot(source) {
    const conversationIds = [...source.matchAll(/\bdata-conversation-id="([^"]+)"/g)];
    const messageIds = [...source.matchAll(/\bdata-message-id="([^"]+)"/g)];
    if (!conversationIds.length || !messageIds.length) return null;

    const documentFragment = new DOMParser().parseFromString(source, "text/html");
    const blocks = new Map();
    const visit = (root) => {
      for (const block of root.querySelectorAll?.("[data-assistant-stream-block]") || []) {
        const index = Number(block.getAttribute("data-assistant-stream-block-index") || blocks.size);
        const text = String(block.textContent || "").trimEnd();
        if (text) blocks.set(index, text);
      }
      for (const template of root.querySelectorAll?.("template") || []) visit(template.content);
    };
    visit(documentFragment);
    if (!blocks.size) return null;

    return {
      conversationId: conversationIds[conversationIds.length - 1][1],
      messageId: messageIds[messageIds.length - 1][1],
      text: [...blocks.entries()].sort(([left], [right]) => left - right).map(([, text]) => text).join("\n\n"),
    };
  }

  function extractWebMobileConversationMarkup(source) {
    const matches = [...source.matchAll(/\bdata-conversation="([^"]+)"/g)];
    if (!matches.length) return null;
    return `<span data-conversation="${matches[matches.length - 1][1]}"></span>`;
  }

  async function captureBoundedResponse(response, meta) {
    if (!response.body) {
      try {
        const data = await response.text();
        if (data.length <= MAX_NON_STREAM_BODY) emitCompletedFetch(data, meta);
      } catch {
        // Observation must never break the product request.
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_NON_STREAM_BODY) {
          await reader.cancel();
          return;
        }
        const text = decoder.decode(value, { stream: true });
        if (text) parts.push(text);
      }
      const tail = decoder.decode();
      if (tail) parts.push(tail);
      emitCompletedFetch(parts.join(""), meta);
    } catch {
      // Observation must never break the product request.
    } finally {
      reader.releaseLock();
    }
  }

  function emitCompletedFetch(data, meta) {
    if (String(meta.mimeType || "").includes("text/vnd.openai.web-mobile-partial+html")) {
      data = extractWebMobileConversationMarkup(data);
      if (!data) return;
    }
    emit({
      type: "page-capture",
      transport: "fetch",
      phase: "complete",
      timestamp: Date.now(),
      data,
      ...meta,
    });
  }

  let observedXhrOpen = null;
  let observedXhrSend = null;
  let observedWebSocket = null;
  ensureXhrObserver();
  installWebSocketObserver();

  function ensureXhrObserver() {
    const prototype = window.XMLHttpRequest?.prototype;
    if (!prototype) return;

    if (prototype.open !== observedXhrOpen) {
      const upstreamOpen = prototype.open;
      observedXhrOpen = function slimgptOpen(method, url) {
        this.__slimgptMeta = { method, url: new URL(String(url), location.href).href };
        return Reflect.apply(upstreamOpen, this, arguments);
      };
      prototype.open = observedXhrOpen;
    }

    if (prototype.send !== observedXhrSend) {
      const upstreamSend = prototype.send;
      observedXhrSend = function slimgptSend() {
        const meta = this.__slimgptMeta;
        if (meta && interesting(meta.url) && !this[XHR_RESPONSE_OBSERVED]) {
          this[XHR_RESPONSE_OBSERVED] = true;
          observeXhrResponse(this, meta);
        }
        return Reflect.apply(upstreamSend, this, arguments);
      };
      prototype.send = observedXhrSend;
    }
  }

  function observeXhrResponse(xhr, meta) {
    const requestId = nextRequestId("xhr");
    let sentLength = 0;
    let captureDisabled = false;
    const capture = (phase) => {
      try {
        if (captureDisabled) return;
        if (xhr.responseType && xhr.responseType !== "text") return;
        const text = xhr.responseText || "";
        if (text.length > MAX_NON_STREAM_BODY) {
          captureDisabled = true;
          return;
        }
        if (text.length < sentLength) sentLength = 0;
        const delta = text.slice(sentLength);
        sentLength = text.length;
        if (!delta && phase !== "complete") return;
        emit({
          type: "page-capture",
          transport: "xhr",
          requestId,
          url: meta.url,
          status: xhr.status || null,
          mimeType: xhr.getResponseHeader?.("content-type") || null,
          phase,
          timestamp: Date.now(),
          data: delta,
        });
      } catch {
        // Cross-origin/responseType access can throw; ignore observation only.
      }
    };
    xhr.addEventListener("progress", () => capture("chunk"));
    xhr.addEventListener("loadend", () => capture("complete"), { once: true });
  }

  function installWebSocketObserver() {
    const wrap = (UpstreamWebSocket) => function ObservedWebSocket(url, protocols) {
      const socket = arguments.length > 1
        ? new UpstreamWebSocket(url, protocols)
        : new UpstreamWebSocket(url);
      if (interestingSocket(url) && !socket[WEBSOCKET_OBSERVED]) {
        socket[WEBSOCKET_OBSERVED] = true;
        const requestId = nextRequestId("ws");
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          if (event.data.length > MAX_NON_STREAM_BODY) return;
          emit({
            type: "page-capture",
            transport: "websocket",
            requestId,
            url: String(url),
            phase: "message",
            timestamp: Date.now(),
            data: event.data,
          });
        });
      }
      return socket;
    };

    const makeObserved = (UpstreamWebSocket) => {
      if (typeof UpstreamWebSocket !== "function") return UpstreamWebSocket;
      const Wrapped = wrap(UpstreamWebSocket);
      Wrapped.prototype = UpstreamWebSocket.prototype;
      Object.setPrototypeOf(Wrapped, UpstreamWebSocket);
      for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
        Object.defineProperty(Wrapped, key, { value: UpstreamWebSocket[key] });
      }
      return Wrapped;
    };

    observedWebSocket = makeObserved(window.WebSocket);
    try {
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        enumerable: true,
        get() {
          return observedWebSocket;
        },
        set(next) {
          if (next === observedWebSocket) return;
          observedWebSocket = makeObserved(next);
        },
      });
    } catch {
      window.WebSocket = observedWebSocket;
    }
  }

  function interestingSocket(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ""), location.href);
      const host = url.hostname.toLowerCase();
      return (
        host === "chatgpt.com" ||
        host.endsWith(".chatgpt.com") ||
        host === "openai.com" ||
        host.endsWith(".openai.com")
      );
    } catch {
      return false;
    }
  }

  const emitLocation = () => emit({ type: "page-location", url: location.href });
  const nativePushState = history.pushState;
  history.pushState = function slimgptPushState() {
    const result = nativePushState.apply(this, arguments);
    queueMicrotask(emitLocation);
    return result;
  };
  const nativeReplaceState = history.replaceState;
  history.replaceState = function slimgptReplaceState() {
    const result = nativeReplaceState.apply(this, arguments);
    queueMicrotask(emitLocation);
    return result;
  };
  addEventListener("popstate", emitLocation);
  queueMicrotask(emitLocation);

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;

    const takeoverFrame = document.getElementById(FRAME_ID);
    const takeoverOrigin = takeoverFrame?.src
      ? new URL(takeoverFrame.src, location.href).origin
      : null;
    if (
      takeoverFrame &&
      event.source === takeoverFrame.contentWindow &&
      event.origin === takeoverOrigin &&
      message.channel === UI_CHANNEL &&
      message.direction === "ui-to-bridge"
    ) {
      await handleUiCommand(message.payload);
      return;
    }

    if (event.source !== window || event.origin !== location.origin || message.channel !== CHANNEL) return;
    if (message.direction !== "extension-to-page") return;
    if (message.payload?.type === "request-status") {
      emitPageStatus();
      return;
    }
    if (message.payload?.type === "composer-command") await handleSendCommand(message.payload);
  });

  async function handleUiCommand(payload) {
    if (!payload || typeof payload !== "object") return;
    switch (payload.type) {
      case "request-status":
      case "connect":
        emitPageStatus();
        return;
      case "send-message":
        await handleSendCommand(payload);
        return;
      case "navigate-conversation": {
        const route = payload.route === "uc" ? "uc" : "c";
        navigate(`/${route}/${encodeURIComponent(payload.conversationId || "")}`);
        return;
      }
      case "new-chat":
        navigate("/");
        return;
      case "open-official":
      case "focus-authority":
        hideTakeover();
        return;
      default:
        return;
    }
  }

  function emitPageStatus() {
    emit({ type: "page-hook-ready", timestamp: Date.now(), url: location.href });
    emit({ type: "takeover-state", active: takeoverActive, url: location.href });
  }

  async function handleSendCommand(payload) {
    const commandId = payload?.commandId || crypto.randomUUID();
    if (sendInFlight) {
      emit({
        type: "composer-result",
        result: { ok: false, commandId, error: "send-in-progress" },
      });
      return;
    }

    sendInFlight = true;
    let result;
    try {
      officialFocusPermitDepth += 1;
      wakeOfficialUi();
      await waitForComposerElement(COMPOSER_WAKE_TIMEOUT);
      await nextAnimationFrame();
      result = await sendThroughOfficialComposer(payload?.text, commandId);
    } catch (error) {
      result = { ok: false, commandId, error: String(error?.message || error) };
    } finally {
      officialFocusPermitDepth = Math.max(0, officialFocusPermitDepth - 1);
      sendInFlight = false;
      scheduleRenderSleep();
      queueMicrotask(focusTakeoverFrame);
    }
    emit({ type: "composer-result", result });
  }

  function installRenderSleepStyle() {
    const mount = () => {
      if (!document.documentElement || document.getElementById(SLEEP_STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = SLEEP_STYLE_ID;
      style.textContent = `
        html[${SLEEP_ATTR}="1"] > body {
          visibility: hidden !important;
          content-visibility: hidden !important;
          pointer-events: none !important;
        }
      `;
      document.documentElement.appendChild(style);
    };

    if (document.documentElement) mount();
    else new MutationObserver((_, observer) => {
      if (!document.documentElement) return;
      observer.disconnect();
      mount();
    }).observe(document, { childList: true, subtree: true });
  }

  function scheduleInitialTakeover() {
    const schedule = async () => {
      // The current ChatGPT lightweight shell mounts its composer after
      // DOMContentLoaded. Keep both the official body and the takeover frame
      // usable until the composer exists; auth/challenge/consent pages must
      // fail open even when the composer is already mounted behind a modal.
      const ready = await waitForComposerElement(INITIAL_SHELL_READY_TIMEOUT);
      if (ready) showTakeover();
      else emit({ type: "takeover-state", active: false, reason: "composer-unavailable", url: location.href });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", schedule, { once: true });
    } else {
      void schedule();
    }
  }

  function sleepOfficialUi() {
    const frame = document.getElementById(FRAME_ID);
    if (!frame || frame.dataset.slimgptVisible !== "1") return;
    if (findBlockingOfficialUi()) {
      suspendTakeoverForBlocker();
      scheduleBlockedTakeoverRetry();
      return;
    }
    document.documentElement?.setAttribute(SLEEP_ATTR, "1");
  }

  function wakeOfficialUi() {
    document.documentElement?.removeAttribute(SLEEP_ATTR);
  }

  function scheduleRenderSleep(delay = 1200) {
    clearTimeout(resleepTimer);
    resleepTimer = setTimeout(sleepOfficialUi, delay);
  }

  function showTakeover() {
    const frame = document.getElementById(FRAME_ID);
    if (!frame) return;
    if (findBlockingOfficialUi()) {
      suspendTakeoverForBlocker();
      scheduleBlockedTakeoverRetry();
      return;
    }
    clearTimeout(blockedTakeoverRetryTimer);
    blockedTakeoverRetryTimer = null;
    takeoverActive = true;
    frame.dataset.slimgptVisible = "1";
    frame.style.pointerEvents = "auto";
    frame.style.opacity = "1";
    document.getElementById(RESTORE_ID)?.remove();
    emit({ type: "takeover-state", active: true, url: location.href });
    queueMicrotask(focusTakeoverFrame);
    scheduleRenderSleep(250);
    scheduleTakeoverBlockerGuard();
  }

  function suspendTakeoverForBlocker() {
    const frame = document.getElementById(FRAME_ID);
    clearTimeout(resleepTimer);
    resleepTimer = null;
    clearTimeout(takeoverBlockerGuardTimer);
    takeoverBlockerGuardTimer = null;
    wakeOfficialUi();
    takeoverActive = false;
    if (frame) {
      frame.dataset.slimgptVisible = "0";
      frame.style.pointerEvents = "none";
      frame.style.opacity = "0";
    }
    document.getElementById(RESTORE_ID)?.remove();
    emit({ type: "takeover-state", active: false, reason: "blocking-official-ui", url: location.href });
  }

  function scheduleBlockedTakeoverRetry() {
    if (blockedTakeoverRetryTimer) return;
    blockedTakeoverRetryTimer = setTimeout(() => {
      blockedTakeoverRetryTimer = null;
      if (!findComposerElement()) return;
      if (findBlockingOfficialUi()) {
        scheduleBlockedTakeoverRetry();
        return;
      }
      showTakeover();
    }, BLOCKED_TAKEOVER_RETRY_MS);
  }

  function scheduleTakeoverBlockerGuard() {
    clearTimeout(takeoverBlockerGuardTimer);
    takeoverBlockerGuardDeadline = Date.now() + TAKEOVER_BLOCKER_GUARD_MS;

    const guard = () => {
      takeoverBlockerGuardTimer = null;
      if (!takeoverActive) return;
      if (findBlockingOfficialUi()) {
        suspendTakeoverForBlocker();
        scheduleBlockedTakeoverRetry();
        return;
      }
      if (Date.now() >= takeoverBlockerGuardDeadline) return;
      takeoverBlockerGuardTimer = setTimeout(guard, 250);
    };

    takeoverBlockerGuardTimer = setTimeout(guard, 100);
  }

  function hideTakeover() {
    const frame = document.getElementById(FRAME_ID);
    if (!frame) return;
    clearTimeout(resleepTimer);
    clearTimeout(blockedTakeoverRetryTimer);
    clearTimeout(takeoverBlockerGuardTimer);
    blockedTakeoverRetryTimer = null;
    takeoverBlockerGuardTimer = null;
    wakeOfficialUi();
    takeoverActive = false;
    frame.dataset.slimgptVisible = "0";
    frame.style.pointerEvents = "none";
    frame.style.opacity = "0";
    emit({ type: "takeover-state", active: false, reason: "user", url: location.href });

    let restore = document.getElementById(RESTORE_ID);
    if (restore) return;
    restore = document.createElement("button");
    restore.id = RESTORE_ID;
    restore.type = "button";
    restore.textContent = "SlimGPT";
    Object.assign(restore.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "2147483647",
      border: "1px solid rgba(255,255,255,.25)",
      borderRadius: "999px",
      padding: "8px 12px",
      background: "#111",
      color: "#fff",
      font: "600 13px system-ui, sans-serif",
      boxShadow: "0 4px 20px rgba(0,0,0,.28)",
    });
    restore.addEventListener("click", () => {
      showTakeover();
    });
    document.documentElement.appendChild(restore);
  }

  function navigate(pathname) {
    const target = new URL(pathname, location.origin);
    if (target.origin !== location.origin) return;
    if (target.href === location.href) {
      emitLocation();
      return;
    }
    // Never click host anchors here: an unhandled anchor can fall through to a
    // real document navigation and tear down the takeover iframe. Route all
    // SlimGPT-initiated navigation through same-document history instead.
    navigateWithHistory(target);
  }

  function navigateWithHistory(target) {
    try {
      history.pushState(history.state, '', target.href);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    } catch (error) {
      emit({
        type: 'command-error',
        command: 'navigate-conversation',
        error: `无法在当前页面切换会话：${String(error?.message || error)}`,
      });
    }
  }

  async function sendThroughOfficialComposer(text, commandId) {
    const submittedText = String(text || "").trim();
    if (!submittedText) {
      return { ok: false, commandId, error: "empty-message" };
    }
    const composer = findComposer();
    if (!composer) {
      return { ok: false, commandId, error: "composer-not-found" };
    }

    try {
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (!setter) return { ok: false, commandId, error: "composer-input-unsupported" };
        setter.call(composer, submittedText);
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: submittedText }));
        composer.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const selection = getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand("insertText", false, submittedText);
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: submittedText }));
      }

      await nextAnimationFrame();
      await nextAnimationFrame();
      const actualText = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
        ? composer.value
        : composer.textContent;
      if (String(actualText || "").trim() !== submittedText) {
        return { ok: false, commandId, error: "composer-rejected-input" };
      }

      const sendButton = await waitForSendButton(composer, SEND_CONTROL_TIMEOUT);
      if (!sendButton) return { ok: false, commandId, error: "send-control-not-ready" };
      sendButton.click();
      return { ok: true, commandId, method: "button" };
    } catch (error) {
      return { ok: false, commandId, error: String(error?.message || error) };
    }
  }

  function findComposer() {
    const candidates = [
      document.querySelector("#mobile-composer-prompt"),
      document.querySelector('textarea[data-mobile-composer-prompt]'),
      document.querySelector("#prompt-textarea"),
      document.querySelector('textarea[name="prompt-textarea"]'),
      document.querySelector('textarea[placeholder*="Message"]'),
      document.querySelector('textarea[placeholder*="发消息"]'),
      document.querySelector('textarea[placeholder*="Ask"]'),
      document.querySelector('div[contenteditable="true"][data-virtualkeyboard="true"]'),
      ...document.querySelectorAll('div[contenteditable="true"]'),
    ].filter(Boolean);
    return candidates.find((element) => isVisible(element)) || null;
  }

  function findSendButton(composer) {
    const selectors = [
      '[data-composer-submit]',
      '[data-testid="send-button"]',
      '[data-testid="fruitjuice-send-button"]',
      '[data-testid="composer-send-button"]',
      '[data-testid*="send"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="Prompt"]',
      'form button[type="submit"]',
      'button[type="submit"]',
    ];
    const form = composer?.closest("form");
    const roots = form ? [form, document] : [document];
    for (const root of roots) {
      for (const selector of selectors) {
        const button = [...root.querySelectorAll(selector)].find(isUsableButton);
        if (button) return button;
      }
    }
    return null;
  }

  async function waitForSendButton(composer, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const button = findSendButton(composer);
      if (button) return button;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  function isUsableButton(element) {
    return (
      element instanceof HTMLButtonElement &&
      isVisible(element) &&
      !element.disabled &&
      element.getAttribute("aria-disabled") !== "true" &&
      !element.hasAttribute("data-visually-disabled")
    );
  }

  function findComposerElement() {
    return (
      document.querySelector("#mobile-composer-prompt") ||
      document.querySelector('textarea[data-mobile-composer-prompt]') ||
      document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[name="prompt-textarea"]') ||
      document.querySelector('textarea[placeholder*="Message"]') ||
      document.querySelector('textarea[placeholder*="发消息"]') ||
      document.querySelector('textarea[placeholder*="Ask"]') ||
      document.querySelector('div[contenteditable="true"][data-virtualkeyboard="true"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  function waitForComposerElement(timeoutMs) {
    const existing = findComposerElement();
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const observer = new MutationObserver(() => {
        const composer = findComposerElement();
        if (composer) finish(composer);
      });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        observer.disconnect();
        resolve(value);
      };
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
      timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  function findBlockingOfficialUi() {
    // A modal dialog puts the rest of the document in the browser's inert
    // top-layer state. On Firefox Android that inertness also prevents clicks
    // inside our extension iframe, even if the official body is visually
    // hidden. Detect :modal without a visibility check so it still works after
    // render sleep has hidden the body.
    try {
      const modal = document.querySelector(":modal");
      if (modal) return modal;
    } catch {
      // Older engines may not support :modal; fall through to DOM heuristics.
    }

    if (document.documentElement?.inert) return document.documentElement;
    if (document.body?.inert) return document.body;

    const selectors = [
      "dialog[open]",
      '[role="alertdialog"]',
      '[role="dialog"][aria-modal="true"]',
      "#onetrust-banner-sdk",
      "#onetrust-pc-sdk",
      "#onetrust-consent-sdk",
      '[id*="cookie" i][role="dialog"]',
      '[class*="cookie" i][role="dialog"]',
    ];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (isVisible(element)) return element;
      }
    }
    return null;
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function nextAnimationFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
})();
