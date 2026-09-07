import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationMarkdown, markdownFilename } from '../src/lib/export.js';

test('markdown export includes the full current conversation and preserves markdown', () => {
  const output = buildConversationMarkdown('测试会话', [
    { role: 'user', text: '请给我一个表格' },
    { role: 'assistant', text: '| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log("ok")\n```' },
  ]);

  assert.ok(output.startsWith('# 测试会话\n\n## 你\n\n请给我一个表格\n\n## ChatGPT\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log("ok")\n```\n'));
  assert.match(output, /\n---\n导出时间: \S+\n---\n?$/);
});

test('markdown export footer carries provenance and partial-history warning', () => {
  const output = buildConversationMarkdown('Partial', [{ role: 'assistant', text: 'Hi', model: 'gpt-5.4' }], {
    conversationId: 'conv-123',
    createTime: '2026-09-01T10:00:00Z',
    updateTime: '2026-09-02T10:00:00Z',
    historyComplete: false,
});
  assert.ok(output.startsWith('# Partial\n\n> 历史尚未同步完整'));
  assert.ok(output.includes('## ChatGPT\n\n> 模型：gpt-5.4\n\nHi'));
  assert.match(output, /会话标识: conv-123/);
  assert.match(output, /创建时间: 2026-09-01T10:00:00Z/);
  assert.match(output, /更新时间: 2026-09-02T10:00:00Z/);
  assert.match(output, /历史状态: 局部不完整/);
});
test('markdown export filenames are filesystem-safe and keep CJK titles', () => {
  assert.equal(markdownFilename('  项目 / 计划: 2026?  '), '项目 计划 2026.md');
  assert.equal(markdownFilename(''), 'slimgpt-conversation.md');
});
