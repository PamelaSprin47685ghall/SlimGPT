import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationRecordTimeline, buildConversationRecordView,
  consumeSse, createConversationSseDecoder, decodeCaptureBody,
  findConversationLifecycleEvents, findConversationPayload, findMessageEvents,
  fingerprintCapture, getToolMessageInfo, hydrateConversationObservations,
  ingestConversationMessage, ingestConversationPayload, mergeConversationPayload,
  messageProtocolIdentity, upsertLiveMessage,
} from '../core.js';

const message = (id, text, extra = {}) => ({
  id, author: { role: 'assistant' },
  content: { content_type: 'text', parts: [text] }, ...extra,
});
const user = (id = 'u', turn = 'turn') => message(id, 'question', {
  author: { role: 'user' }, metadata: { turn_exchange_id: turn },
});
function history(messages) {
  return findConversationPayload({
    conversation_id: 'conversation', current_node: messages.at(-1)?.id,
    page_info: { has_previous_page: false }, messages,
  });
}
function decoder() {
  const result = createConversationSseDecoder();
  result.decode({ event: 'delta_encoding', data: '"v1"' });
  return result;
}
const delta = (json) => ({ event: 'delta', json });

test('base64 captures decode UTF-8 rather than Latin-1', () => {
  const text = '{"text":"中文、日本語、🙂"}';
  assert.equal(decodeCaptureBody({ base64Encoded: true, data: Buffer.from(text).toString('base64') }), text);
});

test('SSE framing is independent of byte-chunk boundaries and line endings', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const source = `\ufeff: comment${newline}event: update${newline}id:  two spaces ${newline}data: first${newline}data:  second${newline}${newline}`;
    for (let split = 0; split <= source.length; split += 1) {
      const first = consumeSse('', source.slice(0, split));
      const last = consumeSse(first.rest, source.slice(split), true);
      assert.deepEqual([...first.frames, ...last.frames].map(({ event, id, data }) => ({ event, id, data })), [
        { event: 'update', id: ' two spaces ', data: 'first\n second' },
      ], `line ending ${JSON.stringify(newline)}, split ${split}`);
    }
  }
});

test('SSE accepts empty colonless data fields and discards unterminated events at EOF', () => {
  assert.equal(consumeSse('', 'data\n\n').frames[0]?.data, '');
  assert.deepEqual(consumeSse('', 'data: {"partial":true}', true).frames, []);
  assert.equal(consumeSse('', 'id: bad\0id\ndata: ok\n\n').frames[0]?.id, null);
});

test('delta decoder respects long-form fields instead of overwriting them with inherited values', () => {
  const stream = decoder();
  stream.decode(delta({ channel: 3, op: 'add', path: '', value: { text: 'a' } }));
  assert.deepEqual(stream.decode(delta({ channel: 3, op: 'append', path: '/text', value: 'b' })), { text: 'ab' });
});

test('failed delta operations do not poison inherited channel/path/op state', () => {
  const stream = decoder();
  stream.decode(delta({ c: 0, p: '', o: 'add', v: { text: 'a' } }));
  stream.decode(delta({ p: '/text', o: 'append', v: 'b' }));
  assert.throws(() => stream.decode(delta({ p: '/__proto__/polluted', o: 'replace', v: true })));
  assert.deepEqual(stream.decode(delta({ v: 'c' })), { text: 'abc' });
  assert.equal({}.polluted, undefined);
});

test('JSON-pointer array append appends at the end, without mutating prior snapshots', () => {
  const stream = decoder();
  const first = stream.decode(delta({ v: { parts: ['a', 'b'] } }));
  assert.deepEqual(stream.decode(delta({ p: '/parts/-', o: 'add', v: 'c' })).parts, ['a', 'b', 'c']);
  assert.deepEqual(first.parts, ['a', 'b']);
});

test('authoritative snapshots can correct, shorten, and clear text', () => {
  let rows = upsertLiveMessage([], message('a', 'old answer'), { textMode: 'snapshot' });
  rows = upsertLiveMessage(rows, message('a', 'replacement'), { textMode: 'snapshot' });
  assert.equal(rows[0].text, 'replacement');
  rows = upsertLiveMessage(rows, message('a', ''), { textMode: 'snapshot' });
  assert.equal(rows[0].text, '');
});

test('reasoning snapshots replace rather than concatenate removed thoughts', () => {
  const thought = (text) => message('reason', '', { content: { content_type: 'thoughts', thoughts: [{ summary: 'Step', content: text }] } });
  let rows = upsertLiveMessage([], thought('wrong reasoning'), { textMode: 'snapshot' });
  rows = upsertLiveMessage(rows, thought('corrected reasoning'), { textMode: 'snapshot' });
  assert.equal(rows[0].thought, '> **Step**\n\ncorrected reasoning');
});

test('tool snapshots preserve repeated same-type array items and replace corrected arguments', () => {
  const call = (args) => message('call', '', {
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search', arguments: args } }],
  });
  let rows = upsertLiveMessage([], call('{"q":"wrong"}'), { textMode: 'snapshot' });
  rows = upsertLiveMessage(rows, call('{"q":"right"}'), { textMode: 'snapshot' });
  assert.equal(rows[0].tool.payload.function.arguments, '{"q":"right"}');
  const blocks = (a, b) => message('blocks', '', { content: { content_type: 'text', parts: [{ type: 'text', text: a }, { type: 'text', text: b }] } });
  let parts = upsertLiveMessage([], blocks('first', 'second'), { textMode: 'snapshot' });
  parts = upsertLiveMessage(parts, blocks('FIRST', 'SECOND'), { textMode: 'snapshot' });
  assert.equal(parts[0].text, 'FIRST\nSECOND');
});

test('explicit text deltas preserve intentional repetition without overlap guessing', () => {
  let rows = upsertLiveMessage([], message('repeat', 'ha'), { textMode: 'delta' });
  rows = upsertLiveMessage(rows, message('repeat', 'ha'), { textMode: 'delta' });
  assert.equal(rows[0].text, 'haha');
});

test('discovery consumes protocol snapshots without concatenating two revisions in a frame', () => {
  const events = findMessageEvents({ messages: [message('a', 'wrong'), message('a', 'right')] }, { textMode: 'snapshot' });
  assert.equal(events.length, 1);
  assert.equal(events[0].message.content.parts[0], 'right');
});

test('protocol identity prefers message metadata over enclosing transport context', () => {
  const identity = messageProtocolIdentity(message('a', 'answer', {
    turn_user_message_id: 'new-user', metadata: { response_id: 'new-response', channel: 'final' },
  }), { turnUserMessageId: 'old-user', responseId: 'old-response', phase: 'analysis' });
  assert.equal(identity.turnUserMessageId, 'new-user');
  assert.equal(identity.responseId, 'new-response');
  assert.equal(identity.phase, 'final');
});

test('event discovery carries explicit user ownership and does not invent zero sequence numbers', () => {
  const [event] = findMessageEvents({ turn_user_message_id: 'u', sequence_number: null, output_index: '', message: message('a', 'ok') });
  assert.equal(event.turnUserMessageId, 'u');
  assert.equal(event.sequenceNumber, null);
  assert.equal(event.outputIndex, null);
});

test('lifecycle discovery never treats objects inside message content as protocol events', () => {
  const data = message('tool-result', '', { author: { role: 'tool' }, content: {
    content_type: 'execution_output', result: { type: 'conversation_update', conversation_id: 'not-the-current-conversation' },
  } });
  assert.deepEqual(findConversationLifecycleEvents({ message: data }), []);
});

test('canonical tool results resolve to a later anchor just like live items', () => {
  const payload = history([
    user(),
    message('result', 'result', { author: { role: 'tool' }, tool_call_id: 'call-1' }),
    message('call', '{}', { recipient: 'search', call_id: 'call-1', metadata: { turn_exchange_id: 'turn' } }),
  ]);
  const timeline = buildConversationRecordTimeline(ingestConversationPayload(null, payload));
  assert.equal(timeline.unresolved.length, 0);
  assert.deepEqual(timeline.turns[0].replies.map((item) => item.id), ['call', 'result']);
});

test('canonical output honors an explicit user id even with a misleading parent', () => {
  const payload = history([
    user('u1', 'turn-1'), user('u2', 'turn-2'),
    message('a', 'second answer', { parent_id: 'u1', turn_user_message_id: 'u2' }),
  ]);
  const timeline = buildConversationRecordTimeline(ingestConversationPayload(null, payload));
  assert.deepEqual(timeline.turns.map((turn) => turn.replies.map((item) => item.id)), [[], ['a']]);
});

test('unknown explicit user ownership must not fall back to an old parent', () => {
  let record = ingestConversationPayload(null, history([user('u1', 'turn-1')]));
  record = ingestConversationMessage(record, message('a', 'new answer', { parent_id: 'u1', turn_user_message_id: 'not-loaded-yet' }));
  const timeline = buildConversationRecordTimeline(record);
  assert.equal(timeline.turns[0].replies.length, 0);
  assert.equal(timeline.unresolved.flatMap((turn) => turn.replies).length, 1);
});

test('complete canonical text is not contaminated by an older observation on reload', () => {
  let record = ingestConversationMessage(null, message('a', 'old text', { parent_id: 'u' }), { textMode: 'snapshot' });
  record = ingestConversationPayload(record, history([user(), message('a', 'correct text', { parent_id: 'u', status: 'finished_successfully' })]));
  assert.equal(buildConversationRecordView(record).find((item) => item.id === 'a').text, 'correct text');
});

test('rehydrating stale text cannot append it to the current authoritative snapshot', () => {
  const stored = upsertLiveMessage([], message('a', 'old text'), { textMode: 'snapshot' });
  const current = ingestConversationMessage(null, message('a', ''), { textMode: 'snapshot' });
  const restored = hydrateConversationObservations(current, stored);
  assert.equal(restored.observations[0].text, '');
});

test('partial nonoverlapping histories do not manufacture a parent relationship', () => {
  const first = history([user('u1', 'turn-1')]);
  const second = history([user('u2', 'turn-2')]);
  assert.equal(mergeConversationPayload(first, second).mapping.u2.parent, null);
});

test('canonical item lists preserve distinct output items that reuse a message id', () => {
  const payload = history([
    user(),
    message('a', 'reasoning', { channel: 'analysis', item_id: 'reason', parent_id: 'u' }),
    message('a', 'answer', { channel: 'final', item_id: 'final', parent_id: 'u' }),
  ]);
  const rows = buildConversationRecordView(ingestConversationPayload(null, payload)).filter((item) => item.role === 'assistant');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((item) => item.itemId), ['reason', 'final']);
});

test('different content indices on the same item remain distinct observations', () => {
  let rows = upsertLiveMessage([], message('a', 'first', { content_index: 0 }), { textMode: 'snapshot' });
  rows = upsertLiveMessage(rows, message('a', 'second', { content_index: 1 }), { textMode: 'snapshot' });
  assert.deepEqual(rows.map((item) => item.text), ['first', 'second']);
});

test('search results are not discarded when query metadata is also present', () => {
  const tool = getToolMessageInfo(message('result', '', { author: { role: 'tool' }, metadata: {
    search_model_queries: { queries: ['query'] }, search_result_groups: [{ domain: 'example.com', entries: [{ title: 'Result' }] }],
  } }));
  assert.equal(tool.payload.results[0].entries[0].title, 'Result');
});

test('capture fingerprints distinguish same-length edits in the middle of a response', () => {
  const prefix = 'a'.repeat(200), suffix = 'z'.repeat(200);
  assert.notEqual(fingerprintCapture({}, `${prefix}old${suffix}`), fingerprintCapture({}, `${prefix}new${suffix}`));
});
