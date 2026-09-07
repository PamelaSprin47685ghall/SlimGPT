<script>
  import { onMount, tick } from 'svelte';
  import { Button, Navbar, NavLeft, NavRight, Page } from 'framework7-svelte';
  import ConversationSidebar from '../components/ConversationSidebar.svelte';
  import ConversationTurnStage from '../components/ConversationTurnStage.svelte';
  import MessageOverview from '../components/MessageOverview.svelte';
  import Composer from '../components/Composer.svelte';
  import { createTransport } from '../lib/transport.js';
  import { createConversationStreamReader } from '../lib/conversation-stream.js';
  import { historySyncMessage } from '../lib/history-sync.js';
  import { matchesPendingTurn } from '../lib/pending-turn.js';
  import { prioritizeBanners, createStalenessTracker, trapModalKeydown, getScrimAriaLabel } from '../lib/shell-helpers.js';
  import { buildConversationMarkdown, buildTurnMarkdown, downloadConversationMarkdown, hasExportableMessage } from '../lib/export.js';
  import { copyText } from '../lib/clipboard.js';
  import { humanizeError, isTerminalMessage } from '../lib/message-presentation.js';
  import {
    loadConversationIndex,
    loadObservationLedgerState,
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
    captureMessageContext,
    conversationIdFromPayload,
    conversationIdFromUrl,
    conversationThinkingLevel,
    decodeCaptureBody,
    extractConversationItems,
    findConversationLifecycleEvents,
    findConversationPayload,
    findMessageEvents,
    fingerprintCapture,
    finishCanonicalSync,
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
  let composerRef = $state(null);
  let status = $state({ bridgeReady: false, captureMode: null });
  let conversationMap = $state(new Map());
  let conversationRecords = $state(new Map());
  let cacheOmissions = $state(new Map());
  let pendingUser = $state(null);
  let currentConversationId = $state(null);
  let loadingConversationId = $state(null);
  let navigationTimedOutId = $state(null);
  let historySyncStates = $state(new Map());
  let captures = $state(0);
  let sidebarNotice = $state('');
  let sidebarExportError = $state('');
  let composerStatus = $state('');
  let composerError = $state(false);
  let draft = $state('');
  let sendInFlight = $state(false);
  let pendingCommandId = null;
  let pendingCommandConversationId = null;
  let compactLayout = $state(true);
  let mobilePanel = $state('none');
  let lastActiveMobileTrigger = null;
  let lastActiveModalTrigger = null;
  let shortcutsModalEl = $state(null);
  const stalenessTracker = createStalenessTracker({
    timeoutMs: 90_000,
    onStale: () => {
      statusStale = true;
    },
  });

  function focusComposer() {
    composerRef?.focus?.();
  }

  function handleQuoteText(quoteMarkdown) {
    if (!quoteMarkdown) return;
    draft = draft ? `${quoteMarkdown}${draft}` : quoteMarkdown;
    queueMicrotask(focusComposer);
  }

  let expandedBanners = $state(false);
  let dismissedBannerIds = $state(new Set());
  let statusStale = $state(false);

  function dismissBanner(id) {
    if (!id) return;
    const next = new Set(dismissedBannerIds);
    next.add(id);
    dismissedBannerIds = next;
  }
  let showShortcutsModal = $state(false);
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
  const sseDecoders = new Map();
  const xhrBuffers = new Map();
  const captureConversationIds = new Map();
  const conflictedCaptureIds = new Set();
  // Post-submit settlement tracking (generation gate): conversation id (null
  // for new chat) → { at, obsId, workState } snapshot taken at dispatch.
  // A turn settles via a running→non-running transition after submit, or via
  // a terminal non-user observation newer than the submit snapshot. Reactive
  // so the send gate and Composer props update as observations land.
  let submittedStateByConversation = $state(new Map());
  const draftsByConversation = new Map();
  const recentFingerprints = new Set();
  const locallyPromotedConversationIds = new Set();
  const pendingLiveEvents = new Map();
  const MAX_PENDING_LIVE_EVENTS = 512;
  let pendingLiveEventCount = 0;

  const conversationSearchTexts = $derived.by(() => {
    const texts = new Map();
    for (const [id, record] of conversationRecords) {
      try {
        const { turns: recordTurns } = buildConversationRecordTimeline(record, null);
        const parts = [];
        let length = 0;
        for (const turn of recordTurns) {
          for (const message of [turn.user, ...(turn.replies || [])]) {
            if (!message) continue;
            const text = String(message.text || '').trim();
            if (!text) continue;
            parts.push(text);
            length += text.length;
            if (length >= 2000) break;
          }
          if (length >= 2000) break;
        }
        if (parts.length) texts.set(id, parts.join('\n').slice(0, 2000));
      } catch {
        // Records that cannot be linearized stay searchable by title only.
      }
    }
    return texts;
  });
  const conversations = $derived([...conversationMap.values()]);
  const sidebarConversations = $derived(conversations.map((item) => {
    const searchText = conversationSearchTexts.get(item.id);
    return searchText ? { ...item, searchText } : item;
  }));
  const generatingIds = $derived(
    [...workStates.entries()].filter(([, state]) => state === 'running').map(([id]) => id)
  );
  const currentRecord = $derived(currentConversationId ? conversationRecords.get(currentConversationId) || null : null);
  const isViewingAlternativeBranch = $derived(Boolean(currentPayload && currentConversationId && currentRecord?.terminal && currentPayload?.current_node && currentRecord.terminal !== currentPayload.current_node));
  const cacheNotice = $derived(cacheOmissions.get(currentConversationId) || cacheOmissions.get('*') || null);
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
  const currentBranchLabel = $derived.by(() => {
    if (!isViewingAlternativeBranch) return '';
    const branched = messages.find((message) => (message?.siblingCount || 0) > 1);
    if (!branched) return '历史分支';
    const index = typeof branched.siblingIndex === 'number' ? branched.siblingIndex + 1 : 1;
    return `分支 ${index}/${branched.siblingCount}`;
  });
  const liveConnected = $derived(status.bridgeReady && status.captureMode === 'page' && !statusStale);
  const statusState = $derived(status.bridgeError ? 'error' : (liveConnected ? 'online' : (statusStale ? 'offline' : 'offline')));
  const statusLabel = $derived(
  status.bridgeError
    ? '连接失败'
    : (status.takeover === false
        ? (liveConnected ? '已连接（官方界面可见）' : '未连接')
        : (liveConnected ? '已接管' : '连接中'))
  );
  const activeBanners = $derived(prioritizeBanners({
    bridgeError: Boolean(status.bridgeError),
    liveConnected,
    historySyncProblem,
    cacheNotice,
    currentHistorySyncState,
    canonicalSyncError: currentRecord?.canonicalSyncError,
    conversationHistoryPending,
    conversationBlockingLoad,
    conversationTimedOut,
    dismissedBannerIds,
  }));
  const topBanner = $derived(activeBanners[0] || null);
  const secondaryBanners = $derived(activeBanners.slice(1));
  const conversationHistoryPending = $derived(Boolean(currentConversationId && !currentRecord?.canonicalComplete));
  const currentHistorySyncState = $derived(historySyncStates.get(currentConversationId));
  const historySyncProblem = $derived(historySyncMessage(currentHistorySyncState,
    currentHistorySyncState?.state === 'loading' ? null : currentRecord?.canonicalSyncError));
  const conversationPending = $derived(Boolean(conversationHistoryPending && navigationTimedOutId !== currentConversationId));
  const conversationBlockingLoad = $derived(Boolean(conversationHistoryPending && !messages.length));
  const conversationTimedOut = $derived(Boolean(conversationHistoryPending && navigationTimedOutId === currentConversationId));
  const conversationWorkState = $derived(
    sendInFlight
      ? 'starting'
      : (currentConversationId ? (workStates.get(currentConversationId) || 'unknown') : newChatWorkState)
  );
  // Active-generation evidence must reflect the CURRENT conversation's
  // visible timeline, not raw leftover observations: a web-mobile live chunk
  // (status in_progress, e.g. ma1) stays in `observations` after the
  // canonical payload finalizes the same id (finished_successfully), and a
  // stale in_progress event must not resurrect a stopped turn. Gate on
  // direct running evidence too so unknown/stopped pre-submit idle stays idle.
  const hasActiveLiveGeneration = $derived.by(() => {
    if (conversationWorkState !== 'running') return false;
    const lastReply = [...messages].reverse().find((m) => m?.role !== 'user');
    if (lastReply) return !isTerminalMessage(lastReply);
    const live = currentRecord?.observations || [];
    const last = [...live].reverse().find((m) => m?.role !== 'user');
    if (!last || isTerminalMessage(last)) return false;
    const canonicalMsg = currentRecord?.payload?.mapping?.[last.id || last.nodeId]?.message;
    if (canonicalMsg && isTerminalMessage(canonicalMsg)) return false;
    return true;
  });
  // This conversation's recent sent user texts (oldest → newest) for the
  // composer's ArrowUp/Down history recall.
  const recentUserMessages = $derived(
    [...turns, ...unresolvedTurns]
      .map((group) => group?.user?.text)
      .filter((text) => typeof text === 'string' && text.trim().length > 0)
      .slice(-20)
  );
  // Post-submit settlement for the visible conversation. Stale 'running'
  // with a terminal obs and no open submit counts as settled (dispatches);
  // post-submit pre-first-token stays unsettled (refuses the P0-4 hole).
  const settledSinceSubmit = $derived.by(() => {
    const sub = submittedStateByConversation.get(currentConversationId ?? null);
    if (!sub) return true;
    if (conversationWorkState !== 'running' && sub.workState === 'running') return true;
    const lastReply = [...messages].reverse().find((m) => m?.role !== 'user');
    const live = currentRecord?.observations || [];
    const lastObs = [...live].reverse().find((m) => m?.role !== 'user');
    const last = lastReply || lastObs;
    if (!last) return false;
    const canonicalMsg = currentRecord?.payload?.mapping?.[last.id || last.nodeId]?.message;
    const terminal = isTerminalMessage(last) || Boolean(canonicalMsg && isTerminalMessage(canonicalMsg));
    if (!terminal) return false;
    const lastId = String(last.id || last.nodeId || '');
    return !sub.obsId || lastId !== sub.obsId;
  });
  const hasOpenSubmit = $derived(submittedStateByConversation.get(currentConversationId ?? null) != null);
  const composerGenerating = $derived(hasActiveLiveGeneration || (hasOpenSubmit && !settledSinceSubmit));
  // Open submits init empty (see `= $state(new Map())`) and clear on settle
  // so a pre-submit idle state yields generating=false.
  $effect(() => {
    const key = currentConversationId ?? null;
    if (submittedStateByConversation.has(key) && settledSinceSubmit) {
      const next = new Map(submittedStateByConversation);
      next.delete(key);
      submittedStateByConversation = next;
    }
  });
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
      canonicalComplete: currentRecord?.canonicalComplete === true,
      canonicalSyncError: currentRecord?.canonicalSyncError || null,
      turnCount: turns.length,
      unresolvedCount: unresolvedTurns.length,
      protocolIssues: (timeline.protocolIssues || []).slice(0, 100),
      protocolIssueCount: timeline.protocolIssues?.length || 0,
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

  // Stream-done announcement: persistent live node text, updated on running→stopped.
  let streamDoneMessage = $state('');
  let previousWorkState = null;

  $effect(() => {
    const state = conversationWorkState;
    if (previousWorkState === 'running' && state === 'stopped') {
      const replies = messages.filter((message) => message?.role !== 'user' && message?.role !== 'tool' && !message?.tool);
      const chars = replies.reduce((total, message) => total + String(message?.text || '').length, 0);
      const tools = messages.filter((message) => message?.role === 'tool' || message?.tool).length;
      streamDoneMessage = tools > 0
        ? `回答生成完毕，共 ${chars} 字，调用工具 ${tools} 次`
        : `回答生成完毕，共 ${chars} 字`;
    }
    previousWorkState = state;
  });

  // Body scroll-lock while a mobile drawer is open.
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.body.classList.toggle('slimgpt-drawer-open', compactLayout && mobilePanel !== 'none');
  });

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
    const handleGlobalKeydown = (event) => {
      if (event.key === 'Escape') {
        if (showShortcutsModal) {
          event.preventDefault();
          closeShortcutsModal();
          return;
        }
        if (compactLayout && mobilePanel !== 'none') {
          event.preventDefault();
          closeMobilePanels();
          return;
        }
      }
      const isEditing = event.target?.closest?.('input, textarea, [contenteditable="true"]');
      if (isEditing) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'O' || event.key === 'o')) {
        event.preventDefault();
        newChat();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === 'K' || event.key === 'k')) {
        event.preventDefault();
        if (compactLayout && mobilePanel !== 'sidebar') {
          toggleSidebar();
        }
        queueMicrotask(() => {
          document.querySelector('.conversation-search input')?.focus?.();
        });
        return;
      }
      if ((event.key === '?' || (event.key === '/' && (event.metaKey || event.ctrlKey)))) {
        event.preventDefault();
        if (showShortcutsModal) closeShortcutsModal(); else openShortcutsModal();
      }
    };
    window.addEventListener('keydown', handleGlobalKeydown);
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
      stalenessTracker.clear();
      transport.stop();
      clearTimeout(saveTimer);
      clearTimeout(sendTimer);
      clearTimeout(navigationTimer);
      sseDecoders.clear();
      xhrBuffers.clear();
      captureConversationIds.clear();
      conflictedCaptureIds.clear();
      locallyPromotedConversationIds.clear();
      clearPendingLiveEvents();
      layoutQuery.removeEventListener?.('change', syncLayout);
      window.removeEventListener('resize', syncLayout);
      window.visualViewport?.removeEventListener('resize', syncLayout);
      window.removeEventListener('keydown', handleGlobalKeydown);
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

  function resetToLatestBranch() {
    if (!currentPayload || !currentConversationId) return;
    const next = new Map(conversationRecords);
    next.set(currentConversationId, setConversationRecordTerminal(next.get(currentConversationId), currentPayload.current_node));
    conversationRecords = next;
    setComposerStatus('已回到最新分支');
  }

  async function restoreObservationLedger() {
    try {
      const { entries, omissions } = await loadObservationLedgerState();
      mergeObservationLedger(entries);
      applyCacheOmissions(omissions);
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
    if (Array.isArray(update.observationLedgerOmissions)) applyCacheOmissions(update.observationLedgerOmissions);
    if (update.executionPulse?.payload?.type === 'page-execution-state') {
      applyExecutionState(update.executionPulse.payload);
    }
    if (update.userSettings && typeof update.userSettings === 'object') {
      userSettings = { ...DEFAULT_SETTINGS, ...userSettings, ...update.userSettings };
    }
  }

  function applyCacheOmissions(omissions) {
    const known = new Set(['budget', 'conversation-limit', 'structure-limit', 'invalid-value', 'read-failed', 'write-failed']);
    cacheOmissions = new Map((omissions || [])
      .filter((item) => typeof item?.id === 'string' && known.has(item.reason))
      .map((item) => [item.id, item.reason]));
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
    stalenessTracker.reset();
    if (statusStale) statusStale = false;
    if (message.type === 'status') {
      const bridgeError = message.bridgeReady === true ? false : (message.bridgeError ?? status.bridgeError);
      status = { ...status, ...message, bridgeError };
    }
    else if (message.type === 'takeover-state') {
      status = { ...status, takeover: message.active };
      if (message.active) {
        queueMicrotask(focusComposer);
      }
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
    else if (message.type === 'canonical-sync-status') handleHistorySyncStatus(message);
    else if (message.type === 'page-capture' || message.type === 'canonical-capture') handleCapture(message);
    else if (message.type === 'composer-result') handleComposerResult(message);
    else if (message.type === 'capture-warning') setComposerStatus(`页面启动过快，${message.dropped || 1} 个早期同步事件未能保留；可刷新页面重新同步`, true);
    else if (message.type === 'command-error') {
      status = { ...status, bridgeError: message.command === 'install-page-hook' };
      setComposerStatus(message.error || '命令失败', true);
    }
  }

  function handleHistorySyncStatus(message) {
    const id = typeof message.conversationId === 'string' ? message.conversationId.trim() : '';
    if (!id || !['loading', 'error', 'complete'].includes(message.state)) return;
    const states = new Map(historySyncStates);
    const previous = states.get(id);
    if (message.state !== 'loading' && previous?.canonicalSyncId && message.canonicalSyncId && previous.canonicalSyncId !== message.canonicalSyncId) return;
    if (message.state === 'complete') {
      const before = conversationRecords.get(id);
      const record = finishCanonicalSync(before, message.canonicalSyncId);
      if (record !== before) {
        const records = new Map(conversationRecords);
        records.set(id, record);
        conversationRecords = records;
      }
      // The sender's success does not prove that every bridged page arrived.
      if (!record?.canonicalComplete || record.canonicalSyncError || !record.canonicalRetiredSyncIds?.includes(message.canonicalSyncId)) {
        states.set(id, { state: 'error', code: 'invalid-history' });
      } else states.set(id, { state: 'complete', canonicalSyncId: message.canonicalSyncId });
    } else states.set(id, { ...previous, ...message });
    while (states.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = [...states.keys()].find((key) => key !== currentConversationId && key !== id);
      if (!oldest) break;
      states.delete(oldest);
    }
    historySyncStates = states;
    if (id === currentConversationId && states.get(id)?.state === 'error') {
      clearTimeout(navigationTimer);
      navigationTimer = null;
      navigationTimedOutId = id;
    }
  }

  function retryHistorySync() {
    if (!currentConversationId || !status.bridgeReady || currentHistorySyncState?.state === 'loading') return;
    // The page hook enforces server backoff; a click never forces a retry loop.
    transport.send({ type: 'refresh-conversation', conversationId: currentConversationId });
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
      const decoder = sseDecoders.get(key) || createConversationStreamReader({ maxBufferedChars: MAX_CAPTURE_BUFFER });
      sseDecoders.set(key, decoder);
      const { values, error, failed } = decoder.push(text, capture.phase === 'complete');
      if (capture.phase === 'complete') {
        sseDecoders.delete(key);
      }
      for (const value of values) processStructured(value, capture);
      if (error) {
        setComposerStatus(error === 'buffer-limit'
          ? '一个流式事件超出解析上限，已停止合并这段响应，正在同步完整会话'
          : '响应流不完整或无法解码，已停止合并后续增量，正在同步完整会话', true);
      }
      if (error || (failed && capture.phase === 'complete')) {
        const scope = resolveCapturedConversation(capture);
        if (!scope.conflicted && scope.conversationId) {
          transport.send({ type: 'refresh-conversation', conversationId: scope.conversationId });
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

    // Both ordinary message events and decoded v1 deltas contain snapshots.
    // Appending them heuristically corrupts replacements, truncations and
    // repeated text in reasoning/tool arguments.
    for (const event of findMessageEvents(value, { textMode: 'snapshot' })) {
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
    const turnContext = captureMessageContext(event, capture);
    const next = new Map(conversationRecords);
    next.set(id, ingestConversationMessage(next.get(id), event.message, {
      textMode: 'snapshot',
      ...turnContext,
      captureId: capture.requestId || null,
      captureTransport: capture.transport || null,
      observationOrdinal: ++observationOrdinal,
      sequenceNumber: event.sequenceNumber ?? null,
      outputIndex: event.outputIndex ?? null,
      contentIndex: event.contentIndex ?? null,
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
      capture.conversationRequest !== true || !matchesPendingTurn(pendingUser, null, capture)
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
    for (const [key, entries] of pendingLiveEvents) {
      const matching = entries.filter((entry) => matchesPendingTurn(pendingUser, id, entry.capture));
      const retained = entries.filter((entry) => !matching.includes(entry));
      queued.push(...matching);
      pendingLiveEventCount -= matching.length;
      if (retained.length) pendingLiveEvents.set(key, retained);
      else pendingLiveEvents.delete(key);
    }
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
    const identityCapture = {
      ...capture,
      turnId: lifecycle.turnId || capture.turnId || null,
      turnAliases,
      transportSessionId: lifecycle.transportSessionId || capture.transportSessionId || null,
      transportTurnId: lifecycle.transportTurnId || capture.transportTurnId || null,
      turnUserMessageId: lifecycle.turnUserMessageId || capture.turnUserMessageId || null,
      turnParentMessageId: lifecycle.turnParentMessageId || capture.turnParentMessageId || null,
      turnExchangeId: lifecycle.turnExchangeId || capture.turnExchangeId || null,
    };
    const correlated = matchesPendingTurn(pendingUser, id, identityCapture);
    if (!correlated) return;
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
    if (!matchesPendingTurn(pendingUser, id, capture)) return;
    const turnAliases = capture.turnAliases?.length
      ? capture.turnAliases
      : (pendingUser.turnAliases || []);
    pendingUser = {
      ...pendingUser,
      turnId: capture.turnId || pendingUser.turnId || null,
      turnAliases,
      turnExchangeId: capture.turnExchangeId || pendingUser.turnExchangeId || null,
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
    const correlated = matchesPendingTurn(pendingUser, id, capture);
    bindPendingTurnIdentity(id, capture);
    if (id === currentConversationId) return;
    if (
      capture.conversationRequest === true &&
      correlated &&
      pendingUser?.conversationId === null &&
      (!currentConversationId || isProvisionalConversationId(currentConversationId))
    ) {
      bindPendingConversation(id);
    }
  }

  function acceptConversationPayload(id, payload, capture = {}) {
    const nextRecords = new Map(conversationRecords);
    const previousRecord = nextRecords.get(id);
    const record = ingestConversationPayload(previousRecord, payload, {
      canonicalComplete: capture.canonicalComplete === true,
      canonicalSyncId: capture.canonicalSyncId || null,
      canonicalPageIndex: capture.canonicalPageIndex ?? null,
      canonicalPageCount: capture.canonicalPageCount,
      conversationId: id,
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
    if (capture.canonicalSyncId && !record.canonicalSyncId && !record.canonicalSyncError &&
        record.canonicalComplete && record.payload !== previousRecord?.payload) {
      const states = new Map(historySyncStates);
      states.set(id, { state: 'complete', canonicalSyncId: capture.canonicalSyncId });
      historySyncStates = states;
    }
    if (record.canonicalSyncError && id === currentConversationId) {
      clearTimeout(navigationTimer);
      navigationTimer = null;
      navigationTimedOutId = id;
    }
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
      sidebarNotice = '消息提交中，请等待确认后再切换对话';
      setComposerStatus('消息提交中，请等待确认后再切换对话', true);
      return;
    }
    // Allow re-click retry if timed out or incomplete
    const record = conversationRecords.get(id);
    const isTimedOut = navigationTimedOutId === id;
    const isIncomplete = record && !record.canonicalComplete;
    const canRetryCurrent = id === currentConversationId && (isTimedOut || isIncomplete);

    if (!id || (id === currentConversationId && !canRetryCurrent && record?.payload)) {
      closeMobilePanels();
      return;
    }
    setCurrentConversation(id);
    thinkingLevelOverride = null;
    sidebarNotice = '';
    startConversationLoading(id);
    closeMobilePanels();
    if (transport.supportsLiveChat) {
      const route = conversationMap.get(id)?.route === 'uc' ? 'uc' : 'c';
      transport.send({ type: 'navigate-conversation', conversationId: id, route });
      setComposerStatus('');
      queueMicrotask(focusComposer);
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
    // Never wipe the null-conversation draft here: restore it when entering
    // null (setCurrentConversation already did when switching); it clears
    // only on confirmed send (handleComposerResult).
    draft = draftsByConversation.get(null) || '';
    submittedStateByConversation.delete(null);
    clearPendingLiveEvents();
    closeMobilePanels();
    if (transport.supportsLiveChat) {
      transport.send({ type: 'new-chat', thinkingLevel: userSettings.thinkingLevel });
    }
    queueMicrotask(focusComposer);
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
    // The open submit moves with the draft from the null/provisional scope
    // to the bound id (dispatch may have keyed either).
    if (!submittedStateByConversation.has(id)) {
      for (const [key, entry] of submittedStateByConversation) {
        if ((key === null || key === undefined || isProvisionalConversationId(key)) && key !== id) {
          submittedStateByConversation.set(id, entry);
          submittedStateByConversation.delete(key);
          break;
        }
      }
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

  function exportMarkdown(opts = {}) {
    const includeThought = opts.includeThought !== false;
    const includeTools = opts.includeTools !== false;
    const exportable = turns.flatMap((turn) => [turn.user, ...turn.replies]).filter(hasExportableMessage);
    const hasUnresolved = unresolvedTurns.some((group) => group.replies?.some(hasExportableMessage));
    if (!exportable.length && !hasUnresolved) {
      sidebarExportError = conversationHistoryPending ? '当前对话尚未加载，暂无可导出的内容' : '当前对话暂无可导出的消息';
      setComposerStatus(sidebarExportError, true);
      return;
    }
    const title = currentMeta?.title || 'ChatGPT Conversation';
    try {
      const { filename } = downloadConversationMarkdown(title, exportable, {
        unresolved: unresolvedTurns,
        conversationId: currentConversationId,
        createTime: currentMeta?.create_time ? new Date(currentMeta.create_time < 10_000_000_000 ? currentMeta.create_time * 1000 : currentMeta.create_time).toISOString() : null,
        updateTime: currentMeta?.update_time ? new Date(currentMeta.update_time < 10_000_000_000 ? currentMeta.update_time * 1000 : currentMeta.update_time).toISOString() : null,
        historyComplete: currentRecord?.canonicalComplete === true,
        model: currentMeta?.model || null,
        includeThought,
        includeTools,
      });
      setComposerStatus(conversationHistoryPending ? `已导出当前已取得的内容（历史不完整）：${filename}` : `已导出 ${filename}`);
      sidebarExportError = '';
    } catch {
      setComposerStatus('导出失败，未生成完整文件；当前聊天内容仍保留在页面中', true);
      sidebarExportError = '导出失败，未生成完整文件';
    }
  }

  async function copyConversationMarkdown(opts = {}) {
    const includeThought = opts.includeThought !== false;
    const includeTools = opts.includeTools !== false;
    const exportable = turns.flatMap((turn) => [turn.user, ...turn.replies]).filter(hasExportableMessage);
    const hasUnresolved = unresolvedTurns.some((group) => group.replies?.some(hasExportableMessage));
    if (!exportable.length && !hasUnresolved) {
      sidebarExportError = conversationHistoryPending ? '当前对话尚未加载，暂无可复制的内容' : '当前对话暂无可复制的消息';
      setComposerStatus(sidebarExportError, true);
      return false;
    }
    const title = currentMeta?.title || 'ChatGPT Conversation';
    const content = buildConversationMarkdown(title, exportable, {
      unresolved: unresolvedTurns,
      conversationId: currentConversationId,
      historyComplete: currentRecord?.canonicalComplete === true,
      model: currentMeta?.model || null,
      includeThought,
      includeTools,
    });
    try {
      await copyText(content);
      setComposerStatus(conversationHistoryPending ? '已复制当前已取得的内容（历史不完整）' : '已复制当前对话 Markdown');
      sidebarExportError = '';
      return true;
    } catch {
      setComposerStatus('复制失败，请手动选择并复制', true);
      sidebarExportError = '复制失败，请手动选择并复制';
      return false;
    }
  }

  async function copyTurnMarkdown(turn, opts = {}) {
    const content = buildTurnMarkdown(turn, {
      includeThought: opts.includeThought !== false,
      includeTools: opts.includeTools !== false,
    });
    if (!content.trim()) {
      setComposerStatus('本轮暂无可复制的内容', true);
      return false;
    }
    try {
      await copyText(content);
      setComposerStatus('已复制本轮 Markdown');
      return true;
    } catch {
      setComposerStatus('复制失败，请手动选择并复制', true);
      return false;
    }
  }

  // Runs the exact watchdog-timeout path immediately: mark unconfirmed,
  // keep the draft, free the gate for an explicit retry. Shared by the
  // send watchdog and the composer's 取消等待 button.
  function cancelSendWait() {
    if (!pendingCommandId) return;
    const commandId = pendingCommandId;
    const timedOutConversationId = pendingCommandConversationId;
    clearTimeout(sendTimer);
    sendTimer = null;
    pendingCommandId = null;
    pendingCommandConversationId = null;
    sendInFlight = false;
    if (pendingUser?.commandId === commandId) {
      pendingUser = {
        ...pendingUser,
        failed: true,
        message: {
          ...pendingUser.message,
          status: 'failed',
          error: '官方输入框未确认提交',
          failed: true,
        },
      };
    }
    clearPendingLiveEvents();
    submittedStateByConversation.delete(timedOutConversationId ?? null);
    setConversationWorkState(timedOutConversationId, 'unknown');
    setComposerStatus('官方输入框未确认提交；内容仍保留，请检查官方界面后手动决定是否重试', true);
  }

  function sendMessage(text, options = {}) {
    function workStateOf(id) {
      return id ? (workStates.get(id) || 'unknown') : newChatWorkState;
    }
    function lastNonUserObservationId() {
      const live = currentRecord?.observations || [];
      const last = [...live].reverse().find((m) => m?.role !== 'user');
      return last ? String(last.id || last.nodeId || '') : null;
    }
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
    if (conversationWorkState === 'running' && hasActiveLiveGeneration) {
      // Refuse locally: dispatching here would ride the send watchdog and
      // mark a message failed that was never actually submitted.
      setComposerStatus('正在生成回答，请稍候…');
      return;
    }
    if (sendInFlight || conversationWorkState === 'starting') {
      setComposerStatus('上一条消息仍在提交；SlimGPT 不会重复发送', true);
      return;
    }
    // Generation gate, done right: a stale 'running' work state with a
    // terminal observation still dispatches (no open turn), but post-submit
    // pre-first-token refuses (submitted && unsettled closes the hole).
    if (hasActiveLiveGeneration || (hasOpenSubmit && !settledSinceSubmit)) {
      setComposerStatus('正在生成回答，请稍候…');
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
    // Snapshot the turn for the generation gate: post-submit pre-first-token
    // refuses until a new terminal observation or a running→stopped flip.
    submittedStateByConversation.set(currentConversationId ?? null, {
      at: stamp,
      obsId: lastNonUserObservationId(),
      workState: workStateOf(currentConversationId),
    });
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
      cancelSendWait();
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
      if (pendingUser) {
        pendingUser = {
          ...pendingUser,
          failed: true,
          message: {
            ...pendingUser.message,
            status: 'failed',
            error: message.error || '发送失败',
            failed: true,
          },
        };
      }
      clearPendingLiveEvents();
      if (message.error === 'send-in-progress') setConversationWorkState(submittedConversationId, 'running');
      else if (message.error === 'send-unconfirmed') setConversationWorkState(submittedConversationId, 'unknown');
      // A refused submit never opened a turn: free the gate for retry.
      // 'send-in-progress' means the official side is still working, so the
      // turn stays tracked and the gate keeps refusing until it settles.
      if (message.error !== 'send-in-progress') {
        submittedStateByConversation.delete(submittedConversationId ?? null);
      }
      const details = {
        'composer-not-found': '找不到官方输入框：请检查当前 ChatGPT 页面是否已登录或页面结构是否变化',
        'composer-rejected-input': '官方输入框没有接受这段文字；内容仍保留，未发送',
        'send-control-not-ready': '官方发送按钮未就绪；内容仍保留，未发送',
        'send-in-progress': '官方页面仍在处理上一条消息；本条未发送',
        'empty-message': '消息为空，未发送',
        'send-unconfirmed': '已点击发送但官方页面未确认；消息可能未发出，请勿重复发送，可在官方界面核实',
      };
      const detail = details[message.error] || humanizeError(message.error) || `发送失败：${message.error || 'unknown'}`;
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
    queueMicrotask(focusComposer);
  }

  // Composer error-alert 就地重试: resend the current draft text via the
  // existing dispatch; with an empty draft, retry the failed pending text.
  function handleComposerRetry() {
    if (draft.trim()) {
      sendMessage(draft.trim());
      return;
    }
    if (pendingUser) handleRetrySend(pendingUser.message);
  }

  function handleRetrySend(targetMessage) {
    // Assistant/tool retries resend the turn's USER text, never assistant
    // output. User/pending retries keep the message's own text.
    let textToRetry = '';
    if (!targetMessage || targetMessage?.role === 'user' || targetMessage?.pending || targetMessage?.failed) {
      textToRetry = targetMessage?.text || pendingUser?.text || '';
    } else {
      const groups = [...turns, ...unresolvedTurns];
      const owner = groups.find((group) => (group?.replies || []).some((reply) =>
        reply === targetMessage || messageIdentityMatches(reply, targetMessage)));
      textToRetry = owner?.user?.text || '';
      if (!textToRetry) return;
    }
    if (!textToRetry) return;
    if (pendingUser) {
      pendingUser = null;
    }
    sendMessage(textToRetry);
  }

  function messageIdentityMatches(a, b) {
    if (!a || !b) return false;
    for (const key of ['id', 'nodeId', 'itemId', 'observationKey']) {
      const left = a[key];
      const right = b[key];
      if (left && right && String(left) === String(right)) return true;
    }
    return false;
  }

  function handleEditMessage(message) {
    // onEdit only fires for user-role messages (MessageBubble renders the
    // edit button on user bubbles, including the failed pending card).
    const text = String(message?.text || '');
    if (!text) return;
    if (
      pendingUser?.failed &&
      (message?.failed || message?.text === pendingUser.text ||
        (message?.id && message.id === pendingUser.message?.id))
    ) {
      pendingUser = null;
    }
    draft = text;
    draftsByConversation.set(currentConversationId, text);
    queueMicrotask(focusComposer);
  }

  function handleStopGeneration() {
    if (conversationWorkState !== 'running') return;
    transport.stopGeneration();
    // The user explicitly ended the turn: free the gate for the next send.
    submittedStateByConversation.delete(currentConversationId ?? null);
    // A missing official stop control reports back as a command-error and
    // overwrites this optimistic notice; success flips the work state.
    setComposerStatus('正在请求停止生成…');
  }

  function handleDismissPendingUser() {
    if (pendingUser) {
      pendingUser = null;
    }
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

  const DRAFT_STORAGE_KEY = 'slimgpt-drafts-v1';
  let composerStatusTimer = null;
  let draftPersistTimer = null;

  function setComposerStatus(text, error = false) {
    composerStatus = text;
    composerError = error;
    clearTimeout(composerStatusTimer);
    composerStatusTimer = null;
    if (text && !error) {
      // Transient confirmations fade on their own; errors stay until dismissed.
      const snapshot = text;
      composerStatusTimer = setTimeout(() => {
        if (composerStatus === snapshot && !composerError) composerStatus = '';
      }, 4000);
    }
  }

  function persistDraftsSoon(snapshot, key) {
    clearTimeout(draftPersistTimer);
    draftPersistTimer = setTimeout(() => writeDraftsNow(snapshot, key), 300);
  }

  // Synchronous twin of the debounced persist: beforeunload must not rely
  // on the timer, or the last keystrokes are lost on reload/close.
  function writeDraftsNow(snapshot, key) {
    try {
      draftsByConversation.set(key, snapshot);
      const entries = [...draftsByConversation.entries()].map(([entryKey, value]) => [
        entryKey === null || entryKey === undefined ? '\0' : String(entryKey),
        String(value || ''),
        ]);
      sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(entries));
    } catch {}
  }

  function restoreDrafts() {
    try {
      const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return;
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return;
      for (const [key, value] of entries) {
        if (typeof value !== 'string') continue;
        draftsByConversation.set(key === '\0' ? null : String(key), value);
      }
      const restored = draftsByConversation.get(currentConversationId);
      if (typeof restored === 'string' && restored) draft = restored;
    } catch {}
  }

  onMount(() => {
    restoreDrafts();
    // Synchronous draft flush on unload: the debounced persist would
    // otherwise drop the last keystrokes on reload/close.
    const flushDraftsOnUnload = () => writeDraftsNow(draft, currentConversationId);
    window.addEventListener('beforeunload', flushDraftsOnUnload);
    return () => window.removeEventListener('beforeunload', flushDraftsOnUnload);
  });

  $effect(() => {
    // Drafts persist (debounced) and the next keystroke clears a transient
    // non-error status. Reading composerStatus here only ever clears it.
    const snapshot = draft;
    const key = currentConversationId;
    persistDraftsSoon(snapshot, key);
    if (snapshot && composerStatus && !composerError) composerStatus = '';
  });

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
    const omissions = [];
    try {
      await Promise.all([
        saveConversationIndex(indexSnapshot),
        saveObservationLedger(recordsSnapshot, { onOmitted: (item) => omissions.push(item) }),
      ]);
      applyCacheOmissions(omissions);
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
    const updateTime = Number(rawMessage.create_time ?? rawMessage.createTime ?? metadata.timestamp) || null;
    updateConversationPreview(
      id,
      contentToText(rawMessage.content, metadata),
      metadata.model_slug || metadata.default_model_slug || metadata.model || '',
      updateTime,
    );
  }

  function updateConversationPreview(id, text, model = '', updateTime = null) {
    const existing = conversationMap.get(id) || null;
    const previous = existing || normalizeConversationMeta({
      id,
      title: 'Untitled',
      route: 'c',
    });
    const preview = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (existing && !preview && !model && !updateTime) return;
    const updated = normalizeConversationMeta({
      ...previous,
      last: preview || previous.last,
      model: model || previous.model,
      update_time: updateTime || previous.update_time,
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
    if (mobilePanel !== 'sidebar') lastActiveMobileTrigger = document.querySelector('.mobile-sidebar-button');
    const willOpen = mobilePanel !== 'sidebar';
    mobilePanel = mobilePanel === 'sidebar' ? 'none' : 'sidebar';
    if (mobilePanel === 'none' && lastActiveMobileTrigger) {
      if (lastActiveMobileTrigger?.isConnected) lastActiveMobileTrigger.focus?.();
      else focusComposer();
    } else if (willOpen) {
      queueMicrotask(() => {
        const target = document.querySelector('#slimgpt-mobile-sidebar .conversation-search input') ||
          document.querySelector('#slimgpt-mobile-sidebar button:not([disabled])');
        target?.focus?.();
      });
    }
  }

  function toggleOverview() {
    if (!compactLayout) return;
    if (mobilePanel !== 'overview') lastActiveMobileTrigger = document.querySelector('.mobile-overview-button');
    const willOpen = mobilePanel !== 'overview';
    mobilePanel = mobilePanel === 'overview' ? 'none' : 'overview';
    if (mobilePanel === 'none' && lastActiveMobileTrigger) {
      if (lastActiveMobileTrigger?.isConnected) lastActiveMobileTrigger.focus?.();
      else focusComposer();
    } else if (willOpen) {
      queueMicrotask(() => {
        const target = document.querySelector('#slimgpt-mobile-overview .overview-item.active') ||
          document.querySelector('#slimgpt-mobile-overview .overview-item') ||
          document.querySelector('#slimgpt-mobile-overview button:not([disabled])');
        target?.focus?.();
      });
    }
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
    const prev = mobilePanel;
    mobilePanel = 'none';
    panelPointerIntent = null;
    if (prev !== 'none' && lastActiveMobileTrigger) {
      const trigger = lastActiveMobileTrigger;
      lastActiveMobileTrigger = null;
      queueMicrotask(() => {
        if (trigger?.isConnected) trigger.focus?.();
        else focusComposer();
      });
    } else if (prev !== 'none') {
      queueMicrotask(focusComposer);
    }
  }

  function openShortcutsModal(trigger = null) {
    lastActiveModalTrigger = trigger || (document.activeElement?.isConnected ? document.activeElement : null);
    showShortcutsModal = true;
    void tick().then(() => {
      shortcutsModalEl?.querySelector('.shortcuts-close-btn')?.focus?.();
    });
  }

  function closeShortcutsModal() {
    showShortcutsModal = false;
    queueMicrotask(() => {
      if (lastActiveModalTrigger?.isConnected) {
        lastActiveModalTrigger.focus?.();
      } else {
        focusComposer();
    }
      lastActiveModalTrigger = null;
    });
  }
</script>
<Page class={`slimgpt-page ${compactLayout ? 'compact-layout' : 'desktop-layout'}`}>
  <Navbar
    class={`mobile-navbar ${mobilePanel !== 'none' ? 'drawer-open' : ''}`}
    role="banner"
    inert={compactLayout && mobilePanel !== 'none'}
  >
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
      <button
        type="button"
        class="button button-small mobile-newchat-button"
        aria-label="发起新对话"
        title="发起新对话"
        disabled={sendInFlight}
        onclick={() => { closeMobilePanels(); newChat(); }}
      >+</button>
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
      {#if statusState !== 'online'}
        <span class={`mobile-status-badge ${statusState}`}>{statusLabel}</span>
      {/if}
    </div>
    <NavRight>
      <button
        type="button"
        class="button button-small mobile-shortcuts-button"
        title="快捷键指南"
        onclick={(event) => openShortcutsModal(event.currentTarget)}
      >快捷键</button>
      <button
        type="button"
        class="button button-small mobile-official-button"
        title="查看官方界面（可点击宿主页面右下角的 SlimGPT 浮动按钮随时返回）"
        onclick={() => transport.openOfficial(currentConversationId)}
      >官方界面</button>
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
      role={compactLayout ? 'dialog' : 'navigation'}
      aria-modal={compactLayout && mobilePanel === 'sidebar' ? 'true' : undefined}
      aria-label={compactLayout ? '会话侧栏' : '会话导航'}
      hidden={compactLayout && mobilePanel !== 'sidebar'}
      tabindex="-1"
      onkeydown={(event) => { if (compactLayout && mobilePanel === 'sidebar') trapModalKeydown(event, event.currentTarget, closeMobilePanels); }}
    >
      <ConversationSidebar
        conversations={sidebarConversations}
        currentId={currentConversationId}
        {loadingConversationId}
        {navigationTimedOutId}
        historySyncState={currentHistorySyncState}
        {sendInFlight}
        historyComplete={currentRecord?.canonicalComplete === true}
        hasExportableContent={currentHasRenderableContent}
        exportError={sidebarExportError}
        {sidebarNotice}
        onRetryHistorySync={retryHistorySync}
        onClearNotice={() => { sidebarNotice = ''; sidebarExportError = ''; }}
        {statusLabel}
        {statusState}
        {captures}
        cachedCount={conversationRecords.size}
        omissionCount={cacheOmissions.size}
        workState={conversationWorkState}
        onShowOfficial={() => transport.send({ type: 'open-official', conversationId: currentConversationId })}
        onExportMarkdown={exportMarkdown}
        onCopyMarkdown={copyConversationMarkdown}
        onNewChat={newChat}
        onSelect={selectConversation}
        generatingIds={generatingIds}
        branchLabel={currentBranchLabel}
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
          <Button small onClick={() => transport.openOfficial(currentConversationId)} title="查看官方界面（可点击宿主页面右下角的 SlimGPT 浮动按钮随时返回）">查看官方界面</Button>
          <button
            type="button"
            class="button button-small header-shortcuts-button"
            title="查看键盘快捷键 (? 或 Ctrl+/)"
            onclick={(event) => openShortcutsModal(event.currentTarget)}
          >快捷键</button>
        </div>
      </header>

      <section class="message-stage" aria-label="消息内容">
        {#if turns.length || unresolvedTurns.length}
          <ConversationTurnStage
            {turns}
            unresolved={unresolvedTurns}
            justSent={sendInFlight}
            onRepairProtocol={retryHistorySync}
            activeIndex={activeTurnIndex}
            conversationKey={displayConversationId || 'new'}
            onActiveChange={(index) => activeTurnIndex = index}
            onBranch={stepBranch}
            onRetry={handleRetrySend}
            onEdit={handleEditMessage}
            onDismiss={handleDismissPendingUser}
            streaming={conversationActivelyWorking}
            onQuote={handleQuoteText}
            onCopyTurn={copyTurnMarkdown}
          />
        {:else if !conversationHistoryPending}
          <div class="empty-state">
            {#if !status.bridgeReady}
              <div class="empty-logo">S</div>
              <h2>尚未与 ChatGPT 建立通信</h2>
              <p>请确认官方页面已登录并完成加载，然后刷新官方网页重试；连接恢复后即可在此收发消息。</p>
              <div class="empty-actions">
                <Button outline small onClick={() => transport.openOfficial(currentConversationId)}>刷新官方网页</Button>
                <Button outline small onClick={(event) => openShortcutsModal(event.currentTarget)}>快捷键指南</Button>
              </div>
            {:else}
              <div class="empty-logo">S</div>
              <h2>更轻的 ChatGPT 界面</h2>
              <p>登录、网络和发送仍由当前 ChatGPT 页面处理；SlimGPT 负责会话呈现，并在覆盖显示时暂停官方界面的布局和绘制。</p>
              <div class="empty-actions">
                <Button outline small onClick={newChat}>开始新对话</Button>
                <Button outline small onClick={() => transport.openOfficial(currentConversationId)} title="暂时切换至官方页面（可点击宿主页面右下角的 SlimGPT 浮动按钮随时返回）">查看官方界面</Button>
                <Button outline small onClick={(event) => openShortcutsModal(event.currentTarget)}>快捷键指南</Button>
              </div>
            {/if}
            <div class="empty-shortcuts-hint">
              提示：在下方输入框输入消息按 Enter 即可发送，Shift + Enter 换行；按 ? 查看快捷键，按 Ctrl/⌘ + K 聚焦搜索
            </div>
          </div>
        {/if}

        {#if conversationBlockingLoad}
          <div class="conversation-loading" role="status" aria-live="polite">
            <span class="conversation-loading-spinner" aria-hidden="true"></span>
            <strong>{conversationTimedOut ? '对话暂未加载' : '正在加载对话'}</strong>
            <span>{conversationTimedOut ? '完整历史尚未同步；可重新点击侧栏中的该会话重试' : (currentMeta?.title || '正在同步 ChatGPT 完整会话…')}</span>
            <div class="conversation-loading-actions">
              <Button small outline disabled={!status.bridgeReady} onClick={retryHistorySync}>重试同步</Button>
              <Button small outline onClick={() => transport.openOfficial(currentConversationId)}>查看官方界面</Button>
              <Button small outline onClick={newChat}>新建对话</Button>
            </div>
          </div>
        {/if}

        {#if activeBanners.length}
          <div class="stage-banner-stack" role="region" aria-label="状态提醒">
            {#if topBanner}
              <div class={`stage-guide-banner ${topBanner.level}${topBanner.actionKey === 'sync-error' ? ' history-sync-error' : ''}${topBanner.id === 'cache-notice' ? ' cache-integrity-notice' : ''}`} role={topBanner.level === 'error' ? 'alert' : 'status'}>
                <div class="banner-text">
                  <strong>{topBanner.title}</strong>
                  <span>{topBanner.message}</span>
                </div>
                <div class="banner-actions">
                  {#if topBanner.actionKey === 'bridge-error'}
                    <Button small outline onClick={() => transport.openOfficial(currentConversationId)}>查看官方界面</Button>
                  {:else if topBanner.actionKey === 'offline'}
                    <Button small outline onClick={() => transport.send({ type: 'request-status' })}>重新检查连接</Button>
                    <Button small outline onClick={() => transport.openOfficial(currentConversationId)}>查看官方界面</Button>
                  {:else if topBanner.actionKey === 'sync-error' || topBanner.actionKey === 'resync'}
                    <Button small outline disabled={!status.bridgeReady} onClick={retryHistorySync}>重试同步</Button>
                  {/if}
                  {#if topBanner.level !== 'error'}
                    <button type="button" class="banner-dismiss-btn" aria-label={`关闭提醒：${topBanner.title}`} title="关闭此提醒" onclick={() => dismissBanner(topBanner.id)}>✕</button>
                  {/if}
                </div>
              </div>
            {/if}
            {#if secondaryBanners.length > 0}
              <button type="button" class="stage-banner-expander" onclick={() => expandedBanners = !expandedBanners}>
                {expandedBanners ? '收起其他提醒' : `还有 ${secondaryBanners.length} 项提醒 ▾`}
              </button>
              {#if expandedBanners}
                {#each secondaryBanners as banner (banner.id)}
                  <div class={`stage-guide-banner ${banner.level}${banner.actionKey === 'sync-error' ? ' history-sync-error' : ''}${banner.id === 'cache-notice' ? ' cache-integrity-notice' : ''}`} role={banner.level === 'error' ? 'alert' : 'status'}>
                    <div class="banner-text">
                      <strong>{banner.title}</strong>
                      <span>{banner.message}</span>
                    </div>
                    {#if banner.level !== 'error'}
                      <div class="banner-actions">
                        <button type="button" class="banner-dismiss-btn" aria-label={`关闭提醒：${banner.title}`} title="关闭此提醒" onclick={() => dismissBanner(banner.id)}>✕</button>
                      </div>
                    {/if}
                  </div>
                {/each}
              {/if}
            {/if}
          </div>
        {/if}

        {#if conversationWorkState === 'running' && !conversationBlockingLoad}
          <div class="work-indicator" role="status" aria-live="polite">
            <span class="work-indicator-spinner" aria-hidden="true"></span>
            <span>对话执行中：官方页面仍在生成，请稍候…</span>
          </div>
        {/if}
        <div class="sr-only" aria-live="polite" role="status">{streamDoneMessage}</div>
      </section>

      {#if isViewingAlternativeBranch}
        <div class="branch-return-banner" role="status">
          <span>正在查看历史分支（只读）</span>
          <button type="button" class="button button-small branch-return-btn" onclick={resetToLatestBranch}>切回最新分支</button>
        </div>
      {/if}

      <Composer
        bind:this={composerRef}
        bind:value={draft}
        thinkingLevel={effectiveThinkingLevel}
        onThinkingLevelChange={handleThinkingLevelChange}
        disabled={!transport.supportsLiveChat || !status.bridgeReady}
        loading={conversationPending}
        busy={sendInFlight}
        generating={composerGenerating}
        status={composerStatus}
        error={composerError}
        readonlyBranch={isViewingAlternativeBranch}
        recentUserMessages={recentUserMessages}
        onSend={sendMessage}
        onStop={handleStopGeneration}
        onCancelSend={cancelSendWait}
        onRetry={handleComposerRetry}
        onReturnToLatestBranch={resetToLatestBranch}
      />
    </main>

    <div
      id="slimgpt-mobile-overview"
      class:open={compactLayout && mobilePanel === 'overview'}
      class="overview-host"
      role={compactLayout ? 'dialog' : 'complementary'}
      aria-modal={compactLayout && mobilePanel === 'overview' ? 'true' : undefined}
      aria-label={compactLayout ? '消息概览' : '对话目录'}
      hidden={compactLayout && mobilePanel !== 'overview'}
      tabindex="-1"
      onkeydown={(event) => { if (compactLayout && mobilePanel === 'overview') trapModalKeydown(event, event.currentTarget, closeMobilePanels); }}
    >
      <MessageOverview
        {turns}
        unresolvedCount={unresolvedTurns.reduce((total, turn) => total + turn.replies.length, 0)}
        activeIndex={activeTurnIndex}
        onSelect={selectOverviewMessage}
        streaming={conversationActivelyWorking}
      />
    </div>

    {#if compactLayout && mobilePanel !== 'none'}
      <button
        type="button"
        class="sidebar-scrim"
        aria-label={getScrimAriaLabel(mobilePanel)}
        onpointerdown={(event) => { event.preventDefault(); closeMobilePanels(); }}
        onclick={(event) => { event.preventDefault(); closeMobilePanels(); }}
      ></button>
    {/if}
  </div>

  {#if showShortcutsModal}
    <div
      bind:this={shortcutsModalEl}
      class="shortcuts-modal-backdrop"
      role="presentation"
      onclick={(event) => { if (event.target === event.currentTarget) closeShortcutsModal(); }}
      onkeydown={(event) => trapModalKeydown(event, shortcutsModalEl, closeShortcutsModal)}
    >
      <div class="shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div class="shortcuts-modal-header">
          <strong id="shortcuts-title">键盘快捷键指南</strong>
          <button type="button" class="shortcuts-close-btn" aria-label="关闭" onclick={closeShortcutsModal}>✕</button>
        </div>
        <div class="shortcuts-grid">
          <div class="shortcut-row">
            <kbd>Enter</kbd>
            <span>发送消息（输入框聚焦时）</span>
          </div>
          <div class="shortcut-row">
            <kbd>Shift + Enter</kbd>
            <span>在输入框中换行</span>
          </div>
          <div class="shortcut-row">
            <kbd>Ctrl / ⌘ + Shift + O</kbd>
            <span>新建对话</span>
          </div>
          <div class="shortcut-row">
            <kbd>Ctrl / ⌘ + K</kbd>
            <span>聚焦侧栏搜索框</span>
          </div>
          <div class="shortcut-row">
            <kbd>← / →</kbd>
            <span>在问答轮次间前后翻页</span>
          </div>
          <div class="shortcut-row">
            <kbd>↑ / ↓</kbd>
            <span>在当前问答卡片中滚动内容</span>
          </div>
          <div class="shortcut-row">
            <kbd>PageUp / PageDown</kbd>
            <span>跨屏快速翻页浏览</span>
          </div>
          <div class="shortcut-row">
            <kbd>Home / End</kbd>
            <span>跳至当前轮次顶部或底部</span>
          </div>
          <div class="shortcut-row">
            <kbd>Ctrl / ⌘ + Home / End</kbd>
            <span>跳至首轮 / 末轮</span>
          </div>
          <div class="shortcut-row">
            <kbd>Esc</kbd>
            <span>关闭打开的侧栏、概览抽屉或弹窗；在搜索框中清空搜索</span>
          </div>
          <div class="shortcut-row">
            <kbd>↑ / ↓（思考强度聚焦时）</kbd>
            <span>调节思考强度档位</span>
          </div>
          <div class="shortcut-row">
            <kbd>? / Ctrl + /</kbd>
            <span>打开 / 关闭本快捷键指南</span>
          </div>
        </div>
      </div>
    </div>
  {/if}
</Page>
