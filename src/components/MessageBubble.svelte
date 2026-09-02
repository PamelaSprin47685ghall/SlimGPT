<script>
  import { onDestroy } from 'svelte';
  import IncrementalMarkdown from './IncrementalMarkdown.svelte';
  import ToolPayloadBlock from './ToolPayloadBlock.svelte';

  let {
    message,
    onBranch = () => {},
  } = $props();

  let copied = $state(false);
  let thoughtOpen = $state(false);
  let copyTimer = null;

  const hasText = $derived(Boolean(String(message?.text || '').trim()));
  const hasThought = $derived(Boolean(String(message?.thought || '').trim()));
  const isThinking = $derived(Boolean(message?.isThinking));
  const isStreaming = $derived(Boolean(message?.live && message?.status !== 'finished_successfully' && message?.status !== 'finished'));
  const isError = $derived(Boolean(message?.error || message?.status === 'failed'));
  const unrecognized = $derived(Boolean(!hasText && !hasThought && !message?.tool && !isThinking && !isError && message?.unrecognized));

  // Auto-expand thought if it's currently generating and has no text yet
  $effect(() => {
    if (isThinking && hasThought && !hasText) {
      thoughtOpen = true;
    }
  });

  onDestroy(() => {
    clearTimeout(copyTimer);
  });

  async function copyMessage() {
    const text = String(message?.text || message?.thought || '');
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

  function formatModelBadge(raw) {
    if (!raw) return '';
    const str = String(raw).toLowerCase();
    if (str.includes('pro')) return 'GPT-5.6 Pro';
    if (str.includes('luna')) return 'GPT-5.6 Luna';
    if (str.includes('sol') || str.includes('5.6') || str.includes('gpt-5')) return 'GPT-5.6';
    return String(raw)
      .replace(/^text-/, '')
      .replace(/-latest$/, '')
      .slice(0, 16);
  }
</script>

<div class={`message-card role-${message?.role || 'unknown'} ${message?.tool?.kind || ''} ${isError ? 'is-error' : ''}`}>
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

        {#if message?.thinkingLevel}
          <span class="meta-badge thinking-badge" title={message.thinkingLevel.tip}>
            {message.thinkingLevel.icon} {message.thinkingLevel.label}
          </span>
        {:else if message?.model}
          <span class="meta-badge model-badge">{formatModelBadge(message.model)}</span>
        {/if}

        {#if message?.tool}
          <code class="tool-message-name">{message.tool.name}</code>
        {/if}

        {#if isError}
          <span class="meta-badge error-badge">生成异常</span>
        {/if}

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
        {#if !message?.tool && (hasText || hasThought)}
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
      {#if hasThought}
        <div class="thought-block" class:open={thoughtOpen}>
          <button
            type="button"
            class="thought-header"
            onclick={() => thoughtOpen = !thoughtOpen}
            aria-expanded={thoughtOpen}
          >
            <span class="thought-icon">💭</span>
            <span class="thought-title">思考过程</span>
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
      {:else if hasThought && isStreaming && !message?.endTurn}
        <div class="thinking-indicator" role="status" aria-live="polite">
          <span class="thinking-spinner" aria-hidden="true"></span>
          <span>思考中…</span>
        </div>
      {:else if isThinking}
        <div class="thinking-indicator" role="status" aria-live="polite">
          <span class="thinking-spinner" aria-hidden="true"></span>
          <span>ChatGPT 正在思考与生成…</span>
        </div>
      {:else if unrecognized}
        <div class="unrecognized-notice">
          <strong>官方消息（非文本内容）</strong>
          <span>这条消息包含 SlimGPT 尚未识别的内容类型，已原样保留。可点击「暂时显示官方界面」查看完整内容。</span>
        </div>
      {:else if isError}
        <div class="error-notice">⚠️ 消息生成失败或被官方界面中断</div>
      {:else if !hasThought}
        <div class="empty-notice">（无文字内容）</div>
      {/if}
    </div>
  </div>
</div>
