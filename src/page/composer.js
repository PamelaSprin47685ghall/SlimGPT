// Drives the official ChatGPT composer for explicit UI commands only:
// send, stop, continue, switch branch, reasoning effort. Nothing here runs on
// its own (no auto "Continue generating", no DOM observers left running).
// All DOM access goes through a DomAdapter (see dom.js).

import { EFFORT_VALUES } from '../shared/bridge-protocol.js';

export const DEFAULT_TIMEOUTS = Object.freeze({
  composer: 2_500,
  sendControl: 5_000,
  submission: 10_000,
  branch: 3_000,
  slider: 5_000,
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

export const SLIDER_SELECTORS = Object.freeze([
  '[data-model-reasoning-effort-slider] [role="slider"]',
  '[data-model-reasoning-effort-slider] input[type="range"]',
  'input[type="range"][aria-label*="reasoning" i]',
  'input[type="range"][aria-label*="thinking" i]',
  '[role="slider"][aria-label*="reasoning" i]',
  '[role="slider"][aria-label*="thinking" i]',
]);

const CONTINUE_LABEL = /^(?:continue(?: generating| response)?|继续(?:生成|回答|回复)?)[.!。…\s]*$/i;
const STOP_LABEL = /^(?:stop(?: generating| generation| response| streaming| thinking)?|停止(?:生成|回答|回复|思考)?)[.!。…\s]*$/i;
const STOP_TESTID = /^stop(?:-button)?$/i;
const PREV_LABEL = /^(?:previous(?: response| message| version)?|上一(?:个|条|版)?(?:回复|回答|消息|版本)?)$/i;
const NEXT_LABEL = /^(?:next(?: response| message| version)?|下一(?:个|条|版)?(?:回复|回答|消息|版本)?)$/i;

/** @param {string} label */
export const isContinueLabel = (label) => CONTINUE_LABEL.test(label);
/** @param {string} label */
export const isStopLabel = (label) => STOP_LABEL.test(label);
/** @param {string} label @param {-1|1} direction */
export const isBranchLabel = (label, direction) => (direction < 0 ? PREV_LABEL : NEXT_LABEL).test(label);

/**
 * Map an EffortValue onto a slider range [min, max].
 * @param {string} effort
 * @param {number} min
 * @param {number} max
 * @returns {number|null}
 */
export function effortToSliderValue(effort, min, max) {
  const index = EFFORT_VALUES.indexOf(/** @type {any} */ (effort));
  if (index < 0 || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return min + Math.round((index * (max - min)) / (EFFORT_VALUES.length - 1));
}

/** Inverse of effortToSliderValue (nearest). */
export function sliderValueToEffort(value, min, max) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return EFFORT_VALUES[Math.round(ratio * (EFFORT_VALUES.length - 1))];
}

/**
 * @param {object} options
 * @param {import('./dom.js').DomAdapter} options.dom
 * @param {{ run: <T>(fn: () => Promise<T>) => Promise<T> }} options.officialUi wake the official UI + permit focus while fn runs
 * @param {() => boolean} [options.isStreaming] an official stream is active
 * @param {Partial<typeof DEFAULT_TIMEOUTS>} [options.timeouts]
 */
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

  function findContinueControl() {
    return dom.queryAll('button').find((button) => dom.isEnabledButton(button) && dom.isVisible(button) &&
      isContinueLabel(dom.label(button))) || null;
  }

  function findSlider() {
    for (const selector of SLIDER_SELECTORS) {
      const slider = dom.queryAll(selector).find((candidate) => dom.isVisible(candidate));
      if (slider) return slider;
    }
    return null;
  }

  function findEffortMenuTrigger() {
    const composer = findComposer();
    const form = composer ? dom.closest(composer, 'form') : null;
    if (!form) return null;
    return dom.queryWithin(form, 'button[aria-haspopup="menu"]').find((button) => {
      const id = `${dom.attr(button, 'id') || ''} ${dom.attr(button, 'data-testid') || ''}`;
      return !/composer-plus-btn/.test(id) && dom.isEnabledButton(button) && Boolean(dom.label(button));
    }) || null;
  }

  function sliderRange(slider) {
    const state = dom.sliderState(slider);
    return {
      value: Number(state.value),
      min: Number(state.min),
      max: Number(state.max),
    };
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

  async function continueGeneration() {
    if (isStreaming()) return { ok: false, error: 'busy' };
    return exclusive(async () => {
      if (findBlocker()) return { ok: false, error: 'blocked-by-official-ui' };
      const control = findContinueControl();
      if (!control) return { ok: false, error: 'control-not-found' };
      const confirmation = waitForSubmission();
      dom.click(control);
      const settled = await confirmation;
      return settled?.ok ? { ok: true, error: null } : { ok: false, error: 'not-confirmed' };
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

  /** Current effort as seen on the official slider (only when it is rendered). */
  function readEffort() {
    const slider = findSlider();
    if (!slider) return null;
    const { value, min, max } = sliderRange(slider);
    return sliderValueToEffort(value, min, max);
  }

  async function setEffort(effort) {
    if (!EFFORT_VALUES.includes(/** @type {any} */ (effort))) return { ok: false, error: 'invalid-argument' };
    return exclusive(async () => {
      let slider = findSlider();
      let trigger = null;
      try {
        if (!slider) {
          trigger = findEffortMenuTrigger();
          if (!trigger) return { ok: false, error: 'control-not-found' };
          dom.activate(trigger);
          slider = await dom.waitFor(findSlider, limits.slider);
        }
        if (!slider) return { ok: false, error: 'control-not-found' };
        const range = sliderRange(slider);
        const target = effortToSliderValue(effort, range.min, range.max);
        if (target === null) return { ok: false, error: 'control-not-found' };
        if (dom.isRangeInput(slider)) {
          dom.setRangeValue(slider, target);
        } else {
          let current = range.value;
          let guard = 0;
          while (current !== target && guard++ < 16) {
            const key = target < current ? 'ArrowLeft' : 'ArrowRight';
            const before = current;
            dom.pressKey(slider, key);
            const moved = await dom.waitFor(() => {
              const next = sliderRange(slider).value;
              return next !== before ? { next } : null;
            }, limits.slider);
            if (!moved) return { ok: false, error: 'not-confirmed' };
            current = moved.next;
          }
        }
        const reached = await dom.waitFor(() => sliderRange(slider).value === target, limits.slider);
        return reached ? { ok: true, error: null } : { ok: false, error: 'not-confirmed' };
      } finally {
        if (trigger && dom.attr(trigger, 'aria-expanded') === 'true') {
          try { dom.activate(trigger); } catch { /* ignore */ }
        }
      }
    });
  }

  return {
    send, stop, continueGeneration, switchBranch, setEffort, readEffort,
    noteSubmission, findBlocker, findComposer, hasComposer, isBusy: () => busy,
  };
}
