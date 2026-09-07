import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationRecordTimeline, ingestConversationPayload, ingestConversationMessage,
  setConversationRecordTerminal, hydrateConversationObservations,
} from '../core.js';
import { compactObservationLedger } from '../src/lib/storage.js';

const message = (id, text, extra = {}) => ({
  id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] },
  metadata: { turn_exchange_id: 'same-user-turn' }, ...extra,
});
function branchedHistory() {
  const mapping = {};
  const add = (id, parent, text, extra = {}) => {
    mapping[id] = { id, parent, children: [], message: message(id, text, extra) };
    if (parent) mapping[parent].children.push(id);
  };
  add('u', null, 'question', { author: { role: 'user' } });
  add('call-old', 'u', '{}', { recipient: 'web.run', call_id: 'old-call', response_id: 'old-response' });
  add('old', 'call-old', 'old answer', { response_id: 'old-response', status: 'finished_successfully' });
  add('call-new', 'u', '{}', { recipient: 'web.run', call_id: 'new-call', response_id: 'new-response' });
  add('new', 'call-new', 'new answer', { response_id: 'new-response', status: 'finished_successfully' });
  return { id: 'c', current_node: 'new', mapping };
}
const replyIds = (record) => buildConversationRecordTimeline(record).turns.flatMap((turn) => turn.replies.map((item) => item.id));

test('regenerated answers sharing one user turn never reappear from the other canonical branch', () => {
  const payload = branchedHistory();
  let record = ingestConversationPayload(null, payload);
  for (const id of ['call-old', 'old', 'call-new', 'new']) {
    record = ingestConversationMessage(record, payload.mapping[id].message, { textMode: 'snapshot' });
  }
  assert.deepEqual(replyIds(record), ['call-new', 'new']);
  assert.deepEqual(replyIds(setConversationRecordTerminal(record, 'old')), ['call-old', 'old']);
  assert.deepEqual(replyIds(setConversationRecordTerminal(record, 'new')), ['call-new', 'new']);
});

test('same-user regenerated branch selection survives observation-ledger reload', () => {
  const payload = branchedHistory();
  let record = ingestConversationPayload(null, payload);
  record = ingestConversationMessage(record, payload.mapping.old.message, { textMode: 'snapshot' });
  const [saved] = compactObservationLedger([{ id: 'c', observations: record.observations }]);
  record = hydrateConversationObservations(ingestConversationPayload(null, payload), saved.observations);
  assert.deepEqual(replyIds(record), ['call-new', 'new']);
  assert.equal(buildConversationRecordTimeline(record).unresolved.length, 0);
});

test('unpersisted tool outputs follow their known response branch rather than the shared user turn', () => {
  let record = ingestConversationPayload(null, branchedHistory());
  for (const [id, extra] of [
    ['old-result', { tool_call_id: 'old-call', author: { role: 'tool' } }],
    ['old-commentary', { response_id: 'old-response' }],
    ['old-child', { parent_id: 'old-commentary' }],
    ['new-result', { tool_call_id: 'new-call', author: { role: 'tool' } }],
  ]) record = ingestConversationMessage(record, message(id, id, extra), { textMode: 'snapshot' });
  assert.deepEqual(new Set(replyIds(record)), new Set(['call-new', 'new', 'new-result']));
  assert.deepEqual(new Set(replyIds(setConversationRecordTerminal(record, 'old'))), new Set(['call-old', 'old', 'old-result', 'old-commentary', 'old-child']));
});

test('a new explicit user identity still overrides a misleading parent on an older branch', () => {
  const payload = branchedHistory();
  payload.mapping.next = { id: 'next', parent: 'new', children: [], message: message('next', 'next question', { author: { role: 'user' }, metadata: { turn_exchange_id: 'next-turn' } }) };
  payload.mapping.new.children.push('next');
  payload.current_node = 'next';
  let record = ingestConversationPayload(null, payload);
  record = ingestConversationMessage(record, message('live', 'current answer', { parent_id: 'old', turn_user_message_id: 'next', metadata: { turn_exchange_id: 'next-turn' } }), { textMode: 'snapshot' });
  const timeline = buildConversationRecordTimeline(record);
  assert.equal(timeline.turns[1].replies[0]?.id, 'live');
});

test('unknown branch provenance remains visible rather than being guessed from shared turn metadata', () => {
  let record = ingestConversationPayload(null, branchedHistory());
  record = ingestConversationMessage(record, message('unknown', 'retained'), { textMode: 'snapshot' });
  assert.equal(replyIds(record).includes('unknown'), true);
});

test('unchanged canonical text is not reparsed on each live update, while a new payload invalidates the cache', () => {
  const payload = branchedHistory();
  let reads = 0;
  const content = { content_type: 'text', get parts() { reads += 1; return ['new answer']; } };
  payload.mapping.new.message.content = content;
  let record = ingestConversationPayload(null, payload);
  buildConversationRecordTimeline(record);
  reads = 0;
  for (let index = 0; index < 20; index += 1) {
    record = ingestConversationMessage(record, message('live', `update ${index}`, { parent_id: 'new' }), { textMode: 'snapshot' });
    buildConversationRecordTimeline(record);
  }
  assert.equal(reads, 0, 'immutable canonical payload needs no repeated content parsing');
  const replacement = branchedHistory();
  replacement.mapping.new.message.content.parts = ['server correction'];
  record = ingestConversationPayload(record, replacement);
  const answer = buildConversationRecordTimeline(record).turns[0].replies.find((row) => row.id === 'new');
  assert.equal(answer.text, 'server correction');
});
