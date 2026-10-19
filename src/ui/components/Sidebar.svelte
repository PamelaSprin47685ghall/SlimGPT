<script>
  import { filterList } from '../state/logic.js';
  /** @type {{ list: {id:string,title:string}[], currentId: string|null, running: Set<string>, onopen: (id: string|null) => void }} */
  let { list, currentId, running, onopen } = $props();
  let query = $state('');
  const items = $derived(filterList(list, query));
</script>

<nav class="sidebar" aria-label="会话侧栏">
  <div class="sidebar-head">
    <button type="button" class="btn new-chat" aria-current={currentId === null ? 'page' : undefined} onclick={() => onopen(null)}>＋ 新对话</button>
    <input class="filter" type="search" placeholder="筛选标题" aria-label="按标题筛选对话" bind:value={query} />
  </div>
  <ul class="conv-list">
    {#each items as item (item.id)}
      <li>
        <button type="button" class="conv" aria-current={item.id === currentId ? 'page' : undefined} onclick={() => onopen(item.id)}>
          <span class="conv-title">{item.title || '未命名对话'}</span>
          {#if running.has(item.id)}<span class="running-dot" title="生成中" aria-label="生成中"></span>{/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if !items.length}
    <p class="muted sidebar-empty">{query ? '没有匹配的对话' : '暂无对话'}</p>
  {/if}
</nav>
