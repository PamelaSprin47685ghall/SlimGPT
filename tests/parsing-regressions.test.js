import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationRecordTimeline, consumeSse, createConversationSseDecoder,
  decodeCaptureBody, findMessageEvents, ingestConversationMessage,
  ingestConversationPayload, mergeConversationPayload, mergeObservedMessage,
  upsertLiveMessage, captureMessageContext, findConversationPayload, messageProtocolIdentity,
} from '../core.js';

const message = (id, role, text, extra = {}) => ({
  id, author: { role }, content: { content_type: 'text', parts: [text] }, ...extra,
});
const graph = (messages) => ({
  id: 'regression', current_node: messages.at(-1).id,
  mapping: Object.fromEntries(messages.map((item, index) => [item.id, {
    id: item.id, parent: item.parent_id ?? messages[index - 1]?.id ?? null,
    children: messages[index + 1] ? [messages[index + 1].id] : [], message: item,
  }])),
});

test('base64 response bodies decode UTF-8 rather than binary Latin-1', () => {
  const text = '中文、かな、emoji 🧪';
  assert.equal(decodeCaptureBody({ data: Buffer.from(text).toString('base64'), base64Encoded: true }), text);
});

test('SSE accepts BOM, lone CR, CRLF and all transport split positions', () => {
  const source = '\ufeff: heartbeat\rdata: {"text":"中文"}\r\revent: delta\r\ndata: {"v":1}\r\n\r\n';
  for (let split = 0; split <= source.length; split += 1) {
    const first = consumeSse('', source.slice(0, split));
    const second = consumeSse(first.rest, source.slice(split), true);
    assert.deepEqual([...first.frames, ...second.frames].map(({ event, json }) => [event, json]), [
      ['message', { text: '中文' }], ['delta', { v: 1 }],
    ], `split ${split}`);
  }
});

test('SSE recognizes empty data fields and preserves significant event/id spaces', () => {
  const { frames } = consumeSse('', 'event: custom  \nid: abc  \ndata\n\n', true);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data, '');
  assert.equal(frames[0].event, 'custom  ');
  assert.equal(frames[0].id, 'abc  ');
});

test('delta array end insertion appends and does not overwrite the first item', () => {
  const decoder = createConversationSseDecoder();
  decoder.decode({ event: 'delta_encoding', data: '"v1"' });
  const first = decoder.decode({ event: 'delta', json: { p: '', o: 'add', v: { parts: ['one'] } } });
  const second = decoder.decode({ event: 'delta', json: { p: '/parts/-', o: 'add', v: 'two' } });
  assert.deepEqual(first.parts, ['one']);
  assert.deepEqual(second.parts, ['one', 'two']);
});

test('expanded delta fields are not overwritten by compact field inheritance', () => {
  const decoder = createConversationSseDecoder();
  decoder.decode({ event: 'delta_encoding', data: '"v1"' });
  decoder.decode({ event: 'delta', json: { channel: 0, path: '', op: 'add', value: { text: 'first' } } });
  const value = decoder.decode({ event: 'delta', json: { channel: 0, path: '/text', op: 'replace', value: 'fixed' } });
  assert.deepEqual(value, { text: 'fixed' });
});

test('a failed delta is atomic and cannot poison the next inherited path', () => {
  const decoder = createConversationSseDecoder();
  decoder.decode({ event: 'delta_encoding', data: '"v1"' });
  decoder.decode({ event: 'delta', json: { p: '', o: 'add', v: { text: 'a' } } });
  decoder.decode({ event: 'delta', json: { p: '/text', o: 'append', v: 'b' } });
  assert.throws(() => decoder.decode({ event: 'delta', json: { p: '/__proto__/x', v: 'bad' } }));
  assert.deepEqual(decoder.decode({ event: 'delta', json: { v: 'c' } }), { text: 'abc' });
});

test('snapshot corrections replace reasoning and tool arguments, including an empty replacement', () => {
  let rows = upsertLiveMessage([], message('thought', 'assistant', '', {
    content: { content_type: 'thoughts', thoughts: [{ summary: 'Draft', content: 'long wrong explanation' }] },
  }), { textMode: 'snapshot' });
  rows = upsertLiveMessage(rows, message('thought', 'assistant', '', {
    content: { content_type: 'thoughts', thoughts: [{ summary: 'Fixed', content: 'right' }] },
  }), { textMode: 'snapshot' });
  assert.equal(rows[0].thought, '> **Fixed**\n\nright');
  rows = upsertLiveMessage(rows, message('thought', 'assistant', '', {
    content: { content_type: 'thoughts', thoughts: [] },
  }), { textMode: 'snapshot' });
  assert.equal(rows[0].thought, null);

  let tools = upsertLiveMessage([], message('call', 'assistant', '', {
    tool_calls: [{ id: 'c', function: { name: 'search', arguments: '{"q":"long wrong"}' } }],
  }), { textMode: 'snapshot' });
  tools = upsertLiveMessage(tools, message('call', 'assistant', '', {
    tool_calls: [{ id: 'c', function: { name: 'search', arguments: '{"q":"ok"}' } }],
  }), { textMode: 'snapshot' });
  assert.equal(tools[0].tool.payload.function.arguments, '{"q":"ok"}');
});

test('snapshot text deletion remains deleted at both raw and rendered layers', () => {
  let rows = upsertLiveMessage([], message('a', 'assistant', 'remove me'), { textMode: 'snapshot' });
  rows = upsertLiveMessage(rows, message('a', 'assistant', ''), { textMode: 'snapshot' });
  assert.equal(rows[0].text, '');
  assert.deepEqual(rows[0]._rawMessage.content.parts, ['']);
});

test('snapshot metadata scalars and arrays are authoritative, not longest-string wins', () => {
  const merged = mergeObservedMessage(
    message('a', 'assistant', 'old', { metadata: { model_slug: 'long-model-name', citations: ['a', 'b'] } }),
    message('a', 'assistant', 'new', { metadata: { model_slug: 'short', citations: [] } }),
    { textMode: 'snapshot' },
  );
  assert.equal(merged.metadata.model_slug, 'short');
  assert.deepEqual(merged.metadata.citations, []);
});

test('canonical refresh replaces changed text instead of concatenating two answers', () => {
  const old = graph([message('u', 'user', 'question'), message('a', 'assistant', 'incorrect old answer')]);
  const next = graph([message('u', 'user', 'question'), message('a', 'assistant', 'correct answer')]);
  const merged = mergeConversationPayload(old, next);
  assert.deepEqual(merged.mapping.a.message.content.parts, ['correct answer']);
});

test('merging disconnected canonical graphs never fabricates a parent edge', () => {
  const first = graph([message('u1', 'user', 'one'), message('a1', 'assistant', 'one answer')]);
  const second = graph([message('u2', 'user', 'two'), message('a2', 'assistant', 'two answer')]);
  const merged = mergeConversationPayload(first, second);
  assert.equal(merged.mapping.u2.parent, null);
  assert.equal(merged.mapping.a1.children.includes('u2'), false);
});

test('hidden protocol tool/reasoning items stay visible, hidden context does not', () => {
  const hidden = { is_visually_hidden_from_conversation: true };
  const record = ingestConversationPayload(null, graph([
    message('u', 'user', 'question'),
    message('context', 'system', 'private context', { metadata: hidden }),
    message('call', 'assistant', '{"q":"x"}', { recipient: 'web.run', metadata: hidden }),
    message('result', 'tool', 'found', { metadata: hidden }),
    message('a', 'assistant', 'answer'),
  ]));
  const timeline = buildConversationRecordTimeline(record);
  assert.deepEqual(timeline.turns[0].replies.map((row) => row.id), ['call', 'result', 'a']);
  assert.equal(timeline.unresolved.length, 0);
});

test('canonical response ownership converges when an unparented result precedes its anchor', () => {
  const items = [
    message('u', 'user', 'question', { metadata: { turn_exchange_id: 't' } }),
    message('result', 'tool', 'result', { response_id: 'r' }),
    message('anchor', 'assistant', 'answer', { response_id: 'r', metadata: { turn_exchange_id: 't' } }),
  ];
  const record = ingestConversationPayload(null, {
    ...graph(items), message_order: items.map((item) => item.id),
    mapping: Object.fromEntries(items.map((item) => [item.id, { id: item.id, parent: null, children: [], message: item }])),
  });
  const timeline = buildConversationRecordTimeline(record);
  assert.deepEqual(timeline.turns[0].replies.map((row) => row.id), ['result', 'anchor']);
  assert.equal(timeline.unresolved.length, 0);
});

test('message event metadata includes explicit user ownership without treating null sequence as zero', () => {
  const [event] = findMessageEvents({
    sequence_number: 12, turn_user_message_id: 'user-2',
    message: message('a', 'assistant', 'answer', { sequence_number: null }),
  });
  assert.equal(event.turnUserMessageId, 'user-2');
  assert.equal(event.sequenceNumber, 12);
});

test('unspecified output indices do not sort ahead of known protocol items', () => {
  let record = ingestConversationPayload(null, graph([message('u', 'user', 'question')]));
  record = ingestConversationMessage(record, message('a', 'assistant', 'first'), { turnUserMessageId: 'u', outputIndex: 3, observationOrdinal: 1 });
  record = ingestConversationMessage(record, message('b', 'assistant', 'second'), { turnUserMessageId: 'u', observationOrdinal: 2 });
  assert.deepEqual(buildConversationRecordTimeline(record).turns[0].replies.map((row) => row.id), ['a', 'b']);
});

test('old transport context cannot override explicit item turn identity', () => {
  const event = findMessageEvents({ message: message('a', 'assistant', 'new output', { metadata: { turn_exchange_id: 'new-turn' } }) })[0];
  const context = captureMessageContext(event, { turnId: 'old-turn', turnUserMessageId: 'old-user', transportTurnId: 'transport' });
  assert.equal(context.semanticTurnId, 'new-turn');
  assert.deepEqual(context.turnAliases, ['new-turn']);
  assert.equal(context.turnUserMessageId, null);
  assert.equal(context.transportTurnId, 'transport');
});

test('DOM snapshots have no inferred turn ownership and cannot overwrite protocol markdown', () => {
  const context = captureMessageContext({ message: message('old', 'assistant', 'old answer') }, {
    transport: 'dom', turnId: 'current-turn', turnUserMessageId: 'current-user',
  });
  assert.equal(context.turnUserMessageId, null);
  assert.deepEqual(context.turnAliases, []);
  let rows = upsertLiveMessage([], message('a', 'assistant', '**原文**'), { textMode: 'snapshot', captureTransport: 'sse' });
  rows = upsertLiveMessage(rows, message('a', 'assistant', '原文复制'), { textMode: 'snapshot', captureTransport: 'dom' });
  assert.equal(rows[0].text, '**原文**');
});

test('a stale sequence cannot undo a newer corrected snapshot', () => {
  let rows = upsertLiveMessage([], message('a', 'assistant', 'fixed'), { textMode: 'snapshot', sequenceNumber: 12 });
  rows = upsertLiveMessage(rows, message('a', 'assistant', 'wrong'), { textMode: 'snapshot', sequenceNumber: 10 });
  assert.equal(rows[0].text, 'fixed');
});

test('unmatched new turn identity never binds to an explicitly different old user turn', () => {
  let record = ingestConversationPayload(null, graph([message('u', 'user', 'old question', { metadata: { turn_exchange_id: 'old-turn' } })]));
  record = ingestConversationMessage(record, message('a', 'assistant', 'new answer', { parent_id: 'u', metadata: { turn_exchange_id: 'new-turn' } }));
  const timeline = buildConversationRecordTimeline(record);
  assert.equal(timeline.turns[0].replies.length, 0);
  assert.equal(timeline.unresolved[0].replies[0].text, 'new answer');
});

test('message semantic identity is authoritative over conflicting envelope aliases', () => {
  const raw = message('a', 'assistant', 'new', { metadata: { turn_exchange_id: 'new-turn' } });
  assert.deepEqual(messageProtocolIdentity(raw, { turnAliases: ['old-turn'], semanticTurnId: 'old-turn' }).semanticTurnAliases, ['new-turn']);
  const [event] = findMessageEvents({ turn_exchange_id: 'old-turn', message: raw });
  assert.deepEqual(captureMessageContext(event).turnAliases, ['new-turn']);
});

test('same transport message id in different semantic turns cannot overwrite a previous turn', () => {
  let rows = upsertLiveMessage([], message('a', 'assistant', 'first', { metadata: { turn_exchange_id: 'one' } }), { textMode: 'snapshot' });
  rows = upsertLiveMessage(rows, message('a', 'assistant', 'second', { metadata: { turn_exchange_id: 'two' } }), { textMode: 'snapshot' });
  assert.deepEqual(rows.map((row) => row.text), ['first', 'second']);
});

test('same-id distinct output items survive pagination and repeated overlapping pages', () => {
  const canonical = (messages) => findConversationPayload({ id: 'c', current_node: messages.at(-1).id, page_info: {}, messages });
  const reasoning = message('a', 'assistant', 'reasoning', { item_id: 'reason', channel: 'analysis', parent_id: 'u' });
  const final = message('a', 'assistant', 'answer', { item_id: 'final', channel: 'final', parent_id: 'u' });
  const first = canonical([message('u', 'user', 'question'), reasoning]);
  const second = canonical([final]);
  let payload = mergeConversationPayload(first, second);
  payload = mergeConversationPayload(payload, second);
  const timeline = buildConversationRecordTimeline(ingestConversationPayload(null, payload));
  assert.deepEqual(timeline.turns[0].replies.map((row) => row.itemId), ['reason', 'final']);
  assert.equal(timeline.unresolved.length, 0);
});

test('an explicit null content snapshot deletes rather than reviving the old body', () => {
  let rows = upsertLiveMessage([], message('a', 'assistant', 'old'), { textMode: 'snapshot' });
  rows = upsertLiveMessage(rows, { id: 'a', author: { role: 'assistant' }, content: null }, { textMode: 'snapshot' });
  assert.equal(rows[0].text, '');
  assert.equal(rows[0]._rawMessage.content, null);
});

test('all terminal statuses survive late in-progress envelopes, and a corrected success clears errors', () => {
  for (const status of ['completed', 'cancelled', 'aborted', 'stopped', 'incomplete']) {
    let rows = upsertLiveMessage([], message('a', 'assistant', 'final', { status }), { textMode: 'snapshot' });
    rows = upsertLiveMessage(rows, message('a', 'assistant', 'final', { status: 'in_progress' }), { textMode: 'snapshot' });
    assert.equal(rows[0].status, status);
  }
  let rows = upsertLiveMessage([], message('a', 'assistant', '', { status: 'failed', metadata: { is_error: true } }), { textMode: 'snapshot' });
  rows = upsertLiveMessage(rows, message('a', 'assistant', 'recovered', { status: 'finished_successfully', metadata: { is_error: false, error: null } }), { textMode: 'snapshot' });
  assert.equal(rows[0].error, false);
});

test('canonical repeated ids in distinct turns have distinct keys even without item ids', () => {
  const payload = findConversationPayload({ id: 'c', page_info: {}, messages: [
    message('u1', 'user', 'one', { metadata: { turn_exchange_id: 'one' } }),
    message('a', 'assistant', 'answer one', { metadata: { turn_exchange_id: 'one' } }),
    message('u2', 'user', 'two', { metadata: { turn_exchange_id: 'two' } }),
    message('a', 'assistant', 'answer two', { metadata: { turn_exchange_id: 'two' } }),
  ] });
  const timeline = buildConversationRecordTimeline(ingestConversationPayload(null, payload));
  assert.deepEqual(timeline.turns.map((turn) => turn.replies.map((row) => row.text)), [['answer one'], ['answer two']]);
});
