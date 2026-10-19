// Regression tests for the bugs diagnosed on main@11cbb34 (PLAN.md §2).
// Bugs 1 and 2 are covered in contract.test.js with their fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/protocol/index.js';
import { applyEvents, decodeChunks, fixture, json, mapping, user } from './helpers.js';

test('bug 3: canonical Markdown (code, tables, lists) survives byte-exact, no UI labels', () => {
  const fx = json('regression-markdown-fidelity.json');
  const message = P.normalizeMessage(fx.raw);
  assert.equal(message.blocks.length, 1);
  assert.equal(message.blocks[0].markdown, fx.expectMarkdown);
  assert.doesNotMatch(P.messageToPlainText(message), /Copy code/);
  assert.equal(P.messageToPlainText(message), fx.expectMarkdown);
});

test('bug 4: deltas are applied literally (repeats, overlaps, bare newlines) at every chunk size', () => {
  const expected = json('streams/regression-progressive-text.expected.json');
  const text = fixture('streams/regression-progressive-text.sse');
  for (let split = 1; split <= 64; split += 1) {
    const conversation = applyEvents(P.createConversation('c-4'), decodeChunks(text, [split]));
    assert.equal(conversation.nodes.get(expected.id).message.blocks[0].markdown, expected.markdown, `split ${split}`);
  }
});

test('bug 4: snapshot replace never merges text heuristically', () => {
  let conversation = P.createConversation('c');
  for (const text of ['aa', 'a', 'Hello wor', 'x = 1\n']) {
    conversation = P.applyLiveMessage(conversation, { id: 'm', author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, status: 'in_progress' });
    assert.equal(conversation.nodes.get('m').message.blocks[0].markdown, text);
  }
  // Reasoning is replaced too, never appended to an earlier snapshot.
  for (const body of ['think', 'th', 'think more']) {
    conversation = P.applyLiveMessage(conversation, { id: 't', author: { role: 'assistant' }, content: { content_type: 'thoughts', thoughts: [{ summary: 'S', content: body }] }, status: 'in_progress' });
    assert.equal(conversation.nodes.get('t').message.blocks[0].markdown, body);
  }
});

test('bug 5: every streaming prefix of a cited answer is clean; final has structured citations', () => {
  const fx = json('regression-streaming-citations.json');
  for (const prefix of fx.prefixes) {
    const message = P.normalizeMessage({ id: 'c', author: { role: 'assistant' }, content: { content_type: 'text', parts: [prefix] }, status: 'in_progress', metadata: fx.metadata });
    for (const block of message.blocks) {
      assert.doesNotMatch(block.markdown, /[\uE000-\uF8FF]/, JSON.stringify(prefix));
      for (const word of fx.forbidden) assert.ok(!block.markdown.includes(word), `${JSON.stringify(prefix)} contains ${word}`);
      assert.ok(fx.finalMarkdown.startsWith(block.markdown), `prefix ${JSON.stringify(block.markdown)} is a prefix of the final text`);
      for (const citation of block.citations) assert.ok(citation.start <= block.markdown.length);
    }
  }
  const done = P.normalizeMessage({ id: 'c', author: { role: 'assistant' }, content: { content_type: 'text', parts: [fx.prefixes.at(-1)] }, status: 'finished_successfully', metadata: fx.metadata });
  assert.equal(done.blocks[0].markdown, fx.finalMarkdown);
  assert.deepEqual(done.blocks[0].citations.map(({ start, end }) => ({ start, end })), fx.finalCitations);
  assert.equal(done.blocks[0].citations[0].sources[0].url, 'https://en.wikipedia.org/wiki/Paris');
});

test('bug 5: unresolved markers never become placeholder prose; legacy markers in code fences are kept', () => {
  const message = P.normalizeMessage({ id: 'x', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['A \ue200cite\ue202turn9\ue201 B \ue200products\ue202x\ue201 C\n```\nliteral【1†x】\n```'] } });
  assert.equal(message.blocks[0].markdown, 'A  B  C\n```\nliteral【1†x】\n```');
  assert.deepEqual(message.blocks[0].citations, []);
});

test('bug 6: system_error is flagged as an error message', () => {
  const conversation = P.parseConversation(mapping('c', 'se', [
    ['u1', null, user('u1', 'q')],
    ['se', 'u1', { id: 'se', author: { role: 'system' }, content: { content_type: 'system_error', name: 'X', text: 'boom' } }],
  ]));
  const [turn] = P.selectTurns(conversation);
  assert.equal(turn.replies[0].status, 'error');
  assert.deepEqual(turn.replies[0].blocks, [{ kind: 'error', message: 'boom' }]);
  assert.equal(turn.replies[0].hidden, false);
});

test('bug 7: media are blocks; internal pointers never appear in any text projection', () => {
  const pointers = ['file-service://file-abc', 'sediment://file_x', 'sediment://a', 'sediment://secret'];
  for (const testCase of json('messages.json').cases) {
    const message = P.normalizeMessage(testCase.raw);
    const texts = [P.messageToPlainText(message), ...message.blocks.filter((block) => block.kind === 'text').map((block) => block.markdown)];
    for (const text of texts) for (const pointer of pointers) assert.ok(!text.includes(pointer), `${testCase.name}: ${pointer}`);
    for (const text of texts) assert.doesNotMatch(text, /🖼️|📎|\[图片|\[附件/, testCase.name);
  }
  const exported = P.conversationToMarkdown(P.parseConversation(mapping('c', 'g1', [
    ['u1', null, { id: 'u1', author: { role: 'user' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-abc' }, 'q'] } }],
    ['g1', 'u1', { id: 'g1', author: { role: 'tool', name: 'img' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_x' }] } }],
  ])), { includeTools: true });
  for (const pointer of pointers) assert.ok(!exported.includes(pointer));
});
