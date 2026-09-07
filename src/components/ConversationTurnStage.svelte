<script>
  import { onDestroy, tick } from 'svelte';
  import MessageBubble from './MessageBubble.svelte';
  import { nestedScrollerCanConsume, wheelDeltaPixels } from '../lib/scroll-input.js';

  let {
    turns = [],
    unresolved = [],
    activeIndex = 0,
    conversationKey = 'default',
    streaming = false,
    onActiveChange = () => {},
    onBranch = () => {},
    onRepairProtocol = () => {},
    onRetry = () => {},
    onDismiss = () => {},
    onEdit = () => {},
  } = $props();

  let scroller = $state(null);
  let content = $state(null);
  let pendingEdge = 'start';
  let previousKey = '';
  let previousTurnCount = 0;
  let tailPinned = $state(false);
  let canScroll = $state(false);
  let scrollProgress = $state(0);
  let boundaryDirection = $state(0);
  let boundaryProgress = $state(0);
  let boundaryOffsetPx = $state(0);
  let boundaryReady = $state(false);
  let boundaryCommitDelta = 0;
  let boundarySettleTimer = null;
  let lastAdvanceAt = 0;
  let touchStartY = null;
  let edgeSettleToken = 0;
  let edgeSettleTimers = [];

  const activeTurn = $derived(turns[activeIndex] || null);
  const turnCount = $derived(turns.length);
  const lastTurnActive = $derived(turnCount > 0 && activeIndex === turnCount - 1);
  const showUnresolved = $derived(
    unresolved.length > 0 && (turnCount === 0 || lastTurnActive)
  );
  const hasRenderableContent = $derived(Boolean(activeTurn || showUnresolved));
  const TAIL_STICKY_DISTANCE = 56;
  const canPrev = $derived(activeIndex > 0);
  const canNext = $derived(activeIndex < turnCount - 1);
  const replyList = $derived(activeTurn?.replies || []);
  const thoughtIdx = $derived(replyList.findIndex((message) => message?.thought));
  const toolIdx = $derived(replyList.findIndex((message) => message?.tool));
  const answerIdx = $derived(replyList.findIndex((message) => (message?.role === 'assistant') && (message?.text || message?.thought)));
  const hasThought = $derived(thoughtIdx >= 0);
  const hasTools = $derived(toolIdx >= 0);
  const hasAnswer = $derived(answerIdx >= 0);

  $effect(() => {
    const key = conversationKey;
    const index = activeIndex;
    const count = turnCount;
    if (!count || !scroller) {
      previousKey = key;
      previousTurnCount = count;
      tailPinned = false;
      return;
    }
    const conversationChanged = key !== previousKey;
    const appendedTurn = !conversationChanged && count > previousTurnCount;
    if (appendedTurn && tailPinned && index !== count - 1) {
      pendingEdge = 'end';
      previousTurnCount = count;
      onActiveChange(count - 1);
      return;
    }
    const edge = conversationChanged ? 'start' : pendingEdge;
    previousKey = key;
    previousTurnCount = count;
    pendingEdge = 'start';
    resetBoundaryRunway();
    settleEdge(edge);
  });

  $effect(() => {
    const node = content;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (tailPinned && lastTurnActive && !boundaryDirection && scroller) {
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      }
      updateScrollability();
    });
    observer.observe(node);
    return () => observer.disconnect();
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
        updateTailPinned();
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
    cancelBoundarySettle();
    boundaryDirection = 0;
    boundaryProgress = 0;
    boundaryOffsetPx = 0;
    boundaryReady = false;
    boundaryCommitDelta = 0;
  }

  function cancelBoundarySettle() {
    if (boundarySettleTimer) {
      clearTimeout(boundarySettleTimer);
      boundarySettleTimer = null;
    }
  }

  // Runway honesty: a ready-but-idle overlay must never freeze over content.
  // ~180ms after the last wheel/touch/key nudge with no further activity, a
  // ready runway auto-commits the turn change; an unready one decays away.
  function scheduleBoundarySettle() {
    cancelBoundarySettle();
    boundarySettleTimer = setTimeout(() => {
      boundarySettleTimer = null;
      if (!boundaryDirection) return;
      const direction = boundaryDirection;
      if (boundaryReady && canAdvance(direction)) {
        resetBoundaryRunway();
        advance(direction);
      } else {
        resetBoundaryRunway();
      }
    }, 180);
  }

  function prefersReducedMotion() {
    try {
      return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  function runwayOffset(direction) {
    if (!scroller || prefersReducedMotion()) return 0;
    return -direction * Math.pow(boundaryProgress, 0.85) * Math.min(180, scroller.clientHeight * 0.25);
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
      boundaryOffsetPx = runwayOffset(boundaryDirection);
      boundaryReady = boundaryProgress >= 1;
      boundaryCommitDelta = 0;
      if (boundaryProgress <= 0.001) resetBoundaryRunway();
      else scheduleBoundarySettle();
      return true;
    }

    if (!boundaryDirection) boundaryDirection = direction;
    if (boundaryProgress < 1) {
      boundaryProgress = Math.min(1, boundaryProgress + magnitude / distance);
      boundaryOffsetPx = runwayOffset(direction);
      boundaryReady = boundaryProgress >= 1;
      boundaryCommitDelta = 0;
      scheduleBoundarySettle();
      return true;
    }

    boundaryCommitDelta += magnitude;
    if (boundaryCommitDelta >= 36) {
      resetBoundaryRunway();
      advance(direction);
    } else {
      scheduleBoundarySettle();
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

  function updateTailPinned() {
    if (!scroller) {
      tailPinned = false;
      canScroll = false;
      return;
    }
    updateScrollability();
  }

  function updateScrollability() {
    if (!scroller) return;
    canScroll = scroller.scrollHeight > scroller.clientHeight + 4;
    const remaining = Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
    tailPinned = lastTurnActive && remaining <= TAIL_STICKY_DISTANCE;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scrollProgress = max > 0 ? Math.max(0, Math.min(1, scroller.scrollTop / max)) : 0;
  }

  function advance(direction) {
    if (!turns.length) return;
    cancelBoundarySettle();
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

  function scrollToTail() {
    if (!scroller) return;
    cancelEdgeSettle();
    resetBoundaryRunway();
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    updateTailPinned();
  }

  function stepTurn(direction) {
    if (!canAdvance(direction)) return;
    cancelEdgeSettle();
    resetBoundaryRunway();
    advance(direction);
  }

  function scrollElementWithinTurn(element) {
    if (!scroller || !element) return;
    cancelEdgeSettle();
    resetBoundaryRunway();
    const scrollerBox = scroller.getBoundingClientRect();
    const elementBox = element.getBoundingClientRect();
    const top = scroller.scrollTop + elementBox.top - scrollerBox.top - 12;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTo({ top: Math.max(0, Math.min(max, top)), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    updateTailPinned();
  }

  // Jump chips scroll within the mounted turn only; they never change turns.
  function scrollToSection(kind) {
    if (!scroller || !content) return;
    if (kind === 'question') {
      scrollElementWithinTurn(content.querySelector('.turn-question'));
      return;
    }
    const index = kind === 'thought' ? thoughtIdx : kind === 'tool' ? toolIdx : answerIdx;
    if (index == null || index < 0) return;
    scrollElementWithinTurn(content.querySelectorAll('.turn-message.turn-reply')[index]);
  }

  function isEditableTarget(target) {
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
  }

  function selectionActive() {
    try {
      return Boolean(window.getSelection?.()?.toString());
    } catch {
      return false;
    }
  }

  function handleKeydown(event) {
    if (!hasRenderableContent || !scroller || isEditableTarget(event.target)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      // Horizontal arrows still page turns from inside pre/.table-wrap: only a
      // real text selection or Shift (selection extension) keeps native behavior.
      if (event.shiftKey || selectionActive()) return;
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      if (canAdvance(direction)) {
        event.preventDefault();
        cancelEdgeSettle();
        resetBoundaryRunway();
        advance(direction);
      }
      return;
    }

    if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return;
    // Shift/selection keeps native behavior everywhere below.
    if (event.shiftKey || selectionActive()) return;
    // Vertical arrows keep native scroll-container behavior: when focus sits
    // inside a nested scroller that can still consume the motion, let it.
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && event.target instanceof Element) {
      const probe = event.key === 'ArrowDown' ? 40 : -40;
      if (nestedScrollerCanConsume(event.target, scroller, probe)) return;
    }
    cancelEdgeSettle();

    if (event.key === 'Home' || event.key === 'End') {
      const atTargetEdge = event.key === 'Home' ? atTop() : atBottom();
      if (!atTargetEdge) {
        event.preventDefault();
        resetBoundaryRunway();
        if (event.key === 'Home') tailPinned = false;
        scroller.scrollTop = event.key === 'Home'
          ? 0
          : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        updateTailPinned();
        return;
      }
      // At edge: Home/End pushes or does not leave turn abruptly
      return;
    }

    const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
    if (direction < 0) tailPinned = false;
    const atBoundary = direction > 0 ? atBottom() : atTop();
    event.preventDefault();

    if (atBoundary) {
      const boundaryAmount = event.key === 'PageUp' || event.key === 'PageDown'
        ? Math.max(180, Math.ceil(scroller.clientHeight * 0.55))
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
    if (!hasRenderableContent || !scroller) return;
    const delta = wheelDeltaPixels(event, scroller.clientHeight);
    if (!delta || nestedScrollerCanConsume(event.target, scroller, delta)) return;
    if (delta < 0) tailPinned = false;
    cancelEdgeSettle();

    if (boundaryDirection) {
      event.preventDefault();
      pushBoundary(delta >= 0 ? 1 : -1, Math.abs(delta));
      return;
    }
    if (delta > 0 && atBottom()) {
      event.preventDefault();
      pushBoundary(1, Math.abs(delta));
      return;
    }
    if (delta < 0 && atTop()) {
      event.preventDefault();
      pushBoundary(-1, Math.abs(delta));
      return;
    }
    resetBoundaryRunway();
  }

  function handleTouchStart(event) {
    cancelEdgeSettle();
    touchStartY = event.touches?.length === 1 ? event.touches[0].clientY : null;
  }

  function handleTouchEnd(event) {
    if (touchStartY == null) return;
    if (event.touches?.length || event.defaultPrevented) {
      touchStartY = null;
      return;
    }
    const endY = event.changedTouches?.[0]?.clientY ?? touchStartY;
    const delta = endY - touchStartY;
    touchStartY = null;
    if (Math.abs(delta) < 54) return;
    if (delta > 0) tailPinned = false;
    if (boundaryDirection || (delta < 0 && atBottom()) || (delta > 0 && atTop())) {
      pushBoundary(delta < 0 ? 1 : -1, Math.abs(delta) * 1.25);
    }
  }

  onDestroy(() => {
    cancelEdgeSettle();
    cancelBoundarySettle();
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="single-message-stage conversation-turn-stage">
  {#if hasRenderableContent}
    <div class="single-message-position turn-stage-header-badges" aria-live="polite">
      {#if activeTurn}
        <span class="turn-stepper" role="group" aria-label="问答轮次切换">
          <button
            type="button"
            class="turn-step"
            disabled={!canPrev}
            aria-label="上一轮问答"
            title="上一轮问答 (←)"
            onclick={() => stepTurn(-1)}
          >‹</button>
          <span class="turn-count">{activeIndex + 1} / {turns.length}</span>
          <button
            type="button"
            class="turn-step"
            disabled={!canNext}
            aria-label="下一轮问答"
            title="下一轮问答 (→)"
            onclick={() => stepTurn(1)}
          >›</button>
        </span>
        <span>一轮问答</span>
        {#if canScroll}
          <span class="turn-scroll-progress" aria-hidden="true"><i style={`width:${Math.round(scrollProgress * 100)}%`}></i></span>
        {/if}
        {#if lastTurnActive && canScroll}
          {#if tailPinned}
            {#if streaming}
              <span class="tail-follow-pill active" title="当前紧跟最新回复流式输出">
                <span class="tail-follow-dot"></span>跟随输出
              </span>
            {:else}
              <span class="tail-follow-pill settled" title="已在底部">已在底部</span>
            {/if}
          {:else}
            <button
              type="button"
              class="tail-follow-pill inactive clickable"
              onclick={scrollToTail}
              title="已向上浏览，点击回到底部紧跟输出"
            >
              ↓ 回到底部跟随
            </button>
          {/if}
        {/if}
      {:else}
        <span>对话关系同步未完成</span>
        <span>解析待修复</span>
      {/if}
    </div>
    {#if activeTurn && (hasThought || hasTools || hasAnswer)}
      <nav class="turn-jump-chips" aria-label="本轮内容跳转">
        <button type="button" onclick={() => scrollToSection('question')} title="跳到本轮提问">提问</button>
        {#if hasThought}
          <button type="button" onclick={() => scrollToSection('thought')} title="跳到本轮思考过程">思考</button>
        {/if}
        {#if hasTools}
          <button type="button" onclick={() => scrollToSection('tool')} title="跳到本轮工具调用">工具</button>
        {/if}
        {#if hasAnswer}
          <button type="button" onclick={() => scrollToSection('answer')} title="跳到本轮回答">回答</button>
        {/if}
      </nav>
    {/if}
    <div
      class="single-message-scroller"
      bind:this={scroller}
      onscroll={updateTailPinned}
      onwheel={handleWheel}
      ontouchstart={handleTouchStart}
      ontouchend={handleTouchEnd}
      role="region"
      aria-label={activeTurn ? `问答 ${activeIndex + 1} / ${turns.length}` : '对话关系同步未完成'}
      tabindex="0"
    >
      <div
        class="single-message-content conversation-turn-content"
        bind:this={content}
        style={`transform:translateY(${boundaryOffsetPx}px)`}
      >
        {#if activeTurn}
          <section class="turn-message turn-question">
            <MessageBubble message={activeTurn.user} {onBranch} {onRetry} {onDismiss} {onEdit} />
          </section>
          {#each activeTurn.replies as reply (reply.observationKey || reply.itemId || reply.id || reply.nodeId)}
            <section class={`turn-message turn-reply role-${reply?.role || 'unknown'}`}>
              <MessageBubble message={reply} {onBranch} {onRetry} {onDismiss} {onEdit} />
            </section>
          {/each}
        {/if}
        {#if showUnresolved}
          <section class="turn-unresolved-notice" role="status">
            <strong>对话关系同步未完成</strong>
            <span>还有 {unresolved.reduce((count, group) => count + group.replies.length, 0)} 条消息的协议关联未还原。这是解析或同步问题，不是一类独立回答。内容仍保留在下方供核对。</span>
            <button type="button" onclick={onRepairProtocol}>重新同步关联</button>
          </section>
          {#each unresolved as group (group.id)}
            <div class="turn-unresolved-group">
              {#each group.replies as reply (reply.observationKey || reply.itemId || reply.id || reply.nodeId)}
                <section class={`turn-message turn-reply role-${reply?.role || 'unknown'}`}>
                  {#if reply.ownershipFailure}
                    <details class="protocol-relation-evidence">
                      <summary>关联诊断：{reply.ownershipFailure.reason === 'conflicting-evidence' ? '标识冲突' : reply.ownershipFailure.reason === 'missing-user-message' ? '缺少用户消息' : reply.ownershipFailure.reason === 'missing-parent-message' ? '缺少父消息' : '关联链缺少用户锚点'}</summary>
                      <pre>{JSON.stringify(reply.ownershipFailure, null, 2)}</pre>
                    </details>
                  {/if}
                  <MessageBubble message={reply} {onBranch} {onRetry} {onDismiss} {onEdit} />
                </section>
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    </div>
    {#if boundaryDirection}
      <div
        class:up={boundaryDirection < 0}
        class:down={boundaryDirection > 0}
        class:ready={boundaryReady}
        class="turn-boundary-runway"
        style={`height:${Math.max(38, Math.min(100, boundaryProgress * 100))}%; opacity:${Math.min(1, 0.4 + boundaryProgress * 0.6)}`}
        aria-hidden="true"
      >
        <div class="turn-boundary-pill" class:pill-ready={boundaryReady}>
          <span class="turn-boundary-arrow">{boundaryDirection > 0 ? '↓' : '↑'}</span>
          <span class="turn-boundary-text">
            {#if boundaryReady}
              {boundaryDirection > 0 ? '继续滚动进入下一轮问答' : '继续滚动返回上一轮问答'}
            {:else}
              {boundaryDirection > 0 ? '继续向下滚动 · 下一轮问答' : '继续向上滚动 · 上一轮问答'}
            {/if}
          </span>
          <span class="turn-boundary-progress" style={`--progress:${Math.round(boundaryProgress * 100)}%`}></span>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .single-message-scroller {
    scrollbar-gutter: stable;
    content-visibility: auto;
  }
  .single-message-scroller:focus-visible {
    outline: none;
  }
  .turn-stage-header-badges {
    pointer-events: auto;
  }
  .tail-follow-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 9.5px;
    line-height: 1.5;
    transition: all 0.16s ease;
  }
  .tail-follow-pill.active {
    background: color-mix(in srgb, var(--f7-theme-color) 14%, var(--slim-surface));
    color: var(--f7-theme-color);
    border: 1px solid color-mix(in srgb, var(--f7-theme-color) 35%, transparent);
  }
  .tail-follow-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--f7-theme-color);
    animation: tail-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
  @keyframes tail-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.85); }
  }
  .tail-follow-pill.inactive {
    background: var(--slim-surface);
    color: var(--slim-text);
    border: 1px solid var(--slim-line);
    cursor: pointer;
  }
  .tail-follow-pill.inactive:hover {
    background: var(--slim-soft);
    border-color: color-mix(in srgb, var(--f7-theme-color) 40%, var(--slim-line));
    color: var(--f7-theme-color);
  }
  :global(.slimgpt-page.compact-layout) .turn-stage-header-badges {
    top: 8px;
    right: 10px;
  }
  .turn-boundary-pill {
    position: sticky;
    top: 50%;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 82%;
    padding: 8px 16px;
    border: 1px solid var(--slim-line);
    border-radius: 999px;
    background: color-mix(in srgb, var(--slim-surface) 92%, transparent);
    backdrop-filter: blur(8px);
    color: var(--slim-muted);
    font-size: 11.5px;
    font-weight: 500;
    box-shadow: 0 4px 18px rgba(0,0,0,.08);
    transition: color 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
  }
  .turn-boundary-pill.pill-ready {
    color: var(--f7-theme-color);
    border-color: color-mix(in srgb, var(--f7-theme-color) 60%, var(--slim-line));
    transform: scale(1.03);
  }
  .turn-boundary-arrow {
    font-weight: bold;
    font-size: 12px;
  }
  .turn-stepper {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
  .turn-step {
    display: inline-grid;
    place-items: center;
    min-width: 22px;
    height: 22px;
    padding: 0 4px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--slim-muted);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .turn-step:hover:not(:disabled) {
    background: var(--slim-soft);
    border-color: var(--slim-line);
    color: var(--f7-theme-color);
  }
  .turn-step:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .turn-count {
    min-width: 44px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .turn-scroll-progress {
    display: inline-block;
    width: 56px;
    height: 3px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--slim-line) 70%, transparent);
    overflow: hidden;
    vertical-align: middle;
  }
  .turn-scroll-progress > i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: color-mix(in srgb, var(--f7-theme-color) 65%, transparent);
  }
  .turn-jump-chips {
    position: absolute;
    top: 44px;
    right: 16px;
    z-index: 2;
    display: inline-flex;
    gap: 4px;
    padding: 3px;
    border: 1px solid var(--slim-line);
    border-radius: 999px;
    background: color-mix(in srgb, var(--slim-bg) 92%, transparent);
    backdrop-filter: blur(8px);
    pointer-events: auto;
  }
  .turn-jump-chips button {
    padding: 2px 9px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--slim-muted);
    font-size: 10px;
    line-height: 1.6;
    cursor: pointer;
  }
  .turn-jump-chips button:hover {
    background: var(--slim-soft);
    color: var(--f7-theme-color);
  }
  .tail-follow-pill.settled {
    background: var(--slim-surface);
    color: var(--slim-muted);
    border: 1px solid var(--slim-line);
  }
  .turn-boundary-progress {
    position: absolute;
    left: 18px;
    right: 18px;
    bottom: 9px;
    height: 3px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--slim-line) 75%, transparent);
    overflow: hidden;
  }
  .turn-boundary-progress::after {
    content: "";
    display: block;
    height: 100%;
    width: var(--progress, 0%);
    border-radius: inherit;
    background: var(--f7-theme-color);
  }
  @media (prefers-reduced-motion: reduce) {
    .conversation-turn-content {
      will-change: auto;
    }
    .tail-follow-dot {
      animation: none;
    }
    .turn-boundary-pill,
    .turn-boundary-pill.pill-ready {
      transform: none;
      transition: none;
    }
    .turn-boundary-progress::after {
      transition: none;
    }
  }
</style>
