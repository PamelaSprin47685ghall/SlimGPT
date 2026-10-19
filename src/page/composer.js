// Drives the official ChatGPT composer for explicit UI commands only:
// send, stop, switch branch, reasoning effort. Nothing here runs on its own
// (no DOM observers left running). There is no "Continue generating": the
// current official UI has no such control (HAR 2026-10-19), and SlimGPT never
// fakes one by sending a continuation message.
// All DOM access goes through a DomAdapter (see dom.js).

import { isEffortValue } from '../shared/bridge-protocol.js';

export const DEFAULT_TIMEOUTS = Object.freeze({
  composer: 2_500,
  sendControl: 5_000,
  submission: 10_000,
  branch: 3_000,
  effortMenu: 1_500,
});

export const COMPOSER_SELECTORS = Object.freeze([
  '#mobile-composer-prompt',
  'textarea[data-mobile-composer-prompt]',
  '#prompt-textarea',
  'textarea[name="prompt-textarea"]',
  'div[contenteditable="true"][data-virtualkeyboard="true"]',
]);

export const SEND_SELECTORS = Object.freeze([
  '#composer-submit-button',
  '[data-composer-submit]',
  '[data-testid="send-button"]',
  '[data-testid="fruitjuice-send-button"]',
  '[data-testid="composer-send-button"]',
]);

// The logged-out (free mode) composer reuses one submit button for send and
// stop: while a reply streams it carries data-stop-generating and the stop label.
export const STOP_SELECTORS = Object.freeze([
  '[data-testid="stop-button"]',
  'button[data-composer-submit][data-stop-generating]',
]);

export const BLOCKER_SELECTORS = Object.freeze([
  ':modal',
  'html[data-conversation-gated]',
  'dialog[open]',
  '[role="alertdialog"]',
  '[role="dialog"][aria-modal="true"]',
  '#onetrust-banner-sdk',
  '#onetrust-pc-sdk',
]);

// Options of an open official menu (menus render in portals, not in the form).
export const MENU_OPTION_SELECTORS = Object.freeze([
  '[role="menuitemradio"]', '[role="option"]', '[role="radio"]', '[role="menuitem"]',
]);

// Official labels of known effort values (English / Chinese UI). Unknown
// values are matched by their own name.
const EFFORT_LABELS = {
  instant: ['instant', '即时', '快速'],
  minimal: ['minimal', '最低'],
  low: ['low', '低'],
  light: ['light', '轻度', '轻量'],
  medium: ['medium', '中'],
  standard: ['standard', '标准'],
  high: ['high', '高'],
  extended: ['extended', '进阶', '扩展', '延长'],
  heavy: ['heavy', '深度', '重度'],
};
const THINKING_SUBMENU = /^(?:thinking(?: time| effort| level)?|reasoning(?: effort)?|思考(?:时间|强度|程度)?|推理(?:强度)?)(?:$|[\s:：(（])/i;

/** Does an official option label name this effort value? (first word, case-insensitive) */
export function isEffortLabel(label, effort) {
  const text = String(label || '').trim().toLowerCase();
  if (!text || !isEffortValue(effort)) return false;
  const words = EFFORT_LABELS[effort] || [effort];
  return words.some((word) => text === word || text.startsWith(`${word} `) || text.startsWith(`${word}\n`) ||
    (/[^\x00-\x7f]/.test(word) && text.startsWith(word)));
}

const STOP_LABEL = /^(?:stop(?: generating| generation| response| streaming| thinking)?|停止(?:生成|回答|回复|思考)?)[.!。…\s]*$/i;
const STOP_TESTID = /^stop(?:-button)?$/i;
const PREV_LABEL = /^(?:previous(?: response| message| version)?|上一(?:个|条|版)?(?:回复|回答|消息|版本)?)$/i;
const NEXT_LABEL = /^(?:next(?: response| message| version)?|下一(?:个|条|版)?(?:回复|回答|消息|版本)?)$/i;

/** @param {string} label */
export const isStopLabel = (label) => STOP_LABEL.test(label);
/** @param {string} label @param {-1|1} direction */
export const isBranchLabel = (label, direction) => (direction < 0 ? PREV_LABEL : NEXT_LABEL).test(label);

/**
 * @param {object} options
 * @param {import('./dom.js').DomAdapter} options.dom
 * @param {{ run: <T>(fn: () => Promise<T>) => Promise<T> }} options.officialUi wake the official UI + permit focus while fn runs
 * @param {() => boolean} [options.isStreaming] an official stream is active
 * @param {Partial<typeof DEFAULT_TIMEOUTS>} [options.timeouts]
 */
const lastWord = (label) => String(label || '').trim().split(/\s+/).at(-1) || '';

export function createComposerDriver({ dom, officialUi, isStreaming = () => false, timeouts = {} }) {
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  let busy = false;
  let pendingSubmission = null;

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const element = dom.queryAll(selector).find((candidate) => dom.isVisible(candidate));
      if (element) return element;
    }
    return null;
  }

  function hasComposer() {
    return COMPOSER_SELECTORS.some((selector) => dom.queryAll(selector).length > 0);
  }

  function findBlocker() {
    if (dom.rootInert()) return true;
    return BLOCKER_SELECTORS.some((selector) => dom.queryAll(selector).some((element) =>
      selector === ':modal' || dom.isVisible(element)));
  }

  function isSendCandidate(candidate) {
    return dom.isEnabledButton(candidate) && dom.isVisible(candidate) &&
      dom.attr(candidate, 'data-stop-generating') === null && !isStopLabel(dom.label(candidate));
  }

  function findSendButton(composer) {
    for (const selector of SEND_SELECTORS) {
      const button = dom.queryAll(selector).find(isSendCandidate);
      if (button) return button;
    }
    const form = dom.closest(composer, 'form');
    if (!form) return null;
    return dom.queryWithin(form, 'button[type="submit"]').find(isSendCandidate) || null;
  }

  function findStopControl() {
    for (const selector of STOP_SELECTORS) {
      const direct = dom.queryAll(selector).find((button) => dom.isEnabledButton(button));
      if (direct) return direct;
    }
    const composer = findComposer();
    const form = composer ? dom.closest(composer, 'form') : null;
    if (!form) return null;
    return dom.queryWithin(form, 'button').find((button) => dom.isEnabledButton(button) &&
      (STOP_TESTID.test(String(dom.attr(button, 'data-testid') || '')) || isStopLabel(dom.label(button)))) || null;
  }

  /** Effort menu triggers in the composer (the model / thinking pill), plus-button excluded. */
  function findMenuTriggers() {
    const composer = findComposer();
    const form = composer ? dom.closest(composer, 'form') : null;
    if (!form) return [];
    return dom.queryWithin(form, 'button[aria-haspopup="menu"]').filter((button) => {
      const id = `${dom.attr(button, 'id') || ''} ${dom.attr(button, 'data-testid') || ''}`;
      return !/composer-plus-btn/.test(id) && dom.isEnabledButton(button) && Boolean(dom.label(button));
    }).slice(0, 3);
  }

  function menuOptions() {
    const out = [];
    for (const selector of MENU_OPTION_SELECTORS) {
      for (const option of dom.queryAll(selector)) if (!out.includes(option) && dom.isVisible(option)) out.push(option);
    }
    return out;
  }

  function optionValue(option) {
    return [dom.attr(option, 'data-value'), dom.attr(option, 'data-testid'), dom.attr(option, 'value')]
      .filter(Boolean).join(' ').toLowerCase();
  }

  function findEffortOption(effort) {
    const options = menuOptions().filter((option) => dom.attr(option, 'aria-disabled') !== 'true');
    const byValue = new RegExp(`(?:^|[\\s_:-])${effort}(?:$|[\\s_-])`);
    return options.find((option) => byValue.test(optionValue(option))) ||
      options.find((option) => isEffortLabel(dom.label(option), effort)) || null;
  }

  const isChecked = (option) => ['aria-checked', 'aria-selected'].some((name) => dom.attr(option, name) === 'true') ||
    dom.attr(option, 'data-state') === 'checked';

  function findThinkingSubmenu() {
    return menuOptions().find((option) => dom.attr(option, 'aria-haspopup') && THINKING_SUBMENU.test(dom.label(option))) || null;
  }

  /** Called by the fetch tee when the official submit request settles. */
  function noteSubmission(result) {
    const pending = pendingSubmission;
    if (!pending) return;
    pendingSubmission = null;
    pending.resolve(result);
  }

  function waitForSubmission() {
    pendingSubmission?.resolve(null);
    return new Promise((resolve) => {
      const entry = { resolve: (value) => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => {
        if (pendingSubmission === entry) pendingSubmission = null;
        resolve(null);
      }, limits.submission);
      pendingSubmission = entry;
    });
  }

  async function exclusive(fn) {
    if (busy) return { ok: false, error: 'busy' };
    busy = true;
    try {
      return await officialUi.run(fn);
    } catch {
      return { ok: false, error: 'not-confirmed' };
    } finally {
      busy = false;
    }
  }

  /** @returns {Promise<{ ok: boolean, error: import('../shared/bridge-protocol.js').SendErrorCode|null }>} */
  async function send(text) {
    const submitted = typeof text === 'string' ? text.trim() : '';
    if (!submitted) return { ok: false, error: 'empty-text' };
    if (busy || isStreaming()) return { ok: false, error: 'busy' };
    const result = await exclusive(async () => {
      if (findBlocker()) return { ok: false, error: 'blocked-by-official-ui' };
      const composer = await dom.waitFor(findComposer, limits.composer);
      if (!composer) return { ok: false, error: 'composer-not-found' };
      if (!dom.insertText(composer, submitted)) return { ok: false, error: 'composer-not-found' };
      const button = await dom.waitFor(() => findSendButton(composer), limits.sendControl);
      if (!button) return { ok: false, error: 'send-control-not-ready' };
      const confirmation = waitForSubmission();
      dom.click(button);
      const settled = await confirmation;
      if (!settled) return { ok: false, error: 'send-not-confirmed' };
      if (settled.ok) return { ok: true, error: null };
      return { ok: false, error: settled.status === 401 ? 'not-logged-in' : 'request-rejected' };
    });
    return { ok: result.ok, error: result.ok ? null : (result.error === 'not-confirmed' ? 'send-not-confirmed' : result.error) };
  }

  async function stop() {
    return officialUi.run(async () => {
      const control = findStopControl();
      if (!control) return { ok: false, error: 'control-not-found' };
      dom.click(control);
      return { ok: true, error: null };
    });
  }

  async function switchBranch(messageId, direction) {
    if (typeof messageId !== 'string' || !messageId || (direction !== -1 && direction !== 1)) {
      return { ok: false, error: 'invalid-argument' };
    }
    return exclusive(async () => {
      const selector = `[data-message-id="${dom.escape(messageId)}"]`;
      const node = dom.queryAll(selector)[0];
      if (!node) return { ok: false, error: 'control-not-found' };
      const turn = dom.closest(node, '[data-testid^="conversation-turn"]') || dom.closest(node, 'article') || node;
      const button = dom.queryWithin(turn, 'button')
        .find((candidate) => dom.isEnabledButton(candidate) && isBranchLabel(dom.label(candidate), direction));
      if (!button) return { ok: false, error: 'control-not-found' };
      dom.click(button);
      const switched = await dom.waitFor(() => dom.queryAll(selector).length === 0, limits.branch);
      return switched ? { ok: true, error: null } : { ok: false, error: 'not-confirmed' };
    });
  }

  /**
   * Pick an effort on the official control, the way a user would: open the
   * composer's model/thinking menu (and its thinking submenu when there is
   * one), activate the option, confirm it is checked, close the menu.
   * Nothing is sent and no request is touched.
   */
  async function setEffort(effort) {
    if (!isEffortValue(effort)) return { ok: false, error: 'invalid-argument' };
    if (isStreaming()) return { ok: false, error: 'busy' };
    return exclusive(async () => {
      if (findBlocker()) return { ok: false, error: 'blocked-by-official-ui' };
      let option = findEffortOption(effort);
      let opened = null;
      try {
        for (const trigger of option ? [] : findMenuTriggers()) {
          dom.activate(trigger);
          opened = trigger;
          option = await dom.waitFor(() => findEffortOption(effort) || findThinkingSubmenu(), limits.effortMenu);
          if (option && !findEffortOption(effort)) {
            dom.activate(option); // the thinking submenu
            option = await dom.waitFor(() => findEffortOption(effort), limits.effortMenu);
          }
          if (option) break;
          close(trigger);
          opened = null;
        }
        if (!option) return { ok: false, error: 'control-not-found' };
        if (isChecked(option)) return { ok: true, error: null };
        dom.activate(option);
        const confirmed = await dom.waitFor(() => {
          const now = findEffortOption(effort);
          if (now) return isChecked(now);
          // The menu closed on selection: the pill now names the choice.
          return findMenuTriggers().some((trigger) => isEffortLabel(lastWord(dom.label(trigger)), effort) || isEffortLabel(dom.label(trigger), effort));
        }, limits.effortMenu);
        return confirmed ? { ok: true, error: null } : { ok: false, error: 'not-confirmed' };
      } finally {
        if (opened) close(opened);
      }
    });
  }

  function close(trigger) {
    if (dom.attr(trigger, 'aria-expanded') !== 'true') return;
    try { dom.pressKey(trigger, 'Escape'); } catch { /* ignore */ }
    if (dom.attr(trigger, 'aria-expanded') === 'true') {
      try { dom.activate(trigger); } catch { /* ignore */ }
    }
  }

  return {
    send, stop, switchBranch, setEffort,
    noteSubmission, findBlocker, findComposer, hasComposer, isBusy: () => busy,
  };
}
