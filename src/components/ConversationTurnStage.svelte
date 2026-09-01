<script>
  import { onDestroy, tick } from 'svelte';
  import MessageBubble from './MessageBubble.svelte';

  let {
    turns = [],
    activeIndex = 0,
    conversationKey = 'default',
    onActiveChange = () => {},
    onBranch = () => {},
  } = $props();

  let scroller = $state(null);
  let pendingEdge = 'start';
  let previousKey = '';
  let boundaryDirection = $state(0);
  let boundaryProgress = $state(0);
  let boundaryOffsetPx = $state(0);
  let boundaryReady = $state(false);
  let boundaryCommitDelta = 0;
  let lastAdvanceAt = 0;
  let touchStartY = null;
  let edgeSettleToken = 0;
  let edgeSettleTimers = [];

  const activeTurn = $derived(turns[activeIndex] || null);

  $effect(() => {
    const key = conversationKey;
    const index = activeIndex;
    if (!activeTurn) return;
    const edge = key !== previousKey ? 'start' : pendingEdge;
    previousKey = key;
    pendingEdge = 'start';
    resetBoundaryRunway();
    void index;
    settleEdge(edge);
  });

  function cancelEdgeSettle() {
    edgeSettleToken += 1;
    for (const timer of edgeSettleTimers.splice(0)) clearTimeout(timer);
  }

  function settleEdge(edge) {
    cancelEdgeSettle();
    const token = edgeSettleToken;
    void tick().then(() => {
      if (!scroller || token !== edgeSettleToken) return;
      const apply = () => {
        if (!scroller || token !== edgeSettleToken) return;
        scroller.scrollTop = edge === 'end'
          ? Math.max(0, scroller.scrollHeight - scroller.clientHeight)
          : 0;
      };
      apply();
      requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
      });
      if (edge === 'end') {
        edgeSettleTimers.push(setTimeout(apply, 60));
        edgeSettleTimers.push(setTimeout(apply, 140));
        edgeSettleTimers.push(setTimeout(apply, 260));
      }
    });
  }

  function canAdvance(direction) {
    if (direction > 0) return activeIndex < turns.length - 1;
    return activeIndex > 0;
  }

  function resetBoundaryRunway() {
    boundaryDirection = 0;
    boundaryProgress = 0;
    boundaryOffsetPx = 0;
    boundaryReady = false;
    boundaryCommitDelta = 0;
  }

  function pushBoundary(direction, amount) {
    if (!scroller || !canAdvance(direction)) {
      resetBoundaryRunway();
      return false;
    }

    const distance = Math.max(360, scroller.clientHeight * 0.95);
    const magnitude = Math.max(0, Number(amount) || 0);

    if (boundaryDirection && boundaryDirection !== direction) {
      boundaryProgress = Math.max(0, boundaryProgress - magnitude / distance);
      boundaryOffsetPx = -boundaryDirection * boundaryProgress * scroller.clientHeight;
      boundaryReady = boundaryProgress >= 1;
      boundaryCommitDelta = 0;
      if (boundaryProgress <= 0.001) resetBoundaryRunway();
      return true;
    }

    if (!boundaryDirection) boundaryDirection = direction;
    if (boundaryProgress < 1) {
      boundaryProgress = Math.min(1, boundaryProgress + magnitude / distance);
      boundaryOffsetPx = -direction * boundaryProgress * scroller.clientHeight;
      boundaryReady = boundaryProgress >= 1;
      boundaryCommitDelta = 0;
      return true;
    }

    boundaryCommitDelta += magnitude;
    if (boundaryCommitDelta >= 36) {
      resetBoundaryRunway();
      advance(direction);
    }
    return true;
  }

  function atTop() {
    return !scroller || scroller.scrollTop <= 1;
  }

  function atBottom() {
    if (!scroller) return true;
    return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
  }

  function advance(direction) {
    if (!turns.length) return;
    const now = performance.now();
    if (now - lastAdvanceAt < 240) return;
    const next = Math.max(0, Math.min(turns.length - 1, activeIndex + direction));
    if (next === activeIndex) return;
    lastAdvanceAt = now;
    pendingEdge = direction < 0 ? 'end' : 'start';
    onActiveChange(next);
  }

  function scrollByAmount(amount) {
    if (!scroller) return;
    const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, Math.min(maxScrollTop, scroller.scrollTop + amount));
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="textbox"]'));
  }

  function handleKeydown(event) {
    if (!activeTurn || !scroller || isEditableTarget(event.target)) return;
    if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return;
    cancelEdgeSettle();

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      resetBoundaryRunway();
      scroller.scrollTop = event.key === 'Home'
        ? 0
        : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      return;
    }

    const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
    const atBoundary = direction > 0 ? atBottom() : atTop();
    event.preventDefault();

    if (atBoundary) {
      const boundaryAmount = event.key === 'PageUp' || event.key === 'PageDown'
        ? Math.max(160, Math.floor(scroller.clientHeight * 0.55))
        : 72;
      pushBoundary(direction, boundaryAmount);
      return;
    }

    resetBoundaryRunway();
    const amount = event.key === 'PageUp' || event.key === 'PageDown'
      ? Math.max(120, Math.floor(scroller.clientHeight * 0.85))
      : 52;
    scrollByAmount(direction * amount);
  }

  function handleWheel(event) {
    if (!activeTurn || !scroller) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    cancelEdgeSettle();

    if (boundaryDirection) {
      event.preventDefault();
      pushBoundary(event.deltaY >= 0 ? 1 : -1, Math.abs(event.deltaY));
      return;
    }
    if (event.deltaY > 0 && atBottom()) {
      event.preventDefault();
      pushBoundary(1, Math.abs(event.deltaY));
      return;
    }
    if (event.deltaY < 0 && atTop()) {
      event.preventDefault();
      pushBoundary(-1, Math.abs(event.deltaY));
      return;
    }
    resetBoundaryRunway();
  }

  function handleTouchStart(event) {
    cancelEdgeSettle();
    touchStartY = event.touches?.[0]?.clientY ?? null;
  }

  function handleTouchEnd(event) {
    if (touchStartY == null) return;
    const endY = event.changedTouches?.[0]?.clientY ?? touchStartY;
    const delta = endY - touchStartY;
    touchStartY = null;
    if (Math.abs(delta) < 54) return;
    if (boundaryDirection || (delta < 0 && atBottom()) || (delta > 0 && atTop())) {
      pushBoundary(delta < 0 ? 1 : -1, Math.abs(delta) * 1.25);
    }
  }

  onDestroy(() => {
    cancelEdgeSettle();
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="single-message-stage conversation-turn-stage">
  {#if activeTurn}
    <div class="single-message-position" aria-live="polite">
      <span>{activeIndex + 1} / {turns.length}</span>
      <span>一轮问答</span>
    </div>
    <div
      class="single-message-scroller"
      bind:this={scroller}
      onwheel={handleWheel}
      ontouchstart={handleTouchStart}
      ontouchend={handleTouchEnd}
      role="region"
      aria-label={`问答 ${activeIndex + 1} / ${turns.length}`}
    >
      <div
        class="single-message-content conversation-turn-content"
        style={`transform:translateY(${boundaryOffsetPx}px)`}
      >
        {#if activeTurn.user}
          <section class="turn-message turn-question">
            <MessageBubble message={activeTurn.user} {onBranch} />
          </section>
        {/if}
        {#each activeTurn.replies as reply (reply.id || reply.nodeId)}
          <section class={`turn-message turn-reply role-${reply?.role || 'unknown'}`}>
            <MessageBubble message={reply} {onBranch} />
          </section>
        {/each}
      </div>
    </div>
    {#if boundaryDirection}
      <div
        class:up={boundaryDirection < 0}
        class:down={boundaryDirection > 0}
        class:ready={boundaryReady}
        class="turn-boundary-runway"
        style={`height:${Math.max(0, Math.min(100, boundaryProgress * 100))}%`}
        aria-hidden="true"
      >
        <span>
          {#if boundaryReady}
            {boundaryDirection > 0 ? '再向下滚动进入下一轮问答' : '再向上滚动返回上一轮问答'}
          {:else}
            {boundaryDirection > 0 ? '继续向下滚动 · 下一轮问答' : '继续向上滚动 · 上一轮问答'}
          {/if}
        </span>
      </div>
    {/if}
  {/if}
</div>
