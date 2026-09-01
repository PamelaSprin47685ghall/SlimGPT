import assert from 'node:assert/strict';
import test from 'node:test';
import { formatToolPayloadAsToml, highlightToml, parseJsonPayload } from '../src/lib/tool-format.js';

test('tool JSON is converted to structured TOML while preserving JSON nulls visibly', () => {
  const toml = formatToolPayloadAsToml(JSON.stringify({
    query: 'SlimGPT',
    options: { limit: 3, exact: true },
    values: [1, null, 2],
  }));
  assert.match(toml, /query\s*=\s*"SlimGPT"/);
  assert.match(toml, /values\s*=\s*\[\s*1,\s*"<null>",\s*2\s*\]/);
  assert.match(toml, /\[options\]/);
  assert.match(toml, /limit\s*=\s*3/);
  assert.match(toml, /exact\s*=\s*true/);
});

test('nested JSON argument strings become TOML tables instead of escaped JSON blobs', () => {
  const toml = formatToolPayloadAsToml({
    function: {
      name: 'search',
      arguments: '{"query":"hello","limit":2}',
    },
  });
  assert.match(toml, /\[function\]/);
  assert.match(toml, /name\s*=\s*"search"/);
  assert.match(toml, /\[function\.arguments\]/);
  assert.match(toml, /query\s*=\s*"hello"/);
});

test('TOML uses single-line strings unless the value contains newlines', () => {
  const toml = formatToolPayloadAsToml({
    short: 'one line',
    long: 'line one\nline two',
  });
  assert.match(toml, /short\s*=\s*"one line"/);
  assert.match(toml, /long\s*=\s*"""line one\nline two"""/);
  assert.equal(toml.includes('line one\\nline two'), false);
});

test('arrays of JSON objects prefer TOML array-of-tables syntax', () => {
  const toml = formatToolPayloadAsToml({
    results: [
      { id: 1, title: 'first' },
      { id: 2, title: 'second' },
    ],
  });
  assert.equal((toml.match(/\[\[results\]\]/g) || []).length, 2);
  assert.match(toml, /id\s*=\s*1/);
  assert.match(toml, /title\s*=\s*"second"/);
});

test('TOML highlighting escapes source text and emits syntax token markup', () => {
  const highlighted = highlightToml('name = "<tool>"\ncount = 3\n');
  assert.equal(highlighted.includes('<tool>'), false);
  assert.ok(highlighted.includes('&lt;tool&gt;'));
  assert.match(highlighted, /hljs-(attr|string|number)/);
});

test('JSON fenced payloads are parsed before TOML serialization', () => {
  assert.deepEqual(parseJsonPayload('```json\n{"ok":true}\n```'), { ok: true });
});
