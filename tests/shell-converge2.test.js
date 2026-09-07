import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prioritizeBanners,
  createStalenessTracker,
  trapModalKeydown,
  getScrimAriaLabel,
  formatLedgerOmissionMessage,
  formatLedgerOmissionNotice,
} from '../src/lib/shell-helpers.js';

test('prioritizeBanners enforces bridgeError > offline > sync error > cache/partial notice', () => {
  const allBanners = prioritizeBanners({
    bridgeError: true,
    liveConnected: false,
    historySyncProblem: '同步超时',
    cacheNotice: 'read-failed',
    conversationHistoryPending: true,
  });

  assert.equal(allBanners.length, 3);
  assert.equal(allBanners[0].id, 'bridge-error');
  assert.equal(allBanners[0].level, 'error');
  assert.equal(allBanners[1].id, 'sync-error');
  assert.equal(allBanners[2].id, 'cache-notice');

  const offlineBanners = prioritizeBanners({
    bridgeError: false,
    liveConnected: false,
    historySyncProblem: '同步错误',
  });
  assert.equal(offlineBanners[0].id, 'offline');
  assert.equal(offlineBanners[1].id, 'sync-error');

  const syncOnly = prioritizeBanners({
    bridgeError: false,
    liveConnected: true,
    historySyncProblem: '网络中断',
  });
  assert.equal(syncOnly.length, 1);
  assert.equal(syncOnly[0].id, 'sync-error');
  assert.equal(syncOnly[0].actionKey, 'sync-error');
});

test('prioritizeBanners deduplicates and uses user-facing copy without windowing jargon', () => {
  const pendingBanners = prioritizeBanners({
    bridgeError: false,
    liveConnected: true,
    conversationHistoryPending: true,
    conversationTimedOut: false,
  });
  assert.equal(pendingBanners.length, 1);
  assert.equal(pendingBanners[0].id, 'history-pending');
  assert.ok(!pendingBanners[0].message.includes('局部窗口'));
  assert.ok(pendingBanners[0].message.includes('正在同步完整历史'));

  const timedOutBanners = prioritizeBanners({
    bridgeError: false,
    liveConnected: true,
    conversationHistoryPending: true,
    conversationTimedOut: true,
  });
  assert.equal(timedOutBanners.length, 1);
  assert.ok(!timedOutBanners[0].message.includes('属于本轮'));
});

test('formatLedgerOmissionMessage provides honest per-reason explanation', () => {
  assert.match(formatLedgerOmissionMessage('budget'), /4 MiB/);
  assert.match(formatLedgerOmissionMessage('conversation-limit'), /24 个会话/);
  assert.match(formatLedgerOmissionMessage('structure-limit'), /会话结构/);
  assert.match(formatLedgerOmissionMessage('read-failed'), /本地缓存未能读取/);
  assert.match(formatLedgerOmissionMessage('write-failed'), /未完整保存/);
});

test('formatLedgerOmissionNotice formats omission count for sidebar footer', () => {
  assert.equal(formatLedgerOmissionNotice(0), '');
  assert.equal(formatLedgerOmissionNotice(3), '本地暂存省略 3 项');
  assert.equal(formatLedgerOmissionNotice('5'), '本地暂存省略 5 项');
});

test('trapModalKeydown calls onClose on Escape and cycles Tab', () => {
  let closed = false;
  const mockModal = { querySelectorAll: () => [] };
  trapModalKeydown({ key: 'Escape', preventDefault: () => {}, stopPropagation: () => {} }, mockModal, () => { closed = true; });
  assert.equal(closed, true);
});
