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
  const SEND_CONTROL_TIMEOUT = 1_500;
  const SEND_CONFIRM_TIMEOUT = 10_000;
  const BLOCKED_TAKEOVER_RETRY_MS = 500;
  const TAKEOVER_BLOCKER_GUARD_MS = 5_000;
  const COMPLETE_RESPONSE_RECLICK_MS = 1_250;
  const RESUME_PATH = "/backend-api/f/conversation/resume";
  const RECONNECT_STORM_WINDOW_MS = 15_000;
  const RECONNECT_STORM_LIMIT = 6;
  const EXECUTION_DOM_SETTLE_MS = 220;
  const EXECUTION_SUBMISSION_GRACE_MS = 1_200;
  const NEW_CHAT_EXECUTION_KEY = "__slimgpt_new_chat__";
  const MAX_EXECUTION_STATES = 256;
  const CONVERSATION_INDEX_PAGE_SIZE = 100;
  const MAX_SYNCED_CONVERSATIONS = 500;
  const CONVERSATION_INDEX_REFRESH_MS = 30_000;
  const CONVERSATION_INDEX_RETRY_MS = 5_000;
  let requestCounter = 0;
  let resleepTimer = null;
  let sendInFlight = false;
  let takeoverActive = false;
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
  let lastConversationIndexSyncAt = 0;
  let lastConversationIndexSyncAttemptAt = 0;
  let turnSessionCounter = 0;
  let pendingNewTurnSession = null;
  let thinkingSync = Promise.resolve();
  let resumeGeneration = 0;
  let resumeSession = null;
  let conversationSocketGeneration = 0;
  let conversationSocketState = null;
  let observedLocationHref = location.href;
  let preserveDomConversationOwnership = () => {};
  let executionObserver = null;
  let executionScanTimer = null;
  let executionIdleTimer = null;
  let executionIdleCandidateKey = null;
  const canonicalFetches = new Map();
  const pendingCanonicalIds = new Set();
  const activeTurnSessions = new Map();
  const executionStates = new Map();
  const lastDomRunningAt = new Map();
  const lastExecutionStoppedAt = new Map();
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
      for (let i = Math.max(0, nodes.length - 15); i < nodes.length; i += 1) {
        const roleNode = nodes[i];
        const role = String(roleNode.getAttribute('data-message-author-role') || '').toLowerCase();
        if (!['user', 'assistant', 'tool'].includes(role)) continue;
        const messageRoot = roleNode.closest('[data-message-id]') || roleNode.querySelector?.('[data-message-id]');
        const messageId = messageRoot?.getAttribute?.('data-message-id') || roleNode.getAttribute('data-message-id');
        if (!messageId) continue;
        const ownerNode = messageRoot || roleNode;
        const conversationId = messageOwners.get(ownerNode) || pageConversationId;
        if (!messageOwners.has(ownerNode)) messageOwners.set(ownerNode, conversationId);
        const text = String(roleNode.textContent || '').replace(/\u00a0/g, ' ').trim();
        const seenKey = `${conversationId}\u0000${messageId}`;
        if (!text || seenText.get(seenKey) === text) continue;
        seenText.set(seenKey, text);
        if (seenText.size > MAX_SEEN_MESSAGES) {
          const oldest = seenText.keys().next().value;
          seenText.delete(oldest);
        }
        const turnSession = executionStates.get(executionKey(conversationId))?.state === 'running'
          ? activeTurnSessions.get(conversationId)
          : null;
        emit({
          type: "page-capture",
          transport: "dom",
          phase: "message",
          requestId: `dom-${messageId}`,
          url: location.href,
          conversationId,
          ...(turnSession?.turnId
            ? { turnId: turnSession.turnId }
            : {}),
          ...(turnSession?.turnAliases?.length
            ? { turnAliases: turnSession.turnAliases.slice() }
            : {}),
          ...(turnSession?.transportTurnId
            ? { transportTurnId: turnSession.transportTurnId }
            : {}),
          ...(turnSession?.userMessageId
            ? { turnUserMessageId: turnSession.userMessageId }
            : {}),
          ...(turnSession?.parentMessageId
            ? { turnParentMessageId: turnSession.parentMessageId }
            : {}),
          mimeType: "application/json",
          timestamp: Date.now(),
          data: JSON.stringify({
            conversation_id: conversationId,
            message: {
              id: messageId,
              author: { role },
              content: { content_type: "text", parts: [text] },
              // The DOM never knows the stream lifecycle: claiming
              // in_progress here regresses already-finished messages. The
              // UI merge preserves richer state from real stream events.
              status: null,
              end_turn: null,
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

    if (state === 'stopped' && source === 'dom-composer-ready' && previous?.state === 'running') {
      const domRunningAt = lastDomRunningAt.get(key) || 0;
      const stoppedAt = lastExecutionStoppedAt.get(key) || 0;
      const witnessedThisRun = domRunningAt > stoppedAt;
      const submissionGrace = ['submission-accepted', 'sse-active'].includes(previous.source) &&
        now - previous.observedAt < EXECUTION_SUBMISSION_GRACE_MS;
      const authoritativeServerRun = previous.source === 'ws-turn-running' && !witnessedThisRun;
      if (submissionGrace || authoritativeServerRun) {
        scheduleExecutionStateScan(Math.max(EXECUTION_DOM_SETTLE_MS, EXECUTION_SUBMISSION_GRACE_MS - (now - previous.observedAt)));
        return;
      }
    }

    if (state === 'running' && source === 'dom-stop-control') lastDomRunningAt.set(key, now);
    if (state === 'stopped') lastExecutionStoppedAt.set(key, now);

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
        lastDomRunningAt.delete(candidateKey);
        lastExecutionStoppedAt.delete(candidateKey);
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
        : (request && isResumeRequest(request) ? snapshotActiveTurn(conversationScope) : null);
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
      let clone;
      try {
        clone = response.clone();
      } catch {
        return response;
      }

      const divertOfficialStream = shouldDivertOfficialConversationStream(response, url, mimeType);
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

      if (mimeType.includes("text/vnd.openai.web-mobile-partial+html") && clone.body) {
        void captureWebMobileStream(clone.body, captureMeta);
      } else if (mimeType.includes("text/event-stream") && clone.body) {
        const streamMeta = { ...captureMeta };
        if (divertResume) {
          streamMeta.resume = true;
          streamMeta.cancelSignal = resumeSession?.generation === resumeGenerationForCapture
            ? resumeSession.controller?.signal
            : null;
          streamMeta.onClose = (result) => handleResumeStreamClose(resumeGenerationForCapture, result);
        }
        void captureReadableStream(clone.body, streamMeta);
      } else {
        const declaredLength = Number(response.headers.get("content-length") || 0);
        if (!declaredLength || declaredLength <= MAX_NON_STREAM_BODY) {
          void captureBoundedResponse(clone, captureMeta);
        }
      }

      return divertOfficialStream ? completeOfficialStream(response) : response;
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
    const urlConversationId = conversationIdFromUrl(request?.url);
    const bodyConversationId = isConversationSubmission(request) || isResumeRequest(request)
      ? readRequestConversationId(request)
      : Promise.resolve(null);
    return bodyConversationId.then((bodyId) => {
      if (bodyId && urlConversationId && bodyId !== urlConversationId) {
        return { conversationId: null, conflicted: true };
      }
      return {
        conversationId: bodyId || urlConversationId,
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
    const [scope, identity] = await Promise.all([
      conversationScope?.catch(() => ({ conversationId: null, conflicted: false })) ||
        Promise.resolve({ conversationId: null, conflicted: false }),
      readRequestTurnIdentity(request),
    ]);
    if (!scope?.conflicted && scope?.conversationId) session.conversationId = scope.conversationId;
    if (identity?.userMessageId) session.userMessageId = identity.userMessageId;
    if (identity?.parentMessageId) session.parentMessageId = identity.parentMessageId;
    if (identity?.turnId) session.turnId = identity.turnId;
    if (identity?.turnAliases?.length) session.turnAliases = identity.turnAliases;
    if (identity?.turnExchangeId) session.turnExchangeId = identity.turnExchangeId;
    if (identity?.workingTurnId) session.workingTurnId = identity.workingTurnId;
    if (identity?.requestId) session.requestId = identity.requestId;
    if (identity?.turnTraceId) session.turnTraceId = identity.turnTraceId;
    if (!session.transportTurnId) session.transportTurnId = session.sessionId;
    registerTurnSession(session);
    return { ...session };
  }

  async function snapshotActiveTurn(conversationScope) {
    const scope = await (conversationScope?.catch(() => ({ conversationId: null, conflicted: false })) ||
      Promise.resolve({ conversationId: null, conflicted: false }));
    if (scope?.conflicted) return null;
    const conversationId = scope?.conversationId || null;
    let session = conversationId ? activeTurnSessions.get(conversationId) : null;
    if (!session && pendingNewTurnSession) {
      if (conversationId) bindPendingTurnSession(conversationId);
      session = conversationId ? activeTurnSessions.get(conversationId) : pendingNewTurnSession;
    }
    return session ? { ...session } : null;
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
    );
    const workingTurnId = firstTurnIdentityString(
      metadata.working_turn_id,
      metadata.workingTurnId,
      userMessage?.working_turn_id,
      userMessage?.workingTurnId,
    );
    const requestId = firstTurnIdentityString(
      metadata.request_id,
      metadata.requestId,
      userMessage?.request_id,
      userMessage?.requestId,
    );
    const turnTraceId = firstTurnIdentityString(
      metadata.turn_trace_id,
      metadata.turnTraceId,
      userMessage?.turn_trace_id,
      userMessage?.turnTraceId,
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
    if (session.conversationId && activeTurnSessions.get(session.conversationId)?.sessionId === session.sessionId) {
      activeTurnSessions.delete(session.conversationId);
    }
    if (pendingNewTurnSession?.sessionId === session.sessionId) pendingNewTurnSession = null;
  }

  function bindPendingTurnSession(conversationId) {
    if (!conversationId || !pendingNewTurnSession) return;
    const session = { ...pendingNewTurnSession, conversationId };
    pendingNewTurnSession = null;
    activeTurnSessions.set(conversationId, session);
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
    const resolved = scope.conversationId
      ? { ...captureMeta, conversationId: scope.conversationId }
      : { ...captureMeta };
    if (turn?.turnId) resolved.turnId = turn.turnId;
    if (turn?.turnAliases?.length) resolved.turnAliases = turn.turnAliases.slice();
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
    if (!lastConversationIndexSyncAt) requestConversationIndexSync();
  }

  function requestConversationIndexSync() {
    const sourceHeaders = backendHeaders || backendSessionHeaders;
    const now = Date.now();
    if (!backendFetch || !sourceHeaders || conversationIndexSync) return;
    if (now - lastConversationIndexSyncAt < CONVERSATION_INDEX_REFRESH_MS) return;
    if (now - lastConversationIndexSyncAttemptAt < CONVERSATION_INDEX_RETRY_MS) return;
    lastConversationIndexSyncAttemptAt = now;
    conversationIndexSync = syncConversationIndex(new Headers(sourceHeaders))
      .then((synced) => {
        if (synced) lastConversationIndexSyncAt = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        conversationIndexSync = null;
      });
  }

  async function syncConversationIndex(sourceHeaders) {
    const headers = new Headers(sourceHeaders);
    headers.delete("content-length");
    headers.delete("content-type");
    headers.set("accept", "application/json");

    let offset = 0;
    let synced = false;
    const seenPages = new Set();
    while (offset < MAX_SYNCED_CONVERSATIONS) {
      const limit = Math.min(CONVERSATION_INDEX_PAGE_SIZE, MAX_SYNCED_CONVERSATIONS - offset);
      const url = new URL("/backend-api/conversations", location.origin);
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("order", "updated");

      const response = await Reflect.apply(observedFetch, window, [
        url.href,
        {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers,
        },
      ]);
      if (!response.ok) return synced;

      const text = await response.text();
      if (text.length > MAX_NON_STREAM_BODY) return synced;
      synced = true;

      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return synced;
      }
      const items = Array.isArray(value?.items)
        ? value.items
        : (Array.isArray(value?.data?.items) ? value.data.items : []);
      if (!items.length) return synced;

      const firstId = items[0]?.id || '';
      const lastId = items[items.length - 1]?.id || '';
      const pageSignature = `${items.length}:${firstId}:${lastId}`;
      if (seenPages.has(pageSignature)) return synced;
      seenPages.add(pageSignature);

      offset += items.length;
      const rawTotal = value?.total ?? value?.data?.total;
      const total = rawTotal == null ? Number.NaN : Number(rawTotal);
      if (Number.isFinite(total) && offset >= total) return synced;
      const hasMore = value?.has_more ?? value?.hasMore ?? value?.data?.has_more ?? value?.data?.hasMore;
      if (hasMore === false) return synced;
    }
    return synced;
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
  // the real resume response and gives the official consumer an immediate
  // terminal frame. If the owned stream drops without [DONE], the exact
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

  function completeOfficialStream(response) {
    try {
      void response.body.cancel().catch(() => {});
    } catch {
      // The capture clone already owns the stream; cancellation is only a
      // best-effort release of the official parser's tee branch.
    }
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    headers.set("content-type", "text/event-stream; charset=utf-8");
    const completed = new Response("data: [DONE]\n\n", {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    observedFetchResponses.add(completed);
    return completed;
  }

  async function captureReadableStream(stream, meta) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const { onClose, cancelSignal, ...unresolvedMeta } = meta;
    const captureMeta = await resolveCaptureMeta(unresolvedMeta);
    if (captureMeta.conversationId && isExecutionStreamUrl(captureMeta.url)) {
      emitExecutionState('running', 'sse-active', captureMeta.conversationId);
    }
    const cancelReader = () => { void reader.cancel().catch(() => {}); };
    if (cancelSignal?.aborted) cancelReader();
    else cancelSignal?.addEventListener("abort", cancelReader, { once: true });
    let markerTail = "";
    let sawDone = false;
    let readError = null;

    const captureChunk = (data) => {
      if (!data) return;
      markerTail = `${markerTail}${data}`.slice(-256);
      if (/(?:^|\n)\s*data:\s*\[DONE\]/.test(markerTail)) sawDone = true;
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
      if (captureMeta.conversationId) queueCanonicalConversation(captureMeta.conversationId);
      cancelSignal?.removeEventListener("abort", cancelReader);
      reader.releaseLock();
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
          const urlConversationId = conversationIdFromUrl(url.href);
          const bodyCanDeclareConversation = String(meta.method || "").toUpperCase() === "POST" &&
            (url.pathname === "/backend-api/conversation" ||
              url.pathname === "/backend-api/f/conversation" ||
              url.pathname === RESUME_PATH);
          const bodyConversationId = bodyCanDeclareConversation
            ? conversationIdFromRequestBody(body)
            : null;
          const conversationScope = Promise.resolve(
            bodyConversationId && urlConversationId && bodyConversationId !== urlConversationId
              ? { conversationId: null, conflicted: true }
              : {
                  conversationId: bodyConversationId || urlConversationId,
                  conflicted: false,
                },
          );
          const conversationRequest = String(meta.method || "").toUpperCase() === "POST" &&
            url.origin === location.origin &&
            (url.pathname === "/backend-api/conversation" || url.pathname === "/backend-api/f/conversation");
          const turnScope = conversationRequest
            ? snapshotXhrSubmissionTurn(body, conversationScope)
            : (url.pathname === RESUME_PATH ? snapshotActiveTurn(conversationScope) : null);
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
    const [scope, identity] = await Promise.all([
      conversationScope?.catch(() => ({ conversationId: null, conflicted: false })) ||
        Promise.resolve({ conversationId: null, conflicted: false }),
      Promise.resolve(turnIdentityFromRequestBody(body)),
    ]);
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
    return { ...session };
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

  function queueCanonicalConversation(conversationId) {
    if (!conversationId) return;
    pendingCanonicalIds.add(conversationId);
    drainCanonicalFetches();
  }

  function drainCanonicalFetches() {
    if (!backendFetch || !(backendHeaders || backendSessionHeaders)) return;
    for (const conversationId of pendingCanonicalIds) {
      if (!canonicalFetches.has(conversationId)) void fetchCanonicalConversation(conversationId);
    }
  }

  async function fetchCanonicalConversation(conversationId) {
    const sourceHeaders = backendHeaders || backendSessionHeaders;
    if (canonicalFetches.has(conversationId) || !backendFetch || !sourceHeaders) return;
    const task = (async () => {
      const headers = new Headers(sourceHeaders);
      headers.delete("content-length");
      headers.delete("content-type");
      headers.set("accept", "application/json");
      const pages = await fetchCanonicalConversationPages(conversationId, headers);
      if (!pages.length) return;
      pendingCanonicalIds.delete(conversationId);
      const ordered = pages.slice().reverse();
      const syncId = nextRequestId("sync");
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
    })();
    canonicalFetches.set(conversationId, task);
    try {
      await task;
    } catch {
      // A later WS notification or authenticated request retries this id.
    } finally {
      canonicalFetches.delete(conversationId);
    }
  }

  async function fetchCanonicalConversationPages(conversationId, headers) {
    const pages = [];
    const seenCursors = new Set();
    let before = null;

    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const url = new URL(`/backend-api/conversations/${encodeURIComponent(conversationId)}`, location.origin);
      url.searchParams.set("include_has_versions", "true");
      url.searchParams.set("num_turns", "100");
      if (before) url.searchParams.set("before", before);
      const response = await Reflect.apply(backendFetch, backendFetchThis, [
        url.href,
        {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: new Headers(headers),
        },
      ]);
      if (!response.ok) {
        if (!pages.length) return fetchLegacyCanonicalConversation(conversationId, headers);
        return [];
      }
      const text = await response.text();
      if (!text || text.length > MAX_NON_STREAM_BODY) return [];
      let value;
      try { value = JSON.parse(text); } catch { return []; }
      pages.push({
        text,
        url: response.url || url.href,
        status: response.status,
        mimeType: response.headers.get("content-type") || "application/json",
      });

      // Legacy/full tree responses are already complete in one request.
      if (value?.mapping && value?.current_node) break;
      const pageInfo = value?.page_info || value?.data?.page_info || null;
      if (!pageInfo?.has_previous_page) break;
      const cursor = String(pageInfo.start_cursor || "").trim();
      if (!cursor || seenCursors.has(cursor)) return [];
      seenCursors.add(cursor);
      before = cursor;
    }
    return pages;
  }

  async function fetchLegacyCanonicalConversation(conversationId, headers) {
    const url = new URL(`/backend-api/conversation/${encodeURIComponent(conversationId)}`, location.origin);
    const response = await Reflect.apply(backendFetch, backendFetchThis, [
      url.href,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: new Headers(headers),
      },
    ]);
    if (!response.ok) return [];
    const text = await response.text();
    if (!text || text.length > MAX_NON_STREAM_BODY) return [];
    try {
      const value = JSON.parse(text);
      if (!value?.mapping || !value?.current_node) return [];
    } catch {
      return [];
    }
    return [{
      text,
      url: response.url || url.href,
      status: response.status,
      mimeType: response.headers.get("content-type") || "application/json",
    }];
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
        const stateValue = notificationExecutionState(notification);
        if (conversationId && stateValue === 'running') {
          adoptNotificationTurnIdentity(conversationId, notification);
          emitExecutionState('running', 'ws-turn-running', conversationId, { phase: notification.type });
        } else if (conversationId && stateValue === 'stopped') {
          emitExecutionState('stopped', 'ws-turn-stopped', conversationId, { phase: notification.type });
          const activeSession = activeTurnSessions.get(conversationId);
          if (!activeSession || notificationMatchesTurnSession(notification, activeSession)) {
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
        if (conversationId) queueCanonicalConversation(conversationId);
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
        conversationId: eventPayload.conversation_id || eventPayload.conversationId || null,
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
    const existingAliases = uniqueTurnIdentityStrings(session.turnAliases || []);
    if (
      existingAliases.length &&
      !existingAliases.some((alias) => notification.turnAliases.includes(alias))
    ) {
      return;
    }
    activeTurnSessions.set(conversationId, {
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

  function notificationMatchesTurnSession(notification, session) {
    const notificationAliases = uniqueTurnIdentityStrings(notification?.turnAliases || []);
    const sessionAliases = uniqueTurnIdentityStrings(session?.turnAliases || []);
    if (!notificationAliases.length || !sessionAliases.length) return true;
    return notificationAliases.some((alias) => sessionAliases.includes(alias));
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
      if (routeId) return routeId;
      const apiId = url.pathname.match(/^\/backend-api\/(?:f\/)?conversations?\/([^/?#]+)\/?$/)?.[1];
      return apiId && !["prepare", "resume", "runtime"].includes(apiId)
        ? apiId
        : null;
    } catch {
      return null;
    }
  }

  function emitLocation() {
    if (location.href !== observedLocationHref) {
      preserveDomConversationOwnership(conversationIdFromUrl(observedLocationHref));
      observedLocationHref = location.href;
      resetResumeSession();
    }
    const conversationId = conversationIdFromUrl(location.href);
    if (conversationId) {
      bindPendingTurnSession(conversationId);
      queueCanonicalConversation(conversationId);
    }
    emit({ type: "page-location", url: location.href });
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
      case "navigate-conversation": {
        const route = payload.route === "uc" ? "uc" : "c";
        if (payload.conversationId) queueCanonicalConversation(payload.conversationId);
        navigate(`/${route}/${encodeURIComponent(payload.conversationId || "")}`);
        return;
      }
      case "new-chat": {
        const model = payload.model && payload.model !== "auto" ? `?model=${encodeURIComponent(payload.model)}` : "";
        navigate(`/${model}`);
        return;
      }
      case "open-official":
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
    if (!officialUiHydrated || !frame || frame.dataset.slimgptVisible !== "1") return;
    if (findBlockingOfficialUi()) {
      suspendTakeoverForBlocker();
      return;
    }
    document.documentElement?.setAttribute(SLEEP_ATTR, "1");
  }

  function wakeOfficialUi() {
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
      } else if (!takeoverActive && findComposerElement() && !findBlockingOfficialUi()) {
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
    const roots = form ? [form] : [document];
    for (const root of roots) {
      for (const selector of selectors) {
        const button = [...root.querySelectorAll(selector)].find(isUsableButton);
        if (button) return button;
      }
    }
    return null;
  }

  function waitForSendButton(composer, timeoutMs) {
    const existing = findSendButton(composer);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      let settled = false;
      const root = composer?.closest("form") || document.documentElement || document;
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
