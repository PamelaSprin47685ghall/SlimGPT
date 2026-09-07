import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationMarkdown, markdownFilename } from '../src/lib/export.js';

test('export retains reasoning, tool calls, tool results and final answer as separate items', () => {
  const output = buildConversationMarkdown('Complete turn', [
    { role: 'user', text: 'question' },
    { role: 'assistant', thought: 'reasoning only', text: '' },
    { role: 'assistant', text: '', tool: { kind: 'tool-call', name: 'web.run', callId: 'c1', payload: '{"q":"中文"}' } },
    { role: 'tool', text: 'duplicate preview', tool: { kind: 'tool-result', name: 'web.run', toolCallId: 'c1', payload: { rows: ['result'] } } },
    { role: 'assistant', text: 'final answer' },
  ]);
  assert.match(output, /reasoning only/);
  assert.match(output, /工具调用.*web\.run/);
  assert.match(output, /工具结果.*web\.run/);
  assert.match(output, /"q":"中文"/);
  assert.match(output, /"rows":/);
  assert.match(output, /c1/);
  assert.equal(output.includes('duplicate preview'), false, 'tool payload must not also be exported as its lossy preview');
  assert.ok(output.indexOf('reasoning only') < output.indexOf('工具调用'));
  assert.ok(output.indexOf('工具结果') < output.indexOf('final answer'));
});

test('export keeps source whitespace, including Markdown hard line breaks and indented code', () => {
  const text = '    print("indented")\n\nline with break  \n';
  const output = buildConversationMarkdown('Whitespace', [{ role: 'assistant', text }]);
  assert.ok(output.includes(`## ChatGPT\n\n${text}`));
});

test('tool payloads containing Markdown fences cannot terminate their enclosing export block', () => {
  const payload = '  ```\n# quoted content\n````\ntrailing  \n';
  const output = buildConversationMarkdown('Tools', [{ role: 'tool', tool: { kind: 'tool-result', name: 'read', payload } }]);
  assert.ok(output.includes(payload));
  assert.match(output, /`{5,}text\n/);
  assert.ok(output.includes(`${payload}\n`));
});

test('error and unsupported-content items are not silently missing from exports', () => {
  const output = buildConversationMarkdown('Incomplete', [
    { id: 'failed', role: 'assistant', text: '', error: true, status: 'failed' },
    { id: 'unknown', role: 'assistant', text: '', unrecognized: true, contentType: 'future_card' },
  ]);
  assert.match(output, /生成异常/);
  assert.match(output, /future\\?_card/);
});

test('export headings cannot be injected by conversation titles or tool names', () => {
  const output = buildConversationMarkdown('Title\n\n# Spoof', [{ role: 'tool', name: 'name\n# forged', text: 'body' }]);
  assert.equal(output.includes('\n# Spoof'), false);
  assert.equal(output.includes('\n# forged'), false);
});

test('filenames avoid platform-reserved names and do not split a surrogate pair', () => {
  for (const name of ['CON', 'aux', 'NUL', 'COM1', 'LPT9']) assert.notEqual(markdownFilename(name).toUpperCase(), `${name}.MD`.toUpperCase());
  assert.equal(markdownFilename('a'.repeat(119) + '🧪').includes('\ud83e.md'), false);
});

test('partial history and unresolved groups are explicitly separated from the previous answer', () => {
  const output = buildConversationMarkdown('Partial', [{ role: 'user', text: 'known question' }], {
    historyComplete: false,
    unresolved: [{ replies: [{ role: 'assistant', text: 'unbound response' }] }, { replies: [{ role: 'tool', tool: { kind: 'tool-result', payload: 'unbound tool' } }] }],
  });
  assert.match(output, /不是完整会话/);
  assert.match(output, /## 未归属输出/);
  assert.ok(output.indexOf('## 未归属输出') > output.indexOf('known question'));
  assert.ok(output.indexOf('unbound response') < output.indexOf('未归属组 2'));
  assert.match(output, /unbound tool/);
});

test('pending drafts do not leak into exports and redacted cache payloads are labelled', () => {
  const output = buildConversationMarkdown('Saved', [
    { role: 'user', pending: true, text: 'UNSENT_DRAFT' },
    { role: 'tool', cacheRedacted: true, tool: { kind: 'tool-result', payload: { value: 1 } } },
  ]);
  assert.equal(output.includes('UNSENT_DRAFT'), false);
  assert.match(output, /凭据字段已省略/);
});
