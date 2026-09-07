<script>
  import { Button } from 'framework7-svelte';
  import { formatModelLabel } from '../lib/message-presentation.js';
  import { historySyncStatusLabel, isHistorySyncRetryable } from '../lib/history-sync.js';
  import { formatSidebarTime, fullSidebarDateTime, filterConversations } from '../lib/sidebar-helpers.js';

  let {
    conversations = [],
    currentId = null,
    loadingConversationId = null,
    navigationTimedOutId = null,
    historySyncState = null,
    statusLabel = '未连接',
    statusState = 'offline',
    captures = 0,
    workState = 'unknown',
    sendInFlight = false,
    historyComplete = true,
    hasExportableContent = false,
    exportError = '',
    sidebarNotice = '',
    onShowOfficial = () => {},
    onExportMarkdown = () => {},
    onNewChat = () => {},
    onSelect = () => {},
    onRetryHistorySync = () => {},
    onClearNotice = () => {},
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

  const searchResult = $derived(filterConversations(conversations, query, 100));
  const filtered = $derived(searchResult.visible);
  const totalMatches = $derived(searchResult.total);
  const isCapped = $derived(searchResult.isCapped);

  const syncLabel = $derived(historySyncStatusLabel(historySyncState));
  const syncRetryable = $derived(isHistorySyncRetryable(historySyncState));
  const syncLoading = $derived(historySyncState?.state === 'loading');

  function handleKeydown(event) {
    if (event.key === 'Escape' && query) {
      query = '';
      event.stopPropagation();
      event.preventDefault();
    }
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
      <span>{sidebarNotice}</span>
      <button type="button" class="notice-close-btn" onclick={onClearNotice} aria-label="关闭提示">×</button>
    </div>
  {/if}

  {#if exportError}
    <div class="sidebar-inline-notice error" role="alert">
      <span>{exportError}</span>
      <button type="button" class="notice-close-btn" onclick={onClearNotice} aria-label="关闭提示">×</button>
    </div>
  {/if}

  <div class="sidebar-actions">
    <div class="platform-note">
      <strong>轻量接管</strong>
      <span>登录、网络和产品能力仍由当前 ChatGPT 页面处理；SlimGPT 只负责更轻的界面。</span>
    </div>
    <Button outline small onClick={onShowOfficial}>暂时显示官方界面</Button>
    <Button
      outline
      small
      disabled={!hasExportableContent}
      onClick={onExportMarkdown}
      title={!hasExportableContent ? '当前对话暂无可导出的内容' : (historyComplete ? '导出当前对话 Markdown' : '历史尚未完整，导出将包含不完整提示')}
    >
      <span>导出 Markdown · 当前对话</span>
      {#if !historyComplete && hasExportableContent}
        <span class="partial-badge" title="历史尚未同步完整，导出文件将标记局部不完整">部分</span>
      {/if}
    </Button>
  </div>

  <label class="search-box conversation-search">
    <input
      bind:value={query}
      onkeydown={handleKeydown}
      placeholder="搜索会话标题或内容… (Esc 清除)"
      autocomplete="off"
    />
    {#if query}
      <button type="button" class="search-clear-icon" onclick={() => query = ''} aria-label="清除搜索">×</button>
    {/if}
  </label>

  <div class="sidebar-section-title">
    <span>会话</span>
    {#if isCapped}
      <span class="count-hint" title={`共找到 ${totalMatches} 条结果，当前展示前 100 条`}>
        显示 100 / 全部 {totalMatches}
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
          <button type="button" class="empty-action-btn" onclick={onNewChat} disabled={sendInFlight}>发起新对话</button>
        {:else}
          <div class="empty-title">暂无历史会话</div>
          <div class="empty-hint">当前未发现历史对话记录，随时可以开始新的对话。</div>
          <button type="button" class="empty-action-btn" onclick={onNewChat} disabled={sendInFlight}>发起新对话</button>
        {/if}
      </div>
    {:else}
      {#each filtered as conversation (conversation.id)}
        {@const isCurrent = conversation.id === currentId}
        {@const isLoading = conversation.id === loadingConversationId}
        {@const isTimedOut = conversation.id === navigationTimedOutId}
        {@const modelLabel = formatModel(conversation)}
        <button
          type="button"
          class:active={isCurrent}
          class:pending={isLoading}
          class:timed-out={isTimedOut}
          class="conversation-item"
          onclick={() => handleSelect(conversation.id)}
          title={isTimedOut ? `${conversation.title || 'Untitled'}（加载超时，点击重试）` : (conversation.title || 'Untitled')}
        >
          <span class="conversation-item-topline">
            <span class="conversation-title">{conversation.title || 'Untitled'}</span>
            {#if isLoading}
              <span class="row-spinner" aria-label="正在加载"></span>
            {:else if isTimedOut}
              <span class="retry-pill" title="加载超时，点击重试">重试</span>
            {/if}
            <span
              class="conversation-time"
              title={fullSidebarDateTime(conversation.update_time || conversation.updatedAt)}
            >
              {formatSidebarTime(conversation.update_time || conversation.updatedAt)}
            </span>
          </span>
          <span class="conversation-item-bottomline">
            {#if modelLabel}
              <span class="conversation-model" title={conversation.model || ''}>{modelLabel}</span>
            {/if}
            <span class="conversation-preview" title={preview(conversation)}>{preview(conversation)}</span>
          </span>
        </button>
      {/each}
    {/if}
  </div>

  <footer class="sidebar-footer">
    <div class="sync-status-row">
      <span class="captures-count">已同步 {captures} 次</span>
      {#if syncLabel}
        <span class="sync-label" class:sync-error={historySyncState?.state === 'error'}>
          {syncLabel}
        </span>
      {/if}
      <button
        type="button"
        class="refresh-history-btn"
        disabled={syncLoading || !statusState.startsWith('online') && statusState !== 'online'}
        onclick={onRetryHistorySync}
        title={syncLoading ? '正在同步…' : '刷新历史'}
      >
        {syncLoading ? '同步中…' : '刷新历史'}
      </button>
    </div>
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
  .count-hint {
    font-size: 9px;
    color: var(--slim-muted);
    text-transform: none;
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
    background: color-mix(in srgb, var(--slim-danger, #e74c3c) 15%, transparent);
    color: var(--slim-danger, #e74c3c);
    border: 1px solid var(--slim-danger, #e74c3c);
    flex: none;
  }
  .sync-status-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-wrap: wrap;
  }
  .sync-label {
    font-size: 9.5px;
    color: var(--slim-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 120px;
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
  .footer-security-note {
    font-size: 9.5px;
    color: var(--slim-muted);
    margin-top: 2px;
  }
</style>
