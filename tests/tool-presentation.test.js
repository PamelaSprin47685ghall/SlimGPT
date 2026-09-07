import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolFormatterLoader, presentToolPayload } from '../src/lib/tool-presentation.js';

test('concurrent tool cards share a single lazy module request', async () => {
  let requests = 0;
  const module = { formatToolPayloadAsToml() {}, highlightToml() {} };
  const load = createToolFormatterLoader(async () => { requests++; return module; });
  assert.equal(load(), load());
  assert.deepEqual(await Promise.all([load(), load(), load()]), [module, module, module]);
  assert.equal(requests, 1);
});

test('a rejected formatter load does not poison later attempts or reject invisibly', async () => {
  let attempts = 0;
  const load = createToolFormatterLoader(() => {
    if (++attempts === 1) throw new Error('fixture network failure');
    return 'available';
  });
  await assert.rejects(load(), /network failure/);
  assert.equal(await load(), 'available');
  assert.equal(attempts, 2);
});

test('raw payload is immediately available before optional formatting loads', () => {
  const text = '  {"number":12345678901234567890,"script":"<script>"}\n';
  assert.deepEqual(presentToolPayload(text), { format: 'RAW', text, html: '', failed: false });
  assert.equal(presentToolPayload(text, { raw: true, formatter: { formatToolPayloadAsToml() { throw new Error('must not run'); } } }).text, text);
});

test('either formatter or highlighter failure falls back to the complete raw payload', () => {
  for (const formatter of [
    { formatToolPayloadAsToml() { throw new Error('too deep'); } },
    { formatToolPayloadAsToml() { return 'converted'; }, highlightToml() { throw new Error('highlight failed'); } },
  ]) {
    assert.deepEqual(presentToolPayload('original\n', { formatter }), { format: 'RAW', text: 'original\n', html: '', failed: true });
  }
});

test('successful formatting copies text, never highlighted HTML', () => {
  const formatter = { formatToolPayloadAsToml: () => 'x = 1\n', highlightToml: () => '<b>x</b> = 1\n' };
  assert.deepEqual(presentToolPayload({}, { formatter }), { format: 'TOML', text: 'x = 1\n', html: '<b>x</b> = 1\n', failed: false });
});
