// Live re-test (Incognito): after reload, /uc/<id> is often redirected to /
// by the server. Device conversations must open in place from storage, stay
// read-only (with a calm note) when the official page cannot continue them,
// and never be dropped or wiped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';
import * as L from '../../src/ui/state/logic.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8');
const CONV = '00000000-0000-4000-8000-000000000002';
const REPLY = '00000000-0000-4000-8000-000000000003';
const USER = '00000000-0000-4000-8000-000000000004';
const anon = { type: 'hello', ready: true, loggedIn: false, auth: 'anon', efforts: [] };
const at = (id) => ({ type: 'location', url: id ? `https://chatgpt.com/uc/${id}` : 'https://chatgpt.com/', conversationId: id });

function run(state, messages) {
  const effects = [];
  for (const message of messages) {
    const result = L.reducePage(state, message, P);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}
function stored() {
  const body = fixture('anon-conversation-source.ndjson');
  const first = run(L.initialState(), [anon, at(null),
    { type: 'stream-start', streamId: 's', conversationId: null, userMessageId: USER, parentMessageId: null, resume: false, format: 'conversation-source', userText: 'hello' },
    { type: 'stream-chunk', streamId: 's', chunk: body }, at(CONV), { type: 'stream-end', streamId: 's', ok: true }]).state;
  assert.equal(first.currentId, CONV);
  assert.equal(L.canSend(first).ok, true, 'the conversation the official page is on can be continued');
  return JSON.parse(JSON.stringify({ localConversations: L.persistable(first, 'localConversations', P) }));
}

test('reload redirected to /: the 本机 conversation opens in place (no navigation) and is read-only with a note', () => {
  const raw = stored();
  let { state } = run(L.hydrate(L.initialState(), raw, P), [anon, at(null)]);
  assert.equal(state.currentId, null);
  assert.deepEqual(L.visibleList(state).map((item) => [item.id, item.device]), [[CONV, true]]);
  const opened = L.reduceAction(state, { type: 'open', conversationId: CONV }, P);
  assert.deepEqual(opened.effects, [], 'no /uc navigation');
  state = opened.state;
  assert.equal(state.currentId, CONV);
  const turns = L.currentTurns(state, P);
  assert.deepEqual(turns.map((turn) => [turn.user.id, turn.replies.map((reply) => reply.id)]), [[USER, [REPLY]]]);
  const check = L.canSend(state);
  assert.deepEqual(check, { ok: false, reason: 'device-readonly' });
  assert.equal(L.blockedText(check.reason), '该本机对话已无法继续，可新建对话');
  // A late location from the official page does not take the view away.
  state = run(state, [at(null)]).state;
  assert.equal(state.currentId, CONV);
  assert.deepEqual(L.persistable(state, 'localConversations', P), raw.localConversations, 'record intact');
  // New chat: the official page is already fresh on /, nothing to navigate.
  const fresh = L.reduceAction(state, { type: 'open', conversationId: null }, P);
  assert.deepEqual(fresh.effects, []);
  assert.equal(L.canSend(fresh.state).ok, true);
});

test('reload that keeps /uc/<id>: the conversation is continued through the official page', () => {
  const raw = stored();
  let { state } = run(L.hydrate(L.initialState(), raw, P), [anon, at(CONV)]);
  assert.equal(state.currentId, CONV);
  assert.equal(L.canSend(state).ok, true);
  const next = '00000000-0000-4000-8000-000000000011';
  ({ state } = run(state, [
    { type: 'stream-start', streamId: 's2', conversationId: CONV, userMessageId: '00000000-0000-4000-8000-000000000010', parentMessageId: REPLY, resume: false, format: 'conversation-source', userText: 'more' },
    { type: 'stream-chunk', streamId: 's2', chunk: `${JSON.stringify({ version: 1, type: 'content', messageId: next, revision: 1, mode: 'replace', markdown: 'More.' })}\n${JSON.stringify({ version: 1, type: 'end' })}\n` },
    { type: 'stream-end', streamId: 's2', ok: true }]));
  assert.equal(L.currentTurns(state, P).length, 2);
  // The official page is redirected away later: the view stays, read-only; nothing is lost.
  ({ state } = run(state, [at(null)]));
  assert.equal(state.currentId, CONV);
  assert.equal(L.canSend(state).reason, 'device-readonly');
  const records = L.persistable(state, 'localConversations', P);
  assert.equal(records.length, 1);
  assert.equal(records[0].messages.length, 4);
  // New chat from here asks the official page for a fresh one; sending waits for it.
  const fresh = L.reduceAction({ ...state, officialId: CONV }, { type: 'open', conversationId: null }, P);
  assert.deepEqual(fresh.effects.map((e) => [e.message, e.fields]), [['open', { conversationId: null }]]);
  assert.equal(L.canSend(fresh.state).reason, 'opening');
  assert.equal(L.canSend(run(fresh.state, [at(null)]).state).ok, true);
});
