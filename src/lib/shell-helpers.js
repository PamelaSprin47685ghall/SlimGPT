/**
 * Shell, mobile layout, and accessibility helpers for SlimGPT UX convergence.
 */

/**
 * Computes and prioritizes banners for the message stage.
 * Precedence: Bridge Error > Offline > Sync Error > Cache / Partial Notice.
 */
export function prioritizeBanners({
  bridgeError = false,
  liveConnected = false,
  historySyncProblem = null,
  cacheNotice = null,
  currentHistorySyncState = null,
  canonicalSyncError = null,
  conversationHistoryPending = false,
  conversationBlockingLoad = false,
  conversationTimedOut = false,
  dismissedBannerIds = null,
  browserOffline = false,
} = {}) {
  const banners = [];

  // Priority 1: Bridge Connection Error
  if (bridgeError) {
    banners.push({
      id: 'bridge-error',
      priority: 1,
      level: 'error',
      title: 'ChatGPT 页面连接失败',
      message: '桥接脚本未就绪或被官方界面拦截；请检查官方页面是否正常登录或刷新页面重试。',
      actionKey: 'bridge-error',
    });
  } else if (!liveConnected) {
    // Priority: Offline / Not Taken Over
    banners.push({
      id: 'offline',
      priority: 2,
      level: 'offline',
      title: '未接管官方界面',
      message: '当前正连接 ChatGPT 页面，或者官方界面正处于活动状态。',
      actionKey: 'offline',
    });
  }

  // Priority 3: Sync error (outranks cache/partial notice)
  if (historySyncProblem) {
    banners.push({
      id: 'sync-error',
      priority: 3,
      level: 'error',
      title: '完整历史同步失败',
      message: String(historySyncProblem),
      actionKey: 'sync-error',
    });
  }

  // Priority 4: Cache or Partial synchronization notice
  if (cacheNotice) {
    banners.push({
      id: 'cache-notice',
      priority: 4,
      level: 'warning',
      title: '本地缓存提示',
      message: formatLedgerOmissionMessage(cacheNotice),
      actionKey: null,
    });
  } else if (currentHistorySyncState?.state === 'loading' && canonicalSyncError) {
    banners.push({
      id: 'sync-reloading',
      priority: 4,
      level: 'info',
      title: '历史重新同步中',
      message: '正在重新读取完整历史，已有内容保持不变。',
      actionKey: null,
    });
  } else if (conversationHistoryPending && !conversationBlockingLoad) {
    banners.push({
      id: 'history-pending',
      priority: 4,
      level: 'info',
      title: '历史补齐中',
      message: conversationTimedOut
        ? '完整历史暂未完全同步；当前仅显示已确认的最新实时内容。'
        : '正在同步完整历史；当前已有内容不会被当作会话开头。',
      actionKey: 'resync',
    });
  }

  // Priority 5: native browser offline hint. Lowest precedence: it never
  // overrides bridge-error / sync-error, and auto-clears when the browser
  // goes back online (browserOffline flips false). Always shown while offline.
  if (browserOffline) {
    banners.push({
      id: 'network-offline',
      priority: 5,
      level: 'offline',
      title: '网络已断开',
      message: '浏览器处于离线状态，请检查网络连接；网络恢复后此提醒会自动消失。',
      actionKey: null,
    });
  }
  // Session-memory dismissal: notice-level (non-error) banners the user closed
  // stay hidden; error-level banners (bridge-error, sync-error) are never dismissed.
  if (dismissedBannerIds?.size) {
    return banners.filter((banner) => banner.level === 'error' || banner.id === 'network-offline' || !dismissedBannerIds.has(banner.id));
  }
  return banners;
}

/**
 * Returns human-readable explanation for ledger omission reasons.
 */
export function formatLedgerOmissionMessage(reason) {
  if (reason === 'read-failed') {
    return '本地缓存未能读取；请等待完整历史同步，当前取得的内容仍可导出。';
  }
  if (reason === 'budget') {
    return '本会话数据量超过本地暂存上限（4 MiB），未写入本地缓存；当前页面内容完整无损，可随时导出。';
  }
  if (reason === 'conversation-limit') {
    return '本地暂存的会话数量已达上限（最多保留 24 个会话），早期会话已让位；当前页面内容未受裁剪。';
  }
  if (reason === 'structure-limit') {
    return '会话结构超出本地暂存限制，已跳过本地缓存；当前页面内容保持完整，可先导出。';
  }
  if (reason === 'write-failed') {
    return '本会话的本地输出缓存未完整保存；当前页面内容未被裁剪。刷新后需要重新同步历史，尚未同步的内容可先导出。';
  }
  return '本会话的本地输出缓存未完整保存；当前页面内容未被裁剪。刷新后需要重新同步历史，尚未同步的内容可先导出。';
}

/**
 * Formats ledger omission count for the sidebar footer contract.
 */
export function formatLedgerOmissionNotice(omissionCount) {
  const count = Number(omissionCount) || 0;
  if (count <= 0) return '';
  return `本地暂存省略 ${count} 项`;
}

/**
 * Creates a single-timer staleness watchdog for bridge status messages.
 * No polling loops or intervals. Calling reset() clears and schedules a single timeout.
 */
export function createStalenessTracker({ onStale, timeoutMs = 90_000 } = {}) {
  let timer = null;
  let stale = false;

  function reset() {
    stale = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (timeoutMs > 0 && typeof onStale === 'function') {
      timer = setTimeout(() => {
        stale = true;
        timer = null;
        onStale();
      }, timeoutMs);
    }
  }

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    stale = false;
  }

  function isStale() {
    return stale;
  }

  return { reset, clear, isStale };
}

/**
 * Modal focus trap handler for Tab and Escape keys.
 */
export function trapModalKeydown(event, modalElement, onClose) {
  if (!modalElement) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onClose?.();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusables = Array.from(
    modalElement.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0);

  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (event.shiftKey) {
    if (document.activeElement === first || !modalElement.contains(document.activeElement)) {
      event.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last || !modalElement.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }
}

/**
 * Returns dynamic accessible name for the mobile scrim button.
 */
/** localStorage key for notice-level dismissed banner ids (string set). */
export const DISMISSED_NOTICES_STORAGE_KEY = 'slimgpt:dismissed-notices';

/** Banner levels whose dismissals must never persist (always resurface). */
const NON_PERSISTED_DISMISSAL_LEVELS = new Set(['error', 'warning', 'offline']);

/** True when a dismissal may persist. Only notice-level (info/notice) persists. */
export function isPersistableBannerDismissal(bannerOrLevel) {
  const level = typeof bannerOrLevel === 'string' ? bannerOrLevel : bannerOrLevel && bannerOrLevel.level;
  if (typeof level !== 'string' || level.length === 0) return false;
  return !NON_PERSISTED_DISMISSAL_LEVELS.has(level);
}
/** Persists notice ids as JSON array. Denied storage never throws. */
export function saveDismissedNoticeIds(ids, storage) {
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!store || !store.setItem) return;
  try {
    const list = ids instanceof Set ? [...ids] : (Array.isArray(ids) ? ids : []);
    const clean = list.filter((id) => typeof id === 'string' && id.length > 0);
    store.setItem(DISMISSED_NOTICES_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Private-mode / denied storage: session memory still applies.
  }
}
/** Loads persisted notice ids. Corrupt/missing/denied storage yields empty Set. */
export function loadDismissedNoticeIds(storage) {
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  try {
    const raw = store && store.getItem ? store.getItem(DISMISSED_NOTICES_STORAGE_KEY) : null;
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id) => typeof id === 'string' && id.length > 0));
  } catch {
    return new Set();
  }
}
/** Maps banner actionKey to action buttons. Same mapping for top and secondary. */
export function getBannerActions(bannerOrKey) {
  const actionKey = typeof bannerOrKey === 'string' ? bannerOrKey : bannerOrKey && bannerOrKey.actionKey;
  if (actionKey === 'bridge-error') return [{ key: 'open-official', label: '查看官方界面' }];
  if (actionKey === 'offline') {
    return [{ key: 'recheck', label: '重新检查连接' }, { key: 'open-official', label: '查看官方界面' }];
  }
  if (actionKey === 'sync-error' || actionKey === 'resync') return [{ key: 'retry-sync', label: '重试同步' }];
  return [];
}
/** Compact predicate: width <= 960, or coarse-only pointer with width <= 1100. */
export function isCompactLayout(input) {
  const opts = input || {};
  const w = Number(opts.width) || 0;
  if (w <= 960) return true;
  if (opts.hasCoarsePointer && !opts.hasFinePointer && w <= 1100) return true;
  return false;
}
export function getScrimAriaLabel(mobilePanel) {
  return mobilePanel === 'overview' ? '关闭消息概览' : '关闭会话侧栏';
}
