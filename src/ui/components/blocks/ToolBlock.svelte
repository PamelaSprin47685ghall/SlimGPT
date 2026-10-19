<script>
  import { copyWithFeedback } from '../../lib/clipboard.js';
  let { block } = $props();
  let open = $state(false);
  const raw = $derived(block.kind === 'tool_call' ? block.input ?? '' : block.output ?? '');
  const label = $derived(block.kind === 'tool_call' ? '工具调用' : block.isError ? '工具出错' : '工具结果');
  const shown = $derived.by(() => {
    const text = String(raw);
    const trimmed = text.trim();
    if (!/^[[{]/.test(trimmed)) return text;
    try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch { return text; }
  });
</script>

<details class="fold tool" class:is-error={block.kind === 'tool_result' && block.isError} bind:open>
  <summary><span class="fold-label">{label}</span><span class="fold-hint">{block.tool || '工具'}</span></summary>
  {#if open}
    <div class="fold-body">
      <div class="code-block">
        <div class="code-header">
          <span class="code-lang">{block.language || (shown !== raw ? 'json' : 'text')}</span>
          <button type="button" class="code-copy-btn" aria-label="复制原文" onclick={(event) => copyWithFeedback(event.currentTarget, raw)}>复制</button>
        </div>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre tabindex="0" role="region" aria-label="原文，可滚动"><code>{shown || '（空）'}</code></pre>
      </div>
    </div>
  {/if}
</details>
