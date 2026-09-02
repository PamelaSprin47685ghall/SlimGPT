<script>
  import { onMount } from 'svelte';
  import { Button, Navbar, NavLeft, NavRight, Page } from 'framework7-svelte';
  import ConversationSidebar from '../components/ConversationSidebar.svelte';
  import ConversationTurnStage from '../components/ConversationTurnStage.svelte';
  import MessageOverview from '../components/MessageOverview.svelte';
  import Composer from '../components/Composer.svelte';
  import { createTransport } from '../lib/transport.js';
  import { downloadConversationMarkdown } from '../lib/export.js';
import { loadConversationIndex, saveConversationIndex, loadUserSettings, saveUserSettings, DEFAULT_SETTINGS, THINKING_LEVELS } from '../lib/storage.js';
  import {
    buildConversationView,
    contentToText,
    consumeSse,
    conversationIdFromPayload,
    conversationIdFromUrl,
    conversationThinkingLevel,
    decodeCaptureBody,
    extractConversationItems,
    findConversationPayload,
    findMessageEvents,
    fingerprintCapture,
    getToolMessageInfo,
    groupConversationTurns,
    parseJson,
    parseWebMobilePartialConversation,
    stepConversationBranch,
    upsertLiveMessage,
  } from '../../core.js';

  const transport = createTransport();
  let status = $state({ bridgeReady: false, captureMode: null });
  let conversationMap = $state(new Map());
  let payloads = $state(new Map());
  let terminals = $state(new Map());
  let liveMessages = $state(new Map());
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
  let sidebarOpen = $state(false);
  let overviewOpen = $state(false);
  let activeTurnIndex = $state(0);
  let saveTimer = null;
  let sendTimer = null;
  let navigationTimer = null;
  let userSettings = $state({ ...DEFAULT_SETTINGS });
  let thinkingLevelOverride = $state(null);
  let workStates = $state(new Map());
  let newChatWorkState = $state('idle');
  const MAX_CAPTURE_BUFFER = 20 * 1024 * 1024;
  const MAX_CACHED_PAYLOADS = 24;
  const sseBuffers = new Map();
  const xhrBuffers = new Map();
  const recentFingerprints = new Map();

  const conversations = $derived([...conversationMap.values()].sort((a, b) => (Number(b.update_time) || 0) - (Number(a.update_time) || 0)));
  const currentPayload = $derived(currentConversationId ? payloads.get(currentConversationId) : null);
  const currentHasRenderableContent = $derived(Boolean(
    currentConversationId && hasRenderableConversationContent(currentConversationId)
  ));
  const currentMeta = $derived(currentConversationId ? conversationMap.get(currentConversationId) : null);
  const displayConversationId = $derived(currentConversationId);
  const messages = $derived.by(() => {
    const id = displayConversationId;
    if (!id) return [];
    const payload = payloads.get(id) || null;
    const live = liveMessages.get(id) || [];
    const liveRows = live.filter(Boolean);
    const liveById = new Map(liveRows.map((item) => [item.id, item]));
    const liveIds = new Set(liveRows.map((item) => item.id));
    let rows = payload
      ? buildConversationView(payload, terminals.get(id)).filter((row) => !liveIds.has(row.id))
      : [];
    rows = rows.map((row) => liveById.has(row.id) ? { ...row, ...liveById.get(row.id) } : row);
    if (pendingUser && pendingUser.conversationId === id) rows.push(pendingUser.message);
    for (const item of liveRows) if (!liveById.has(item.id) || !rows.some((row) => row.id === item.id)) rows.push(item);
    // De-duplicate by id while keeping order; guard against overlapping graph
    // and live captures of the same message.
    const seen = new Set();
    rows = rows.filter((row) => {
      const key = row?.id || row?.nodeId;
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      return true;
    });
    return rows;
  });
  const turns = $derived(groupConversationTurns(messages));
  const liveConnected = $derived(status.bridgeReady && status.captureMode === 'page');
  const statusState = $derived(status.bridgeError ? 'error' : (liveConnected ? 'online' : 'offline'));
  const statusLabel = $derived(status.bridgeError ? '连接失败' : (liveConnected ? (status.takeover === false ? '已连接' : '已接管') : '连接中'));
  const conversationPending = $derived(Boolean(currentConversationId && !currentHasRenderableContent));
  const conversationTimedOut = $derived(Boolean(conversationPending && navigationTimedOutId === currentConversationId));
  const conversationWorkState = $derived(
    sendInFlight
      ? 'working'
      : (currentConversationId ? (workStates.get(currentConversationId) || 'idle') : newChatWorkState)
  );
  const conversationThinkingDepth = $derived.by(() => {
    const payload = currentConversationId ? payloads.get(currentConversationId) : null;
    return payload ? conversationThinkingLevel(payload) : null;
  });
  const effectiveThinkingLevel = $derived(
    thinkingLevelOverride ?? conversationThinkingDepth?.level ?? userSettings.thinkingLevel ?? 3
  );
  // Test observability mirror: smoke/live harnesses read this instead of
  // polling internals. Updated only when derived state actually changes.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const live = currentConversationId ? liveMessages.get(currentConversationId) || [] : [];
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
    transport.start();
    restoreIndex();
    restoreSettings();
    return () => {
      unsubscribe?.();
      transport.stop();
      clearTimeout(saveTimer);
      clearTimeout(sendTimer);
      clearTimeout(navigationTimer);
      sseBuffers.clear();
      xhrBuffers.clear();
    };
  });

  async function restoreIndex() {
    try {
      const items = await loadConversationIndex();
      conversationMap = new Map(items.filter((item) => item?.id).map((item) => [item.id, normalizeConversationMeta(item)]));
    } catch {
      setComposerStatus('无法读取本地会话索引；当前聊天仍可正常使用', true);
    }
  }

  async function restoreSettings() {
    try {
      userSettings = await loadUserSettings();
    } catch {
      userSettings = { ...DEFAULT_SETTINGS };
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
    else if (message.type === 'page-stream-status') {
      const id = message.conversationId || currentConversationId;
      if (message.state === 'working') setConversationWorkState(id, 'working');
      else if (message.state === 'idle') setConversationWorkState(id, 'idle');
    }
    else if (message.type === 'page-location') handlePageLocation(message.url);
    else if (message.type === 'canonical-capture') handleCapture(message);
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
      const now = Date.now();
      if (recentFingerprints.has(fingerprint) && now - recentFingerprints.get(fingerprint) < 2500) return;
      recentFingerprints.set(fingerprint, now);
      if (recentFingerprints.size > 160) {
        for (const [key, seenAt] of recentFingerprints) if (now - seenAt > 5000) recentFingerprints.delete(key);
      }
    }

    const isEventStream = capture.transport === 'sse' || String(capture.mimeType || '').includes('text/event-stream');
    if (isEventStream) {
      const key = capture.requestId || capture.url || 'sse';
      const { rest, frames } = consumeSse(sseBuffers.get(key) || '', text, capture.phase === 'complete');
      if (capture.phase === 'complete') {
        sseBuffers.delete(key);
        if (capture.graceful) {
          setConversationWorkState(conversationIdFromUrl(capture.url || '') || currentConversationId, 'idle');
        }
      } else {
        sseBuffers.set(key, rest);
      }
      for (const frame of frames) {
        if (frame.data === '[DONE]') {
          setConversationWorkState(conversationIdFromUrl(capture.url || '') || currentConversationId, 'idle');
        } else if (frame.json) {
          processStructured(frame.json, capture.url || '');
        }
      }
      return;
    }

    if (capture.transport === 'xhr') {
      const key = capture.requestId || capture.url || 'xhr';
      const combined = `${xhrBuffers.get(key) || ''}${text}`;
      if (combined.length > MAX_CAPTURE_BUFFER) {
        xhrBuffers.delete(key);
        setComposerStatus('一个过大的页面响应已跳过，避免 SlimGPT 占用过多内存', true);
        return;
      }
      if (capture.phase !== 'complete') {
        xhrBuffers.set(key, combined);
        return;
      }
      xhrBuffers.delete(key);
      processCaptureText(combined, capture.url || '', capture.transport, capture.mimeType);
      return;
    }

    processCaptureText(text, capture.url || '', capture.transport, capture.mimeType);
  }

  function processCaptureText(text, url, transport, mimeType = '') {
    if (
      String(mimeType).includes('text/vnd.openai.web-mobile-partial+html') ||
      text.includes('data-web-mobile-dpu-frame')
    ) {
      const conversation = parseWebMobilePartialConversation(text);
      if (conversation?.id) {
        acceptConversationPayload(conversation.id, conversation);
        return;
      }
    }

    const json = parseJson(text);
    if (json) {
      processStructured(json, url);
      return;
    }
    if (transport === 'websocket' || text.includes('data:')) {
      for (const frame of consumeSse('', text, true).frames) if (frame.json) processStructured(frame.json, url);
    }
  }

  function processStructured(value, url) {
    const conversation = findConversationPayload(value);
    if (conversation) {
      const id = conversationIdFromPayload(conversation, url) || currentConversationId;
      if (id) acceptConversationPayload(id, conversation);
      return;
    }

    const items = extractConversationItems(value);
    if (items.length) {
      const next = new Map(conversationMap);
      for (const item of items) {
        if (!item?.id) continue;
        next.set(item.id, normalizeConversationMeta(item, next.get(item.id)));
      }
      conversationMap = next;
      schedulePersist();
    }

    for (const event of findMessageEvents(value)) {
      const id = event.conversationId || conversationIdFromUrl(url) || currentConversationId;
      if (!id) continue;
      const next = new Map(liveMessages);
      next.set(id, upsertLiveMessage(next.get(id) || [], event.message));
      liveMessages = next;
      updateWorkStateFromMessage(id, event.message);
      updateConversationPreviewFromMessage(id, event.message);
      if (id === currentConversationId) {
        if (hasRenderableConversationContent(id) && (loadingConversationId === id || navigationTimedOutId === id)) {
          finishConversationLoading();
        }
        reconcilePending(event.message);
      }
    }
  }

  function acceptConversationPayload(id, payload) {
    const nextPayloads = new Map(payloads);
    const nextTerminals = new Map(terminals);
    const nextLive = new Map(liveMessages);
    
    nextPayloads.set(id, payload);
    nextTerminals.set(id, payload.current_node);
    nextLive.set(id, []);

    // Evict oldest cached conversation trees if exceeding limit
    while (nextPayloads.size > MAX_CACHED_PAYLOADS) {
      const oldestId = nextPayloads.keys().next().value;
      if (oldestId === id || oldestId === currentConversationId) break;
      nextPayloads.delete(oldestId);
      nextTerminals.delete(oldestId);
      nextLive.delete(oldestId);
    }

    payloads = nextPayloads;
    terminals = nextTerminals;
    liveMessages = nextLive;
    const pageConversationId = conversationIdFromUrl(status.pageUrl || '');
    if (id === currentConversationId || id === pageConversationId || (!currentConversationId && !pageConversationId)) {
      if (!currentConversationId && newChatWorkState === 'working') {
        setConversationWorkState(id, 'working');
        newChatWorkState = 'idle';
      }
      currentConversationId = id;
    }
    updateWorkStateFromPayload(id, payload);
    const next = new Map(conversationMap);
    const previous = next.get(id) || {};
    const details = conversationDetailsFromPayload(payload, previous);
    const pagePath = (() => {
      try { return new URL(status.pageUrl || 'https://chatgpt.com/').pathname; } catch { return ''; }
    })();
    next.set(id, normalizeConversationMeta({
      id,
      title: payload.title || previous.title || 'Untitled',
      create_time: payload.create_time || previous.create_time,
      update_time: payload.update_time || Date.now() / 1000,
      route: payload.metadata?.source === 'web-mobile-partial' || pagePath.startsWith('/uc/') ? 'uc' : (previous.route || 'c'),
      last: details.last,
      model: details.model,
    }, previous));
    conversationMap = next;
    if (loadingConversationId === id) finishConversationLoading();
    reconcilePendingAgainstPayload(payload);
    schedulePersist();
  }

  function handlePageLocation(url) {
    if (!url) return;
    status = { ...status, pageUrl: url };
    const id = conversationIdFromUrl(url);
    if (id) {
      if (id !== currentConversationId) {
        currentConversationId = id;
        thinkingLevelOverride = null;
        startConversationLoading(id);
      }
    }
    else if (url.startsWith('https://chatgpt.com/')) {
      currentConversationId = null;
      thinkingLevelOverride = null;
      finishConversationLoading();
    }
  }

  function selectConversation(id) {
    if (sendInFlight) {
      setComposerStatus('当前消息仍在提交，请等待确认后再切换对话', true);
      return;
    }
    if (!id || (id === currentConversationId && payloads.has(id))) {
      sidebarOpen = false;
      overviewOpen = false;
      return;
    }
    currentConversationId = id;
    thinkingLevelOverride = null;
    startConversationLoading(id);
    sidebarOpen = false;
    overviewOpen = false;
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
    currentConversationId = null;
    thinkingLevelOverride = null;
    newChatWorkState = 'idle';
    finishConversationLoading();
    pendingUser = null;
    sidebarOpen = false;
    overviewOpen = false;
    if (transport.supportsLiveChat) {
      transport.send({ type: 'new-chat', thinkingLevel: userSettings.thinkingLevel });
    }
  }

  function startConversationLoading(id) {
    clearTimeout(navigationTimer);
    navigationTimer = null;
    navigationTimedOutId = null;
    if (!id || hasRenderableConversationContent(id)) {
      loadingConversationId = null;
      return;
    }
    loadingConversationId = id;
    navigationTimer = setTimeout(() => {
      if (loadingConversationId !== id || hasRenderableConversationContent(id)) return;
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
    if (payloads.has(id)) return true;
    const live = liveMessages.get(id) || [];
    return live.some((message) => String(message?.text || '').trim());
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
    if (currentPayload && currentConversationId && terminals.get(currentConversationId) !== currentPayload.current_node) {
      setComposerStatus('当前正在只读查看其他分支；请切回最新分支，或在官方界面继续该分支', true);
      return;
    }
    if (sendInFlight) {
      setComposerStatus('上一条消息仍在提交；SlimGPT 不会重复发送', true);
      return;
    }
    const stamp = Date.now();
    const commandId = crypto.randomUUID();
    const thinkingLevel = options?.thinkingLevel || effectiveThinkingLevel;
    const levelObj = THINKING_LEVELS.find((item) => item.level === thinkingLevel) || THINKING_LEVELS[2];
    sendInFlight = true;
    pendingCommandId = commandId;
    pendingUser = {
      conversationId: currentConversationId,
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
    setConversationWorkState(currentConversationId, 'working');
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
      pendingCommandId = null;
      sendInFlight = false;
      pendingUser = null;
      setConversationWorkState(currentConversationId, 'idle');
      setComposerStatus('官方输入框未确认提交；内容仍保留，请检查官方界面后手动决定是否重试', true);
    }, 14_000);
    setComposerStatus('正在通过 ChatGPT 页面发送；断线后不会自动重发');
  }

  function handleComposerResult(message) {
    if (message.commandId && pendingCommandId && message.commandId !== pendingCommandId) return;
    clearTimeout(sendTimer);
    sendTimer = null;
    sendInFlight = false;
    pendingCommandId = null;
    if (!message.ok) {
      pendingUser = null;
      setConversationWorkState(currentConversationId, 'idle');
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
    if (pendingUser && draft.trim() === pendingUser.text.trim()) draft = '';
    setComposerStatus('消息已发送（官方已确认）');
  }

  function reconcilePending(rawMessage) {
    if (!pendingUser || rawMessage?.author?.role !== 'user') return;
    const text = rawMessage?.content?.parts?.filter((part) => typeof part === 'string').join('\n') || '';
    if (text.trim() === pendingUser.text.trim()) pendingUser = null;
  }

  function reconcilePendingAgainstPayload(payload) {
    if (!pendingUser || !payload?.mapping) return;
    for (const node of Object.values(payload.mapping)) {
      if (node?.message?.author?.role !== 'user') continue;
      const text = (node.message.content?.parts || []).filter((part) => typeof part === 'string').join('\n');
      if (text.trim() === pendingUser.text.trim()) {
        pendingUser = null;
        return;
      }
    }
  }

  function setConversationWorkState(id, state) {
    if (!id) {
      newChatWorkState = state;
      return;
    }
    if (workStates.get(id) === state) return;
    workStates = new Map(workStates).set(id, state);
  }

  function updateWorkStateFromMessage(id, message) {
    const role = message?.author?.role || message?.role;
    if (role !== 'assistant') return;
    const statusValue = String(message?.status || '');
    if (message?.end_turn === true || statusValue === 'finished_successfully' || statusValue === 'finished' || statusValue === 'failed') {
      setConversationWorkState(id, 'idle');
      return;
    }
    if (message?.end_turn === false || statusValue === 'in_progress' || statusValue === 'thinking' || statusValue === 'live') {
      setConversationWorkState(id, 'working');
    }
  }

  function updateWorkStateFromPayload(id, payload) {
    const rows = buildConversationView(payload, payload?.current_node);
    const assistant = [...rows].reverse().find((message) => message?.role === 'assistant');
    if (!assistant) return;
    updateWorkStateFromMessage(id, {
      role: assistant.role,
      status: assistant.status,
      end_turn: assistant.endTurn,
    });
  }

  function stepBranch(nodeId, delta) {
    if (!currentPayload || !currentConversationId) return;
    const terminal = stepConversationBranch(currentPayload, nodeId, delta);
    terminals = new Map(terminals).set(currentConversationId, terminal);
    liveMessages = new Map(liveMessages).set(currentConversationId, []);
    if (terminal !== currentPayload.current_node) setComposerStatus('正在只读查看其他分支；发送前请切回最新分支');
    else setComposerStatus('已回到最新分支');
  }

  function setComposerStatus(text, error = false) {
    composerStatus = text;
    composerError = error;
  }

  function schedulePersist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await saveConversationIndex(conversations);
      } catch {
        setComposerStatus('无法保存本地会话索引；当前聊天不受影响', true);
      }
    }, 500);
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
      contentToText(rawMessage.content),
      metadata.model_slug || metadata.default_model_slug || metadata.model || '',
    );
  }

  function updateConversationPreview(id, text, model = '') {
    const previous = conversationMap.get(id);
    if (!previous) return;
    const preview = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!preview && !model) return;
    const next = new Map(conversationMap);
    next.set(id, normalizeConversationMeta({
      ...previous,
      last: preview || previous.last,
      model: model || previous.model,
      update_time: Date.now() / 1000,
    }, previous));
    conversationMap = next;
    schedulePersist();
  }

  function selectOverviewMessage(index) {
    activeTurnIndex = Math.max(0, Math.min(turns.length - 1, Number(index) || 0));
    overviewOpen = false;
  }

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    if (sidebarOpen) overviewOpen = false;
  }

  function toggleOverview() {
    overviewOpen = !overviewOpen;
    if (overviewOpen) sidebarOpen = false;
  }

  function closeMobilePanels() {
    sidebarOpen = false;
    overviewOpen = false;
  }
</script>

<Page class="slimgpt-page">
  <Navbar class="mobile-navbar">
    <NavLeft>
      <Button small onClick={toggleSidebar}>☰</Button>
    </NavLeft>
    <div class="mobile-title">
      <span>{currentMeta?.title || 'SlimGPT'}</span>
      <span
        class="mobile-work-state"
        class:working={conversationWorkState === 'working'}
        role="status"
        aria-label={conversationWorkState === 'working' ? '对话工作中' : '对话已停止'}
        title={conversationWorkState === 'working' ? '工作中' : '已停止'}
      ></span>
    </div>
    <NavRight>
      <Button small onClick={toggleOverview}>概览</Button>
    </NavRight>
  </Navbar>

  <div class="app-shell">
    <div class:open={sidebarOpen} class="sidebar-host">
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
            <span class="work-dot" class:working={conversationWorkState === 'working'} aria-hidden="true"></span>
            {conversationWorkState === 'working' ? '工作中' : '已停止'}
          </span>
          <Button small onClick={() => transport.openOfficial(currentConversationId)}>暂时显示官方界面</Button>
        </div>
      </header>

      <section class="message-stage">
        {#if turns.length}
          <ConversationTurnStage
            {turns}
            activeIndex={activeTurnIndex}
            conversationKey={displayConversationId || 'new'}
            onActiveChange={(index) => activeTurnIndex = index}
            onBranch={stepBranch}
          />
        {:else if !conversationPending}
          <div class="empty-state">
            <div class="empty-logo">S</div>
            <h2>更轻的 ChatGPT 界面</h2>
            <p>登录、网络和发送仍由当前 ChatGPT 页面处理；SlimGPT 负责会话呈现，并在覆盖显示时暂停官方界面的布局和绘制。</p>
          </div>
        {/if}

        {#if conversationPending}
          <div class="conversation-loading" role="status" aria-live="polite">
            <span class="conversation-loading-spinner" aria-hidden="true"></span>
            <strong>{conversationTimedOut ? '对话暂未加载' : '正在加载对话'}</strong>
            <span>{conversationTimedOut ? '可重新点击侧栏中的该会话重试' : (currentMeta?.title || '正在同步 ChatGPT 会话…')}</span>
          </div>
        {/if}

        {#if conversationWorkState === 'working' && !conversationPending}
          <div class="work-indicator" role="status" aria-live="polite">
            <span class="work-indicator-spinner" aria-hidden="true"></span>
            <span>对话进行中：正在生成或等待官方页面返回…</span>
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

    <div class:open={overviewOpen} class="overview-host">
      <MessageOverview
        {turns}
        activeIndex={activeTurnIndex}
        onSelect={selectOverviewMessage}
      />
    </div>

    {#if sidebarOpen || overviewOpen}
      <button class="sidebar-scrim" aria-label="关闭侧栏" onclick={closeMobilePanels}></button>
    {/if}
  </div>
</Page>
