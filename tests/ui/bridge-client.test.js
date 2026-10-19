import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeClient, PAGE_ORIGIN } from '../../src/ui/bridge-client.js';
import { bridgeMessage, UI_CHANNEL } from '../../src/shared/bridge-protocol.js';

function fakeWindow() {
  const listeners = new Set();
  const parent = { posted: [], postMessage(data, origin) { this.posted.push({ data, origin }); } };
  const win = {
    parent,
    addEventListener: (type, fn) => type === 'message' && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    emit: (event) => { for (const fn of listeners) fn(event); },
  };
  return win;
}

test('posts v2 envelopes to the parent with the exact chatgpt.com origin', () => {
  const win = fakeWindow();
  const client = createBridgeClient({ window: win, onMessage() {} });
  assert.equal(client.connected, true);
  client.send('open', { conversationId: 'c1' });
  assert.deepEqual(win.parent.posted, [
    { origin: PAGE_ORIGIN, data: { channel: UI_CHANNEL, v: 2, type: 'ui-ready' } },
    { origin: PAGE_ORIGIN, data: { conversationId: 'c1', channel: UI_CHANNEL, v: 2, type: 'open' } },
  ], 'ui-ready is announced once on mount, before anything else');
  client.destroy();
});

test('accepts only well-formed page messages from the parent and the exact origin', () => {
  const win = fakeWindow();
  const received = [];
  const client = createBridgeClient({ window: win, onMessage: (m) => received.push(m.type) });
  const good = bridgeMessage('page-to-ui', 'hello', { ready: true });
  win.emit({ source: win.parent, origin: PAGE_ORIGIN, data: good });
  win.emit({ source: {}, origin: PAGE_ORIGIN, data: good });
  win.emit({ source: win.parent, origin: 'https://evil.example', data: good });
  win.emit({ source: win.parent, origin: 'https://chatgpt.com.evil.example', data: good });
  win.emit({ source: win.parent, origin: PAGE_ORIGIN, data: { ...good, v: 1 } });
  win.emit({ source: win.parent, origin: PAGE_ORIGIN, data: bridgeMessage('ui-to-page', 'send', {}) });
  assert.deepEqual(received, ['hello']);
  client.destroy();
  win.emit({ source: win.parent, origin: PAGE_ORIGIN, data: good });
  assert.deepEqual(received, ['hello'], 'no delivery after destroy');
});

test('storage requests resolve with the matching storage-result; a read that times out is null, a write {}', async () => {
  const win = fakeWindow();
  const received = [];
  const client = createBridgeClient({ window: win, onMessage: (m) => received.push(m.type), timeoutMs: 20 });
  const pending = client.storageGet(['drafts']);
  const request = win.parent.posted.at(-1).data;
  assert.equal(request.type, 'storage-get');
  assert.deepEqual(request.keys, ['drafts']);
  win.emit({ source: win.parent, origin: PAGE_ORIGIN, data: bridgeMessage('page-to-ui', 'storage-result', { requestId: 'other', values: { drafts: 1 } }) });
  win.emit({ source: win.parent, origin: PAGE_ORIGIN, data: bridgeMessage('page-to-ui', 'storage-result', { requestId: request.requestId, values: { drafts: { a: 'x' } } }) });
  assert.deepEqual(await pending, { drafts: { a: 'x' } });
  assert.deepEqual(await client.storageSet({ settings: {} }), {}, 'unanswered request times out');
  assert.equal(await client.storageGet(['localConversations']), null, 'unreadable storage is not "empty"');
  const failed = client.storageGet(['localConversations']);
  win.emit({ source: win.parent, origin: PAGE_ORIGIN, data: bridgeMessage('page-to-ui', 'storage-result', { requestId: win.parent.posted.at(-1).data.requestId, ok: false, values: {}, error: 'quota' }) });
  assert.equal(await failed, null);
  assert.deepEqual(received, [], 'storage results are not forwarded to the app');
  client.destroy();
});

test('without a parent frame nothing is posted and storage resolves empty', async () => {
  const win = { addEventListener() {}, removeEventListener() {} };
  win.parent = win;
  const client = createBridgeClient({ window: win, onMessage() {} });
  assert.equal(client.connected, false);
  assert.equal(client.send('stop'), false);
  assert.deepEqual(await client.storageGet(['settings']), {});
});
