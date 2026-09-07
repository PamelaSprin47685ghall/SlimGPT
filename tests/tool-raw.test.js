import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'smol-toml';
import { formatRawToolPayload, formatToolPayloadAsToml, highlightToml } from '../src/lib/tool-format.js';

test('raw tool strings keep exact whitespace, escapes and large numeric literals', () => {
  const text = '  {"id":12345678901234567890123,"text":"\\n中文"}\n\n';
  assert.equal(formatRawToolPayload(text), text);
  assert.deepEqual(JSON.parse(formatRawToolPayload({ text: '中文', missing: null })), { text: '中文', missing: null });
});

test('special-looking keys are displayed as data rather than object prototypes', () => {
  const payload = JSON.parse('{"__proto__":{"note":"keep"},"constructor":"keep too"}');
  const parsed = parse(formatToolPayloadAsToml(payload));
  assert.equal(parsed.__proto__.note, 'keep');
  assert.equal(parsed.constructor, 'keep too');
  assert.equal({}.note, undefined);
});

test('very long tool logs bypass highlighting without losing text or allowing HTML', () => {
  const text = '<script>&'.repeat(30_000);
  const html = highlightToml(text);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html, text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
});
