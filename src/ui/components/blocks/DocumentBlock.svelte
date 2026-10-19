<script>
  import Markdown from './Markdown.svelte';
  /** @type {{ block: import('../../../protocol/types.js').DocumentBlock, streaming?: boolean }} */
  let { block, streaming = false } = $props();
</script>

<section class="doc-card" data-variant={block.variant ?? ''}>
  {#if block.title}<header class="doc-title">{block.title}</header>{/if}
  <div class="doc-body">
    <Markdown source={block.markdown} citations={block.citations} final={!streaming} />
  </div>
</section>
