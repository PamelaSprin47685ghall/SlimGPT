// Live bug regression (bda5542): phantom branches on fresh replies and after
// regenerate, built from realistic v1 SSE streams + canonical history, run
// through the real UI reducer and protocol core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';
import * as L from '../../src/ui/state/logic.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8');
const fx = JSON.parse(fixture('regression-phantom-branches.json'));
const { ids } = fx;

function run(state, messages) {
  for (const message of messages) state = L.reducePage(state, message, P).state;
  return state;
}

function streamMessages(streamId, spec, conversationId, size) {
  const sse = fixture(spec.file);
  const out = [{ type: 'stream-start', streamId, conversationId, userMessageId: spec.userMessageId, parentMessageId: spec.parentMessageId, resume: false }];
  for (let i = 0; i < sse.length; i += size) out.push({ type: 'stream-chunk', streamId, chunk: sse.slice(i, i + size) });
  out.push({ type: 'stream-end', streamId, ok: true });
  return out;
}

const shape = (turns) => turns.map((turn) => ({
  user: turn.user?.id ?? null, replies: turn.replies.map((reply) => reply.id), userCount: turn.userBranch.count, replyCount: turn.replyBranch.count,
}));
const canonicalMessage = (body) => ({ type: 'conversation', conversationId: fx.conversationId, body: JSON.stringify(body), page: 1, pages: 1 });

for (const size of [1, 13, 4096]) {
  test(`fresh first reply with web search: no phantom branch before or after canonical refresh (chunk ${size})`, () => {
    let state = run(L.initialState(), [{ type: 'hello', ready: true, loggedIn: true }, ...streamMessages('s1', fx.streams.first, null, size)]);
    assert.equal(state.currentId, fx.conversationId);
    assert.equal(state.streamError, null);
    const expected = [{ user: ids.u1, replies: [ids.t1, ids.c1, ids.r1, ids.a1], userCount: 1, replyCount: 1 }];
    assert.deepEqual(shape(L.currentTurns(state, P)), expected, 'live only');
    state = run(state, [canonicalMessage(fx.canonicalAfterFirst)]);
    assert.deepEqual(shape(L.currentTurns(state, P)), expected, 'after canonical');
    const conv = L.currentConversation(state);
    for (const id of [ids.mec, ids.p1]) assert.equal(conv.nodes.has(id), false, `live-only node ${id} dropped`);
  });

  test(`regenerate shows 2/2 (not 4/4) and both branches have replies (chunk ${size})`, () => {
    let state = run(L.initialState(), [
      { type: 'hello', ready: true, loggedIn: true },
      ...streamMessages('s1', fx.streams.first, null, size),
      canonicalMessage(fx.canonicalAfterFirst),
      ...streamMessages('s2', fx.streams.regenerate, fx.conversationId, size),
    ]);
    const live = shape(L.currentTurns(state, P));
    assert.deepEqual(live, [{ user: ids.u1, replies: [ids.t2, ids.a2], userCount: 1, replyCount: 2 }], 'live regenerate');
    for (const body of [null, fx.canonicalAfterRegenerate]) {
      if (body) state = run(state, [canonicalMessage(body)]);
      assert.deepEqual(shape(L.currentTurns(state, P)), live, body ? 'after canonical' : 'before canonical');
      const back = L.reduceAction(state, { type: 'switch-branch', nodeId: ids.t2, delta: -1 }, P).state;
      const older = shape(L.currentTurns(back, P));
      assert.deepEqual(older, [{ user: ids.u1, replies: [ids.t1, ids.c1, ids.r1, ids.a1], userCount: 1, replyCount: 2 }], 'older branch is not empty');
      const forward = L.reduceAction(back, { type: 'switch-branch', nodeId: ids.t1, delta: 1 }, P).state;
      assert.deepEqual(shape(L.currentTurns(forward, P)), live);
    }
  });
}

test('a hidden side leaf arriving after the answer never steals the current path', () => {
  let conv = P.parseConversation(fx.canonicalAfterFirst);
  conv = P.applyLiveMessage(conv, { id: 'late-hidden', author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, status: 'finished_successfully', metadata: { parent_id: ids.u1, is_visually_hidden_from_conversation: true } });
  assert.equal(conv.currentNodeId, ids.a1);
  assert.equal(P.selectTurns(conv)[0].replyBranch.count, 1);
});

for (const ok of [true, false]) {
  test(`Stop mid-stream (stream-end ok=${ok}, EOF inside an event) is a quiet interruption, not a parse error`, () => {
    const sse = fixture(fx.streams.first.file);
    const cut = sse.indexOf('"1.95 "') + 3; // inside the second answer delta
    let state = run(L.initialState(), [
      { type: 'hello', ready: true, loggedIn: true },
      { type: 'stream-start', streamId: 's', conversationId: null, userMessageId: ids.u1, parentMessageId: 'client-created-root', resume: false },
      { type: 'stream-chunk', streamId: 's', chunk: sse.slice(0, cut) },
    ]);
    const result = L.reducePage(state, { type: 'stream-end', streamId: 's', ok }, P);
    state = result.state;
    assert.equal(state.streamError, null);
    assert.equal(L.statusLine(state), null, 'no orange warning');
    assert.ok(result.effects.some((effect) => effect.message === 'refresh' && effect.fields.conversationId === fx.conversationId), 'quiet refresh');
    const answer = L.currentConversation(state).nodes.get(ids.a1).message;
    assert.equal(answer.status, 'interrupted');
    assert.equal(L.isRunning(state), false);
  });
}

test('a real parse error still warns, and a completed canonical refresh clears the warning', () => {
  let state = run(L.initialState(), [
    { type: 'hello', ready: true, loggedIn: true },
    { type: 'location', conversationId: fx.conversationId, url: 'x' },
    canonicalMessage(fx.canonicalAfterFirst),
    { type: 'stream-start', streamId: 's', conversationId: fx.conversationId, userMessageId: null, parentMessageId: ids.u1, resume: false },
    { type: 'stream-chunk', streamId: 's', chunk: 'data: {broken\n\n' },
  ]);
  assert.equal(L.statusLine(state)?.tone, 'warn');
  state = run(state, [{ type: 'stream-end', streamId: 's', ok: true }, canonicalMessage(fx.canonicalAfterFirst)]);
  assert.equal(L.statusLine(state), null);
});
