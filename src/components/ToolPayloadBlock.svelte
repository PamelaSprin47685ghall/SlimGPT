<script>
  import { onDestroy, onMount } from 'svelte';
  import { extractToolCallIds, loadToolFormatter, presentToolPayload } from '../lib/tool-presentation.js';
  import { copyText } from '../lib/clipboard.js';

  let { tool, streaming = false, isError = false } = $props();
  let userToggled = $state(false);
  let manualOpen = $state(false);
  let copied = $state(false);
  let copyError = $state(false);
  let copiedId = $state(false);
  let rawMode = $state(false);
  let formatter = $state.raw(null);
  let loadFailed = $state(false);
  let copyTimer = null;
  let idCopyTimer = null;
  let alive = true;

  const presentation = $derived(presentToolPayload(tool?.payload, { formatter, raw: rawMode }));
  const displayRaw = $derived(presentation.format === 'RAW');
  const callIds = $derived(extractToolCallIds(tool));

  // When streaming prop is explicitly provided (boolean), follow streaming. Otherwise default to true (expanded).
  let isOpen = $state(true);

  function toggleOpen() {
    manualOpen = !isOpen;
    isOpen = manualOpen;
    userToggled = true;
  }

  $effect(() => {
    // When streaming changes and user has not manually toggled:
    if (!userToggled && typeof streaming === 'boolean') {
      isOpen = streaming;
    }
  });

  const toolName = $derived(tool?.name || 'tool');
  const isSuccess = $derived(!isError && tool?.status !== 'failed');
  const summaryStatus = $derived(isSuccess ? '✓' : '✗');

  const keyArg = $derived.by(() => {
    const payload = tool?.payload;
    if (!payload) return '';
    if (typeof payload === 'string') {
      try {
        const parsed = JSON.parse(payload);
        if (typeof parsed === 'object' && parsed !== null) {
          return extractKeyFromObject(parsed);
        }
      } catch {
        return payload.slice(0, 40).replace(/\s+/g, ' ').trim();
      }
    } else if (typeof payload === 'object') {
      return extractKeyFromObject(payload);
    }
    return '';
  });

  function extractKeyFromObject(obj) {
    for (const key of ['query', 'q', 'url', 'search_query', 'command', 'action', 'prompt', 'code']) {
      if (typeof obj[key] === 'string' && obj[key].trim()) return `${key}: ${obj[key].trim()}`;
    }
    const firstKey = Object.keys(obj)[0];
    if (firstKey && typeof obj[firstKey] === 'string') return `${firstKey}: ${obj[firstKey].trim()}`;
    return '';
  }

  onMount(() => {
    loadToolFormatter().then((module) => { if (alive) formatter = module; })
      .catch(() => { if (alive) loadFailed = true; });
  });

  $effect(() => {
    // A copy acknowledgement belongs to exactly the version that was copied.
    void presentation.text;
    copied = copyError = false;
    clearTimeout(copyTimer);
  });

  function toggleFormat() {
    rawMode = !rawMode;
    copied = false;
    copyError = false;
    clearTimeout(copyTimer);
  }

  onDestroy(() => {
    alive = false;
    clearTimeout(copyTimer);
    clearTimeout(idCopyTimer);
  });

  async function copyToml() {
    const text = presentation.text;
    try {
      await copyText(text);
      if (!alive || presentation.text !== text) return;
      copied = true;
      copyError = false;
    } catch {
      if (!alive || presentation.text !== text) return;
      copied = false;
      copyError = true;
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied = false; copyError = false; }, 2400);
  }

  async function copyCallId(id) {
    try {
      await copyText(id);
      if (!alive) return;
      copiedId = true;
    } catch {
      if (!alive) return;
      copiedId = false;
    }
    clearTimeout(idCopyTimer);
    idCopyTimer = setTimeout(() => { copiedId = false; }, 2400);
  }
</script>

<div class="tool-payload-block" data-tool-kind={tool?.kind || ''} class:collapsed={!isOpen}>
  <div class="tool-summary-bar">
    <button type="button" class="tool-summary-toggle" onclick={toggleOpen} aria-expanded={isOpen}>
      <span class="tool-summary-status" class:is-error={!isSuccess}>{summaryStatus}</span>
      <span class="tool-summary-name">{toolName}</span>
      {#if keyArg}
        <span class="tool-summary-arg" title={keyArg}>{keyArg}</span>
      {/if}
      <span class="tool-summary-toggle-text">{isOpen ? '收起 ▲' : '展开 ▼'}</span>
    </button>
  </div>
  <div class="tool-code-header" hidden={!isOpen}>
    <span class="tool-code-language">{presentation.format}</span>
    <span class="tool-code-name" title={tool?.title || tool?.name || 'tool'}>
      {tool?.name || 'tool'}{tool?.title ? ` · ${tool.title}` : ''}
    </span>
    {#if callIds.length > 0}
      <div class="tool-call-ids" title="调用标识">
        {#each callIds as id}
          <button
            type="button"
            class="tool-call-id-btn"
            onclick={() => copyCallId(id)}
            title={`点击复制调用标识：${id}`}
            aria-label={`复制调用标识 ${id}`}
          >
            <span class="tool-call-id-label">ID:</span>
            <span class="tool-call-id-val">{id}</span>
          </button>
        {/each}
        {#if copiedId}
          <span class="tool-id-copied-tip">已复制 ID</span>
        {/if}
      </div>
    {/if}
    <div class="tool-code-actions">
      <button type="button" class="tool-code-copy tool-format-toggle" onclick={toggleFormat}
        disabled={!formatter || presentation.failed}
        aria-pressed={rawMode} title="查看原始载荷；字符串保持原样，对象显示为 JSON">
        {displayRaw ? '查看 TOML' : '查看原文'}
      </button>
      <button type="button" class:copied class="tool-code-copy" onclick={copyToml} aria-live="polite">
        {copied ? '已复制' : copyError ? '复制失败' : displayRaw ? '复制原文' : '复制 TOML'}
      </button>
    </div>
  </div>
  {#if loadFailed || presentation.failed}
    <div class="tool-format-notice" role="status">{loadFailed ? '格式模块未能加载，已显示原文；刷新页面可重试。' : '此载荷无法格式化，已显示原文。'}</div>
  {:else if !formatter}
    <div class="tool-format-notice" role="status">正在载入格式模块，先显示原文。</div>
  {/if}
  <!-- Scrollable logs must be reachable by keyboard, even though they are read-only. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <pre class="tool-toml-pre" role="region" tabindex={isOpen ? '0' : '-1'} aria-label="工具内容，可滚动" aria-hidden={!isOpen} hidden={!isOpen}>{#if displayRaw}<code>{presentation.text}</code>{:else}<code class="hljs language-toml">{@html presentation.html}</code>{/if}</pre>
</div>

<style>
  .tool-summary-bar {
    display: flex;
    align-items: center;
    width: 100%;
    background: color-mix(in srgb, var(--slim-soft) 76%, var(--slim-code));
    border-bottom: 1px solid var(--slim-line);
  }
  .tool-payload-block.collapsed .tool-summary-bar {
    border-bottom: none;
  }
  .tool-summary-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 32px;
    padding: 6px 12px;
    background: transparent;
    border: none;
    font: inherit;
    color: var(--slim-text);
    cursor: pointer;
    text-align: left;
  }
  .tool-summary-toggle:hover {
    background: color-mix(in srgb, var(--slim-soft) 90%, var(--slim-code));
  }
  .tool-summary-status { font-weight: 700; color: #22735e; }
  .tool-summary-status.is-error { color: var(--slim-danger); }
  .tool-summary-name { font-weight: 600; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .tool-summary-arg { font-size: 10.5px; color: var(--slim-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: min(50vw, 400px); }
  .tool-summary-toggle-text { margin-left: auto; font-size: 10px; color: var(--slim-muted); flex: none; }

  .tool-code-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .tool-format-notice { padding: 8px 12px; font-size: 12px; color: var(--slim-muted); }
  .tool-call-ids { display: inline-flex; align-items: center; gap: 6px; overflow: hidden; }
  .tool-call-id-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 20px;
    max-width: 160px;
    padding: 0 6px;
    border: 1px solid var(--slim-line);
    border-radius: 4px;
    background: color-mix(in srgb, var(--slim-surface) 80%, transparent);
    color: var(--slim-muted);
    font: 500 9.5px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  .tool-call-id-btn:hover { color: var(--f7-theme-color); border-color: var(--f7-theme-color); }
  .tool-call-id-label { opacity: 0.65; flex: none; }
  .tool-call-id-val { overflow: hidden; text-overflow: ellipsis; }
  .tool-id-copied-tip { font-size: 9.5px; color: var(--f7-theme-color); flex: none; }
</style>
