import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterConversations,
  groupConversations,
  highlightTitle,
  isContentHit,
  buildTruncationLabel,
  getPinnedIds,
  savePinnedIds,
  togglePinnedId,
} from '../src/lib/sidebar-helpers.js';

test('buildTruncationLabel formats truncation and full counts cleanly', () => {
  assert.equal(buildTruncationLabel(0, 0), '共 0 个会话');
  assert.equal(buildTruncationLabel(42, 42), '共 42 个会话');
  assert.equal(buildTruncationLabel(120, 100), '共 120 个会话 · 显示前 100 个');
  assert.equal(buildTruncationLabel(250, 150), '共 250 个会话 · 显示前 150 个');
  assert.equal(buildTruncationLabel(null, 10), '共 0 个会话');
  assert.equal(buildTruncationLabel(-5, 0), '共 0 个会话');
});

test('pin store guards: getPinnedIds, savePinnedIds, togglePinnedId handle invalid storage and corrupted payloads', () => {
  // Missing storage
  assert.deepEqual(getPinnedIds(null), []);
  savePinnedIds(['a'], null); // no throw
  assert.deepEqual(togglePinnedId('a', null), []);
  assert.deepEqual(togglePinnedId('', null), []);
  assert.deepEqual(togglePinnedId(null, null), []);

  // Mock storage
  const store = {
    data: {},
    getItem(key) { return this.data[key] ?? null; },
    setItem(key, value) { this.data[key] = String(value); },
  };

  // Initially empty
  assert.deepEqual(getPinnedIds(store), []);

  // Save valid array
  savePinnedIds(['c1', 'c2'], store);
  assert.deepEqual(getPinnedIds(store), ['c1', 'c2']);

  // Filter out non-strings or blanks
  savePinnedIds(['c1', 123, null, '', '  ', 'c3'], store);
  assert.deepEqual(getPinnedIds(store), ['c1', 'c3']);

  // Corrupt storage payload
  store.setItem('slimgpt:pinned-conversations', '{ invalid json');
  assert.deepEqual(getPinnedIds(store), []);

  store.setItem('slimgpt:pinned-conversations', '{"not":"an array"}');
  assert.deepEqual(getPinnedIds(store), []);

  // Toggle pinning
  store.data = {};
  const t1 = togglePinnedId('conv-1', store);
  assert.deepEqual(t1, ['conv-1']);
  assert.deepEqual(getPinnedIds(store), ['conv-1']);

  const t2 = togglePinnedId('conv-2', store);
  assert.deepEqual(t2, ['conv-1', 'conv-2']);

  // Toggle off conv-1
  const t3 = togglePinnedId('conv-1', store);
  assert.deepEqual(t3, ['conv-2']);
  assert.deepEqual(getPinnedIds(store), ['conv-2']);
});

test('filterConversations token parsing includes is:pinned and text tokens', () => {
  const conversations = [
    { id: 'c1', title: 'React Guide', last: 'Frontend', searchText: 'hooks and state' },
    { id: 'c2', title: 'Svelte 5 Runes', last: 'Frontend', searchText: 'signals and props' },
    { id: 'c3', title: 'Rust Systems', last: 'Backend', searchText: 'memory safety' },
  ];
  const pinnedIds = ['c2', 'c3'];

  // Plain query
  const res1 = filterConversations(conversations, 'frontend', 100, pinnedIds);
  assert.equal(res1.total, 2);
  assert.equal(res1.filterPinnedOnly, false);
  assert.deepEqual(res1.queryTokens, ['frontend']);

  // is:pinned alone
  const res2 = filterConversations(conversations, 'is:pinned', 100, pinnedIds);
  assert.equal(res2.total, 2);
  assert.equal(res2.filterPinnedOnly, true);
  assert.deepEqual(res2.visible.map((x) => x.id), ['c2', 'c3']);

  // is:pinned with token matching pinned item
  const res3 = filterConversations(conversations, 'is:pinned svelte', 100, pinnedIds);
  assert.equal(res3.total, 1);
  assert.equal(res3.visible[0].id, 'c2');

  // is:pinned with token matching unpinned item only
  const res4 = filterConversations(conversations, 'is:pinned react', 100, pinnedIds);
  assert.equal(res4.total, 0);

  // Case insensitivity of is:pinned token
  const res5 = filterConversations(conversations, 'IS:PINNED runes', 100, pinnedIds);
  assert.equal(res5.total, 1);
  assert.equal(res5.visible[0].id, 'c2');
});

test('groupConversations separates pinned group above time buckets', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');
  const conversations = [
    { id: 'c1', title: 'Today item', update_time: '2026-09-08T10:00:00.000Z' },
    { id: 'c2', title: 'Yesterday item', update_time: '2026-09-07T15:00:00.000Z' },
    { id: 'c3', title: 'Old item', update_time: '2026-08-01T12:00:00.000Z' },
  ];

  // Without pins
  const gNoPin = groupConversations(conversations, now, []);
  assert.equal(gNoPin[0].key, 'today');
  assert.equal(gNoPin[0].label, '今天');
  assert.equal(gNoPin.find((g) => g.key === 'pinned'), undefined);

  // With c3 pinned: c3 is placed in 'pinned' group regardless of its timestamp
  const gWithPin = groupConversations(conversations, now, ['c3']);
  assert.equal(gWithPin.length, 3);
  assert.equal(gWithPin[0].key, 'pinned');
  assert.equal(gWithPin[0].label, '置顶');
  assert.equal(gWithPin[0].items.length, 1);
  assert.equal(gWithPin[0].items[0].id, 'c3');

  // c3 is not duplicated in 'earlier'
  const earlierGroup = gWithPin.find((g) => g.key === 'earlier');
  assert.equal(earlierGroup, undefined); // was only c3, now empty so filtered out
});

test('highlightTitle and isContentHit ignore is:pinned token', () => {
  const parts = highlightTitle('Svelte 5 Runes', 'is:pinned runes');
  assert.deepEqual(parts, [
    { text: 'Svelte 5 ', mark: false },
    { text: 'Runes', mark: true },
  ]);

  const onlyTokenParts = highlightTitle('Svelte 5 Runes', 'is:pinned');
  assert.deepEqual(onlyTokenParts, [
    { text: 'Svelte 5 Runes', mark: false },
  ]);

  assert.equal(isContentHit({ searchText: 'signals and runes' }, 'is:pinned runes'), true);
  assert.equal(isContentHit({ searchText: 'signals and runes' }, 'is:pinned'), false);
});
