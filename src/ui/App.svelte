<script>
  import { onMount, setContext, untrack } from 'svelte';
  import F7App from 'framework7-svelte/components/app.svelte';
  import View from 'framework7-svelte/components/view.svelte';
  import Page from 'framework7-svelte/components/page.svelte';
  import Panel from 'framework7-svelte/components/panel.svelte';
  import Navbar from 'framework7-svelte/components/navbar.svelte';
  import NavLeft from 'framework7-svelte/components/nav-left.svelte';
  import NavTitle from 'framework7-svelte/components/nav-title.svelte';
  import NavRight from 'framework7-svelte/components/nav-right.svelte';
  import Link from 'framework7-svelte/components/link.svelte';
  import Popover from 'framework7-svelte/components/popover.svelte';
  import List from 'framework7-svelte/components/list.svelte';
  import ListItem from 'framework7-svelte/components/list-item.svelte';
  import { f7params, notify, closePanel } from './f7.js';
  import { copyText } from './lib/clipboard.js';
  import { createStore } from './state.svelte.js';
  import * as L from './state/logic.js';
  import Sidebar from './components/Sidebar.svelte';
  import Thread from './components/Thread.svelte';
  import Composer from './components/Composer.svelte';
  import StatusLine from './components/StatusLine.svelte';
  import { downloadText, safeFileName } from './lib/download.js';
  import { stabilizeTurns } from './lib/stable-turns.js';

  /** @type {{ store?: ReturnType<typeof createStore> }} */
  let { store: provided } = $props();
  const store = untrack(() => provided) ?? createStore();
  const P = store.protocol;
  setContext('slimgpt', { protocol: P, dispatch: (action) => store.dispatch(action) });

  const s = $derived(store.state);
  // Unchanged turns keep their identity: a streaming delta re-renders only its own turn.
  let shownTurns = [];
  const view = $derived.by(() => {
    try { shownTurns = stabilizeTurns(shownTurns, L.displayTurns(s, P)); return { turns: shownTurns, failed: false }; } catch { return { turns: [], failed: true }; }
  });
  const running = $derived(L.isRunning(s));
  // Stable sidebar inputs: a streaming delta does not touch the list, so it
  // must not hand the sidebar a new array / Set (that re-renders every row).
  let lastList = { source: null, mode: null, value: [] };
  const sidebarList = $derived.by(() => {
    const mode = L.isFreeMode(s);
    if (lastList.source !== s.list || lastList.mode !== mode) lastList = { source: s.list, mode, value: L.visibleList(s) };
    return lastList.value;
  });
  let lastRunning = new Set();
  const sidebarRunning = $derived.by(() => {
    const next = L.runningIds(s);
    if (next.size !== lastRunning.size || [...next].some((id) => !lastRunning.has(id))) lastRunning = next;
    return lastRunning;
  });
  const check = $derived(L.canSend(s));
  const offBranch = $derived(L.isOffBranch(s));
  const conv = $derived(L.currentConversation(s));
  const title = $derived(L.currentTitle(s));
  const status = $derived(view.failed ? { tone: 'error', text: '消息解析失败', action: { label: '重试同步', type: 'retry-sync' } } : L.statusLine(s));
  const sendError = $derived(s.sendError && (s.sendError.conversationId ?? null) === (s.currentId ?? null) ? L.sendErrorText(s.sendError.code) : '');
  const feature = $derived(L.features(s));
  // Primitive props as their own deriveds: a prop written as \`s.x\` would make
  // every row / message that reads it re-run on ANY state change (each
  // streaming delta), even when its value did not change.
  const currentId = $derived(s.currentId);
  const freeMode = $derived(L.isFreeMode(s));
  const branchesOn = $derived(feature.branches);
  const turns = $derived(view.turns);
  const emptyText = $derived(!s.currentId ? '开始新的对话' : s.sync[s.currentId]?.state === 'loading' ? '正在加载对话…' : conv ? '对话暂无消息' : L.isFreeMode(s) ? '这个免费模式对话没有保存在本机' : '对话暂未加载');

  onMount(() => store.start());

  function open(id) {
    closePanel();
    store.dispatch({ type: 'open', conversationId: id });
  }

  function exportMarkdown() {
    if (!conv) return;
    let text = '';
    try { text = P.conversationToMarkdown(conv, { leafId: L.selectedLeaf(s), includeReasoning: false, includeTools: false, title: s.list.find((item) => item.id === conv.id)?.title || '' }); } catch { text = ''; }
    if (!text.trim()) { notify('当前对话暂无可导出的消息'); return; }
    if (downloadText(text, safeFileName(title))) { notify('已导出 Markdown'); return; }
    void copyText(text).then((ok) => notify(ok ? '无法下载文件，已复制 Markdown 到剪贴板' : '导出失败'), () => notify('导出失败'));
  }
</script>

<F7App {...f7params}>
  <Panel left cover visibleBreakpoint={960}>
    <Sidebar list={sidebarList} {currentId} running={sidebarRunning} {freeMode} onopen={open} />
  </Panel>
  <View main>
    <Page pageContent={false} withSubnavbar={!!status} class="chat">
      <Navbar>
        <NavLeft><Link iconOnly panelOpen="left" class="sidebar-toggle" aria-label="打开会话侧栏">☰</Link></NavLeft>
        <NavTitle title={title} />
        <NavRight><Link iconOnly popoverOpen=".menu-popover" aria-label="更多操作">⋯</Link></NavRight>
        {#if status}<StatusLine {status} onaction={(type) => store.dispatch({ type })} />{/if}
      </Navbar>
      <Thread
        {turns}
        conversationKey={currentId ?? ''}
        {running}
        branches={branchesOn}
        empty={emptyText}
      />
      <Composer
        draft={L.currentDraft(s)}
        {running}
        pending={!!s.pending}
        blocked={!check.ok}
        notice={['branch', 'loading', 'pending', 'device-readonly', 'opening'].includes(check.reason) ? L.blockedText(check.reason) : ''}
        {offBranch}
        error={sendError}
        efforts={s.efforts}
        effort={s.settings.effort}
        currentEffort={s.effort.current}
        effortError={L.effortErrorText(s.effortError)}
        onsend={(text) => store.dispatch({ type: 'send', text })}
        onstop={() => store.dispatch({ type: 'stop' })}
        ondraft={(text) => store.dispatch({ type: 'draft', text })}
        onlatest={() => store.dispatch({ type: 'latest-branch' })}
        ondismiss={() => store.dispatch({ type: 'dismiss-send-error' })}
        oneffort={(effort) => store.dispatch({ type: 'set-effort', effort })}
      />
    </Page>
  </View>
  <Popover class="menu-popover">
    <List>
      <ListItem link popoverClose title="导出 Markdown" class={conv && view.turns.length ? '' : 'disabled'} onClick={exportMarkdown} />
      <ListItem link popoverClose title="显示官方界面" onClick={() => store.dispatch({ type: 'show-official' })} />
    </List>
  </Popover>
</F7App>
