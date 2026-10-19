// UI logic against the REAL protocol core (workstream A). Reported as TODO
// while src/protocol is still the scaffolded stub, so the suite stays green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';
import * as L from '../../src/ui/state/logic.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8');
const implemented = (() => { try { P.createConversation('probe'); return true; } catch { return false; } })();
const t = (name, fn) => test(name, { todo: implemented ? false : 'protocol core not implemented yet (workstream A)' }, fn);

function run(state, messages) {
  const effects = [];
  for (const message of messages) {
    const result = L.reducePage(state, message, P);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

t('new chat streamed from the SSE fixture at several chunk sizes ends in one clean turn', () => {
  const sse = fixture('streams/v1-reasoning-then-answer.sse');
  for (const size of [1, 7, 64, sse.length]) {
    const chunks = [];
    for (let i = 0; i < sse.length; i += size) chunks.push({ type: 'stream-chunk', streamId: 's', chunk: sse.slice(i, i + size) });
    const { state, effects } = run(L.initialState(), [
      { type: 'hello', ready: true, loggedIn: true },
      { type: 'stream-start', streamId: 's', conversationId: null, userMessageId: 'u1', parentMessageId: null, resume: false },
      ...chunks,
      { type: 'stream-end', streamId: 's', ok: true },
    ]);
    assert.equal(state.currentId, 'c-1', `size ${size}`);
    assert.equal(L.currentTitle(state), 'Greeting');
    assert.equal(state.streamError, null);
    const turns = L.currentTurns(state, P);
    assert.deepEqual(turns.map((turn) => [turn.user?.id, turn.replies.map((reply) => reply.id)]), [['u1', ['t1', 'a1']]]);
    const answer = turns[0].replies[1];
    assert.equal(answer.blocks[0].markdown, 'aaa\n\n!');
    assert.ok(effects.some((effect) => effect.message === 'refresh' && effect.fields.conversationId === 'c-1'));
  }
});

t('canonical history then a streamed live copy of the multimodal user keeps the turn intact', () => {
  const fx = JSON.parse(fixture('regression-multimodal-user-turn.json'));
  const sse = `data: ${JSON.stringify({ message: fx.live, conversation_id: 'c-1' })}\n\ndata: [DONE]\n\n`;
  const { state } = run({ ...L.initialState(), currentId: 'c-1' }, [
    { type: 'hello', ready: true, loggedIn: true },
    { type: 'conversation', conversationId: 'c-1', body: JSON.stringify(fx.canonical), page: 1, pages: 1 },
    { type: 'stream-start', streamId: 's', conversationId: 'c-1', userMessageId: 'u1', parentMessageId: 'root', resume: false },
    { type: 'stream-chunk', streamId: 's', chunk: sse },
    { type: 'stream-end', streamId: 's', ok: true },
  ]);
  const turns = L.currentTurns(state, P);
  assert.deepEqual(turns.map((turn) => ({ user: turn.user?.id, replies: turn.replies.map((reply) => reply.id) })), fx.expect.turns);
  assert.deepEqual(turns[0].user.blocks.map((block) => block.kind), fx.expect.userBlocksKinds);
});
