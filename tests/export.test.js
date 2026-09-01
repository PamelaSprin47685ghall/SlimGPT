import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationMarkdown, markdownFilename } from '../src/lib/export.js';

test('markdown export includes the full current conversation and preserves markdown', () => {
  const output = buildConversationMarkdown('测试会话', [
    { role: 'user', text: '请给我一个表格' },
    { role: 'assistant', text: '| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log("ok")\n```' },
  ]);

  assert.equal(output, '# 测试会话\n\n## 你\n\n请给我一个表格\n\n## ChatGPT\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconsole.log("ok")\n```\n');
});

test('markdown export filenames are filesystem-safe and keep CJK titles', () => {
  assert.equal(markdownFilename('  项目 / 计划: 2026?  '), '项目 计划 2026.md');
  assert.equal(markdownFilename(''), 'slimgpt-conversation.md');
});
