import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findConversationPayload, findMessageEvents, ingestConversationPayload, captureMessageContext, upsertLiveMessage,
  ingestConversationMessage, buildConversationRecordTimeline, hydrateConversationObservations,
} from '../core.js';
import { compactObservationLedger } from '../src/lib/storage.js';

const msg = (id, role = 'assistant', extra = {}) => ({ id, author: { role }, content: { content_type: 'text', parts: [id] }, ...extra });
const node = (id, message, parent = null) => ({ id, message, parent, children: [] });
const tree = (...nodes) => ({ id: 'c', current_node: nodes.at(-1)?.id, mapping: Object.fromEntries(nodes.map((n) => [n.id, n])) });
const flat = (messages) => findConversationPayload({ id: 'c', current_node: messages.at(-1)?.id, messages, page_info: { has_previous_page: false } });
const timeline = (payload) => buildConversationRecordTimeline(ingestConversationPayload(null, payload));
const replies = (result) => result.turns.map((turn) => turn.replies.map((m) => m.id));

test('a child with a known exchange identifies the preceding connected output chain, without using array adjacency', () => {
  const result = timeline(flat([
    msg('u', 'user', { metadata: { turn_exchange_id: 'exchange' } }),
    msg('reasoning'),
    msg('call', 'assistant', { parent_id: 'reasoning', recipient: 'web.run', call_id: 'call-id' }),
    msg('result', 'tool', { parent_id: 'call', tool_call_id: 'call-id' }),
    msg('final', 'assistant', { parent_id: 'result', metadata: { turn_exchange_id: 'exchange' } }),
  ]));
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(replies(result), [['reasoning', 'call', 'result', 'final']]);
});

test('the same response can acquire its user anchor after the canonical pass, not only before it', () => {
  let record = ingestConversationPayload(null, flat([
    msg('u', 'user', { metadata: { turn_exchange_id: 'exchange' } }),
    msg('canonical-result', 'tool', { response_id: 'response' }),
  ]));
  record = ingestConversationMessage(record, msg('live-final', 'assistant', { response_id: 'response', metadata: { turn_exchange_id: 'exchange' } }), { textMode: 'snapshot' });
  const result = buildConversationRecordTimeline(record);
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(new Set(result.turns[0].replies.map((m) => m.id)), new Set(['canonical-result', 'live-final']));
});

test('node and message ids both identify a canonical user; explicit node ownership is not missing ownership', () => {
  const result = timeline(tree(
    node('node-user', msg('message-user', 'user')),
    node('node-answer', msg('message-answer', 'assistant', { turn_user_message_id: 'node-user' }), 'node-user'),
  ));
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(replies(result), [['message-answer']]);
});

test('a different request id does not contradict a proven parent when the identifier namespaces differ', () => {
  const result = timeline(tree(
    node('u', msg('u', 'user', { metadata: { turn_exchange_id: 'exchange' } })),
    node('tool', msg('tool', 'tool', { metadata: { request_id: 'worker-request' } }), 'u'),
  ));
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(replies(result), [['tool']]);
});

test('a shared request alias cannot obscure an explicit matching turn exchange', () => {
  const result = timeline(flat([
    msg('u1', 'user', { metadata: { turn_exchange_id: 'one', request_id: 'shared-request' } }),
    msg('u2', 'user', { metadata: { turn_exchange_id: 'two', request_id: 'shared-request' } }),
    msg('a', 'assistant', { metadata: { turn_exchange_id: 'two', request_id: 'shared-request' } }),
  ]));
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(replies(result), [[], ['a']]);
});

test('identical strings in exchange and request namespaces are not the same identity', () => {
  const result = timeline(flat([
    msg('u1', 'user', { metadata: { turn_exchange_id: 'same-spelling' } }),
    msg('u2', 'user', { metadata: { request_id: 'same-spelling' } }),
    msg('a', 'assistant', { metadata: { turn_exchange_id: 'same-spelling' } }),
  ]));
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(replies(result), [['a'], []]);
});

test('proof propagation cannot carry ownership backwards across a visible user boundary', () => {
  const result = timeline(tree(
    node('u1', msg('u1', 'user')),
    node('a1', msg('a1'), 'u1'),
    node('u2', msg('u2', 'user'), 'a1'),
    node('a2', msg('a2'), 'u2'),
  ));
  assert.deepEqual(replies(result), [['a1'], ['a2']]);
  assert.equal(result.unresolved.length, 0);
});

test('a new explicit exchange still overrides a misleading parent in an older turn', () => {
  const result = timeline(flat([
    msg('u1', 'user', { metadata: { turn_exchange_id: 'one' } }),
    msg('old', 'assistant', { parent_id: 'u1' }),
    msg('u2', 'user', { metadata: { turn_exchange_id: 'two' } }),
    msg('new', 'assistant', { parent_id: 'old', metadata: { turn_exchange_id: 'two' } }),
  ]));
  assert.deepEqual(replies(result), [['old'], ['new']]);
});

test('an old explicit exchange cannot be assigned using a merely adjacent newer user', () => {
  const result = timeline(flat([
    msg('u', 'user', { metadata: { turn_exchange_id: 'new' } }),
    msg('unavailable-owner', 'assistant', { metadata: { turn_exchange_id: 'old' } }),
  ]));
  assert.deepEqual(replies(result), [[]]);
  assert.equal(result.unresolved.flatMap((turn) => turn.replies).length, 1);
});

test('request parent identifies the continuation context, never the user who asked the current question', () => {
  let record = ingestConversationPayload(null, tree(node('u1', msg('u1', 'user')), node('a1', msg('a1'), 'u1')));
  record = ingestConversationMessage(record, msg('new-output'), { turnParentMessageId: 'a1', textMode: 'snapshot' });
  const result = buildConversationRecordTimeline(record);
  assert.deepEqual(replies(result), [['a1']]);
  assert.equal(result.unresolved.flatMap((turn) => turn.replies).length, 1);
});

test('a canonical output chain can be recovered after the observed anchor is restored from storage', () => {
  let record = ingestConversationPayload(null, flat([msg('u', 'user'), msg('first'), msg('second', 'assistant', { parent_id: 'first' })]));
  const observed = ingestConversationMessage(null, msg('last', 'assistant', { parent_id: 'second', turn_user_message_id: 'u' }), { textMode: 'snapshot' });
  const [cached] = compactObservationLedger([{ id: 'c', observations: observed.observations }]);
  record = hydrateConversationObservations(record, cached.observations);
  const result = buildConversationRecordTimeline(record);
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(replies(result), [['first', 'second', 'last']]);
});

test('a message envelope carries its explicit parent relationship into discovery and ingestion', () => {
  const [event] = findMessageEvents({ conversation_id: 'c', parent_id: 'u', message: msg('a') });
  let record = ingestConversationPayload(null, tree(node('u', msg('u', 'user'))));
  record = ingestConversationMessage(record, event.message, { ...event, textMode: 'snapshot' });
  assert.deepEqual(replies(buildConversationRecordTimeline(record)), [['a']]);
});

test('an enclosing turn exchange keeps its namespace through capture context and storage', () => {
  const [event] = findMessageEvents({ conversation_id: 'c', turn_exchange_id: 'turn', message: msg('a', 'assistant', { metadata: { request_id: 'worker' } }) });
  const context = captureMessageContext(event);
  assert.equal(context.turnExchangeId, 'turn');
  assert.equal(context.turnRequestId, 'worker');
  const rows = upsertLiveMessage([], event.message, { ...context, textMode: 'snapshot' });
  assert.equal(rows[0].turnExchangeId, 'turn');
  const [stored] = compactObservationLedger([{ id: 'c', observations: rows }]);
  assert.equal(stored.observations[0].turnExchangeId, 'turn');
});

test('an independent worker request id cannot discard the originating submission user', () => {
  const [event] = findMessageEvents({ message: msg('worker-output', 'tool', { metadata: { request_id: 'worker-request' } }) });
  const context = captureMessageContext(event, { turnExchangeId: 'turn', turnId: 'turn', turnAliases: ['turn'], turnUserMessageId: 'u' });
  assert.equal(context.turnUserMessageId, 'u');
  assert.equal(context.turnExchangeId, 'turn');
});

test('a snapshot enriched with worker identity remains one item after an enclosing turn identity', () => {
  let rows = upsertLiveMessage([], msg('a'), { textMode: 'snapshot', turnExchangeId: 'turn', turnAliases: ['turn'] });
  rows = upsertLiveMessage(rows, msg('a', 'assistant', { metadata: { request_id: 'worker-request' } }), {
    textMode: 'snapshot', turnExchangeId: 'turn', turnAliases: ['turn'],
  });
  assert.equal(rows.length, 1);
});

test('the resolved association carries inspectable protocol edges rather than a positional guess', () => {
  const result = timeline(flat([
    msg('u', 'user', { metadata: { turn_exchange_id: 'turn' } }), msg('first'),
    msg('last', 'assistant', { parent_id: 'first', metadata: { turn_exchange_id: 'turn' } }),
  ]));
  const row = result.turns[0].replies.find((r) => r.id === 'first');
  assert.equal(row.ownership.userMessageId, 'u');
  assert.ok(row.ownership.evidence.some((edge) => edge.kind === 'child' && edge.reference === 'last'));
  assert.ok(row.ownership.evidence.some((edge) => edge.kind === 'exchange' && edge.reference === 'turn'));
});

test('contradictory child anchors cannot make an unanchored ancestor depend on arrival order', () => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const result = timeline(flat([
      msg('u1', 'user'), msg('u2', 'user'), msg('shared'),
      ...order.map((id) => msg(id, 'assistant', { parent_id: 'shared', turn_user_message_id: id === 'a' ? 'u1' : 'u2' })),
    ]));
    assert.deepEqual(replies(result), [['a'], ['b']]);
    const failed = result.unresolved.flatMap((g) => g.replies).find((r) => r.id === 'shared');
    assert.equal(failed.ownershipFailure.reason, 'conflicting-evidence');
  }
});

test('a call identity resolves a result to its actual response despite a stale historical parent', () => {
  const result = timeline(flat([
    msg('u1', 'user'), msg('old', 'assistant', { parent_id: 'u1' }), msg('u2', 'user'),
    msg('result', 'tool', { parent_id: 'old', tool_call_id: 'new-call' }),
    msg('call', 'assistant', { recipient: 'web.run', call_id: 'new-call', turn_user_message_id: 'u2' }),
  ]));
  assert.deepEqual(replies(result), [['old'], ['call', 'result']]);
  assert.equal(result.unresolved.length, 0);
});

test('forward and backward relation solving is independent of output arrival order', () => {
  const user = msg('u', 'user', { metadata: { turn_exchange_id: 'turn' } });
  const output = [msg('first'), msg('call', 'assistant', { parent_id: 'first', recipient: 'web', call_id: 'k' }),
    msg('result', 'tool', { tool_call_id: 'k', parent_id: 'call' }),
    msg('last', 'assistant', { parent_id: 'result', metadata: { turn_exchange_id: 'turn' } })];
  const permutations = (items) => items.length ? items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map((tail) => [item, ...tail])) : [[]];
  for (const order of permutations(output)) {
    const result = timeline(flat([user, ...order]));
    assert.equal(result.unresolved.length, 0);
    assert.deepEqual(replies(result), [['first', 'call', 'result', 'last']]);
    assert.ok(result.turns[0].replies.every((row) => row.ownership.userMessageId === 'u'));
  }
});

test('message-less canonical routing nodes remain part of the parent proof without becoming visible bubbles', () => {
  const result = timeline(tree(
    node('u', msg('u', 'user')),
    node('routing-node', null, 'u'),
    node('a', msg('a'), 'routing-node'),
  ));
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(replies(result), [['a']]);
  assert.equal(result.turns[0].replies[0].ownership.userMessageId, 'u');
});

test('stable item references link distinct protocol phases without merging their content', () => {
  let record = ingestConversationPayload(null, flat([
    msg('u', 'user'), msg('anchor', 'assistant', { item_id: 'item', parent_id: 'u', phase: 'commentary' }),
  ]));
  record = ingestConversationMessage(record, msg('final', 'assistant', { item_id: 'item', phase: 'final' }), { textMode: 'snapshot' });
  const result = buildConversationRecordTimeline(record);
  assert.equal(result.unresolved.length, 0);
  assert.deepEqual(replies(result), [['anchor', 'final']]);
});
