import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeMessage, acceptBridgeMessage, PAGE_TO_UI, UI_TO_PAGE } from '../../src/shared/bridge-protocol.js';
import { isExtensionOrigin, isFromExactly, originOf } from '../../src/shared/origin.js';
import { acceptStorageCommand, runStorageCommand } from '../../src/page/bridge-core.js';
import { acceptUiCommand, createPageLink, resolveFrame } from '../../src/page/link.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const frameWindow = { name: 'frame' };
const ui = (type, fields) => bridgeMessage('ui-to-page', type, fields);

test('origin helpers handle extension schemes exactly', () => {
  assert.equal(originOf(`${EXT}/index.html?takeover=1`), EXT);
  assert.equal(originOf('moz-extension://1234-abcd/index.html'), 'moz-extension://1234-abcd');
  assert.equal(originOf('https://chatgpt.com/c/x'), 'https://chatgpt.com');
  assert.equal(originOf('not a url'), null);
  assert.equal(isExtensionOrigin(EXT), true);
  assert.equal(isExtensionOrigin('safari-web-extension://ABC-123'), true);
  assert.equal(isExtensionOrigin('https://chatgpt.com'), false);
  assert.equal(isExtensionOrigin(`${EXT}/`), false);
  assert.equal(isExtensionOrigin('null'), false);
  assert.equal(isFromExactly({ source: frameWindow, origin: EXT }, frameWindow, EXT), true);
  assert.equal(isFromExactly({ source: frameWindow, origin: `${EXT}x` }, frameWindow, EXT), false);
  assert.equal(isFromExactly({ source: {}, origin: EXT }, frameWindow, EXT), false);
  assert.equal(isFromExactly({ source: frameWindow, origin: 'null' }, frameWindow, 'null'), false);
  assert.equal(isFromExactly({ source: undefined, origin: undefined }, undefined, undefined), false);
});

test('contract lists are disjoint per direction and messages round-trip', () => {
  for (const type of UI_TO_PAGE) assert.ok(acceptBridgeMessage(ui(type), 'ui-to-page'));
  for (const type of PAGE_TO_UI) assert.ok(acceptBridgeMessage(bridgeMessage('page-to-ui', type), 'page-to-ui'));
  assert.equal(acceptBridgeMessage(ui('send'), 'page-to-ui'), null);
  assert.equal(acceptBridgeMessage({ ...ui('send'), v: 1 }, 'ui-to-page'), null);
  assert.equal(acceptBridgeMessage({ ...ui('send'), type: 'eval' }, 'ui-to-page'), null);
  assert.equal(bridgeMessage('ui-to-page', 'send', { type: 'spoof', channel: 'x' }).type, 'send');
});

test('page hook accepts commands only from the extension frame at its exact origin', () => {
  const frame = { element: { contentWindow: frameWindow }, origin: EXT };
  const event = (data, source = frameWindow, origin = EXT) => ({ data, source, origin });
  assert.equal(acceptUiCommand(event(ui('send', { text: 'x' })), frame).type, 'send');
  assert.equal(acceptUiCommand(event(ui('send'), {}), frame), null, 'other window');
  assert.equal(acceptUiCommand(event(ui('send'), frameWindow, 'https://chatgpt.com'), frame), null, 'page origin');
  assert.equal(acceptUiCommand(event(ui('send'), frameWindow, 'chrome-extension://otherextension'), frame), null);
  assert.equal(acceptUiCommand(event(ui('storage-get', { requestId: 'r', keys: [] })), frame), null, 'storage is the bridge’s job');
  assert.equal(acceptUiCommand(event(bridgeMessage('page-to-ui', 'hello')), frame), null);
  assert.equal(acceptUiCommand(event(ui('send')), null), null);
});

test('resolveFrame ignores page-made iframes that are not extension frames', () => {
  const doc = (element) => ({ getElementById: () => element });
  assert.equal(resolveFrame(doc(null)), null);
  assert.equal(resolveFrame(doc({ tagName: 'IFRAME', src: 'https://chatgpt.com/evil' })), null);
  assert.equal(resolveFrame(doc({ tagName: 'DIV', src: `${EXT}/index.html` })), null);
  assert.equal(resolveFrame(doc({ tagName: 'IFRAME', src: `${EXT}/index.html?takeover=1` })).origin, EXT);
});

test('bridge accepts storage commands only from the frame at the exact extension origin', () => {
  const ok = { source: frameWindow, origin: EXT, data: ui('storage-get', { requestId: 'r1', keys: ['drafts'] }) };
  assert.equal(acceptStorageCommand(ok, frameWindow, EXT).requestId, 'r1');
  assert.equal(acceptStorageCommand({ ...ok, origin: 'https://chatgpt.com' }, frameWindow, EXT), null);
  assert.equal(acceptStorageCommand({ ...ok, source: {} }, frameWindow, EXT), null);
  assert.equal(acceptStorageCommand({ ...ok, data: ui('send') }, frameWindow, EXT), null);
  assert.equal(acceptStorageCommand({ ...ok, data: ui('storage-get', { keys: [] }) }, frameWindow, EXT), null, 'requestId required');
  assert.equal(acceptStorageCommand(ok, null, EXT), null, 'frame not mounted');
});

test('storage proxy filters keys and answers storage-result{requestId, values}', async () => {
  const store = { drafts: { a: 'x' }, settings: { effort: 'high' }, secret: 'nope' };
  const storage = {
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
    set: async (values) => Object.assign(store, values),
  };
  const got = await runStorageCommand(storage, { type: 'storage-get', requestId: 'r', keys: ['drafts', 'secret', 'settings'] });
  assert.equal(got.type, 'storage-result');
  assert.equal(got.channel, 'slimgpt-page-v2');
  assert.deepEqual({ requestId: got.requestId, ok: got.ok, values: got.values }, { requestId: 'r', ok: true, values: { drafts: { a: 'x' }, settings: { effort: 'high' } } });
  const set = await runStorageCommand(storage, { type: 'storage-set', requestId: 's', values: { drafts: {}, secret: 'overwritten?' } });
  assert.equal(set.ok, true);
  assert.deepEqual(store.drafts, {});
  assert.equal(store.secret, 'nope');
  const failing = await runStorageCommand({ get: async () => { throw new Error('quota'); } }, { type: 'storage-get', requestId: 'f', keys: ['drafts'] });
  assert.deepEqual([failing.ok, failing.error, failing.values], [false, 'quota', {}]);
});

function fakeLinkWindow() {
  const posted = [];
  const listeners = {};
  const frameListeners = {};
  const frame = {
    tagName: 'IFRAME',
    src: `${EXT}/index.html?takeover=1`,
    contentWindow: { postMessage: (message, origin) => posted.push({ message, origin }) },
    addEventListener: (type, fn) => { frameListeners[type] = fn; },
  };
  const win = {
    document: { getElementById: () => frame, addEventListener() {}, documentElement: {} },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  return { win, frame, posted, listeners, frameListeners };
}

test('page link queues until the frame loads, then posts with the exact extension origin', () => {
  const { win, frame, posted, listeners, frameListeners } = fakeLinkWindow();
  const commands = [];
  let readyCalls = 0;
  const link = createPageLink({ window: win, onCommand: (m) => commands.push(m.type), onUiReady: () => { readyCalls += 1; } });
  link.install();
  link.post('location', { url: 'https://chatgpt.com/', conversationId: null });
  link.post('conversation', { conversationId: 'x', body: '{}', page: 1, pages: 1 });
  assert.equal(posted.length, 0);
  frameListeners.load();
  assert.equal(readyCalls, 1);
  assert.deepEqual(posted.map((p) => [p.message.type, p.origin]), [['conversation', EXT]], 'stale state dropped, data kept');
  link.post('stream-chunk', { streamId: 's', chunk: 'x' });
  assert.equal(posted.at(-1).origin, EXT);
  listeners.message({ source: frame.contentWindow, origin: EXT, data: ui('refresh', { conversationId: 'x' }) });
  listeners.message({ source: frame.contentWindow, origin: 'https://chatgpt.com', data: ui('send') });
  listeners.message({ source: frame.contentWindow, origin: EXT, data: ui('ui-ready') });
  assert.deepEqual(commands, ['refresh']);
  assert.equal(readyCalls, 2);
});

test('queue overflow never delivers a partial stream: data dropped, open streams closed with ok=false', () => {
  const { win, posted, frameListeners } = fakeLinkWindow();
  const link = createPageLink({ window: win, onCommand() {}, onUiReady() {} });
  link.install();
  link.post('hello', { ready: true });
  link.post('stream-start', { streamId: 's1' });
  link.post('stream-chunk', { streamId: 's1', chunk: 'x'.repeat(33 * 1024 * 1024) });
  frameListeners.load();
  assert.deepEqual(posted.map((p) => [p.message.type, p.message.streamId, p.message.ok]), [
    ['stream-end', 's1', false],
  ]);
});
