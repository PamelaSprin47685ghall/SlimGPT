import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToolKeyArg } from '../src/lib/tool-presentation.js';
import { renderContentReferences } from '../src/lib/content-references.js';
import { parseMarkdownDestination } from '../src/lib/incremental-markdown.js';

test('extractToolKeyArg unwraps JSON string function.arguments', () => {
  const payload = {
    function: {
      name: 'python',
      arguments: JSON.stringify({ code: 'print("hello world")' }),
    },
  };
  const result = extractToolKeyArg(payload);
  assert.equal(result, 'code: print("hello world")');
});

test('extractToolKeyArg unwraps calls[0].function.arguments', () => {
  const payload = {
    calls: [
      {
        function: {
          name: 'web_search',
          arguments: JSON.stringify({ query: 'svelte 5 runes tutorial' }),
        },
      },
    ],
  };
  const result = extractToolKeyArg(payload);
  assert.equal(result, 'query: svelte 5 runes tutorial');
});

test('extractToolKeyArg formats array values with comma separation', () => {
  const payload = {
    action: 'filter',
    queries: ['first', 'second', 'third'],
  };
  const result = extractToolKeyArg(payload);
  assert.equal(result, 'action: filter');

  const arrayPayload = {
    items: ['apple', 'banana', 'orange'],
  };
  const arrayResult = extractToolKeyArg(arrayPayload);
  assert.equal(arrayResult, 'items: apple, banana, orange');
});

test('extractToolKeyArg falls back to shortened callId instead of dumping raw call_ id', () => {
  const tool = {
    name: 'custom_tool',
    callId: 'call_9876543210abcdef9876543210',
    payload: {},
  };
  const result = extractToolKeyArg(tool.payload, tool);
  assert.equal(result, '…543210');
});

test('renderContentReferences supports withTitle flag and escapes title', () => {
  const marker = '\uE200cite\uE202t0s0\uE201';
  const metadata = {
    withTitle: true,
    content_references: [
      {
        matched_text: marker,
        items: [
          { title: 'Safe Article "Title" \\ Test', url: 'https://example.com/source' },
        ],
      },
    ],
  };
  const rendered = renderContentReferences(marker, metadata);
  assert.match(rendered, /\[来源 1\]\(https:\/\/example\.com\/source "Safe Article \\"Title\\" \\\\ Test"\)/);

  const parsed = parseMarkdownDestination('https://example.com/source "Safe Article \\"Title\\" \\\\ Test"');
  assert.equal(parsed.href, 'https://example.com/source');
  assert.equal(parsed.title, 'Safe Article "Title" \\ Test');
});
