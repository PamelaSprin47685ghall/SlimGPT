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
    // Priority 2: Offline / Not Taken Over
    banners.push({
      id: 'offline',
      priority: 2,
      level: 'offline',
      title: '未接管官方界面',
      message: '当前正连接 ChatGPT 页面，或者官方界面正处于活动状态。',
      actionKey: 'offline',
    });
  }

  // Priority 3: Sync error
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
      message: cacheNotice === 'read-failed'
        ? '本地缓存未能读取；请等待完整历史同步，当前取得的内容仍可导出。'
        : '本会话的本地输出缓存未完整保存；当前页面内容未被裁剪。刷新后需要重新同步历史，尚未同步的内容可先导出。',
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
        ? '完整历史同步暂未完成；当前仅显示已确认属于本轮的实时内容。'
        : '正在补齐完整历史；局部窗口不会被当作会话开头。',
      actionKey: 'resync',
    });
  }

  return banners;
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
export function getScrimAriaLabel(mobilePanel) {
  return mobilePanel === 'overview' ? '关闭消息概览' : '关闭会话侧栏';
}
