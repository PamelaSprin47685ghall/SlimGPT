// Real official flows from a HAR captured on chatgpt.com (2026-10-19,
// logged-in free account), sanitized: ids remapped, tokens redacted.
// Stop → GET /backend-api/conversations/<id> (paged path view) → regenerate
// (action "variant") → GET history again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';
import * as L from '../../src/ui/state/logic.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8');
const CONV = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const ANSWER = '00000000-0000-4000-8000-000000000009';
const regenSse = fixture('streams/har-regenerate-after-stop.sse');
const afterStop = fixture('har-history-after-stop.json');
const afterRegen = fixture('har-history-after-regenerate.json');

// The stopped first stream was not captured (aborted body). Rebuild it from
// the real regenerate stream: same dialect, different message ids, cut
// inside the answer like a user Stop.
const stoppedSse = (() => {
  const first = regenSse.indexOf('\\u4e0b\\u9762');
  const cut = regenSse.indexOf('event: delta', first) + 30; // inside the following event
  return regenSse.slice(0, cut)
    .replace(/00000000-0000-4000-8000-0000000000(0[3-9]|1[0-9])/g, (id) => id.replace('-0000000000', '-9999999999'))
    // ...and earlier: the stopped reply was streamed ~40 s before the regenerate.
    .replace(/"create_time":179240099(\d)/g, (_, digit) => `"create_time":179240095${digit}`);
})();

function run(state, messages) {
  const effects = [];
  for (const message of messages) {
    const result = L.reducePage(state, message, P);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}
const stream = (id, sse, fields, ok = true, size = 97) => {
  const out = [{ type: 'stream-start', streamId: id, resume: false, ...fields }];
  for (let i = 0; i < sse.length; i += size) out.push({ type: 'stream-chunk', streamId: id, chunk: sse.slice(i, i + size) });
  out.push({ type: 'stream-end', streamId: id, ok });
  return out;
};
const history = (body) => ({ type: 'conversation', conversationId: CONV, body, page: 1, pages: 1 });
const shape = (state) => L.currentTurns(state, P).map((turn) => ({
  user: turn.user?.id ?? null, replies: turn.replies.map((reply) => reply.id), replyCount: turn.replyBranch.count,
}));

test('HAR: paged history view (plural endpoint) with hidden nodes omitted still forms the turn', () => {
  const conv = P.parseConversation(afterRegen);
  const turns = P.selectTurns(conv);
  assert.deepEqual(turns.map((turn) => [turn.user?.id, turn.replies.map((reply) => reply.id)]), [[USER, [ANSWER]]]);
  assert.equal(turns[0].replyBranch.count, 1);
});

test('HAR: Stop mid-stream → quiet interruption; regenerate → 2/2 with both branches non-empty', () => {
  const opened = run({ ...L.initialState(), currentId: CONV }, [
    { type: 'hello', ready: true, loggedIn: true },
    { type: 'location', conversationId: CONV, url: `https://chatgpt.com/c/${CONV}` },
    history(afterStop),
  ]).state;
  for (const ok of [false, true]) {
    let { state, effects } = run(opened, stream('s1', stoppedSse, { conversationId: CONV, userMessageId: null, parentMessageId: USER }, ok));
    assert.equal(state.streamError, null, 'no parse warning after Stop');
    assert.equal(L.statusLine(state), null);
    assert.ok(effects.some((effect) => effect.message === 'refresh'), 'history refreshed quietly');
    const stopped = shape(state);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].replies.length, 1);
    const partial = L.currentConversation(state).nodes.get(stopped[0].replies[0]).message;
    assert.equal(partial.status, 'interrupted');
    assert.match(partial.blocks[0].markdown, /^\s*下面/);
    // The official app re-reads the paged history right after Stop: the
    // partial reply is not in it yet, and must not vanish or be re-parented.
    state = run(state, [history(afterStop)]).state;
    assert.deepEqual(shape(state), stopped);

    state = run(state, stream('s2', regenSse, { conversationId: CONV, userMessageId: null, parentMessageId: USER })).state;
    assert.equal(state.streamError, null);
    for (const body of [null, afterRegen]) {
      if (body) state = run(state, [history(body)]).state;
      assert.deepEqual(shape(state), [{ user: USER, replies: [ANSWER], replyCount: 2 }], body ? 'after history' : 'live');
      const turn = L.currentTurns(state, P)[0];
      // The regenerated answer is the newer branch: ‹ 2/2 ›, older one first.
      assert.equal(turn.replyBranch.index, 1, body ? 'after history: 2/2' : 'live: 2/2');
      const other = L.reduceAction(state, { type: 'switch-branch', nodeId: turn.replyBranch.siblingIds[turn.replyBranch.index], delta: -1 }, P).state;
      const otherTurns = L.currentTurns(other, P);
      assert.equal(otherTurns[0].replies.length, 1, 'older branch has its (stopped) reply');
      assert.equal(otherTurns[0].replies[0].status, 'interrupted');
    }
  }
});
