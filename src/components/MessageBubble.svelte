<script>
  import { onDestroy } from 'svelte';
  import { renderMarkdown } from '../lib/markdown.js';

  let {
    message,
    onBranch = () => {},
  } = $props();

  let html = $state('');
  let timer = null;
  let cancelWorkerListener = null;

  // The worker escapes every source fragment before adding its own fixed tags.
  // Never pass server-rendered HTML directly to this sink.
  $effect(() => {
    const id = message?.id || message?.nodeId || 'message';
    const source = String(message?.text || '');
    clearTimeout(timer);
    timer = setTimeout(() => {
      cancelWorkerListener?.();
      cancelWorkerListener = renderMarkdown(id, source, (result) => {
        html = result?.html || '';
      });
    }, 45);
  });

  onDestroy(() => {
    clearTimeout(timer);
    cancelWorkerListener?.();
  });
</script>

<div class={`role-${message?.role || 'unknown'}`}>
  <div class="message-meta">
    <span>{message?.role === 'assistant' ? 'ChatGPT' : (message?.role === 'user' ? '你' : (message?.name || message?.role || '消息'))}</span>
    {#if (message?.siblingCount || 0) > 1}
      <span class="branch-control">
        <button
          type="button"
          aria-label="Previous branch"
          disabled={message.siblingIndex <= 0}
          onClick={() => onBranch(message.nodeId, -1)}
        >‹</button>
        <span>{message.siblingIndex + 1}/{message.siblingCount}</span>
        <button
          type="button"
          aria-label="Next branch"
          disabled={message.siblingIndex >= message.siblingCount - 1}
          onClick={() => onBranch(message.nodeId, 1)}
        >›</button>
      </span>
    {/if}
  </div>
  <div class="message-bubble">
    <div class="message-markdown">{@html html}</div>
  </div>
</div>
