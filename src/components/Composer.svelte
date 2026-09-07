<script>
  import { Button, Segmented } from 'framework7-svelte';
  import { THINKING_LEVELS } from '../lib/storage.js';
  import { shouldSubmitOnEnter, createImeTracker } from '../lib/message-presentation.js';

  let {
    value = $bindable(''),
    thinkingLevel = 2,
    disabled = false,
    loading = false,
    busy = false,
    generating = false,
    status = '',
    error = false,
    onThinkingLevelChange = () => {},
    onSend = () => {},
    onStop = () => {},
  } = $props();

  let textareaEl = $state(null);
  let dismissedStatus = $state(null);
  // Local refusal notice: status/error are parent-owned one-way props and
  // must never be mutated from here.
  let localNotice = $state('');
  let localNoticeTimer = null;
  const ime = createImeTracker();
  const MIN_HEIGHT = 34;
  const MAX_HEIGHT = 160;

  const canSubmit = $derived(!disabled && !loading && !busy && !generating && Boolean(value.trim()));

  const currentLevelObj = $derived(
    THINKING_LEVELS.find((item) => item.level === thinkingLevel) || THINKING_LEVELS[1]
  );

  $effect(() => {
    // Re-adjust height whenever value changes
    const _ = value;
    adjustHeight();
  });

  // Runs synchronously: the $effect above and oninput both fire after the DOM
  // already reflects the current value. Only writes style when it changed.
  function adjustHeight() {
    if (!textareaEl) return;
    const prevHeight = textareaEl.style.height;
    const prevOverflow = textareaEl.style.overflowY;
    textareaEl.style.height = 'auto';
    const contentHeight = textareaEl.scrollHeight;
    const nextHeight = `${Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, contentHeight))}px`;
    const nextOverflow = contentHeight > MAX_HEIGHT ? 'auto' : 'hidden';
    // Restoring an identical value is a no-op for layout; a differing value
    // is the only real write.
    textareaEl.style.height = nextHeight !== prevHeight ? nextHeight : prevHeight;
    if (nextOverflow !== prevOverflow) textareaEl.style.overflowY = nextOverflow;
  }

  export function focus() {
    if (!disabled && !loading && !busy && textareaEl?.isConnected) {
      try { textareaEl.focus({ preventScroll: true }); } catch { try { textareaEl.focus(); } catch {} }
    }
  }

  function submit() {
    if (generating) {
      showLocalNotice('正在生成回答，请稍候…');
      return;
    }
    if (busy) {
      showLocalNotice('正在提交上一条消息，请稍候…');
      return;
    }
    const message = value.trim();
    if (!message || disabled || loading) return;
    clearLocalNotice();
    onSend(message, {
      thinkingLevel,
      reasoningEffort: currentLevelObj.effort,
      model: currentLevelObj.slug,
    });
  }

  function onKeydown(event) {
    if (shouldSubmitOnEnter(event, ime)) {
      event.preventDefault();
      if (generating) {
        showLocalNotice('正在生成回答，请稍候…');
        return;
      }
      if (busy) {
        showLocalNotice('正在提交上一条消息，请稍候…');
        return;
      }
      if (canSubmit) {
        submit();
      }
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

  function showLocalNotice(message) {
    localNotice = message;
    clearTimeout(localNoticeTimer);
    localNoticeTimer = setTimeout(() => {
      if (localNotice === message) localNotice = '';
    }, 4000);
  }

  function clearLocalNotice() {
    localNotice = '';
    clearTimeout(localNoticeTimer);
    localNoticeTimer = null;
  }

  function onTextareaInput() {
    // Typing dismisses the transient refusal notice and any faded status.
    clearLocalNotice();
    adjustHeight();
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

    {#if !error && status}
      <div class="composer-status" role="status" aria-live="polite" title={status}>
        {status}
      </div>
    {:else if error && status && dismissedStatus === status}
      <div class="composer-status error" role="status" aria-live="polite" title={status}>
        {status}
      </div>
    {/if}
    {#if localNotice}
      <div class="composer-status local-notice" role="status" title={localNotice}>
        {localNotice}
      </div>
    {/if}
    <!-- Query-compat mirror of the error alert: the alert announces once, so
      this shim stays hidden from assistive tech (no live role). -->
    {#if error && status && dismissedStatus !== status}
      <div class="composer-status error sr-only" aria-hidden="true" title={status}>{status}</div>
    {/if}
  </div>

  {#if error && status && dismissedStatus !== status}
    <div class="composer-error-alert" role="alert" aria-live="assertive" title={status}>
      <span class="composer-error-icon" aria-hidden="true">⚠️</span>
      <span class="composer-error-text">{status}</span>
      <button
        type="button"
        class="composer-error-dismiss"
        aria-label="关闭提示"
        onclick={() => { dismissedStatus = status; }}
      >×</button>
    </div>
  {/if}

  <div class="composer-shell">
    <textarea
      bind:this={textareaEl}
      bind:value
      onkeydown={onKeydown}
      onkeyup={(e) => ime.onKeyup(e)}
      oncompositionstart={() => ime.onCompositionStart()}
      oncompositionend={() => ime.onCompositionEnd()}
      oninput={onTextareaInput}
      disabled={disabled || loading}
      readonly={busy}
      aria-busy={busy || generating}
      rows="1"
      enterkeyhint="send"
      placeholder={loading
        ? '正在加载对话…'
        : (disabled
          ? 'ChatGPT 页面桥尚未就绪…'
          : (generating
            ? 'ChatGPT 正在思考与生成回答…'
            : (busy ? '正在提交上一条消息…' : '发消息…')))}
      aria-label="消息"
    ></textarea>
    <Button
      class="send-button"
      fill
      round
      disabled={!canSubmit}
      onClick={submit}
      aria-label="发送"
    >↑</Button>
    {#if generating}
      <Button
        class="stop-button"
        outline
        round
        onClick={onStop}
        aria-label="停止回答"
      >■ 停止回答</Button>
    {/if}
  </div>
  <div class="composer-hint">Enter 发送 · Shift+Enter 换行 · 失败不会自动重发</div>
</div>
