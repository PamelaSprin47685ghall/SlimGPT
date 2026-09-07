import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTimestamp, formatSidebarTime, fullSidebarDateTime, filterConversations } from '../src/lib/sidebar-helpers.js';
import { formatModelLabel } from '../src/lib/message-presentation.js';
import { buildConversationMarkdown } from '../src/lib/export.js';
import { historySyncStatusLabel } from '../src/lib/history-sync.js';

test('parseTimestamp parses ISO-8601, numeric epoch, and string epochs safely without bare Number() corruption', () => {
  assert.equal(parseTimestamp('not-a-date'), null);
  assert.equal(parseTimestamp(''), null);
  assert.equal(parseTimestamp(null), null);

  // ISO string
  const iso = parseTimestamp('2026-09-08T12:30:00.000Z');
  assert.ok(iso instanceof Date);
  assert.equal(iso.toISOString(), '2026-09-08T12:30:00.000Z');

  // Numeric epoch (seconds vs ms)
  const epochSec = parseTimestamp(1788856200);
  assert.equal(epochSec.getTime(), 1788856200000);

  const epochMs = parseTimestamp(1788856200000);
  assert.equal(epochMs.getTime(), 1788856200000);

  // String epoch
  const strSec = parseTimestamp('1788856200');
  assert.equal(strSec.getTime(), 1788856200000);
});

test('formatSidebarTime gives honest relative time <1h, HH:mm today, and month/day/weekday older', () => {
  const base = new Date('2026-09-08T12:00:00.000Z');

  // <1 min: 刚刚
  assert.equal(formatSidebarTime(new Date('2026-09-08T11:59:30.000Z'), base), '刚刚');

  // 15 min ago
  assert.equal(formatSidebarTime(new Date('2026-09-08T11:45:00.000Z'), base), '15分钟前');

  // Today but >1h: HH:mm
  const todayOlder = new Date('2026-09-08T08:15:00.000Z');
  const todayFormatted = formatSidebarTime(todayOlder, base);
  assert.match(todayFormatted, /^\d{2}:\d{2}$/);

  // Yesterday / older: month/day
  const lastWeek = new Date('2026-09-01T12:00:00.000Z');
  const olderFormatted = formatSidebarTime(lastWeek, base);
  assert.ok(olderFormatted.length > 0);
  assert.doesNotMatch(olderFormatted, /^\d{2}:\d{2}$/);
});

test('filterConversations matches both title and snippet preview, gates empty state by trimmed query, and caps rows', () => {
  const list = [
    { id: '1', title: 'Vue Migration', last: 'Migrating components' },
    { id: '2', title: 'React Hooks', last: 'Discussion about useEffect and state' },
    { id: '3', title: 'Rust Tooling', last: 'Cargo configuration details' },
  ];

  // Match title
  const res1 = filterConversations(list, 'vue');
  assert.equal(res1.total, 1);
  assert.equal(res1.visible[0].id, '1');

  // Match snippet preview
  const res2 = filterConversations(list, 'useEffect');
  assert.equal(res2.total, 1);
  assert.equal(res2.visible[0].id, '2');

  // Trimmed empty query
  const resEmpty = filterConversations(list, '   ');
  assert.equal(resEmpty.needle, '');
  assert.equal(resEmpty.total, 3);

  // Cap rows (~100 limit)
  const bigList = Array.from({ length: 150 }, (_, i) => ({ id: `c-${i}`, title: `Item ${i}`, last: `Snippet ${i}` }));
  const resCap = filterConversations(bigList, '', 100);
  assert.equal(resCap.total, 150);
  assert.equal(resCap.visible.length, 100);
  assert.equal(resCap.isCapped, true);
});

test('formatModelLabel hides unknown / Web / Mobile and cleanly formats o1/o3 and custom GPT slugs', () => {
  assert.equal(formatModelLabel(''), '');
  assert.equal(formatModelLabel(null), '');
  assert.equal(formatModelLabel('Web'), '');
  assert.equal(formatModelLabel('Mobile'), '');
  assert.equal(formatModelLabel('o1'), 'o1');
  assert.equal(formatModelLabel('o1-preview'), 'o1-preview');
  assert.equal(formatModelLabel('o3-mini'), 'o3-mini');
  assert.equal(formatModelLabel('o3-pro'), 'o3-pro');
  assert.equal(formatModelLabel('g-23423423-python-tutor'), 'GPT · python tutor');
  assert.equal(formatModelLabel('gizmo-code-helper'), 'GPT · code helper');
  assert.equal(formatModelLabel('gpt-5.4'), 'GPT-5.4');
});

test('historySyncStatusLabel reports loading, complete, and classify failures', () => {
  assert.equal(historySyncStatusLabel({ state: 'loading' }), '正在同步历史…');
  assert.equal(historySyncStatusLabel({ state: 'complete' }), '历史已同步');
  assert.match(historySyncStatusLabel({ state: 'error', status: 429 }), /受限/);
  assert.equal(historySyncStatusLabel(null, 'transaction-error'), '分页缺失');
});

test('buildConversationMarkdown includes frontmatter and tags assistant model', () => {
  const md = buildConversationMarkdown('Title', [
    { role: 'user', text: 'Hello' },
    { role: 'assistant', text: 'World', model: 'o3-mini' },
  ], {
    conversationId: 'c-test',
    createTime: '2026-09-08T00:00:00Z',
    historyComplete: false,
  });

  assert.match(md, /---/);
  assert.match(md, /会话标识: c-test/);
  assert.match(md, /历史状态: 局部不完整/);
  assert.match(md, /> 模型：o3-mini/);
});
