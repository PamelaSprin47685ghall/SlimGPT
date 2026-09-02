(() => {
  if (window.__SLIMGPT_ISOLATED_BRIDGE__) return;
  window.__SLIMGPT_ISOLATED_BRIDGE__ = true;

  const PAGE_CHANNEL = 'slimgpt-page-v1';
  const UI_CHANNEL = 'slimgpt-ui-v1';
  const FRAME_ID = 'slimgpt-takeover-frame';
  const MAX_PENDING_UI_EVENTS = 512;
  const MAX_PENDING_UI_BYTES = 32 * 1024 * 1024;
  const STORAGE_KEYS = new Set([
    'conversationIndex',
    'observationLedger',
    'userSettings',
    'cachedModels',
    'executionPulse',
  ]);
  const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;
  const EXECUTION_PULSE_SOURCE = crypto.randomUUID?.() ||
    `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  let frame = null;
  let pageHookReady = false;
  let uiReady = false;
  let pendingUiBytes = 0;
  let droppedUiPayloads = 0;
  const pendingUiPayloads = [];

  installTakeoverFrame();
  installPageHookFallback();
  installStorageChangeForwarder();

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (
      event.source === frame?.contentWindow &&
      event.origin === EXTENSION_ORIGIN &&
      message.channel === UI_CHANNEL &&
      message.direction === 'ui-to-bridge' &&
      (message.payload?.type === 'storage-get' || message.payload?.type === 'storage-set')
    ) {
      void handleStorageCommand(message.payload);
      return;
    }

    if (
      event.source === window &&
      event.origin === location.origin &&
      message.channel === PAGE_CHANNEL &&
      message.direction === 'page-to-extension'
    ) {
      if (message.payload?.type === 'page-hook-ready') pageHookReady = true;
      forwardPagePayload(message.payload);
      if (message.payload?.type === 'page-execution-state') {
        void publishExecutionPulse(message.payload);
      }
      return;
    }
  });

  async function publishExecutionPulse(payload) {
    const conversationId = typeof payload?.conversationId === 'string'
      ? payload.conversationId.trim()
      : '';
    if (!conversationId || /^WEB:/i.test(conversationId) || !chrome.storage?.local) return;
    try {
      await chrome.storage.local.set({
        executionPulse: {
          source: EXECUTION_PULSE_SOURCE,
          nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
          payload: {
            type: 'page-execution-state',
            conversationId,
            state: payload.state === 'running' ? 'running' : 'stopped',
            source: String(payload.source || 'cross-window'),
            observedAt: Number(payload.observedAt) || Date.now(),
          },
        },
      });
    } catch {
      // Cross-window status is advisory; local execution state remains valid.
    }
  }

  function installStorageChangeForwarder() {
    const onChanged = (changes, areaName) => {
      if (areaName && areaName !== 'local') return;
      const values = {};
      for (const [key, change] of Object.entries(changes || {})) {
        if (!STORAGE_KEYS.has(key)) continue;
        values[key] = change?.newValue;
      }
      if (Object.keys(values).length) {
        forwardToUi({ type: 'storage-change', values });
      }
    };
    chrome.storage?.onChanged?.addListener(onChanged);
    addEventListener('pagehide', () => {
      chrome.storage?.onChanged?.removeListener?.(onChanged);
    }, { once: true });
  }

  async function handleStorageCommand(payload) {
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null;
    if (!requestId || !chrome.storage?.local) return;
    try {
      if (payload.type === 'storage-get') {
        const keys = Array.isArray(payload.keys)
          ? payload.keys.filter((key) => STORAGE_KEYS.has(key))
          : [];
        const values = await chrome.storage.local.get(keys);
        postToUi({ type: 'storage-result', requestId, ok: true, values });
        return;
      }

      const values = {};
      for (const [key, value] of Object.entries(payload.values || {})) {
        if (STORAGE_KEYS.has(key)) values[key] = value;
      }
      await chrome.storage.local.set(values);
      postToUi({ type: 'storage-result', requestId, ok: true, values: {} });
    } catch (error) {
      postToUi({
        type: 'storage-result',
        requestId,
        ok: false,
        error: String(error?.message || error),
      });
    }
  }

  function installTakeoverFrame() {
    const mount = () => {
      if (document.getElementById(FRAME_ID)) return;
      frame = document.createElement('iframe');
      frame.id = FRAME_ID;
      frame.src = chrome.runtime.getURL('index.html?takeover=1');
      frame.setAttribute('title', 'SlimGPT');
      frame.setAttribute('allow', 'clipboard-write');
      frame.dataset.slimgptVisible = '0';
      Object.assign(frame.style, {
        position: 'fixed',
        inset: '0',
        width: '100%',
        height: '100%',
        border: '0',
        margin: '0',
        padding: '0',
        zIndex: '2147483647',
        background: '#111',
        colorScheme: 'light dark',
        display: 'block',
        opacity: '0',
        pointerEvents: 'none',
        transition: 'opacity 90ms ease-out',
        willChange: 'opacity',
      });
      document.documentElement.appendChild(frame);
      frame.addEventListener('load', () => {
        uiReady = true;
        postToUi({
          type: 'status',
          bridgeReady: pageHookReady,
          takeover: frame.dataset.slimgptVisible === '1',
          captureMode: pageHookReady ? 'page' : null,
          pageUrl: location.href,
        });
        flushPendingUi();
      });
    };

    if (document.documentElement) mount();
    else new MutationObserver((_, observer) => {
      if (!document.documentElement) return;
      observer.disconnect();
      mount();
    }).observe(document, { childList: true, subtree: true });
  }

  function installPageHookFallback() {
    window.postMessage({
      channel: PAGE_CHANNEL,
      direction: 'extension-to-page',
      payload: { type: 'request-status' },
    }, location.origin);

    setTimeout(() => {
      if (pageHookReady) return;
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('main-mitm.js');
      script.async = false;
      script.dataset.slimgptFallback = '1';
      script.addEventListener('load', () => script.remove());
      script.addEventListener('error', () => {
        script.remove();
        forwardToUi({
          type: 'command-error',
          command: 'install-page-hook',
          error: '无法安装 page-world hook；当前浏览器可能不支持 SlimGPT 所需的 WebExtension 注入能力。',
        });
        forwardToUi({
          type: 'status',
          bridgeReady: false,
          bridgeError: true,
          takeover: false,
          captureMode: null,
          pageUrl: location.href,
        });
      });
      (document.head || document.documentElement).appendChild(script);
    }, 100);
  }

  function forwardToUi(payload) {
    if (!uiReady || !frame?.contentWindow) {
      queueForUi(payload);
      return;
    }
    postToUi(payload);
  }

  function postToUi(payload) {
    if (!frame?.contentWindow) return;
    const targetOrigin = new URL(frame.src).origin;
    frame.contentWindow.postMessage({
      channel: UI_CHANNEL,
      direction: 'bridge-to-ui',
      payload,
    }, targetOrigin);
  }

  function queueForUi(payload) {
    const size = typeof payload?.data === 'string' ? payload.data.length : 256;
    pendingUiPayloads.push({ payload, size });
    pendingUiBytes += size;

    while (
      pendingUiPayloads.length > MAX_PENDING_UI_EVENTS ||
      pendingUiBytes > MAX_PENDING_UI_BYTES
    ) {
      const dropped = pendingUiPayloads.shift();
      pendingUiBytes -= dropped?.size || 0;
      droppedUiPayloads += 1;
    }
  }

  function flushPendingUi() {
    if (!uiReady || !frame?.contentWindow) return;
    for (const item of pendingUiPayloads.splice(0)) postToUi(item.payload);
    pendingUiBytes = 0;
    if (droppedUiPayloads) {
      postToUi({ type: 'capture-warning', dropped: droppedUiPayloads });
      droppedUiPayloads = 0;
    }
  }

  function forwardPagePayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'page-capture') {
      forwardToUi({
        ...payload,
        type: 'canonical-capture',
        source: 'page',
      });
      return;
    }
    if (payload.type === 'page-location') {
      forwardToUi({ type: 'page-location', url: payload.url || location.href });
      return;
    }
    if (payload.type === 'composer-result') {
      forwardToUi({ type: 'composer-result', ...(payload.result || {}) });
      return;
    }
    if (payload.type === 'page-hook-ready') {
      forwardToUi({
        type: 'status',
        bridgeReady: true,
        takeover: frame?.style.display !== 'none',
        captureMode: 'page',
        pageUrl: payload.url || location.href,
      });
      return;
    }
    forwardToUi(payload);
  }
})();
