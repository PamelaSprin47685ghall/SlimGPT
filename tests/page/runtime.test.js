// End-to-end wiring of the MAIN-world runtime against a minimal fake window.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installHook } from '../../src/page/runtime.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ID = '6713a1f0-1234-4abc-8def-0123456789ab';
const UI = (type, fields = {}) => ({ ...fields, channel: 'slimgpt-ui-v2', v: 2, type });
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

function fakeWindow(nativeFetch) {
  const listeners = {};
  const posted = [];
  const frameListeners = {};
  class Element {}
  class HTMLElement extends Element { focus() {} }
  const frame = {
    tagName: 'IFRAME', id: 'slimgpt-takeover-frame', src: `${EXT}/index.html?takeover=1`, dataset: {}, style: {},
    contentWindow: { postMessage: (message, origin) => posted.push({ message, origin }) },
    addEventListener: (type, fn) => { frameListeners[type] = fn; },
  };
  const location = new URL('https://chatgpt.com/');
  const documentElement = { dataset: {}, appendChild() {}, setAttribute() {}, removeAttribute() {} };
  const win = {
    location: {
      get origin() { return location.origin; }, get href() { return location.href; }, get pathname() { return location.pathname; },
    },
    history: {
      state: null,
      pushState(_s, _t, url) { location.href = new URL(url, location).href; },
      replaceState(_s, _t, url) { location.href = new URL(url, location).href; },
    },
    fetch: nativeFetch,
    document: {
      readyState: 'complete', documentElement, body: {},
      getElementById: (id) => (id === frame.id ? frame : null),
      querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }),
      addEventListener() {},
    },
    Element, HTMLElement,
    MutationObserver: class { observe() {} disconnect() {} },
    MouseEvent: class { constructor(type) { this.type = type; } },
    PopStateEvent: class { constructor(type) { this.type = type; } },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
    clearTimeout,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); },
  };
  return {
    win, frame, posted, frameListeners,
    fromFrame: (data, origin = EXT) => {
      for (const fn of listeners.message || []) fn({ source: frame.contentWindow, origin, data });
    },
    types: () => posted.map((p) => p.message.type),
  };
}

test('runtime: hello on frame load, observed history forwarded raw, exact origin on every post', async () => {
  const historyBody = JSON.stringify({ conversation_id: ID, mapping: { a: {} } });
  const env = fakeWindow(async (url) => {
    const path = new URL(url, 'https://chatgpt.com').pathname;
    if (path === `/backend-api/conversation/${ID}`) return new Response(historyBody, { headers: { 'content-type': 'application/json' } });
    if (path === '/backend-api/conversations') return new Response('{"items":[],"total":0}', { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  });
  installHook(env.win);
  installHook(env.win); // idempotent
  assert.equal(env.win.document.documentElement.dataset.slimgptHook, '2');
  assert.equal(env.posted.length, 0, 'queued until the frame loads');
  env.frameListeners.load();
  assert.deepEqual(env.types().slice(0, 3), ['hello', 'location', 'takeover']);
  assert.deepEqual(env.posted[0].message.efforts, []);
  assert.equal(env.posted[0].message.ready, false);

  // Official app fetches with its bearer token: headers learned, history observed.
  const response = await env.win.fetch(`/backend-api/conversation/${ID}`, { headers: { authorization: 'Bearer t' } });
  assert.equal(await response.text(), historyBody);
  await settle();
  const conversation = env.posted.find((p) => p.message.type === 'conversation').message;
  assert.deepEqual([conversation.conversationId, conversation.body, conversation.page, conversation.pages], [ID, historyBody, 1, 1]);
  const hello = env.posted.filter((p) => p.message.type === 'hello').at(-1).message;
  assert.equal(hello.loggedIn, true);
  assert.ok(env.types().includes('conversation-list'), 'list bootstrapped once headers are known');
  assert.ok(env.posted.every((p) => p.origin === EXT));
  assert.ok(env.posted.every((p) => !JSON.stringify(p.message).includes('Bearer')), 'credentials never cross the bridge');
});

test('runtime: commands from a foreign origin are ignored; refresh/open/continue are validated', async () => {
  const requests = [];
  const env = fakeWindow(async (url) => {
    requests.push(new URL(url, 'https://chatgpt.com').pathname);
    return new Response(JSON.stringify({ mapping: {} }), { headers: { 'content-type': 'application/json' } });
  });
  installHook(env.win);
  env.frameListeners.load();
  await env.win.fetch('/backend-api/me', { headers: { authorization: 'Bearer t' } });
  await settle();
  const before = requests.length;

  env.fromFrame(UI('refresh', { conversationId: ID }), 'https://chatgpt.com');
  env.fromFrame(UI('refresh', { conversationId: '../memories' }));
  await settle();
  assert.equal(requests.length, before, 'foreign origin and invalid ids do nothing');

  env.fromFrame(UI('refresh', { conversationId: ID }));
  await settle();
  assert.equal(requests.at(-1), `/backend-api/conversation/${ID}`);
  assert.equal(env.posted.at(-1).message.type, 'conversation');

  env.fromFrame(UI('open', { conversationId: ID }));
  await settle();
  assert.equal(env.win.location.pathname, `/c/${ID}`);
  const location = env.posted.filter((p) => p.message.type === 'location').at(-1).message;
  assert.equal(location.conversationId, ID);

  env.fromFrame(UI('continue', { conversationId: '00000000-0000-4000-8000-000000000000', messageId: 'm' }));
  await settle();
  const result = env.posted.at(-1).message;
  assert.deepEqual([result.type, result.command, result.ok, result.error], ['command-result', 'continue', false, 'invalid-argument']);

  env.fromFrame(UI('send', { commandId: 'c1', text: '   ' }));
  await settle();
  const send = env.posted.at(-1).message;
  assert.deepEqual([send.type, send.commandId, send.ok, send.error], ['send-result', 'c1', false, 'empty-text']);
});
