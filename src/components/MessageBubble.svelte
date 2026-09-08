<script>
  import { onDestroy } from 'svelte';
  // eslint-disable-next-line
  import IncrementalMarkdown from './IncrementalMarkdown.svelte';
  import ToolPayloadBlock from './ToolPayloadBlock.svelte';
  import { copyText } from '../lib/clipboard.js';
  import { calculateReadingMinutes, formatMessageTimestamp, formatModelLabel, humanizeError, isDuplicateErrorDetail, isMessageStreaming, isTerminalMessage } from '../lib/message-presentation.js';
  import { getOrderedMessageSources, safeReferenceUrl } from '../lib/content-references.js';
  import { THINKING_LEVELS } from '../lib/storage.js';

  let {
    message,
    onRetry = () => {},
    onEdit = () => {},
    onDismiss = () => {},
    onBranch = () => {},
    onQuote = () => {},
    branchDisabled = false,
  } = $props();

  let copied = $state(false);
  let copyError = $state(false);
  let thoughtCopied = $state(false);
  let thoughtCopyError = $state(false);
  let thoughtCopyTimer = null;
  let userToggled = $state(false);
  let thoughtManualState = $state(false);
  let copyTimer = null;
  const codeCopyTimers = new Map();
  let previousMessageKey = null;
  const messageKey = $derived(message?.observationKey || message?.itemId || message?.nodeId || message?.id || null);

  // Live thinking ticker
  let liveThinkingSeconds = $state(0);
  let tickerTimer = null;

  // Fold long text state (>1500 chars)
  let isFolded = $state(true);

  // Sources list folding state
  let sourcesOpen = $state(false);

  // Lightbox state
  let lightboxSrc = $state(null);
  let lightboxAlt = $state('');

  $effect(() => {
    const key = messageKey;
    if (key === previousMessageKey) return;
    previousMessageKey = key;
    userToggled = false;
    thoughtManualState = false;
    copied = false;
    copyError = false;
    thoughtCopied = false;
    thoughtCopyError = false;
    isFolded = true;
    sourcesOpen = false;
    lightboxSrc = null;
    clearTimeout(copyTimer);
    clearTimeout(thoughtCopyTimer);
  });

  const hasText = $derived(Boolean(String(message?.text || '').trim()));
  const hasThought = $derived(Boolean(String(message?.thought || '').trim()));
  const isThinking = $derived(Boolean(message?.isThinking && !message?.error && !isTerminalMessage(message)));
  const isStreaming = $derived(isMessageStreaming(message));
  const isError = $derived(Boolean(message?.error || message?.status === 'failed'));
  const unrecognized = $derived(Boolean(!hasText && !hasThought && !message?.tool && !isThinking && !isError && message?.unrecognized));
  const isUser = $derived(message?.role === 'user');

  const thoughtOpen = $derived(userToggled ? thoughtManualState : (!hasText || isThinking));

  const isLong = $derived((message?.text?.length || 0) > 1500);
  const shouldCollapse = $derived(isLong && isFolded && !isStreaming);

  const thinkingActive = $derived(
    !message?.tool &&
    (isThinking || (hasThought && isStreaming && !message?.endTurn)) &&
    !message?.thinkingDuration
  );

  $effect(() => {
    if (thinkingActive) {
      const startMs = message?.createTime
        ? (message.createTime < 10_000_000_000 ? message.createTime * 1000 : message.createTime)
        : Date.now();
      const updateSec = () => {
        liveThinkingSeconds = Math.max(1, Math.floor((Date.now() - startMs) / 1000));
      };
      updateSec();
      clearInterval(tickerTimer);
      tickerTimer = setInterval(updateSec, 1000);
    } else {
      clearInterval(tickerTimer);
      tickerTimer = null;
      liveThinkingSeconds = 0;
    }
  });

  const sources = $derived.by(() => {
    return getOrderedMessageSources(message);
  });

  function toggleThought() {
    thoughtManualState = !thoughtOpen;
    userToggled = true;
  }

  let lightboxCloseBtn = $state(null);
  let retryChevronBtn = $state(null);
  let retryMenuContainer = $state(null);
  let lastThumbFocused = null;
  let retryMenuOpen = $state(false);
  let highlightSourceIndex = $state(-1);
  let highlightTimer = null;

  function isSafeImageSrc(src) {
    if (!src || typeof src !== 'string') return false;
    const trimmed = src.trim();
    return trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('blob:');
  }

  function openLightbox(imgEl) {
    if (!imgEl || !imgEl.src) return;
    if (typeof window !== 'undefined') window.__slimgptLightboxOpen = true;
    lastThumbFocused = imgEl;
    lightboxSrc = imgEl.src;
    lightboxAlt = imgEl.alt || '预览图片';
    // Move focus into close button on open
    setTimeout(() => {
      try { lightboxCloseBtn?.focus?.(); } catch {}
    }, 0);
  }

  function closeLightbox() {
    if (typeof window !== 'undefined') window.__slimgptLightboxOpen = false;
    lightboxSrc = null;
    lightboxAlt = '';
    // Restore focus to the thumbnail on close
    const thumb = lastThumbFocused;
    lastThumbFocused = null;
    if (thumb && typeof thumb.focus === 'function' && document.contains(thumb)) {
      setTimeout(() => {
        try { thumb.focus(); } catch {}
      }, 0);
    }
  }

  function handleKeydown(e) {
    if (!lightboxSrc) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      closeLightbox();
      return;
    }
    if (e.key === 'Tab') {
      const scrim = e.currentTarget;
      if (!scrim) return;
      const focusables = Array.from(
        scrim.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0);

      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !scrim.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !scrim.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  function closeRetryMenu(restoreFocus = false) {
    if (!retryMenuOpen) return;
    retryMenuOpen = false;
    if (restoreFocus) {
      try { retryChevronBtn?.focus?.(); } catch {}
    }
  }

  function handleRetryMenuKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      closeRetryMenu(true);
    }
  }

  $effect(() => {
    if (!retryMenuOpen) return;
    const handleOutsidePointer = (event) => {
      if (retryChevronBtn?.contains?.(event.target)) return;
      if (retryMenuContainer?.contains?.(event.target)) return;
      closeRetryMenu(false);
    };
    document.addEventListener('pointerdown', handleOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer, true);
    };
  });

  function quoteFullMessage() {
    const text = String(message?.text || (message?.thought ? message.thought : ''));
    if (!text.trim()) return;
    const quoteLines = text.trim().split('\n').map((line) => `> ${line}`).join('\n') + '\n\n';
    onQuote(quoteLines);
  }

  function jumpToSource(index) {
    // Ensure sources list is open, then smooth-scroll + highlight the card
    sourcesOpen = true;
    highlightSourceIndex = index;
    clearTimeout(highlightTimer);
    highlightTimer = setTimeout(() => { highlightSourceIndex = -1; }, 1600);
    setTimeout(() => {
      const el = document.querySelector(`[data-message-id="${message?.id}"] .message-source-item[data-source-index="${index}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 30);
  }

  onDestroy(() => {
    if (typeof window !== 'undefined' && lightboxSrc) window.__slimgptLightboxOpen = false;
    clearTimeout(copyTimer);
    clearTimeout(thoughtCopyTimer);
    clearTimeout(highlightTimer);
    clearInterval(tickerTimer);
    for (const timer of codeCopyTimers.values()) clearTimeout(timer);
    codeCopyTimers.clear();
  });

  async function copyMessage() {
    const key = messageKey;
    const text = String(message?.text || (message?.thought ? message.thought : ''));
    if (!text) return;
    try {
      await copyText(text);
      if (key !== messageKey) return;
      copied = true;
      copyError = false;
    } catch {
      if (key !== messageKey) return;
      copied = false;
      copyError = true;
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied = false; copyError = false; }, 2400);
  }

  async function copyThought(e) {
    e?.stopPropagation?.();
    const key = messageKey;
    const text = String(message?.thought || '');
    if (!text) return;
    try {
      await copyText(text);
      if (key !== messageKey) return;
      thoughtCopied = true;
      thoughtCopyError = false;
    } catch {
      if (key !== messageKey) return;
      thoughtCopied = false;
      thoughtCopyError = true;
    }
    clearTimeout(thoughtCopyTimer);
    thoughtCopyTimer = setTimeout(() => { thoughtCopied = false; thoughtCopyError = false; }, 2400);
  }

  async function handleBubbleClick(event) {
    const img = event.target?.closest?.('.message-markdown img');
    if (img && img.src) {
      openLightbox(img);
      return;
    }
    const citation = event.target?.closest?.('.citation-badge');
    if (citation && citation.textContent) {
      const match = citation.textContent.trim().match(/来源\s*(\d+)/);
      if (match) {
        const idx = Number(match[1]) - 1;
        if (idx >= 0 && idx < sources.length) {
          event.preventDefault();
          event.stopPropagation();
          jumpToSource(idx);
          return;
        }
      }
    }
    const copyBtn = event.target?.closest?.('.code-copy-btn');
    if (!copyBtn) return;
    const codeBlock = copyBtn.closest('.code-block');
    const code = codeBlock?.querySelector('pre code')?.textContent || '';
    if (!code || !code.trim()) {
      copyBtn.textContent = '无代码';
      copyBtn.setAttribute('aria-label', '代码内容为空');
      clearTimeout(codeCopyTimers.get(copyBtn));
      codeCopyTimers.set(copyBtn, setTimeout(() => {
        copyBtn.textContent = '复制';
        copyBtn.setAttribute('aria-label', '复制代码');
        codeCopyTimers.delete(copyBtn);
      }, 2400));
      return;
    }
    let succeeded = false;
    try {
      await copyText(code);
      succeeded = true;
    } catch {
      // Report failure rather than silently claiming success or rejecting an
      // unobserved clipboard promise.
    }
    if (!copyBtn.isConnected) return;
    copyBtn.textContent = succeeded ? '已复制' : '复制失败';
    copyBtn.setAttribute('aria-label', succeeded ? '已复制代码' : '复制代码失败');
    copyBtn.classList.toggle('copied', succeeded);
    clearTimeout(codeCopyTimers.get(copyBtn));
    codeCopyTimers.set(copyBtn, setTimeout(() => {
      copyBtn.textContent = '复制';
      copyBtn.setAttribute('aria-label', '复制代码');
      copyBtn.classList.remove('copied');
      codeCopyTimers.delete(copyBtn);
    }, 2400));
  }

  const errorDetail = $derived.by(() => {
    if (!isError) return '';
    const msgErr = message?.error;
    if (typeof msgErr === 'string' && msgErr.trim()) return msgErr.trim();
    if (typeof msgErr?.message === 'string' && msgErr.message.trim()) return msgErr.message.trim();
    if (typeof msgErr?.detail === 'string' && msgErr.detail.trim()) return msgErr.detail.trim();
    const metaErr = message?.metadata?.error;
    if (typeof metaErr === 'string' && metaErr.trim()) return metaErr.trim();
    if (typeof metaErr?.message === 'string' && metaErr.message.trim()) return metaErr.message.trim();
    if (typeof metaErr?.detail === 'string' && metaErr.detail.trim()) return metaErr.detail.trim();
    return '';
  });

  const errorHumanSummary = $derived(humanizeError(message?.error || errorDetail || '消息生成失败或被官方界面中断'));

  // Long user messages get bottom toolbar (edit/copy), assistant bottom toolbar always visible
  const showBottomToolbar = $derived.by(() => {
    if (message?.tool) return isError;
    // Peer P1: floating mini action bar for EVERY message incl. short user ones
    // (remove the >300-char gate)
    return true;
  });
  const errorDetailDuplicate = $derived(isDuplicateErrorDetail(errorHumanSummary, errorDetail));
  const timestamp = $derived(formatMessageTimestamp(message?.createTime ?? message?.create_time ?? message?.timestamp));
  const readingMinutes = $derived(!isUser && hasText ? calculateReadingMinutes(String(message?.text || '')) : 0);
  const showReadingMinutes = $derived(!isUser && hasText && (String(message?.text || '').length >= 500) && readingMinutes >= 1);
</script>

<svelte:window onkeydown={lightboxSrc ? handleKeydown : null} />

<div
  class={`message-card role-${message?.role || 'unknown'} ${message?.tool?.kind || ''} ${isError ? 'is-error' : ''}`}
  data-message-id={message?.id}
  data-owner-user-id={message?.ownership?.userMessageId || undefined}
  data-item-id={message?.itemId || undefined}
  data-message-phase={message?.phase || undefined}
>
  <div class="message-avatar" aria-hidden="true">
    {#if message?.tool?.kind === 'tool-call'}
      ↗
    {:else if message?.tool?.kind === 'tool-result'}
      ↙
    {:else if message?.role === 'assistant'}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <path d="M22.28 9.87a5.98 5.98 0 0 0-.52-4.92 6.05 6.05 0 0 0-4.39-2.9 6 6 0 0 0-5.18 1.48 6.06 6.06 0 0 0-4.22.42 6.02 6.02 0 0 0-3.03 4.14 6.03 6.03 0 0 0 .74 5.34 6 6 0 0 0 .52 4.92 6.05 6.05 0 0 0 4.39 2.9 6 6 0 0 0 5.18-1.48 6.06 6.06 0 0 0 4.22-.42 6.02 6.02 0 0 0 3.03-4.14 6.03 6.03 0 0 0-.74-5.34zm-8.8 10.74a4.5 4.5 0 0 1-2.9-.11 4.54 4.54 0 0 1-.36-.18l3.18-1.84a.75.75 0 0 0 .38-.65v-4.48l1.35.78v4.46a4.53 4.53 0 0 1-1.65 2.02zm-7.7-3.23a4.5 4.5 0 0 1-.32-2.88c.15-.55.4-1.06.75-1.5l3.19 1.84a.75.75 0 0 0 .75 0l3.88-2.24v1.56l-3.87 2.23a4.53 4.53 0 0 1-4.38.99zm-1.44-8.03c.27-.49.63-.92 1.07-1.25l3.18 1.84a.75.75 0 0 0 .75 0l3.88-2.24-1.35-.78-3.87 2.23a4.52 4.52 0 0 1-3.66.2zm14.33 3.32l-3.88 2.24v-1.56l3.87-2.24a4.52 4.52 0 0 1 3.66-.2c.49.27.92.63 1.25 1.07a4.5 4.5 0 0 1 .32 2.88 4.55 4.55 0 0 1-.75 1.5l-3.19-1.84a.75.75 0 0 0-.75 0zm2.25-3.03a4.52 4.52 0 0 1-1.25-1.07l-3.18 1.84a.75.75 0 0 0-.38.65v4.48l-1.35-.78v-4.46a4.53 4.53 0 0 1 1.65-2.02 4.5 4.5 0 0 1 2.9.11c.56.2 1.06.53 1.48.97l-.02.04zm-9.35.34l1.73 1-1.73 1-1.73-1 1.73-1z"/>
      </svg>
    {:else if message?.role === 'user'}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
        <circle cx="12" cy="7" r="4"></circle>
      </svg>
    {:else if message?.role === 'system'}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    {:else}
      ·
    {/if}
  </div>

  <div class="message-card-body">
    <div class="message-meta">
      <div class="message-meta-left">
        <span class="message-author-name">
          {#if message?.tool?.kind === 'tool-call'}
            工具调用
          {:else if message?.tool?.kind === 'tool-result'}
            工具返回
          {:else if message?.role === 'assistant'}
            ChatGPT
          {:else if message?.role === 'user'}
            你
          {:else if message?.role === 'system'}
            系统消息
          {:else}
            {message?.name || message?.role || '消息'}
          {/if}
        </span>

        {#if !isUser && !message?.tool && message?.thinkingLevel && (hasThought || message?.reasoningEffort)}
          <span class="meta-badge thinking-badge" title={message.thinkingLevel.tip}>
            {message.thinkingLevel.icon} {message.thinkingLevel.label}
          </span>
        {/if}
        {#if !isUser && message?.model}
          <span class="meta-badge model-badge" title={message.model}>{formatModelLabel(message.model)}</span>
        {/if}

        {#if message?.tool}
          <code class="tool-message-name">{message.tool.name}</code>
          {#if message.tool.title}
            <span class="tool-message-title" title={message.tool.title}>{message.tool.title}</span>
          {/if}
        {/if}

        {#if isError}
          <span class="meta-badge error-badge">生成异常</span>
        {/if}

        {#if (message?.siblingCount || 0) > 1}
          <span class="branch-control">
            <button
              type="button"
              aria-label="上一分支"
              disabled={branchDisabled || message.siblingIndex <= 0}
              title={branchDisabled ? '生成中，完成后可切换分支' : '上一分支'}
              onclick={() => onBranch(message.nodeId, -1)}
            >‹</button>
            <span>{message.siblingIndex + 1}/{message.siblingCount}</span>
            <button
              type="button"
              aria-label="下一分支"
              disabled={branchDisabled || message.siblingIndex >= message.siblingCount - 1}
              title={branchDisabled ? '生成中，完成后可切换分支' : '下一分支'}
              onclick={() => onBranch(message.nodeId, 1)}
            >›</button>
          </span>
        {/if}
      </div>

      <div class="message-meta-right">
        {#if timestamp.time}
          <span class="message-timestamp" title={timestamp.full}>{timestamp.time}</span>
        {/if}
      </div>
    </div>

    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="message-bubble" onclick={handleBubbleClick}>
      {#if hasThought}
        <div class="thought-block" class:open={thoughtOpen}>
          <div class="thought-header">
            <button
              type="button"
              class="thought-toggle-btn"
              onclick={toggleThought}
              aria-expanded={thoughtOpen}
            >
              <span class="thought-pulse-indicator" class:pulsing={thinkingActive}>
                {#if thinkingActive}
                  <span class="thought-pulse-ring"></span>
                  <span class="thought-pulse-core"></span>
                {:else}
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"></path>
                    <line x1="9" y1="21" x2="15" y2="21"></line>
                  </svg>
                {/if}
              </span>
              <span class="thought-title">{thinkingActive ? '思考中…' : '深度思考'}</span>
              {#if thinkingActive && liveThinkingSeconds > 0}
                <span class="thought-duration">（已思考 {liveThinkingSeconds} 秒）</span>
              {:else if message?.thinkingDuration}
                <span class="thought-duration">（用时 {message.thinkingDuration}）</span>
              {/if}
              <span class="thought-toggle" class:rotated={thoughtOpen}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </span>
            </button>
            <button
              type="button"
              class="thought-copy-btn"
              class:copied={thoughtCopied}
              onclick={copyThought}
              aria-label={thoughtCopied ? '已复制思考过程' : thoughtCopyError ? '复制失败' : '复制思考过程'}
              aria-live="polite"
              title="复制思考过程"
            >{thoughtCopied ? '已复制' : thoughtCopyError ? '复制失败' : '复制思考过程'}</button>
          </div>
          <div class="thought-content-wrapper" hidden={!thoughtOpen} aria-hidden={!thoughtOpen}>
            <IncrementalMarkdown class="thought-content" source={message.thought} streaming={isStreaming} />
          </div>
        </div>
      {/if}

      {#if message?.tool}
        <ToolPayloadBlock tool={message.tool} message={message} streaming={isStreaming} {isError} />
      {:else if hasText}
      <div class="message-text-container" class:is-collapsed={shouldCollapse}>
        <IncrementalMarkdown source={message.text} streaming={isStreaming} />
        </div>
      {#if isLong}
        <div class="message-collapse-bar">
          <button
            type="button"
            class="message-collapse-btn"
            onclick={() => { isFolded = !isFolded; }}
            aria-expanded={!isFolded}
          >
            {isFolded ? '展开全部 ▼' : '收起 ▲'}
          </button>
        </div>
      {/if}
      {:else if !message?.tool && hasThought && isStreaming && !message?.endTurn}
        <div class="thinking-indicator" role="status" aria-live="polite">
          <span class="thinking-spinner" aria-hidden="true"></span>
        <span>思考中 {liveThinkingSeconds > 0 ? `${liveThinkingSeconds}s…` : '…'}</span>
      </div>
      {:else if !message?.tool && isThinking}
        <div class="thinking-indicator" role="status" aria-live="polite">
          <span class="thinking-spinner" aria-hidden="true"></span>
        <span>{liveThinkingSeconds > 0 ? `思考中 ${liveThinkingSeconds}s…` : 'ChatGPT 正在思考与生成…'}</span>
      </div>
      {:else if !message?.tool && unrecognized}
        <div class="unrecognized-notice">
          <strong>官方消息（非文本内容）</strong>
          <span>这条消息包含 SlimGPT 尚未识别的内容类型，已原样保留。可点击「暂时显示官方界面」查看完整内容。</span>
        </div>
      {:else if !message?.tool && !hasThought}
        <div class="empty-notice">（无文字内容）</div>
      {/if}

      {#if isError}
        <div class="error-footer-banner" role="alert">
          <div class="error-banner-main">
            <span class="error-banner-icon">⚠️</span>
          <span class="error-banner-title">{errorHumanSummary}</span>
        </div>
          {#if errorDetail && !errorDetailDuplicate}
          <details class="error-banner-details">
            <summary class="error-banner-summary">原始错误详情</summary>
            <div class="error-banner-detail">{errorDetail}</div>
          </details>
          {/if}
          </div>
      {/if}

      {#if sources.length > 0}
      <div class="message-sources-block">
        <button
          type="button"
          class="message-sources-toggle"
          onclick={() => { sourcesOpen = !sourcesOpen; }}
          aria-expanded={sourcesOpen}
        >
          <span class="message-sources-icon">📚</span>
          <span class="message-sources-title">参考来源 ({sources.length})</span>
          <span class="message-sources-arrow">{sourcesOpen ? '收起 ▲' : '展开 ▼'}</span>
        </button>
        {#if sourcesOpen}
          <div class="message-sources-list">
            {#each sources as source, index}
              {@const safeUrl = safeReferenceUrl(source.url)}
              <div
                class="message-source-item"
                class:highlighted={highlightSourceIndex === index}
                data-source-index={index}
                id={`source-${message?.id || messageKey || 'msg'}-${index}`}
                title={source.title}
              >
                <span class="message-source-badge">{index + 1}</span>
                <span class="message-source-avatar">{source.avatar}</span>
                <span class="message-source-info">
                  <span class="message-source-text">{source.title}</span>
                  {#if source.domain}
                    <span class="message-source-domain">{source.domain}</span>
                  {/if}
                </span>
                {#if safeUrl}
                  <a
                    href={safeUrl}
                    target="_blank"
                    rel="noopener"
                    class="message-source-open"
                    title={`打开链接：${source.url}`}
                    onclick={(e) => e.stopPropagation()}
                  >打开链接 ↗</a>
                {/if}
              </div>
            {/each}
          </div>
            {/if}
        </div>
          {/if}

      {#if showBottomToolbar}
        <div class="message-bottom-toolbar">
          {#if isUser}
            <button type="button" class="bubble-action-btn copy-btn" class:copied onclick={copyMessage}>{copied ? '已复制' : copyError ? '复制失败' : '复制'}</button>
            <button type="button" class="bubble-action-btn quote-btn" onclick={quoteFullMessage} aria-label="引用消息">引用</button>
            <button type="button" class="bubble-action-btn edit-btn" onclick={() => onEdit(message)}>改写</button>
            {#if isError}
              <button type="button" class="bubble-action-btn retry-btn" onclick={() => onRetry(message)}>重试</button>
              <button type="button" class="bubble-action-btn dismiss-btn" onclick={() => onDismiss(message)}>放弃</button>
            {/if}
          {:else}
            {#if showReadingMinutes}
              <span class="message-reading-time" title={`预计阅读时间约 ${readingMinutes} 分钟`}>约 {readingMinutes} 分钟</span>
            {/if}
            <button type="button" class="bubble-action-btn copy-btn" class:copied onclick={copyMessage}>{copied ? '已复制' : copyError ? '复制失败' : '复制回答'}</button>
            <button type="button" class="bubble-action-btn quote-btn" onclick={quoteFullMessage} aria-label="引用消息">引用</button>
            {#if !message?.tool}
              <span class="message-retry-split">
                <button type="button" class="bubble-action-btn retry-btn" onclick={() => { retryMenuOpen = false; onRetry(message); }} aria-label="重新生成回答">{isError ? '重试' : '重新生成'}</button>
                <button
                  type="button"
                  class="bubble-action-btn retry-chevron"
                  bind:this={retryChevronBtn}
                  onclick={(e) => { e.stopPropagation(); retryMenuOpen = !retryMenuOpen; }}
                  onkeydown={handleRetryMenuKeydown}
                  aria-label="选择思考强度后重试"
                  aria-haspopup="true"
                  aria-expanded={retryMenuOpen}
                  aria-controls={`retry-menu-${message?.id || messageKey || 'msg'}`}
                  title="选择思考强度"
                >▾</button>
                {#if retryMenuOpen}
                  <span
                    class="message-retry-menu"
                    role="menu"
                    bind:this={retryMenuContainer}
                    id={`retry-menu-${message?.id || messageKey || 'msg'}`}
                    tabindex="-1"
                    onkeydown={handleRetryMenuKeydown}
                  >
                    {#each THINKING_LEVELS as lvl}
                      <button type="button" role="menuitem" class="message-retry-level" onclick={() => { retryMenuOpen = false; onRetry(message, lvl.level); }} title={lvl.tip}>{lvl.icon} {lvl.cnLabel || lvl.label}</button>
                    {/each}
                  </span>
                {/if}
              </span>
            {:else if isError}
              <button type="button" class="bubble-action-btn retry-btn" onclick={() => onRetry(message)}>重试</button>
            {/if}
          {/if}
          {#if (message?.siblingCount || 0) > 1}
            <span class="branch-control branch-control-bottom">
              <button
                type="button"
                aria-label="上一分支"
                disabled={branchDisabled || message.siblingIndex <= 0}
                title={branchDisabled ? '生成中，完成后可切换分支' : '上一分支'}
                onclick={() => onBranch(message.nodeId, -1)}
              >‹</button>
              <span>{message.siblingIndex + 1}/{message.siblingCount}</span>
              <button
                type="button"
                aria-label="下一分支"
                disabled={branchDisabled || message.siblingIndex >= message.siblingCount - 1}
                title={branchDisabled ? '生成中，完成后可切换分支' : '下一分支'}
                onclick={() => onBranch(message.nodeId, 1)}
              >›</button>
            </span>
          {/if}
        </div>
      {/if}
      {#if message?.cacheRedacted}
        <div class="unrecognized-notice" role="note">此项来自本地缓存，其中的凭据字段已省略；重新同步后可查看服务器提供的内容。</div>
      {/if}
    </div>
  </div>
</div>

{#if lightboxSrc}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="message-lightbox-scrim" onclick={closeLightbox} onkeydown={handleKeydown} tabindex="-1">
    <div class="message-lightbox-content" onclick={(e) => e.stopPropagation()} role="dialog" aria-label={lightboxAlt || '图片预览'} aria-modal="true">
      <img src={lightboxSrc} alt={lightboxAlt} class="message-lightbox-img" />
      <div class="message-lightbox-actions">
        {#if isSafeImageSrc(lightboxSrc)}
          <a href={lightboxSrc} target="_blank" rel="noopener" class="message-lightbox-original" title="在新标签页打开原图" onclick={(e) => e.stopPropagation()}>原图</a>
        {/if}
        <button type="button" class="message-lightbox-close" bind:this={lightboxCloseBtn} onclick={closeLightbox} aria-label="关闭预览">×</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .message-bubble {
    position: relative;
  }
  .thought-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--slim-soft) 85%, var(--slim-surface));
    border-radius: 12px;
    transition: background 0.15s ease;
  }
  .thought-block.open .thought-header {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
  .thought-block {
    margin: 0 0 12px;
    border: 1px solid color-mix(in srgb, var(--slim-line) 85%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--slim-soft) 55%, var(--slim-surface));
    overflow: hidden;
    transition: border-color 0.15s ease;
  }
  .thought-block:hover {
    border-color: color-mix(in srgb, var(--f7-theme-color) 35%, var(--slim-line));
  }
  .thought-pulse-indicator {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-right: 8px;
    color: var(--f7-theme-color);
    flex: none;
  }
  .thought-pulse-ring {
    position: absolute;
    inset: 1px;
    border-radius: 50%;
    border: 1.5px solid var(--f7-theme-color);
    animation: thought-ping 1.4s cubic-bezier(0, 0, 0.2, 1) infinite;
    opacity: 0.75;
  }
  .thought-pulse-core {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--f7-theme-color);
  }
  @keyframes thought-ping {
    75%, 100% {
      transform: scale(1.6);
      opacity: 0;
    }
  }
  .thought-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--slim-text);
    letter-spacing: -0.01em;
  }
  .thought-duration {
    font-size: 11px;
    color: var(--slim-muted);
    margin-left: 6px;
    font-variant-numeric: tabular-nums;
  }
  .thought-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: 8px;
    color: var(--slim-muted);
    transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .thought-toggle.rotated {
    transform: rotate(180deg);
  }
  .thought-content-wrapper {
    border-top: 1px solid color-mix(in srgb, var(--slim-line) 60%, transparent);
  }
  :global(.thought-content) {
    padding: 12px 14px;
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--slim-muted);
  }
  .thought-toggle-btn {
    display: inline-flex;
    align-items: center;
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: pointer;
    flex: 1;
    text-align: left;
  }
  .thought-copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 4px;
    padding: 3px 8px;
    border: 1px solid var(--slim-line);
    border-radius: 6px;
    background: var(--slim-surface);
    color: var(--slim-muted);
    font: 500 10.5px/1 inherit;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .thought-copy-btn:hover {
    color: var(--f7-theme-color);
    border-color: var(--f7-theme-color);
    background: color-mix(in srgb, var(--f7-theme-color) 8%, var(--slim-surface));
  }
  .thought-copy-btn.copied {
    color: var(--f7-theme-color);
    border-color: var(--f7-theme-color);
    background: color-mix(in srgb, var(--f7-theme-color) 12%, var(--slim-surface));
    font-weight: 600;
  }
  .role-user .message-meta {
    flex-direction: row-reverse;
  }
  .role-user .message-meta-left {
    flex-direction: row-reverse;
  }
  .branch-control {
    direction: ltr !important;
    flex-direction: row !important;
  }

  .message-text-container {
    position: relative;
  }
  .message-text-container.is-collapsed {
    max-height: 480px;
    overflow: hidden;
    mask-image: linear-gradient(to bottom, black 65%, transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, black 65%, transparent 100%);
  }
  .message-collapse-bar {
    display: flex;
    justify-content: center;
    margin-top: 6px;
  }
  .message-collapse-btn {
    display: inline-flex;
    align-items: center;
    padding: 3px 12px;
    border: 1px solid var(--slim-line);
    border-radius: 999px;
    background: var(--slim-surface);
    color: var(--slim-muted);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .message-collapse-btn:hover {
    color: var(--f7-theme-color);
    border-color: var(--f7-theme-color);
  }

  /* Sources styling */
  .message-sources-block {
    margin-top: 10px;
    border-top: 1px dashed var(--slim-line);
    padding-top: 8px;
  }
  .message-sources-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--slim-muted);
    font-size: 11px;
    cursor: pointer;
  }
  .message-sources-toggle:hover {
    color: var(--f7-theme-color);
  }
  .message-sources-title {
    font-weight: 600;
  }
  .message-sources-arrow {
    font-size: 9.5px;
    opacity: 0.8;
  }
  .message-sources-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 6px;
    margin-top: 8px;
  }
  .message-source-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 9px;
    border: 1px solid var(--slim-line);
    border-radius: 8px;
    background: color-mix(in srgb, var(--slim-surface) 60%, transparent);
    text-decoration: none;
    color: var(--slim-text);
    font-size: 11px;
    overflow: hidden;
    transition: all 0.15s ease;
  }
  .message-source-item:hover {
    border-color: var(--f7-theme-color);
    background: var(--slim-soft);
  }
  .message-source-item.highlighted {
    border-color: var(--f7-theme-color);
    background: color-mix(in srgb, var(--f7-theme-color) 12%, var(--slim-surface));
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--f7-theme-color) 30%, transparent);
  }
  .message-source-badge {
    display: grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 4px;
    flex: none;
    border-radius: 999px;
    background: var(--f7-theme-color);
    color: #fff;
    font-weight: 700;
    font-size: 10px;
  }
  .message-source-open {
    margin-left: auto;
    flex: none;
    color: var(--f7-theme-color);
    font-size: 10px;
    text-decoration: none;
    white-space: nowrap;
  }
  .message-source-open:hover {
    text-decoration: underline;
  }
  .message-timestamp {
    color: var(--slim-muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .message-reading-time {
    color: var(--slim-muted);
    font-size: 10px;
    white-space: nowrap;
  }
  .message-retry-split {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .message-retry-split .retry-btn {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right: 0;
  }
  .message-retry-split .retry-chevron {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    padding: 0 6px;
  }
  .message-retry-menu {
    position: absolute;
    bottom: calc(100% + 4px);
    right: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    min-width: 120px;
    padding: 4px;
    border: 1px solid var(--slim-line);
    border-radius: 8px;
    background: var(--slim-surface);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }
  .message-retry-level {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--slim-text);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .message-retry-level:hover {
    background: var(--slim-soft);
  }
  .message-source-avatar {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    flex: none;
    border-radius: 4px;
    background: var(--slim-soft);
    color: var(--f7-theme-color);
    font-weight: 700;
    font-size: 10px;
  }
  .message-source-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  .message-source-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }
  .message-source-domain {
    font-size: 9.5px;
    color: var(--slim-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Lightbox */
  .message-lightbox-scrim {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(4px);
    display: grid;
    place-items: center;
    padding: 24px;
    box-sizing: border-box;
  }
  .message-lightbox-content {
    position: relative;
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .message-lightbox-img {
    max-width: 100%;
    max-height: 85vh;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }
  .message-lightbox-close {
    position: absolute;
    top: -14px;
    right: -14px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.3);
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .message-lightbox-actions {
    position: absolute;
    top: -14px;
    right: -14px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .message-lightbox-actions .message-lightbox-close {
    position: static;
  }
  .message-lightbox-original {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
    font-size: 11px;
    text-decoration: none;
    cursor: pointer;
  }
  .message-lightbox-original:hover {
    background: rgba(0, 0, 0, 0.85);
  }
  .error-banner-details {
    margin-top: 4px;
  }
  .error-banner-summary {
    font-size: 11px;
    cursor: pointer;
    color: var(--slim-muted);
    outline: none;
  }
  .error-banner-summary:hover {
    color: var(--slim-text);
  }

  /* Discreet floating action buttons on hover / focus */
  .message-bottom-toolbar {
    opacity: 0;
    transform: translateY(2px);
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  :global(.message-card:hover) .message-bottom-toolbar,
  :global(.message-card:focus-within) .message-bottom-toolbar,
  .message-bottom-toolbar:focus-within {
    opacity: 1;
    transform: translateY(0);
  }
  @media (pointer: coarse) {
    .message-bottom-toolbar {
      opacity: 1;
      transform: none;
    }
  }

  /* Sleek modern bubble action buttons */
  .bubble-action-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding: 0 9px;
    border: 1px solid var(--slim-line);
    border-radius: 7px;
    background: var(--slim-surface);
    color: var(--slim-muted);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.12s ease;
  }
  .bubble-action-btn:hover {
    color: var(--slim-text);
    border-color: color-mix(in srgb, var(--f7-theme-color) 40%, var(--slim-line));
    background: var(--slim-soft);
  }
  .bubble-action-btn.copied {
    color: var(--f7-theme-color) !important;
    border-color: var(--f7-theme-color) !important;
    background: color-mix(in srgb, var(--f7-theme-color) 12%, var(--slim-surface)) !important;
    font-weight: 600;
  }

  /* Sleek avatar styling: 28px circular indicator with clean SVG */
  :global(.message-card .message-avatar) {
    width: 28px !important;
    height: 28px !important;
    min-width: 28px !important;
    margin-top: 4px !important;
    border-radius: 50% !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08) !important;
  }

  /* Bubble shape and wrapping improvements */
  :global(.message-card.role-user .message-bubble) {
    border-radius: 16px 16px 4px 16px !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04) !important;
    border: 1px solid color-mix(in srgb, var(--f7-theme-color) 20%, var(--slim-line)) !important;
    word-break: break-word;
    overflow-wrap: break-word;
  }
  :global(.message-card.role-assistant .message-bubble) {
    border-radius: 16px 16px 16px 4px !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04) !important;
    word-break: break-word;
    overflow-wrap: break-word;
  }
  :global(.message-card.role-user) {
    gap: 10px !important;
  }
  :global(.message-card.role-assistant) {
    gap: 10px !important;
  }
  :global(.message-card) {
    margin-bottom: 4px;
  }
</style>
