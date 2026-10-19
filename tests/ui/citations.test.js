import test from 'node:test';
import assert from 'node:assert/strict';
import { injectCitations, SENTINEL_BASE } from '../../src/ui/markdown/citations.js';

const S = (i) => String.fromCharCode(SENTINEL_BASE + i);

test('citations become one sentinel per span end, numbered by unique source', () => {
  const text = 'Alpha. Beta.';
  const result = injectCitations(text, [
    { start: 7, end: 12, sources: [{ url: 'https://b.example/', title: 'B' }] },
    { start: 0, end: 6, sources: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B' }] },
  ]);
  assert.equal(result.source, `Alpha.${S(0)} Beta.${S(1)}`);
  assert.deepEqual(result.groups.map((g) => g.map((s) => s.n)), [[1, 2], [2]]);
  assert.equal(result.groups[0][0].title, 'A');
  assert.deepEqual(result.fallback, []);
});

test('unsafe, missing or out-of-range citations are dropped; text is never changed otherwise', () => {
  const text = 'x'.repeat(5);
  const result = injectCitations(text, [
    { start: 0, end: 9, sources: [{ url: 'https://late.example/' }] },
    { start: 0, end: 2, sources: [{ url: 'javascript:alert(1)' }, { url: 'https://u:p@x.example/' }] },
    { start: 0, end: 3, sources: [] },
    null,
  ]);
  assert.equal(result.source, text);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(injectCitations(undefined, undefined), { source: '', groups: [], fallback: [] });
});

test('text that already contains sentinel-range characters falls back to a source list', () => {
  const text = `icon ${String.fromCharCode(0xf001)} here`;
  const result = injectCitations(text, [{ start: 0, end: 4, sources: [{ url: 'https://a.example/', title: 'A' }] }]);
  assert.equal(result.source, text);
  assert.deepEqual(result.fallback.map((s) => s.url), ['https://a.example/']);
});
