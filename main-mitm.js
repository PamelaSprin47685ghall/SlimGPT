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
  let requestCounter = 0;
  let resleepTimer = null;
  let sendInFlight = false;
  let takeoverActive = false;
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
  scheduleInitialTakeover();
  emit({ type: "page-hook-ready", timestamp: Date.now(), url: location.href });

  let observedFetch = null;
  installFetchObserver();
  for (const delay of [0, 10, 50, 250, 1000, 3000]) {
    setTimeout(ensureFetchObserver, delay);
  }

  function installFetchObserver() {
    observedFetch = wrapFetch(window.fetch);
    window.fetch = observedFetch;
  }

  function ensureFetchObserver() {
    if (window.fetch === observedFetch) return;
    observedFetch = wrapFetch(window.fetch);
    window.fetch = observedFetch;
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
  ensureWebSocketObserver();

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

  function ensureWebSocketObserver() {
    if (!window.WebSocket || window.WebSocket === observedWebSocket) return;
    const UpstreamWebSocket = window.WebSocket;
    observedWebSocket = function ObservedWebSocket(url, protocols) {
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
    observedWebSocket.prototype = UpstreamWebSocket.prototype;
    Object.setPrototypeOf(observedWebSocket, UpstreamWebSocket);
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      Object.defineProperty(observedWebSocket, key, { value: UpstreamWebSocket[key] });
    }
    window.WebSocket = observedWebSocket;
  }

  const observerGuard = setInterval(() => {
    ensureFetchObserver();
    ensureXhrObserver();
    ensureWebSocketObserver();
  }, 1000);
  addEventListener("pagehide", () => clearInterval(observerGuard), { once: true });

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
      wakeOfficialUi();
      await waitForComposerElement(COMPOSER_WAKE_TIMEOUT);
      await nextAnimationFrame();
      result = await sendThroughOfficialComposer(payload?.text, commandId);
    } catch (error) {
      result = { ok: false, commandId, error: String(error?.message || error) };
    } finally {
      sendInFlight = false;
      scheduleRenderSleep();
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
      // usable until the composer exists; auth/challenge pages must fail open.
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
    if (!frame || frame.style.display === "none") return;
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
    takeoverActive = true;
    frame.style.display = "block";
    document.getElementById(RESTORE_ID)?.remove();
    emit({ type: "takeover-state", active: true, url: location.href });
    scheduleRenderSleep(250);
  }

  function hideTakeover() {
    const frame = document.getElementById(FRAME_ID);
    if (!frame) return;
    clearTimeout(resleepTimer);
    wakeOfficialUi();
    takeoverActive = false;
    frame.style.display = "none";
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
    location.assign(new URL(pathname, location.origin).href);
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
      document.querySelector('div[contenteditable="true"][data-virtualkeyboard="true"]'),
      ...document.querySelectorAll('div[contenteditable="true"]'),
    ].filter(Boolean);
    return candidates.find((element) => isVisible(element)) || null;
  }

  function findSendButton(composer) {
    const selectors = [
      '[data-composer-submit]',
      '[data-testid="send-button"]',
      'button[aria-label="发送消息"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
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
