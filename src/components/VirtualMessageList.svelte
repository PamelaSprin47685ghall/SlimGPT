<script>
  import { tick } from 'svelte';
  import { estimateMessageHeight } from '../../core.js';
  import MessageBubble from './MessageBubble.svelte';

  let {
    messages = [],
    conversationKey = 'default',
    followTail = false,
    onBranch = () => {},
  } = $props();

  const OVERSCAN = 8;
  let viewport = $state(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(700);
  let measured = $state(new Map());
  let resizeObserver = null;
  let previousConversationKey = null;
  let previousFollowTail = false;

  let heights = $derived(messages.map((message) => measured.get(message.id) || estimateMessageHeight(message)));
  let offsets = $derived.by(() => {
    const result = new Array(messages.length + 1).fill(0);
    for (let index = 0; index < messages.length; index += 1) result[index + 1] = result[index] + heights[index];
    return result;
  });
  let totalHeight = $derived(offsets[offsets.length - 1] || 0);
  let startIndex = $derived(Math.max(0, locate(scrollTop) - OVERSCAN));
  let endIndex = $derived(Math.min(messages.length, locate(scrollTop + viewportHeight) + OVERSCAN + 1));
  let visible = $derived(messages.slice(startIndex, endIndex));

  $effect(() => {
    if (conversationKey !== previousConversationKey) {
      previousConversationKey = conversationKey;
      measured = new Map();
      queueMicrotask(() => scrollToEnd());
    }
  });

  $effect(() => {
    if (followTail && !previousFollowTail) queueMicrotask(() => scrollToEnd());
    previousFollowTail = followTail;
  });

  function locate(target) {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (offsets[mid] < target) low = mid + 1;
      else high = mid;
    }
    return Math.max(0, low - 1);
  }

  function onScroll() {
    if (!viewport) return;
    scrollTop = viewport.scrollTop;
    viewportHeight = viewport.clientHeight;
  }

  async function scrollToEnd() {
    await tick();
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    scrollTop = viewport.scrollTop;
  }

  function measure(node, message) {
    const update = () => {
      const height = Math.max(64, Math.ceil(node.getBoundingClientRect().height));
      if (measured.get(message.id) === height) return;
      measured = new Map(measured).set(message.id, height);
    };
    node.dataset.messageId = message.id;
    resizeObserver ||= new ResizeObserver((entries) => {
      let next = null;
      for (const entry of entries) {
        const id = entry.target.dataset.messageId;
        if (!id) continue;
        const height = Math.max(64, Math.ceil(entry.borderBoxSize?.[0]?.blockSize || entry.contentRect.height));
        if (measured.get(id) === height) continue;
        next ||= new Map(measured);
        next.set(id, height);
      }
      if (next) measured = next;
    });
    resizeObserver.observe(node);
    queueMicrotask(update);
    return { destroy: () => resizeObserver?.unobserve(node) };
  }
</script>

<div class="virtual-viewport" bind:this={viewport} onscroll={onScroll}>
  <div class="virtual-spacer" style={`height:${totalHeight}px`}></div>
  <div class="virtual-layer">
    {#each visible as message, localIndex (message.id)}
      {@const index = startIndex + localIndex}
      <div
        class:pending={Boolean(message.pending)}
        class="message-row"
        style={`top:${offsets[index]}px`}
        use:measure={message}
      >
        <MessageBubble {message} {onBranch} />
      </div>
    {/each}
  </div>
</div>
