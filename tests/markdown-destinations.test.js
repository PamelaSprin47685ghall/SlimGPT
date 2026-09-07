import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownDestination, sanitizeMarkdownUrl } from '../src/lib/incremental-markdown.js';

test('angle-wrapped citation destinations and titles remain external URLs', () => {
  const result = parseMarkdownDestination('<https://example.com/source> "Source"');
  assert.deepEqual(result, { href: 'https://example.com/source', title: 'Source' });
  assert.equal(sanitizeMarkdownUrl(result.href), 'https://example.com/source');
  assert.deepEqual(parseMarkdownDestination('https://example.com/a "A title"'), { href: 'https://example.com/a', title: 'A title' });
  assert.deepEqual(parseMarkdownDestination("<https://example.com/a(b)> 'Title'"), { href: 'https://example.com/a(b)', title: 'Title' });
});

test('quoted titles are plain text and never part of the navigation address', () => {
  const result = parseMarkdownDestination('<https://example.com/> "x\\" onclick=\\"bad"');
  assert.equal(result.href, 'https://example.com/');
  assert.equal(result.title, 'x" onclick="bad');
  assert.equal(sanitizeMarkdownUrl(parseMarkdownDestination('<javascript:alert(1)> "Bad"').href), '');
  assert.deepEqual(parseMarkdownDestination('<https://example.com> onclick="bad"'), { href: '', title: '' });
});

test('plain relative, anchor and mail destinations retain their existing behavior', () => {
  for (const value of ['#section', '/c/conversation', 'mailto:test@example.invalid', 'https://example.com/a%20b']) {
    assert.equal(parseMarkdownDestination(value).href, value);
  }
});
