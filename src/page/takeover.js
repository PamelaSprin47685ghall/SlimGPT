// Takeover frame visibility, official-UI render sleep, focus guard and the
// "SlimGPT" restore button. The frame element itself is mounted by the
// isolated bridge (bridge.js); this MAIN-world module only toggles it.

export const FRAME_ID = 'slimgpt-takeover-frame';
export const RESTORE_ID = 'slimgpt-restore-button';
export const SLEEP_ATTR = 'data-slimgpt-render-sleep';
const SLEEP_STYLE_ID = 'slimgpt-render-sleep-style';
const INITIAL_COMPOSER_TIMEOUT = 15_000;

/**
 * Pure visibility decision.
 * @param {{ visible: boolean, userHidden: boolean, hasComposer: boolean, blocked: boolean }} state
 * @returns {'show'|'suspend'|null}
 */
export function decideTakeover({ visible, userHidden, hasComposer, blocked }) {
  if (visible && blocked) return 'suspend';
  if (!visible && !userHidden && hasComposer && !blocked) return 'show';
  return null;
}

/**
 * @param {object} options
 * @param {Window & typeof globalThis} options.window
 * @param {(visible: boolean, reason: string) => void} options.onChange
 * @param {() => boolean} options.hasComposer
 * @param {() => boolean} options.findBlocker
 */
export function createTakeover({ window: win, onChange, hasComposer, findBlocker }) {
  const doc = win.document;
  let visible = false;
  let userHidden = false;
  let focusPermit = 0;
  let sleepTimer = null;
  let hydrated = false;
  let lastReason = 'composer-unavailable';

  const frame = () => /** @type {HTMLIFrameElement|null} */ (doc.getElementById(FRAME_ID));

  function install() {
    whenRoot(() => {
      if (!doc.getElementById(SLEEP_STYLE_ID)) {
        const style = doc.createElement('style');
        style.id = SLEEP_STYLE_ID;
        style.textContent = `html[${SLEEP_ATTR}="1"] > body { display: none !important; }`;
        doc.documentElement.appendChild(style);
      }
    });
    installFocusGuard();
    installBlockerWatch();
    const start = () => {
      waitForComposer(INITIAL_COMPOSER_TIMEOUT).then((found) => {
        if (found) evaluate();
        else setVisible(false, 'composer-unavailable');
      });
    };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  function evaluate() {
    if (focusPermit > 0) return; // our own command is driving official menus
    const decision = decideTakeover({ visible, userHidden, hasComposer: hasComposer(), blocked: findBlocker() });
    if (decision === 'show') show();
    else if (decision === 'suspend') setVisible(false, 'blocking-official-ui');
  }

  function show() {
    if (findBlocker()) {
      setVisible(false, 'blocking-official-ui');
      return;
    }
    userHidden = false;
    doc.getElementById(RESTORE_ID)?.remove();
    setVisible(true, 'ready');
    scheduleSleep(0);
    queueMicrotask(focusFrame);
  }

  /** User asked for the official UI. */
  function hide() {
    userHidden = true;
    setVisible(false, 'user');
    mountRestoreButton();
  }

  function setVisible(next, reason) {
    const element = frame();
    if (element) {
      element.dataset.slimgptVisible = next ? '1' : '0';
      element.style.opacity = next ? '1' : '0';
      element.style.pointerEvents = next ? 'auto' : 'none';
    }
    if (!next) wake();
    const changed = next !== visible || reason !== lastReason;
    visible = next;
    lastReason = reason;
    if (changed) onChange(visible, reason);
  }

  function wake() {
    if (sleepTimer !== null) win.clearTimeout(sleepTimer);
    sleepTimer = null;
    doc.documentElement?.removeAttribute(SLEEP_ATTR);
  }

  function scheduleSleep(delay = 1_200) {
    if (sleepTimer !== null) win.clearTimeout(sleepTimer);
    sleepTimer = win.setTimeout(() => {
      sleepTimer = null;
      if (!visible || focusPermit > 0) return;
      if (!hydrated && !markHydrated()) return;
      if (findBlocker()) {
        setVisible(false, 'blocking-official-ui');
        return;
      }
      doc.documentElement?.setAttribute(SLEEP_ATTR, '1');
    }, delay);
  }

  /** The official React tree is live (sleeping before that can stall hydration). */
  function markHydrated() {
    const composer = doc.querySelector('#prompt-textarea, #mobile-composer-prompt, textarea[name="prompt-textarea"]');
    for (let node = composer; node && node !== doc; node = node.parentNode) {
      try {
        if (Object.getOwnPropertyNames(node).some((key) => key.startsWith('__react'))) {
          hydrated = true;
          return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Run fn with the official UI awake and focusable; re-sleep afterwards. */
  async function run(fn) {
    focusPermit += 1;
    wake();
    try {
      return await fn();
    } finally {
      focusPermit = Math.max(0, focusPermit - 1);
      if (visible) {
        scheduleSleep();
        queueMicrotask(focusFrame);
      }
    }
  }

  function focusFrame() {
    if (!visible) return;
    try { frame()?.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  function installFocusGuard() {
    const proto = win.HTMLElement?.prototype;
    if (!proto) return;
    const nativeFocus = proto.focus;
    proto.focus = function slimgptGuardedFocus() {
      if (visible && focusPermit === 0 && this?.id !== FRAME_ID) return undefined;
      return Reflect.apply(nativeFocus, this, arguments);
    };
  }

  function installBlockerWatch() {
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      win.requestAnimationFrame(() => {
        queued = false;
        evaluate();
      });
    };
    // Official dialogs are portaled to <body>; watch only the top levels.
    whenBody(() => {
      const observer = new win.MutationObserver(schedule);
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['inert', 'class', 'style'] });
      observer.observe(doc.body, { childList: true, attributes: true, attributeFilter: ['inert', 'aria-hidden', 'style'] });
    });
    win.addEventListener('popstate', schedule);
    win.addEventListener('focus', schedule);
  }

  function waitForComposer(timeoutMs) {
    return new Promise((resolve) => {
      if (hasComposer()) return resolve(true);
      const observer = new win.MutationObserver(() => {
        if (hasComposer()) finish(true);
      });
      const timer = win.setTimeout(() => finish(false), timeoutMs);
      function finish(found) {
        observer.disconnect();
        win.clearTimeout(timer);
        resolve(found);
      }
      observer.observe(doc.documentElement || doc, { childList: true, subtree: true });
    });
  }

  function mountRestoreButton() {
    if (doc.getElementById(RESTORE_ID) || !doc.documentElement) return;
    const button = doc.createElement('button');
    button.id = RESTORE_ID;
    button.type = 'button';
    button.textContent = 'SlimGPT';
    button.setAttribute('aria-label', '返回 SlimGPT 轻量界面');
    const dark = win.matchMedia?.('(prefers-color-scheme: dark)').matches;
    Object.assign(button.style, {
      position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
      border: dark ? '1px solid rgba(255,255,255,.2)' : '1px solid rgba(0,0,0,.15)',
      borderRadius: '999px', padding: '8px 12px',
      background: dark ? '#222220' : '#ffffff', color: dark ? '#ecece8' : '#20201e',
      font: '600 13px system-ui, sans-serif', cursor: 'pointer',
    });
    button.addEventListener('click', show);
    doc.documentElement.appendChild(button);
  }

  function whenRoot(fn) {
    if (doc.documentElement) return fn();
    const observer = new win.MutationObserver(() => {
      if (!doc.documentElement) return;
      observer.disconnect();
      fn();
    });
    observer.observe(doc, { childList: true });
  }

  function whenBody(fn) {
    if (doc.body) return fn();
    doc.addEventListener('DOMContentLoaded', () => doc.body && fn(), { once: true });
  }

  return {
    install, show, hide, run, wake, scheduleSleep, evaluate,
    isVisible: () => visible,
    reason: () => lastReason,
  };
}
