// Live bug (bda5542): raw `:::writing{…}` directives rendered as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';
import { splitDirectives, parseDirectiveAttributes } from '../../src/protocol/directives.js';

const har = JSON.parse(readFileSync(new URL('../fixtures/protocol/har-history-after-regenerate.json', import.meta.url), 'utf8'));
const raw = (text, extra = {}) => ({
  id: 'm1', author: { role: 'assistant' }, status: 'finished_successfully', end_turn: true,
  content: { content_type: 'text', parts: [text] }, metadata: {}, ...extra,
});

test('real HAR answer: :::writing becomes a textdoc block with title and markdown body', () => {
  const answer = har.messages.find((m) => m.author?.role === 'assistant' && String(m.content?.parts?.[0] ?? '').includes(':::writing'));
  assert.ok(answer, 'fixture carries the directive');
  const message = P.normalizeMessage(answer);
  assert.deepEqual(message.blocks.map((b) => b.kind), ['text', 'textdoc', 'text']);
  const doc = message.blocks[1];
  assert.equal(doc.title, '宇宙大爆炸：我们从哪里来？');
  assert.equal(doc.variant, 'document');
  assert.equal(doc.directive, 'writing');
  assert.match(doc.markdown, /^# 宇宙大爆炸/);
  for (const block of message.blocks) assert.doesNotMatch(block.markdown, /^:::|\n:::/m, 'no fence lines left');
  assert.doesNotMatch(message.blocks[0].markdown, /message_reaction|\uE200/, 'reaction marker stripped');
  const md = P.conversationToMarkdown(P.parseConversation(JSON.stringify(har)), {});
  assert.match(md, /# 宇宙大爆炸：我们从哪里来？/);
  assert.doesNotMatch(md, /:::/);
  assert.match(P.messageToPlainText(message), /宇宙大爆炸：我们从哪里来？/);
});

test('unknown directives lose only their fence lines; code fences are left alone', () => {
  const blocks = P.normalizeMessage(raw('Intro\n\n:::callout{tone="info"}\n**Inner** text\n:::\n\nOutro')).blocks;
  assert.deepEqual(blocks.map((b) => [b.kind, b.markdown.trim()]), [['text', 'Intro'], ['text', '**Inner** text'], ['text', 'Outro']]);
  const code = '```md\n:::writing{title="x"}\nbody\n:::\n```';
  assert.deepEqual(P.normalizeMessage(raw(code)).blocks.map((b) => [b.kind, b.markdown]), [['text', code]]);
});

test('streaming: an unclosed directive renders as a growing textdoc; nested directives stay inside', () => {
  const partial = P.normalizeMessage(raw('Here:\n\n:::writing{variant="email" title="Hi \\"Bob\\""}\nDear Bob,\n\nLine', { status: 'in_progress', end_turn: null })).blocks;
  assert.deepEqual(partial.map((b) => b.kind), ['text', 'textdoc']);
  assert.equal(partial[1].title, 'Hi "Bob"');
  assert.equal(partial[1].markdown, 'Dear Bob,\n\nLine');
  const nested = splitDirectives(':::writing{title="T"}\na\n:::note\nb\n:::\nc\n:::');
  assert.deepEqual(nested.map((s) => [s.kind, s.markdown]), [['textdoc', 'a\n:::note\nb\n:::\nc']]);
  assert.deepEqual(parseDirectiveAttributes('{variant="document" id="58321" title=\'x y\' n=3}'), { variant: 'document', id: '58321', title: 'x y', n: '3' });
});

test('user text is never parsed for directives', () => {
  const blocks = P.normalizeMessage({ ...raw(':::writing{title="x"}\nbody\n:::'), author: { role: 'user' } }).blocks;
  assert.deepEqual(blocks.map((b) => b.kind), ['text']);
});

test('device records keep textdoc blocks through a save/load round trip', () => {
  const conversation = P.parseConversation(JSON.stringify(har));
  const record = P.localRecordFromConversation(conversation, { title: 't' });
  assert.ok(record);
  const back = P.conversationFromLocalRecord(record);
  const kinds = [...back.nodes.values()].flatMap((node) => node.message?.blocks ?? []).map((b) => b.kind);
  assert.ok(kinds.includes('textdoc'));
});
