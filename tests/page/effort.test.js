// Reasoning effort (思考强度): learned passively from what the official app
// fetches and sends. Fixture: sanitized from the logged-in free-account HAR
// (2026-10-19): only effort-related fields.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createEffortTracker, effortName } from '../../src/page/effort.js';
import { classifyEndpoint, readSubmitChoice } from '../../src/page/endpoints.js';
import { installHook } from '../../src/page/runtime.js';

const har = JSON.parse(readFileSync(new URL('../fixtures/page/har-effort-free-account.json', import.meta.url), 'utf8'));
const O = 'https://chatgpt.com';

test('HAR free account: settings/user offers only "instant", no model has configurable effort → one value, no choice', () => {
  const tracker = createEffortTracker();
  assert.equal(tracker.noteModels(JSON.stringify(har.models)), false, 'no configurable model: nothing changes');
  assert.equal(tracker.noteSettings(JSON.stringify(har.settingsUser)), true);
  assert.deepEqual(tracker.efforts(), ['instant']);
  for (const body of har.submitBodies) tracker.noteSubmit(readSubmitChoice(JSON.stringify(body)));
  assert.deepEqual(tracker.efforts(), ['instant']);
  assert.equal(tracker.current(), null, 'the submit body carries no effort field on this account');
  assert.deepEqual(har.submitBodies.map((body) => readSubmitChoice(JSON.stringify(body))), [{ model: 'auto', effort: null }, { model: 'gpt-6', effort: null }]);
});

test('a configurable model offers its own efforts (strings or objects); others fall back to the account list', () => {
  const tracker = createEffortTracker();
  tracker.noteSettings({ available_options: { backend_reasoning_effort: ['instant'] } });
  const models = { default_model_slug: 'auto', models: [
    { slug: 'gpt-6-t', configurable_thinking_effort: true, thinking_efforts: [{ thinking_effort: 'light' }, 'Standard', { value: 'extended' }, 'standard', { label: 'no name' }, 'bad value!'] },
    { slug: 'auto', configurable_thinking_effort: false, thinking_efforts: ['ignored'] },
  ] };
  assert.equal(tracker.noteModels(models), false, 'default model is not configurable');
  assert.deepEqual(tracker.efforts(), ['instant']);
  assert.equal(tracker.noteSubmit({ model: 'gpt-6-t', effort: null }), true);
  assert.deepEqual(tracker.efforts(), ['light', 'standard', 'extended']);
  assert.equal(tracker.noteSubmit(readSubmitChoice(JSON.stringify({ model: 'gpt-6-t', thinking_effort: 'Extended' }))), true);
  assert.equal(tracker.current(), 'extended');
  assert.deepEqual(readSubmitChoice(JSON.stringify({ model: 'x', reasoning_effort: 'high' })), { model: 'x', effort: 'high' });
  assert.deepEqual(readSubmitChoice('not json'), { model: null, effort: null });
  assert.equal(effortName({ effort: 'HEAVY ' }), 'heavy');
  assert.equal(effortName(42), null);
  assert.equal(tracker.noteModels('{broken'), false);
});

test('only the exact models / settings endpoints are observed (GET)', () => {
  assert.deepEqual(classifyEndpoint('GET', '/backend-api/models?iim=false&include_icons=false&is_gizmo=false', O), { kind: 'models' });
  assert.deepEqual(classifyEndpoint('GET', '/backend-api/settings/user', O), { kind: 'user-settings' });
  assert.equal(classifyEndpoint('GET', 'https://evil.example/backend-api/models', O), null);
  assert.equal(classifyEndpoint('GET', '/backend-api/settings/is_adult', O), null);
});

// Runtime wiring with a fake window (same shape as runtime.test.js).
function fakeWindow(nativeFetch) {
  const listeners = {};
  const posted = [];
  const frameListeners = {};
  class Element {}
  class HTMLElement extends Element { focus() {} }
  const frame = {
    tagName: 'IFRAME', id: 'slimgpt-takeover-frame', src: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/index.html?takeover=1', dataset: {}, style: {},
    contentWindow: { postMessage: (message) => posted.push(message) },
    addEventListener: (type, fn) => { frameListeners[type] = fn; },
  };
  const location = new URL('https://chatgpt.com/');
  const win = {
    location: { get origin() { return location.origin; }, get href() { return location.href; }, get pathname() { return location.pathname; }, assign() {} },
    history: { state: null, pushState() {}, replaceState() {} },
    fetch: nativeFetch,
    document: {
      readyState: 'complete', documentElement: { dataset: {}, appendChild() {}, setAttribute() {}, removeAttribute() {} }, body: {},
      getElementById: (id) => (id === frame.id ? frame : null), querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }), addEventListener() {},
    },
    Element, HTMLElement,
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
    clearTimeout,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); },
  };
  const fromFrame = (data) => { for (const fn of listeners.message || []) fn({ source: frame.contentWindow, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', data }); };
  return { win, posted, frameListeners, fromFrame, of: (type) => posted.filter((m) => m.type === type) };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('runtime: hello.efforts comes from the observed official fetches; a choice needs 2+ values; logged out → []', async () => {
  const settings = { current: har.settingsUser };
  const env = fakeWindow(async (url) => {
    const path = new URL(url, O).pathname;
    if (path === '/backend-api/models') return json(har.models);
    if (path === '/backend-api/settings/user') return json(settings.current);
    return json({ items: [], total: 0 });
  });
  installHook(env.win);
  env.frameListeners.load();
  assert.deepEqual(env.of('hello').at(-1).efforts, []);
  const auth = { headers: { authorization: 'Bearer t' } };
  await env.win.fetch('/backend-api/models?iim=false&include_icons=false&is_gizmo=false', auth);
  await env.win.fetch('/backend-api/settings/user', auth);
  await settle();
  assert.deepEqual(env.of('hello').at(-1).efforts, ['instant']);
  assert.deepEqual(env.of('effort').at(-1), { ...env.of('effort').at(-1), available: false, effort: null });
  // One value is no choice: a set-effort is refused without touching the official page.
  env.fromFrame({ channel: 'slimgpt-ui-v2', v: 2, type: 'set-effort', commandId: 'e1', effort: 'instant' });
  await settle();
  assert.deepEqual(env.of('command-result').map(({ commandId, command, ok, error }) => ({ commandId, command, ok, error })),
    [{ commandId: 'e1', command: 'set-effort', ok: false, error: 'invalid-argument' }]);
  settings.current = { available_options: { backend_reasoning_effort: ['instant', 'standard'] } };
  await env.win.fetch('/backend-api/settings/user', auth);
  await settle();
  assert.deepEqual(env.of('hello').at(-1).efforts, ['instant', 'standard']);
  assert.equal(env.of('effort').at(-1).available, true);
});

test('runtime: logged-out app never offers efforts', async () => {
  const env = fakeWindow(async () => json(har.settingsUser));
  installHook(env.win);
  env.frameListeners.load();
  await env.win.fetch('/backend-anon/me');
  await env.win.fetch('/backend-api/settings/user');
  await settle();
  const hello = env.of('hello').at(-1);
  assert.equal(hello.auth, 'anon');
  assert.deepEqual(hello.efforts, []);
});
