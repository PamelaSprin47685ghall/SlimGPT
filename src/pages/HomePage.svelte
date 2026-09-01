<script>
  import { onMount } from 'svelte';
  import { Button, Navbar, NavLeft, NavRight, Page } from 'framework7-svelte';
  import ConversationSidebar from '../components/ConversationSidebar.svelte';
  import VirtualMessageList from '../components/VirtualMessageList.svelte';
  import Composer from '../components/Composer.svelte';
  import { createTransport } from '../lib/transport.js';
  import { loadConversationIndex, saveConversationIndex } from '../lib/storage.js';
  import {
    buildConversationView,
    consumeSse,
    conversationIdFromPayload,
    conversationIdFromUrl,
    decodeCaptureBody,
    extractConversationItems,
    findConversationPayload,
    findMessageEvents,
    fingerprintCapture,
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
  let captures = $state(0);
  let composerStatus = $state('');
  let composerError = $state(false);
  let draft = $state('');
  let sendInFlight = $state(false);
  let pendingCommandId = null;
  let sidebarOpen = $state(false);
  let followTail = $state(false);
  let saveTimer = null;
  let sendTimer = null;
  const MAX_CAPTURE_BUFFER = 20 * 1024 * 1024;
  const sseBuffers = new Map();
  const xhrBuffers = new Map();
  const recentFingerprints = new Map();

  const conversations = $derived([...conversationMap.values()].sort((a, b) => (Number(b.update_time) || 0) - (Number(a.update_time) || 0)));
  const currentPayload = $derived(currentConversationId ? payloads.get(currentConversationId) : null);
  const currentMeta = $derived(currentConversationId ? conversationMap.get(currentConversationId) : null);
  const messages = $derived.by(() => {
    let rows = currentPayload ? buildConversationView(currentPayload, terminals.get(currentConversationId)) : [];
    const live = currentConversationId ? liveMessages.get(currentConversationId) || [] : [];
    const liveById = new Map(live.map((item) => [item.id, item]));
    const rowIds = new Set(rows.map((row) => row.id));
    rows = rows.map((row) => liveById.has(row.id) ? { ...row, ...liveById.get(row.id) } : row);
    if (pendingUser && (!pendingUser.conversationId || pendingUser.conversationId === currentConversationId)) rows.push(pendingUser.message);
    for (const item of live) if (!rowIds.has(item.id)) rows.push(item);
    return rows;
  });
  const liveConnected = $derived(status.bridgeReady && status.captureMode === 'page');
  const statusState = $derived(status.bridgeError ? 'error' : (liveConnected ? 'online' : 'offline'));
  const statusLabel = $derived(status.bridgeError ? '连接失败' : (liveConnected ? (status.takeover === false ? '已连接' : '已接管') : '连接中'));

  onMount(() => {
    let unsubscribe = transport.subscribe(handleTransportMessage);
    transport.start();
    restoreIndex();
    return () => {
      unsubscribe?.();
      transport.stop();
      clearTimeout(saveTimer);
      clearTimeout(sendTimer);
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

  function handleTransportMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'status') {
      const bridgeError = message.bridgeReady === true ? false : (message.bridgeError ?? status.bridgeError);
      status = { ...status, ...message, bridgeError };
    }
    else if (message.type === 'takeover-state') status = { ...status, takeover: message.active };
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
      if (capture.phase === 'complete') sseBuffers.delete(key); else sseBuffers.set(key, rest);
      for (const frame of frames) if (frame.json && frame.data !== '[DONE]') processStructured(frame.json, capture.url || '');
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
      if (id === currentConversationId) {
        reconcilePending(event.message);
        pulseFollowTail();
      }
    }
  }

  function acceptConversationPayload(id, payload) {
    payloads = new Map(payloads).set(id, payload);
    terminals = new Map(terminals).set(id, payload.current_node);
    liveMessages = new Map(liveMessages).set(id, []);
    const pageConversationId = conversationIdFromUrl(status.pageUrl || '');
    if (id === currentConversationId || id === pageConversationId || (!currentConversationId && !pageConversationId)) {
      currentConversationId = id;
    }
    const next = new Map(conversationMap);
    const previous = next.get(id) || {};
    const pagePath = (() => {
      try { return new URL(status.pageUrl || 'https://chatgpt.com/').pathname; } catch { return ''; }
    })();
    next.set(id, normalizeConversationMeta({
      id,
      title: payload.title || previous.title || 'Untitled',
      create_time: payload.create_time || previous.create_time,
      update_time: payload.update_time || Date.now() / 1000,
      route: payload.metadata?.source === 'web-mobile-partial' || pagePath.startsWith('/uc/') ? 'uc' : (previous.route || 'c'),
    }, previous));
    conversationMap = next;
    reconcilePendingAgainstPayload(payload);
    schedulePersist();
    pulseFollowTail();
  }

  function handlePageLocation(url) {
    if (!url) return;
    const id = conversationIdFromUrl(url);
    if (id) currentConversationId = id;
    else if (url.startsWith('https://chatgpt.com/')) currentConversationId = null;
  }

  function selectConversation(id) {
    if (sendInFlight) {
      setComposerStatus('当前消息仍在提交，请等待确认后再切换对话', true);
      return;
    }
    currentConversationId = id;
    sidebarOpen = false;
    if (transport.supportsLiveChat) {
      const route = conversationMap.get(id)?.route === 'uc' ? 'uc' : 'c';
      transport.send({ type: 'navigate-conversation', conversationId: id, route });
      setComposerStatus('正在让当前 ChatGPT 页面打开该对话…');
    }
  }

  function newChat() {
    if (sendInFlight) {
      setComposerStatus('当前消息仍在提交，请等待确认后再新建对话', true);
      return;
    }
    currentConversationId = null;
    pendingUser = null;
    sidebarOpen = false;
    if (transport.supportsLiveChat) transport.send({ type: 'new-chat' });
  }

  function sendMessage(text) {
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
    transport.send({ type: 'send-message', commandId, text });
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      if (pendingCommandId !== commandId) return;
      pendingCommandId = null;
      sendInFlight = false;
      pendingUser = null;
      setComposerStatus('官方输入框未确认提交；内容仍保留，请检查官方界面后手动决定是否重试', true);
    }, 8_000);
    setComposerStatus('正在通过 ChatGPT 页面发送；断线后不会自动重发');
    pulseFollowTail();
  }

  function handleComposerResult(message) {
    if (message.commandId && pendingCommandId && message.commandId !== pendingCommandId) return;
    clearTimeout(sendTimer);
    sendTimer = null;
    sendInFlight = false;
    pendingCommandId = null;
    if (!message.ok) {
      pendingUser = null;
      const details = {
        'composer-not-found': '找不到官方输入框：请检查当前 ChatGPT 页面是否已登录或页面结构是否变化',
        'composer-rejected-input': '官方输入框没有接受这段文字；内容仍保留，未发送',
        'send-control-not-ready': '官方发送按钮未就绪；内容仍保留，未发送',
        'send-in-progress': '官方页面仍在处理上一条消息；本条未发送',
        'empty-message': '消息为空，未发送',
      };
      const detail = details[message.error] || `发送失败：${message.error || 'unknown'}`;
      setComposerStatus(detail, true);
      return;
    }
    if (pendingUser && draft.trim() === pendingUser.text.trim()) draft = '';
    setComposerStatus('消息已提交');
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

  function pulseFollowTail() {
    followTail = false;
    queueMicrotask(() => followTail = true);
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
    };
  }
</script>

<Page class="slimgpt-page">
  <Navbar class="mobile-navbar">
    <NavLeft>
      <Button small onClick={() => sidebarOpen = !sidebarOpen}>☰</Button>
    </NavLeft>
    <div class="mobile-title">{currentMeta?.title || 'SlimGPT'}</div>
    <NavRight>
      <Button small onClick={() => transport.openOfficial(currentConversationId)}>官方</Button>
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
        onShowOfficial={() => transport.send({ type: 'open-official', conversationId: currentConversationId })}
        onNewChat={newChat}
        onSelect={selectConversation}
      />
    </div>
    {#if sidebarOpen}<button class="sidebar-scrim" aria-label="关闭侧栏" onclick={() => sidebarOpen = false}></button>{/if}

    <main class="chat-pane">
      <header class="desktop-chat-header">
        <div class="header-title-group">
          <strong>{currentMeta?.title || (currentConversationId ? '加载中的对话' : '新对话')}</strong>
          <span>{currentConversationId ? 'ChatGPT 会话' : 'SlimGPT · 轻量模式'}</span>
        </div>
        <Button small onClick={() => transport.openOfficial(currentConversationId)}>暂时显示官方界面</Button>
      </header>

      <section class="message-stage">
        {#if messages.length}
          <VirtualMessageList
            {messages}
            conversationKey={currentConversationId || 'new'}
            {followTail}
            onBranch={stepBranch}
          />
        {:else}
          <div class="empty-state">
            <div class="empty-logo">S</div>
            <h2>更轻的 ChatGPT 界面</h2>
            <p>登录、网络和发送仍由当前 ChatGPT 页面处理；SlimGPT 负责会话呈现，并在覆盖显示时暂停官方界面的布局和绘制。</p>
          </div>
        {/if}
      </section>

      <Composer
        bind:value={draft}
        disabled={!transport.supportsLiveChat || !status.bridgeReady}
        busy={sendInFlight}
        status={composerStatus}
        error={composerError}
        onSend={sendMessage}
      />
    </main>
  </div>
</Page>
