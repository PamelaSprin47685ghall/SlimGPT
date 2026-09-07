import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSidebarTime, filterConversations } from '../src/lib/sidebar-helpers.js';
import { historySyncPillLabel } from '../src/lib/history-sync.js';
import { buildConversationMarkdown } from '../src/lib/export.js';

test('formatSidebarTime formats yesterday as 昨天', () => {
  const base = new Date('2026-09-08T12:00:00.000Z');
  const yesterdayNoon = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1, 12, 0, 0);
  assert.equal(formatSidebarTime(yesterdayNoon, base), '昨天');

  const yesterdayLate = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1, 23, 59, 59);
  assert.equal(formatSidebarTime(yesterdayLate, base), '昨天');

  const older = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 7, 12, 0, 0);
  assert.notEqual(formatSidebarTime(older, base), '昨天');
});

test('filterConversations whitespace token split matches title and snippet tokens', () => {
  const list = [
    { id: '1', title: 'React Hooks Guide', last: 'Understanding useEffect dependencies' },
    { id: '2', title: 'Vue Composition API', last: 'Migrating options to script setup' },
    { id: '3', title: 'Svelte Runes Tutorial', last: 'State and derived runes in Svelte 5' },
  ];

  // Multiple tokens across title and snippet
  const res1 = filterConversations(list, 'react useeffect');
  assert.equal(res1.total, 1);
  assert.equal(res1.visible[0].id, '1');

  // Order independent
  const res2 = filterConversations(list, 'dependencies hooks');
  assert.equal(res2.total, 1);
  assert.equal(res2.visible[0].id, '1');

  // Token mismatch
  const res3 = filterConversations(list, 'react vue');
  assert.equal(res3.total, 0);

  // Pagination limit increase
  const resLimit = filterConversations(list, '', 2);
  assert.equal(resLimit.total, 3);
  assert.equal(resLimit.visible.length, 2);
  assert.equal(resLimit.isCapped, true);
});

test('historySyncPillLabel returns concise pills for errors', () => {
  assert.equal(historySyncPillLabel({ state: 'error', status: 401 }), '需重新登录');
  assert.equal(historySyncPillLabel({ state: 'error', status: 403 }), '需重新登录');
  assert.equal(historySyncPillLabel({ state: 'error', status: 429 }), '请求受限');
  assert.equal(historySyncPillLabel({ state: 'error', code: 'backoff' }), '请求受限');
  assert.equal(historySyncPillLabel({ state: 'error', code: 'timeout' }), '同步超时');
  assert.equal(historySyncPillLabel({ state: 'error', status: 500 }), '服务异常');
  assert.equal(historySyncPillLabel({ state: 'loading' }), '正在同步…');
  assert.equal(historySyncPillLabel({ state: 'complete' }), '历史已同步');
});

test('buildConversationMarkdown includes model in footer, per-message timestamps, and branch provenance', () => {
  const md = buildConversationMarkdown('Branch Test', [
    {
      role: 'user',
      text: 'Question 1',
      createTime: '2026-09-08T10:00:00.000Z',
    },
    {
      role: 'assistant',
      text: 'Answer branch 1',
      model: 'gpt-5.4',
      createTime: 1788856200,
      siblingCount: 3,
      siblingIndex: 1,
    },
  ], {
    conversationId: 'conv-branch',
    model: 'gpt-5.4',
    historyComplete: true,
  });

  // Starts with title
  assert.ok(md.startsWith('# Branch Test\n'));
  // Per-message timestamp
  assert.ok(md.includes('> 时间：2026-09-08T10:00:00.000Z'));
  // Branch provenance
  assert.ok(md.includes('> 分支：第 2 / 3 个分支'));
  // Model in footer
  assert.match(md, /模型: gpt-5.4/);
  // Title stays first
  assert.ok(!md.startsWith('> 模型：'));
});
