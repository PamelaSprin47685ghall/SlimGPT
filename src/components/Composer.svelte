<script>
  import { Button, Segmented } from 'framework7-svelte';
  import { tick } from 'svelte';
  import { THINKING_LEVELS } from '../lib/storage.js';

  let {
    value = $bindable(''),
    thinkingLevel = 2,
    disabled = false,
    loading = false,
    busy = false,
    status = '',
    error = false,
    onThinkingLevelChange = () => {},
    onSend = () => {},
  } = $props();

  let textareaEl = $state(null);
  const MIN_HEIGHT = 34;
  const MAX_HEIGHT = 160;

  const currentLevelObj = $derived(
    THINKING_LEVELS.find((item) => item.level === thinkingLevel) || THINKING_LEVELS[1]
  );

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
    onSend(message, {
      thinkingLevel,
      reasoningEffort: currentLevelObj.effort,
      model: currentLevelObj.slug,
    });
  }

  function onKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function selectLevel(level) {
    if (disabled || loading || busy) return;
    onThinkingLevelChange(level);
    queueMicrotask(() => {
      document.querySelector(`.thinking-segmented [data-thinking-level="${level}"]`)?.focus();
    });
  }

  function onLevelKeydown(event) {
    if (disabled || loading || busy) return;
    let next = thinkingLevel;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      next = Math.min(5, thinkingLevel + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      next = Math.max(1, thinkingLevel - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      next = 1;
    } else if (event.key === 'End') {
      event.preventDefault();
      next = 5;
    } else {
      return;
    }
    selectLevel(next);
  }

  function optionLabel(level) {
    return ['即时', '标准', '深入', '专家', 'Pro'][level - 1] || '';
  }
</script>

<div class="composer-wrap">
  <div class="composer-top-bar">
    <div class="thinking-control" aria-label="思考强度">
      <div class="thinking-control-copy">
        <span class="thinking-control-label">思考强度</span>
        <strong>{currentLevelObj.cnLabel}</strong>
        <span class="thinking-control-tip">{currentLevelObj.tip}</span>
      </div>
      <Segmented
        strong
        round
        class="thinking-segmented"
        role="radiogroup"
        aria-label="选择思考强度"
        onkeydown={onLevelKeydown}
      >
        {#each THINKING_LEVELS as item (item.level)}
          <Button
            small
            active={item.level === thinkingLevel}
            data-thinking-level={item.level}
            role="radio"
            aria-checked={item.level === thinkingLevel}
            aria-label={`${item.label}，${item.tip}`}
            title={item.tip}
            tabindex={item.level === thinkingLevel ? 0 : -1}
            disabled={disabled || loading || busy}
            onClick={() => selectLevel(item.level)}
          >{optionLabel(item.level)}</Button>
        {/each}
      </Segmented>
    </div>

    <div class:error class="composer-status" role="status" aria-live="polite">{status}</div>
  </div>

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
