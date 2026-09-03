<script>
  import { onMount } from 'svelte';
  import { Button, Navbar, NavLeft, NavRight, Page } from 'framework7-svelte';
  import ConversationSidebar from '../components/ConversationSidebar.svelte';
  import ConversationTurnStage from '../components/ConversationTurnStage.svelte';
  import MessageOverview from '../components/MessageOverview.svelte';
  import Composer from '../components/Composer.svelte';
  import { createTransport } from '../lib/transport.js';
  import { downloadConversationMarkdown } from '../lib/export.js';
  import {
    loadConversationIndex,
    loadObservationLedger,
    saveConversationIndex,
    saveObservationLedger,
    loadUserSettings,
    saveUserSettings,
    subscribeStorageChanges,
    DEFAULT_SETTINGS,
    THINKING_LEVELS,
  } from '../lib/storage.js';
  import {
    bindConversationTurnUser,
    buildConversationRecordTimeline,
    buildConversationView,
    contentToText,
    consumeSse,
    createConversationSseDecoder,
    conversationIdFromPayload,
    conversationIdFromUrl,
    conversationThinkingLevel,
    decodeCaptureBody,
    extractConversationItems,
    findConversationLifecycleEvents,
    findConversationPayload,
    findMessageEvents,
    fingerprintCapture,
    getToolMessageInfo,
    hydrateConversationObservations,
    ingestConversationMessage,
    ingestConversationPayload,
    messageTurnIdentity,
    parseJson,
    parseWebMobilePartialConversation,
    resolveConversationScope,
    setConversationRecordTerminal,
    stepConversationBranch,
  } from '../../core.js';

  const transport = createTransport();
  let status = $state({ bridgeReady: false, captureMode: null });
  let conversationMap = $state(new Map());
  let conversationRecords = $state(new Map());
  let pendingUser = $state(null);
  let currentConversationId = $state(null);
  let loadingConversationId = $state(null);
  let navigationTimedOutId = $state(null);
  let captures = $state(0);
  let composerStatus = $state('');
  let composerError = $state(false);
  let draft = $state('');
  let sendInFlight = $state(false);
  let pendingCommandId = null;
  let pendingCommandConversationId = null;
  let compactLayout = $state(true);
  let mobilePanel = $state('none');
  let panelPointerIntent = null;
  let activeTurnIndex = $state(0);
  let saveTimer = null;
  let persistInFlight = false;
  let persistQueued = false;
  let sendTimer = null;
  let navigationTimer = null;
  let observationOrdinal = 0;
  let userSettings = $state({ ...DEFAULT_SETTINGS });
  let thinkingLevelOverride = $state(null);
  let workStates = $state(new Map());
  let newChatWorkState = $state('unknown');
  const MAX_CAPTURE_BUFFER = 20 * 1024 * 1024;
  const MAX_CACHED_CONVERSATIONS = 24;
  // Main-world recovery is MutationObserver-driven but can traverse the
  // official root error boundary before it confirms the conversation request.
  const SEND_COMMAND_WATCHDOG_MS = 30_000;
  const sseBuffers = new Map();
  const sseDecoders = new Map();
  const xhrBuffers = new Map();
  const captureConversationIds = new Map();
  const conflictedCaptureIds = new Set();
  const draftsByConversation = new Map();
  const recentFingerprints = new Set();
  const locallyPromotedConversationIds = new Set();
  const pendingLiveEvents = new Map();
  const MAX_PENDING_LIVE_EVENTS = 512;
  let pendingLiveEventCount = 0;

  const conversations = $derived([...conversationMap.values()]);
  const currentRecord = $derived(currentConversationId ? conversationRecords.get(currentConversationId) || null : null);
  const currentPayload = $derived(currentRecord?.payload || null);
  const currentHasRenderableContent = $derived(Boolean(
    currentConversationId && hasRenderableConversationContent(currentConversationId)
  ));
  const currentMeta = $derived(currentConversationId ? conversationMap.get(currentConversationId) : null);
  const displayConversationId = $derived(currentConversationId);
  const timeline = $derived.by(() => {
    const id = displayConversationId;
    if (!id) return { turns: [], unresolved: [] };
    const record = conversationRecords.get(id) || null;
    const pending = pendingUser?.conversationId === id ? pendingUser.message : null;
    return buildConversationRecordTimeline(record, pending);
  });
  const turns = $derived(timeline.turns);
  const unresolvedTurns = $derived(timeline.unresolved);
  const messages = $derived(
    [...turns, ...unresolvedTurns]
      .flatMap((turn) => [turn.user, ...(turn.replies || [])].filter(Boolean))
  );
  const liveConnected = $derived(status.bridgeReady && status.captureMode === 'page');
  const statusState = $derived(status.bridgeError ? 'error' : (liveConnected ? 'online' : 'offline'));
  const statusLabel = $derived(status.bridgeError ? '连接失败' : (liveConnected ? (status.takeover === false ? '已连接' : '已接管') : '连接中'));
  const conversationHistoryPending = $derived(Boolean(currentConversationId && !currentRecord?.canonicalComplete));
  const conversationPending = $derived(Boolean(conversationHistoryPending && navigationTimedOutId !== currentConversationId));
  const conversationBlockingLoad = $derived(Boolean(conversationHistoryPending && !messages.length));
  const conversationTimedOut = $derived(Boolean(conversationHistoryPending && navigationTimedOutId === currentConversationId));
  const conversationWorkState = $derived(
    sendInFlight
      ? 'starting'
      : (currentConversationId ? (workStates.get(currentConversationId) || 'unknown') : newChatWorkState)
  );
  const conversationWorkLabel = $derived(workStateLabel(conversationWorkState));
  const conversationActivelyWorking = $derived(conversationWorkState === 'running' || conversationWorkState === 'starting');
  const conversationThinkingDepth = $derived.by(() => {
    const payload = currentConversationId ? conversationRecords.get(currentConversationId)?.payload || null : null;
    return payload ? conversationThinkingLevel(payload) : null;
  });
  const effectiveThinkingLevel = $derived(
    thinkingLevelOverride ?? conversationThinkingDepth?.level ?? userSettings.thinkingLevel ?? 3
  );
  // Test observability mirror: smoke/live harnesses read this instead of
  // polling internals. Updated only when derived state actually changes.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const live = currentConversationId ? conversationRecords.get(currentConversationId)?.observations || [] : [];
    const lastAssistant = [...live].reverse().find((message) => message?.role !== 'user' && message?.role !== 'tool');
    window.__SLIMGPT_DEBUG__ = {
      workState: conversationWorkState,
      lastAssistant: lastAssistant ? {
        id: lastAssistant.id,
        status: lastAssistant.status,
        endTurn: lastAssistant.endTurn,
        hasText: Boolean(String(lastAssistant.text || '').trim()),
        live: Boolean(lastAssistant.live),
      } : null,
      liveCount: live.length,
    };
  });
  let previousDisplayConversationId = null;
  let previousTurnCount = 0;

  $effect(() => {
    const key = displayConversationId || 'new';
    const count = turns.length;
    if (key !== previousDisplayConversationId) {
      previousDisplayConversationId = key;
      previousTurnCount = count;
      activeTurnIndex = Math.max(0, count - 1);
      return;
    }
    if (!count) {
      previousTurnCount = 0;
      activeTurnIndex = 0;
      return;
    }
    if (previousTurnCount === 0 || activeTurnIndex >= count) activeTurnIndex = count - 1;
    previousTurnCount = count;
  });

  onMount(() => {
    let unsubscribe = transport.subscribe(handleTransportMessage);
    let unsubscribeStorage = subscribeStorageChanges(handleStorageChange);
    const layoutQuery = matchMedia('(max-width: 960px), (pointer: coarse)');
    const syncLayout = () => {
      const touchCompact = navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
      const nextCompact = window.innerWidth <= 960 || touchCompact;
      if (nextCompact !== compactLayout) {
        compactLayout = nextCompact;
        mobilePanel = 'none';
      }
    };
    layoutQuery.addEventListener?.('change', syncLayout);
    window.addEventListener('resize', syncLayout);
    window.visualViewport?.addEventListener('resize', syncLayout);
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') void flushPersist();
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    syncLayout();
    transport.start();
    restoreIndex();
    restoreObservationLedger();
    restoreSettings();
    return () => {
      unsubscribe?.();
      unsubscribeStorage?.();
      transport.stop();
      clearTimeout(saveTimer);
      clearTimeout(sendTimer);
      clearTimeout(navigationTimer);
      sseBuffers.clear();
      sseDecoders.clear();
      xhrBuffers.clear();
      captureConversationIds.clear();
      conflictedCaptureIds.clear();
      locallyPromotedConversationIds.clear();
      clearPendingLiveEvents();
      layoutQuery.removeEventListener?.('change', syncLayout);
      window.removeEventListener('resize', syncLayout);
      window.visualViewport?.removeEventListener('resize', syncLayout);
      document.removeEventListener('visibilitychange', flushWhenHidden);
    };
  });

  async function restoreIndex() {
    try {
      const items = await loadConversationIndex();
      mergeConversationIndex(items);
    } catch {
      setComposerStatus('无法读取本地会话索引；当前聊天仍可正常使用', true);
    }
  }

  async function restoreObservationLedger() {
    try {
      const entries = await loadObservationLedger();
      mergeObservationLedger(entries);
    } catch {
      // The server/canonical conversation remains authoritative if the local
      // observation cache cannot be restored.
    }
  }

  async function restoreSettings() {
    try {
      userSettings = await loadUserSettings();
    } catch {
      userSettings = { ...DEFAULT_SETTINGS };
    }
  }

  function handleStorageChange(update) {
    if (!update || typeof update !== 'object') return;
    if (Array.isArray(update.conversationIndex)) mergeConversationIndex(update.conversationIndex);
    if (Array.isArray(update.observationLedger)) mergeObservationLedger(update.observationLedger);
    if (update.executionPulse?.payload?.type === 'page-execution-state') {
      applyExecutionState(update.executionPulse.payload);
    }
    if (update.userSettings && typeof update.userSettings === 'object') {
      userSettings = { ...DEFAULT_SETTINGS, ...userSettings, ...update.userSettings };
    }
  }

  function mergeConversationIndex(items, { promote = true } = {}) {
    if (!Array.isArray(items) || !items.length) return;
    const existing = new Map(conversationMap);
    const incoming = [];
    const incomingIds = new Set();
    for (const item of items) {
      if (!item?.id) continue;
      const id = String(item.id);
      const previous = existing.get(id) || {};
      incomingIds.add(id);
      incoming.push([id, normalizeConversationMeta({ ...previous, ...item }, previous)]);
      existing.delete(id);
    }
    if (!incoming.length) return;

    if (!promote) {
      const next = new Map(conversationMap);
      for (const [id, item] of incoming) next.set(id, item);
      conversationMap = next;
      return;
    }

    const next = new Map();
    for (const id of locallyPromotedConversationIds) {
      if (incomingIds.has(id)) {
        locallyPromotedConversationIds.delete(id);
        continue;
      }
      const item = existing.get(id);
      if (!item) continue;
      next.set(id, item);
      existing.delete(id);
    }
    for (const [id, item] of incoming) next.set(id, item);
    for (const [id, item] of existing) next.set(id, item);
    conversationMap = next;
  }

  function mergeObservationLedger(entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    const next = new Map(conversationRecords);
    for (const entry of entries) {
      if (!entry?.id || !Array.isArray(entry.observations)) continue;
      next.set(entry.id, hydrateConversationObservations(next.get(entry.id), entry.observations));
    }
    conversationRecords = next;
  }

  function applyExecutionState(message) {
    const { conversationId, conflicted } = resolveConversationScope(
      message.conversationId,
      message.conversationId ? null : conversationIdFromUrl(message.url || ''),
    );
    if (!conflicted && ['running', 'stopped', 'unknown'].includes(message.state)) {
      if (conversationId && message.state === 'running') {
        bindLifecycleConversation(conversationId, message, { conversationRequest: false });
      }
      setConversationWorkState(conversationId, message.state);
    }
  }

  async function handleThinkingLevelChange(thinkingLevel) {
    thinkingLevelOverride = thinkingLevel;
    userSettings = { ...userSettings, thinkingLevel };
    await saveUserSettings(userSettings);
    if (transport.supportsLiveChat) {
      const levelObj = THINKING_LEVELS.find((item) => item.level === thinkingLevel) || THINKING_LEVELS[2];
      transport.send({
        type: 'set-thinking-level',
        thinkingLevel,
        reasoningEffort: levelObj.effort,
      });
    }
  }

  function handleTransportMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'status') {
      const bridgeError = message.bridgeReady === true ? false : (message.bridgeError ?? status.bridgeError);
      status = { ...status, ...message, bridgeError };
    }
    else if (message.type === 'takeover-state') {
      status = { ...status, takeover: message.active };
    }
    else if (message.type === 'page-execution-state') {
      applyExecutionState(message);
    }
    else if (message.type === 'page-conversation-bound') {
      const { conversationId, conflicted } = resolveConversationScope(message.conversationId);
      if (!conflicted && conversationId) bindLifecycleConversation(conversationId, message, { conversationRequest: true });
    }
    else if (message.type === 'page-conversation-index') {
      mergeConversationIndex(message.items, { promote: message.complete === true });
      schedulePersist();
    }
    else if (message.type === 'page-location') handlePageLocation(message.url);
    else if (message.type === 'page-capture' || message.type === 'canonical-capture') handleCapture(message);
    else if (message.type === 'composer-result') handleComposerResult(message);
    else if (message.type === 'capture-warning') setComposerStatus(`页面启动过快，${message.dropped || 1} 个早期同步事件未能保留；可刷新页面重新同步`, true);
    else if (message.type === 'command-error') {
      status = { ...status, bridgeError: message.command === 'install-page-hook' };
      setComposerStatus(message.error || '命令失败', true);
    }
  }

  function handleCapture(capture) {
    captures += 1;
    const text = decodeCaptureBody(capture);
    if (!text && capture.phase !== 'complete') return;

    if (capture.transport !== 'sse' && capture.phase !== 'chunk') {
      const fingerprint = fingerprintCapture(capture, text);
      if (recentFingerprints.has(fingerprint)) return;
      recentFingerprints.add(fingerprint);
      if (recentFingerprints.size > 256) {
        const oldest = recentFingerprints.values().next().value;
        recentFingerprints.delete(oldest);
      }
    }

    const isEventStream = capture.transport === 'sse' || String(capture.mimeType || '').includes('text/event-stream');
    if (isEventStream) {
      const key = capture.requestId || capture.url || 'sse';
      const decoder = sseDecoders.get(key) || createConversationSseDecoder();
      sseDecoders.set(key, decoder);
      const { rest, frames } = consumeSse(sseBuffers.get(key) || '', text, capture.phase === 'complete');
      if (capture.phase === 'complete') {
        sseBuffers.delete(key);
        sseDecoders.delete(key);
      } else {
        sseBuffers.set(key, rest);
      }

      for (const frame of frames) {
        if (frame.data === '[DONE]') {
          // [DONE] terminates this SSE segment only. It is not evidence that
          // the conversation turn has stopped; async/tool work may continue.
          continue;
        }
        try {
          const decoded = decoder.decode(frame);
          if (decoded && typeof decoded === 'object') processStructured(decoded, capture);
        } catch {
          setComposerStatus('官方增量事件无法解码；将以完整会话同步结果为准', true);
        }
      }
      if (capture.phase === 'complete') {
        releaseCaptureScope(capture);
      }
      return;
    }

    if (capture.transport === 'xhr') {
      const key = capture.requestId || capture.url || 'xhr';
      const combined = `${xhrBuffers.get(key) || ''}${text}`;
      if (combined.length > MAX_CAPTURE_BUFFER) {
        xhrBuffers.delete(key);
        releaseCaptureScope(capture);
        setComposerStatus('一个过大的页面响应已跳过，避免 SlimGPT 占用过多内存', true);
        return;
      }
      if (capture.phase !== 'complete') {
        xhrBuffers.set(key, combined);
        return;
      }
      xhrBuffers.delete(key);
      processCaptureText(combined, capture);
      releaseCaptureScope(capture);
      return;
    }

    processCaptureText(text, capture);
  }

  function processCaptureText(text, capture) {
    if (
      String(capture.mimeType || '').includes('text/vnd.openai.web-mobile-partial+html') ||
      text.includes('data-web-mobile-dpu-frame')
    ) {
      const conversation = parseWebMobilePartialConversation(text);
      if (conversation?.id) {
        const scope = resolveCapturedConversation(capture, conversation.id);
        if (!scope.conflicted && scope.conversationId) {
          maybeActivateCapturedConversation(scope.conversationId, capture);
          acceptConversationPayload(scope.conversationId, conversation, capture);
        }
        return;
      }
    }

    const json = parseJson(text);
    if (json) {
      processStructured(json, capture);
      return;
    }
    if (capture.transport === 'websocket' || text.includes('data:')) {
      for (const frame of consumeSse('', text, true).frames) {
        if (frame.json) processStructured(frame.json, capture);
      }
    }
  }

  function processStructured(value, capture) {
    for (const lifecycle of findConversationLifecycleEvents(value)) {
      const scope = resolveCapturedConversation(capture, lifecycle.conversationId);
      if (scope.conflicted || !scope.conversationId) continue;
      bindLifecycleConversation(scope.conversationId, lifecycle, capture);
    }

    const structuredConversationId = conversationIdFromPayload(value);
    const provisionalPageId = conversationIdFromUrl(capture.url || '');
    const conversation = findConversationPayload(value, {
      conversationId: structuredConversationId || capture.conversationId ||
        (isProvisionalConversationId(provisionalPageId) ? '' : provisionalPageId),
    });
    if (conversation) {
      const scope = resolveCapturedConversation(capture, conversationIdFromPayload(conversation));
      if (!scope.conflicted && scope.conversationId) {
        maybeActivateCapturedConversation(scope.conversationId, capture);
        acceptConversationPayload(scope.conversationId, conversation, capture);
      }
      return;
    }

    const items = extractConversationItems(value);
    if (items.length) {
      mergeConversationIndex(items, {
        promote: isFirstConversationIndexPage(capture.url),
      });
      schedulePersist();
      return;
    }

    for (const event of findMessageEvents(value)) {
      const scope = resolveCapturedConversation(
        capture,
        event.conversationId,
        event.conversationIdConflict,
      );
      if (scope.conflicted) continue;
      if (!scope.conversationId) {
        queuePendingLiveEvent(event, capture);
        continue;
      }
      acceptMessageEvent(scope.conversationId, event, capture);
    }
  }

  function acceptMessageEvent(id, event, capture) {
    maybeActivateCapturedConversation(id, capture);
    bindPendingTurnIdentity(id, capture);
    const turnAliases = [...new Set([
      ...(event.turnAliases || []),
      ...(capture.turnAliases || []),
    ].filter(Boolean))];
    const next = new Map(conversationRecords);
    next.set(id, ingestConversationMessage(next.get(id), event.message, {
      textMode: capture.transport === 'dom' ? 'snapshot' : 'progressive',
      semanticTurnId: event.turnId || capture.turnId || null,
      turnAliases,
      transportTurnId: capture.transportTurnId || capture.transportSessionId || null,
      turnUserMessageId: capture.turnUserMessageId || event.turnUserMessageId || null,
      turnParentMessageId: capture.turnParentMessageId || event.turnParentMessageId || null,
      captureId: capture.requestId || null,
      captureTransport: capture.transport || null,
      observationOrdinal: ++observationOrdinal,
      sequenceNumber: event.sequenceNumber ?? null,
      outputIndex: event.outputIndex ?? null,
      responseId: event.responseId || null,
      itemId: event.itemId || null,
      callId: event.callId || null,
      toolCallId: event.toolCallId || null,
      phase: event.phase || null,
      channel: event.channel || null,
      eventType: event.eventType || null,
    }));
    conversationRecords = next;
    schedulePersist();
    updateConversationPreviewFromMessage(id, event.message);
    if (id === currentConversationId) reconcilePending(id, event.message);
  }

  function queuePendingLiveEvent(event, capture) {
    if (
      !pendingUser ||
      pendingUser.conversationId !== null ||
      capture.conversationRequest !== true
    ) {
      return false;
    }
    const key = capture.transportSessionId || capture.transportTurnId || capture.requestId;
    if (!key) return false;

    bindPendingTurnIdentity(null, capture);
    const captureMeta = { ...capture };
    delete captureMeta.data;
    delete captureMeta.body;
    const queued = pendingLiveEvents.get(key) || [];
    queued.push({ event, capture: captureMeta });
    pendingLiveEvents.set(key, queued);
    pendingLiveEventCount += 1;

    while (pendingLiveEventCount > MAX_PENDING_LIVE_EVENTS) {
      const oldestKey = pendingLiveEvents.keys().next().value;
      const oldest = pendingLiveEvents.get(oldestKey) || [];
      oldest.shift();
      pendingLiveEventCount -= 1;
      if (oldest.length) pendingLiveEvents.set(oldestKey, oldest);
      else pendingLiveEvents.delete(oldestKey);
      setComposerStatus('新对话事件超过安全缓存上限；未丢失的事件仍会在服务端绑定会话后显示', true);
    }
    return true;
  }

  function flushPendingLiveEvents(id) {
    if (!id || !pendingLiveEventCount) return;
    const queued = [];
    for (const entries of pendingLiveEvents.values()) queued.push(...entries);
    clearPendingLiveEvents();
    for (const entry of queued) {
      acceptMessageEvent(id, entry.event, {
        ...entry.capture,
        conversationId: id,
        conversationIdConflict: false,
      });
    }
  }

  function clearPendingLiveEvents() {
    pendingLiveEvents.clear();
    pendingLiveEventCount = 0;
  }

  function isFirstConversationIndexPage(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''), 'https://chatgpt.com/');
      if (url.pathname !== '/backend-api/conversations') return true;
      return Number(url.searchParams.get('offset') || 0) === 0;
    } catch {
      return true;
    }
  }

  function isProvisionalConversationId(id) {
    return /^WEB:/i.test(String(id || ''));
  }

  function bindLifecycleConversation(id, lifecycle = {}, capture = {}) {
    if (!id) return;
    const turnAliases = [...new Set([
      ...(lifecycle.turnAliases || []),
      lifecycle.turnId,
      lifecycle.turnExchangeId,
      lifecycle.workingTurnId,
      lifecycle.turnRequestId,
      lifecycle.turnTraceId,
      ...(capture.turnAliases || []),
      capture.turnId,
    ].filter(Boolean))];
    const pendingAliases = [...new Set([
      ...(pendingUser?.turnAliases || []),
      pendingUser?.turnId,
      pendingUser?.message?.turnId,
      ...(pendingUser?.message?.turnAliases || []),
    ].filter(Boolean))];
    const transportIds = new Set([
      lifecycle.transportSessionId,
      lifecycle.transportTurnId,
      capture.transportSessionId,
      capture.transportTurnId,
    ].filter(Boolean));
    const pendingTransportIds = [
      pendingUser?.transportSessionId,
      pendingUser?.transportTurnId,
      pendingUser?.message?.transportSessionId,
      pendingUser?.message?.transportTurnId,
    ].filter(Boolean);
    const correlated = capture.conversationRequest === true ||
      Boolean(
        (lifecycle.turnUserMessageId || capture.turnUserMessageId) &&
        pendingUser?.userMessageId === (lifecycle.turnUserMessageId || capture.turnUserMessageId)
      ) ||
      pendingTransportIds.some((id) => transportIds.has(id)) ||
      (turnAliases.length > 0 && pendingAliases.some((alias) => turnAliases.includes(alias)));

    const identityCapture = {
      ...capture,
      turnId: lifecycle.turnId || capture.turnId || null,
      turnAliases,
      transportSessionId: lifecycle.transportSessionId || capture.transportSessionId || null,
      transportTurnId: lifecycle.transportTurnId || capture.transportTurnId || null,
      turnUserMessageId: lifecycle.turnUserMessageId || capture.turnUserMessageId || null,
      turnParentMessageId: lifecycle.turnParentMessageId || capture.turnParentMessageId || null,
    };
    bindPendingTurnIdentity(id, identityCapture);
    if (
      pendingUser?.conversationId === null &&
      (!currentConversationId || isProvisionalConversationId(currentConversationId)) &&
      correlated
    ) {
      bindPendingConversation(id);
    }
  }

  function bindPendingTurnIdentity(id, capture) {
    if (
      !pendingUser ||
      !(capture?.turnId || capture?.transportSessionId || capture?.transportTurnId || capture?.turnUserMessageId)
    ) {
      return;
    }
    if (pendingUser.conversationId && pendingUser.conversationId !== id) return;
    const turnAliases = capture.turnAliases?.length
      ? capture.turnAliases
      : (pendingUser.turnAliases || []);
    pendingUser = {
      ...pendingUser,
      turnId: capture.turnId || pendingUser.turnId || null,
      turnAliases,
      transportSessionId: capture.transportSessionId || pendingUser.transportSessionId || null,
      transportTurnId: capture.transportTurnId || pendingUser.transportTurnId || null,
      userMessageId: capture.turnUserMessageId || pendingUser.userMessageId || null,
      message: {
        ...pendingUser.message,
        turnId: capture.turnId || pendingUser.message?.turnId || null,
        turnAliases,
        transportSessionId: capture.transportSessionId || pendingUser.message?.transportSessionId || null,
        transportTurnId: capture.transportTurnId || pendingUser.message?.transportTurnId || null,
        turnUserMessageId: capture.turnUserMessageId || pendingUser.message?.turnUserMessageId || null,
        turnParentMessageId: capture.turnParentMessageId || pendingUser.message?.turnParentMessageId || null,
      },
    };
  }

  function resolveCapturedConversation(capture, explicitConversationId = null, explicitConflict = false) {
    const key = persistentCaptureKey(capture);
    if (
      explicitConflict ||
      capture.conversationIdConflict ||
      (key && conflictedCaptureIds.has(key))
    ) {
      if (key) conflictedCaptureIds.add(key);
      return { conversationId: null, conflicted: true };
    }

    const urlConversationId = capture.conversationId
      ? null
      : conversationIdFromUrl(capture.url || '');
    const scope = resolveConversationScope(
      explicitConversationId,
      capture.conversationId,
      urlConversationId,
      key ? captureConversationIds.get(key) : null,
    );
    if (
      scope.conflicted &&
      capture.conversationRequest === true &&
      pendingUser?.conversationId === null
    ) {
      const stableIds = [explicitConversationId, capture.conversationId, urlConversationId]
        .filter((id) => id && !isProvisionalConversationId(id));
      const provisionalIds = [explicitConversationId, capture.conversationId, urlConversationId]
        .filter((id) => isProvisionalConversationId(id));
      const stableId = [...new Set(stableIds)][0] || null;
      if (stableId && new Set(stableIds).size === 1 && provisionalIds.length) {
        if (key) captureConversationIds.set(key, stableId);
        return { conversationId: stableId, conflicted: false };
      }
    }
    if (scope.conflicted) {
      if (key) {
        captureConversationIds.delete(key);
        conflictedCaptureIds.add(key);
      }
      return scope;
    }
    if (scope.conversationId && key) {
      captureConversationIds.set(key, scope.conversationId);
      if (captureConversationIds.size > 128) {
        const oldestKey = captureConversationIds.keys().next().value;
        captureConversationIds.delete(oldestKey);
        conflictedCaptureIds.delete(oldestKey);
      }
    }
    return scope;
  }

  function persistentCaptureKey(capture) {
    if (!capture?.requestId || !['sse', 'xhr'].includes(capture.transport)) return null;
    return `${capture.transport}:${capture.requestId}`;
  }

  function releaseCaptureScope(capture) {
    const key = persistentCaptureKey(capture);
    if (!key) return;
    captureConversationIds.delete(key);
    conflictedCaptureIds.delete(key);
  }

  function maybeActivateCapturedConversation(id, capture) {
    bindPendingTurnIdentity(id, capture);
    if (id === currentConversationId) return;
    if (
      capture.conversationRequest === true &&
      pendingUser?.conversationId === null &&
      (!currentConversationId || isProvisionalConversationId(currentConversationId))
    ) {
      bindPendingConversation(id);
    }
  }

  function acceptConversationPayload(id, payload, capture = {}) {
    const nextRecords = new Map(conversationRecords);
    const record = ingestConversationPayload(nextRecords.get(id), payload, {
      canonicalComplete: capture.canonicalComplete === true,
      canonicalSyncId: capture.canonicalSyncId || null,
      canonicalPageIndex: capture.canonicalPageIndex ?? null,
    });
    const mergedPayload = record.payload;
    nextRecords.set(id, record);

    // Bound memory by whole conversations, never by a sliding message window.
    while (nextRecords.size > MAX_CACHED_CONVERSATIONS) {
      let evictedId = null;
      for (const candidateId of nextRecords.keys()) {
        if (candidateId === id || candidateId === currentConversationId) continue;
        evictedId = candidateId;
        break;
      }
      if (!evictedId) break;
      nextRecords.delete(evictedId);
    }

    conversationRecords = nextRecords;
    if (!mergedPayload) {
      schedulePersist();
      return;
    }
    const next = new Map(conversationMap);
    const previous = next.get(id) || {};
    const details = conversationDetailsFromPayload(mergedPayload, previous);
    const pagePath = (() => {
      try { return new URL(status.pageUrl || 'https://chatgpt.com/').pathname; } catch { return ''; }
    })();
    const pageConversationId = conversationIdFromUrl(status.pageUrl || '');
    next.set(id, normalizeConversationMeta({
      id,
      title: mergedPayload.title || previous.title || 'Untitled',
      create_time: mergedPayload.create_time || previous.create_time,
      update_time: mergedPayload.update_time || previous.update_time || null,
      route: mergedPayload.metadata?.source === 'web-mobile-partial' ||
        (pageConversationId === id && pagePath.startsWith('/uc/'))
        ? 'uc'
        : (previous.route || 'c'),
      last: details.last,
      model: details.model,
    }, previous));
    conversationMap = next;
    if (record.canonicalComplete && loadingConversationId === id) finishConversationLoading();
    reconcilePendingAgainstPayload(id, mergedPayload);
    schedulePersist();
  }

  function handlePageLocation(url) {
    if (!url) return;
    status = { ...status, pageUrl: url };
    const id = conversationIdFromUrl(url);
    if (id) {
      if (
        isProvisionalConversationId(id) &&
        pendingUser?.conversationId === null &&
        currentConversationId === null
      ) {
        // ChatGPT exposes a WEB:* optimistic route before the server assigns
        // the persisted conversation id. Keep the new-chat scope unbound until
        // an intercepted event carries the real id.
        return;
      }
      if (id !== currentConversationId) {
        if (pendingUser?.conversationId === null && currentConversationId === null) {
          bindPendingConversation(id);
        } else {
          setCurrentConversation(id);
        }
        thinkingLevelOverride = null;
        startConversationLoading(id);
      }
    }
    else if (url.startsWith('https://chatgpt.com/')) {
      setCurrentConversation(null);
      thinkingLevelOverride = null;
      finishConversationLoading();
    }
  }

  function selectConversation(id) {
    if (sendInFlight) {
      setComposerStatus('当前消息仍在提交，请等待确认后再切换对话', true);
      return;
    }
    if (!id || (id === currentConversationId && conversationRecords.get(id)?.payload)) {
      closeMobilePanels();
      return;
    }
    setCurrentConversation(id);
    thinkingLevelOverride = null;
    startConversationLoading(id);
    closeMobilePanels();
    if (transport.supportsLiveChat) {
      const route = conversationMap.get(id)?.route === 'uc' ? 'uc' : 'c';
      transport.send({ type: 'navigate-conversation', conversationId: id, route });
      setComposerStatus('');
    }
  }

  function newChat() {
    if (sendInFlight) {
      setComposerStatus('当前消息仍在提交，请等待确认后再新建对话', true);
      return;
    }
    setCurrentConversation(null);
    thinkingLevelOverride = null;
    newChatWorkState = 'unknown';
    finishConversationLoading();
    pendingUser = null;
    clearPendingLiveEvents();
    closeMobilePanels();
    if (transport.supportsLiveChat) {
      transport.send({ type: 'new-chat', thinkingLevel: userSettings.thinkingLevel });
    }
  }

  function setCurrentConversation(id, { migrateDraft = false } = {}) {
    const nextId = id || null;
    if (nextId === currentConversationId) return;
    closeMobilePanels();
    const previousId = currentConversationId;
    if (migrateDraft) {
      draftsByConversation.delete(previousId);
      currentConversationId = nextId;
      draftsByConversation.set(nextId, draft);
      return;
    }
    draftsByConversation.set(previousId, draft);
    currentConversationId = nextId;
    draft = draftsByConversation.get(nextId) || '';
  }

  function bindPendingConversation(id) {
    if (!id || !pendingUser || (pendingUser.conversationId && !isProvisionalConversationId(pendingUser.conversationId))) return;
    const pendingText = pendingUser.text;
    const provisionalId = isProvisionalConversationId(currentConversationId)
      ? currentConversationId
      : (isProvisionalConversationId(pendingUser.conversationId) ? pendingUser.conversationId : null);
    pendingUser = { ...pendingUser, conversationId: id };
    if (
      pendingCommandId === pendingUser.commandId &&
      (!pendingCommandConversationId || isProvisionalConversationId(pendingCommandConversationId))
    ) {
      pendingCommandConversationId = id;
    }
    if (currentConversationId === null || currentConversationId === provisionalId) {
      if (provisionalId) {
        const nextRecords = new Map(conversationRecords);
        const provisionalRecord = nextRecords.get(provisionalId);
        if (provisionalRecord && !nextRecords.has(id)) nextRecords.set(id, provisionalRecord);
        nextRecords.delete(provisionalId);
        conversationRecords = nextRecords;
        const nextConversationMap = new Map(conversationMap);
        nextConversationMap.delete(provisionalId);
        conversationMap = nextConversationMap;
      }
      setCurrentConversation(id, { migrateDraft: true });
    }
    if (transport.supportsLiveChat) {
      const rawPageUrl = String(status.pageUrl || '');
      let provisionalRoute = false;
      try {
        provisionalRoute = /\/(?:c|uc)\/WEB:/i.test(decodeURIComponent(new URL(rawPageUrl).pathname));
      } catch {}
      if (provisionalRoute || !conversationIdFromUrl(rawPageUrl)) {
        transport.send({ type: 'adopt-conversation-id', conversationId: id });
      }
    }
    if (newChatWorkState !== 'unknown') {
      setConversationWorkState(id, newChatWorkState);
      newChatWorkState = 'unknown';
    }
    updateConversationPreview(id, pendingText, '');
    flushPendingLiveEvents(id);
  }

  function startConversationLoading(id) {
    clearTimeout(navigationTimer);
    navigationTimer = null;
    navigationTimedOutId = null;
    if (!id || conversationRecords.get(id)?.canonicalComplete) {
      loadingConversationId = null;
      return;
    }
    loadingConversationId = id;
    navigationTimer = setTimeout(() => {
      if (loadingConversationId !== id || conversationRecords.get(id)?.canonicalComplete) return;
      loadingConversationId = null;
      navigationTimedOutId = id;
      navigationTimer = null;
      setComposerStatus('对话加载超时，可重新点击该会话重试', true);
    }, 12_000);
  }

  function finishConversationLoading() {
    clearTimeout(navigationTimer);
    navigationTimer = null;
    loadingConversationId = null;
    navigationTimedOutId = null;
  }

  function hasRenderableConversationContent(id) {
    if (!id) return false;
    const record = conversationRecords.get(id);
    if (record?.payload) return true;
    return (record?.observations || []).some((message) =>
      String(message?.text || message?.thought || '').trim() || message?.tool
    );
  }

  function exportMarkdown() {
    if (conversationPending) {
      setComposerStatus('当前对话尚未加载完成，暂不能导出', true);
      return;
    }
    const exportable = messages.filter((message) => !message?.pending && String(message?.text || '').trim());
    if (!exportable.length) {
      setComposerStatus('当前对话暂无可导出的消息', true);
      return;
    }
    const title = currentMeta?.title || 'ChatGPT Conversation';
    const { filename } = downloadConversationMarkdown(title, exportable);
    setComposerStatus(`已导出 ${filename}`);
  }

  function sendMessage(text, options = {}) {
    if (conversationPending) {
      setComposerStatus('目标对话仍在加载，请加载完成后再发送', true);
      return;
    }
    if (!transport.supportsLiveChat || !status.bridgeReady) {
      setComposerStatus('ChatGPT 页面桥尚未就绪', true);
      return;
    }
    if (currentPayload && currentConversationId && currentRecord?.terminal !== currentPayload.current_node) {
      setComposerStatus('当前正在只读查看其他分支；请切回最新分支，或在官方界面继续该分支', true);
      return;
    }
    if (sendInFlight) {
      setComposerStatus('上一条消息仍在提交；SlimGPT 不会重复发送', true);
      return;
    }
    clearPendingLiveEvents();
    const stamp = Date.now();
    const commandId = crypto.randomUUID();
    const thinkingLevel = options?.thinkingLevel || effectiveThinkingLevel;
    const levelObj = THINKING_LEVELS.find((item) => item.level === thinkingLevel) || THINKING_LEVELS[2];
    sendInFlight = true;
    pendingCommandId = commandId;
    pendingCommandConversationId = currentConversationId;
    pendingUser = {
      commandId,
      conversationId: isProvisionalConversationId(currentConversationId) ? null : currentConversationId,
      text,
      message: {
        id: `pending-${stamp}`,
        nodeId: `pending-${stamp}`,
        role: 'user',
        text,
        createTime: stamp / 1000,
        status: 'pending',
        endTurn: true,
        siblingIndex: 0,
        siblingCount: 1,
        siblingNodeIds: [],
        metadata: {},
        pending: true,
      },
    };
    if (currentConversationId) updateConversationPreview(currentConversationId, text, '');
    transport.send({
      type: 'send-message',
      commandId,
      text,
      thinkingLevel,
      reasoningEffort: levelObj.effort,
    });
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      if (pendingCommandId !== commandId) return;
      const timedOutConversationId = pendingCommandConversationId;
      pendingCommandId = null;
      pendingCommandConversationId = null;
      sendInFlight = false;
      if (pendingUser?.commandId === commandId) pendingUser = null;
      clearPendingLiveEvents();
      setConversationWorkState(timedOutConversationId, 'unknown');
      setComposerStatus('官方输入框未确认提交；内容仍保留，请检查官方界面后手动决定是否重试', true);
    }, SEND_COMMAND_WATCHDOG_MS);
    setComposerStatus('正在通过 ChatGPT 页面发送；断线后不会自动重发');
  }

  function handleComposerResult(message) {
    if (!pendingCommandId || message.commandId !== pendingCommandId) return;
    const submitted = pendingUser;
    const submittedConversationId = pendingCommandConversationId;
    clearTimeout(sendTimer);
    sendTimer = null;
    sendInFlight = false;
    pendingCommandId = null;
    pendingCommandConversationId = null;
    if (!message.ok) {
      pendingUser = null;
      clearPendingLiveEvents();
      if (message.error === 'send-in-progress') setConversationWorkState(submittedConversationId, 'running');
      else if (message.error === 'send-unconfirmed') setConversationWorkState(submittedConversationId, 'unknown');
      const details = {
        'composer-not-found': '找不到官方输入框：请检查当前 ChatGPT 页面是否已登录或页面结构是否变化',
        'composer-rejected-input': '官方输入框没有接受这段文字；内容仍保留，未发送',
        'send-control-not-ready': '官方发送按钮未就绪；内容仍保留，未发送',
        'send-in-progress': '官方页面仍在处理上一条消息；本条未发送',
        'empty-message': '消息为空，未发送',
        'send-unconfirmed': '已点击发送但官方页面未确认；消息可能未发出，请勿重复发送，可在官方界面核实',
      };
      const detail = details[message.error] || `发送失败：${message.error || 'unknown'}`;
      setComposerStatus(detail, true);
      return;
    }
    if (submitted) {
      const submittedText = submitted.text.trim();
      if (
        currentConversationId === submitted.conversationId &&
        draft.trim() === submittedText
      ) {
        draft = '';
      }
      const storedDraft = draftsByConversation.get(submitted.conversationId);
      if (typeof storedDraft === 'string' && storedDraft.trim() === submittedText) {
        draftsByConversation.set(submitted.conversationId, '');
      }
    }
    setComposerStatus('消息已发送（官方已确认）');
  }

  function pendingUserMatch(rawMessage) {
    if (!pendingUser || rawMessage?.author?.role !== 'user') return false;

    const messageId = String(rawMessage.id || '').trim();
    const expectedIds = new Set([
      pendingUser.userMessageId,
      pendingUser.message?.turnUserMessageId,
    ].filter(Boolean).map(String));
    if (expectedIds.size) return Boolean(messageId && expectedIds.has(messageId));

    const pendingAliases = new Set([
      ...(pendingUser.turnAliases || []),
      pendingUser.turnId,
      ...(pendingUser.message?.turnAliases || []),
      pendingUser.message?.turnId,
    ].filter(Boolean).map(String));
    const observedAliases = messageTurnIdentity(rawMessage).turnAliases;
    if (pendingAliases.size && observedAliases.length) {
      return observedAliases.some((alias) => pendingAliases.has(alias));
    }

    const text = rawMessage.content?.parts
      ?.filter((part) => typeof part === 'string')
      .join('\n') || '';
    return text.trim() === pendingUser.text.trim();
  }

  function reconcilePending(id, rawMessage) {
    if (
      !pendingUser ||
      pendingUser.conversationId !== id ||
      !pendingUserMatch(rawMessage)
    ) {
      return;
    }
    bindPendingTurnToUser(id, rawMessage.id);
    pendingUser = null;
  }

  function reconcilePendingAgainstPayload(id, payload) {
    if (!pendingUser || pendingUser.conversationId !== id || !payload?.mapping) return;

    const mapping = payload.mapping;
    const expectedIds = new Set([
      pendingUser.userMessageId,
      pendingUser.message?.turnUserMessageId,
    ].filter(Boolean).map(String));
    if (expectedIds.size) {
      for (const node of Object.values(mapping)) {
        const messageId = String(node?.message?.id || node?.id || '').trim();
        if (!expectedIds.has(messageId) || node?.message?.author?.role !== 'user') continue;
        bindPendingTurnToUser(id, messageId);
        pendingUser = null;
        return;
      }
      return;
    }

    let nodeId = payload.current_node;
    const visited = new Set();
    while (nodeId && !visited.has(nodeId)) {
      visited.add(nodeId);
      const node = mapping[nodeId];
      if (!node) return;
      if (pendingUserMatch(node.message)) {
        bindPendingTurnToUser(id, node.message.id || node.id);
        pendingUser = null;
        return;
      }
      nodeId = node.parent;
    }
  }

  function bindPendingTurnToUser(id, userMessageId) {
    const turnId = pendingUser?.turnId || pendingUser?.message?.turnId;
    if (!id || !turnId || !userMessageId) return;
    const next = new Map(conversationRecords);
    next.set(id, bindConversationTurnUser(next.get(id), turnId, userMessageId));
    conversationRecords = next;
    schedulePersist();
  }

  function setConversationWorkState(id, state) {
    if (!['running', 'stopped', 'unknown'].includes(state)) return;
    if (!id) {
      newChatWorkState = state;
      return;
    }
    if (workStates.get(id) === state) return;
    workStates = new Map(workStates).set(id, state);
  }

  function workStateLabel(state) {
    if (state === 'running') return '执行中';
    if (state === 'starting') return '提交中';
    if (state === 'stopped') return '已停止';
    return '状态未知';
  }

  function stepBranch(nodeId, delta) {
    if (!currentPayload || !currentConversationId) return;
    const terminal = stepConversationBranch(currentPayload, nodeId, delta);
    const next = new Map(conversationRecords);
    next.set(currentConversationId, setConversationRecordTerminal(next.get(currentConversationId), terminal));
    conversationRecords = next;
    if (terminal !== currentPayload.current_node) setComposerStatus('正在只读查看其他分支；发送前请切回最新分支');
    else setComposerStatus('已回到最新分支');
  }

  function setComposerStatus(text, error = false) {
    composerStatus = text;
    composerError = error;
  }

  function schedulePersist() {
    if (persistInFlight) {
      persistQueued = true;
      return;
    }
    if (saveTimer) return;
    // Throttle rather than debounce. Continuous token streams must publish
    // bounded progress to sibling windows instead of waiting for final silence.
    saveTimer = setTimeout(() => void flushPersist(), 750);
  }

  async function flushPersist() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (persistInFlight) {
      persistQueued = true;
      return;
    }

    persistInFlight = true;
    const indexSnapshot = [...conversations];
    const recordsSnapshot = new Map(conversationRecords);
    try {
      await Promise.all([
        saveConversationIndex(indexSnapshot),
        saveObservationLedger(recordsSnapshot),
      ]);
    } catch {
      setComposerStatus('无法保存本地会话缓存；当前聊天不受影响', true);
    } finally {
      persistInFlight = false;
      if (persistQueued) {
        persistQueued = false;
        schedulePersist();
      }
    }
  }

  function normalizeConversationMeta(item, previous = {}) {
    return {
      id: String(item.id),
      title: String(item.title || previous.title || 'Untitled'),
      create_time: Number(item.create_time ?? item.createdAt ?? previous.create_time) || null,
      update_time: Number(item.update_time ?? item.updatedAt ?? previous.update_time) || null,
      route: item.route === 'uc' || previous.route === 'uc' ? 'uc' : 'c',
      last: String(item.last ?? previous.last ?? ''),
      model: String(item.model ?? previous.model ?? ''),
    };
  }

  function conversationDetailsFromPayload(payload, previous = {}) {
    const rows = buildConversationView(payload, payload?.current_node);
    const latest = [...rows].reverse().find((message) => !message?.tool) || rows[rows.length - 1] || null;
    const last = String(latest?.text || previous.last || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    let model = '';
    for (let index = rows.length - 1; index >= 0 && !model; index -= 1) {
      const metadata = rows[index]?.metadata || {};
      model = metadata.model_slug || metadata.default_model_slug || metadata.model || '';
    }
    model ||= payload?.metadata?.model_slug || payload?.metadata?.default_model_slug || previous.model || '';
    return { last, model: String(model || '') };
  }

  function updateConversationPreviewFromMessage(id, rawMessage) {
    if (!rawMessage) return;
    if (getToolMessageInfo(rawMessage)) return;
    const metadata = rawMessage.metadata || {};
    updateConversationPreview(
      id,
      contentToText(rawMessage.content, metadata),
      metadata.model_slug || metadata.default_model_slug || metadata.model || '',
    );
  }

  function updateConversationPreview(id, text, model = '') {
    const existing = conversationMap.get(id) || null;
    const previous = existing || normalizeConversationMeta({
      id,
      title: 'Untitled',
      route: 'c',
    });
    const preview = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (existing && !preview && !model) return;
    const updated = normalizeConversationMeta({
      ...previous,
      last: preview || previous.last,
      model: model || previous.model,
    }, previous);
    locallyPromotedConversationIds.add(id);
    const next = new Map([[id, updated]]);
    for (const [candidateId, item] of conversationMap) {
      if (candidateId !== id) next.set(candidateId, item);
    }
    conversationMap = next;
    schedulePersist();
  }

  function selectOverviewMessage(index) {
    activeTurnIndex = Math.max(0, Math.min(turns.length - 1, Number(index) || 0));
    closeMobilePanels();
  }

  function toggleSidebar() {
    if (!compactLayout) return;
    mobilePanel = mobilePanel === 'sidebar' ? 'none' : 'sidebar';
  }

  function toggleOverview() {
    if (!compactLayout) return;
    mobilePanel = mobilePanel === 'overview' ? 'none' : 'overview';
  }

  function beginPanelPointer(event, panel) {
    if (!event.isTrusted || event.isPrimary === false) return;
    panelPointerIntent = {
      panel,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
    };
  }

  function finishPanelPointer(event, panel) {
    const intent = panelPointerIntent;
    panelPointerIntent = null;
    if (!event.isTrusted || !intent || intent.pointerId !== event.pointerId || intent.panel !== panel) return;
    const moved = Math.hypot(event.clientX - intent.x, event.clientY - intent.y);
    const elapsed = performance.now() - intent.startedAt;
    if (moved > 10 || elapsed > 900) return;
    event.preventDefault();
    event.stopPropagation();
    if (panel === 'overview') toggleOverview();
    else if (panel === 'sidebar') toggleSidebar();
  }

  function cancelPanelPointer() {
    panelPointerIntent = null;
  }

  function handlePanelClick(event, panel) {
    // Pointer activation is handled on pointerup so a swipe/drag ending over
    // the navbar cannot synthesize an accidental drawer-open click. Preserve
    // trusted keyboard activation (Enter/Space), but ignore scripted clicks.
    event.preventDefault();
    if (!(event.isTrusted && event.detail === 0)) return;
    if (panel === 'overview') toggleOverview();
    else if (panel === 'sidebar') toggleSidebar();
  }

  function closeMobilePanels() {
    mobilePanel = 'none';
    panelPointerIntent = null;
  }
</script>

<Page class={`slimgpt-page ${compactLayout ? 'compact-layout' : 'desktop-layout'}`}>
  <Navbar class="mobile-navbar">
    <NavLeft>
      <button
        type="button"
        class="button button-small mobile-sidebar-button"
        aria-expanded={mobilePanel === 'sidebar'}
        aria-controls="slimgpt-mobile-sidebar"
        onpointerdown={(event) => beginPanelPointer(event, 'sidebar')}
        onpointerup={(event) => finishPanelPointer(event, 'sidebar')}
        onpointercancel={cancelPanelPointer}
        onclick={(event) => handlePanelClick(event, 'sidebar')}
      >☰</button>
    </NavLeft>
    <div class="mobile-title">
      <span>{currentMeta?.title || 'SlimGPT'}</span>
      <span
        class="mobile-work-state"
        class:working={conversationActivelyWorking}
        data-state={conversationWorkState}
        role="status"
        aria-label={`对话状态：${conversationWorkLabel}`}
        title={conversationWorkLabel}
      ></span>
    </div>
    <NavRight>
      <button
        type="button"
        class="button button-small mobile-overview-button"
        aria-expanded={mobilePanel === 'overview'}
        aria-controls="slimgpt-mobile-overview"
        onpointerdown={(event) => beginPanelPointer(event, 'overview')}
        onpointerup={(event) => finishPanelPointer(event, 'overview')}
        onpointercancel={cancelPanelPointer}
        onclick={(event) => handlePanelClick(event, 'overview')}
      >概览</button>
    </NavRight>
  </Navbar>

  <div class="app-shell">
    <div
      id="slimgpt-mobile-sidebar"
      class:open={compactLayout && mobilePanel === 'sidebar'}
      class="sidebar-host"
      hidden={compactLayout && mobilePanel !== 'sidebar'}
    >
      <ConversationSidebar
        {conversations}
        currentId={currentConversationId}
        {statusLabel}
        {statusState}
        {captures}
        workState={conversationWorkState}
        onShowOfficial={() => transport.send({ type: 'open-official', conversationId: currentConversationId })}
        onExportMarkdown={exportMarkdown}
        onNewChat={newChat}
        onSelect={selectConversation}
      />
    </div>

    <main class="chat-pane">
      <header class="desktop-chat-header">
        <div class="header-title-group">
          <strong>{currentMeta?.title || (currentConversationId ? '加载中的对话' : '新对话')}</strong>
          <span>{currentMeta?.model ? `${currentMeta.model} · ` : ''}{currentConversationId ? 'ChatGPT 会话' : 'SlimGPT · 轻量模式'}</span>
        </div>
        <div class="header-actions">
          <span class="header-work-state" data-state={conversationWorkState} role="status">
            <span class="work-dot" class:working={conversationActivelyWorking} aria-hidden="true"></span>
            {conversationWorkLabel}
          </span>
          <Button small onClick={() => transport.openOfficial(currentConversationId)}>暂时显示官方界面</Button>
        </div>
      </header>

      <section class="message-stage">
        {#if turns.length || unresolvedTurns.length}
          <ConversationTurnStage
            {turns}
            unresolved={unresolvedTurns}
            activeIndex={activeTurnIndex}
            conversationKey={displayConversationId || 'new'}
            onActiveChange={(index) => activeTurnIndex = index}
            onBranch={stepBranch}
          />
        {:else if !conversationHistoryPending}
          <div class="empty-state">
            <div class="empty-logo">S</div>
            <h2>更轻的 ChatGPT 界面</h2>
            <p>登录、网络和发送仍由当前 ChatGPT 页面处理；SlimGPT 负责会话呈现，并在覆盖显示时暂停官方界面的布局和绘制。</p>
          </div>
        {/if}

        {#if conversationBlockingLoad}
          <div class="conversation-loading" role="status" aria-live="polite">
            <span class="conversation-loading-spinner" aria-hidden="true"></span>
            <strong>{conversationTimedOut ? '对话暂未加载' : '正在加载对话'}</strong>
            <span>{conversationTimedOut ? '完整历史尚未同步；可重新点击侧栏中的该会话重试' : (currentMeta?.title || '正在同步 ChatGPT 完整会话…')}</span>
          </div>
        {:else if conversationHistoryPending}
          <div class="history-sync-notice" role="status" aria-live="polite">
            {conversationTimedOut ? '完整历史同步暂未完成；当前仅显示已确认属于本轮的实时内容。' : '正在补齐完整历史；局部窗口不会被当作会话开头。'}
          </div>
        {/if}

        {#if conversationWorkState === 'running' && !conversationBlockingLoad}
          <div class="work-indicator" role="status" aria-live="polite">
            <span class="work-indicator-spinner" aria-hidden="true"></span>
            <span>对话执行中：已观测到官方页面仍在生成或服务端 turn 尚未结束…</span>
          </div>
        {/if}
      </section>

      <Composer
        bind:value={draft}
        thinkingLevel={effectiveThinkingLevel}
        onThinkingLevelChange={handleThinkingLevelChange}
        disabled={!transport.supportsLiveChat || !status.bridgeReady}
        loading={conversationPending}
        busy={sendInFlight}
        status={composerStatus}
        error={composerError}
        onSend={sendMessage}
      />
    </main>

    <div
      id="slimgpt-mobile-overview"
      class:open={compactLayout && mobilePanel === 'overview'}
      class="overview-host"
      hidden={compactLayout && mobilePanel !== 'overview'}
    >
      <MessageOverview
        {turns}
        unresolvedCount={unresolvedTurns.reduce((total, turn) => total + turn.replies.length, 0)}
        activeIndex={activeTurnIndex}
        onSelect={selectOverviewMessage}
      />
    </div>

    {#if compactLayout && mobilePanel !== 'none'}
      <button class="sidebar-scrim" aria-label="关闭侧栏" onclick={closeMobilePanels}></button>
    {/if}
  </div>
</Page>
