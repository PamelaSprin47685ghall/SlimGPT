<script>
  import { tick } from 'svelte';

  let {
    turns = [],
    unresolvedCount = 0,
    activeIndex = 0,
    onSelect = () => {},
  } = $props();

  let listEl = $state(null);

  $effect(() => {
    const index = activeIndex;
    void tick().then(() => {
      listEl?.querySelector(`[data-overview-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  });

  function clean(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, '').replace(/```/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function preview(turn) {
    const question = clean(turn?.user?.text || turn?.user?.thought);
    const answerMsg = turn?.replies?.find((message) => message?.role === 'assistant' && !message?.tool && (message?.text || message?.thought)) ||
      turn?.replies?.find((message) => !message?.tool && (message?.text || message?.thought)) ||
      turn?.replies?.find((message) => message?.text || message?.thought);
    const answer = clean(answerMsg?.text || answerMsg?.thought);
    if (question && answer) return `${question}  →  ${answer}`;
    if (question) return question;
    if (answer) return answer;
    if (turn?.replies?.some((message) => message?.tool)) return '（工具调用）';
    return '（空对话轮次）';
  }
</script>

<aside class="message-overview">
  <header class="overview-header">
    <div>
      <strong>消息概览</strong>
      <span>{unresolvedCount ? `问答轮次 · ${unresolvedCount} 条关联待修复` : '问答轮次'}</span>
    </div>
    <span class="overview-count">{turns.length}</span>
  </header>

  <div class="overview-list" bind:this={listEl}>
    {#if turns.length === 0}
      <div class="overview-empty">
        {unresolvedCount ? '对话关系未同步完整，请重新同步关联' : '当前对话暂无问答'}
      </div>
    {:else}
      {#each turns as turn, index (turn.id || index)}
        <button
          type="button"
          class="overview-item"
          class:active={index === activeIndex}
          data-overview-index={index}
          aria-current={index === activeIndex ? 'true' : undefined}
          onclick={() => onSelect(index)}
        >
          <span class="overview-role role-turn">Q/A</span>
          <span class="overview-preview">{preview(turn)}</span>
          <span class="overview-number">{index + 1}</span>
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
  .overview-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
