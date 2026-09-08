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
    readonlyBranch = false,
    recentUserMessages = [],
    onThinkingLevelChange = () => {},
    onSend = () => {},
    onStop = () => {},
    onCancelSend = () => {},
    onReturnToLatestBranch = null,
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

  // In-flight send countdown (display only): mirrors the send watchdog window
  // so the waiting state shows honest progress. Restarts whenever `busy` flips.
  const SEND_WAIT_SECONDS = 30;
  let sendElapsed = $state(0);
  const sendRemaining = $derived(Math.max(0, SEND_WAIT_SECONDS - sendElapsed));

  // ArrowUp/Down history recall: index into recentUserMessages, -1 = idle.
  // Any edit resets the browse position.
  let historyIndex = $state(-1);
  let historyDraft = $state('');

  const canSubmit = $derived(!disabled && !loading && !busy && !generating && !readonlyBranch && Boolean(value.trim()));
  // Reasons-not-dead-buttons: the slot stays clickable; this only drives the
  // `aria-disabled` + `.composer-send-disabled` look. Real guards live in submit().
  const sendAriaDisabled = $derived(generating ? (disabled || loading) : !canSubmit);
  const sendTitle = $derived(readonlyBranch ? '当前正在只读查看历史分支；请切回最新分支后再发送' : '发送');
  const showCharCount = $derived(value.length > 500);
  const charCountWarn = $derived(value.length > 30000);

  $effect(() => {
    if (!busy) {
      sendElapsed = 0;
      return;
    }
    sendElapsed = 0;
    const timer = setInterval(() => {
      sendElapsed += 1;
    }, 1000);
    return () => clearInterval(timer);
  });

  // A new history list (message update or conversation switch) ends browsing.
  $effect(() => {
    const _ = recentUserMessages;
    historyIndex = -1;
    historyDraft = '';
  });

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
    if (readonlyBranch) {
      showLocalNotice('当前正在只读查看历史分支；请切回最新分支后再发送');
      return;
    }
    if (generating) {
      showLocalNotice('正在生成回答，请稍候…');
      return;
    }
    if (busy) {
      showLocalNotice('正在提交上一条消息，请稍候…');
      return;
    }
    if (disabled) {
      showLocalNotice('ChatGPT 页面桥尚未就绪，稍候再试');
      return;
    }
    if (loading) {
      showLocalNotice('正在加载对话，请稍候…');
      return;
    }
    const message = value.trim();
    if (!message) {
      showLocalNotice('消息为空，未发送');
      return;
    }
    clearLocalNotice();
    onSend(message, {
      thinkingLevel,
      reasoningEffort: currentLevelObj.effort,
      model: currentLevelObj.slug,
    });
  }

  // Structural send slot: `.composer-shell .send-button` ALWAYS exists so a
  // programmatic `.click()` never throws on a missing node. The slot never
  // uses the HTML `disabled` attribute (it would swallow clicks); instead
  // `aria-disabled` + `.composer-send-disabled` render the disabled look
  // while every click still reaches submit()/onStop so the exact refusal
  // reason surfaces as a notice. In generating mode the same 34px slot
  // becomes the stop control (stop-mode class, ■ icon, onStop action,
  // aria-disabled only on bridge/loading); in send mode it keeps the
  // readonly reason via submit().
  function handleSlotClick() {
    if (generating) {
      if (disabled || loading) {
        showLocalNotice('ChatGPT 页面桥尚未就绪，稍候再试');
        return;
      }
      onStop();
      return;
    }
    submit();
  }

  function onKeydown(event) {
    if (recallHistory(event)) return;
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
    // Any edit resets the ArrowUp/Down history browse position.
    historyIndex = -1;
    adjustHeight();
  }

  function afterHistoryJump() {
    adjustHeight();
    queueMicrotask(() => {
      if (!textareaEl?.isConnected) return;
      try {
        textareaEl.focus({ preventScroll: true });
        const end = textareaEl.value.length;
        textareaEl.setSelectionRange(end, end);
      } catch {}
    });
  }

  // Caret-line predicates (pure; mirrored in tests/composer-converge5.test.js):
  // first line ⇔ no '\n' before selectionStart; last line ⇔ no '\n' after it.
  function isCaretOnFirstLine(text, selectionStart) {
    const value = String(text || '');
    const index = Math.max(0, Math.min(selectionStart ?? value.length, value.length));
    return !value.slice(0, index).includes('\n');
  }

  function isCaretOnLastLine(text, selectionStart) {
    const value = String(text || '');
    const index = Math.max(0, Math.min(selectionStart ?? value.length, value.length));
    return !value.slice(index).includes('\n');
  }

  // Caret-aware history recall: ArrowUp recalls only from the first line,
  // ArrowDown advances only from the last line. Any other caret position or
  // a non-collapsed selection keeps native caret movement so cursor motion
  // never destroys edited text. Typing exits recall mode (onTextareaInput).
  // Returns true when handled.
  function recallHistory(event) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (ime.isComposing) return false;
    const list = Array.isArray(recentUserMessages) ? recentUserMessages : [];
    if (!list.length) return false;
    if (textareaEl?.isConnected) {
      const start = textareaEl.selectionStart ?? value.length;
      const end = textareaEl.selectionEnd ?? value.length;
      if (start !== end) return false;
      if (event.key === 'ArrowUp' && !isCaretOnFirstLine(value, start)) return false;
      if (event.key === 'ArrowDown' && !isCaretOnLastLine(value, start)) return false;
    } else if (event.key === 'ArrowUp' && historyIndex === -1 && value !== '') {
      // No caret info (unfocused): keep the old empty-only behavior so a
      // blind recall never clobbers an edited draft.
      return false;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (historyIndex === -1) {
        historyDraft = value;
        historyIndex = list.length - 1;
      } else {
        historyIndex = Math.max(0, Math.min(historyIndex, list.length - 1) - 1);
      }
      value = list[historyIndex] ?? '';
      afterHistoryJump();
      return true;
    }
    if (historyIndex === -1) return false;
    event.preventDefault();
    if (historyIndex >= list.length - 1) {
      historyIndex = -1;
      value = historyDraft;
    } else {
      historyIndex = Math.min(historyIndex + 1, list.length - 1);
      value = list[historyIndex] ?? '';
    }
    afterHistoryJump();
    return true;
  }

  function hasFilePayload(transfer) {
    if (!transfer) return false;
    if (transfer.files && transfer.files.length > 0) return true;
    try {
      return Array.from(transfer.types || []).includes('Files');
    } catch {
      return false;
    }
  }

  // Image/file payloads are guided, never silently swallowed.
  function onPaste(event) {
    const transfer = event.clipboardData;
    if (!hasFilePayload(transfer)) return;
    let text = '';
    try { text = transfer.getData('text/plain'); } catch {}
    if (!text) event.preventDefault();
    showLocalNotice('纯文本模式暂不支持图片/文件，请在官方界面上传');
  }

  function onDrop(event) {
    const transfer = event.dataTransfer;
    if (!hasFilePayload(transfer)) return;
    let text = '';
    try { text = transfer.getData('text/plain'); } catch {}
    if (!text) event.preventDefault();
    showLocalNotice('纯文本模式暂不支持图片/文件，请在官方界面上传');
  }

  function onDragOver(event) {
    if (hasFilePayload(event.dataTransfer)) event.preventDefault();
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
      <div class="composer-thinking-caption">部分模型忽略此设置（仅推理模型生效）</div>
    </div>

    {#if busy}
      <div class="composer-sending" role="status" title="正在等待官方输入框确认">
        <span>发送中…{sendRemaining}s（超时自动取消）</span>
        <button type="button" class="composer-cancel-send-btn" onclick={() => onCancelSend()} title="不再等待，直接按发送失败处理（草稿保留）">取消等待</button>
      </div>
    {/if}
    {#if showCharCount}
      <span class="composer-char-count" class:composer-char-warn={charCountWarn} title={charCountWarn ? '内容较长（超过 30000 字），发送可能较慢' : `${value.length} 字`}>{value.length} 字</span>
    {/if}
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
      <span class="composer-error-hint">请在上方失败卡片重试或改写</span>
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
      onpaste={onPaste}
      ondrop={onDrop}
      ondragover={onDragOver}
      disabled={disabled || loading}
      readonly={busy}
      aria-busy={busy || generating}
      rows="1"
      enterkeyhint="send"
      placeholder={loading
        ? '正在加载对话…'
        : (disabled
          ? 'ChatGPT 页面桥尚未就绪…'
          : (readonlyBranch
            ? '只读查看分支中…'
            : (generating
              ? 'ChatGPT 正在思考与生成回答…'
              : (busy ? '正在提交上一条消息…' : '问点什么…（Enter 发送，Shift + Enter 换行）'))))}
      aria-label="消息"
    ></textarea>
    {#if readonlyBranch}
      <button
        type="button"
        class="composer-branch-return-btn"
        onclick={() => onReturnToLatestBranch?.()}
        title="回到最新分支以继续发送"
      >回到最新分支</button>
    {/if}
      <Button
      class={`send-button${generating ? ' stop-mode stop-button' : ''}${sendAriaDisabled ? ' composer-send-disabled' : ''}`}
        fill
        round
      style={generating ? 'font-size: 13px;' : undefined}
      aria-disabled={sendAriaDisabled}
      onClick={handleSlotClick}
      aria-label={generating ? '停止回答' : '发送'}
      title={generating ? '停止回答' : sendTitle}
    >{generating ? '■' : '↑'}</Button>
  </div>
  <div class="composer-hint">Enter 发送，Shift + Enter 换行 · 失败不会自动重发</div>
</div>

<style>
  /* Floating modern card aesthetic */
  :global(.composer-wrap) {
    background: transparent !important;
    border-top: none !important;
    padding-top: 10px !important;
  }
  :global(.composer-shell) {
    border-radius: 16px !important;
    border: 1px solid color-mix(in srgb, var(--slim-line) 85%, transparent) !important;
    background: var(--slim-surface) !important;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05), 0 1px 3px rgba(0, 0, 0, 0.02) !important;
    padding: 8px 10px 8px 16px !important;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease !important;
  }
  :global(.composer-shell:focus-within) {
    border-color: var(--f7-theme-color) !important;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08), 0 0 0 2px color-mix(in srgb, var(--f7-theme-color) 25%, transparent) !important;
  }
  :global(.composer-shell textarea) {
    font-size: 14px;
    line-height: 20px !important;
  }
  :global(.composer-shell textarea::placeholder) {
    color: var(--slim-muted) !important;
    opacity: 0.7 !important;
  }
  :global(.send-button) {
    width: 32px !important;
    height: 32px !important;
    min-width: 32px !important;
    border-radius: 50% !important;
    background: var(--f7-theme-color) !important;
    color: #ffffff !important;
    box-shadow: 0 2px 6px color-mix(in srgb, var(--f7-theme-color) 35%, transparent) !important;
    transition: all 0.15s ease !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
  }
  :global(.send-button:not(.composer-send-disabled):hover) {
    transform: scale(1.05);
    box-shadow: 0 3px 8px color-mix(in srgb, var(--f7-theme-color) 50%, transparent) !important;
  }
  :global(.send-button.stop-mode) {
    background: #cf6258 !important;
    box-shadow: 0 2px 6px rgba(207, 98, 88, 0.35) !important;
  }
  :global(.send-button.stop-mode:hover) {
    transform: scale(1.05);
    box-shadow: 0 3px 8px rgba(207, 98, 88, 0.5) !important;
  }
  :global(.composer-send-disabled) {
    opacity: 0.35 !important;
    cursor: not-allowed !important;
    box-shadow: none !important;
  }
  :global(.thinking-segmented) {
    border-radius: 999px !important;
    padding: 3px !important;
    background: color-mix(in srgb, var(--slim-soft) 85%, var(--slim-surface)) !important;
    border: 1px solid color-mix(in srgb, var(--slim-line) 75%, transparent) !important;
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.04) !important;
  }
  :global(.thinking-segmented .button) {
    height: 26px !important;
    font-size: 11px !important;
    border-radius: 999px !important;
    font-weight: 550 !important;
    padding: 0 8px !important;
    transition: all 0.15s ease !important;
  }
  :global(.thinking-segmented .button-active) {
    background: var(--slim-surface) !important;
    color: var(--f7-theme-color) !important;
    font-weight: 650 !important;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1) !important;
  }
  :global(.composer-hint) {
    font-size: 11px !important;
    color: var(--slim-muted) !important;
    opacity: 0.75 !important;
    margin-top: 6px !important;
  }
  :global(.thinking-control-label) {
    font-size: 11px !important;
    font-weight: 600 !important;
  }
  :global(.thinking-control-copy strong) {
    font-size: 11.5px !important;
    font-weight: 700 !important;
  }
  :global(.thinking-control-tip) {
    font-size: 11px !important;
    opacity: 0.8 !important;
  }
</style>
