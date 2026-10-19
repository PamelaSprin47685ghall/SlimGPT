<script>
  import { tick } from 'svelte';
  import Button from 'framework7-svelte/components/button.svelte';
  import Turn from './Turn.svelte';

  /** @type {{ turns: import('../../protocol/types.js').Turn[], conversationKey: string, running?: boolean, branches?: boolean, empty?: string }} */
  let { turns, conversationKey, running = false, branches = true, empty = '' } = $props();
  let scroller = $state();
  let content = $state();
  let follow = $state(true);
  const FOLLOW_THRESHOLD = 64;

  function atBottom() {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_THRESHOLD;
  }

  function onScroll() {
    follow = atBottom();
  }

  function toBottom() {
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    follow = true;
  }

  // A different conversation always opens at its newest message.
  $effect(() => {
    void conversationKey;
    follow = true;
    void tick().then(toBottom);
  });

  // Keep following while content grows (streaming, late highlighting, images)
  // but only when the reader is already at the bottom.
  $effect(() => {
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (follow) scroller.scrollTop = scroller.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  });
</script>

<div class="page-content thread" bind:this={scroller} onscroll={onScroll}>
  <div class="thread-inner" bind:this={content}>
    {#if !turns.length}
      <p class="thread-empty">{empty}</p>
    {/if}
    {#each turns as turn, index (turn.user?.id ?? `lead-${turn.replies[0]?.id ?? index}`)}
      <Turn {turn} last={index === turns.length - 1} {running} {branches} />
    {/each}
  </div>
  {#if !follow}
    <Button small fill round class="to-bottom" onClick={toBottom}>回到底部</Button>
  {/if}
</div>
