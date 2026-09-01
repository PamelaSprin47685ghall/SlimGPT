<script>
  import { Button } from 'framework7-svelte';
  import { tick } from 'svelte';

  let {
    value = $bindable(''),
    disabled = false,
    loading = false,
    busy = false,
    status = '',
    error = false,
    onSend = () => {},
  } = $props();

  let textareaEl = $state(null);
  const MIN_HEIGHT = 34;
  const MAX_HEIGHT = 160;

  $effect(() => {
    // Re-adjust height whenever value changes
    const _ = value;
    adjustHeight();
  });

  async function adjustHeight() {
    await tick();
    if (!textareaEl) return;
    textareaEl.style.height = 'auto';
    const contentHeight = textareaEl.scrollHeight;
    const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, contentHeight));
    textareaEl.style.height = `${newHeight}px`;
    textareaEl.style.overflowY = contentHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }

  function submit() {
    const message = value.trim();
    if (!message || disabled || loading || busy) return;
    onSend(message);
  }

  function onKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }
</script>

<div class="composer-wrap">
  <div class:error class="composer-status" role="status" aria-live="polite">{status}</div>
  <div class="composer-shell">
    <textarea
      bind:this={textareaEl}
      bind:value
      onkeydown={onKeydown}
      oninput={adjustHeight}
      disabled={disabled || loading}
      aria-busy={busy}
      rows="1"
      placeholder={loading ? '正在加载对话…' : (disabled ? 'ChatGPT 页面桥尚未就绪…' : (busy ? '正在提交上一条消息…' : '发消息…'))}
      aria-label="Message"
    ></textarea>
    <Button
      class="send-button"
      fill
      round
      disabled={disabled || loading || busy || !value.trim()}
      onClick={submit}
      aria-label="Send"
    >↑</Button>
  </div>
  <div class="composer-hint">Enter 发送 · Shift+Enter 换行 · 失败不会自动重发</div>
</div>
