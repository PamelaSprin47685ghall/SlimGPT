import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prioritizeBanners,
  createStalenessTracker,
  trapModalKeydown,
  getScrimAriaLabel,
} from '../src/lib/shell-helpers.js';

test('prioritizeBanners enforces bridgeError > offline > sync error > cache/partial notice', () => {
  // All present: bridgeError is top
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

  // Offline without bridgeError
  const offlineBanners = prioritizeBanners({
    bridgeError: false,
    liveConnected: false,
    historySyncProblem: '同步错误',
  });
  assert.equal(offlineBanners[0].id, 'offline');
  assert.equal(offlineBanners[1].id, 'sync-error');

  // Connected with sync error only
  const syncOnly = prioritizeBanners({
    bridgeError: false,
    liveConnected: true,
    historySyncProblem: '网络中断',
  });
  assert.equal(syncOnly.length, 1);
  assert.equal(syncOnly[0].id, 'sync-error');

  // Connected with cache notice
  const cacheOnly = prioritizeBanners({
    bridgeError: false,
    liveConnected: true,
    cacheNotice: 'read-failed',
  });
  assert.equal(cacheOnly.length, 1);
  assert.equal(cacheOnly[0].id, 'cache-notice');
  assert.equal(cacheOnly[0].level, 'warning');

  // Clean state
  const clean = prioritizeBanners({
    bridgeError: false,
    liveConnected: true,
  });
  assert.equal(clean.length, 0);
});

test('createStalenessTracker resets timer on each message and calls onStale once', (t, done) => {
  let staleCalled = 0;
  const tracker = createStalenessTracker({
    timeoutMs: 50,
    onStale: () => {
      staleCalled += 1;
      assert.equal(staleCalled, 1);
      assert.equal(tracker.isStale(), true);
      tracker.clear();
      done();
    },
  });

  assert.equal(tracker.isStale(), false);
  tracker.reset();

  // Reset before 50ms should defer execution
  setTimeout(() => {
    assert.equal(staleCalled, 0);
    tracker.reset();
  }, 25);
});

test('createStalenessTracker clear cancels pending timeout', (t, done) => {
  let staleCalled = 0;
  const tracker = createStalenessTracker({
    timeoutMs: 30,
    onStale: () => {
      staleCalled += 1;
    },
  });
  tracker.reset();
  tracker.clear();

  setTimeout(() => {
    assert.equal(staleCalled, 0);
    assert.equal(tracker.isStale(), false);
    done();
  }, 50);
});

test('getScrimAriaLabel provides distinct accessible names per drawer', () => {
  assert.equal(getScrimAriaLabel('sidebar'), '关闭会话侧栏');
  assert.equal(getScrimAriaLabel('overview'), '关闭消息概览');
  assert.equal(getScrimAriaLabel('none'), '关闭会话侧栏');
});

test('trapModalKeydown calls onClose on Escape', () => {
  let closed = false;
  const mockModal = {
    querySelectorAll: () => [],
    contains: () => true,
  };
  let prevented = false;
  let stopped = false;
  const event = {
    key: 'Escape',
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  };

  trapModalKeydown(event, mockModal, () => { closed = true; });
  assert.equal(closed, true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test('trapModalKeydown cycles focus between first and last elements', () => {
  let focusedIndex = -1;
  const el1 = { offsetParent: {}, focus: () => { focusedIndex = 0; } };
  const el2 = { offsetParent: {}, focus: () => { focusedIndex = 1; } };
  const mockModal = {
    querySelectorAll: () => [el1, el2],
    contains: (el) => el === el1 || el === el2,
  };

  // Tab forwards from last element
  globalThis.document = { activeElement: el2 };
  let prevented = false;
  trapModalKeydown({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } }, mockModal);
  assert.equal(prevented, true);
  assert.equal(focusedIndex, 0);

  // Tab backwards from first element
  globalThis.document = { activeElement: el1 };
  prevented = false;
  trapModalKeydown({ key: 'Tab', shiftKey: true, preventDefault: () => { prevented = true; } }, mockModal);
  assert.equal(prevented, true);
  assert.equal(focusedIndex, 1);
});
