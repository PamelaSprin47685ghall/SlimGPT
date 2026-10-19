<script>
  import { onMount, setContext, untrack } from 'svelte';
  import { createStore } from './state.svelte.js';
  import * as L from './state/logic.js';
  import Sidebar from './components/Sidebar.svelte';
  import Thread from './components/Thread.svelte';
  import Composer from './components/Composer.svelte';
  import StatusLine from './components/StatusLine.svelte';
  import { downloadText, safeFileName } from './lib/download.js';

  /** @type {{ store?: ReturnType<typeof createStore> }} */
  let { store: provided } = $props();
  const store = untrack(() => provided) ?? createStore();
  const P = store.protocol;
  setContext('slimgpt', { protocol: P, dispatch: (action) => store.dispatch(action) });

  let drawer = $state(false);
  let menu = $state(false);

  const s = $derived(store.state);
  const view = $derived.by(() => {
    try { return { turns: L.currentTurns(s, P), failed: false }; } catch { return { turns: [], failed: true }; }
  });
  const running = $derived(L.isRunning(s));
  const check = $derived(L.canSend(s));
  const offBranch = $derived(L.isOffBranch(s));
  const conv = $derived(L.currentConversation(s));
  const title = $derived(L.currentTitle(s));
  const status = $derived(view.failed ? { tone: 'error', text: '消息解析失败', action: { label: '重试同步', type: 'retry-sync' } } : L.statusLine(s));
  const sendError = $derived(s.sendError && (s.sendError.conversationId ?? null) === (s.currentId ?? null) ? L.sendErrorText(s.sendError.code) : '');
  const emptyText = $derived(!s.currentId ? '开始新的对话' : s.sync[s.currentId]?.state === 'loading' ? '正在加载对话…' : conv ? '对话暂无消息' : '对话暂未加载');

  onMount(() => store.start());

  function open(id) {
    drawer = false;
    store.dispatch({ type: 'open', conversationId: id });
  }

  function exportMarkdown() {
    menu = false;
    if (!conv) return;
    let text = '';
    try { text = P.conversationToMarkdown(conv, { leafId: L.selectedLeaf(s), includeReasoning: false, includeTools: false }); } catch { text = ''; }
    if (text.trim()) downloadText(text, safeFileName(title));
  }

  function onkeydown(event) {
    if (event.key === 'Escape') { drawer = false; menu = false; }
  }
</script>

<svelte:window {onkeydown} />

<div class="app" class:drawer-open={drawer}>
  <aside class="side">
    <Sidebar list={s.list} currentId={s.currentId} running={L.runningIds(s)} onopen={open} />
  </aside>
  {#if drawer}<button type="button" class="scrim" aria-label="关闭会话侧栏" onclick={() => (drawer = false)}></button>{/if}
  <main class="main">
    <header class="topbar">
      <button type="button" class="icon-btn drawer-btn" aria-label="打开会话侧栏" onclick={() => (drawer = true)}>☰</button>
      <h1 class="title" title={title}>{title}</h1>
      <div class="menu-wrap">
        <button type="button" class="icon-btn" aria-label="更多操作" aria-expanded={menu} onclick={() => (menu = !menu)}>⋯</button>
        {#if menu}
          <div class="menu" role="menu">
            <button type="button" role="menuitem" disabled={!conv || !view.turns.length} onclick={exportMarkdown}>导出 Markdown</button>
            <button type="button" role="menuitem" onclick={() => { menu = false; store.dispatch({ type: 'show-official' }); }}>显示官方界面</button>
          </div>
        {/if}
      </div>
    </header>
    <StatusLine {status} onaction={(type) => store.dispatch({ type })} />
    <Thread
      turns={view.turns}
      conversationKey={s.currentId ?? ''}
      {running}
      canContinue={!running && !offBranch && check.reason !== 'bridge' && check.reason !== 'pending'}
      empty={emptyText}
    />
    <Composer
      draft={L.currentDraft(s)}
      {running}
      pending={!!s.pending}
      blocked={!check.ok}
      notice={['branch', 'loading', 'pending'].includes(check.reason) ? L.blockedText(check.reason) : ''}
      {offBranch}
      error={sendError}
      efforts={s.efforts}
      effort={s.settings.effort}
      onsend={(text) => store.dispatch({ type: 'send', text })}
      onstop={() => store.dispatch({ type: 'stop' })}
      ondraft={(text) => store.dispatch({ type: 'draft', text })}
      onlatest={() => store.dispatch({ type: 'latest-branch' })}
      ondismiss={() => store.dispatch({ type: 'dismiss-send-error' })}
      oneffort={(effort) => store.dispatch({ type: 'set-effort', effort })}
    />
  </main>
</div>
