<script>
  import { onDestroy } from 'svelte';
  import { createIncrementalMarkdown } from '../lib/incremental-markdown.js';

  let {
    source = '',
    streaming = false,
    class: className = '',
  } = $props();

  let root = $state(null);
  let renderer = null;
  let scheduledSource = '';
  let scheduledFinal = false;
  let frame = 0;

  $effect(() => {
    const node = root;
    const nextSource = String(source || '');
    const final = !streaming;
    if (!node) return;
    if (!renderer) renderer = createIncrementalMarkdown(node);
    scheduledSource = nextSource;
    scheduledFinal = final;
    if (final) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      flush();
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(flush);
  });

  onDestroy(() => {
    if (frame) cancelAnimationFrame(frame);
  });

  function flush() {
    frame = 0;
    renderer?.update(scheduledSource, { final: scheduledFinal });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={root} class={`message-markdown ${className}`.trim()}></div>
