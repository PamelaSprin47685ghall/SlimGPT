<script>
  import { tick } from 'svelte';

  let {
    turns = [],
    unresolvedCount = 0,
    activeIndex = 0,
    streaming = false,
    streamingIndex = -1,
    onSelect = () => {},
  } = $props();

  let listEl = $state(null);
  let filterQuery = $state('');

  // Defaults to the latest turn so HomePage only passes `streaming`.
  const effectiveStreamingIndex = $derived(streamingIndex >= 0 ? streamingIndex : turns.length - 1);

  $effect(() => {
    const index = activeIndex;
    void tick().then(() => {
      listEl?.querySelector(`[data-overview-index="${index}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    });
  });

  function clean(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Rank11 code-aware overview: when the filter query matches inside a
  // fenced code block, keep the matching code line in the preview instead
  // of stripping the hit.
  function findCodeHitLine(text, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return '';
    const blocks = String(text || '').match(/```[\s\S]*?(?:```|$)/g) || [];
    for (const block of blocks) {
      const lines = block.replace(/```[^\n]*\n?/, '').replace(/```\s*$/, '').split('\n');
      for (const line of lines) {
        if (line.toLowerCase().includes(q)) {
          const hit = line.trim().slice(0, 120);
          if (hit) return hit;
        }
      }
    }
    return '';
  }

  function findAnswerMessage(turn) {
    return turn?.replies?.find((message) => message?.role === 'assistant' && !message?.tool && (message?.text || message?.thought)) ||
      turn?.replies?.find((message) => !message?.tool && (message?.text || message?.thought)) ||
      turn?.replies?.find((message) => message?.text || message?.thought);
  }

  function answerPreview(turn, index, query) {
    const answerMsg = findAnswerMessage(turn);
    const raw = answerMsg?.text || answerMsg?.thought || '';
    const hit = findCodeHitLine(raw, query);
    if (hit) return hit;
    return clean(raw);
  }

  function questionPreview(turn, query) {
    const raw = turn?.user?.text || turn?.user?.thought || '';
    const hit = findCodeHitLine(raw, query);
    if (hit) return hit;
    return questionText(turn);
  }

  function getStreamingFallback(turn) {
    const hasThought = turn?.replies?.some((m) => m?.thought || m?.isThinking);
    return hasThought ? '正在思考…' : '正在生成…';
  }

  function preview(turn, index) {
    const question = clean(turn?.user?.text || turn?.user?.thought);
    const answerMsg = turn?.replies?.find((message) => message?.role === 'assistant' && !message?.tool && (message?.text || message?.thought)) ||
      turn?.replies?.find((message) => !message?.tool && (message?.text || message?.thought)) ||
      turn?.replies?.find((message) => message?.text || message?.thought);
    const answer = clean(answerMsg?.text || answerMsg?.thought);
    const isStreaming = streaming && index === effectiveStreamingIndex;
    const fallback = isStreaming ? getStreamingFallback(turn) : (turn?.replies?.some((message) => message?.tool) ? '（工具调用）' : '（空对话轮次）');
    if (question && (answer || isStreaming)) return `${question}  →  ${answer || fallback}`;
    if (question) return question;
    if (answer) return answer;
    return fallback;
  }

  function hasMultimodalContent(user) {
    if (!user) return false;
    if (Array.isArray(user.attachments) && user.attachments.length > 0) return true;
    if (Array.isArray(user.metadata?.attachments) && user.metadata.attachments.length > 0) return true;
    if (Array.isArray(user.parts) && user.parts.some((p) => p && (p.image || p.asset_pointer || p.content_type?.includes('image') || p.content_type?.includes('multimodal')))) return true;
    if (user.metadata?.multimodal || user.metadata?.hasImage || user.image) return true;
    return false;
  }

  function questionText(turn) {
    const text = clean(turn?.user?.text || turn?.user?.thought);
    if (text) return text;
    if (hasMultimodalContent(turn?.user)) return '[图片/多模态提问]';
    return '';
  }

  function answerText(turn) {
    const answerMsg = turn?.replies?.find((message) => message?.role === 'assistant' && !message?.tool && (message?.text || message?.thought)) ||
      turn?.replies?.find((message) => !message?.tool && (message?.text || message?.thought)) ||
      turn?.replies?.find((message) => message?.text || message?.thought);
    return clean(answerMsg?.text || answerMsg?.thought);
  }

  function toolCount(turn) {
    return turn?.replies?.filter((message) => message?.tool).length || 0;
  }

  function hasBranch(turn) {
    if ((turn?.user?.siblingCount || 0) > 1) return true;
    if (Array.isArray(turn?.replies)) {
      return turn.replies.some((r) => (r?.siblingCount || 0) > 1);
    }
    return false;
  }

  function handleListKeydown(event) {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
    if (event.target?.tagName === 'INPUT') return;
    if (!listEl) return;
    const items = Array.from(listEl.querySelectorAll('.overview-item'));
    if (!items.length) return;
    const currentIndex = items.findIndex((el) => el === document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    } else if (event.key === 'PageUp') {
      nextIndex = Math.max(0, (currentIndex >= 0 ? currentIndex : 0) - 5);
    } else if (event.key === 'PageDown') {
      nextIndex = Math.min(items.length - 1, (currentIndex >= 0 ? currentIndex : 0) + 5);
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    } else if (event.key === 'ArrowDown') {
      nextIndex = currentIndex < 0 || currentIndex >= items.length - 1 ? 0 : currentIndex + 1;
    }
    const nextItem = items[nextIndex];
    if (nextItem) {
      event.preventDefault();
      nextItem.focus();
      nextItem.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  }

  function handleFilterKeydown(event) {
    if (event.key === 'Escape') {
      filterQuery = '';
      event.preventDefault();
    } else if (event.key === 'ArrowDown') {
      const firstItem = listEl?.querySelector('.overview-item');
      if (firstItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }
  }

  const filteredTurns = $derived.by(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) {
      return turns.map((turn, index) => ({ turn, index }));
    }
    return turns
      .map((turn, index) => ({ turn, index }))
      .filter(({ turn, index }) => {
        const qText = questionText(turn).toLowerCase();
        const aText = answerText(turn).toLowerCase();
        const idxText = String(index + 1);
        if (qText.includes(q) || aText.includes(q) || idxText.includes(q)) return true;
        return turn?.replies?.some((r) => {
          const text = String(r?.text || r?.thought || r?.tool?.name || '').toLowerCase();
          return text.includes(q);
        });
      });
  });
</script>

<aside class="message-overview">
  <header class="overview-header">
    <div>
      <strong>消息概览</strong>
      <span>{unresolvedCount ? `问答轮次 · ${unresolvedCount} 条关联待修复` : '问答轮次'}</span>
    </div>
    <span class="overview-count">{filterQuery.trim() ? `${filteredTurns.length}/${turns.length}` : turns.length}</span>
  </header>

  <div class="overview-filter-box">
    <input
      type="search"
      class="overview-filter-input"
      bind:value={filterQuery}
      placeholder="过滤轮次内容… (Esc 清除)"
      aria-label="过滤问答轮次"
      onkeydown={handleFilterKeydown}
    />
    {#if filterQuery}
      <button
        type="button"
        class="overview-filter-clear"
        onclick={() => filterQuery = ''}
        aria-label="清空过滤"
        title="一键清空过滤"
      >一键清空</button>
    {/if}
  </div>

  <div class="overview-list" bind:this={listEl} onkeydown={handleListKeydown} role="region" aria-label="问答轮次列表">
    {#if turns.length === 0}
      <div class="overview-empty">
        {unresolvedCount ? '对话关系未同步完整，请重新同步关联' : '当前对话暂无问答'}
      </div>
    {:else if filteredTurns.length === 0}
      <div class="overview-empty">
        无匹配的问答轮次
      </div>
    {:else}
      {#each filteredTurns as { turn, index } (turn.id || index)}
        {@const query = questionPreview(turn, filterQuery)}
        {@const answer = answerPreview(turn, index, filterQuery)}
        {@const tools = toolCount(turn)}
        {@const branch = hasBranch(turn)}
        {@const isStreaming = streaming && index === effectiveStreamingIndex}
        <button
          type="button"
          class="overview-item"
          class:active={index === activeIndex}
          data-overview-index={index}
          aria-current={index === activeIndex ? 'true' : undefined}
          aria-label={preview(turn, index)}
          onclick={() => onSelect(index)}
        >
          <span class="overview-role role-turn">Q/A</span>
          <span class="overview-text">
            <span class="overview-query">{query || '（空提问）'}</span>
            <span class="overview-answer">{answer || (isStreaming ? getStreamingFallback(turn) : (tools ? `工具调用 ×${tools}` : '（空对话轮次）'))}</span>
          </span>
          <span class="overview-meta">
            {#if branch}
              <span class="overview-branch" title="本轮含多分支历史">分支</span>
            {/if}
            {#if tools}
              <span class="overview-tools" title={`本轮含 ${tools} 条工具调用`}>×{tools}</span>
            {/if}
            {#if isStreaming}
              <span class="overview-live-dot" title="正在输出" aria-hidden="true"></span>
            {/if}
            <span class="overview-number">{index + 1}</span>
          </span>
        </button>
      {/each}
    {/if}
  </div>
</aside>

<style>
  .overview-list {
    scrollbar-gutter: stable;
  }
  .overview-item {
    transition: background-color 0.12s ease;
  }
  .overview-branch {
    display: inline-flex;
    align-items: center;
    height: 16px;
    padding: 0 5px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--f7-theme-color) 14%, var(--slim-soft));
    color: var(--f7-theme-color);
    font-size: 9px;
    font-weight: 700;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.overview-live-dot) {
      animation: none !important;
    }
  }
</style>
