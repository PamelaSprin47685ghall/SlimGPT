import test from 'node:test';
import assert from 'node:assert/strict';

// Reading converge5 pure-logic contracts. These helpers mirror the component
// implementations (ConversationTurnStage.svelte turnKeyFor / restore-target /
// chip cycler / arrow denylist, MessageOverview.svelte findCodeHitLine,
// HomePage.svelte resolveRestoredTurnIndex) so the contracts stay pinned while
// the Svelte templates own the DOM wiring.

// --- Rank1: per-turn scroll offset map key ---
function turnKeyFor(turns, conversationKey, index) {
  const turn = turns[index];
  const id = turn?.id || turn?.user?.observationKey || turn?.user?.itemId || turn?.user?.nodeId || turn?.user?.id;
  return `${conversationKey}::${id ?? 'idx-' + index}`;
}

// --- Rank1: restore-target decision (saved offset wins unless edge === 'end') ---
function resolveScrollTarget({ savedOffset, edge }) {
  return (savedOffset != null && edge !== 'end') ? savedOffset : edge;
}

// --- Rank6: chip cycler ---
function collectKindIndices(replies, predicate) {
  const out = [];
  replies.forEach((message, index) => {
    if (predicate(message)) out.push(index);
  });
  return out;
}

function chipLabel(kind, total, cursor) {
  if (total <= 1) return kind;
  return `${kind} ${Math.min(cursor, total - 1) + 1}/${total}`;
}

function nextCycle(cursor, total) {
  return (cursor + 1) % total;
}

// --- Rank2: arrow denylist predicate (DOM-free mirror) ---
const ARROW_FLIP_DENY_SELECTOR = 'button, input, textarea, select, a[href], [contenteditable], [role="textbox"], [role="button"], pre, .table-wrap, .math-block, .tool-toml-pre, .tool-payload-block, .code-block, .code-shell';

function isArrowTurnFlipDenied(target, { isBody = false, isElement = true, scroller = null } = {}) {
  if (!target || isBody) return false;
  if (!isElement) return false;
  if (target.closest?.('.composer-shell')) return true;
  if (target.closest?.('.conversation-sidebar, .message-overview, .desktop-chat-header, .mobile-navbar')) return true;
  if (target.closest?.(ARROW_FLIP_DENY_SELECTOR)) return true;
  if (target.closest?.('.conversation-turn-stage, .single-message-scroller')) return false;
  if (target === scroller) return false;
  return true;
}

function fakeTarget({ inComposer = false, inChrome = false, denyHit = false, inStage = false } = {}) {
  return {
    closest(sel) {
      if (sel === '.composer-shell') return inComposer ? {} : null;
      if (sel.includes('.conversation-sidebar')) return inChrome ? {} : null;
      if (sel === ARROW_FLIP_DENY_SELECTOR) return denyHit ? {} : null;
      if (sel.includes('.conversation-turn-stage')) return inStage ? {} : null;
      return null;
    },
  };
}

// --- Rank9: shift-step math ---
function shiftStepTarget(activeIndex, turnCount, direction, shiftKey) {
  const stride = shiftKey ? 5 : 1;
  const next = Math.max(0, Math.min(turnCount - 1, activeIndex + direction * stride));
  return next === activeIndex ? null : next;
}

// --- Rank11: code-aware overview hit line ---
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

// --- Rank1 (HomePage half): per-conversation turn index restore ---
function resolveRestoredTurnIndex({ key, count, memory, seen, notices }) {
  if (!count) return 0;
  const savedIndex = memory.has(key) ? memory.get(key) : null;
  const seenCount = seen.get(key);
  if (savedIndex == null) {
    seen.set(key, count);
    return count - 1;
  }
  const clamped = Math.max(0, Math.min(count - 1, savedIndex));
  if (seenCount != null && count > seenCount) {
    seen.set(key, count);
    notices.push('离开期间收到新内容，已定位到最新一轮');
    return count - 1;
  }
  seen.set(key, count);
  return clamped;
}

test('turnKeyFor prefers stable turn identity and scopes by conversation', () => {
  const turns = [
    { id: 't1', user: { text: 'q1' } },
    { user: { observationKey: 'obs-9', text: 'q2' } },
    { user: { text: 'q3' } },
  ];
  assert.equal(turnKeyFor(turns, 'cA', 0), 'cA::t1');
  assert.equal(turnKeyFor(turns, 'cA', 1), 'cA::obs-9');
  assert.equal(turnKeyFor(turns, 'cA', 2), 'cA::idx-2');
  assert.equal(turnKeyFor(turns, 'cB', 0), 'cB::t1');
  assert.notEqual(turnKeyFor(turns, 'cA', 0), turnKeyFor(turns, 'cB', 0));
});

test('resolveScrollTarget restores saved offsets, honors explicit end edge', () => {
  assert.equal(resolveScrollTarget({ savedOffset: 240, edge: 'start' }), 240);
  assert.equal(resolveScrollTarget({ savedOffset: 0, edge: 'start' }), 0);
  assert.equal(resolveScrollTarget({ savedOffset: 240, edge: 'end' }), 'end');
  assert.equal(resolveScrollTarget({ savedOffset: null, edge: 'start' }), 'start');
  assert.equal(resolveScrollTarget({ savedOffset: undefined, edge: 'end' }), 'end');
});

test('chip cycler collects all kind indices and labels counts', () => {
  const replies = [
    { thought: 't1' },
    { tool: { name: 'a' } },
    { role: 'assistant', text: 'ans' },
    { tool: { name: 'b' } },
    { tool: { name: 'c' } },
  ];
  const tools = collectKindIndices(replies, (m) => m?.tool);
  assert.deepEqual(tools, [1, 3, 4]);
  assert.equal(chipLabel('工具', tools.length, 0), '工具 1/3');
  assert.equal(chipLabel('工具', tools.length, 1), '工具 2/3');
  assert.equal(chipLabel('工具', 1, 0), '工具');
  const thoughts = collectKindIndices(replies, (m) => m?.thought);
  assert.deepEqual(thoughts, [0]);
});

test('chip cycler wraps around on next', () => {
  assert.equal(nextCycle(0, 3), 1);
  assert.equal(nextCycle(1, 3), 2);
  assert.equal(nextCycle(2, 3), 0);
  assert.equal(nextCycle(0, 1), 0);
});

test('arrow denylist allows message text and body, denies interactive nests', () => {
  const scroller = {};
  assert.equal(isArrowTurnFlipDenied(null), false);
  assert.equal(isArrowTurnFlipDenied({}, { isBody: true }), false);
  assert.equal(isArrowTurnFlipDenied(fakeTarget({ inStage: true }), { scroller }), false);
  assert.equal(isArrowTurnFlipDenied(fakeTarget({ denyHit: true, inStage: true }), { scroller }), true);
  assert.equal(isArrowTurnFlipDenied(fakeTarget({ inComposer: true, inStage: true }), { scroller }), true);
  assert.equal(isArrowTurnFlipDenied(fakeTarget({ inChrome: true }), { scroller }), true);
  assert.equal(isArrowTurnFlipDenied(fakeTarget(), { scroller }), true);
});

test('shift-step math: plain ±1, shift ±5, clamped at bounds', () => {
  assert.equal(shiftStepTarget(3, 10, 1, false), 4);
  assert.equal(shiftStepTarget(3, 10, -1, false), 2);
  assert.equal(shiftStepTarget(3, 10, 1, true), 8);
  assert.equal(shiftStepTarget(3, 10, -1, true), 0);
  assert.equal(shiftStepTarget(8, 10, 1, true), 9);
  assert.equal(shiftStepTarget(9, 10, 1, true), null);
  assert.equal(shiftStepTarget(0, 10, -1, false), null);
  assert.equal(shiftStepTarget(0, 3, -1, true), null);
});

test('findCodeHitLine keeps the matching code line, ignores prose matches', () => {
  const text = '先解释一下原理\n```js\nconst foo = 1;\nconst barTarget = 2;\n```\n结论是 barTarget 很好';
  assert.equal(findCodeHitLine(text, 'barTarget'), 'const barTarget = 2;');
  assert.equal(findCodeHitLine(text, '原理'), '');
  assert.equal(findCodeHitLine(text, ''), '');
  assert.equal(findCodeHitLine(text, '  '), '');
  assert.equal(findCodeHitLine('no code here', 'code'), '');
});

test('findCodeHitLine handles unclosed fences and returns the first hit', () => {
  const text = '```python\nfirst_hit = True\nsecond_hit = False';
  assert.equal(findCodeHitLine(text, 'hit'), 'first_hit = True');
});

test('resolveRestoredTurnIndex restores saved position without new activity', () => {
  const memory = new Map([['cA', 2]]);
  const seen = new Map([['cA', 5]]);
  const notices = [];
  assert.equal(resolveRestoredTurnIndex({ key: 'cA', count: 5, memory, seen, notices }), 2);
  assert.deepEqual(notices, []);
  assert.equal(seen.get('cA'), 5);
});

test('resolveRestoredTurnIndex jumps to latest with notice on new activity', () => {
  const memory = new Map([['cA', 2]]);
  const seen = new Map([['cA', 5]]);
  const notices = [];
  assert.equal(resolveRestoredTurnIndex({ key: 'cA', count: 7, memory, seen, notices }), 6);
  assert.equal(notices.length, 1);
});

test('resolveRestoredTurnIndex defaults to latest and clamps out-of-range saves', () => {
  const notices = [];
  assert.equal(
    resolveRestoredTurnIndex({ key: 'fresh', count: 4, memory: new Map(), seen: new Map(), notices }),
    3
  );
  const memory = new Map([['cA', 40]]);
  const seen = new Map([['cA', 4]]);
  assert.equal(resolveRestoredTurnIndex({ key: 'cA', count: 4, memory, seen, notices }), 3);
  assert.equal(resolveRestoredTurnIndex({ key: 'cA', count: 0, memory, seen, notices }), 0);
});
// --- Tail-follow (round-5 fix): live at-bottom authority + same-turn anti-yank ---
// Mirrors ConversationTurnStage.svelte shouldFollowOnGrowth /
// resolveSameTurnTarget so the smoke tail pin stays pinned while growth
// alone can never strand a tail reader.
function shouldFollowOnGrowth(pinned, liveAtBottom) {
  return Boolean(pinned || liveAtBottom);
}

function resolveSameTurnTarget({ sameTurn, followingTail, savedOffset, edge }) {
  if (sameTurn && followingTail) return 'end';
  return savedOffset != null && edge !== 'end' ? savedOffset : edge;
}

test('tail follow: cached unpin must not veto growth while at the bottom', () => {
  assert.equal(shouldFollowOnGrowth(false, true), true);
  assert.equal(shouldFollowOnGrowth(true, false), true);
  assert.equal(shouldFollowOnGrowth(true, true), true);
  assert.equal(shouldFollowOnGrowth(false, false), false);
});

test('same-turn re-settle: tail reader holds the live end, others honor memory', () => {
  // Tail setup then stream growth: a remembered stale offset must not yank.
  assert.equal(resolveSameTurnTarget({ sameTurn: true, followingTail: true, savedOffset: 120, edge: 'start' }), 'end');
  assert.equal(resolveSameTurnTarget({ sameTurn: true, followingTail: true, savedOffset: null, edge: 'start' }), 'end');
  // Detached / mid-turn reader on the same turn: memory still wins.
  assert.equal(resolveSameTurnTarget({ sameTurn: true, followingTail: false, savedOffset: 120, edge: 'start' }), 120);
  assert.equal(resolveSameTurnTarget({ sameTurn: true, followingTail: false, savedOffset: null, edge: 'start' }), 'start');
  assert.equal(resolveSameTurnTarget({ sameTurn: true, followingTail: false, savedOffset: 120, edge: 'end' }), 'end');
  // Genuine turn switch while at the old tail: new turn honors memory/edge.
  assert.equal(resolveSameTurnTarget({ sameTurn: false, followingTail: true, savedOffset: 120, edge: 'start' }), 120);
  assert.equal(resolveSameTurnTarget({ sameTurn: false, followingTail: true, savedOffset: null, edge: 'end' }), 'end');
});
// --- Anti-yank (round-5 fix): same-turn growth never re-settles ---
// Mirrors the ConversationTurnStage.svelte turn-effect growth guard: a
// same-turn re-run (streaming content updating the turns read) returns
// without settle — detached readers hold still, tail readers are owned by
// the RO live-follow path. Only genuine switches / conversation changes
// reach the settle + memory path.
function turnEffectAction({ sameTurn, conversationChanged }) {
  if (sameTurn && !conversationChanged) return 'ignore';
  return 'settle';
}

test('same-turn growth never re-settles: RO owns follow, effect stands down', () => {
  // Detached reader mid-growth: effect must not restore memory or edges.
  assert.equal(turnEffectAction({ sameTurn: true, conversationChanged: false }), 'ignore');
  // Tail reader mid-growth: same — RO live-follow owns the frame, not the effect.
  assert.equal(turnEffectAction({ sameTurn: true, conversationChanged: false }), 'ignore');
  // Genuine turn flip restores remembered offset via the settle path.
  assert.equal(turnEffectAction({ sameTurn: false, conversationChanged: false }), 'settle');
  // Conversation change always settles from the start edge.
  assert.equal(turnEffectAction({ sameTurn: false, conversationChanged: true }), 'settle');
  assert.equal(turnEffectAction({ sameTurn: true, conversationChanged: true }), 'settle');
});
