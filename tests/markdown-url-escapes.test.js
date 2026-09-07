import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownDestination, sanitizeMarkdownUrl } from '../src/lib/incremental-markdown.js';

test('parenthesized link titles and escaped destinations are separate', () => {
  assert.deepEqual(parseMarkdownDestination('https://example.com/a\\(b\\)?x=1&amp;y=2 (A title)'), {
    href: 'https://example.com/a(b)?x=1&y=2', title: 'A title',
  });
});

test('entities are decoded before validating a link scheme, never after', () => {
  for (const target of ['<java&#x73;cript:alert(1)> "bad"', '<javascript&#58;alert(1)>', '<data:text/html,bad>', '<https://user:password@example.com>']) {
    assert.equal(sanitizeMarkdownUrl(parseMarkdownDestination(target).href), '');
  }
  assert.deepEqual(parseMarkdownDestination('https://example.com "a\\" onclick=\\"bad &amp; b"'), {
    href: 'https://example.com', title: 'a" onclick="bad & b',
  });
});
