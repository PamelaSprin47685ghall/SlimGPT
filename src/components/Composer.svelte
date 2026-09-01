<script>
  import { Button } from 'framework7-svelte';
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
  }

  function onSliderKeydown(event) {
    if (disabled || loading || busy) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(5, thinkingLevel + 1);
      onThinkingLevelChange(next);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      const next = Math.max(1, thinkingLevel - 1);
      onThinkingLevelChange(next);
    }
  }
</script>

<div class="composer-wrap">
  <div class="composer-top-bar">
    <div
      class="thinking-slider-container"
      role="slider"
      tabindex="0"
      aria-label="思考强度滑块 (Thinking Slider)"
      aria-valuemin="1"
      aria-valuemax="5"
      aria-valuenow={thinkingLevel}
      aria-valuetext={`${currentLevelObj.label} (${currentLevelObj.cnLabel})`}
      onkeydown={onSliderKeydown}
    >
      <div class="thinking-level-badge" title={currentLevelObj.tip}>
        <span class="thinking-icon">{currentLevelObj.icon}</span>
        <span class="thinking-name">{currentLevelObj.label}</span>
        <span class="thinking-cn">{currentLevelObj.cnLabel}</span>
      </div>

      <div class="thinking-slider-track-wrap">
        <div class="thinking-track-bg"></div>
        <div
          class="thinking-progress-bar"
          style={`width: ${((thinkingLevel - 1) / 4) * 100}%`}
        ></div>

        <div class="thinking-ticks">
          {#each THINKING_LEVELS as item (item.level)}
            <button
              type="button"
              class="thinking-tick-btn"
              class:active={item.level === thinkingLevel}
              class:passed={item.level <= thinkingLevel}
              onclick={() => selectLevel(item.level)}
              title={`${item.label} (${item.cnLabel}) - ${item.tip}`}
              disabled={disabled || loading || busy}
              aria-label={`${item.label} ${item.cnLabel}`}
            >
              <span class="tick-dot"></span>
              <span class="tick-label">{item.label}</span>
            </button>
          {/each}
        </div>
      </div>

      <span class="thinking-tip-text">{currentLevelObj.tip}</span>
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
