import test from 'node:test';
import assert from 'node:assert/strict';
import { findConversationPayload, extractConversationItems, extractModelsList, findMessageEvents } from '../core.js';

const quoted = {
  id: 'quoted-conversation', current_node: 'quoted-message', mapping: { 'quoted-message': { id: 'quoted-message' } },
  items: [{ id: 'not-a-conversation', title: 'A search result' }],
  models: [{ slug: 'not-a-real-model', title: 'Quoted model example' }],
};
const toolMessage = { id: 'tool', author: { role: 'tool' }, content: { content_type: 'execution_output', result: quoted } };

test('structured tool content is never mistaken for conversation, index or model envelopes', () => {
  const envelope = { conversation_id: 'actual-conversation', message: toolMessage };
  assert.equal(findConversationPayload(envelope), null);
  assert.deepEqual(extractConversationItems(envelope), []);
  assert.deepEqual(extractModelsList(envelope), []);
  assert.equal(findMessageEvents(envelope)[0].message.id, 'tool');
});

test('opaque message content does not prevent discovering a genuine sibling envelope', () => {
  const actual = { id: 'real', current_node: 'u', mapping: { u: { id: 'u', message: { id: 'u', author: { role: 'user' }, content: { parts: ['q'] } } } } };
  assert.equal(findConversationPayload({ message: toolMessage, actual }), actual);
  assert.deepEqual(extractConversationItems({ message: toolMessage, actual: { items: [{ id: 'real', title: 'Real conversation' }] } }).map((item) => item.id), ['real']);
});
