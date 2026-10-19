import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/protocol/index.js';
import { assistant, mapping, turnShape, user } from './helpers.js';

const base = () => mapping('c', 'a1', [
  ['root', null, null],
  ['u1', 'root', user('u1', 'q')],
  ['a1', 'u1', assistant('a1', 'A')],
]);

test('parseConversation: mapping format, ids, title, current node, complete', () => {
  const conversation = P.parseConversation(JSON.stringify(base()));
  assert.equal(conversation.id, 'c');
  assert.equal(conversation.title, 'T');
  assert.equal(conversation.currentNodeId, 'a1');
  assert.equal(conversation.complete, true);
  assert.deepEqual(conversation.nodes.get('root'), { id: 'root', parentId: null, childIds: ['u1'], message: null });
  assert.equal(conversation.nodes.get('a1').message.parentId, 'u1');
  assert.deepEqual(Object.keys(conversation).sort(), ['complete', 'currentNodeId', 'id', 'nodes', 'title']);
});

test('parseConversation rejects non-conversations', () => {
  for (const body of ['', '{', '[]', 'null', '{"items":[]}', { messages: 'x' }, { mapping: [] }, 42, null]) {
    assert.equal(P.parseConversation(body), null, JSON.stringify(body));
  }
});

test('paged history: newest page first, older page later, reconnects across pages', () => {
  const newest = {
    conversation_id: 'c', current_node: 'a2', title: 'Paged',
    messages: [
      user('u2', 'q2', { metadata: { parent_id: 'a1' } }),
      assistant('a2', 'A2', { metadata: { parent_id: 'u2' } }),
    ],
    page_info: { has_previous_page: true, start_cursor: 'cur' },
  };
  const older = {
    conversation_id: 'c', current_node: 'a2',
    messages: [user('u1', 'q1'), assistant('a1', 'A1', { metadata: { parent_id: 'u1' } })],
    page_info: { has_previous_page: false },
  };
  const first = P.parseConversation(newest);
  assert.equal(first.complete, false);
  assert.deepEqual(turnShape(P.selectTurns(first)), [{ user: 'u2', replies: ['a2'] }]);
  const merged = P.mergeConversation(first, P.parseConversation(older));
  assert.equal(merged.complete, true);
  assert.equal(merged.title, 'Paged');
  assert.equal(merged.currentNodeId, 'a2');
  assert.deepEqual(turnShape(P.selectTurns(merged)), [{ user: 'u1', replies: ['a1'] }, { user: 'u2', replies: ['a2'] }]);
  assert.deepEqual(merged.nodes.get('a1').childIds, ['u2']);
});

test('paged page without any parent ids is chained in order, but a stated parent later wins', () => {
  const linear = P.parseConversation({ conversation_id: 'c', current_node: 'a1', messages: [user('u1', 'q'), assistant('a1', 'A')] });
  assert.deepEqual(turnShape(P.selectTurns(linear)), [{ user: 'u1', replies: ['a1'] }]);
  const full = P.parseConversation(mapping('c', 'a1', [
    ['root', null, null], ['u1', 'root', user('u1', 'q')], ['t1', 'u1', assistant('t1', 'tool step')], ['a1', 't1', assistant('a1', 'A')],
  ]));
  const merged = P.mergeConversation(linear, full);
  assert.equal(merged.nodes.get('a1').parentId, 't1');
  assert.deepEqual(merged.nodes.get('u1').childIds, ['t1']);
  // …and the inferred chain never overrides the stated one afterwards.
  const again = P.mergeConversation(merged, linear);
  assert.equal(again.nodes.get('a1').parentId, 't1');
});

test('merge never creates a cycle even with hostile pages', () => {
  const conversation = P.parseConversation(base());
  const hostile = P.parseConversation(mapping('c', 'u1', [['u1', 'a1', user('u1', 'q')], ['a1', null, assistant('a1', 'A')]]));
  const merged = P.mergeConversation(conversation, hostile);
  assert.equal(merged.nodes.get('u1').parentId, 'root');
  assert.ok(P.selectTurns(merged).length >= 1);
});

const branched = () => mapping('c', 'a2b', [
  ['root', null, null],
  ['u1', 'root', user('u1', 'q', { create_time: 1 })],
  ['a1', 'u1', assistant('a1', 'first', { create_time: 2 })],
  ['a1b', 'u1', assistant('a1b', 'regenerated', { create_time: 3 })],
  ['u2', 'a1b', user('u2', 'follow', { create_time: 4 })],
  ['u2b', 'a1b', user('u2b', 'edited follow', { create_time: 6 })],
  ['a2', 'u2', assistant('a2', 'x', { create_time: 5 })],
  ['a2b', 'u2b', assistant('a2b', 'y', { create_time: 7 })],
]);

test('branches: regenerate (reply siblings) and edited user (user siblings)', () => {
  const conversation = P.parseConversation(branched());
  const turns = P.selectTurns(conversation);
  assert.deepEqual(turnShape(turns), [{ user: 'u1', replies: ['a1b'] }, { user: 'u2b', replies: ['a2b'] }]);
  assert.deepEqual(turns[0].replyBranch, { index: 1, count: 2, siblingIds: ['a1', 'a1b'] });
  assert.deepEqual(turns[0].userBranch, { index: 0, count: 1, siblingIds: ['u1'] });
  assert.deepEqual(turns[1].userBranch, { index: 1, count: 2, siblingIds: ['u2', 'u2b'] });

  const toFirstReply = P.switchBranch(conversation, 'a1b', -1);
  assert.equal(toFirstReply, 'a1');
  assert.deepEqual(turnShape(P.selectTurns(conversation, toFirstReply)), [{ user: 'u1', replies: ['a1'] }]);

  const toOldEdit = P.switchBranch(conversation, 'u2b', -1);
  assert.equal(toOldEdit, 'a2');
  const oldTurns = P.selectTurns(conversation, toOldEdit);
  assert.deepEqual(turnShape(oldTurns), [{ user: 'u1', replies: ['a1b'] }, { user: 'u2', replies: ['a2'] }]);
  assert.equal(oldTurns[1].userBranch.index, 0);

  // Switching back to the branch that contains the current leaf returns it.
  assert.equal(P.switchBranch(conversation, 'u2', +1), 'a2b');
  // Out of range / unknown → null.
  assert.equal(P.switchBranch(conversation, 'u2b', +1), null);
  assert.equal(P.switchBranch(conversation, 'nope', 1), null);
  assert.equal(P.switchBranch(conversation, 'u1', 0.5), null);
});

test('selectTurns: hidden messages excluded, protocol order kept, preamble without user', () => {
  const conversation = P.parseConversation(mapping('c', 'a1', [
    ['root', null, null],
    ['sys', 'root', { id: 'sys', author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } }],
    ['greet', 'sys', assistant('greet', 'Hi, I am a GPT')],
    ['ctx', 'greet', { id: 'ctx', author: { role: 'user' }, content: { content_type: 'user_editable_context', user_profile: 'p' }, metadata: { is_visually_hidden_from_conversation: true } }],
    ['u1', 'ctx', user('u1', 'q')],
    ['t1', 'u1', { id: 't1', author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts: [{ summary: 's', content: 'c' }] } }],
    ['c1', 't1', { id: 'c1', author: { role: 'assistant' }, recipient: 'python', content: { content_type: 'code', text: '1' } }],
    ['r1', 'c1', { id: 'r1', author: { role: 'tool', name: 'python' }, content: { content_type: 'execution_output', text: '1' } }],
    ['a1', 'r1', assistant('a1', 'done')],
  ]));
  const turns = P.selectTurns(conversation);
  assert.deepEqual(turnShape(turns), [{ user: null, replies: ['greet'] }, { user: 'u1', replies: ['t1', 'c1', 'r1', 'a1'] }]);
  assert.equal(turns[0].userBranch.count, 0);
  assert.equal(turns[1].replyBranch.count, 1);
});

test('tool call and result pair by callId', () => {
  const conversation = P.parseConversation(mapping('c', 'r2', [
    ['u1', null, user('u1', 'q')],
    ['c1', 'u1', { id: 'c1', author: { role: 'assistant' }, recipient: 'web.run', content: { content_type: 'code', text: '{}' }, metadata: { call_id: 'k-1' } }],
    ['c2', 'c1', { id: 'c2', author: { role: 'assistant' }, recipient: 'python', content: { content_type: 'code', text: '2' }, metadata: { call_id: 'k-2' } }],
    ['r2', 'c2', { id: 'r2', author: { role: 'tool', name: 'python' }, content: { content_type: 'execution_output', text: '2' }, metadata: { call_id: 'k-2' } }],
    ['r1', 'r2', { id: 'r1', author: { role: 'tool', name: 'web.run' }, content: { content_type: 'text', parts: ['r'] }, metadata: { call_id: 'k-1' } }],
  ]));
  const blocks = P.selectTurns(conversation, 'r1')[0].replies.flatMap((reply) => reply.blocks);
  const calls = new Map(blocks.filter((block) => block.kind === 'tool_call').map((block) => [block.callId, block]));
  for (const result of blocks.filter((block) => block.kind === 'tool_result')) {
    assert.equal(calls.get(result.callId)?.tool, result.tool, result.callId);
  }
  assert.equal(calls.size, 2);
});

test('live: new turn from a stream attaches via fallbackParentId and becomes current', () => {
  let conversation = P.parseConversation(base());
  conversation = P.applyLiveMessage(conversation, user('u2', 'next', { status: null }), { fallbackParentId: 'a1' });
  conversation = P.applyLiveMessage(conversation, assistant('a2', 'Ans', { status: 'in_progress' }), { fallbackParentId: 'u2' });
  assert.equal(conversation.currentNodeId, 'a2');
  assert.deepEqual(turnShape(P.selectTurns(conversation)), [{ user: 'u1', replies: ['a1'] }, { user: 'u2', replies: ['a2'] }]);
  assert.equal(conversation.nodes.get('a2').message.source, 'live');
  assert.equal(conversation.nodes.get('a2').message.status, 'streaming');
  // Server-stated parent beats the fallback.
  const stated = P.applyLiveMessage(conversation, assistant('a3', 'x', { metadata: { parent_id: 'u1' } }), { fallbackParentId: 'u2' });
  assert.equal(stated.nodes.get('a3').parentId, 'u1');
  // A message is never its own parent.
  const self = P.applyLiveMessage(P.createConversation('c'), user('u9', 'x'), { fallbackParentId: 'u9' });
  assert.equal(self.nodes.get('u9').parentId, null);
});

test('live: regenerate during streaming switches the current leaf to the new sibling', () => {
  let conversation = P.parseConversation(base());
  conversation = P.applyLiveMessage(conversation, assistant('a1b', '', { status: 'in_progress', metadata: { parent_id: 'u1' } }));
  assert.equal(conversation.currentNodeId, 'a1b');
  const turns = P.selectTurns(conversation);
  assert.deepEqual(turnShape(turns), [{ user: 'u1', replies: ['a1b'] }]);
  assert.equal(turns[0].replyBranch.count, 2);
});

test('live: out-of-order child before parent is adopted when the parent arrives', () => {
  let conversation = P.createConversation('c');
  conversation = P.applyLiveMessage(conversation, assistant('a1', 'A', { metadata: { parent_id: 'u1' } }));
  conversation = P.applyLiveMessage(conversation, user('u1', 'q'));
  assert.deepEqual(conversation.nodes.get('u1').childIds, ['a1']);
  assert.equal(conversation.currentNodeId, 'a1');
  assert.deepEqual(turnShape(P.selectTurns(conversation)), [{ user: 'u1', replies: ['a1'] }]);
});

test('precedence: live may continue a canonical interrupted/streaming message; canonical refresh replaces live', () => {
  const canonical = P.parseConversation(mapping('c', 'a1', [
    ['u1', null, user('u1', 'q')],
    ['a1', 'u1', assistant('a1', 'half', { status: 'finished_partial_completion' })],
  ]));
  assert.equal(canonical.nodes.get('a1').message.status, 'interrupted');
  const live = P.applyLiveMessage(canonical, assistant('a1', 'half and more', { status: 'in_progress' }));
  assert.equal(live.nodes.get('a1').message.blocks[0].markdown, 'half and more');
  assert.equal(live.nodes.get('a1').parentId, 'u1', 'canonical parent kept');
  const finished = P.applyLiveMessage(live, assistant('a1', 'half and more!'));
  assert.equal(finished.nodes.get('a1').message.status, 'done');
  // Live 'done' is still replaceable by later live snapshots (it is not canonical)…
  assert.equal(P.applyLiveMessage(finished, assistant('a1', 'v3')).nodes.get('a1').message.blocks[0].markdown, 'v3');
  // …and a canonical refresh replaces live data.
  const refreshed = P.mergeConversation(finished, P.parseConversation(mapping('c', 'a1', [
    ['u1', null, user('u1', 'q')], ['a1', 'u1', assistant('a1', 'final text')],
  ])));
  assert.equal(refreshed.nodes.get('a1').message.source, 'canonical');
  assert.equal(refreshed.nodes.get('a1').message.blocks[0].markdown, 'final text');
  // Canonical done is final for live.
  assert.equal(P.applyLiveMessage(refreshed, assistant('a1', 'stale', { status: 'in_progress' })), refreshed);
});

test('merge keeps a newer live leaf that continues the canonical path', () => {
  let conversation = P.parseConversation(base());
  conversation = P.applyLiveMessage(conversation, user('u2', 'more'), { fallbackParentId: 'a1' });
  conversation = P.applyLiveMessage(conversation, assistant('a2', 'str', { status: 'in_progress' }), { fallbackParentId: 'u2' });
  const merged = P.mergeConversation(conversation, P.parseConversation(base()));
  assert.equal(merged.currentNodeId, 'a2');
  assert.deepEqual(turnShape(P.selectTurns(merged)), [{ user: 'u1', replies: ['a1'] }, { user: 'u2', replies: ['a2'] }]);
});

test('immutability: inputs are never mutated by parse/merge/apply', () => {
  const body = base();
  const snapshot = JSON.stringify(body);
  const conversation = P.parseConversation(body);
  assert.equal(JSON.stringify(body), snapshot);
  const nodesBefore = new Map(conversation.nodes);
  const nodeJson = JSON.stringify([...conversation.nodes]);
  const raw = assistant('a2', 'x', { metadata: { parent_id: 'a1' } });
  const rawJson = JSON.stringify(raw);
  const next = P.applyLiveMessage(conversation, raw);
  P.mergeConversation(next, P.parseConversation(base()));
  assert.notEqual(next, conversation);
  assert.equal(JSON.stringify(raw), rawJson);
  assert.equal(JSON.stringify([...conversation.nodes]), nodeJson);
  for (const [id, node] of nodesBefore) assert.equal(conversation.nodes.get(id), node);
  assert.equal(conversation.nodes.has('a2'), false);
});

test('createConversation shape', () => {
  const conversation = P.createConversation('new');
  assert.deepEqual({ ...conversation, nodes: [...conversation.nodes] }, { id: 'new', title: '', nodes: [], currentNodeId: null, complete: false });
  assert.deepEqual(P.selectTurns(conversation), []);
});
