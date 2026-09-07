import test from 'node:test';
import assert from 'node:assert/strict';
import { prioritizeBanners } from '../src/lib/shell-helpers.js';

test('prioritizeBanners keeps sync-error ahead of cache/partial notice', () => {
  const banners = prioritizeBanners({
    bridgeError: false,
    liveConnected: true,
    historySyncProblem: '同步超时',
    cacheNotice: 'read-failed',
  });
  assert.equal(banners[0].id, 'sync-error');
  assert.equal(banners[0].level, 'error');
  assert.equal(banners[1].id, 'cache-notice');
});

test('prioritizeBanners hides dismissed notice-level banners with session memory', () => {
  const banners = prioritizeBanners({
    bridgeError: false,
    liveConnected: true,
    historySyncProblem: '同步超时',
    cacheNotice: 'read-failed',
    dismissedBannerIds: new Set(['cache-notice']),
  });
  assert.ok(banners.some((banner) => banner.id === 'sync-error'));
  assert.ok(!banners.some((banner) => banner.id === 'cache-notice'));
});

test('prioritizeBanners never dismisses error-level banners', () => {
  const banners = prioritizeBanners({
    bridgeError: false,
    liveConnected: true,
    historySyncProblem: '同步超时',
    dismissedBannerIds: new Set(['sync-error']),
  });
  assert.ok(banners.some((banner) => banner.id === 'sync-error'));
});

test('prioritizeBanners without dismissedBannerIds keeps default order', () => {
  const banners = prioritizeBanners({
    bridgeError: false,
    liveConnected: false,
    historySyncProblem: '同步错误',
  });
  assert.deepEqual(banners.map((banner) => banner.id), ['offline', 'sync-error']);
});
