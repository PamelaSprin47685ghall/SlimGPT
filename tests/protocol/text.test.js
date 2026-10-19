import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/protocol/index.js';
import { assistant, mapping, user } from './helpers.js';

test('messageToPlainText: text first, tools as fallback, never throws', () => {
  assert.equal(P.messageToPlainText(P.normalizeMessage(assistant('a', 'Hello'))), 'Hello');
  const call = P.normalizeMessage({ id: 'c', author: { role: 'assistant' }, recipient: 'python', content: { content_type: 'code', text: 'print(1)' } });
  assert.equal(P.messageToPlainText(call), 'print(1)');
  const user = P.normalizeMessage({ id: 'u', author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://f' }, 'a', 'b'] } });
  assert.equal(P.messageToPlainText(user), 'a\n\nb');
  for (const garbage of [null, undefined, {}, { blocks: 'x' }, { blocks: [null, 1, { kind: 'text' }] }]) assert.doesNotThrow(() => P.messageToPlainText(garbage));
});

const exportable = () => P.parseConversation(mapping('c', 'a1', [
  ['u1', null, user('u1', 'How to print ``` in markdown?')],
  ['t1', 'u1', { id: 't1', author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts: [{ summary: 'Plan', content: 'line1\nline2' }] } }],
  ['c1', 't1', { id: 'c1', author: { role: 'assistant' }, recipient: 'python', content: { content_type: 'code', language: 'python', text: 'print("````")' } }],
  ['r1', 'c1', { id: 'r1', author: { role: 'tool', name: 'python' }, content: { content_type: 'execution_output', text: '````' } }],
  ['a1', 'r1', assistant('a1', 'Use a longer fence. Source\ue200cite\ue202turn0search0\ue201.', { metadata: { content_references: [{ matched_text: '\ue200cite\ue202turn0search0\ue201', items: [{ url: 'https://spec.commonmark.org', title: 'CM' }] }] } })],
], { title: 'Fences\nTitle' }));

test('conversationToMarkdown: default export is user + answer only, citations as numbered links', () => {
  const md = P.conversationToMarkdown(exportable());
  assert.equal(md, '# Fences Title\n\n## User\n\nHow to print ``` in markdown?\n\n## Assistant\n\nUse a longer fence. Source [1](https://spec.commonmark.org).\n');
});

test('conversationToMarkdown: tools are fenced with a fence longer than any backtick run', () => {
  const md = P.conversationToMarkdown(exportable(), { includeReasoning: true, includeTools: true });
  assert.match(md, /> \*\*Plan\*\*\n>\n> line1\n> line2/);
  assert.match(md, /`````python\nprint\("````"\)\n`````/);
  assert.match(md, /Tool result: `python`\n\n`````\n````\n`````/);
});

test('conversationToMarkdown follows leafId and is total', () => {
  const conversation = exportable();
  assert.equal(P.conversationToMarkdown(conversation, { leafId: 'u1' }), '# Fences Title\n\n## User\n\nHow to print ``` in markdown?\n');
  for (const garbage of [null, {}, { nodes: 1 }]) assert.equal(P.conversationToMarkdown(garbage), '');
  assert.doesNotThrow(() => P.conversationToMarkdown(conversation, null));
});

test('parseConversationList', () => {
  const body = JSON.stringify({ items: [
    { id: 'a', title: 'First', update_time: '2026-10-01T00:00:00.000Z' },
    { id: 'b', title: null, update_time: 1700000000 },
    { id: 'a', title: 'dup' },
    { title: 'no id' }, null, 'x',
    { id: 'c', create_time: 1700000000123 },
  ], total: 3 });
  assert.deepEqual(P.parseConversationList(body), [
    { id: 'a', title: 'First', updatedAt: Date.parse('2026-10-01T00:00:00.000Z') / 1000 },
    { id: 'b', title: '', updatedAt: 1700000000 },
    { id: 'c', title: '', updatedAt: 1700000000.123 },
  ]);
  for (const bad of ['', '{', '{"items":3}', null, 5, { mapping: {} }]) assert.equal(P.parseConversationList(bad), null);
  assert.deepEqual(P.parseConversationList({ items: [] }), []);
});
