<script>
  import { onDestroy } from 'svelte';
  import { renderMarkdown } from '../lib/markdown.js';
  import ToolPayloadBlock from './ToolPayloadBlock.svelte';

  let {
    message,
    onBranch = () => {},
  } = $props();

  let html = $state('');
  let copied = $state(false);
  let timer = null;
  let copyTimer = null;
  let cancelWorkerListener = null;
  let initial = true;

  // The worker escapes every source fragment before adding its own fixed tags.
  // Never pass server-rendered HTML directly to this sink.
  $effect(() => {
    const id = message?.id || message?.nodeId || 'message';
    const source = String(message?.text || '');
    clearTimeout(timer);
    if (message?.tool) {
      cancelWorkerListener?.();
      cancelWorkerListener = null;
      html = '';
      return;
    }
    const delay = initial ? 0 : 35;
    initial = false;
    timer = setTimeout(() => {
      cancelWorkerListener?.();
      cancelWorkerListener = renderMarkdown(id, source, (result) => {
        html = result?.html || '';
      });
    }, delay);
  });

  onDestroy(() => {
    clearTimeout(timer);
    clearTimeout(copyTimer);
    cancelWorkerListener?.();
  });

  async function copyMessage() {
    const text = String(message?.text || '');
    if (!text) return;
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      copied = true;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; }, 1800);
    } catch {
      // Ignore clipboard write failures
    }
  }

  function handleBubbleClick(event) {
    const copyBtn = event.target.closest('.code-copy-btn');
    if (!copyBtn) return;
    const codeBlock = copyBtn.closest('.code-block');
    const code = codeBlock?.querySelector('pre code')?.textContent || '';
    if (!code) return;
    try {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(code).then(() => {
          showCopySuccess(copyBtn);
        });
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = code;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        showCopySuccess(copyBtn);
      }
    } catch {}
  }

  function showCopySuccess(btn) {
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = '复制';
      btn.classList.remove('copied');
    }, 1800);
  }
</script>

<div class={`message-card role-${message?.role || 'unknown'} ${message?.tool?.kind || ''}`}>
  <div class="message-avatar" aria-hidden="true">
    {message?.tool?.kind === 'tool-call'
      ? '↗'
      : message?.tool?.kind === 'tool-result'
        ? '↙'
        : message?.role === 'assistant'
          ? 'S'
          : (message?.role === 'user' ? '你' : '·')}
  </div>
  <div class="message-card-body">
    <div class="message-meta">
      <div class="message-meta-left">
        <span>
          {message?.tool?.kind === 'tool-call'
            ? '工具调用'
            : message?.tool?.kind === 'tool-result'
              ? '工具返回'
              : message?.role === 'assistant'
                ? 'ChatGPT'
                : (message?.role === 'user' ? '你' : (message?.name || message?.role || '消息'))}
        </span>
        {#if message?.tool}<code class="tool-message-name">{message.tool.name}</code>{/if}
        {#if (message?.siblingCount || 0) > 1}
          <span class="branch-control">
            <button
              type="button"
              aria-label="Previous branch"
              disabled={message.siblingIndex <= 0}
              onclick={() => onBranch(message.nodeId, -1)}
            >‹</button>
            <span>{message.siblingIndex + 1}/{message.siblingCount}</span>
            <button
              type="button"
              aria-label="Next branch"
              disabled={message.siblingIndex >= message.siblingCount - 1}
              onclick={() => onBranch(message.nodeId, 1)}
            >›</button>
          </span>
        {/if}
      </div>
      <div class="message-meta-right">
        {#if !message?.tool}
          <button
            type="button"
            class="message-action-btn"
            class:copied
            onclick={copyMessage}
            aria-label="复制消息"
          >{copied ? '已复制' : '复制'}</button>
        {/if}
      </div>
    </div>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="message-bubble" onclick={handleBubbleClick}>
      {#if message?.tool}
        <ToolPayloadBlock tool={message.tool} />
      {:else}
        <div class="message-markdown">{@html html}</div>
      {/if}
    </div>
  </div>
</div>
