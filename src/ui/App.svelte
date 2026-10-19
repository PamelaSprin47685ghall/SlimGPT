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

  /** @type {{ store?: ReturnType<typeof createStore> }} */
  let { store: provided } = $props();
  const store = untrack(() => provided) ?? createStore();
  const P = store.protocol;
  setContext('slimgpt', { protocol: P, dispatch: (action) => store.dispatch(action) });

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
  const feature = $derived(L.features(s));
  const emptyText = $derived(!s.currentId ? '开始新的对话' : s.sync[s.currentId]?.state === 'loading' ? '正在加载对话…' : conv ? '对话暂无消息' : L.isFreeMode(s) ? '这个免费模式对话没有保存在本机' : '对话暂未加载');

  onMount(() => store.start());

  function open(id) {
    closePanel();
    store.dispatch({ type: 'open', conversationId: id });
  }

  function exportMarkdown() {
    if (!conv) return;
    let text = '';
    try { text = P.conversationToMarkdown(conv, { leafId: L.selectedLeaf(s), includeReasoning: false, includeTools: false }); } catch { text = ''; }
    if (!text.trim()) { notify('当前对话暂无可导出的消息'); return; }
    if (downloadText(text, safeFileName(title))) { notify('已导出 Markdown'); return; }
    void copyText(text).then((ok) => notify(ok ? '无法下载文件，已复制 Markdown 到剪贴板' : '导出失败'), () => notify('导出失败'));
  }
</script>

<F7App {...f7params}>
  <Panel left cover visibleBreakpoint={960}>
    <Sidebar list={L.visibleList(s)} currentId={s.currentId} running={L.runningIds(s)} freeMode={L.isFreeMode(s)} onopen={open} />
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
        turns={view.turns}
        conversationKey={s.currentId ?? ''}
        {running}
        branches={feature.branches}
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
    </Page>
  </View>
  <Popover class="menu-popover">
    <List>
      <ListItem link popoverClose title="导出 Markdown" class={conv && view.turns.length ? '' : 'disabled'} onClick={exportMarkdown} />
      <ListItem link popoverClose title="显示官方界面" onClick={() => store.dispatch({ type: 'show-official' })} />
    </List>
  </Popover>
</F7App>
