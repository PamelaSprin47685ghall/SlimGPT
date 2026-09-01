import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodeLanguage, sanitizeMarkdownUrl } from '../src/lib/incremental-markdown.js';

test('markdown URL policy rejects scriptable schemes', () => {
  assert.equal(sanitizeMarkdownUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeMarkdownUrl('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(sanitizeMarkdownUrl('https://example.com/a?q=1'), 'https://example.com/a?q=1');
  assert.equal(sanitizeMarkdownUrl('/c/example'), 'https://chatgpt.com/c/example');
  assert.equal(sanitizeMarkdownUrl('mailto:test@example.com'), 'mailto:test@example.com');
  assert.equal(sanitizeMarkdownUrl('mailto:test@example.com', true), '');
});

test('code language attributes cannot escape their class', () => {
  assert.equal(normalizeCodeLanguage(' TypeScript '), 'typescript');
  assert.equal(normalizeCodeLanguage('language-c++'), 'c++');
  assert.equal(normalizeCodeLanguage('js onclick=alert(1)'), 'js');
  assert.equal(normalizeCodeLanguage('"><script>'), '');
});
