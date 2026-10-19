<script>
  import { createMarkdownRenderer } from '../../markdown/renderer.js';
  import { injectCitations } from '../../markdown/citations.js';

  /** @type {{ source: string, citations?: object[], final?: boolean }} */
  let { source = '', citations = [], final = true } = $props();
  let root = $state();
  let renderer = null;
  const prepared = $derived(injectCitations(source, citations));

  $effect(() => {
    if (!root) return;
    renderer ||= createMarkdownRenderer(root);
    renderer.update(prepared.source, { final, citations: prepared.groups });
  });
</script>

<div class="md" bind:this={root}></div>
{#if prepared.fallback.length}
  <ol class="sources">
    {#each prepared.fallback as item (item.url)}
      <li><a href={item.url} target="_blank" rel="noreferrer noopener">{item.title || item.url}</a></li>
    {/each}
  </ol>
{/if}
