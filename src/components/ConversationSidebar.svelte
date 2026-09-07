<script>
  import { Button } from 'framework7-svelte';
  import { formatModelLabel } from '../lib/message-presentation.js';
  import { historySyncStatusLabel, historySyncPillLabel, isHistorySyncRetryable } from '../lib/history-sync.js';
  import {
    formatSidebarTime,
    fullSidebarDateTime,
    filterConversations,
    groupConversations,
    highlightTitle,
    isContentHit,
    buildTruncationLabel,
    getPinnedIds,
    togglePinnedId,
  } from '../lib/sidebar-helpers.js';

  let {
    conversations = [],
    currentId = null,
    loadingConversationId = null,
    navigationTimedOutId = null,
    historySyncState = null,
    statusLabel = '未连接',
    statusState = 'offline',
    captures = 0,
    cachedCount = null,
    omissionCount = 0,
    workState = 'unknown',
    sendInFlight = false,
    historyComplete = true,
    hasExportableContent = false,
    exportError = '',
    sidebarNotice = '',
    generatingIds = [],
    branchLabel = '',
    onShowOfficial = () => {},
    onExportMarkdown = () => {},
    onCopyMarkdown = () => {},
    onNewChat = () => {},
    onSelect = () => {},
    onRetryHistorySync = () => {},
    onClearNotice = () => {},
    onClearExportError = () => {},
  } = $props();

  const workLabel = $derived(
    workState === 'running'
      ? '对话执行中'
      : (workState === 'starting'
          ? '正在提交'
          : (workState === 'stopped' ? '对话已停止' : '状态未知'))
  );
  const activelyWorking = $derived(workState === 'running' || workState === 'starting');

  let query = $state('');
  let debouncedQuery = $state('');
  let searchInputRef = null;
  let pageLimit = $state(100);
  let cleanExport = $state(false);
  let copied = $state(false);
  let copyTimer = null;
  let noticeDismissTimer = null;
  let bucketEpoch = $state(Date.now());
  let pinnedIds = $state(getPinnedIds());

  $effect(() => {
    const handler = () => {
      bucketEpoch = Date.now();
    };
    window.addEventListener('focus', handler);
    document.addEventListener('visibilitychange', handler);
    return () => {
      window.removeEventListener('focus', handler);
      document.removeEventListener('visibilitychange', handler);
    };
  });

  $effect(() => {
    const raw = query;
    const timer = setTimeout(() => {
      debouncedQuery = raw;
    }, 150);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const _ = debouncedQuery;
    pageLimit = 100;
  });

  $effect(() => {
    clearTimeout(noticeDismissTimer);
    if (sidebarNotice) {
      const isErrorNotice = typeof sidebarNotice === 'string' && (sidebarNotice.includes('错误') || sidebarNotice.includes('失败'));
      if (!isErrorNotice) {
        noticeDismissTimer = setTimeout(() => {
          onClearNotice();
        }, 6000);
      }
    }
    return () => clearTimeout(noticeDismissTimer);
  });

  const searchResult = $derived(filterConversations(conversations, debouncedQuery, pageLimit, pinnedIds));
  const filtered = $derived(searchResult.visible);
  const totalMatches = $derived(searchResult.total);
  const isCapped = $derived(searchResult.isCapped);
  const grouped = $derived(groupConversations(filtered, new Date(bucketEpoch), pinnedIds));
  const hasQuery = $derived(Boolean(debouncedQuery.trim()));
  const corpusCachedCount = $derived(
    typeof cachedCount === 'number' && Number.isFinite(cachedCount)
      ? cachedCount
      : conversations.filter((c) => Boolean(c?.searchText)).length
  );
  const truncationLine = $derived(buildTruncationLabel(conversations.length, filtered.length));

  const syncPill = $derived(historySyncPillLabel(historySyncState));
  const syncFull = $derived(historySyncStatusLabel(historySyncState));
  const syncRetryable = $derived(isHistorySyncRetryable(historySyncState));
  const syncLoading = $derived(historySyncState?.state === 'loading');
  const syncIsAuthDead = $derived(
    historySyncState?.state === 'error' && (historySyncState?.status === 401 || historySyncState?.status === 403)
  );

  function handleKeydown(event) {
    if (event.key === 'Escape' && query) {
      query = '';
      debouncedQuery = '';
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && filtered.length) {
      event.preventDefault();
      handleSelect(filtered[0].id);
      return;
    }
    if (event.key === 'ArrowDown' && filtered.length) {
      event.preventDefault();
      const root = event.currentTarget?.closest?.('.conversation-sidebar');
      const first = root?.querySelector?.('.conversation-item');
      if (first) first.focus();
    }
  }

  function handleItemKeydown(event, conversationId) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const root = event.currentTarget?.closest?.('.conversation-sidebar');
      if (!root) return;
      const items = Array.from(root.querySelectorAll('.conversation-item'));
      const currentIndex = items.indexOf(event.currentTarget);
      if (currentIndex === -1) return;
      if (event.key === 'ArrowDown') {
        const nextIndex = (currentIndex + 1) % items.length;
        items[nextIndex]?.focus();
      } else {
        const prevIndex = (currentIndex - 1 + items.length) % items.length;
        items[prevIndex]?.focus();
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      handleSelect(conversationId);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (searchInputRef) {
        searchInputRef.focus();
      }
      return;
    }
  }

  function handleTogglePin(event, conversationId) {
    event.stopPropagation();
    pinnedIds = togglePinnedId(conversationId);
  }

  function formatModel(item) {
    const raw = String(item?.model || '').trim();
    if (!raw) return '';
    return formatModelLabel(raw).slice(0, 20);
  }

  function preview(item) {
    return String(item?.last || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isGenerating(item) {
    return Array.isArray(generatingIds) && generatingIds.includes(item?.id);
  }

  function exportOpts() {
    return { includeThought: !cleanExport, includeTools: !cleanExport };
  }

  async function handleCopyMarkdown() {
    try {
      const result = await onCopyMarkdown(exportOpts());
      if (result === false) return;
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; }, 2000);
    } catch {
      // HomePage surfaces the failure via exportError / composer status.
    }
  }

  function handleSelect(id) {
    if (sendInFlight) {
      // Show notice directly in sidebar
      onSelect(id);
      return;
    }
    onSelect(id);
  }
</script>

<aside class="conversation-sidebar">
  <div class="brand-row">
    <div>
      <div class="brand">SlimGPT</div>
      <div class="brand-subtitle">轻量 ChatGPT 前端</div>
    </div>
    <span class:online={statusState === 'online'} class:error={statusState === 'error'} class="status-pill">
      {statusLabel}
    </span>
  </div>

  <div class="conversation-work-state" data-state={workState} role="status">
    <span class="work-dot" class:working={activelyWorking} aria-hidden="true"></span>
    <span>{workLabel}</span>
  </div>

  <!-- Hierarchy: 新对话 is the top primary CTA with + -->
  <div class="new-chat-container">
    <button
      type="button"
      class="new-chat-primary-btn new-chat"
      class:active={currentId === null}
      disabled={sendInFlight}
      onclick={onNewChat}
      title={sendInFlight ? '正在提交消息，请等待确认后再新建对话' : '发起新对话'}
      aria-label="发起新对话"
    >
      <span class="plus-icon" aria-hidden="true">+</span>
      <span>新对话</span>
    </button>
  </div>

  {#if sidebarNotice}
    <div class="sidebar-inline-notice warning" role="alert">
      {#if typeof sidebarNotice === 'object' && sidebarNotice !== null}
        <span>{sidebarNotice.text || ''}</span>
        {#if Array.isArray(sidebarNotice.actions)}
          <span class="notice-actions">
            {#each sidebarNotice.actions as act}
              <button type="button" class="notice-action-btn" onclick={act.action}>{act.label}</button>
            {/each}
          </span>
        {/if}
      {:else}
        <span>{sidebarNotice}</span>
      {/if}
      <button type="button" class="notice-close-btn" onclick={onClearNotice} aria-label="关闭提示">×</button>
    </div>
  {/if}

  {#if exportError}
    <div class="sidebar-inline-notice error" role="alert">
      <span>{exportError}</span>
      <button type="button" class="notice-close-btn" onclick={onClearExportError} aria-label="关闭提示">×</button>
    </div>
  {/if}

  <div class="sidebar-actions">
    <div class="platform-note">
      <strong>轻量接管</strong>
      <span>登录、网络和产品能力仍由当前 ChatGPT 页面处理；SlimGPT 只负责更轻的界面。</span>
    </div>
    <Button outline small onClick={onShowOfficial}>暂时显示官方界面</Button>
    <div class="export-row">
      <Button
        outline
        small
        disabled={!hasExportableContent}
        onClick={() => onExportMarkdown(exportOpts())}
        title={!hasExportableContent ? '当前对话暂无可导出的内容' : (historyComplete ? '导出当前对话 Markdown' : '历史尚未完整，导出将包含不完整提示')}
      >
        <span>导出 Markdown · 下载</span>
        {#if !historyComplete && hasExportableContent}
          <span class="partial-badge" title="历史尚未同步完整，导出文件将标记局部不完整">部分</span>
        {/if}
      </Button>
      <Button
        outline
        small
        disabled={!hasExportableContent}
        onClick={handleCopyMarkdown}
        title={!hasExportableContent ? '当前对话暂无可复制的内容' : '复制当前对话 Markdown 到剪贴板'}
      >
        <span>{copied ? '已复制' : '复制 Markdown'}</span>
      </Button>
    </div>
    <label class="clean-export-row" title="勾选后导出与复制时省略思考过程与工具调用，仅保留纯净问答">
      <input type="checkbox" bind:checked={cleanExport} />
      <span>纯净问答</span>
    </label>
  </div>

  <label class="search-box conversation-search">
    <input
      bind:this={searchInputRef}
      bind:value={query}
      onkeydown={handleKeydown}
      placeholder="搜索会话标题或内容… (Esc 清除)"
      autocomplete="off"
    />
    {#if query}
      <button type="button" class="search-clear-icon" onclick={() => { query = ''; debouncedQuery = ''; }} aria-label="清除搜索">×</button>
    {/if}
  </label>
  {#if debouncedQuery.trim()}
    <div class="corpus-coverage-caption" role="note">
      全文检索仅覆盖已缓存的 {corpusCachedCount} 个会话标题+正文，其余仅标题
    </div>
  {/if}

  <div class="sidebar-section-title">
    <span>会话</span>
    {#if isCapped}
      <span class="count-hint" title={`共找到 ${totalMatches} 条结果，当前展示前 ${filtered.length} 条`}>
        显示 {filtered.length} / 全部 {totalMatches}
      </span>
    {:else}
      <span>{totalMatches}</span>
    {/if}
  </div>

  <div class="conversation-list">
    {#if filtered.length === 0}
      <div class="empty-list" role="status">
        {#if query.trim()}
          <div class="empty-title">未找到匹配的会话</div>
          <div class="empty-hint">没有找到包含“{query.trim()}”的对话标题或内容，可尝试其他关键词。</div>
          <button type="button" class="empty-action-btn" onclick={() => query = ''}>清除搜索词</button>
        {:else if captures === 0}
          <div class="empty-title">等待同步官方会话</div>
          <div class="empty-hint">捕获到官方会话索引后，这里会显示历史对话。请确保已在当前 ChatGPT 标签页登录。</div>
          <div class="empty-actions">
            <button type="button" class="empty-action-btn" onclick={onShowOfficial}>暂时显示官方界面</button>
            <button type="button" class="empty-action-btn" onclick={onNewChat} disabled={sendInFlight}>发起新对话</button>
          </div>
        {:else}
          <div class="empty-title">暂无历史会话</div>
          <div class="empty-hint">当前未发现历史对话记录，随时可以开始新的对话。</div>
          <button type="button" class="empty-action-btn" onclick={onNewChat} disabled={sendInFlight}>发起新对话</button>
        {/if}
      </div>
    {:else}
      {#each grouped as group (group.key)}
        <div class="sidebar-section-header" role="presentation">{group.label}</div>
        {#each group.items as conversation (conversation.id)}
          {@const isCurrent = conversation.id === currentId}
          {@const isLoading = conversation.id === loadingConversationId}
          {@const isTimedOut = conversation.id === navigationTimedOutId}
          {@const modelLabel = formatModel(conversation)}
          {@const snippet = preview(conversation)}
          {@const isCompact = !modelLabel && !snippet}
          {@const titleParts = highlightTitle(conversation.title || 'Untitled', debouncedQuery)}
          {@const contentHit = hasQuery && isContentHit(conversation, debouncedQuery)}
          {@const showBranch = isCurrent && branchLabel}
          {@const isPinned = pinnedIds.includes(conversation.id)}
          <button
            type="button"
            class:active={isCurrent}
            class:pending={isLoading}
            class:timed-out={isTimedOut}
            class:compact={isCompact}
            aria-current={isCurrent ? 'page' : undefined}
            class="conversation-item"
            onclick={() => handleSelect(conversation.id)}
            onkeydown={(e) => handleItemKeydown(e, conversation.id)}
            title={isTimedOut
              ? `${conversation.title || 'Untitled'}（加载超时，点击重试）`
              : ((conversation.title || 'Untitled') + (showBranch ? `（${branchLabel}）` : ''))}
          >
            <span class="conversation-item-topline">
              <span class="conversation-title">{#each titleParts as part}{#if part.mark}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>
              {#if showBranch}
                <span class="branch-badge" title="正在查看历史分支（只读）">[{branchLabel}]</span>
              {/if}
              {#if isGenerating(conversation) && !isLoading}
                <span class="pulse-dot" role="img" aria-label="后台生成中" title="后台生成中"></span>
              {/if}
              {#if contentHit}
                <span class="body-hit-badge" title="正文命中搜索词">正文命中</span>
              {/if}
              {#if isLoading}
                <span class="row-spinner" aria-label="正在加载"></span>
              {:else if isTimedOut}
                <span class="retry-pill" title="加载超时，点击重试">重试</span>
              {/if}
              <span
                role="button"
                tabindex="0"
                class="pin-toggle-btn"
                class:pinned={isPinned}
                aria-pressed={isPinned}
                title={isPinned ? '取消置顶' : '置顶'}
                onclick={(e) => handleTogglePin(e, conversation.id)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleTogglePin(e, conversation.id); } }}
              >
                {isPinned ? '★' : '☆'}
              </span>
              <span
                class="conversation-time"
                title={fullSidebarDateTime(conversation.update_time || conversation.updatedAt)}
              >
                {formatSidebarTime(conversation.update_time || conversation.updatedAt)}
              </span>
            </span>
            {#if !isCompact}
              <span class="conversation-item-bottomline">
                {#if modelLabel}
                  <span class="conversation-model" title={conversation.model || ''}>{modelLabel}</span>
                {/if}
                {#if snippet}
                  <span class="conversation-preview" title={snippet}>
                    {snippet}
                  </span>
                {/if}
              </span>
            {/if}
          </button>
        {/each}
      {/each}
      {#if isCapped}
        <div class="load-more-container">
          <button type="button" class="load-more-btn" onclick={() => pageLimit += 50}>
            加载更多 (+50)
          </button>
        </div>
      {/if}
    {/if}
  </div>

  <footer class="sidebar-footer">
    <div class="index-status-line">
      {#if conversations.length}
        <span class="captures-count" title={`共 ${conversations.length} 个会话`}>
          {truncationLine}{#if typeof cachedCount === 'number' && cachedCount > 0} · 缓存 {cachedCount}/24{/if}
        </span>
      {:else}
        <span class="captures-count">等待同步会话列表</span>
      {/if}
      {#if omissionCount > 0}
        <span class="ledger-omissions-note" title={`本地暂存省略 ${omissionCount} 项`}>省略 {omissionCount} 项</span>
      {/if}
    </div>
    {#if currentId}
      <div class="active-history-row">
        {#if syncPill}
          <span class="sync-label" class:sync-error={historySyncState?.state === 'error'} title={syncFull}>
            当前对话历史：{syncPill}
          </span>
        {:else}
          <span class="sync-label" title="正在同步当前对话历史">当前对话历史：同步中…</span>
        {/if}
        {#if syncIsAuthDead}
          <button
            type="button"
            class="refresh-history-btn auth-redirect"
            onclick={onShowOfficial}
            title="去官方界面登录以恢复完整历史同步"
          >
            去官方界面登录
          </button>
        {:else}
        <button
          type="button"
          class="refresh-history-btn"
          disabled={syncLoading || !statusState.startsWith('online') && statusState !== 'online'}
          onclick={onRetryHistorySync}
          title={syncLoading ? '正在同步…' : '刷新历史'}
        >
          {syncLoading ? '同步中…' : '刷新历史'}
        </button>
        {/if}
      </div>
    {/if}
    <div class="footer-security-note">登录凭据不会离开 ChatGPT 页面</div>
  </footer>
</aside>

<style>
  .empty-title {
    font-weight: 600;
    color: var(--slim-text, inherit);
    margin-bottom: 4px;
  }
  .empty-hint {
    margin-bottom: 10px;
  }
  .empty-actions {
    display: flex;
    gap: 8px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .empty-action-btn {
    display: inline-block;
    padding: 4px 10px;
    font-size: 11px;
    border: 1px solid var(--slim-line);
    border-radius: 6px;
    background: var(--slim-soft);
    color: var(--f7-theme-color, #4facfe);
    cursor: pointer;
  }
  .empty-action-btn:hover:not(:disabled) {
    background: var(--slim-surface);
  }
  .empty-action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .new-chat-container {
    margin: 8px 0 10px;
  }
  .new-chat-primary-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    height: 38px;
    border: 1px solid var(--f7-theme-color, #22735e);
    border-radius: 9px;
    background: color-mix(in srgb, var(--f7-theme-color, #22735e) 15%, var(--slim-soft));
    color: var(--f7-theme-color, #22735e);
    font-size: 13.5px;
    font-weight: 650;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
  }
  .new-chat-primary-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--f7-theme-color, #22735e) 25%, var(--slim-soft));
  }
  .new-chat-primary-btn.active {
    background: var(--f7-theme-color, #22735e);
    color: #ffffff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  }
  .new-chat-primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .plus-icon {
    font-size: 17px;
    line-height: 1;
    font-weight: 700;
  }
  .sidebar-inline-notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 6px 10px;
    margin-bottom: 8px;
    border-radius: 8px;
    font-size: 11px;
    line-height: 1.35;
  }
  .notice-actions {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .notice-action-btn {
    background: var(--slim-surface, #ffffff);
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 10.5px;
    font-weight: 600;
    color: inherit;
    cursor: pointer;
  }
  .notice-action-btn:hover {
    opacity: 0.85;
  }
  .sidebar-inline-notice.warning {
    background: var(--slim-warning-bg, rgba(232, 201, 138, 0.15));
    border: 1px solid var(--slim-warning, #b87b14);
    color: var(--slim-warning, #b87b14);
  }
  .sidebar-inline-notice.error {
    background: color-mix(in srgb, var(--slim-danger, #e74c3c) 15%, transparent);
    border: 1px solid var(--slim-danger, #e74c3c);
    color: var(--slim-danger, #e74c3c);
  }
  .notice-close-btn {
    background: none;
    border: none;
    font-size: 14px;
    cursor: pointer;
    color: inherit;
    padding: 0 2px;
    line-height: 1;
  }
  .export-btn-wrap {
    width: 100%;
  }
  .export-row {
    display: flex;
    gap: 8px;
  }
  .export-row > :global(*) {
    flex: 1;
  }
  .clean-export-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: 11px;
    color: var(--slim-muted);
    cursor: pointer;
    user-select: none;
  }
  .clean-export-row input {
    accent-color: var(--f7-theme-color, #22735e);
  }
  .sidebar-export-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--slim-line);
    border-radius: 6px;
    background: var(--slim-soft);
    color: var(--slim-text);
    font-size: 11.5px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .sidebar-export-btn:hover:not(:disabled) {
    background: var(--slim-surface);
    border-color: var(--f7-theme-color);
  }
  .sidebar-export-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .partial-badge {
    padding: 1px 4px;
    border-radius: 4px;
    font-size: 9px;
    background: var(--slim-warning-bg, rgba(232, 201, 138, 0.2));
    color: var(--slim-warning, #b87b14);
    border: 1px solid var(--slim-warning, #b87b14);
  }
  .search-clear-icon {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    font-size: 14px;
    color: var(--slim-muted);
    cursor: pointer;
    padding: 0 4px;
  }
  .corpus-coverage-caption {
    font-size: 9.5px;
    color: var(--slim-muted);
    padding: 2px 4px 6px;
    line-height: 1.3;
  }
  .pin-toggle-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    font-size: 12px;
    line-height: 1;
    color: var(--slim-muted);
    border-radius: 3px;
    cursor: pointer;
    user-select: none;
    transition: color 0.15s ease, transform 0.15s ease;
  }
  .pin-toggle-btn:hover {
    color: var(--slim-text);
    transform: scale(1.15);
  }
  .pin-toggle-btn.pinned {
    color: #e0a63c;
  }
  .count-hint {
    font-size: 9px;
    color: var(--slim-muted);
    text-transform: none;
  }
  .branch-badge {
    flex: none;
    font-size: 9.5px;
    font-weight: 700;
    color: #875404;
    white-space: nowrap;
  }
  @media (prefers-color-scheme: dark) {
    .branch-badge {
      color: var(--slim-warning, #e8c98a);
    }
  }
  .body-hit-badge {
    flex: none;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--slim-line);
    color: var(--slim-muted);
    background: var(--slim-soft);
    white-space: nowrap;
  }
  .row-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 1.5px solid var(--slim-line);
    border-top-color: var(--f7-theme-color, #22735e);
    border-radius: 50%;
    animation: slimgpt-spin 0.8s linear infinite;
    flex: none;
  }
  .retry-pill {
    font-size: 8.5px;
    padding: 1px 4px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--slim-danger, #a82d22) 15%, transparent);
    color: #a82d22;
    border: 1px solid #a82d22;
    flex: none;
  }
  @media (prefers-color-scheme: dark) {
    .retry-pill {
      color: var(--slim-danger, #e78278);
      border-color: var(--slim-danger, #e78278);
    }
  }
  .index-status-line {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .active-history-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }
  .sync-label {
    font-size: 9.5px;
    color: var(--slim-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 160px;
  }
  .sync-label.sync-error {
    color: var(--slim-danger, #e74c3c);
  }
  .refresh-history-btn {
    padding: 2px 6px;
    font-size: 9.5px;
    border: 1px solid var(--slim-line);
    border-radius: 4px;
    background: var(--slim-soft);
    color: var(--f7-theme-color, #22735e);
    cursor: pointer;
    margin-left: auto;
  }
  .refresh-history-btn:hover:not(:disabled) {
    background: var(--slim-surface);
  }
  .refresh-history-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .load-more-container {
    padding: 8px 6px;
    text-align: center;
  }
  .load-more-btn {
    width: 100%;
    padding: 6px 12px;
    font-size: 11px;
    color: var(--f7-theme-color, #22735e);
    background: var(--slim-soft);
    border: 1px solid var(--slim-line);
    border-radius: 6px;
    cursor: pointer;
  }
  .load-more-btn:hover {
    background: var(--slim-surface);
  }
  .footer-security-note {
    font-size: 9.5px;
    color: var(--slim-muted);
    margin-top: 2px;
  }
</style>
