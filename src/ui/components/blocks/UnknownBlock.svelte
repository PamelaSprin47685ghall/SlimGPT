<script>
  let { block } = $props();
  let open = $state(false);
  const json = $derived.by(() => {
    try { return JSON.stringify(block.raw, null, 2) ?? String(block.raw); } catch { return String(block.raw); }
  });
</script>

<details class="fold unknown" bind:open>
  <summary><span class="fold-label">暂不支持的内容</span><span class="fold-hint">{block.contentType || 'unknown'}</span></summary>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  {#if open}<div class="fold-body"><pre tabindex="0" role="region" aria-label="原文，可滚动"><code>{json}</code></pre></div>{/if}
</details>
