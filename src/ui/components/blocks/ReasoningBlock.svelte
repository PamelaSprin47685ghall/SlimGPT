<script>
  import Markdown from './Markdown.svelte';
  let { block, streaming = false } = $props();
  let open = $state(false);
  const label = $derived(streaming ? '思考中…' : block.label ? block.label : block.durationSec ? `思考 · ${Math.max(1, Math.round(block.durationSec))} 秒` : '思考');
</script>

<details class="fold reasoning" bind:open>
  <summary><span class="fold-label">{label}</span>{#if block.summary}<span class="fold-hint">{block.summary}</span>{/if}</summary>
  {#if open}
    <div class="fold-body">
      {#if block.markdown}<Markdown source={block.markdown} final={!streaming} />{:else}<p class="muted">暂无思考内容</p>{/if}
    </div>
  {/if}
</details>
