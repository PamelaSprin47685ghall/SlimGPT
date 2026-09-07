import test from 'node:test';
import assert from 'node:assert/strict';
import { renderContentReferences } from '../src/lib/content-references.js';
import {
  parseMarkdownDestination,
  sanitizeMarkdownUrl,
  normalizeCodeLanguage,
} from '../src/lib/incremental-markdown.js';

test('content-references generates valid links with stable source numbering', () => {
  const marker = '\uE200cite\uE202turn0search0\uE201';
  const metadata = {
    content_references: [{
      matched_text: marker,
      items: [
        { title: 'Test Article Title', url: 'https://example.com/article' }
      ]
    }]
  };
  const result = renderContentReferences(marker, metadata);
  assert.equal(result, '[来源 1](https://example.com/article)');

  const match = result.match(/\[来源 1\]\((.*?)\)/);
  assert.ok(match);
  const dest = parseMarkdownDestination(match[1]);
  assert.equal(dest.href, 'https://example.com/article');
  assert.equal(sanitizeMarkdownUrl(dest.href), 'https://example.com/article');
});

test('link sanitization identifies unsafe urls and distinguishes safe ones', () => {
  assert.equal(sanitizeMarkdownUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeMarkdownUrl('data:text/html,bad'), '');
  assert.equal(sanitizeMarkdownUrl('https://valid.com/page'), 'https://valid.com/page');
  assert.equal(sanitizeMarkdownUrl('mailto:user@example.com'), 'mailto:user@example.com');
});

test('normalizeCodeLanguage handles languages and comments keywords correctly', () => {
  assert.equal(normalizeCodeLanguage('python'), 'python');
  assert.equal(normalizeCodeLanguage('javascript'), 'javascript');
  assert.equal(normalizeCodeLanguage('language-rust'), 'rust');
  assert.equal(normalizeCodeLanguage('C++'), 'c++');
});

test('multiple references deduplicate by url', () => {
  const marker = '\uE200cite\uE202id1\uE201';
  const metadata = {
    citations: [
      { matched_text: marker, url: 'https://example.com/page', title: 'First Page' },
      { matched_text: marker, url: 'https://example.com/page', title: 'Second Page Duplicate' },
    ]
  };
  const result = renderContentReferences(marker, metadata);
  assert.equal(result, '[来源 1](https://example.com/page)');
});
