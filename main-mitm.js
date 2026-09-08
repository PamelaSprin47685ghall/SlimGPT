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
  const MAX_IDENTITY_BODY = 1024 * 1024;
  const INITIAL_SHELL_READY_TIMEOUT = 15_000;
  const COMPOSER_WAKE_TIMEOUT = 2_500;
  // This is only a watchdog. waitForSendButton is MutationObserver-driven and
  // resolves immediately when the official React composer flips its submit
  // control to enabled. Real Chrome currently crosses that boundary after the
  // previous 1.5s watchdog on a cold/new thread, so ending earlier races the
  // official state transition and falsely reports send-control-not-ready.
  const SEND_CONTROL_TIMEOUT = 5_000;
  const SEND_CONFIRM_TIMEOUT = 10_000;
  const COMPOSER_REHYDRATE_TIMEOUT = 10_000;
  const COMPLETE_RESPONSE_RECLICK_MS = 1_250;
  const RESUME_PATH = "/backend-api/f/conversation/resume";
  const RECONNECT_STORM_WINDOW_MS = 15_000;
  const RECONNECT_STORM_LIMIT = 6;
  const EXECUTION_DOM_SETTLE_MS = 220;
  const NEW_CHAT_EXECUTION_KEY = "__slimgpt_new_chat__";
  const MAX_EXECUTION_STATES = 256;
  const CONVERSATION_INDEX_PAGE_SIZE = 100;
  const CANONICAL_PAGE_TURNS = 10;
  const MAX_SYNCED_CONVERSATIONS = 500;
  let requestCounter = 0;
  let resleepTimer = null;
  let sendInFlight = false;
  let takeoverActive = false;
  let takeoverUserHidden = false;
  let officialUiHydrated = false;
  let renderSleepRequested = false;
  let officialFocusPermitDepth = 0;
  let lastContinueControl = null;
  let lastContinueClickAt = 0;
  let pendingSendConfirmation = null;
  let backendFetch = null;
  let backendFetchThis = null;
  let backendHeaders = null;
  let backendSessionHeaders = null;
  let conversationIndexSync = null;
  let conversationIndexSyncRequested = false;
  let conversationIndexBootstrapped = false;
  let turnSessionCounter = 0;
  let turnSubmissionOrdinal = 0;
  let pendingNewTurnSession = null;
  let suppressLocationEmission = false;
  let thinkingSync = Promise.resolve();
  let resumeGeneration = 0;
  let resumeSession = null;
  let conversationSocketGeneration = 0;
  let conversationSocketState = null;
  let observedLocationHref = null;
  let preserveDomConversationOwnership = () => {};
  let executionObserver = null;
  let executionScanTimer = null;
  let executionIdleTimer = null;
  let executionIdleCandidateKey = null;
  const canonicalFetches = new Map();
  const pendingCanonicalIds = new Set();
  const canonicalQueueGenerations = new Map();
  const canonicalAttemptedGenerations = new Map();
  const canonicalSyncedIds = new Set();
  const canonicalBackoffUntil = new Map();
  const canonicalFailureCounts = new Map();
  const activeTurnSessions = new Map();
  const turnSessionReservations = new Map();
  const executionStates = new Map();
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
      if (url.pathname.includes("/ces/v1/") || url.pathname.includes("/beacons/")) return false;
      if (/\/conversation\/(?:prepare|runtime)$/.test(url.pathname)) return false;
      return (
        url.pathname.includes("conversation") ||
        url.pathname.includes("messages") ||
        url.pathname.includes("history") ||
        url.pathname.includes("models") ||
        url.pathname.includes("/backend-api/me")
      );
    } catch {
      return false;
    }
  };

  const nextRequestId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
  const nextTurnSessionId = () => `turn-${Date.now().toString(36)}-${(++turnSessionCounter).toString(36)}`;

  installRenderSleepStyle();
  installFocusGuard();
  installCompleteResponse();
  installDomMessageObserver();
  installExecutionStateObserver();
  installBlockerObserver();
  scheduleInitialTakeover();

  let observedFetch = null;
  installFetchObserver();
  emit({ type: "page-hook-ready", timestamp: Date.now(), url: location.href });

  const resumeDisconnectedTransports = () => {
    reconnectResumeIfNeeded();
    reconnectConversationSocketIfNeeded();
    requestConversationIndexSync();
  };
  addEventListener("focus", resumeDisconnectedTransports);
  addEventListener("online", resumeDisconnectedTransports);
  addEventListener("load", maybeMarkOfficialUiHydrated, { once: true });
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resumeDisconnectedTransports();
  });
  addEventListener("pagehide", () => {
    resetResumeSession();
    resetConversationSocket();
  }, { once: true });

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
      'form button[data-testid*="continue" i]',
      'main button[data-testid*="continue" i]',
      'form button',
      'button',
    ];
    for (const selector of selectors) {
      for (const button of document.querySelectorAll(selector)) {
        if (isCompleteResponseControl(button)) return button;
      }
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
    let scanTimer = null;
    const seenText = new Map();
    const messageOwners = new WeakMap();
    const MAX_SEEN_MESSAGES = 120;

    preserveDomConversationOwnership = (conversationId) => {
      if (!conversationId) return;
      const nodes = document.querySelectorAll('[data-message-author-role]');
      for (let index = Math.max(0, nodes.length - 30); index < nodes.length; index += 1) {
        const roleNode = nodes[index];
        const messageRoot = roleNode.closest('[data-message-id]') || roleNode.querySelector?.('[data-message-id]');
        const ownerNode = messageRoot || roleNode;
        if (!messageOwners.has(ownerNode)) messageOwners.set(ownerNode, conversationId);
      }
    };

    const schedule = () => {
      if (scanTimer) return;
      scanTimer = setTimeout(scan, 350);
    };

    const scan = () => {
      scanTimer = null;
      maybeMarkOfficialUiHydrated();
      const match = location.pathname.match(/\/(?:c|uc)\/([^/?#]+)/);
      const pageConversationId = match?.[1] || null;
      if (!pageConversationId) return;

      const nodes = document.querySelectorAll('[data-message-author-role]');
      // Collect-then-emit: every capture carries its index/total within this
      // scan so consumers apply only the newest candidate as a preview
      // instead of cycling the sidebar oldest-to-newest through each event.
      const changedDomMessages = [];
      for (let i = Math.max(0, nodes.length - 15); i < nodes.length; i += 1) {
        const roleNode = nodes[i];
        const role = String(roleNode.getAttribute('data-message-author-role') || '').toLowerCase();
        if (!['user', 'assistant', 'tool'].includes(role)) continue;
        const messageRoot = roleNode.closest('[data-message-id]') || roleNode.querySelector?.('[data-message-id]');
        const messageId = messageRoot?.getAttribute?.('data-message-id') || roleNode.getAttribute('data-message-id');
        if (!messageId || /^request-placeholder(?:-|$)/i.test(messageId)) continue;
        const ownerNode = messageRoot || roleNode;
        const conversationId = messageOwners.get(ownerNode) || pageConversationId;
        if (!messageOwners.has(ownerNode)) messageOwners.set(ownerNode, conversationId);
        const text = String(roleNode.textContent || '').replace(/\u00a0/g, ' ').trim();
        const seenKey = `${conversationId}\u0000${messageId}`;
        if (!text.replace(/[\u200b-\u200d\ufeff]/g, '').trim() || seenText.get(seenKey) === text) continue;
        seenText.set(seenKey, text);
        if (seenText.size > MAX_SEEN_MESSAGES) {
          const oldest = seenText.keys().next().value;
          seenText.delete(oldest);
        }
        // DOM scans include old messages. The active transport says nothing
        // about the ownership of those nodes; only their stable message id
        // may connect this low-fidelity fallback to a protocol item.
        changedDomMessages.push({ conversationId, messageId, role, text });
      }
      changedDomMessages.forEach((changed, domMessageIndex) => {
        emit({
          type: "page-capture",
          transport: "dom",
          phase: "message",
          requestId: `dom-${changed.messageId}`,
          url: location.href,
          conversationId: changed.conversationId,
          mimeType: "application/json",
          timestamp: Date.now(),
          // Ordered oldest-to-newest within this scan batch: the UI must
          // preview only the latest candidate, never one per event.
          domMessageIndex,
          domMessageTotal: changedDomMessages.length,
          data: JSON.stringify({
            conversation_id: changed.conversationId,
            message: {
              id: changed.messageId,
              author: { role: changed.role },
              content: { content_type: "text", parts: [changed.text] },
              // The DOM never knows the stream lifecycle: claiming
              // in_progress here regresses already-finished messages. The
              // UI merge preserves richer state from real stream events.
              status: null,
              end_turn: null,
            },
          }),
        });
      });
    };

    const mount = () => {
      if (!document.documentElement || observer) return;
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
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
    addEventListener("pagehide", () => {
      clearTimeout(scanTimer);
      observer?.disconnect();
    }, { once: true });
  }

  function executionKey(conversationId) {
    return conversationId || NEW_CHAT_EXECUTION_KEY;
  }

  function executionConversationIdFromUrl(rawUrl = location.href) {
    return conversationIdFromUrl(rawUrl) || null;
  }

  function emitExecutionState(state, source, conversationId = executionConversationIdFromUrl(), extra = {}) {
    if (!['running', 'stopped', 'unknown'].includes(state)) return;
    const key = executionKey(conversationId);
    const now = Date.now();
    const previous = executionStates.get(key) || null;

    if (state === 'stopped' && source === 'dom-composer-ready') {
      const activeTurn = conversationId
        ? activeTurnSessions.get(conversationId)
        : pendingNewTurnSession;
      // SlimGPT gives the hidden renderer a low-cost semantic stream. Composer
      // readiness can precede the captured server lifecycle, so it cannot
      // declare the logical turn stopped while the intercepted turn is active.
      if (activeTurn) return;
    }

    const next = {
      state,
      source,
      observedAt: now,
      conversationId,
      url: location.href,
    };
    executionStates.set(key, next);
    if (executionStates.size > MAX_EXECUTION_STATES) {
      for (const candidateKey of executionStates.keys()) {
        if (candidateKey === key) continue;
        executionStates.delete(candidateKey);
        break;
      }
    }
    if (previous?.state === state && previous?.source === source) return;
    emit({
      type: 'page-execution-state',
      state,
      source,
      timestamp: now,
      url: location.href,
      ...(conversationId ? { conversationId } : {}),
      ...extra,
    });
  }

  function markExecutionUnknownIfActive(conversationId, source) {
    const current = executionStates.get(executionKey(conversationId));
    if (current?.state === 'running') emitExecutionState('unknown', source, conversationId);
  }

  function installExecutionStateObserver() {
    const schedule = () => scheduleExecutionStateScan();
    const mount = () => {
      if (!document.documentElement || executionObserver) return;
      executionObserver = new MutationObserver(schedule);
      executionObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'aria-disabled', 'data-testid', 'data-composer-submit', 'disabled', 'hidden'],
      });
      scheduleExecutionStateScan(0);
    };
    if (document.documentElement) mount();
    else new MutationObserver((_, observer) => {
      if (!document.documentElement) return;
      observer.disconnect();
      mount();
    }).observe(document, { childList: true, subtree: true });
    addEventListener('popstate', () => scheduleExecutionStateScan(0));
    addEventListener('pagehide', () => {
      clearTimeout(executionScanTimer);
      clearTimeout(executionIdleTimer);
      executionObserver?.disconnect();
      executionObserver = null;
    }, { once: true });
  }

  function scheduleExecutionStateScan(delay = 45) {
    clearTimeout(executionScanTimer);
    executionScanTimer = setTimeout(() => {
      executionScanTimer = null;
      scanExecutionState();
    }, Math.max(0, delay));
  }

  function scanExecutionState() {
    const composer = findComposerElement();
    if (!composer) return;
    const conversationId = executionConversationIdFromUrl();
    const key = executionKey(conversationId);
    if (findExecutionStopControl(composer)) {
      clearTimeout(executionIdleTimer);
      executionIdleTimer = null;
      executionIdleCandidateKey = null;
      emitExecutionState('running', 'dom-stop-control', conversationId);
      return;
    }

    if (executionIdleCandidateKey !== key) {
      clearTimeout(executionIdleTimer);
      executionIdleCandidateKey = key;
      executionIdleTimer = setTimeout(() => {
        executionIdleTimer = null;
        executionIdleCandidateKey = null;
        const currentComposer = findComposerElement();
        if (!currentComposer) return;
        const currentConversationId = executionConversationIdFromUrl();
        if (executionKey(currentConversationId) !== key || findExecutionStopControl(currentComposer)) return;
        emitExecutionState('stopped', 'dom-composer-ready', currentConversationId);
      }, EXECUTION_DOM_SETTLE_MS);
    }
  }

  function findExecutionStopControl(composer) {
    const form = composer.closest?.('form');
    const roots = [];
    if (form) roots.push(form);
    let ancestor = form || composer.parentElement;
    for (let depth = 0; ancestor && ancestor !== document.body && depth < 3; depth += 1) {
      if (!roots.includes(ancestor)) roots.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    if (!roots.length && composer.parentElement) roots.push(composer.parentElement);

    for (const root of roots) {
      for (const button of root.querySelectorAll?.('button') || []) {
        if (!(button instanceof HTMLButtonElement)) continue;
        if (button.hidden || button.getAttribute('aria-hidden') === 'true') continue;
        const testId = String(button.getAttribute('data-testid') || '').trim();
        const label = [
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.textContent,
        ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        if (/^(?:stop|cancel)(?:[-_ ].*)?$/i.test(testId)) return button;
        if (/^(?:stop(?: generating| generation| response| response generation| streaming| thinking)?|cancel(?: generation| response| streaming)?|停止(?:生成|回答|回复|思考)?|取消(?:生成|回答|回复|思考)?)[.!。…\s]*$/i.test(label)) return button;
      }
    }
    return null;
  }

  function wrapFetch(upstreamFetch) {
    return async function slimgptObservedFetch(input, init) {
      const fetchThis = this;
      const request = observedRequest(input, init);
      if (request) observeBackendRequest(request, upstreamFetch, fetchThis);
      const conversationScope = request ? snapshotConversationScope(request) : null;
      const submission = request && isConversationSubmission(request);
      const turnScope = submission
        ? snapshotSubmissionTurn(request, conversationScope)
        : (request && isResumeRequest(request) ? snapshotActiveTurn(conversationScope, readRequestTurnIdentity(request)) : null);
      const resumeSnapshot = request && isResumeRequest(request)
        ? snapshotRequest(request, upstreamFetch, fetchThis, conversationScope, turnScope)
        : null;

      let response;
      try {
        response = await Reflect.apply(upstreamFetch, fetchThis, arguments);
      } catch (error) {
        if (submission) {
          settleSendConfirmation(false, "request-failed");
          void releaseTurnSession(turnScope);
        }
        throw error;
      }
      if (submission) {
        settleSendConfirmation(response.ok, response.ok ? "request-accepted" : `http-${response.status}`);
        if (!response.ok) void releaseTurnSession(turnScope);
      }
      queueMicrotask(maybeMarkOfficialUiHydrated);

      const url = response.url || request?.url || (typeof input === "string" ? input : input?.url);
      if (!interesting(url)) return response;
      if (observedFetchResponses.has(response)) return response;
      observedFetchResponses.add(response);

      const requestId = nextRequestId("fetch");
      const mimeType = response.headers.get("content-type") || "";
      const divertOfficialStream = shouldDivertOfficialConversationStream(response, url, mimeType);
      let captureResponse = response;
      if (!divertOfficialStream) {
        try {
          captureResponse = response.clone();
        } catch {
          return response;
        }
      }

      const divertResume = Boolean(resumeSnapshot && divertOfficialStream);
      let resumeGenerationForCapture = null;
      if (divertResume) resumeGenerationForCapture = adoptResumeRequest(resumeSnapshot);
      const captureMeta = {
        requestId,
        url,
        status: response.status,
        mimeType,
        conversationScope,
        turnScope,
        conversationRequest: Boolean(submission),
      };

      let captureDone = null;
      let officialSemanticStream = null;
      if (mimeType.includes("text/vnd.openai.web-mobile-partial+html") && captureResponse.body) {
        captureDone = captureWebMobileStream(captureResponse.body, captureMeta);
      } else if (mimeType.includes("text/event-stream") && captureResponse.body) {
        officialSemanticStream = divertOfficialStream ? createOfficialSemanticStream() : null;
        const streamMeta = { ...captureMeta, officialSemanticStream };
        if (divertResume) {
          streamMeta.resume = true;
          streamMeta.cancelSignal = resumeSession?.generation === resumeGenerationForCapture
            ? resumeSession.controller?.signal
            : null;
          streamMeta.onClose = (result) => handleResumeStreamClose(resumeGenerationForCapture, result);
        }
        captureDone = captureReadableStream(captureResponse.body, streamMeta);
      } else {
        const declaredLength = Number(response.headers.get("content-length") || 0);
        if (!declaredLength || declaredLength <= MAX_NON_STREAM_BODY) {
          void captureBoundedResponse(captureResponse, captureMeta);
        }
      }

      return divertOfficialStream
        ? completeOfficialStream(response, officialSemanticStream?.readable, captureDone)
        : response;
    };
  }

  function observedRequest(input, init) {
    try {
      const source = input instanceof Request ? input.clone() : input;
      return new Request(source, init);
    } catch {
      return null;
    }
  }

  function requestUrl(request) {
    try {
      return new URL(request.url, location.href);
    } catch {
      return null;
    }
  }

  function snapshotConversationScope(request) {
    const endpointConversationId = conversationIdFromUrl(request?.url);
    const pageConversationId = isConversationSubmission(request) || isResumeRequest(request)
      ? conversationIdFromUrl(location.href)
      : null;
    const bodyConversationId = isConversationSubmission(request) || isResumeRequest(request)
      ? readRequestConversationId(request)
      : Promise.resolve(null);
    return bodyConversationId.then((bodyId) => {
      const stableBodyId = isProvisionalConversationId(bodyId) ? null : bodyId;
      if (stableBodyId && endpointConversationId && stableBodyId !== endpointConversationId) {
        return { conversationId: null, conflicted: true };
      }
      return {
        conversationId: stableBodyId || endpointConversationId || pageConversationId,
        ...(isProvisionalConversationId(bodyId) ? { provisionalConversationId: bodyId } : {}),
        conflicted: false,
      };
    });
  }

  async function readRequestConversationId(request) {
    if (!request || !["POST", "PUT", "PATCH"].includes(request.method.toUpperCase())) return null;
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_IDENTITY_BODY) return null;
    try {
      const text = await request.clone().text();
      if (text.length > MAX_IDENTITY_BODY) return null;
      return conversationIdFromRequestBody(text);
    } catch {
      return null;
    }
  }

  async function snapshotSubmissionTurn(request, conversationScope) {
    const session = {
      sessionId: nextTurnSessionId(),
      submissionOrdinal: ++turnSubmissionOrdinal,
      scopePending: true,
      transportTurnId: request?.headers?.get?.("x-oai-turn-trace-id") || null,
      turnId: null,
      turnAliases: [],
      turnExchangeId: null,
      workingTurnId: null,
      requestId: null,
      turnTraceId: null,
      conversationId: null,
      userMessageId: null,
      parentMessageId: null,
      startedAt: Date.now(),
    };
    if (!session.transportTurnId) session.transportTurnId = session.sessionId;
    registerTurnSession(session);
    const [scope, identity] = await Promise.all([
      conversationScope?.catch(() => ({ conversationId: null, conflicted: true })) ||
        Promise.resolve({ conversationId: null, conflicted: false }),
      readRequestTurnIdentity(request),
    ]);
    session.scopePending = false;
    session.scopeConflicted = Boolean(scope?.conflicted);
    if (!scope?.conflicted && scope?.conversationId) {
      session.conversationId = scope.conversationId;
    }
    if (identity?.userMessageId) session.userMessageId = identity.userMessageId;
    if (identity?.parentMessageId) session.parentMessageId = identity.parentMessageId;
    if (identity?.turnId) session.turnId = identity.turnId;
    if (identity?.turnAliases?.length) session.turnAliases = identity.turnAliases;
    if (identity?.turnExchangeId) session.turnExchangeId = identity.turnExchangeId;
    if (identity?.workingTurnId) session.workingTurnId = identity.workingTurnId;
    if (identity?.requestId) session.requestId = identity.requestId;
    if (identity?.turnTraceId) session.turnTraceId = identity.turnTraceId;
    registerTurnSession(session);
    return session;
  }

  async function snapshotActiveTurn(conversationScope, requestIdentity = null) {
    // Capture at request entry, not after an awaited body parse. Otherwise a
    // later submission can lend its identity to an older resume request.
    const atRequest = new Map([...activeTurnSessions].map(([id, session]) => [id, {
      ...session, turnAliases: session.turnAliases.slice(),
    }]));
    const reservedAtRequest = [...turnSessionReservations.values()].map((session) => ({ ...session, turnAliases: session.turnAliases.slice() }));
    const scope = await (conversationScope?.catch(() => ({ conversationId: null, conflicted: false })) ||
      Promise.resolve({ conversationId: null, conflicted: false }));
    if (scope?.conflicted) return null;
    const conversationId = scope?.conversationId || null;
    const identity = await Promise.resolve(requestIdentity).catch(() => null);
    if (identity?.userMessageId || identity?.turnAliases?.length) {
      const matching = reservedAtRequest.filter((session) => session.conversationId === conversationId &&
        notificationMatchesTurnSession({ ...identity, turnUserMessageId: identity.userMessageId }, session));
      // Multiple regenerations may share a user id. Do not break that tie by
      // timestamp or by whichever request happens to be active now.
      return matching.length === 1 ? matching[0] : null;
    }
    // A conversation id alone is never evidence that a pending new chat owns
    // it. Binding belongs to correlated message/turn events or official route.
    return conversationId ? atRequest.get(conversationId) || null : null;
  }

  async function readRequestTurnIdentity(request) {
    if (!request || !["POST", "PUT", "PATCH"].includes(request.method.toUpperCase())) return null;
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_IDENTITY_BODY) return null;
    try {
      const text = await request.clone().text();
      if (text.length > MAX_IDENTITY_BODY) return null;
      return turnIdentityFromRequestBody(text);
    } catch {
      return null;
    }
  }

  function turnIdentityFromRequestBody(body) {
    let value = body;
    if (typeof body === "string") {
      const text = body.trim();
      if (!text) return null;
      try {
        value = JSON.parse(text);
      } catch {
        return null;
      }
    }
    if (!value || typeof value !== "object") return null;
    const messages = Array.isArray(value.messages) ? value.messages : [];
    const userMessage = [...messages].reverse().find((message) => message?.author?.role === "user") ||
      (value.partial_query?.author?.role === "user" ? value.partial_query : null);
    const userMessageId = userMessage?.id || value.user_message_id || value.userMessageId || null;
    const parentMessageId = value.parent_message_id || value.parentMessageId || userMessage?.parent_id || null;
    const metadata = userMessage?.metadata && typeof userMessage.metadata === "object"
      ? userMessage.metadata
      : {};
    const turnExchangeId = firstTurnIdentityString(
      metadata.turn_exchange_id,
      metadata.turnExchangeId,
      userMessage?.turn_exchange_id,
      userMessage?.turnExchangeId,
      value.turn_exchange_id,
      value.turnExchangeId,
      value.metadata?.turn_exchange_id,
    );
    const workingTurnId = firstTurnIdentityString(
      metadata.working_turn_id,
      metadata.workingTurnId,
      userMessage?.working_turn_id,
      userMessage?.workingTurnId,
      value.working_turn_id,
      value.workingTurnId,
      value.metadata?.working_turn_id,
    );
    const requestId = firstTurnIdentityString(
      metadata.request_id,
      metadata.requestId,
      userMessage?.request_id,
      userMessage?.requestId,
      value.request_id,
      value.requestId,
      value.metadata?.request_id,
    );
    const turnTraceId = firstTurnIdentityString(
      metadata.turn_trace_id,
      metadata.turnTraceId,
      userMessage?.turn_trace_id,
      userMessage?.turnTraceId,
      value.turn_trace_id,
      value.turnTraceId,
      value.metadata?.turn_trace_id,
    );
    const turnAliases = uniqueTurnIdentityStrings([
      turnExchangeId,
      workingTurnId,
      requestId,
      turnTraceId,
    ]);
    return {
      userMessageId: typeof userMessageId === "string" && userMessageId ? userMessageId : null,
      parentMessageId: typeof parentMessageId === "string" && parentMessageId ? parentMessageId : null,
      turnId: turnAliases[0] || null,
      turnAliases,
      turnExchangeId,
      workingTurnId,
      requestId,
      turnTraceId,
    };
  }

  function firstTurnIdentityString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  function uniqueTurnIdentityStrings(values) {
    const output = [];
    const seen = new Set();
    for (const value of values || []) {
      if (typeof value !== "string") continue;
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      output.push(normalized);
    }
    return output;
  }

  function registerTurnSession(session) {
    if (!session?.sessionId) return;
    turnSessionReservations.set(session.sessionId, session);
    while (turnSessionReservations.size > MAX_EXECUTION_STATES) {
      turnSessionReservations.delete(turnSessionReservations.keys().next().value);
    }
    if (session.scopePending || session.scopeConflicted || session.released) return;
    // Registration order is a local transport ordering key, never a persisted
    // semantic turn id. Slow decoding of an older request cannot go backwards.
    for (const other of turnSessionReservations.values()) {
      if (!other.scopePending && !other.scopeConflicted &&
          other.conversationId === session.conversationId && other.submissionOrdinal > session.submissionOrdinal) return;
    }
    if (session.conversationId) {
      activeTurnSessions.set(session.conversationId, session);
      if (activeTurnSessions.size > MAX_EXECUTION_STATES) {
        const oldest = activeTurnSessions.keys().next().value;
        activeTurnSessions.delete(oldest);
      }
      return;
    }
    pendingNewTurnSession = session;
  }

  async function releaseTurnSession(turnScope) {
    const session = await Promise.resolve(turnScope).catch(() => null);
    if (!session?.sessionId) return;
    const reserved = turnSessionReservations.get(session.sessionId);
    if (reserved) reserved.released = true;
    if (session.conversationId && activeTurnSessions.get(session.conversationId)?.sessionId === session.sessionId) {
      activeTurnSessions.delete(session.conversationId);
    }
    if (pendingNewTurnSession?.sessionId === session.sessionId) pendingNewTurnSession = null;
  }

  function bindPendingTurnSession(conversationId) {
    if (!conversationId || !pendingNewTurnSession) return null;
    const session = pendingNewTurnSession;
    if (session.scopePending || session.scopeConflicted || session.released) return null;
    const existing = activeTurnSessions.get(conversationId);
    if (existing && existing.sessionId !== session.sessionId) return null;
    pendingNewTurnSession = null;
    session.conversationId = conversationId;
    activeTurnSessions.set(conversationId, session);
    requestConversationIndexSync();
    const pendingExecution = executionStates.get(NEW_CHAT_EXECUTION_KEY);
    if (pendingExecution) {
      executionStates.delete(NEW_CHAT_EXECUTION_KEY);
      emitExecutionState(
        pendingExecution.state,
        pendingExecution.source || "conversation-bound",
        conversationId,
        { boundFromNewChat: true },
      );
    }
    return session;
  }

  function observeCapturedTurn(value, capture) {
    const session = turnSessionReservations.get(capture?.transportSessionId);
    const message = value?.message;
    if (!session || session.scopePending || session.scopeConflicted || session.released ||
        !message || typeof message !== 'object' || !message.id || !message.author) return;
    const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
    const userId = firstTurnIdentityString(message.turn_user_message_id, metadata.turn_user_message_id,
      message.author.role === 'user' ? message.id : null);
    if (userId && session.userMessageId && userId !== session.userMessageId) return;
    const conversationIds = uniqueTurnIdentityStrings([
      value.conversation_id, value.conversationId, message.conversation_id, message.conversationId,
      session.conversationId,
    ]).filter((id) => !isProvisionalConversationId(id));
    if (conversationIds.length > 1) return;
    const exchange = firstTurnIdentityString(metadata.turn_exchange_id, message.turn_exchange_id);
    if (exchange && session.turnExchangeId && exchange !== session.turnExchangeId) return;
    const working = firstTurnIdentityString(metadata.working_turn_id, message.working_turn_id);
    const requestId = firstTurnIdentityString(metadata.request_id, message.request_id);
    const trace = firstTurnIdentityString(metadata.turn_trace_id, message.turn_trace_id);
    session.turnAliases = uniqueTurnIdentityStrings([...session.turnAliases, exchange, working, requestId, trace]);
    session.turnId ||= session.turnAliases[0] || null;
    session.turnExchangeId ||= exchange;
    session.workingTurnId ||= working;
    session.requestId ||= requestId;
    session.turnTraceId ||= trace;
    session.userMessageId ||= userId;
    // This association is proven by the exact captured submission transport,
    // unlike a broadcast for an arbitrary conversation elsewhere in the account.
    const conversationId = conversationIds[0];
    if (conversationId && !session.conversationId) {
      if (pendingNewTurnSession?.sessionId === session.sessionId) bindPendingTurnSession(conversationId);
      else { session.conversationId = conversationId; registerTurnSession(session); }
    }
  }

  function conversationIdFromRequestBody(body) {
    let value = body;
    if (typeof body === "string") {
      const text = body.trim();
      if (!text) return null;
      try {
        value = JSON.parse(text);
      } catch {
        try {
          return new URLSearchParams(text).get("conversation_id") ||
            new URLSearchParams(text).get("conversationId") ||
            null;
        } catch {
          return null;
        }
      }
    } else if (body instanceof URLSearchParams || body instanceof FormData) {
      const field = body.get("conversation_id") || body.get("conversationId");
      return typeof field === "string" && field.trim() ? field.trim() : null;
    }
    const direct = value?.conversation_id || value?.conversationId;
    return typeof direct === "string" && direct.trim() ? direct.trim() : null;
  }

  async function resolveCaptureMeta(meta) {
    const { conversationScope, turnScope, ...captureMeta } = meta;
    const scope = conversationScope
      ? await conversationScope.catch(() => ({ conversationId: null, conflicted: false }))
      : { conversationId: null, conflicted: false };
    const turn = turnScope
      ? await Promise.resolve(turnScope).catch(() => null)
      : null;
    if (scope.conflicted) return { ...captureMeta, conversationIdConflict: true };
    const resolvedConversationId = scope.conversationId || turn?.conversationId || null;
    const resolved = resolvedConversationId
      ? { ...captureMeta, conversationId: resolvedConversationId }
      : { ...captureMeta };
    if (scope.provisionalConversationId) resolved.provisionalConversationId = scope.provisionalConversationId;
    if (turn?.turnId) resolved.turnId = turn.turnId;
    if (turn?.turnAliases?.length) resolved.turnAliases = turn.turnAliases.slice();
    if (turn?.sessionId) resolved.transportSessionId = turn.sessionId;
    if (turn?.transportTurnId) resolved.transportTurnId = turn.transportTurnId;
    if (turn?.turnExchangeId) resolved.turnExchangeId = turn.turnExchangeId;
    if (turn?.workingTurnId) resolved.workingTurnId = turn.workingTurnId;
    if (turn?.requestId) resolved.turnRequestId = turn.requestId;
    if (turn?.turnTraceId) resolved.turnTraceId = turn.turnTraceId;
    if (turn?.userMessageId) resolved.turnUserMessageId = turn.userMessageId;
    if (turn?.parentMessageId) resolved.turnParentMessageId = turn.parentMessageId;
    return resolved;
  }

  function isResumeRequest(request) {
    const url = requestUrl(request);
    return Boolean(url && url.origin === location.origin && url.pathname === RESUME_PATH);
  }

  function isConversationSubmission(request) {
    if (request.method.toUpperCase() !== "POST") return false;
    const url = requestUrl(request);
    return Boolean(
      url &&
      url.origin === location.origin &&
      (url.pathname === "/backend-api/conversation" || url.pathname === "/backend-api/f/conversation")
    );
  }

  function observeBackendRequest(request, upstreamFetch, fetchThis) {
    const url = requestUrl(request);
    if (!url || url.origin !== location.origin || !url.pathname.startsWith("/backend-api/")) return;
    backendFetch = upstreamFetch;
    backendFetchThis = fetchThis;
    backendSessionHeaders = new Headers(request.headers);
    if (request.headers.get("authorization")) {
      backendHeaders = new Headers(request.headers);
    }
    drainCanonicalFetches();
    // Bootstrap-only: once bootstrapped, backend traffic must never trigger
    // index syncs on its own. Refreshes go through requestConversationIndexSync
    // (cooldown-gated, first-page-only) from completion handlers instead.
    // Even pre-bootstrap, background request bursts share one sync: force
    // bypasses the cooldown inside requestConversationIndexSync, so gate here
    // and never spam while a sync is already in flight (drain coalesces via
    // conversationIndexSyncRequested and re-drains once on settle).
    if (!conversationIndexBootstrapped && !conversationIndexSync) {
      requestConversationIndexSync({ force: true });
    }
  }

  let lastIndexSyncAttemptAt = 0;
  // Lower bound for index refreshes: stream completions, focus/online events
  // and turn-stop notifications all funnel through requestConversationIndexSync,
  // so rapid-fire triggers coalesce instead of storming /conversations.
  const INDEX_SYNC_COOLDOWN_MS = 10_000;
  function requestConversationIndexSync(options = {}) {
    const force = options === true || Boolean(options?.force);
    const now = Date.now();
    if (!force && conversationIndexBootstrapped && now - lastIndexSyncAttemptAt < INDEX_SYNC_COOLDOWN_MS) {
      return;
    }
    lastIndexSyncAttemptAt = now;
    conversationIndexSyncRequested = true;
    drainConversationIndexSync(options);
  }

  function drainConversationIndexSync(options = {}) {
    const sourceHeaders = backendHeaders || backendSessionHeaders || new Headers();
    if (!conversationIndexSyncRequested || conversationIndexSync || !backendFetch || !sourceHeaders) return;
    conversationIndexSyncRequested = false;
    const fullSync = !conversationIndexBootstrapped || options === true || Boolean(options?.force);
    conversationIndexSync = syncConversationIndex(new Headers(sourceHeaders), fullSync)
      .then((synced) => {
        conversationIndexBootstrapped = Boolean(synced);
      })
      .catch(() => {
        // A failed refresh must never un-bootstrap already-loaded data: that
        // would turn one transient error into a cascade of immediate full
        // syncs. Keep serving the cache; the cooldown timestamps the retry.
        if (conversationIndexBootstrapped) lastIndexSyncAttemptAt = Date.now();
      })
      .finally(() => {
        conversationIndexSync = null;
        if (conversationIndexSyncRequested) drainConversationIndexSync();
      });
  }

  async function syncConversationIndex(sourceHeaders, fullSync = true) {
    const headers = new Headers(sourceHeaders);
    headers.delete("content-length");
    headers.delete("content-type");
    headers.set("accept", "application/json");

    const items = [];
    const itemIds = new Set();
    const publish = (complete) => {
      if (items.length || complete) {
        emit({
          type: "page-conversation-index",
          items,
          complete,
          timestamp: Date.now(),
        });
      }
      return complete || items.length > 0;
    };

    let offset = 0;
    const seenPages = new Set();
    const maxSyncItems = fullSync ? MAX_SYNCED_CONVERSATIONS : CONVERSATION_INDEX_PAGE_SIZE;
    while (offset < maxSyncItems) {
      const limit = Math.min(CONVERSATION_INDEX_PAGE_SIZE, maxSyncItems - offset);
      const url = new URL("/backend-api/conversations", location.origin);
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("order", "updated");

      const response = await Reflect.apply(backendFetch, backendFetchThis, [
        url.href,
        {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: new Headers(headers),
        },
      ]);
      if (!response.ok) return publish(false);

      const text = await response.text();
      if (text.length > MAX_NON_STREAM_BODY) return publish(false);

      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return publish(false);
      }
      const pageItems = Array.isArray(value?.items)
        ? value.items
        : (Array.isArray(value?.data?.items) ? value.data.items : []);
      if (!pageItems.length) return publish(true);

      const firstId = pageItems[0]?.id || '';
      const lastId = pageItems[pageItems.length - 1]?.id || '';
      const pageSignature = `${pageItems.length}:${firstId}:${lastId}`;
      if (seenPages.has(pageSignature)) return publish(false);
      seenPages.add(pageSignature);

      for (const item of pageItems) {
        const id = typeof item?.id === "string" ? item.id : "";
        if (!id || itemIds.has(id)) continue;
        itemIds.add(id);
        items.push(item);
      }

      offset += pageItems.length;
      const rawTotal = value?.total ?? value?.data?.total;
      const total = rawTotal == null ? Number.NaN : Number(rawTotal);
      if (Number.isFinite(total) && offset >= total) return publish(true);
      const hasMore = value?.has_more ?? value?.hasMore ?? value?.data?.has_more ?? value?.data?.hasMore;
      if (hasMore === false) return publish(true);
    }
    return publish(false);
  }

  function snapshotRequest(request, upstreamFetch, fetchThis, conversationScope, turnScope = null) {
    const method = request.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;
    const bodyPromise = hasBody
      ? request.clone().arrayBuffer().catch(() => null)
      : Promise.resolve(null);
    return {
      url: request.url,
      method,
      headers: new Headers(request.headers),
      credentials: request.credentials,
      cache: request.cache,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      hasBody,
      bodyPromise,
      upstreamFetch,
      fetchThis,
      conversationScope,
      turnScope,
    };
  }

  async function requestFromSnapshot(snapshot, signal) {
    const body = await snapshot.bodyPromise;
    if (snapshot.hasBody && body === null) throw new Error("resume-body-unavailable");
    const init = {
      method: snapshot.method,
      headers: new Headers(snapshot.headers),
      credentials: snapshot.credentials,
      cache: snapshot.cache,
      redirect: snapshot.redirect,
      referrer: snapshot.referrer,
      referrerPolicy: snapshot.referrerPolicy,
      integrity: snapshot.integrity,
      keepalive: snapshot.keepalive,
      mode: snapshot.mode,
      signal,
    };
    if (body !== null) init.body = body.slice(0);
    return new Request(snapshot.url, init);
  }

  function shouldDivertOfficialConversationStream(response, rawUrl, mimeType) {
    if (
      !takeoverActive ||
      !response.ok ||
      !response.body ||
      !String(mimeType).includes("text/event-stream")
    ) {
      return false;
    }
    try {
      const url = new URL(String(rawUrl || ""), location.href);
      return (
        url.origin === location.origin &&
        /^\/backend-api\/(?:f\/)?conversation(?:\/resume)?$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }

  // The official renderer is fragile with long-lived streams. SlimGPT owns
  // the real resume response while the official consumer receives a low-cost
  // semantic stream. If the owned stream drops without [DONE], the exact
  // observed request is replayed immediately; delay is used only to stop a
  // reconnect storm.
  function adoptResumeRequest(snapshot) {
    resetResumeSession();
    const generation = ++resumeGeneration;
    resumeSession = {
      generation,
      snapshot,
      controller: new AbortController(),
      reconnectTimer: null,
      reconnectQueued: false,
      reconnectTimes: [],
      needsReconnect: false,
    };
    return generation;
  }

  function handleResumeStreamClose(generation, {
    sawDone,
    error,
    conversationId,
    conversationIdConflict,
  }) {
    const session = resumeSession;
    if (!session || session.generation !== generation) return;
    session.controller = null;
    if (sawDone) {
      session.needsReconnect = false;
      emit({
        type: "page-stream-status",
        transport: "sse",
        phase: "complete",
        state: "connected",
        ...(conversationId && !conversationIdConflict ? { conversationId } : {}),
        timestamp: Date.now(),
      });
      return;
    }
    session.needsReconnect = true;
    if (conversationId && !conversationIdConflict) {
      markExecutionUnknownIfActive(conversationId, 'sse-disconnected');
    }
    emit({
      type: "page-stream-status",
      transport: "sse",
      phase: "closed",
      state: "disconnected",
      error: Boolean(error),
      ...(conversationId && !conversationIdConflict ? { conversationId } : {}),
      timestamp: Date.now(),
    });
    scheduleResumeReconnect(session);
  }

  function scheduleResumeReconnect(session = resumeSession) {
    if (
      !session ||
      session !== resumeSession ||
      !session.needsReconnect ||
      session.controller ||
      session.reconnectTimer ||
      session.reconnectQueued ||
      !takeoverActive ||
      !navigator.onLine
    ) {
      return;
    }

    const now = Date.now();
    session.reconnectTimes = session.reconnectTimes.filter((at) => now - at < RECONNECT_STORM_WINDOW_MS);
    if (session.reconnectTimes.length >= RECONNECT_STORM_LIMIT) {
      const delay = Math.max(1, session.reconnectTimes[0] + RECONNECT_STORM_WINDOW_MS - now);
      session.reconnectTimer = setTimeout(() => {
        if (session !== resumeSession) return;
        session.reconnectTimer = null;
        scheduleResumeReconnect(session);
      }, delay);
      return;
    }

    session.reconnectTimes.push(now);
    session.reconnectQueued = true;
    queueMicrotask(() => {
      if (session !== resumeSession) return;
      session.reconnectQueued = false;
      void runResumeReconnect(session);
    });
  }

  async function runResumeReconnect(session) {
    if (
      session !== resumeSession ||
      !session.needsReconnect ||
      session.controller ||
      !takeoverActive ||
      !navigator.onLine
    ) {
      return;
    }

    const controller = new AbortController();
    session.controller = controller;
    session.needsReconnect = false;
    try {
      const request = await requestFromSnapshot(session.snapshot, controller.signal);
      if (session !== resumeSession) return;
      const response = await Reflect.apply(
        session.snapshot.upstreamFetch,
        session.snapshot.fetchThis,
        [request],
      );
      const mimeType = response.headers.get("content-type") || "";
      if (!response.ok || !response.body || !mimeType.includes("text/event-stream")) {
        throw new Error(`resume-http-${response.status}`);
      }
      const resolvedScope = await session.snapshot.conversationScope
        .catch(() => ({ conversationId: null, conflicted: false }));
      emit({
        type: "page-stream-status",
        transport: "sse",
        phase: "connected",
        state: "connected",
        ...(!resolvedScope.conflicted && resolvedScope.conversationId
          ? { conversationId: resolvedScope.conversationId }
          : {}),
        timestamp: Date.now(),
      });
      await captureReadableStream(response.body, {
        requestId: nextRequestId("resume"),
        url: response.url || session.snapshot.url,
        status: response.status,
        mimeType,
        conversationScope: session.snapshot.conversationScope,
        turnScope: session.snapshot.turnScope,
        resume: true,
        replay: true,
        cancelSignal: controller.signal,
        onClose: (result) => handleResumeStreamClose(session.generation, result),
      });
    } catch (error) {
      if (session !== resumeSession || controller.signal.aborted) return;
      session.controller = null;
      session.needsReconnect = true;
      emit({
        type: "page-stream-status",
        transport: "sse",
        phase: "closed",
        state: "disconnected",
        error: true,
        timestamp: Date.now(),
      });
      scheduleResumeReconnect(session);
    }
  }

  function reconnectResumeIfNeeded() {
    if (resumeSession?.needsReconnect) scheduleResumeReconnect(resumeSession);
  }

  function resetResumeSession() {
    const session = resumeSession;
    resumeSession = null;
    resumeGeneration += 1;
    if (!session) return;
    clearTimeout(session.reconnectTimer);
    session.controller?.abort();
  }

  function createOfficialSemanticStream() {
    const encoder = new TextEncoder();
    const channelValues = new Map();
    const projectedLegacyMessages = new Map();
    const projectedControls = new Map();
    let projectedResumeControl = null;
    let turnUserMessageId = null;
    let turnParentMessageId = null;
    let controller = null;
    let closed = false;
    let source = "";
    let encoding = null;
    let deltaFailed = false;
    let previousDelta = { channel: 0, op: "add", path: "", value: undefined };
    let onTurnValue = null;

    const readable = new ReadableStream({
      start(nextController) {
        controller = nextController;
      },
      cancel() {
        closed = true;
        controller = null;
      },
    });

    const write = (event, value) => {
      if (closed || !controller) return;
      const prefix = event ? `event: ${event}\n` : "";
      controller.enqueue(encoder.encode(`${prefix}data: ${JSON.stringify(value)}\n\n`));
    };

    const rememberProjection = (projected) => {
      if (!projected) return;
      if (projected.type === "resume_conversation_token") {
        projectedResumeControl = projected;
      } else if (projected.message?.id) {
        // A channel is a reusable transport slot, not the identity of its
        // current output item. Keep structural items before that slot changes
        // into a completion/control event. Only tiny projections live here.
        const message = projected.message;
        const key = `${message.id}\0${message.author?.role || ''}\0${message.channel || ''}`;
        projectedLegacyMessages.set(key, projected);
      } else if (projected.type) {
        projectedControls.set(projected.type, projected);
      }
    };

    const processBlock = (block) => {
      const frame = parseOfficialSseFrame(block);
      if (!frame || frame.data === "[DONE]") return;
      if (frame.event === "delta_encoding") {
        if (frame.value !== "v1") { deltaFailed = true; return; }
        encoding = "v1";
        previousDelta = { channel: 0, op: "add", path: "", value: undefined };
        channelValues.clear();
        return;
      }
      if (frame.event === "delta") {
        if (deltaFailed) return;
        if (encoding !== "v1") { deltaFailed = true; return; }
        try {
          const delta = decodeOfficialCompactDelta(frame.value, previousDelta);
          const value = applyOfficialDelta(channelValues.get(delta.channel), delta);
          previousDelta = delta;
          channelValues.set(delta.channel, value);
          onTurnValue?.(value);
          rememberProjection(projectOfficialSemanticValue(value));
        } catch {
          // A future delta dialect must not fall back to the expensive raw
          // official renderer. Nor may later inherited operations continue
          // from the state before a missing/failed delta.
          deltaFailed = true;
          channelValues.clear();
        }
        return;
      }

      try { onTurnValue?.(frame.value); } catch { /* observation must not affect projection */ }
      rememberProjection(projectOfficialSemanticValue(frame.value));
    };

    return {
      readable,
      setContext(context) {
        onTurnValue = typeof context?.onTurnValue === 'function' ? context.onTurnValue : null;
        turnUserMessageId = context?.turnUserMessageId || turnUserMessageId;
        turnParentMessageId = context?.turnParentMessageId || turnParentMessageId;
      },
      accept(chunk) {
        if (closed || !chunk) return;
        const parsed = consumeOfficialSseBlocks(source, chunk);
        source = parsed.rest;
        for (const block of parsed.blocks) processBlock(block);
      },
      finish(sawDone) {
        if (closed) return;
        for (const block of consumeOfficialSseBlocks(source, '', true).blocks) processBlock(block);
        source = "";
        if (deltaFailed) sawDone = false;
        if (controller) {
          if (!sawDone && projectedResumeControl) write("", projectedResumeControl);

          let matchingUser = null;
          let latestUser = null;
          let final = null;
          for (const projected of projectedLegacyMessages.values()) {
            if (projected?.message?.author?.role === "user") {
              latestUser = projected;
              if (projected.message.id === turnUserMessageId) matchingUser = projected;
            }
            if (isOfficialFinalAssistant(projected?.message)) final = projected;
          }
          const user = matchingUser || latestUser;
          const userId = turnUserMessageId || user?.message?.id || null;

          if (user) write("", projectOfficialTurnNode(user, turnParentMessageId));
          if (final) write("", projectOfficialTurnNode(final, userId));
          for (const type of [
            "title_generation",
            "message_stream_complete",
            "conversation_detail_metadata",
          ]) {
            const projected = projectedControls.get(type);
            if (projected) write("", projected);
          }
          if (sawDone) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
        controller = null;
        closed = true;
        channelValues.clear();
        projectedLegacyMessages.clear();
        projectedControls.clear();
        projectedResumeControl = null;
        onTurnValue = null;
      },
    };
  }

  function isOfficialFinalAssistant(message) {
    if (message?.author?.role !== "assistant") return false;
    if (message.recipient && message.recipient !== "all") return false;
    return message.end_turn === true ||
      (message.channel === "final" && /^finished/.test(String(message.status || "")));
  }

  function projectOfficialTurnNode(projected, parentMessageId) {
    const message = projected.message;
    const parent = parentMessageId || message.parent_id || message.metadata?.parent_id || null;
    return {
      ...projected,
      message: {
        ...message,
        ...(parent ? { parent_id: parent } : {}),
        content: { content_type: "text", parts: ["\u200b"] },
        metadata: {
          ...(message.metadata || {}),
          ...(parent ? { parent_id: parent } : {}),
        },
      },
    };
  }

  function consumeOfficialSseBlocks(buffer, chunk, flush = false) {
    const source = (String(buffer || '') + String(chunk || '')).replace(/^\uFEFF/, '');
    const blocks = [];
    let blockStart = 0;
    let lineStart = 0;
    for (const match of source.matchAll(/\r\n|\r|\n/g)) {
      if (!flush && match[0] === '\r' && match.index === source.length - 1) break;
      const end = match.index + match[0].length;
      if (match.index === lineStart) {
        blocks.push(source.slice(blockStart, lineStart));
        blockStart = end;
      }
      lineStart = end;
    }
    return { blocks, rest: flush ? '' : source.slice(blockStart) };
  }

  function parseOfficialSseFrame(block) {
    if (!block) return null;
    let event = "";
    const data = [];
    for (const line of String(block).split(/\r\n|\r|\n/)) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (!data.length) return null;
    const body = data.join("\n");
    if (body === "[DONE]") return { event, data: body, value: null };
    try {
      return { event, data: body, value: JSON.parse(body) };
    } catch {
      return null;
    }
  }

  function decodeOfficialCompactDelta(rawDelta, previousDelta) {
    if (!rawDelta || typeof rawDelta !== "object" || Array.isArray(rawDelta)) {
      throw new Error("Unexpected official delta");
    }
    const compact = { ...rawDelta };
    for (const [field, short] of [["channel", "c"], ["path", "p"], ["op", "o"]]) {
      if (!(short in compact) && !(field in compact)) compact[short] = previousDelta[field];
    }
    const delta = expandOfficialDelta(compact);
    if (!Number.isSafeInteger(delta.channel) || delta.channel < 0 || typeof delta.path !== 'string') {
      throw new Error('Invalid official delta channel/path');
    }
    return delta;
  }

  function expandOfficialDelta(compact) {
    const delta = { ...compact };
    for (const [field, short] of [["channel", "c"], ["path", "p"], ["op", "o"], ["value", "v"]]) {
      if (!(short in compact)) continue;
      delta[field] = compact[short];
      delete delta[short];
    }
    if (delta.op === "patch") {
      if (!Array.isArray(delta.value)) throw new Error("Invalid official patch");
      delta.value = delta.value.map(expandOfficialDelta);
    }
    return delta;
  }

  function applyOfficialDelta(previousValue, delta) {
    const root = Symbol("official-delta-root");
    const path = [root, ...parseOfficialDeltaPath(delta.path)];
    const result = { [root]: previousValue };
    let source = result;
    let target = result;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      const nextKey = path[index + 1];
      const sourceChild = source && typeof source === "object" ? source[key] : undefined;
      const targetChild = Array.isArray(sourceChild)
        ? sourceChild.slice()
        : (sourceChild && typeof sourceChild === "object")
          ? { ...sourceChild }
          : typeof nextKey === "number" ? [] : {};
      target[key] = targetChild;
      source = sourceChild;
      target = targetChild;
    }
    applyOfficialDeltaOperation(target, path[path.length - 1], delta);
    return result[root];
  }

  function parseOfficialDeltaPath(value) {
    if (!value) return [];
    const source = value[0] === "/" ? value.slice(1) : value;
    return source.split("/").map((part) => {
      const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (["__proto__", "prototype", "constructor"].includes(decoded)) {
        throw new Error("Unsafe official delta path");
      }
      return /^(?:0|[1-9]\d*)$/.test(decoded) ? Number.parseInt(decoded, 10) : decoded;
    });
  }

  function applyOfficialDeltaOperation(target, key, delta) {
    if (Array.isArray(target)) {
      if (key === '-' && delta.op === 'add') key = target.length;
      if (!Number.isSafeInteger(key) || key < 0 || key > target.length || (key === target.length && delta.op !== 'add')) {
        throw new Error('Invalid official delta array index');
      }
    }
    if (delta.op === "patch") {
      let value = target[key];
      for (const patch of delta.value) value = applyOfficialDelta(value, patch);
      target[key] = value;
    } else if (delta.op === "add") {
      if (Array.isArray(target)) target.splice(key, 0, delta.value);
      else target[key] = delta.value;
    } else if (delta.op === "remove") {
      if (Array.isArray(target)) target.splice(key, 1);
      else delete target[key];
    } else if (delta.op === "replace") {
      target[key] = delta.value;
    } else if (delta.op === "append") {
      const previous = target[key];
      if (typeof previous === "string") target[key] = previous + delta.value;
      else if (Array.isArray(previous)) {
        target[key] = previous.concat(Array.isArray(delta.value) ? delta.value : [delta.value]);
      } else if (
        previous && delta.value &&
        typeof previous === "object" && typeof delta.value === "object" &&
        !Array.isArray(previous) && !Array.isArray(delta.value)
      ) {
        target[key] = { ...previous, ...delta.value };
      } else target[key] = delta.value;
    } else if (delta.op === "truncate") {
      if (typeof target[key] === "string") target[key] = target[key].substring(0, delta.value);
      else if (Array.isArray(target[key])) target[key] = target[key].slice(0, delta.value);
    } else {
      throw new Error("Unknown official delta operation");
    }
  }

  function projectOfficialSemanticValue(value) {
    if (!value || typeof value !== "object") return null;
    if (value.message && typeof value.message === "object") {
      const message = value.message;
      const metadata = {};
      for (const key of [
        "parent_id",
        "request_id",
        "turn_exchange_id",
        "working_turn_id",
        "turn_trace_id",
        "message_type",
        "message_source",
        "can_save",
        "is_visually_hidden_from_conversation",
        "selected_sources",
        "serialization_metadata",
        "reasoning_status",
        "cot_version",
        "model_switcher_deny",
        "model_slug",
        "resolved_model_slug",
        "default_model_slug",
        "thinking_effort",
        "is_complete",
        "finish_details",
        "async_source",
        "real_author",
        "call_id",
        "tool_call_id",
      ]) {
        if (message.metadata?.[key] !== undefined) metadata[key] = message.metadata[key];
      }
      return {
        message: {
          id: message.id,
          ...(message.parent_id ? { parent_id: message.parent_id } : {}),
          author: {
            role: message.author?.role,
            name: message.author?.name ?? null,
            metadata: message.author?.metadata?.real_author
              ? { real_author: message.author.metadata.real_author }
              : {},
          },
          create_time: message.create_time ?? null,
          update_time: message.update_time ?? null,
          content: projectOfficialMessageContent(message.content),
          status: message.status ?? null,
          end_turn: message.end_turn ?? null,
          weight: message.weight ?? 1,
          metadata,
          recipient: message.recipient ?? "all",
          channel: message.channel ?? null,
        },
        conversation_id: value.conversation_id || null,
        error: value.error ?? null,
        error_code: value.error_code ?? null,
      };
    }

    if (value.type === "input_message") return null;
    if (typeof value.type === "string") {
      const serialized = JSON.stringify(value);
      return serialized.length <= 16_384 ? value : { type: value.type, conversation_id: value.conversation_id || null };
    }
    return null;
  }

  function projectOfficialMessageContent(content) {
    const type = content?.content_type || "text";
    const placeholder = type === "code" ? "{}" : "\u200b";
    if (Array.isArray(content?.parts)) return { content_type: type, parts: [placeholder] };
    if (typeof content?.text === "string") return { content_type: type, text: placeholder };
    if (typeof content?.content === "string") return { content_type: type, content: placeholder };
    return { content_type: type, parts: [placeholder] };
  }

  function completeOfficialStream(response, semanticBody, captureDone) {
    // Retain the native network Response identity while substituting only its
    // body reader. ChatGPT associates response internals with router/request
    // state; constructing a new Response loses that semantic identity.
    const body = semanticBody || new ReadableStream({
      start(controller) {
        Promise.resolve(captureDone)
          .catch(() => {})
          .then(() => {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          });
      },
    });
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    const projected = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    const readers = {};
    for (const name of ["text", "json", "arrayBuffer", "blob", "formData", "bytes", "clone"]) {
      if (typeof projected[name] !== "function") continue;
      readers[name] = { configurable: true, value: projected[name].bind(projected) };
    }
    try {
      Object.defineProperties(response, {
        // clone() tees a stream and can replace its branch. Always expose the
        // projected Response's current body, not the original locked stream.
        body: { configurable: true, get: () => projected.body },
        bodyUsed: { configurable: true, get: () => projected.bodyUsed },
        ...readers,
      });
      return response;
    } catch {
      observedFetchResponses.add(projected);
      return projected;
    }
  }

  async function captureReadableStream(stream, meta) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const { onClose, cancelSignal, officialSemanticStream, ...unresolvedMeta } = meta;
    const captureMeta = await resolveCaptureMeta(unresolvedMeta);
    officialSemanticStream?.setContext({ ...captureMeta,
      onTurnValue: (value) => observeCapturedTurn(value, captureMeta),
    });
    if (captureMeta.conversationId && isExecutionStreamUrl(captureMeta.url)) {
      emitExecutionState('running', 'sse-active', captureMeta.conversationId);
    }
    const cancelReader = () => { void reader.cancel().catch(() => {}); };
    if (cancelSignal?.aborted) cancelReader();
    else cancelSignal?.addEventListener("abort", cancelReader, { once: true });
    let markerTail = "";
    let sawDone = false;
    let readError = null;

    const trackCompletion = (data, flush = false) => {
      const parsed = consumeOfficialSseBlocks(markerTail, data, flush);
      markerTail = parsed.rest;
      for (const block of parsed.blocks) {
        if (block.includes('[DONE]') && parseOfficialSseFrame(block)?.data === '[DONE]') sawDone = true;
      }
    };

    const captureChunk = (data) => {
      if (!data) return;
      officialSemanticStream?.accept(data);
      trackCompletion(data);
      emit({
        type: "page-capture",
        transport: "sse",
        phase: "chunk",
        timestamp: Date.now(),
        data,
        ...captureMeta,
      });
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        captureChunk(decoder.decode(value, { stream: true }));
      }
      captureChunk(decoder.decode());
    } catch (error) {
      readError = error;
    } finally {
      trackCompletion('', true);
      officialSemanticStream?.finish(sawDone);
      emit({
        type: "page-capture",
        transport: "sse",
        phase: "complete",
        timestamp: Date.now(),
        data: "",
        graceful: sawDone,
        disconnected: !sawDone,
        ...captureMeta,
      });
      cancelSignal?.removeEventListener("abort", cancelReader);
      reader.releaseLock();
      // Post-stream refresh is a single first-page touch-up, never a full
      // multi-page sync: full history (up to 500 conversations) is reserved
      // for initial bootstrap and explicit manual refresh. The default path
      // is cooldown-gated and single-page once bootstrapped.
      if (sawDone && isExecutionStreamUrl(captureMeta.url)) {
        requestConversationIndexSync();
      }
      try {
        onClose?.({
          sawDone,
          error: readError,
          conversationId: captureMeta.conversationId || null,
          conversationIdConflict: Boolean(captureMeta.conversationIdConflict),
        });
      } catch {
        // Transport recovery must never escape into the observed request.
      }
    }
  }

  function isExecutionStreamUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''), location.href);
      return url.origin === location.origin && /^\/backend-api\/(?:f\/)?conversation(?:\/resume)?$/.test(url.pathname);
    } catch {
      return false;
    }
  }

  async function captureWebMobileStream(stream, meta) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const captureMeta = await resolveCaptureMeta(meta);
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
            emitWebMobileLiveMessage(snapshot, captureMeta);
          }
        }
      }
      const tail = decoder.decode();
      if (tail) source += tail;
      const safeConversation = extractWebMobileConversationMarkup(source);
      if (safeConversation) emitCompletedFetch(safeConversation, captureMeta);
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
    const captureMeta = await resolveCaptureMeta(meta);
    if (!response.body) {
      try {
        const data = await response.text();
        if (data.length <= MAX_NON_STREAM_BODY) emitCompletedFetch(data, captureMeta);
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
      emitCompletedFetch(parts.join(""), captureMeta);
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
      observedXhrSend = function slimgptSend(body) {
        const meta = this.__slimgptMeta;
        if (meta && interesting(meta.url) && !this[XHR_RESPONSE_OBSERVED]) {
          this[XHR_RESPONSE_OBSERVED] = true;
          const url = new URL(meta.url, location.href);
          const method = String(meta.method || "").toUpperCase();
          const conversationRequest = method === "POST" &&
            url.origin === location.origin &&
            (url.pathname === "/backend-api/conversation" || url.pathname === "/backend-api/f/conversation");
          const resumeRequest = method === "POST" && url.origin === location.origin && url.pathname === RESUME_PATH;
          const endpointConversationId = conversationIdFromUrl(url.href);
          const pageConversationId = conversationRequest || resumeRequest
            ? conversationIdFromUrl(location.href)
            : null;
          const bodyConversationId = conversationRequest || resumeRequest
            ? conversationIdFromRequestBody(body)
            : null;
          const conversationScope = Promise.resolve(
            bodyConversationId && endpointConversationId && bodyConversationId !== endpointConversationId
              ? { conversationId: null, conflicted: true }
              : {
                  conversationId: bodyConversationId || endpointConversationId || pageConversationId,
                  conflicted: false,
                },
          );
          const turnScope = conversationRequest
            ? snapshotXhrSubmissionTurn(body, conversationScope)
            : (url.pathname === RESUME_PATH ? snapshotActiveTurn(conversationScope, turnIdentityFromRequestBody(body)) : null);
          observeXhrResponse(this, {
            ...meta,
            conversationScope,
            turnScope,
            conversationRequest,
          });
        }
        return Reflect.apply(upstreamSend, this, arguments);
      };
      prototype.send = observedXhrSend;
    }
  }

  async function snapshotXhrSubmissionTurn(body, conversationScope) {
    const session = {
      sessionId: nextTurnSessionId(),
      submissionOrdinal: ++turnSubmissionOrdinal,
      scopePending: true,
      transportTurnId: null,
      turnId: null,
      turnAliases: [],
      turnExchangeId: null,
      workingTurnId: null,
      requestId: null,
      turnTraceId: null,
      conversationId: null,
      userMessageId: null,
      parentMessageId: null,
      startedAt: Date.now(),
    };
    session.transportTurnId = session.sessionId;
    registerTurnSession(session);
    const [scope, identity] = await Promise.all([
      conversationScope?.catch(() => ({ conversationId: null, conflicted: true })) ||
        Promise.resolve({ conversationId: null, conflicted: false }),
      Promise.resolve(turnIdentityFromRequestBody(body)),
    ]);
    session.scopePending = false;
    session.scopeConflicted = Boolean(scope?.conflicted);
    if (!scope?.conflicted && scope?.conversationId) session.conversationId = scope.conversationId;
    if (identity?.userMessageId) session.userMessageId = identity.userMessageId;
    if (identity?.parentMessageId) session.parentMessageId = identity.parentMessageId;
    if (identity?.turnId) session.turnId = identity.turnId;
    if (identity?.turnAliases?.length) session.turnAliases = identity.turnAliases;
    if (identity?.turnExchangeId) session.turnExchangeId = identity.turnExchangeId;
    if (identity?.workingTurnId) session.workingTurnId = identity.workingTurnId;
    if (identity?.requestId) session.requestId = identity.requestId;
    if (identity?.turnTraceId) session.turnTraceId = identity.turnTraceId;
    session.transportTurnId = session.sessionId;
    registerTurnSession(session);
    return session;
  }

  function observeXhrResponse(xhr, meta) {
    const requestId = nextRequestId("xhr");
    const captureMetaPromise = resolveCaptureMeta(meta);
    let sentLength = 0;
    let captureDisabled = false;
    const capture = async (phase) => {
      try {
        const captureMeta = await captureMetaPromise;
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
          ...captureMeta,
        });
      } catch {
        // Cross-origin/responseType access can throw; ignore observation only.
      }
    };
    xhr.addEventListener("progress", () => capture("chunk"));
    xhr.addEventListener("loadend", () => {
      capture("complete");
      try {
        const url = new URL(meta.url, location.href);
        const submission = String(meta.method || "").toUpperCase() === "POST" &&
          url.origin === location.origin &&
          (url.pathname === "/backend-api/conversation" || url.pathname === "/backend-api/f/conversation");
        if (submission) {
          const ok = xhr.status >= 200 && xhr.status < 300;
          settleSendConfirmation(ok, ok ? "request-accepted" : `http-${xhr.status || 0}`);
          if (!ok) void releaseTurnSession(meta.turnScope);
        }
      } catch {
        // Capture remains best-effort; send confirmation will time out.
      }
    }, { once: true });
  }

  function queueCanonicalConversation(conversationId, options = {}) {
    if (!conversationId || isProvisionalConversationId(conversationId)) return;
    const force = options === true || Boolean(options?.force);
    if (!force && typeof canonicalSyncedIds !== 'undefined' && canonicalSyncedIds.has(conversationId)) return;
    if (canonicalFetches.has(conversationId)) {
      // A snapshot for this conversation is already in flight (e.g. navigation
      // and a turn-stop notification arriving together). Keep it queued without
      // bumping the generation so concurrent signals coalesce into the single
      // in-flight fetch instead of serializing into back-to-back full-history
      // reads. Genuine new-content signals use force and still schedule a
      // follow-up pass via the generation bump below.
      pendingCanonicalIds.add(conversationId);
      if (!force) return;
    }
    const retryAfterMs = (canonicalBackoffUntil.get(conversationId) || 0) - Date.now();
    if (retryAfterMs > 0) {
      emit({ type: 'canonical-sync-status', conversationId, state: 'error', code: 'backoff', retryAfterMs });
    } else if (!backendFetch || !(backendHeaders || backendSessionHeaders)) {
      emit({ type: 'canonical-sync-status', conversationId, state: 'error', code: 'not-ready' });
    }
    const generation = canonicalQueueGenerations.get(conversationId) || 0;
    const attempted = canonicalAttemptedGenerations.get(conversationId);
    if (!pendingCanonicalIds.has(conversationId)) {
      canonicalQueueGenerations.set(conversationId, generation + 1);
    } else if (attempted === generation) {
      // Coalesce any number of semantic notifications arriving while the
      // current snapshot is in flight (or backing off) into one later pass.
      canonicalQueueGenerations.set(conversationId, generation + 1);
    }
    pendingCanonicalIds.add(conversationId);
    drainCanonicalFetches();
  }

  function drainCanonicalFetches() {
    if (!backendFetch || !(backendHeaders || backendSessionHeaders)) return;
    const now = Date.now();
    for (const conversationId of pendingCanonicalIds) {
      if (canonicalFetches.size >= 3) break;
      if (canonicalFetches.has(conversationId)) continue;
      if ((canonicalBackoffUntil.get(conversationId) || 0) > now) continue;
      const generation = canonicalQueueGenerations.get(conversationId) || 0;
      if (canonicalAttemptedGenerations.get(conversationId) === generation) continue;
      void fetchCanonicalConversation(conversationId, generation);
    }
  }

  async function fetchCanonicalConversation(conversationId, generation = canonicalQueueGenerations.get(conversationId) || 0) {
    const sourceHeaders = backendHeaders || backendSessionHeaders;
    if (canonicalFetches.has(conversationId) || !backendFetch || !sourceHeaders) return;
    canonicalAttemptedGenerations.set(conversationId, generation);
    const syncId = nextRequestId('sync');
    emit({ type: 'canonical-sync-status', conversationId, canonicalSyncId: syncId, state: 'loading' });
    const task = (async () => {
      const headers = new Headers(sourceHeaders);
      headers.delete("content-length");
      headers.delete("content-type");
      headers.set("accept", "application/json");
      const pages = await fetchCanonicalConversationPages(conversationId, headers);
      if (!pages.length) throw new Error('empty canonical conversation');
      canonicalFailureCounts.delete(conversationId);
      canonicalBackoffUntil.delete(conversationId);
      if (typeof canonicalSyncedIds !== 'undefined') canonicalSyncedIds.add(conversationId);
      const latestGeneration = canonicalQueueGenerations.get(conversationId) || 0;
      if (latestGeneration <= generation) {
        pendingCanonicalIds.delete(conversationId);
        canonicalAttemptedGenerations.delete(conversationId);
        canonicalQueueGenerations.delete(conversationId);
      }
      const ordered = pages.slice().reverse();
      for (let index = 0; index < ordered.length; index += 1) {
        const page = ordered[index];
        emit({
          type: "page-capture",
          transport: "fetch",
          phase: "complete",
          requestId: `${syncId}-${index + 1}`,
          url: page.url,
          status: page.status,
          mimeType: page.mimeType,
          timestamp: Date.now(),
          data: page.text,
          conversationId,
          synchronized: true,
          canonicalSyncId: syncId,
          canonicalPageIndex: index,
          canonicalPageCount: ordered.length,
          canonicalComplete: index === ordered.length - 1,
        });
      }
      emit({ type: 'canonical-sync-status', conversationId, canonicalSyncId: syncId, state: 'complete' });
    })();
    canonicalFetches.set(conversationId, task);
    try {
      await task;
    } catch (error) {
      scheduleCanonicalBackoff(conversationId, error);
      emit({ type: 'canonical-sync-status', conversationId, canonicalSyncId: syncId, state: 'error',
        code: error?.code === 'timeout' ? 'timeout' : error?.code === 'invalid-history' ? 'invalid-history' : 'request-failed',
        status: Number(error?.status) || null,
        retryAfterMs: Math.max(0, (canonicalBackoffUntil.get(conversationId) || 0) - Date.now()),
      });
    } finally {
      canonicalFetches.delete(conversationId);
      // Release a slot for any queued conversation. Failed generations remain
      // attempted/backed off; this is completion-driven, not timer polling.
      drainCanonicalFetches();
    }
  }

  function scheduleCanonicalBackoff(conversationId, error) {
    const failureCount = (canonicalFailureCounts.get(conversationId) || 0) + 1;
    canonicalFailureCounts.set(conversationId, failureCount);
    const explicitDelay = Number(error?.retryAfterMs);
    const delay = Number.isFinite(explicitDelay) && explicitDelay > 0
      ? explicitDelay
      : Math.min(1_500 * (2 ** Math.min(failureCount - 1, 4)), 24_000);
    canonicalBackoffUntil.set(conversationId, Date.now() + delay);
    // Strictly event-driven: a failed full-history read never schedules its
    // own retry.  The next navigation / durable turn-complete notification
    // may retry after this backoff window.  This keeps failure handling from
    // turning a rate limit or transient outage into a request loop.
  }

  function canonicalFetchFailure(response) {
    const error = new Error(`canonical fetch failed: ${response?.status || 0}`);
    error.status = response?.status || 0;
    const retryAfter = String(response?.headers?.get?.('retry-after') || '').trim();
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) error.retryAfterMs = seconds * 1000;
      else {
        const timestamp = Date.parse(retryAfter);
        if (Number.isFinite(timestamp)) error.retryAfterMs = Math.max(0, timestamp - Date.now());
      }
    }
    return error;
  }

  async function fetchCanonicalConversationPages(conversationId, headers, limits = {}) {
    const pages = [];
    const seenCursors = new Set();
    const maxPages = limits.maxPages ?? 100;
    const maxTotalBytes = limits.maxTotalBytes ?? 64 * 1024 * 1024;
    let totalBytes = 0;
    let before = null;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const tryFetch = async (useMessagesEndpoint) => {
        const path = useMessagesEndpoint && before
          ? `/backend-api/conversations/${encodeURIComponent(conversationId)}/messages`
          : `/backend-api/conversations/${encodeURIComponent(conversationId)}`;
        const url = new URL(path, location.origin);
        url.searchParams.set("include_has_versions", "true");
        url.searchParams.set("num_turns", String(CANONICAL_PAGE_TURNS));
        if (before) url.searchParams.set("before", before);
        return fetchCanonicalPageResponse(url, headers, limits);
      };

      let url;
      let response;
      let body;
      // Prefer the paginated /messages endpoint for older pages (matches
      // fixture and newer ChatGPT builds), but fall back to the unified
      // ?before= cursor on the same /conversations/:id endpoint if the
      // deployment does not expose /messages yet. This keeps old
      // conversations loadable across both API shapes.
      if (before) {
        const primary = await tryFetch(true);
        if (primary.response.ok) {
          url = primary.url;
          response = primary.response;
          body = primary.body;
        } else if ([404, 405, 400].includes(primary.response.status)) {
          const fallback = await tryFetch(false);
          url = fallback.url;
          response = fallback.response;
          body = fallback.body;
        } else {
          url = primary.url;
          response = primary.response;
          body = primary.body;
        }
      } else {
        const single = await tryFetch(false);
        url = single.url;
        response = single.response;
        body = single.body;
      }
      if (!response.ok) {
        if (!pages.length && [404, 405].includes(response.status)) {
          return fetchLegacyCanonicalConversation(conversationId, headers, limits);
        }
        throw canonicalFetchFailure(response);
      }
      const { text, bytes } = body;
      totalBytes += bytes;
      if (totalBytes > maxTotalBytes) throw canonicalProtocolFailure('canonical total size limit exceeded');
      const { pageInfo } = validateCanonicalPage(text, conversationId);
      if (pages.length && pages[pages.length - 1].text === text) {
        throw canonicalProtocolFailure('canonical page did not advance');
      }
      pages.push({
        text,
        url: response.url || url.href,
        status: response.status,
        mimeType: response.headers.get("content-type") || "application/json",
      });

      // Explicit pagination always wins over the presence of a mapping/root.
      if (!pageInfo || pageInfo.has_previous_page === false) return pages;
      const cursor = typeof pageInfo.start_cursor === 'string' ? pageInfo.start_cursor.trim() : '';
      if (!cursor || seenCursors.has(cursor)) throw canonicalProtocolFailure('canonical cursor did not advance');
      seenCursors.add(cursor);
      before = cursor;
    }
    throw canonicalProtocolFailure('canonical page limit reached with incomplete history');
  }

  async function fetchLegacyCanonicalConversation(conversationId, headers, limits = {}) {
    const url = new URL(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, location.origin);
    const { response, body } = await fetchCanonicalPageResponse(url, headers, limits);
    if (!response.ok) throw canonicalFetchFailure(response);
    const { text, bytes } = body;
    const { value, pageInfo } = validateCanonicalPage(text, conversationId);
    if (!value.mapping || pageInfo?.has_previous_page || bytes > (limits.maxTotalBytes ?? 64 * 1024 * 1024)) throw canonicalProtocolFailure('invalid or incomplete legacy canonical response');
    return [{
      text,
      url: response.url || url.href,
      status: response.status,
      mimeType: response.headers.get("content-type") || "application/json",
    }];
  }

  function canonicalProtocolFailure(message) {
    const error = new Error(message);
    error.code = 'invalid-history';
    return error;
  }

  function validateCanonicalPage(text, conversationId) {
    let root;
    try { root = JSON.parse(text); } catch { throw canonicalProtocolFailure('invalid canonical response json'); }
    let value = root;
    let outerPageInfo;
    const visited = new Set();
    while (value && typeof value === 'object' && !Array.isArray(value) && !visited.has(value)) {
      visited.add(value);
      for (const id of [value.conversation_id, value.conversationId]) {
        if (id != null && id !== conversationId) throw canonicalProtocolFailure('canonical conversation identity mismatch');
      }
      if (value.page_info != null) outerPageInfo = value.page_info;
      if (value.mapping || Array.isArray(value.messages)) break;
      // Envelope keys only; tool output/message content is never traversed.
      value = value.data || value.conversation || value.result || value.payload;
      if (visited.size > 8) break;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw canonicalProtocolFailure('invalid canonical page shape');
    if (value.id != null && value.id !== conversationId) throw canonicalProtocolFailure('canonical conversation identity mismatch');
    const mapping = value.mapping;
    const isTree = mapping && typeof mapping === 'object' && !Array.isArray(mapping);
    const messageValid = (message) => message && typeof message === 'object' && !Array.isArray(message) &&
      typeof message.id === 'string' && message.id && (message.author || message.content);
    if (isTree) {
      if (!Object.values(mapping).every((node) => node && typeof node === 'object' && !Array.isArray(node) && (node.message == null || messageValid(node.message)))) throw canonicalProtocolFailure('invalid canonical mapping node');
    } else if (!Array.isArray(value.messages) || !value.messages.every(messageValid)) {
      throw canonicalProtocolFailure('invalid canonical messages');
    }
    const pageInfo = value.page_info ?? outerPageInfo;
    if (pageInfo != null && (typeof pageInfo !== 'object' || typeof pageInfo.has_previous_page !== 'boolean')) throw canonicalProtocolFailure('invalid canonical pagination');
    if (!isTree && !pageInfo) throw canonicalProtocolFailure('canonical list has no pagination boundary');
    if (isTree && !pageInfo && (Object.keys(mapping).length && !mapping[value.current_node])) throw canonicalProtocolFailure('canonical tree has no terminal node');
    return { value, pageInfo: pageInfo || null };
  }

  async function fetchCanonicalPageResponse(url, headers, limits = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.requestTimeoutMs ?? 30_000);
    try {
      const response = await Reflect.apply(backendFetch, backendFetchThis, [url.href, {
        method: 'GET', credentials: 'include', cache: 'no-store',
        headers: new Headers(headers), signal: controller.signal,
      }]);
      if (!response.ok) {
        // Rejected fallback endpoints can still stream bodies. They are not
        // evidence and must not keep a reader/connection alive indefinitely.
        try { await response.body?.cancel(); } catch { /* already closed */ }
        return { url, response, body: null };
      }
      return { url, response, body: await readCanonicalBody(response, controller.signal) };
    } catch (error) {
      if (controller.signal.aborted) {
        const timeout = new Error('canonical request timed out');
        timeout.code = 'timeout';
        throw timeout;
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function readCanonicalBody(response, signal) {
    if (!response.body) throw canonicalProtocolFailure('empty canonical response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let bytes = 0;
    let completed = false;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        const { done, value } = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (done) { completed = true; break; }
        bytes += value.byteLength;
        if (bytes > MAX_NON_STREAM_BODY) throw canonicalProtocolFailure('canonical response size limit exceeded');
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      if (!bytes) throw canonicalProtocolFailure('empty canonical response');
      return { text: chunks.join(''), bytes };
    } finally {
      signal.removeEventListener('abort', abort);
      if (!completed) { try { await reader.cancel(); } catch { /* already failed */ } }
      reader.releaseLock();
    }
  }

  function installWebSocketObserver() {
    const wrap = (UpstreamWebSocket) => function ObservedWebSocket(url, protocols) {
      const hasProtocols = arguments.length > 1;
      const socket = hasProtocols
        ? new UpstreamWebSocket(url, protocols)
        : new UpstreamWebSocket(url);
      if (interestingSocket(url)) {
        adoptOfficialConversationSocket(socket, {
          UpstreamWebSocket,
          url: String(url),
          hasProtocols,
          protocols: Array.isArray(protocols) ? protocols.slice() : protocols,
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

  function adoptOfficialConversationSocket(socket, options) {
    const previous = conversationSocketState;
    const replayFrames = previous ? new Map(previous.replayFrames) : new Map();
    if (previous) {
      clearTimeout(previous.reconnectTimer);
      if (previous.managed && previous.managed.readyState < 2) {
        try { previous.managed.close(1000, "official-reconnected"); } catch {}
      }
    }

    const state = {
      generation: ++conversationSocketGeneration,
      ...options,
      original: socket,
      managed: null,
      replayFrames,
      reconnectTimer: null,
      reconnectQueued: false,
      reconnectTimes: [],
      needsReconnect: false,
    };
    conversationSocketState = state;

    const upstreamSend = socket.send;
    try {
      socket.send = function slimgptObservedSocketSend(data) {
        rememberSocketFrame(state, data);
        return Reflect.apply(upstreamSend, socket, arguments);
      };
    } catch {
      // Without replay frames the official client remains the reconnect owner.
    }
    observeConversationSocket(socket, state, false);
  }

  function rememberSocketFrame(state, data) {
    if (state !== conversationSocketState || typeof data !== "string") return;
    try {
      const packet = JSON.parse(data);
      const frames = Array.isArray(packet) ? packet : [packet];
      const replayKeys = [];
      for (const frame of frames) {
        const command = frame?.command && typeof frame.command === "object"
          ? frame.command
          : frame;
        if (command?.type === "connect") {
          replayKeys.push("connect");
          continue;
        }
        if (command?.type !== "subscribe") continue;
        const topic = String(command?.data?.topic || command?.topic_id || command?.topic || "");
        if (topic) replayKeys.push(`subscribe:${topic}`);
      }
      if (!replayKeys.length) return;
      const key = replayKeys.length === 1
        ? replayKeys[0]
        : `packet:${replayKeys.join("|")}`;
      state.replayFrames.set(key, data);
    } catch {
      // Binary and non-protocol frames are never replayed.
    }
  }

  function observeConversationSocket(socket, state, managed) {
    if (socket[WEBSOCKET_OBSERVED]) return;
    socket[WEBSOCKET_OBSERVED] = true;
    const requestId = nextRequestId("ws");
    const publicUrl = safeSocketUrl(state.url);

    const handleOpen = () => {
      if (state !== conversationSocketState) {
        if (managed) try { socket.close(1000, "stale"); } catch {}
        return;
      }
      state.needsReconnect = false;
      if (managed) {
        for (const frame of state.replayFrames.values()) {
          try { socket.send(frame); } catch {}
        }
      }
      emit({
        type: "page-stream-status",
        transport: "websocket",
        phase: "connected",
        state: "connected",
        url: publicUrl,
        timestamp: Date.now(),
      });
    };
    socket.addEventListener("open", handleOpen);
    if (socket.readyState === 1) queueMicrotask(handleOpen);

    socket.addEventListener("close", () => {
      if (state !== conversationSocketState) return;
      if (managed) state.managed = null;
      else state.original = null;
      state.needsReconnect = true;
      emit({
        type: "page-stream-status",
        transport: "websocket",
        phase: "closed",
        state: "disconnected",
        url: publicUrl,
        timestamp: Date.now(),
      });
      for (const [key, execution] of executionStates) {
        if (execution?.state !== 'running' || execution?.source !== 'ws-turn-running') continue;
        const conversationId = key === NEW_CHAT_EXECUTION_KEY ? null : key;
        markExecutionUnknownIfActive(conversationId, 'websocket-disconnected');
      }
      scheduleConversationSocketReconnect(state);
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data.length > MAX_NON_STREAM_BODY) return;
      const notifications = conversationNotifications(event.data);
      emit({
        type: "page-capture",
        transport: "websocket",
        requestId,
        url: publicUrl,
        phase: "message",
        timestamp: Date.now(),
        data: event.data,
      });
      if (!notifications.length || !takeoverActive) return;

      // This listener is registered before the official caller can attach its
      // own. Conversation notifications are consumed here so the heavyweight
      // official parser never sees them; connection/subscription replies still
      // pass through unchanged.
      event.stopImmediatePropagation();
      for (const notification of notifications) {
        const conversationId = notification.conversationId;
        const stateValue = applicableNotificationState(notification, activeTurnSessions.get(conversationId));
        if (
          conversationId &&
          pendingNewTurnSession &&
          notificationMatchesPendingNewTurn(notification, pendingNewTurnSession)
        ) {
          const boundSession = bindPendingTurnSession(conversationId);
          if (boundSession) {
            adoptNotificationTurnIdentity(conversationId, notification);
            emit({
              type: 'page-conversation-bound',
              conversationId,
              transportSessionId: boundSession.sessionId || null,
              transportTurnId: boundSession.transportTurnId || null,
              turnUserMessageId: boundSession.userMessageId || null,
              turnParentMessageId: boundSession.parentMessageId || null,
              turnId: notification.turnAliases?.[0] || boundSession.turnId || null,
              turnAliases: uniqueTurnIdentityStrings([
                ...(boundSession.turnAliases || []),
                ...(notification.turnAliases || []),
              ]),
              turnExchangeId: notification.turnExchangeId || boundSession.turnExchangeId || null,
              workingTurnId: notification.workingTurnId || boundSession.workingTurnId || null,
              turnRequestId: notification.requestId || boundSession.requestId || null,
              turnTraceId: notification.turnTraceId || boundSession.turnTraceId || null,
              timestamp: Date.now(),
            });
          }
        }
        if (conversationId && stateValue === 'running') {
          adoptNotificationTurnIdentity(conversationId, notification);
          emitExecutionState('running', 'ws-turn-running', conversationId, { phase: notification.type,
            turnAliases: notification.turnAliases, turnUserMessageId: notification.turnUserMessageId });
        } else if (conversationId && stateValue === 'stopped') {
          emitExecutionState('stopped', 'ws-turn-stopped', conversationId, { phase: notification.type,
            turnAliases: notification.turnAliases, turnUserMessageId: notification.turnUserMessageId });
          const activeSession = activeTurnSessions.get(conversationId);
          if (!activeSession || notificationMatchesTurnSession(notification, activeSession)) {
            if (activeSession) activeSession.released = true;
            activeTurnSessions.delete(conversationId);
          }
        }
        emit({
          type: "page-stream-status",
          transport: "websocket",
          phase: notification.type,
          ...(stateValue ? { state: stateValue === 'running' ? 'working' : 'idle' } : {}),
          conversationId,
          timestamp: Date.now(),
        });
        if (conversationId && stateValue === 'stopped') {
          // Turn-completion triggers coalesce: the SSE [DONE] path already
          // requested a (cooldown-gated, first-page-only) index refresh, and
          // queueCanonicalConversation merges concurrent signals into one
          // in-flight fetch. Force past canonicalSyncedIds only for genuine
          // new content — a tracked live turn ending, or a conversation never
          // snapshotted — so repeated stop notifications never re-fetch a
          // completed conversation on every minor event.
          const trackedTurn = activeTurnSessions.get(conversationId);
          const endsLiveTurn = trackedTurn
            ? notificationMatchesTurnSession(notification, trackedTurn)
            : !canonicalSyncedIds.has(conversationId);
          queueCanonicalConversation(conversationId, { force: endsLiveTurn });
          requestConversationIndexSync();
        }
      }
    });
  }

  function conversationNotifications(data) {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    const notifications = [];
    for (const frame of frames) {
      if (frame?.type !== "message" || frame?.topic_id !== "conversations") continue;
      let payload = frame.payload;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { payload = null; }
      }
      if (!payload || typeof payload !== "object") continue;
      const eventPayload = payload.payload && typeof payload.payload === "object"
        ? payload.payload
        : payload;
      const metadata = eventPayload.metadata && typeof eventPayload.metadata === "object"
        ? eventPayload.metadata
        : {};
      const conversationIds = uniqueTurnIdentityStrings([
        payload.conversation_id, payload.conversationId, eventPayload.conversation_id, eventPayload.conversationId,
      ]);
      if (conversationIds.length !== 1 || isProvisionalConversationId(conversationIds[0])) continue;
      const turnExchangeId = firstTurnIdentityString(
        eventPayload.turn_exchange_id,
        eventPayload.turnExchangeId,
        metadata.turn_exchange_id,
        metadata.turnExchangeId,
      );
      const workingTurnId = firstTurnIdentityString(
        eventPayload.working_turn_id,
        eventPayload.workingTurnId,
        metadata.working_turn_id,
        metadata.workingTurnId,
      );
      const requestId = firstTurnIdentityString(
        eventPayload.request_id,
        eventPayload.requestId,
        metadata.request_id,
        metadata.requestId,
      );
      const turnTraceId = firstTurnIdentityString(
        eventPayload.turn_trace_id,
        eventPayload.turnTraceId,
        metadata.turn_trace_id,
        metadata.turnTraceId,
      );
      notifications.push({
        type: String(payload.type || eventPayload.type || "conversation-update"),
        conversationId: conversationIds[0],
        turnUserMessageId: firstTurnIdentityString(
          eventPayload.turn_user_message_id, eventPayload.turnUserMessageId,
          eventPayload.user_message_id, eventPayload.userMessageId,
          metadata.turn_user_message_id, metadata.user_message_id,
          payload.turn_user_message_id, payload.user_message_id,
        ),
        status: String(eventPayload.status || payload.status || ''),
        turnExchangeId,
        workingTurnId,
        requestId,
        turnTraceId,
        turnAliases: uniqueTurnIdentityStrings([
          turnExchangeId,
          workingTurnId,
          requestId,
          turnTraceId,
        ]),
      });
    }
    return notifications;
  }

  function adoptNotificationTurnIdentity(conversationId, notification) {
    const session = activeTurnSessions.get(conversationId);
    if (!session || !notification?.turnAliases?.length) return;
    if (!notificationMatchesTurnSession(notification, session)) return;
    const existingAliases = uniqueTurnIdentityStrings(session.turnAliases || []);
    Object.assign(session, {
      ...session,
      turnId: session.turnId || notification.turnAliases[0],
      turnAliases: uniqueTurnIdentityStrings([
        ...existingAliases,
        ...notification.turnAliases,
      ]),
      turnExchangeId: session.turnExchangeId || notification.turnExchangeId || null,
      workingTurnId: session.workingTurnId || notification.workingTurnId || null,
      requestId: session.requestId || notification.requestId || null,
      turnTraceId: session.turnTraceId || notification.turnTraceId || null,
    });
  }

  function applicableNotificationState(notification, session) {
    if (session && !notificationMatchesTurnSession(notification, session)) return null;
    return notificationExecutionState(notification);
  }

  function notificationMatchesTurnSession(notification, session) {
    if (!session || session.scopePending || session.scopeConflicted || session.released) return false;
    const userId = firstTurnIdentityString(notification?.turnUserMessageId, notification?.userMessageId);
    if (userId && session.userMessageId && userId !== session.userMessageId) return false;
    if (notification?.turnExchangeId && session.turnExchangeId && notification.turnExchangeId !== session.turnExchangeId) return false;
    const notificationAliases = uniqueTurnIdentityStrings(notification?.turnAliases || []);
    const sessionAliases = uniqueTurnIdentityStrings(session?.turnAliases || []);
    return Boolean((userId && session.userMessageId === userId) ||
      notificationAliases.some((alias) => sessionAliases.includes(alias)));
  }

  function notificationMatchesPendingNewTurn(notification, session) {
    return Boolean(session && !session.conversationId &&
      notificationMatchesTurnSession(notification, session));
  }

  function notificationExecutionState(notification) {
    const type = String(notification?.type || '').toLowerCase().replace(/_/g, '-');
    const status = String(notification?.status || '').toLowerCase().replace(/_/g, '-');
    const combined = `${type} ${status}`;
    if (/(?:turn|generation|response).*(?:complete|completed|finished|done|stopped|cancelled|canceled|failed)\b/.test(combined)) {
      return 'stopped';
    }
    if (/(?:turn|generation|response).*(?:start|started|in-progress|running|resumed|resume)\b/.test(combined)) {
      return 'running';
    }
    return null;
  }

  function scheduleConversationSocketReconnect(state = conversationSocketState) {
    if (
      !state ||
      state !== conversationSocketState ||
      !state.needsReconnect ||
      state.managed ||
      state.reconnectTimer ||
      state.reconnectQueued ||
      !takeoverActive ||
      !navigator.onLine
    ) {
      return;
    }
    if (![...state.replayFrames.keys()].some((key) => key.includes("subscribe:"))) return;

    const now = Date.now();
    state.reconnectTimes = state.reconnectTimes.filter((at) => now - at < RECONNECT_STORM_WINDOW_MS);
    if (state.reconnectTimes.length >= RECONNECT_STORM_LIMIT) {
      const delay = Math.max(1, state.reconnectTimes[0] + RECONNECT_STORM_WINDOW_MS - now);
      state.reconnectTimer = setTimeout(() => {
        if (state !== conversationSocketState) return;
        state.reconnectTimer = null;
        scheduleConversationSocketReconnect(state);
      }, delay);
      return;
    }

    state.reconnectTimes.push(now);
    state.reconnectQueued = true;
    queueMicrotask(() => {
      if (state !== conversationSocketState) return;
      state.reconnectQueued = false;
      openManagedConversationSocket(state);
    });
  }

  function openManagedConversationSocket(state) {
    if (
      state !== conversationSocketState ||
      !state.needsReconnect ||
      state.managed ||
      !takeoverActive ||
      !navigator.onLine
    ) {
      return;
    }
    try {
      const socket = state.hasProtocols
        ? new state.UpstreamWebSocket(state.url, state.protocols)
        : new state.UpstreamWebSocket(state.url);
      state.managed = socket;
      state.needsReconnect = false;
      observeConversationSocket(socket, state, true);
    } catch {
      state.managed = null;
      state.needsReconnect = true;
      scheduleConversationSocketReconnect(state);
    }
  }

  function reconnectConversationSocketIfNeeded() {
    if (conversationSocketState?.needsReconnect) {
      scheduleConversationSocketReconnect(conversationSocketState);
    }
  }

  function resetConversationSocket() {
    const state = conversationSocketState;
    conversationSocketState = null;
    conversationSocketGeneration += 1;
    if (!state) return;
    clearTimeout(state.reconnectTimer);
    if (state.managed && state.managed.readyState < 2) {
      try { state.managed.close(1000, "page-hidden"); } catch {}
    }
  }

  function interestingSocket(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ""), location.href);
      const host = url.hostname.toLowerCase();
      return (
        url.protocol === "wss:" &&
        (host === "ws.chatgpt.com" || host.endsWith(".chatgpt.com")) &&
        url.pathname.includes("/ws/user/")
      );
    } catch {
      return false;
    }
  }

  function safeSocketUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ""), location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "";
    }
  }

  function conversationIdFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ""), location.href);
      const routeId = url.pathname.match(/\/(?:c|uc)\/([^/?#]+)/)?.[1];
      if (routeId && !isProvisionalConversationId(routeId)) return routeId;
      const apiId = url.pathname.match(/^\/backend-api\/(?:f\/)?conversations?\/([^/?#]+)(?:\/messages)?\/?$/)?.[1];
      return apiId && !["prepare", "resume", "runtime", "messages"].includes(apiId) && !isProvisionalConversationId(apiId)
        ? apiId
        : null;
    } catch {
      return null;
    }
  }

  function isProvisionalConversationId(value) {
    return typeof value === "string" && /^WEB:/i.test(value.trim());
  }

  function emitLocation(force = false) {
    if (suppressLocationEmission) return;
    const href = location.href;
    const changed = href !== observedLocationHref;
    if (changed) {
      preserveDomConversationOwnership(conversationIdFromUrl(observedLocationHref));
      observedLocationHref = href;
      resetResumeSession();
    }
    const conversationId = conversationIdFromUrl(href);
    const syncedIds = typeof canonicalSyncedIds !== 'undefined' ? canonicalSyncedIds : null;
    if ((changed || force === true) && conversationId && (force === true || !syncedIds || !syncedIds.has(conversationId))) {
      bindPendingTurnSession(conversationId);
      queueCanonicalConversation(conversationId, { force: force === true });
    }
    emit({ type: "page-location", url: href });
    scheduleExecutionStateScan(0);
  }

  const nativePushState = history.pushState;
  history.pushState = function slimgptPushState() {
    preserveDomConversationOwnership(conversationIdFromUrl(location.href));
    const result = nativePushState.apply(this, arguments);
    queueMicrotask(emitLocation);
    return result;
  };
  const nativeReplaceState = history.replaceState;
  history.replaceState = function slimgptReplaceState() {
    preserveDomConversationOwnership(conversationIdFromUrl(location.href));
    const result = nativeReplaceState.apply(this, arguments);
    queueMicrotask(emitLocation);
    return result;
  };
  addEventListener("popstate", emitLocation);
  addEventListener("hashchange", emitLocation);
  addEventListener("pageshow", emitLocation);
  globalThis.navigation?.addEventListener?.("currententrychange", emitLocation);
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
      case "set-thinking-level": {
        const level = Number(payload.thinkingLevel);
        if (Number.isInteger(level) && level >= 1 && level <= 5) {
          await queueOfficialThinkingLevel(level);
        }
        return;
      }
      case "set-model-preference":
        if (payload.model && payload.model !== "auto" && location.pathname === "/") {
          const currentModel = new URL(location.href).searchParams.get("model");
          if (currentModel !== payload.model) {
            navigate(`/?model=${encodeURIComponent(payload.model)}`);
          }
        }
        return;
      case "send-message":
        await handleSendCommand(payload);
        return;
      case "stop-generation": {
        // Reuse the existing execution-state stop-control finder: the only
        // supported stop is a click on the official control, never a synthetic
        // request. Failures report precisely instead of going silent.
        const composer = findComposerElement();
        const stopControl = composer ? findExecutionStopControl(composer) : null;
        if (stopControl) {
          stopControl.click();
        } else {
          emit({
            type: "command-error",
            command: "stop-generation",
            error: composer
              ? "官方页面当前没有可点击的停止按钮，生成可能已结束"
              : "找不到官方输入框，无法停止生成；请检查官方页面状态",
          });
        }
        return;
      }
      case "navigate-conversation": {
        const route = payload.route === "uc" ? "uc" : "c";
        navigate(`/${route}/${encodeURIComponent(payload.conversationId || "")}`);
        return;
      }
      case "refresh-conversation": {
        const id = typeof payload.conversationId === 'string' ? payload.conversationId.trim() : '';
        if (id && !isProvisionalConversationId(id)) queueCanonicalConversation(id, { force: true });
        return;
      }
      case "adopt-conversation-id": {
        const conversationId = typeof payload.conversationId === "string"
          ? payload.conversationId.trim()
          : "";
        if (!conversationId || isProvisionalConversationId(conversationId)) return;
        bindPendingTurnSession(conversationId);
        const route = location.pathname.startsWith('/uc/') ? 'uc' : 'c';
        if (!conversationIdFromUrl(location.href)) {
          const target = new URL(`/${route}/${encodeURIComponent(conversationId)}`, location.origin);
          history.replaceState(history.state, '', target.href);
        }
        queueCanonicalConversation(conversationId, { force: true });
        return;
      }
      case "new-chat": {
        const model = payload.model && payload.model !== "auto" ? `?model=${encodeURIComponent(payload.model)}` : "";
        navigate(`/${model}`);
        return;
      }
      case "open-official":
        if (typeof payload?.conversationId === "string") {
          const targetId = payload.conversationId.trim();
          if (targetId && !isProvisionalConversationId(targetId)) {
            const currentId = conversationIdFromUrl(location.href);
            if (currentId !== targetId) {
              const route = location.pathname.startsWith('/uc/') ? 'uc' : 'c';
              navigate(`/${route}/${encodeURIComponent(targetId)}`);
            }
          }
        }
        hideTakeover();
        return;
      case "focus-authority":
        hideTakeover();
        return;
      default:
        return;
    }
  }

  function emitPageStatus() {
    emit({
      type: "page-hook-ready",
      timestamp: Date.now(),
      url: location.href,
      thinkingLevel: readOfficialThinkingLevel(),
    });
    emit({ type: "takeover-state", active: takeoverActive, url: location.href });
  }

  function findThinkingSlider() {
    const selector = [
      '[data-model-reasoning-effort-slider] [role="slider"]',
      'input[type="range"][aria-label*="thinking" i]',
      'input[type="range"][aria-label*="reasoning" i]',
      '[role="slider"][aria-label*="thinking" i]',
      '[role="slider"][aria-label*="reasoning" i]',
      '[data-testid*="reasoning-slider"]',
    ].join(', ');
    return [...document.querySelectorAll(selector)].find((slider) => {
      const container = slider.closest("[data-model-reasoning-effort-slider]");
      return isVisible(container || slider);
    }) || null;
  }

  function levelFromOfficialSlider(slider) {
    if (!slider) return null;
    const raw = slider.getAttribute("aria-valuenow") ?? slider.value;
    const value = Number(raw);
    if (!Number.isInteger(value)) return null;
    const min = Number(slider.getAttribute("aria-valuemin") ?? slider.min);
    const max = Number(slider.getAttribute("aria-valuemax") ?? slider.max);
    if (min === 0 && max === 4 && value >= 0 && value <= 4) return value + 1;
    return value >= 1 && value <= 5 ? value : null;
  }

  function readOfficialThinkingLevel() {
    try {
      return levelFromOfficialSlider(findThinkingSlider());
    } catch {
      return null;
    }
  }

  function findThinkingMenuTrigger() {
    const composer = findComposerElement();
    const form = composer?.closest("form");
    if (!form) return null;
    return [...form.querySelectorAll('button[aria-haspopup="menu"]')].find((button) => {
      if (button.id === "composer-plus-btn" || button.dataset.testid === "composer-plus-btn") return false;
      const label = `${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`.trim();
      return Boolean(label);
    }) || null;
  }

  function activateOfficialControl(element) {
    try { element.focus({ preventScroll: true }); } catch { try { element.focus(); } catch {} }
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...eventInit, buttons: 0, detail: 1 }));
  }

  function waitForThinkingSlider(timeoutMs = 5000) {
    const existing = findThinkingSlider();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      let settled = false;
      const observer = new MutationObserver(() => {
        const slider = findThinkingSlider();
        if (slider) finish(slider);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      const finish = (slider) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve(slider);
      };
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    });
  }

  function waitForThinkingLevel(slider, level, timeoutMs = 5000) {
    if (levelFromOfficialSlider(slider) === level) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const observer = new MutationObserver(() => {
        if (levelFromOfficialSlider(slider) === level) finish(true);
      });
      const timer = setTimeout(() => finish(false), timeoutMs);
      const finish = (matched) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve(matched);
      };
      observer.observe(slider, { attributes: true, attributeFilter: ["aria-valuenow", "value"] });
    });
  }

  async function moveOfficialSlider(slider, level) {
    let current = levelFromOfficialSlider(slider);
    if (current === level) return true;
    if (slider instanceof HTMLInputElement) {
      const min = Number(slider.min || slider.getAttribute("aria-valuemin"));
      const target = min === 0 ? level - 1 : level;
      const confirmation = waitForThinkingLevel(slider, level);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(slider, String(target));
      else slider.value = String(target);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
      return await confirmation;
    }

    try { slider.focus({ preventScroll: true }); } catch { try { slider.focus(); } catch {} }
    while (current !== level) {
      const key = level < current ? "ArrowLeft" : "ArrowRight";
      const next = current + (level < current ? -1 : 1);
      const confirmation = waitForThinkingLevel(slider, next);
      slider.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
      slider.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true }));
      if (!await confirmation) return false;
      current = next;
    }
    return true;
  }

  function queueOfficialThinkingLevel(level) {
    thinkingSync = thinkingSync
      .catch(() => {})
      .then(() => setOfficialThinkingLevelFromSlider(level));
    return thinkingSync;
  }

  async function setOfficialThinkingLevelFromSlider(level) {
    if (!Number.isInteger(level) || level < 1 || level > 5) return false;
    officialFocusPermitDepth += 1;
    const shouldResleep = takeoverActive;
    let trigger = null;
    try {
      wakeOfficialUi();
      let slider = findThinkingSlider();
      if (!slider) {
        trigger = findThinkingMenuTrigger();
        if (!trigger) return false;
        const sliderReady = waitForThinkingSlider();
        activateOfficialControl(trigger);
        slider = await sliderReady;
      }
      if (!slider) return false;
      return await moveOfficialSlider(slider, level);
    } finally {
      if (trigger?.getAttribute("aria-expanded") === "true") {
        try { activateOfficialControl(trigger); } catch {}
      }
      officialFocusPermitDepth = Math.max(0, officialFocusPermitDepth - 1);
      emitPageStatus();
      if (shouldResleep) scheduleRenderSleep();
      queueMicrotask(focusTakeoverFrame);
    }
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
      const level = Number(payload?.thinkingLevel);
      if (Number.isInteger(level) && level >= 1 && level <= 5) {
        await queueOfficialThinkingLevel(level);
      }
      officialFocusPermitDepth += 1;
      wakeOfficialUi();
      await waitForComposerElement(COMPOSER_WAKE_TIMEOUT);
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
          display: none !important;
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

  function hasReactBinding(element) {
    for (let node = element; node && node !== document; node = node.parentNode) {
      try {
        if (Object.getOwnPropertyNames(node).some((key) => /^__react(?:Fiber|Props|Container)\$/.test(key))) {
          return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  function maybeMarkOfficialUiHydrated() {
    if (officialUiHydrated) return true;
    const composer = findComposerElement();
    if (!composer || !hasReactBinding(composer)) return false;
    officialUiHydrated = true;
    scheduleExecutionStateScan(0);
    if (renderSleepRequested && takeoverActive) scheduleRenderSleep(0);
    return true;
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
    if (officialFocusPermitDepth > 0 || sendInFlight) return;
    if (!officialUiHydrated || !frame || frame.dataset.slimgptVisible !== "1") return;
    if (findBlockingOfficialUi()) {
      suspendTakeoverForBlocker();
      return;
    }
    document.documentElement?.setAttribute(SLEEP_ATTR, "1");
  }

  function wakeOfficialUi() {
    clearTimeout(resleepTimer);
    resleepTimer = null;
    document.documentElement?.removeAttribute(SLEEP_ATTR);
  }

  function scheduleRenderSleep(delay = 1200) {
    renderSleepRequested = true;
    if (!officialUiHydrated) {
      maybeMarkOfficialUiHydrated();
      return;
    }
    clearTimeout(resleepTimer);
    resleepTimer = setTimeout(sleepOfficialUi, delay);
  }

  function showTakeover() {
    const frame = document.getElementById(FRAME_ID);
    if (!frame) return;
    if (findBlockingOfficialUi()) {
      suspendTakeoverForBlocker();
      return;
    }
    takeoverActive = true;
    takeoverUserHidden = false;
    frame.dataset.slimgptVisible = "1";
    frame.style.pointerEvents = "auto";
    frame.style.opacity = "1";
    document.getElementById(RESTORE_ID)?.remove();
    emit({ type: "takeover-state", active: true, url: location.href });
    resumeDisconnectedTransports();
    queueMicrotask(focusTakeoverFrame);
    scheduleRenderSleep(0);
  }

  function suspendTakeoverForBlocker() {
    const frame = document.getElementById(FRAME_ID);
    clearTimeout(resleepTimer);
    resleepTimer = null;
    renderSleepRequested = false;
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

  function installBlockerObserver() {
    let scheduled = false;
    const check = () => {
      if (takeoverActive && findBlockingOfficialUi()) {
        suspendTakeoverForBlocker();
      } else if (
        !takeoverActive &&
        !takeoverUserHidden &&
        findComposerElement() &&
        !findBlockingOfficialUi()
      ) {
        showTakeover();
      }
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        check();
      });
    };
    const mount = () => {
      if (!document.documentElement) return;
      const observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['open', 'inert', 'aria-modal', 'class', 'style'],
      });
    };
    if (document.documentElement) mount();
    else new MutationObserver((_, obs) => {
      if (!document.documentElement) return;
      obs.disconnect();
      mount();
    }).observe(document, { childList: true, subtree: true });
    addEventListener('popstate', schedule);
  }

  function hideTakeover() {
    const frame = document.getElementById(FRAME_ID);
    if (!frame) return;
    clearTimeout(resleepTimer);
    renderSleepRequested = false;
    wakeOfficialUi();
    takeoverActive = false;
    takeoverUserHidden = true;
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
    restore.setAttribute("aria-label", "返回 SlimGPT 轻量界面");
    restore.setAttribute("title", "返回 SlimGPT 轻量界面");
    const isDarkMode = window.matchMedia?.("(prefers-color-scheme: dark)").matches ||
      document.documentElement?.classList.contains("dark") ||
      document.documentElement?.getAttribute("data-color-mode") === "dark";
    const bg = isDarkMode ? "#222220" : "#ffffff";
    const fg = isDarkMode ? "#ecece8" : "#20201e";
    const border = isDarkMode ? "1px solid rgba(255,255,255,.2)" : "1px solid rgba(0,0,0,.15)";
    const shadow = isDarkMode ? "0 4px 20px rgba(0,0,0,.5)" : "0 4px 20px rgba(0,0,0,.18)";
    Object.assign(restore.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: "2147483647",
      border,
      borderRadius: "999px",
      padding: "8px 12px",
      background: bg,
      color: fg,
      font: "600 13px system-ui, sans-serif",
      boxShadow: shadow,
      cursor: "pointer",
      outline: "none",
      transition: "outline 0.15s ease",
    });
    restore.addEventListener("focus", () => {
      restore.style.outline = isDarkMode ? "2px solid #58b99a" : "2px solid #22735e";
      restore.style.outlineOffset = "2px";
    });
    restore.addEventListener("blur", () => {
      restore.style.outline = "none";
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
      emitLocation(true);
      return;
    }
    navigateThroughOfficialRouter(target);
  }

  function navigateThroughOfficialRouter(target) {
    try {
      const candidates = target.pathname === '/'
        ? [
            document.querySelector('[data-testid="create-new-chat-button"]'),
            document.querySelector('a[href="/"]'),
          ]
        : [...document.querySelectorAll('a[href]')].filter((anchor) => {
            try {
              const href = new URL(anchor.href, location.href);
              return href.origin === target.origin && href.pathname === target.pathname;
            } catch {
              return false;
            }
          });
      const control = candidates.find(Boolean) || null;
      if (control) {
        try {
          control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        } catch {
          control.click();
        }
      }
      // Update history and notify listeners. Always update location gracefully
      // within the single-page application lifecycle without a hard reload.
      if (location.pathname !== target.pathname || location.search !== target.search) {
        history.pushState(history.state, '', target.href);
        window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
        emitLocation();
      }
    } catch (error) {
      emit({
        type: 'command-error',
        command: 'navigate-conversation',
        error: `无法通过官方路由切换会话：${String(error?.message || error)}`,
      });
    }
  }

  async function sendThroughOfficialComposer(text, commandId) {
    const submittedText = String(text || "").trim();
    if (!submittedText) {
      return { ok: false, commandId, error: "empty-message" };
    }
    let composer = findComposer();
    if (!composer) composer = await rehydrateOfficialComposer();
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
        const inserted = document.execCommand("insertText", false, submittedText);
        if (!inserted) {
          composer.textContent = submittedText;
          composer.dispatchEvent(new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: submittedText,
          }));
          composer.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: submittedText,
          }));
        }
      }

      const sendButton = await waitForSendButton(composer, SEND_CONTROL_TIMEOUT);
      if (!sendButton) {
        const actualText = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : composer.textContent;
        const error = String(actualText || "").trim() === submittedText
          ? "send-control-not-ready"
          : "composer-rejected-input";
        return { ok: false, commandId, error };
      }
      const officialLevel = readOfficialThinkingLevel();
      const confirmation = beginSendConfirmation(submittedText);
      sendButton.click();
      // A click is not proof. Success requires an accepted official
      // conversation request or a matching user turn echoed into the DOM.
      const confirmed = await confirmation;
      if (!confirmed) {
        return { ok: false, commandId, error: "send-unconfirmed", method: "button", officialThinkingLevel: officialLevel };
      }
      return { ok: true, commandId, method: "button", officialThinkingLevel: officialLevel };
    } catch (error) {
      return { ok: false, commandId, error: String(error?.message || error) };
    }
  }

  function settleSendConfirmation(ok, reason) {
    const pending = pendingSendConfirmation;
    if (!pending || pending.settled) return;
    if (!ok) {
      pending.finish(false);
      return;
    }
    pending.acceptedReason = reason;
    pending.finish(true);
  }

  function officialDomTextFor(submittedText) {
    const needle = submittedText.slice(0, 48);
    if (!needle) return false;
    for (const node of document.querySelectorAll('[data-message-author-role="user"]')) {
      if (String(node.textContent || "").includes(needle)) return true;
    }
    return false;
  }

  function beginSendConfirmation(submittedText) {
    if (pendingSendConfirmation) pendingSendConfirmation.finish(false);
    return new Promise((resolve) => {
      let timer = null;
      const conversationId = executionConversationIdFromUrl();
      const observer = new MutationObserver(() => {
        if (officialDomTextFor(submittedText)) finish(true);
        else if (findBlockingOfficialUi()) finish(false);
      });
      const finish = (confirmed) => {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(timer);
        observer.disconnect();
        if (pendingSendConfirmation === pending) pendingSendConfirmation = null;
        if (confirmed) {
          emitExecutionState('running', 'submission-accepted', conversationId);
          scheduleExecutionStateScan(0);
        }
        resolve(confirmed);
      };
      const pending = {
        submittedText,
        conversationId,
        settled: false,
        acceptedReason: null,
        finish,
      };
      pendingSendConfirmation = pending;
      observer.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
      timer = setTimeout(() => finish(false), SEND_CONFIRM_TIMEOUT);
      if (officialDomTextFor(submittedText)) finish(true);
    });
  }

  async function rehydrateOfficialComposer() {
    const conversationId = conversationIdFromUrl(location.href);
    if (!conversationId || !document.documentElement) return null;
    const targetUrl = location.href;
    const deadline = Date.now() + COMPOSER_REHYDRATE_TIMEOUT;
    const remaining = () => Math.max(0, deadline - Date.now());
    preserveDomConversationOwnership(conversationId);
    suppressLocationEmission = true;
    try {
      const currentRetry = findOfficialLoadRetryControl();
      if (currentRetry) {
        currentRetry.click();
        const recovered = await waitForOfficialDom(() => {
          const composer = findComposer();
          return composer
            ? { composer, ready: Boolean(document.querySelector("[data-message-author-role]")) }
            : null;
        }, Math.min(2_500, remaining()));
        if (recovered?.ready) return recovered.composer;
      }

      nativeReplaceState.call(history, history.state, "", location.origin);
      window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      const rootComposer = await recoverOfficialRouteComposer(null, remaining(), false);
      if (!rootComposer) return null;

      let routeLink = findOfficialRouteLink(targetUrl);
      if (!routeLink) {
        routeLink = await waitForOfficialDom(
          () => findOfficialRouteLink(targetUrl),
          Math.min(2_500, remaining()),
        );
      }
      if (routeLink) {
        routeLink.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }));
      } else {
        nativeReplaceState.call(history, history.state, "", targetUrl);
        window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
      }
      return await recoverOfficialRouteComposer(rootComposer, remaining(), true);
    } finally {
      if (location.href !== targetUrl) {
        nativeReplaceState.call(history, history.state, "", targetUrl);
      }
      suppressLocationEmission = false;
      emitLocation();
    }
  }

  async function recoverOfficialRouteComposer(previousComposer, timeoutMs, requireMessages) {
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    const state = await waitForOfficialDom(() => {
      const composer = findComposer();
      const hasMessages = Boolean(document.querySelector("[data-message-author-role]"));
      const routeReady = composer &&
        (!requireMessages || hasMessages) &&
        (!previousComposer || composer !== previousComposer || hasMessages);
      return {
        composer: routeReady ? composer : null,
        retry: findOfficialLoadRetryControl(),
      };
    }, remaining(), (value) => Boolean(value.composer || value.retry));
    if (state?.composer) return state.composer;
    if (!state?.retry) return null;
    state.retry.click();
    return await waitForOfficialDom(() => {
      const composer = findComposer();
      const hasMessages = Boolean(document.querySelector("[data-message-author-role]"));
      return composer &&
        (!requireMessages || hasMessages) &&
        (!previousComposer || composer !== previousComposer || hasMessages)
          ? composer
          : null;
    }, remaining());
  }

  function findOfficialRouteLink(rawUrl) {
    const target = new URL(rawUrl, location.origin);
    for (const anchor of document.querySelectorAll("a[href]")) {
      try {
        const href = new URL(anchor.href, location.href);
        if (href.origin === target.origin && href.pathname === target.pathname) return anchor;
      } catch {}
    }
    return null;
  }

  function findOfficialLoadRetryControl() {
    if (findComposer()) return null;
    for (const button of document.querySelectorAll("button")) {
      if (!(button instanceof HTMLButtonElement) || button.disabled || button.hidden) continue;
      const label = String(button.textContent || "").replace(/\s+/g, " ").trim();
      if (/^(?:try again|retry|重试|再试一次)$/i.test(label)) return button;
    }
    return null;
  }

  function waitForOfficialDom(predicate, timeoutMs, accepts = Boolean) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve(value);
      };
      const scan = () => {
        const value = predicate();
        if (accepts(value)) finish(value);
      };
      const observer = new MutationObserver(scan);
      const timer = setTimeout(() => finish(null), timeoutMs);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled", "aria-disabled", "contenteditable"],
      });
      queueMicrotask(scan);
    });
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
    const officialSelectors = [
      '#composer-submit-button',
      '[data-composer-submit]',
      '[data-testid="send-button"]',
      '[data-testid="fruitjuice-send-button"]',
      '[data-testid="composer-send-button"]',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="Prompt"]',
    ];

    // Current ChatGPT renders the ProseMirror editor and its submit control in
    // sibling subtrees.  A closest-form assumption therefore misses the real
    // #composer-submit-button even though it is enabled.  Strong official send
    // identities are safe to resolve document-wide; generic submit buttons are
    // only considered inside the editor's own form so sidebar/search controls
    // cannot be clicked accidentally.
    for (const selector of officialSelectors) {
      const button = [...document.querySelectorAll(selector)].find(isUsableButton);
      if (button) return button;
    }

    const form = composer?.closest("form");
    if (form) {
      const button = [...form.querySelectorAll('button[type="submit"]')].find(isUsableButton);
      if (button) return button;
    }
    return null;
  }

  function waitForSendButton(composer, timeoutMs) {
    const existing = findSendButton(composer);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      let settled = false;
      const root = document.documentElement || document;
      const observer = new MutationObserver(() => {
        const button = findSendButton(composer);
        if (button) finish(button);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      const finish = (button) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve(button);
      };
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled", "aria-disabled", "data-visually-disabled", "data-testid"],
      });
    });
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
})();
