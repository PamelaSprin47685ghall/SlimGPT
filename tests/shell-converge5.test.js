import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prioritizeBanners,
  isCompactLayout,
  getBannerActions,
  isPersistableBannerDismissal,
  loadDismissedNoticeIds,
  saveDismissedNoticeIds,
  DISMISSED_NOTICES_STORAGE_KEY,
} from '../src/lib/shell-helpers.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    _data: data,
  };
}

test('isCompactLayout collapses narrow windows regardless of pointer', () => {
  assert.equal(isCompactLayout({ width: 360 }), true);
  assert.equal(isCompactLayout({ width: 960 }), true);
  assert.equal(isCompactLayout({ width: 960, hasCoarsePointer: true, hasFinePointer: true }), true);
});

test('isCompactLayout keeps wide touchscreens in 3 panes unless coarse-only', () => {
  // iPad landscape / Surface / open foldables with coarse-only touch.
  assert.equal(isCompactLayout({ width: 1024, hasCoarsePointer: true }), true);
  assert.equal(isCompactLayout({ width: 1100, hasCoarsePointer: true }), true);
  assert.equal(isCompactLayout({ width: 1101, hasCoarsePointer: true }), false);
  // Hybrid (touch + mouse/trackpad reports fine) keeps desktop panes.
  assert.equal(isCompactLayout({ width: 1024, hasCoarsePointer: true, hasFinePointer: true }), false);
  // Plain desktop stays wide.
  assert.equal(isCompactLayout({ width: 1280 }), false);
  assert.equal(isCompactLayout({ width: 1280, hasFinePointer: true }), false);
});

test('getBannerActions mirrors the top-banner mapping for secondary banners', () => {
  assert.deepEqual(getBannerActions('bridge-error'), [{ key: 'open-official', label: '查看官方界面' }]);
  assert.deepEqual(getBannerActions('offline'), [
    { key: 'recheck', label: '重新检查连接' },
    { key: 'open-official', label: '查看官方界面' },
  ]);
  assert.deepEqual(getBannerActions('sync-error'), [{ key: 'retry-sync', label: '重试同步' }]);
  assert.deepEqual(getBannerActions('resync'), [{ key: 'retry-sync', label: '重试同步' }]);
  assert.deepEqual(getBannerActions(null), []);
  assert.deepEqual(getBannerActions({ actionKey: 'sync-error' }), [{ key: 'retry-sync', label: '重试同步' }]);
  // Every banner the helper emits stays actionable in HomePage secondary stacks.
  const banners = prioritizeBanners({ bridgeError: true, liveConnected: false, historySyncProblem: '同步超时' });
  for (const banner of banners.filter((b) => b.actionKey)) {
    assert.ok(getBannerActions(banner).length > 0, `${banner.id} must map to buttons`);
  }
});

test('error-level secondary keeps action mapping while native offline has none', () => {
  const banners = prioritizeBanners({ bridgeError: false, liveConnected: true, historySyncProblem: '断线', browserOffline: true });
  const syncError = banners.find((b) => b.id === 'sync-error');
  assert.equal(syncError.level, 'error');
  assert.deepEqual(getBannerActions(syncError), [{ key: 'retry-sync', label: '重试同步' }]);
  const nativeOffline = banners.find((b) => b.id === 'network-offline');
  assert.deepEqual(getBannerActions(nativeOffline), []);
});

test('browserOffline hint is lowest precedence and never overrides errors', () => {
  const banners = prioritizeBanners({ bridgeError: true, liveConnected: false, historySyncProblem: 'x', browserOffline: true });
  assert.deepEqual(banners.map((b) => b.id), ['bridge-error', 'sync-error', 'network-offline']);
  const clean = prioritizeBanners({ bridgeError: false, liveConnected: true, browserOffline: false });
  assert.ok(!clean.some((b) => b.id === 'network-offline'));
});

test('loadDismissedNoticeIds guards corrupt and foreign payloads', () => {
  assert.deepEqual([...loadDismissedNoticeIds(fakeStorage())], []);
  assert.deepEqual([...loadDismissedNoticeIds(fakeStorage({ [DISMISSED_NOTICES_STORAGE_KEY]: 'not-json{{{' }))], []);
  assert.deepEqual([...loadDismissedNoticeIds(fakeStorage({ [DISMISSED_NOTICES_STORAGE_KEY]: '{"a":1}' }))], []);
  assert.deepEqual(
    [...loadDismissedNoticeIds(fakeStorage({ [DISMISSED_NOTICES_STORAGE_KEY]: JSON.stringify(['a', 1, '', null, 'b']) }))],
    ['a', 'b'],
  );
  assert.deepEqual([...loadDismissedNoticeIds(null)], []);
  assert.deepEqual([...loadDismissedNoticeIds({ getItem: () => { throw new Error('denied'); } })], []);
});

test('saveDismissedNoticeIds round-trips string sets and never throws', () => {
  const storage = fakeStorage();
  saveDismissedNoticeIds(new Set(['history-pending']), storage);
  assert.deepEqual([...loadDismissedNoticeIds(storage)], ['history-pending']);
  saveDismissedNoticeIds(['a', 42, ''], storage);
  assert.deepEqual([...loadDismissedNoticeIds(storage)], ['a']);
  assert.doesNotThrow(() => saveDismissedNoticeIds(new Set(['x']), null));
  assert.doesNotThrow(() => saveDismissedNoticeIds(new Set(['x']), { setItem: () => { throw new Error('denied'); } }));
});

test('isPersistableBannerDismissal keeps notices, drops errors/warnings/offline', () => {
  assert.equal(isPersistableBannerDismissal('info'), true);
  assert.equal(isPersistableBannerDismissal('notice'), true);
  assert.equal(isPersistableBannerDismissal({ level: 'info' }), true);
  assert.equal(isPersistableBannerDismissal('error'), false);
  assert.equal(isPersistableBannerDismissal('warning'), false);
  assert.equal(isPersistableBannerDismissal('offline'), false);
  assert.equal(isPersistableBannerDismissal({ level: 'error' }), false);
  assert.equal(isPersistableBannerDismissal(null), false);
  assert.equal(isPersistableBannerDismissal(undefined), false);
});
