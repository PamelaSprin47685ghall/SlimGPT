<script>
  import { Button } from 'framework7-svelte';
  import { formatModelLabel } from '../lib/message-presentation.js';

  let {
    conversations = [],
    currentId = null,
    statusLabel = '未连接',
    statusState = 'offline',
    captures = 0,
    workState = 'unknown',
    onShowOfficial = () => {},
    onExportMarkdown = () => {},
    onNewChat = () => {},
    onSelect = () => {},
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
  let filtered = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return conversations;
    return conversations.filter((item) => String(item?.title || '').toLocaleLowerCase().includes(needle));
  });

  function formatTime(value) {
    const numeric = Number(value || 0);
    if (!numeric || numeric <= 0) return '';
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const isSameYear = date.getFullYear() === now.getFullYear();
    return new Intl.DateTimeFormat(undefined, {
      ...(isSameYear ? {} : { year: 'numeric' }),
      month: 'short',
      day: 'numeric',
      weekday: 'short',
    }).format(date);
  }

  function fullDateTime(value) {
    const numeric = Number(value || 0);
    if (!numeric || numeric <= 0) return '';
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  function formatModel(item) {
    const raw = String(item?.model || '').trim();
    if (raw) return formatModelLabel(raw).slice(0, 20);
    return item?.route === 'uc' ? 'Mobile' : 'Web';
  }

  function preview(item) {
    return String(item?.last || '')
      .replace(/\s+/g, ' ')
      .trim();
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

  <div class="sidebar-actions">
    <div class="platform-note">
      <strong>轻量接管</strong>
      <span>登录、网络和产品能力仍由当前 ChatGPT 页面处理；SlimGPT 只负责更轻的界面。</span>
    </div>
    <Button outline small onClick={onShowOfficial}>暂时显示官方界面</Button>
    <Button outline small onClick={onExportMarkdown}>导出 Markdown</Button>
  </div>

  <Button class="new-chat" outline small onClick={onNewChat}>
    新对话
  </Button>

  <label class="search-box conversation-search">
    <input bind:value={query} placeholder="搜索会话标题…" autocomplete="off" />
  </label>

  <div class="sidebar-section-title">
    <span>会话</span>
    <span>{filtered.length}</span>
  </div>

  <div class="conversation-list">
    {#if filtered.length === 0}
      <div class="empty-list" role="status">
        {#if query}
          <div class="empty-title">未找到匹配的会话</div>
          <div class="empty-hint">没有找到包含“{query.trim()}”的对话标题，可尝试其他关键词。</div>
          <button type="button" class="empty-action-btn" onclick={() => query = ''}>清除搜索词</button>
        {:else if captures === 0}
          <div class="empty-title">等待同步官方会话</div>
          <div class="empty-hint">捕获到官方会话索引后，这里会显示历史对话。请确保已在当前 ChatGPT 标签页登录。</div>
          <button type="button" class="empty-action-btn" onclick={onNewChat}>发起新对话</button>
        {:else}
          <div class="empty-title">暂无历史会话</div>
          <div class="empty-hint">当前未发现历史对话记录，随时可以开始新的对话。</div>
          <button type="button" class="empty-action-btn" onclick={onNewChat}>发起新对话</button>
        {/if}
      </div>
    {:else}
      {#each filtered as conversation (conversation.id)}
        <button
          type="button"
          class:active={conversation.id === currentId}
          class="conversation-item"
          onclick={() => onSelect(conversation.id)}
          title={conversation.title || 'Untitled'}
        >
          <span class="conversation-item-topline">
            <span class="conversation-title">{conversation.title || 'Untitled'}</span>
            <span
              class="conversation-time"
              title={fullDateTime(conversation.update_time || conversation.updatedAt)}
            >
              {formatTime(conversation.update_time || conversation.updatedAt)}
            </span>
          </span>
          <span class="conversation-item-bottomline">
            <span class="conversation-model" title={conversation.model || ''}>{formatModel(conversation)}</span>
            <span class="conversation-preview" title={preview(conversation)}>{preview(conversation)}</span>
          </span>
        </button>
      {/each}
    {/if}
  </div>

  <footer class="sidebar-footer">
    <span>已同步 {captures} 次</span>
    <span>登录凭据不会离开 ChatGPT 页面</span>
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
  .empty-action-btn:hover {
    background: var(--slim-surface);
  }
</style>
