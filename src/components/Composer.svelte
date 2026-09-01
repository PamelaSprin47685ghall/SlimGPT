<script>
  import { Button } from 'framework7-svelte';

  let {
    value = $bindable(''),
    disabled = false,
    busy = false,
    status = '',
    error = false,
    onSend = () => {},
  } = $props();

  function submit() {
    const message = value.trim();
    if (!message || disabled || busy) return;
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
      bind:value
      onkeydown={onKeydown}
      {disabled}
      aria-busy={busy}
      rows="1"
      placeholder={disabled ? 'ChatGPT 页面桥尚未就绪…' : (busy ? '正在提交上一条消息…' : '发消息…')}
      aria-label="Message"
    ></textarea>
    <Button
      class="send-button"
      fill
      round
      disabled={disabled || busy || !value.trim()}
      onClick={submit}
      aria-label="Send"
    >↑</Button>
  </div>
  <div class="composer-hint">Enter 发送 · Shift+Enter 换行 · 失败不会自动重发</div>
</div>
