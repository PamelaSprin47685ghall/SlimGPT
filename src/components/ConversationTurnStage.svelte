<script>
  import { onDestroy, tick, untrack } from 'svelte';
  import MessageBubble from './MessageBubble.svelte';
  import { nestedScrollerCanConsume, wheelDeltaPixels } from '../lib/scroll-input.js';

  let {
    turns = [],
    unresolved = [],
    activeIndex = 0,
    conversationKey = 'default',
    streaming = false,
    justSent = false,
    onActiveChange = () => {},
    onBranch = () => {},
    onRepairProtocol = () => {},
    onRetry = () => {},
    onDismiss = () => {},
    onEdit = () => {},
    onQuote = () => {},
    onCopyTurn = () => {},
    onOpenOverview = () => {},
  } = $props();

  let scroller = $state(null);
  let content = $state(null);
  let pendingEdge = 'start';
  let previousKey = '';
  let previousTurnCount = 0;
  // Rank1 scroll memory: per-turn scrollTop map. Keyed by conversation + turn
  // identity so back-and-forth flips restore offsets instead of forcing edges.
  const turnScrollTops = new Map();
  // Programmatic edge settles (turn switches, boundary landings) must not
  // poison scroll memory: their scroll events carry the settle target, not
  // a user offset. Revisiting a turn landed at the bottom would otherwise
  // restore the bottom, and a within-turn PageDown would hit the boundary
  // runway instead of scrolling.
  let suppressRememberTop = null;
  // Rank10 copy feedback: '' | 'copied' | 'failed' (2.4s inline confirm).
  let copyTurnStatus = $state('');
  let copyTurnTimer = null;
  // Rank6 multi jump chips: cycle cursor per kind, reset on turn switch.
  let thoughtCycle = $state(0);
  let toolCycle = $state(0);
  let answerCycle = $state(0);
  // Rank8 settle guard: track rAF handles so stale frames never fire.
  let edgeSettleRafs = [];

  function turnKeyFor(index) {
    const turn = turns[index];
    const id = turn?.id || turn?.user?.observationKey || turn?.user?.itemId || turn?.user?.nodeId || turn?.user?.id;
    return `${conversationKey}::${id ?? 'idx-' + index}`;
  }

  function rememberScrollTop() {
    if (!scroller) return;
    if (suppressRememberTop != null && Math.abs(scroller.scrollTop - suppressRememberTop) <= 1) return;
    suppressRememberTop = null;
    turnScrollTops.set(turnKeyFor(activeIndex), scroller.scrollTop);
  }
  // Pure follow/target predicates (mirrored in tests/reading-converge5.test.js).
  // shouldFollowOnGrowth: a cached pinned=false must not veto following
  // when the viewport IS at the bottom as content grows.
  function shouldFollowOnGrowth(pinned, liveAtBottom) {
    return Boolean(pinned || liveAtBottom);
  }
  // resolveSameTurnTarget: a same-turn re-settle while following the tail
  // re-affirms the live end instead of restoring a just-superseded
  // remembered offset (anti-yank); all other cases honor memory/edge.
  function resolveSameTurnTarget({ sameTurn, followingTail, savedOffset, edge }) {
    if (sameTurn && followingTail) return 'end';
    return savedOffset != null && edge !== 'end' ? savedOffset : edge;
  }
  let tailPinned = $state(false);
  // Live tail authority: derived from actual distance on every scroll event
  // (synthetic or native), refreshed on every stream follow. Growth alone
  // never clears it, so a cached pinned=false can't strand a tail reader.
  // Only a genuine scroll away from the bottom parks the reader.
  let tailLiveAtBottom = false;
  // Previously settled turn key: distinguishes same-turn re-settles
  // (streaming growth re-running the turn effect) from genuine switches.
  let previousTurnKey = '';
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
  let inertiaLockedUntil = 0;
  let inertiaLockDirection = 0;
  let boundaryClosing = $state(false);
  let boundaryClosingTimer = null;
  let quoteSelection = $state(null);
  let previousStreaming = false;
  let previousActiveIndex = null;

  const activeTurn = $derived(turns[activeIndex] || null);
  const turnCount = $derived(turns.length);
  const lastTurnActive = $derived(turnCount > 0 && activeIndex === turnCount - 1);
  const showUnresolved = $derived(
    unresolved.length > 0 && (turnCount === 0 || lastTurnActive)
  );
  const hasRenderableContent = $derived(Boolean(activeTurn || showUnresolved));
  const TAIL_STICKY_DISTANCE = 32;
  const canPrev = $derived(activeIndex > 0);
  const canNext = $derived(activeIndex < turnCount - 1);
  const replyList = $derived(activeTurn?.replies || []);
  // Rank6: collect ALL indices per kind so chips can cycle multi-match turns.
  const thoughtIndices = $derived(replyList.map((message, index) => (message?.thought || message?.isThinking) ? index : -1).filter((index) => index >= 0));
  const toolIndices = $derived(replyList.map((message, index) => (message?.tool ? index : -1)).filter((index) => index >= 0));
  const answerIndices = $derived(replyList.map((message, index) => (message?.role === 'assistant' && (message?.text || message?.thought)) ? index : -1).filter((index) => index >= 0));
  const hasThought = $derived(thoughtIndices.length > 0);
  const hasTools = $derived(toolIndices.length > 0);
  const hasAnswer = $derived(answerIndices.length > 0);
  const thoughtLabel = $derived(thoughtIndices.length > 1 ? `思考 ${Math.min(thoughtCycle, thoughtIndices.length - 1) + 1}/${thoughtIndices.length}` : '思考');
  const toolLabel = $derived(toolIndices.length > 1 ? `工具 ${Math.min(toolCycle, toolIndices.length - 1) + 1}/${toolIndices.length}` : '工具');
  const answerLabel = $derived(answerIndices.length > 1 ? `回答 ${Math.min(answerCycle, answerIndices.length - 1) + 1}/${answerIndices.length}` : '回答');
  // Rank10 unresolved honesty: count chip when off-tail with pending items.
  const unresolvedCount = $derived(unresolved.reduce((total, group) => total + (group?.replies?.length || 0), 0));
  const showOffTailUnresolvedChip = $derived(unresolvedCount > 0 && turnCount > 0 && !lastTurnActive);
  // Rank4 branch-during-stream: live tail turn while generating.
  const branchLive = $derived(streaming && lastTurnActive);

  $effect(() => {
    const isStreaming = streaming;
    const index = activeIndex;
    const wasStreaming = previousStreaming;
    const wasIndex = previousActiveIndex;
    previousStreaming = isStreaming;
    previousActiveIndex = index;

    if (turnCount > 0 && index === turnCount - 1) {
      if ((!wasStreaming && isStreaming) || (wasIndex !== index && isStreaming)) {
        tailPinned = true;
        settleEdge('end');
      }
    }
  });

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
    if (conversationChanged) {
      turnScrollTops.clear();
      suppressRememberTop = null;
    }
    // Rank4: clamp defensively without yanking scroll — no settle, no edge.
    if (index < 0 || index >= count) {
      previousKey = key;
      previousTurnCount = count;
      onActiveChange(Math.max(0, Math.min(count - 1, index)));
      return;
    }
    const appendedTurn = !conversationChanged && count > previousTurnCount;
    const wasOnLastTurn = previousTurnCount > 0 && index === previousTurnCount - 1;
    if (appendedTurn) {
      if (wasOnLastTurn || justSent) {
        pendingEdge = 'end';
        tailPinned = true;
        previousTurnCount = count;
        onActiveChange(count - 1);
        return;
      }
      previousTurnCount = count;
      tailPinned = false;
      return;
    }
    // Rank1: restore saved offset for visited turns; fresh entries
    // (streaming tail, first open, boundary crossing) use the edge.
    const nextKey = turnKeyFor(index);
    // Same-turn content growth (streaming re-running this effect via the
    // turns read in turnKeyFor) must NEVER re-settle scroll: no memory
    // restore, no edge apply. The RO path owns growth frames (follow iff
    // tailLiveAtBottom || tailPinned, else hands off). Detached frames also
    // cancel stale programmatic settles so a 60/140/260ms 'end' timer queued
    // while at the tail cannot yank a reader who scrolled away during the
    // settle window (ordering harden, not timing). Genuine switches,
    // conversation changes, and explicit navigation fall through to the
    // settle + memory path below. Scroll-away clears tailLiveAtBottom /
    // tailPinned synchronously in handleStageScroll, so no stale follow
    // authority survives a synthetic scroll event.
    const sameTurnGrowth = !conversationChanged && previousTurnKey !== '' && nextKey === previousTurnKey;
   if (sameTurnGrowth) {
      previousKey = key;
     previousTurnCount = count;
      const liveFollowing = untrack(() => lastTurnActive && (tailPinned || tailLiveAtBottom));
      if (!liveFollowing) cancelEdgeSettle();
      return;
    }
    // Rank6/9: fresh turn identity resets jump-chip cycle cursors.
    // Only genuine switches reach here; growth frames above must not reset
    // chip cycling.
    thoughtCycle = 0;
    toolCycle = 0;
    answerCycle = 0;
    const savedOffset = turnScrollTops.get(nextKey);
    const edge = conversationChanged ? 'start' : pendingEdge;
    // Genuine switch: drop stale live-tail authority, then honor
    // memory/edge. Same-turn tail follow never reaches here (RO owns it).
    // untrack: pin reads are point-in-time; they must not resubscribe.
    tailLiveAtBottom = false;
    const followingTail = untrack(() => lastTurnActive && (tailPinned || tailLiveAtBottom));
    const target = resolveSameTurnTarget({ sameTurn: false, followingTail, savedOffset, edge });
    previousKey = key;
    previousTurnCount = count;
    previousTurnKey = nextKey;
    pendingEdge = 'start';
    resetBoundaryRunway();
    cancelEdgeSettle();
    settleScroll(target);
  });

  $effect(() => {
    const node = content;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // Live tail authority: follow when pinned OR actually at the bottom.
      // tailLiveAtBottom is derived from live distance on scroll events and
      // refreshed below, so growth alone can never strand a tail reader.
      if (lastTurnActive && !boundaryDirection && scroller && shouldFollowOnGrowth(tailPinned, tailLiveAtBottom)) {
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        tailLiveAtBottom = true;
      }
      updateScrollability();
    });
    observer.observe(node);
    return () => observer.disconnect();
  });

  function cancelEdgeSettle() {
    edgeSettleToken += 1;
    for (const timer of edgeSettleTimers.splice(0)) clearTimeout(timer);
    for (const raf of edgeSettleRafs.splice(0)) {
      try {
        cancelAnimationFrame(raf);
      } catch {
        // ignore missing rAF handles in non-DOM runtimes
      }
    }
  }

  function applyScrollTarget(target) {
    if (!scroller) return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const next = typeof target === 'number'
      ? Math.max(0, Math.min(max, target))
      : (target === 'end' ? max : 0);
    suppressRememberTop = next;
    scroller.scrollTop = next;
    updateTailPinned();
  }

  // Rank8: generation-token guard — every async apply re-checks the token
  // so stale timeouts/rAFs from a previous turn never fire after a switch.
  function settleScroll(target) {
    cancelEdgeSettle();
    const token = edgeSettleToken;
    void tick().then(() => {
      if (!scroller || token !== edgeSettleToken) return;
      applyScrollTarget(target);
      const raf1 = requestAnimationFrame(() => {
        if (token !== edgeSettleToken) return;
        applyScrollTarget(target);
        const raf2 = requestAnimationFrame(() => {
          if (token !== edgeSettleToken) return;
          applyScrollTarget(target);
        });
        edgeSettleRafs.push(raf2);
      });
      edgeSettleRafs.push(raf1);
      if (target === 'end') {
        for (const delay of [60, 140, 260]) {
          edgeSettleTimers.push(setTimeout(() => {
            if (token !== edgeSettleToken) return;
            applyScrollTarget(target);
          }, delay));
        }
      }
    });
  }

  function settleEdge(edge) {
    settleScroll(edge);
  }

  function canAdvance(direction) {
    if (direction > 0) return activeIndex < turns.length - 1;
    return activeIndex > 0;
  }

  function resetBoundaryRunway() {
    cancelBoundarySettle();
    cancelBoundaryClosing();
    if (boundaryClosingTimer) {
      clearTimeout(boundaryClosingTimer);
      boundaryClosingTimer = null;
    }
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

  function cancelBoundaryClosing() {
    boundaryClosing = false;
    if (boundaryClosingTimer) {
      clearTimeout(boundaryClosingTimer);
      boundaryClosingTimer = null;
    }
  }

  // Runway honesty: a ready-but-idle overlay must never freeze over content.
  // An unready or idle runway decays away. Commits require an explicit follow-up nudge (delta >= 36).
  function scheduleBoundarySettle(delay = 400) {
    cancelBoundarySettle();
    boundarySettleTimer = setTimeout(() => {
      boundarySettleTimer = null;
      if (!boundaryDirection) return;
      boundaryClosing = true;
      boundaryClosingTimer = setTimeout(resetBoundaryRunway, 400);
    }, delay);
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

  function pushBoundary(direction, amount, settleDelay = 400) {
    cancelBoundarySettle();
    cancelBoundaryClosing();
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
      else scheduleBoundarySettle(settleDelay);
      return true;
    }

    if (!boundaryDirection) boundaryDirection = direction;
    if (boundaryProgress < 1) {
      boundaryProgress = Math.min(1, boundaryProgress + magnitude / distance);
      boundaryOffsetPx = runwayOffset(direction);
      boundaryReady = boundaryProgress >= 1;
      boundaryCommitDelta = 0;
      scheduleBoundarySettle(settleDelay);
      return true;
    }

    boundaryCommitDelta += magnitude;
    if (boundaryCommitDelta >= 36) {
      resetBoundaryRunway();
      advance(direction, { fromBoundary: true });
    } else {
      scheduleBoundarySettle(settleDelay);
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
    // Rank5 tail stick continuity: only auto-stick while already pinned; a
    // user upward scroll unpins until they return to the bottom (<=2px).
    if (!lastTurnActive) {
      tailPinned = false;
    } else if (tailPinned) {
      tailPinned = remaining <= TAIL_STICKY_DISTANCE;
    } else {
      tailPinned = remaining <= 2;
    }
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scrollProgress = max > 0 ? Math.max(0, Math.min(1, scroller.scrollTop / max)) : 0;
  }

  function handleStageScroll() {
    rememberScrollTop();
    // Live at-bottom derivation: actual distance right now, whether this
    // scroll event is synthetic (fixture setup) or native, trusted or not.
    if (scroller) {
      tailLiveAtBottom =
        Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 2;
    }
    updateTailPinned();
  }

  // Rank1: plain flips (stepper/arrows/J-K/overview) never set pendingEdge —
  // the turn effect restores the saved offset. Only runway boundary commits
  // pass fromBoundary to force the landing edge and drop the saved offset.
  function advance(direction, opts = {}) {
    if (!turns.length) return;
    cancelEdgeSettle();
    resetBoundaryRunway();
    const now = performance.now();
    if (now - lastAdvanceAt < 240) return;
    const next = Math.max(0, Math.min(turns.length - 1, activeIndex + direction));
    if (next === activeIndex) return;
    lastAdvanceAt = now;
    inertiaLockedUntil = now + 350;
    inertiaLockDirection = direction;
    if (opts.fromBoundary) {
      pendingEdge = direction < 0 ? 'end' : 'start';
      turnScrollTops.delete(turnKeyFor(next));
    }
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
    tailLiveAtBottom = true;
    updateTailPinned();
  }

  // Rank9: Shift+click jumps ±5 turns; plain click stays ±1.
  function stepTurn(direction, event = null) {
    if (!turns.length) return;
    const stride = event?.shiftKey ? 5 : 1;
    const now = performance.now();
    if (now - lastAdvanceAt < 240) return;
    const next = Math.max(0, Math.min(turns.length - 1, activeIndex + direction * stride));
    if (next === activeIndex) return;
    lastAdvanceAt = now;
    cancelEdgeSettle();
    resetBoundaryRunway();
    inertiaLockedUntil = now + 350;
    inertiaLockDirection = direction;
    onActiveChange(next);
  }

  function scrollElementWithinTurn(element) {
    if (!scroller || !element) return;
    cancelEdgeSettle();
    resetBoundaryRunway();
    const scrollerBox = scroller.getBoundingClientRect();
    const elementBox = element.getBoundingClientRect();
    const top = scroller.scrollTop + elementBox.top - scrollerBox.top - 64;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTo({ top: Math.max(0, Math.min(max, top)), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    if (typeof element.focus === 'function') {
      if (!element.hasAttribute('tabindex')) {
        element.setAttribute('tabindex', '-1');
      }
      try {
        element.focus({ preventScroll: true });
      } catch {
        element.focus();
      }
    }
    updateTailPinned();
  }

  // Jump chips scroll within the mounted turn only; they never change turns.
  // Rank6: chips cycle through ALL matches per kind (工具 2/3 style);
  // single-match turns behave exactly as before.
  function cycleJump(kind) {
    if (!scroller || !content) return;
    if (kind === 'question') {
      scrollElementWithinTurn(content.querySelector('.turn-question'));
      return;
    }
    const indices = kind === 'thought' ? thoughtIndices : kind === 'tool' ? toolIndices : answerIndices;
    if (!indices.length) return;
    const cursor = kind === 'thought' ? thoughtCycle : kind === 'tool' ? toolCycle : answerCycle;
    const pick = indices[cursor % indices.length];
    scrollElementWithinTurn(content.querySelectorAll('.turn-message.turn-reply')[pick]);
    const next = (cursor + 1) % indices.length;
    if (kind === 'thought') thoughtCycle = next;
    else if (kind === 'tool') toolCycle = next;
    else answerCycle = next;
  }

  // Rank4 branch guard: no branch switching on the live tail while running.
  function handleBranch(nodeId, delta) {
    if (branchLive) return;
    onBranch(nodeId, delta);
  }

  function jumpToLatestTurn() {
    if (turnCount <= 0 || lastTurnActive) return;
    cancelEdgeSettle();
    resetBoundaryRunway();
    pendingEdge = 'end';
    turnScrollTops.delete(turnKeyFor(turnCount - 1));
    onActiveChange(turnCount - 1);
  }

  // Rank10 copy local feedback: 已复制/复制失败 inline 2.4s; HomePage
  // copyTurnMarkdown already falls back to the composer notice on failure.
  async function handleCopyTurn() {
    if (copyTurnTimer) {
      clearTimeout(copyTurnTimer);
      copyTurnTimer = null;
    }
    let ok = false;
    try {
      ok = (await onCopyTurn(activeTurn)) !== false;
    } catch {
      ok = false;
    }
    copyTurnStatus = ok ? 'copied' : 'failed';
    copyTurnTimer = setTimeout(() => {
      copyTurnStatus = '';
      copyTurnTimer = null;
    }, 2400);
  }
  function isEditableTarget(target) {
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
  }

  // Rank2 arrow scope denylist: ArrowLeft/Right flip turns whenever the
  // event target is inside the stage, EXCEPT interactive/editable nests
  // (button, input, textarea, select, a[href], [contenteditable], code-shell
  // buttons) and horizontal-scroll blocks. The composer is never hijacked.
  const ARROW_FLIP_DENY_SELECTOR = 'button, input, textarea, select, a[href], [contenteditable], [role="textbox"], [role="button"], pre, .table-wrap, .math-block, .tool-toml-pre, .tool-payload-block, .code-block, .code-shell';

  function isArrowTurnFlipDenied(target) {
    if (!target || target === document.body || target === document.documentElement) return false;
    if (!(target instanceof Element)) return false;
    if (target.closest?.('.composer-shell')) return true;
    if (target.closest?.('.conversation-sidebar, .message-overview, .desktop-chat-header, .mobile-navbar')) return true;
    if (target.closest?.(ARROW_FLIP_DENY_SELECTOR)) return true;
    if (target.closest?.('.conversation-turn-stage, .single-message-scroller')) return false;
    if (target === scroller) return false;
    return true;
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
    if (event.target?.closest?.('.conversation-sidebar, .message-overview, .composer-shell, .desktop-chat-header, .mobile-navbar')) {
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      cancelEdgeSettle();
      resetBoundaryRunway();
      const targetIndex = event.key === 'Home' ? 0 : turns.length - 1;
      if (targetIndex !== activeIndex) {
        pendingEdge = event.key === 'Home' ? 'start' : 'end';
        turnScrollTops.delete(turnKeyFor(targetIndex));
        if (event.key === 'Home') tailPinned = false;
        else tailPinned = true;
        onActiveChange(targetIndex);
      } else {
        scroller.scrollTop = event.key === 'Home'
          ? 0
          : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (event.key === 'Home') tailPinned = false;
        updateTailPinned();
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (event.shiftKey || selectionActive()) return;
      // Rank2: denylist scope — flip whenever the target is inside the stage
      // EXCEPT interactive/editable nests; never hijack the composer.
      if (isArrowTurnFlipDenied(event.target)) return;
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      if (canAdvance(direction)) {
        event.preventDefault();
        advance(direction);
      }
      return;
    }

    if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return;
    if (event.shiftKey || selectionActive()) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key) && event.target instanceof Element) {
      const isPage = event.key === 'PageUp' || event.key === 'PageDown';
      const isDown = event.key === 'ArrowDown' || event.key === 'PageDown';
      const probeMagnitude = isPage ? Math.max(80, Math.round(scroller.clientHeight * 0.8)) : 40;
      const probe = isDown ? probeMagnitude : -probeMagnitude;
      if (nestedScrollerCanConsume(event.target, scroller, probe)) return;
    }
    cancelEdgeSettle();

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const atTargetEdge = event.key === 'Home' ? atTop() : atBottom();
      if (!atTargetEdge) {
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
      pushBoundary(direction, boundaryAmount, 360);
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
    const now = performance.now();
    const delta = wheelDeltaPixels(event, scroller.clientHeight);
    if (now < inertiaLockedUntil && inertiaLockDirection !== 0) {
      const deltaDir = delta > 0 ? 1 : delta < 0 ? -1 : 0;
      if (deltaDir === inertiaLockDirection) {
        event.preventDefault();
        return;
      }
      inertiaLockedUntil = 0;
      inertiaLockDirection = 0;
    }
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

  function handleTouchMove(event) {
    if (touchStartY == null || !scroller) return;
    if (event.touches?.length !== 1) return;
    const currentY = event.touches[0].clientY;
    const deltaY = currentY - touchStartY;
    const direction = deltaY < 0 ? 1 : -1;
    if (!canAdvance(direction)) return;

    const isAtEdge = direction > 0 ? atBottom() : atTop();
    if (!boundaryDirection && !isAtEdge) return;

    const distance = Math.max(280, scroller.clientHeight * 0.7);
    const progress = Math.min(1, Math.abs(deltaY) / distance);
    boundaryDirection = direction;
    boundaryProgress = progress;
    boundaryOffsetPx = runwayOffset(direction);
    boundaryReady = progress >= 1;
    if (progress >= 1) {
      boundaryCommitDelta = Math.abs(deltaY) - distance;
    } else {
      boundaryCommitDelta = 0;
    }
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
    if (boundaryDirection && boundaryReady) {
      const direction = boundaryDirection;
      resetBoundaryRunway();
      advance(direction, { fromBoundary: true });
      return;
    }
    if (boundaryDirection) {
      scheduleBoundarySettle(120);
      return;
    }
    if (Math.abs(delta) < 54) return;
    if (delta > 0) tailPinned = false;
    if ((delta < 0 && atBottom()) || (delta > 0 && atTop())) {
      pushBoundary(delta < 0 ? 1 : -1, Math.abs(delta) * 1.25);
    }
  }

  onDestroy(() => {
    cancelEdgeSettle();
    cancelBoundarySettle();
    cancelBoundaryClosing();
    if (copyTurnTimer) {
      clearTimeout(copyTurnTimer);
      copyTurnTimer = null;
    }
  });

  function handleSelectionChange() {
    if (typeof window === 'undefined') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      quoteSelection = null;
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      quoteSelection = null;
      return;
    }
    const anchorNode = sel.anchorNode;
    const focusNode = sel.focusNode;
    const assistantEl = anchorNode?.parentElement?.closest?.('.turn-reply.role-assistant, .message-card.role-assistant');
    if (!assistantEl) {
      quoteSelection = null;
      return;
    }
    if (!scroller?.contains(anchorNode) || !scroller?.contains(focusNode)) {
      quoteSelection = null;
      return;
    }
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const stageEl = scroller.parentElement;
    const stageRect = stageEl ? stageEl.getBoundingClientRect() : { left: 0, top: 0 };
    quoteSelection = {
      text,
      x: rect.left + rect.width / 2 - stageRect.left,
      y: rect.top - stageRect.top,
    };
  }

  function applyQuote() {
    if (!quoteSelection?.text) return;
    const lines = quoteSelection.text.split('\n');
    const quoteMarkdown = lines.map((line) => `> ${line}`).join('\n') + '\n\n';
    onQuote(quoteMarkdown);
    quoteSelection = null;
    window.getSelection()?.removeAllRanges?.();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="single-message-stage conversation-turn-stage" class:has-jump-chips={activeTurn && (hasThought || hasTools || hasAnswer)}>
  {#if hasRenderableContent}
    <div class="single-message-position turn-stage-header-badges" aria-live="polite">
      {#if activeTurn}
        <span class="turn-stepper" role="group" aria-label="问答轮次切换">
          <button
            type="button"
            class="turn-step"
            disabled={!canPrev}
            aria-label="上一轮问答"
            title="上一轮问答 (←)，Shift+点击一次跳 5 轮"
            onclick={(event) => stepTurn(-1, event)}
          >‹</button>
          <button
            type="button"
            class="turn-count turn-count-btn"
            onclick={() => onOpenOverview()}
            title="打开消息概览，快速跳转问答轮次"
            aria-label={`打开消息概览，当前第 ${activeIndex + 1} 轮，共 ${turns.length} 轮`}
          >{activeIndex + 1} / {turns.length}</button>
          <button
            type="button"
            class="turn-step"
            disabled={!canNext}
            aria-label="下一轮问答"
            title="下一轮问答 (→)，Shift+点击一次跳 5 轮"
            onclick={(event) => stepTurn(1, event)}
          >›</button>
        </span>
        {#if onCopyTurn}
          <button
            type="button"
            class="turn-step turn-copy-btn"
            class:copied={copyTurnStatus === 'copied'}
            class:copy-failed={copyTurnStatus === 'failed'}
            onclick={handleCopyTurn}
            aria-label="复制本轮问答"
            title="复制本轮问答 Markdown"
          >{copyTurnStatus === 'copied' ? '已复制' : copyTurnStatus === 'failed' ? '复制失败' : '复制本轮'}</button>
        {/if}
        {#if showOffTailUnresolvedChip}
          <button
            type="button"
            class="turn-unresolved-chip"
            onclick={jumpToLatestTurn}
            title="有未关联消息在最新一轮，点击跳到最新一轮"
            aria-label={`有 ${unresolvedCount} 条未关联消息，点击跳到最新一轮`}
          >未关联 {unresolvedCount} · 去最新</button>
        {/if}
        <span>一轮问答</span>
        {#if canScroll}
          <span class="turn-scroll-progress" aria-hidden="true"><i style={`width:${Math.round(scrollProgress * 100)}%`}></i></span>
        {/if}
      {:else}
        <span>对话关系同步未完成</span>
        <span>解析待修复</span>
      {/if}
    </div>
    {#if activeTurn && (hasThought || hasTools || hasAnswer)}
      <nav class="turn-jump-chips" aria-label="本轮内容跳转">
        <button type="button" onclick={() => cycleJump('question')} title="跳到本轮提问">提问</button>
        {#if hasThought}
          <button type="button" onclick={() => cycleJump('thought')} title={thoughtIndices.length > 1 ? `跳到本轮思考过程（共 ${thoughtIndices.length} 处，点击循环切换）` : '跳到本轮思考过程'}>{thoughtLabel}</button>
        {/if}
        {#if hasTools}
          <button type="button" onclick={() => cycleJump('tool')} title={toolIndices.length > 1 ? `跳到本轮工具调用（共 ${toolIndices.length} 处，点击循环切换）` : '跳到本轮工具调用'}>{toolLabel}</button>
        {/if}
        {#if hasAnswer}
          <button type="button" onclick={() => cycleJump('answer')} title={answerIndices.length > 1 ? `跳到本轮回答（共 ${answerIndices.length} 处，点击循环切换）` : '跳到本轮回答'}>{answerLabel}</button>
        {/if}
      </nav>
    {/if}
    <div
      class="single-message-scroller"
      bind:this={scroller}
      onscroll={handleStageScroll}
      onmouseup={handleSelectionChange}
      onwheel={handleWheel}
      ontouchstart={handleTouchStart}
      ontouchmove={handleTouchMove}
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
            <MessageBubble message={activeTurn.user} onBranch={handleBranch} branchDisabled={branchLive} {onRetry} {onDismiss} {onEdit} {onQuote} />
          </section>
          {#each activeTurn.replies as reply (reply.observationKey || reply.itemId || reply.id || reply.nodeId)}
            <section class={`turn-message turn-reply role-${reply?.role || 'unknown'}`}>
              <MessageBubble message={reply} onBranch={handleBranch} branchDisabled={branchLive} {onRetry} {onDismiss} {onEdit} {onQuote} />
            </section>
          {/each}
          {#if streaming && lastTurnActive && (!activeTurn.replies || activeTurn.replies.length === 0)}
            <section class="turn-message turn-reply role-assistant assistant-skeleton">
              <div class="message-avatar skeleton-pulse" aria-hidden="true">S</div>
              <div class="message-card-body">
                <div class="message-meta">
                  <span class="message-author-name">ChatGPT</span>
                </div>
                <div class="message-bubble">
                  <div class="thinking-indicator" role="status" aria-live="polite">
                    <span class="thinking-spinner" aria-hidden="true"></span>
                    <span>正在思考…</span>
                  </div>
                </div>
              </div>
            </section>
          {/if}
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
                  <MessageBubble message={reply} onBranch={handleBranch} branchDisabled={branchLive} {onRetry} {onDismiss} {onEdit} {onQuote} />
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
        class:closing={boundaryClosing}
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
    {#if lastTurnActive && canScroll}
      <div class="tail-follow-bottom-anchor">
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
      </div>
    {/if}
    {#if quoteSelection}
      <div class="selection-quote-tooltip" style={`left:${quoteSelection.x}px; top:${quoteSelection.y}px`}>
        <button
          type="button"
          class="selection-quote-btn"
          onclick={applyQuote}
          title="引用选中文本到输入框"
        >
          <span>引用</span>
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  :global(.single-message-content) {
    width: min(800px, calc(100% - 48px));
    max-width: 800px;
  }
  .single-message-scroller {
    scrollbar-gutter: stable;
    overflow-x: hidden;
    content-visibility: auto;
  }
  .turn-stage-header-badges {
    pointer-events: auto;
  }
  .turn-copy-btn {
    min-width: unset;
    padding: 0 6px;
    font-size: 11px;
    height: 22px;
    border-radius: 6px;
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
    transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
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
    right: max(16px, env(safe-area-inset-right));
    z-index: 2;
    display: inline-flex;
    gap: 4px;
    max-width: calc(100% - 32px);
    overflow-x: auto;
    padding: 3px;
    border: 1px solid var(--slim-line);
    border-radius: 999px;
    background: color-mix(in srgb, var(--slim-bg) 85%, transparent);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
    pointer-events: auto;
    scrollbar-width: none;
  }
  .turn-jump-chips::-webkit-scrollbar {
    display: none;
  }
  .turn-jump-chips button {
    flex: none;
    padding: 2px 9px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--slim-muted);
    font-size: 10px;
    line-height: 1.6;
    cursor: pointer;
    transition: background-color 0.12s ease, color 0.12s ease, transform 0.12s ease;
  }
  .turn-jump-chips button:hover {
    background: var(--slim-soft);
    color: var(--f7-theme-color);
    transform: translateY(-1px);
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
    .turn-jump-chips button,
    .turn-jump-chips button:hover {
      transform: none;
      transition: none;
    }
    .turn-boundary-progress::after {
      transition: none;
    }
  }
</style>
