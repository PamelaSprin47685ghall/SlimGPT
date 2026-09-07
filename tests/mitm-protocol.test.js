import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { consumeSse, createConversationSseDecoder } from '../core.js';

// The page hook is a classic script, so exercise its actual functions in an
// isolated realm instead of copying their implementation into the test.
const source = readFileSync(new URL('../main-mitm.js', import.meta.url), 'utf8');
const names = ['consumeOfficialSseBlocks', 'parseOfficialSseFrame', 'decodeOfficialCompactDelta',
  'expandOfficialDelta', 'applyOfficialDelta', 'parseOfficialDeltaPath', 'applyOfficialDeltaOperation'];
const declarations = names.map((name) => {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf('\n  function ', start + 1);
  assert.ok(end > start);
  return source.slice(start, end);
}).join('\n');
const hook = runInNewContext(`${declarations}\n({${names.join(',')}})`);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('page hook and UI agree on every chunk split, including CR-only and partial EOF', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = `\ufeffdata: {"message":"中文"}${newline}${newline}data: [DONE]${newline}${newline}data: {"truncated":true}`;
    for (let split = 0; split <= text.length; split += 1) {
      const first = hook.consumeOfficialSseBlocks('', text.slice(0, split));
      const last = hook.consumeOfficialSseBlocks(first.rest, text.slice(split), true);
      const captured = [...first.blocks, ...last.blocks].map(hook.parseOfficialSseFrame).filter(Boolean).map((frame) => frame.data);
      assert.deepEqual(captured, consumeSse('', text, true).frames.map((frame) => frame.data));
    }
  }
});

test('page hook and UI apply identical immutable JSON pointer operations', () => {
  const stream = createConversationSseDecoder();
  stream.decode({ event: 'delta_encoding', data: '"v1"' });
  let previous = { channel: 0, op: 'add', path: '', value: undefined };
  let value;
  for (const raw of [
    { channel: 0, op: 'add', path: '', value: { parts: ['a'], 'a/b': { '~': 'x' } } },
    { o: 'add', p: '/parts/-', v: 'b' },
    { o: 'replace', p: '/a~1b/~0', v: 'corrected' },
    { o: 'patch', p: '', v: [{ p: '/parts/0', o: 'remove' }, { p: '/parts/0', o: 'append', v: 'c' }] },
  ]) {
    const delta = hook.decodeOfficialCompactDelta(raw, previous);
    value = hook.applyOfficialDelta(value, delta);
    previous = delta;
    assert.deepEqual(plain(value), stream.decode({ event: 'delta', json: raw }));
  }
  assert.throws(() => hook.applyOfficialDelta(value, { op: 'add', path: '/parts/999', value: 'bad' }));
  assert.throws(() => hook.applyOfficialDelta(value, { op: 'replace', path: '/__proto__/x', value: true }));
  assert.equal({}.x, undefined);
});
