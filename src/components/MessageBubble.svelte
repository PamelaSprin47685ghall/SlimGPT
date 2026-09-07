<script>
  import { onDestroy } from 'svelte';
  import IncrementalMarkdown from './IncrementalMarkdown.svelte';
  import ToolPayloadBlock from './ToolPayloadBlock.svelte';
  import { copyText } from '../lib/clipboard.js';
  import { formatModelLabel, isMessageStreaming, isTerminalMessage } from '../lib/message-presentation.js';

  let {
    message,
    onBranch = () => {},
  } = $props();

  let copied = $state(false);
  let copyError = $state(false);
  let userToggled = $state(false);
  let thoughtManualState = $state(false);
  let copyTimer = null;
  const codeCopyTimers = new Map();
  let previousMessageKey = null;
  const messageKey = $derived(message?.observationKey || message?.itemId || message?.nodeId || message?.id || null);

  $effect(() => {
    const key = messageKey;
    if (key === previousMessageKey) return;
    previousMessageKey = key;
    userToggled = false;
    thoughtManualState = false;
    copied = false;
    copyError = false;
    clearTimeout(copyTimer);
  });

  const hasText = $derived(Boolean(String(message?.text || '').trim()));
  const hasThought = $derived(Boolean(String(message?.thought || '').trim()));
  const isThinking = $derived(Boolean(message?.isThinking && !message?.error && !isTerminalMessage(message)));
  const isStreaming = $derived(isMessageStreaming(message));
  const isError = $derived(Boolean(message?.error || message?.status === 'failed'));
  const unrecognized = $derived(Boolean(!hasText && !hasThought && !message?.tool && !isThinking && !isError && message?.unrecognized));
  const isUser = $derived(message?.role === 'user');

  const thoughtOpen = $derived(userToggled ? thoughtManualState : (!hasText || isThinking));

  function toggleThought() {
    thoughtManualState = !thoughtOpen;
    userToggled = true;
  }

  onDestroy(() => {
    clearTimeout(copyTimer);
    for (const timer of codeCopyTimers.values()) clearTimeout(timer);
    codeCopyTimers.clear();
  });

  async function copyMessage() {
    const key = messageKey;
    const text = String(message?.text || (message?.thought ? `【思考过程】\n${message.thought}` : ''));
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

  async function handleBubbleClick(event) {
    const copyBtn = event.target?.closest?.('.code-copy-btn');
    if (!copyBtn) return;
    const codeBlock = copyBtn.closest('.code-block');
    const code = codeBlock?.querySelector('pre code')?.textContent || '';
    if (!code) return;
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
    copyBtn.classList.toggle('copied', succeeded);
    clearTimeout(codeCopyTimers.get(copyBtn));
    codeCopyTimers.set(copyBtn, setTimeout(() => {
      copyBtn.textContent = '复制';
      copyBtn.classList.remove('copied');
      codeCopyTimers.delete(copyBtn);
    }, 2400));
  }
</script>

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
      S
    {:else if message?.role === 'user'}
      你
    {:else if message?.role === 'system'}
      ⚙
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
        {:else if !isUser && message?.model}
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
              disabled={message.siblingIndex <= 0}
              onclick={() => onBranch(message.nodeId, -1)}
            >‹</button>
            <span>{message.siblingIndex + 1}/{message.siblingCount}</span>
            <button
              type="button"
              aria-label="下一分支"
              disabled={message.siblingIndex >= message.siblingCount - 1}
              onclick={() => onBranch(message.nodeId, 1)}
            >›</button>
          </span>
        {/if}
      </div>

      <div class="message-meta-right">
        {#if !message?.tool && (hasText || hasThought)}
          <button
            type="button"
            class="message-action-btn"
            class:copied
            onclick={copyMessage}
            aria-label="复制消息"
            aria-live="polite"
          >{copied ? '已复制' : copyError ? '复制失败' : '复制'}</button>
        {/if}
      </div>
    </div>

    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="message-bubble" onclick={handleBubbleClick}>
      {#if hasThought}
        <div class="thought-block" class:open={thoughtOpen}>
          <button
            type="button"
            class="thought-header"
            onclick={toggleThought}
            aria-expanded={thoughtOpen}
          >
            <span class="thought-icon">💭</span>
            <span class="thought-title">思考过程</span>
            {#if message?.thinkingDuration}
              <span class="thought-duration">（用时 {message.thinkingDuration}）</span>
            {/if}
            <span class="thought-toggle">{thoughtOpen ? '收起 ▲' : '展开 ▼'}</span>
          </button>
          {#if thoughtOpen}
            <IncrementalMarkdown class="thought-content" source={message.thought} streaming={isStreaming} />
          {/if}
        </div>
      {/if}

      {#if message?.tool}
        <ToolPayloadBlock tool={message.tool} />
      {:else if hasText}
        <IncrementalMarkdown source={message.text} streaming={isStreaming} />
      {:else if !message?.tool && hasThought && isStreaming && !message?.endTurn}
        <div class="thinking-indicator" role="status" aria-live="polite">
          <span class="thinking-spinner" aria-hidden="true"></span>
          <span>思考中…</span>
        </div>
      {:else if !message?.tool && isThinking}
        <div class="thinking-indicator" role="status" aria-live="polite">
          <span class="thinking-spinner" aria-hidden="true"></span>
          <span>ChatGPT 正在思考与生成…</span>
        </div>
      {:else if !message?.tool && unrecognized}
        <div class="unrecognized-notice">
          <strong>官方消息（非文本内容）</strong>
          <span>这条消息包含 SlimGPT 尚未识别的内容类型，已原样保留。可点击「暂时显示官方界面」查看完整内容。</span>
        </div>
      {:else if !message?.tool && isError}
        <div class="error-notice">⚠️ 消息生成失败或被官方界面中断</div>
      {:else if !message?.tool && !hasThought}
        <div class="empty-notice">（无文字内容）</div>
      {/if}
      {#if message?.cacheRedacted}
        <div class="unrecognized-notice" role="note">此项来自本地缓存，其中的凭据字段已省略；重新同步后可查看服务器提供的内容。</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .message-bubble {
    position: relative;
  }
  .role-user .message-meta {
    flex-direction: row-reverse;
  }
  .role-user .message-meta-left {
    flex-direction: row-reverse;
  }
</style>
