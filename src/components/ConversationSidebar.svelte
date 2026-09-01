<script>
  import { Button } from 'framework7-svelte';

  let {
    conversations = [],
    currentId = null,
    statusLabel = '未连接',
    statusState = 'offline',
    captures = 0,
    onShowOfficial = () => {},
    onNewChat = () => {},
    onSelect = () => {},
  } = $props();

  let query = $state('');
  let filtered = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return conversations;
    return conversations.filter((item) => String(item?.title || '').toLocaleLowerCase().includes(needle));
  });

  function formatTime(value) {
    const numeric = Number(value || 0);
    if (!numeric) return '';
    const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
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

  <div class="sidebar-actions">
    <div class="platform-note">
      <strong>轻量接管</strong>
      <span>登录、网络和产品能力仍由当前 ChatGPT 页面处理；SlimGPT 只负责更轻的界面。</span>
    </div>
    <Button outline small onClick={onShowOfficial}>暂时显示官方界面</Button>
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
      <div class="empty-list">捕获到官方会话索引后，这里会显示历史对话。</div>
    {:else}
      {#each filtered as conversation (conversation.id)}
        <button
          type="button"
          class:active={conversation.id === currentId}
          class="conversation-item"
          onClick={() => onSelect(conversation.id)}
        >
          <span class="conversation-title">{conversation.title || 'Untitled'}</span>
          <span class="conversation-time">{formatTime(conversation.update_time || conversation.updatedAt)}</span>
        </button>
      {/each}
    {/if}
  </div>

  <footer class="sidebar-footer">
    <span>已同步 {captures} 次</span>
    <span>登录凭据不会离开 ChatGPT 页面</span>
  </footer>
</aside>
