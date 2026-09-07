import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestConversationPayload, buildConversationRecordTimeline } from '../core.js';

const initial = {
  id: 'c', current_node: 'a', mapping: {
    u: { id: 'u', parent: null, children: ['a'], message: { id: 'u', author: { role: 'user' }, content: { parts: ['question'] }, metadata: { turn_exchange_id: 'known-turn' } } },
    a: { id: 'a', parent: 'u', children: [], message: { id: 'a', author: { role: 'assistant' }, content: { parts: ['answer'] } } },
  },
};
const partial = (metadata = {}) => ({
  id: 'c', current_node: 'new-output', metadata: { source: 'optimized-conversation' }, mapping: {
    'new-output': { id: 'new-output', parent: null, children: [], message: { id: 'new-output', author: { role: 'assistant' }, content: { parts: ['captured new answer'] }, metadata } },
  },
});

test('new output from a disconnected partial history stays visible without inventing a turn', () => {
  let record = ingestConversationPayload(null, initial, { canonicalComplete: true });
  record = ingestConversationPayload(record, partial(), { canonicalComplete: false });
  const timeline = buildConversationRecordTimeline(record);
  assert.equal(record.payload.mapping['new-output'].parent, null);
  assert.equal(timeline.turns.length, 1);
  assert.deepEqual(timeline.turns[0].replies.map((item) => item.id), ['a']);
  assert.deepEqual(timeline.unresolved.flatMap((turn) => turn.replies.map((item) => item.id)), ['new-output']);
});

test('partial output with a semantic turn id binds by identity and is not duplicated on repeat', () => {
  let record = ingestConversationPayload(null, initial, { canonicalComplete: true });
  record = ingestConversationPayload(record, partial({ turn_exchange_id: 'known-turn' }), { canonicalComplete: false });
  record = ingestConversationPayload(record, partial({ turn_exchange_id: 'known-turn' }), { canonicalComplete: false });
  const timeline = buildConversationRecordTimeline(record);
  assert.deepEqual(timeline.turns[0].replies.map((item) => item.id), ['a', 'new-output']);
  assert.equal(timeline.unresolved.length, 0);
});

test('an incomplete historical page never creates a historical user turn', () => {
  const record = ingestConversationPayload(null, initial, { canonicalComplete: false });
  assert.equal(buildConversationRecordTimeline(record).turns.length, 0);
});
