<script>
  import { onDestroy, onMount } from 'svelte';
  import { extractToolCallIds, loadToolFormatter, presentToolPayload } from '../lib/tool-presentation.js';
  import { copyText } from '../lib/clipboard.js';

  let { tool } = $props();
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

<div class="tool-payload-block" data-tool-kind={tool?.kind || ''}>
  <div class="tool-code-header">
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
  <pre class="tool-toml-pre" role="region" tabindex="0" aria-label="工具内容，可滚动">{#if displayRaw}<code>{presentation.text}</code>{:else}<code class="hljs language-toml">{@html presentation.html}</code>{/if}</pre>
</div>

<style>
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
