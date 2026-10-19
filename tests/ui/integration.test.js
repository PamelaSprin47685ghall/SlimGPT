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

// ------------------------------------------------------------ free mode (logged out)

const FREE_CONV = '00000000-0000-4000-8000-000000000002';
const FREE_REPLY = '00000000-0000-4000-8000-000000000003';
const FREE_USER = '00000000-0000-4000-8000-000000000004';
const freeHello = { type: 'hello', ready: true, loggedIn: false, auth: 'anon', efforts: [] };

function freeStream(chunkSize, { conversationId = null, userMessageId = FREE_USER, parentMessageId = null, userText = 'hello, reply with a list', streamId = 's' } = {}) {
  const body = fixture('anon-conversation-source.ndjson');
  const chunks = [];
  for (let i = 0; i < body.length; i += chunkSize) chunks.push({ type: 'stream-chunk', streamId, chunk: body.slice(i, i + chunkSize) });
  return [
    { type: 'stream-start', streamId, conversationId, userMessageId, parentMessageId, resume: false, format: 'conversation-source', userText },
    ...chunks,
    { type: 'stream-end', streamId, ok: true },
  ];
}

t('free mode: hello is ready without login; calm note instead of the login warning; sending allowed', () => {
  const { state } = run(L.initialState(), [freeHello]);
  assert.equal(L.isFreeMode(state), true);
  assert.deepEqual(L.statusLine(state), { tone: 'note', text: L.FREE_MODE_NOTE });
  assert.equal(L.canSend(state).ok, true);
  assert.deepEqual(L.features(state), { branches: false, continueGeneration: false });
  const signedOut = run(L.initialState(), [{ type: 'hello', ready: false, loggedIn: false, auth: 'unknown' }]).state;
  assert.equal(L.statusLine(signedOut).tone, 'warn');
  assert.equal(L.canSend(signedOut).reason, 'bridge');
});

t('free mode: NDJSON stream builds the user + assistant turn at any chunk size, stored on device, no refresh', () => {
  for (const size of [1, 9, 128, 100000]) {
    const { state, effects } = run(L.initialState(), [freeHello, ...freeStream(size)]);
    assert.equal(state.currentId, FREE_CONV, `size ${size}`);
    const turns = L.currentTurns(state, P);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].user.id, FREE_USER);
    assert.equal(turns[0].user.blocks[0].markdown, 'hello, reply with a list');
    assert.equal(turns[0].replies[0].id, FREE_REPLY);
    assert.equal(turns[0].replies[0].status, 'done');
    assert.ok(turns[0].replies[0].blocks[0].markdown.endsWith('hello()\n```'));
    assert.equal(state.streamError, null);
    assert.ok(!effects.some((effect) => effect.message === 'refresh'), 'free mode never asks for server history');
    assert.ok(effects.some((effect) => effect.type === 'save' && effect.key === 'localConversations'));
    const item = state.list.find((entry) => entry.id === FREE_CONV);
    assert.equal(item.device, true);
    assert.equal(item.title, 'hello, reply with a list');
    assert.deepEqual(L.visibleList(state).map((entry) => entry.id), [FREE_CONV]);
  }
});

t('free mode: device records persist, survive a reload and stay out of the server index', () => {
  const { state } = run(L.initialState(), [freeHello, ...freeStream(64)]);
  const stored = L.persistable(state, 'localConversations', P);
  assert.equal(stored.length, 1);
  assert.deepEqual(L.persistable(state, 'conversationIndex'), []);
  const raw = JSON.parse(JSON.stringify({ localConversations: stored }));

  let reloaded = L.hydrate(L.initialState(), raw, P);
  reloaded = run(reloaded, [freeHello, { type: 'location', url: `https://chatgpt.com/uc/${FREE_CONV}`, conversationId: FREE_CONV }]);
  assert.ok(!reloaded.effects.some((effect) => effect.message === 'refresh'));
  const turns = L.currentTurns(reloaded.state, P);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user.blocks[0].markdown, 'hello, reply with a list');
  assert.equal(L.currentTitle(reloaded.state), 'hello, reply with a list');
  assert.equal(L.statusLine(reloaded.state).tone, 'note');

  // Signed-in mode never lists device-only conversations.
  const signedIn = run(L.hydrate(L.initialState(), raw, P), [{ type: 'hello', ready: true, loggedIn: true, auth: 'user' }]).state;
  assert.deepEqual(L.visibleList(signedIn), []);
});

t('free mode: a follow-up in a stored conversation extends it; a broken revision chain keeps the good text', () => {
  const first = run(L.initialState(), [freeHello, ...freeStream(64)]).state;
  const follow = [
    { type: 'stream-start', streamId: 's2', conversationId: FREE_CONV, userMessageId: '00000000-0000-4000-8000-000000000010', parentMessageId: FREE_REPLY, resume: false, format: 'conversation-source', userText: 'more' },
    { type: 'stream-chunk', streamId: 's2', chunk: `${JSON.stringify({ version: 1, type: 'content', messageId: '00000000-0000-4000-8000-000000000011', revision: 1, mode: 'replace', markdown: 'Part' })}\n` },
    { type: 'stream-chunk', streamId: 's2', chunk: `${JSON.stringify({ version: 1, type: 'content', messageId: '00000000-0000-4000-8000-000000000011', revision: 3, mode: 'append', baseRevision: 2, markdown: ' guessed' })}\n` },
    { type: 'stream-end', streamId: 's2', ok: true },
  ];
  const { state, effects } = run(first, follow);
  const turns = L.currentTurns(state, P);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].user.blocks[0].markdown, 'more');
  assert.equal(turns[1].replies[0].blocks[0].markdown, 'Part');
  assert.equal(turns[1].replies[0].status, 'interrupted');
  assert.equal(L.statusLine(state).tone, 'warn');
  assert.ok(!effects.some((effect) => effect.message === 'refresh'));
  assert.equal(L.reduceAction(state, { type: 'continue', messageId: 'x' }, P).effects.length, 0, 'no Continue in free mode');
  assert.equal(L.reduceAction(state, { type: 'retry-sync' }, P).effects.length, 0);
});
