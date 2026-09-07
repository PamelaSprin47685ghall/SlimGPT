import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupConversations,
  filterConversations,
  highlightTitle,
  isContentHit,
} from '../src/lib/sidebar-helpers.js';
import {
  buildConversationMarkdown,
  buildTurnMarkdown,
} from '../src/lib/export.js';

test('groupConversations buckets items into 今天/昨天/近7天/更早', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');
  const conversations = [
    { id: '1', title: 'Today item', update_time: '2026-09-08T10:00:00.000Z' },
    { id: '2', title: 'Yesterday item', update_time: '2026-09-07T15:00:00.000Z' },
    { id: '3', title: '3 days ago item', update_time: '2026-09-05T12:00:00.000Z' },
    { id: '4', title: 'Old item', update_time: '2026-08-01T12:00:00.000Z' },
    { id: '5', title: 'No timestamp item' },
  ];

  const groups = groupConversations(conversations, now);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].label, '今天');
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[0].items[0].id, '1');

  assert.equal(groups[1].label, '昨天');
  assert.equal(groups[1].items.length, 1);
  assert.equal(groups[1].items[0].id, '2');

  assert.equal(groups[2].label, '近7天');
  assert.equal(groups[2].items.length, 1);
  assert.equal(groups[2].items[0].id, '3');

  assert.equal(groups[3].label, '更早');
  assert.equal(groups[3].items.length, 2);
  assert.equal(groups[3].items[0].id, '4');
  assert.equal(groups[3].items[1].id, '5');
});

test('filterConversations matches cached corpus searchText and isContentHit detects it', () => {
  const conversations = [
    { id: '1', title: 'Quick Sort', last: 'Partition algorithm', searchText: 'in-place divide and conquer' },
    { id: '2', title: 'Merge Sort', last: 'Recursion', searchText: 'stable sorting algorithm' },
  ];

  const res = filterConversations(conversations, 'conquer');
  assert.equal(res.total, 1);
  assert.equal(res.visible[0].id, '1');
  assert.equal(isContentHit(res.visible[0], 'conquer'), true);
  assert.equal(isContentHit(conversations[1], 'conquer'), false);

  // highlightTitle
  const parts = highlightTitle('Quick Sort Algorithm', 'sort');
  assert.deepEqual(parts, [
    { text: 'Quick ', mark: false },
    { text: 'Sort', mark: true },
    { text: ' Algorithm', mark: false },
  ]);
});

test('buildTurnMarkdown exports turn and respects opts', () => {
  const turn = {
    user: { role: 'user', text: 'Explain CORS' },
    replies: [
      { role: 'assistant', thought: 'Cross origin resource sharing...', text: 'CORS is a security mechanism.' },
      { role: 'tool', tool: { kind: 'tool-call', name: 'search', payload: { q: 'cors' } } },
    ],
  };

  // Default FULL
  const fullMd = buildTurnMarkdown(turn);
  assert.ok(fullMd.includes('## 你\n\nExplain CORS'));
  assert.ok(fullMd.includes('### 思考过程\n\nCross origin resource sharing...'));
  assert.ok(fullMd.includes('CORS is a security mechanism.'));
  assert.ok(fullMd.includes('工具调用 · search'));

  // Pure Q&A (no thought, no tools)
  const cleanMd = buildTurnMarkdown(turn, { includeThought: false, includeTools: false });
  assert.ok(cleanMd.includes('## 你\n\nExplain CORS'));
  assert.ok(!cleanMd.includes('思考过程'));
  assert.ok(cleanMd.includes('CORS is a security mechanism.'));
  assert.ok(!cleanMd.includes('工具调用'));
});

test('buildConversationMarkdown opts defaults to full and allows pure Q&A', () => {
  const messages = [
    { role: 'user', text: 'Hi' },
    { role: 'assistant', thought: 'thinking...', text: 'Hello', model: 'gpt-5.4' },
    { role: 'tool', tool: { kind: 'tool-call', name: 'test-tool', payload: {} } },
  ];

  const full = buildConversationMarkdown('Test', messages);
  assert.ok(full.includes('思考过程'));
  assert.ok(full.includes('工具调用'));

  const clean = buildConversationMarkdown('Test', messages, { includeThought: false, includeTools: false });
  assert.ok(!clean.includes('思考过程'));
  assert.ok(!clean.includes('工具调用'));
  assert.ok(clean.includes('Hello'));
});
