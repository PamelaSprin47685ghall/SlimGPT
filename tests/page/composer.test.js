import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createComposerDriver, effortToSliderValue, isBranchLabel, isContinueLabel, isStopLabel, sliderValueToEffort,
} from '../../src/page/composer.js';

// Plain-object fake of the DomAdapter. `selectors` maps a selector string to
// the elements it returns; elements are { label, visible, enabled, attrs, ... }.
function fakeDom() {
  const selectors = new Map();
  const log = [];
  const el = (props = {}) => ({ visible: true, enabled: true, button: true, attrs: {}, label: '', children: new Map(), ...props });
  const dom = {
    selectors, log, el,
    inert: false,
    on(selector, ...elements) { selectors.set(selector, elements); return elements[0]; },
    queryAll: (selector) => (selectors.get(selector) || []).filter((element) => !element.removed),
    queryWithin: (root, selector) => (root.children.get(selector) || []).filter((element) => !element.removed),
    closest: (element, selector) => element.closest?.[selector] || null,
    isVisible: (element) => Boolean(element.visible),
    isEnabledButton: (element) => Boolean(element.button && element.enabled),
    label: (element) => element.label,
    attr: (element, name) => element.attrs[name] ?? null,
    rootInert: () => dom.inert,
    async waitFor(probe, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = probe();
        if (value) return value;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    },
    insertText(element, text) { log.push(['insert', text]); element.value = text; return element.accepts !== false; },
    readValue: (element) => element.value || '',
    click(element) { log.push(['click', element.name]); element.onClick?.(); },
    activate(element) { log.push(['activate', element.name]); element.onActivate?.(); },
    pressKey(element, key) { log.push(['key', key]); element.onKey?.(key); },
    isRangeInput: (element) => Boolean(element.range),
    setRangeValue(element, value) { log.push(['range', value]); element.state.value = value; },
    sliderState: (element) => element.state,
    escape: (value) => value,
  };
  return dom;
}

const officialUi = () => {
  const calls = { runs: 0 };
  return { calls, run: async (fn) => { calls.runs += 1; return fn(); } };
};
const T = { composer: 30, sendControl: 30, submission: 60, branch: 30, slider: 30 };

function composerSetup(dom) {
  const form = dom.el({ name: 'form', button: false });
  const composer = dom.on('#prompt-textarea', dom.el({ name: 'composer', button: false, closest: { form } }));
  return { form, composer };
}

test('label matchers are exact', () => {
  assert.ok(isContinueLabel('Continue generating'));
  assert.ok(isContinueLabel('继续生成'));
  assert.ok(!isContinueLabel('Continue with Google'));
  assert.ok(isStopLabel('Stop streaming'));
  assert.ok(isStopLabel('停止生成'));
  assert.ok(!isStopLabel('Stop sharing link'));
  assert.ok(isBranchLabel('Previous response', -1));
  assert.ok(isBranchLabel('下一回复', 1));
  assert.ok(!isBranchLabel('Next response', -1));
});

test('effort maps linearly onto any slider range', () => {
  assert.equal(effortToSliderValue('lowest', 0, 4), 0);
  assert.equal(effortToSliderValue('medium', 0, 4), 2);
  assert.equal(effortToSliderValue('highest', 1, 5), 5);
  assert.equal(effortToSliderValue('high', 0, 100), 75);
  assert.equal(effortToSliderValue('extreme', 0, 4), null);
  assert.equal(effortToSliderValue('low', 3, 3), null);
  assert.equal(sliderValueToEffort(3, 1, 5), 'medium');
  assert.equal(sliderValueToEffort(4, 0, 4), 'highest');
  assert.equal(sliderValueToEffort(Number.NaN, 0, 4), null);
});

test('send: types into the official composer, clicks send, confirms via the official request', async () => {
  const dom = fakeDom();
  composerSetup(dom);
  let driver;
  dom.on('#composer-submit-button', dom.el({ name: 'send', onClick: () => queueMicrotask(() => driver.noteSubmission({ ok: true, status: 200 })) }));
  const ui = officialUi();
  driver = createComposerDriver({ dom, officialUi: ui, timeouts: T });
  assert.deepEqual(await driver.send('  hello  '), { ok: true, error: null });
  assert.deepEqual(dom.log, [['insert', 'hello'], ['click', 'send']]);
  assert.equal(ui.calls.runs, 1, 'official UI woken for the command');
});

test('send failures map to explicit codes', async () => {
  const dom = fakeDom();
  const driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.deepEqual(await driver.send('   '), { ok: false, error: 'empty-text' });
  assert.deepEqual(await driver.send('x'), { ok: false, error: 'composer-not-found' });

  composerSetup(dom);
  assert.deepEqual(await driver.send('x'), { ok: false, error: 'send-control-not-ready' });

  dom.on('#composer-submit-button', dom.el({ name: 'send' }));
  assert.deepEqual(await driver.send('x'), { ok: false, error: 'send-not-confirmed' });

  dom.on('#composer-submit-button', dom.el({ name: 'send', onClick: () => queueMicrotask(() => driver.noteSubmission({ ok: false, status: 401 })) }));
  assert.deepEqual(await driver.send('x'), { ok: false, error: 'not-logged-in' });
  dom.on('#composer-submit-button', dom.el({ name: 'send', onClick: () => queueMicrotask(() => driver.noteSubmission({ ok: false, status: 429 })) }));
  assert.deepEqual(await driver.send('x'), { ok: false, error: 'request-rejected' });

  dom.on('dialog[open]', dom.el({ name: 'dialog', button: false }));
  assert.deepEqual(await driver.send('x'), { ok: false, error: 'blocked-by-official-ui' });
});

test('send is refused while an official stream runs or another command is in progress', async () => {
  const dom = fakeDom();
  composerSetup(dom);
  dom.on('#composer-submit-button', dom.el({ name: 'send' }));
  let streaming = true;
  const driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T, isStreaming: () => streaming });
  assert.deepEqual(await driver.send('x'), { ok: false, error: 'busy' });
  streaming = false;
  const first = driver.send('x');
  assert.deepEqual(await driver.send('y'), { ok: false, error: 'busy' });
  await first;
});

test('a falsely enabled generic submit outside the composer form is never clicked', async () => {
  const dom = fakeDom();
  const { form } = composerSetup(dom);
  dom.on('button[type="submit"]', dom.el({ name: 'sidebar-search' }));
  form.children.set('button[type="submit"]', [dom.el({ name: 'form-submit', visible: false })]);
  const driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.equal((await driver.send('x')).error, 'send-control-not-ready');
  assert.ok(!dom.log.some(([kind]) => kind === 'click'));
});

test('stop clicks only the official stop control', async () => {
  const dom = fakeDom();
  const { form } = composerSetup(dom);
  const driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.deepEqual(await driver.stop(), { ok: false, error: 'control-not-found' });
  form.children.set('button', [dom.el({ name: 'attach', label: 'Attach files' }), dom.el({ name: 'stop', label: 'Stop streaming' })]);
  assert.deepEqual(await driver.stop(), { ok: true, error: null });
  assert.deepEqual(dom.log.at(-1), ['click', 'stop']);
});

test('continue is explicit and confirmed by the official request', async () => {
  const dom = fakeDom();
  let driver;
  dom.on('button',
    dom.el({ name: 'google', label: 'Continue with Google' }),
    dom.el({ name: 'continue', label: 'Continue generating', onClick: () => queueMicrotask(() => driver.noteSubmission({ ok: true, status: 200 })) }));
  driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.deepEqual(await driver.continueGeneration(), { ok: true, error: null });
  assert.deepEqual(dom.log, [['click', 'continue']]);
  dom.selectors.set('button', []);
  assert.deepEqual(await driver.continueGeneration(), { ok: false, error: 'control-not-found' });
});

test('switch-branch clicks the arrow inside that message turn and waits for the sibling to replace it', async () => {
  const dom = fakeDom();
  const turn = dom.el({ name: 'turn', button: false });
  const message = dom.on('[data-message-id="m-a"]', dom.el({ name: 'msg', button: false, closest: { '[data-testid^="conversation-turn"]': turn } }));
  turn.children.set('button', [
    dom.el({ name: 'copy', label: 'Copy' }),
    dom.el({ name: 'prev', label: 'Previous response' }),
    dom.el({ name: 'next', label: 'Next response', onClick: () => { message.removed = true; } }),
  ]);
  const driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.deepEqual(await driver.switchBranch('m-a', 0), { ok: false, error: 'invalid-argument' });
  assert.deepEqual(await driver.switchBranch('missing', 1), { ok: false, error: 'control-not-found' });
  assert.deepEqual(await driver.switchBranch('m-a', 1), { ok: true, error: null });
  assert.deepEqual(dom.log, [['click', 'next']]);
});

test('switch-branch reports not-confirmed when the official UI does not change', async () => {
  const dom = fakeDom();
  const turn = dom.el({ name: 'turn', button: false });
  dom.on('[data-message-id="m-a"]', dom.el({ name: 'msg', button: false, closest: { article: turn } }));
  turn.children.set('button', [dom.el({ name: 'prev', label: 'Previous response' })]);
  const driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.deepEqual(await driver.switchBranch('m-a', -1), { ok: false, error: 'not-confirmed' });
});

test('set-effort: opens the official menu, steps an ARIA slider by keys, closes the menu', async () => {
  const dom = fakeDom();
  const { form } = composerSetup(dom);
  const slider = dom.el({ name: 'slider', button: false, state: { value: 1, min: 0, max: 4 } });
  slider.onKey = (key) => setTimeout(() => { slider.state.value += key === 'ArrowRight' ? 1 : -1; }, 1);
  const trigger = dom.el({ name: 'trigger', label: 'Thinking', attrs: {} });
  trigger.onActivate = () => {
    trigger.attrs['aria-expanded'] = trigger.attrs['aria-expanded'] === 'true' ? 'false' : 'true';
    dom.selectors.set('[data-model-reasoning-effort-slider] [role="slider"]', trigger.attrs['aria-expanded'] === 'true' ? [slider] : []);
  };
  form.children.set('button[aria-haspopup="menu"]', [dom.el({ name: 'plus', label: 'Add', attrs: { id: 'composer-plus-btn' } }), trigger]);
  const driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.deepEqual(await driver.setEffort('high'), { ok: true, error: null });
  assert.equal(slider.state.value, 3);
  assert.deepEqual(dom.log.map(([kind, value]) => `${kind}:${value}`), ['activate:trigger', 'key:ArrowRight', 'key:ArrowRight', 'activate:trigger']);
  assert.deepEqual(await driver.setEffort('max'), { ok: false, error: 'invalid-argument' });
});

test('set-effort on a range input sets the value directly; missing control is reported', async () => {
  const dom = fakeDom();
  const driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.deepEqual(await driver.setEffort('low'), { ok: false, error: 'control-not-found' });
  const slider = dom.on('input[type="range"][aria-label*="reasoning" i]', dom.el({ name: 'range', button: false, range: true, state: { value: 5, min: 1, max: 5 } }));
  assert.deepEqual(await driver.setEffort('lowest'), { ok: true, error: null });
  assert.equal(slider.state.value, 1);
  assert.equal(driver.readEffort(), 'lowest');
});

test('blocker detection: inert root, :modal or visible dialogs', () => {
  const dom = fakeDom();
  const driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.equal(driver.findBlocker(), false);
  dom.on('[role="dialog"][aria-modal="true"]', dom.el({ button: false, visible: false }));
  assert.equal(driver.findBlocker(), false, 'hidden dialogs do not block');
  dom.on(':modal', dom.el({ button: false, visible: false }));
  assert.equal(driver.findBlocker(), true, ':modal blocks even while render-sleeping');
  dom.selectors.clear();
  dom.inert = true;
  assert.equal(driver.findBlocker(), true);
});

test('free mode composer: the shared submit button sends, and stops only while it is the stop button', async () => {
  const dom = fakeDom();
  const form = dom.el({ name: 'form', button: false });
  dom.on('#mobile-composer-prompt', dom.el({ name: 'composer', button: false, closest: { form } }));
  let driver;
  const submit = dom.el({ name: 'submit', label: 'Send message', attrs: {}, onClick: () => driver.noteSubmission({ ok: true, status: 200 }) });
  dom.on('[data-composer-submit]', submit);
  driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.equal(driver.hasComposer(), true);
  assert.deepEqual(await driver.send('hello'), { ok: true, error: null });
  assert.deepEqual(dom.log, [['insert', 'hello'], ['click', 'submit']]);

  // While streaming the same button turns into "Stop generating": never clicked as send.
  submit.attrs['data-stop-generating'] = '';
  submit.label = 'Stop generating';
  dom.on('button[data-composer-submit][data-stop-generating]', submit);
  const idle = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.equal((await idle.send('again')).error, 'send-control-not-ready');
  dom.log.length = 0;
  assert.deepEqual(await idle.stop(), { ok: true, error: null });
  assert.deepEqual(dom.log, [['click', 'submit']]);
});

test('a gated free-mode page (login wall) blocks sending', async () => {
  const dom = fakeDom();
  composerSetup(dom);
  dom.on('html[data-conversation-gated]', dom.el({ name: 'html', button: false }));
  const driver = createComposerDriver({ dom, officialUi: officialUi(), timeouts: T });
  assert.equal((await driver.send('x')).error, 'blocked-by-official-ui');
});
