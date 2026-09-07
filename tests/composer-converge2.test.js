import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSubmitOnEnter } from '../src/lib/message-presentation.js';
import { matchesPendingTurn } from '../src/lib/pending-turn.js';
import { copyText } from '../src/lib/clipboard.js';
import { createTransport } from '../src/lib/transport.js';

test('shouldSubmitOnEnter rejects Option+Enter but keeps IME guards', () => {
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', altKey: true }, false), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, false), true);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true }, false), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', keyCode: 229 }, false), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, true), false);
});

test('new-chat pending never binds to a known conversation without request evidence', () => {
  const pending = { commandId: 'cmd-1', conversationId: null, text: 'hello' };
  assert.equal(matchesPendingTurn(pending, 'real-convo-id', {}), false);
  assert.equal(
    matchesPendingTurn(pending, 'real-convo-id', { conversationRequest: false }),
    false,
  );
  // A null-pending never binds to a real server id on a bare request flag without corroborating evidence.
  assert.equal(
    matchesPendingTurn(pending, 'real-convo-id', { conversationRequest: true }),
    false,
  );
  // Corroborated evidence (session/alias/user) binds successfully to a real server id.
  assert.equal(
    matchesPendingTurn({ ...pending, transportSessionId: 'sess' }, 'real-convo-id', { transportSessionId: 'sess' }),
    true,
  );
  // Provisional conversation id ('new' or WEB:*) binds with request evidence.
  assert.equal(
    matchesPendingTurn(pending, 'new', { conversationRequest: true }),
    true,
  );
});

test('bound pending still rejects a conflicting conversation', () => {
  const pending = { commandId: 'cmd-1', conversationId: 'c1', text: 'hello' };
  assert.equal(matchesPendingTurn(pending, 'c2', { conversationRequest: true }), false);
});

test('clipboard fallback uses an editable textarea with setSelectionRange', async () => {
  let created = null;
  const fakeDocument = {
    body: { appendChild: (el) => { created = el; } },
    activeElement: null,
    getSelection: () => null,
    createElement: () => ({
      value: '',
      readOnly: true,
      style: {},
      setAttribute: () => {},
      focus: () => {},
      select: () => {},
      setSelectionRange: function (start, end) { this.range = [start, end]; },
      remove: () => {},
    }),
    execCommand: () => true,
  };
  await copyText('hello ios', { navigator: {}, document: fakeDocument });
  assert.ok(created, 'fallback textarea is created');
  assert.equal(created.readOnly, false);
  assert.deepEqual(created.range, [0, 'hello ios'.length]);
});

test('transport exposes stopGeneration as a stop-generation command', () => {
  const posted = [];
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    parent: { postMessage: (message, origin) => { posted.push({ message, origin }); } },
  };
  try {
    const transport = createTransport();
    assert.equal(typeof transport.stopGeneration, 'function');
    transport.stopGeneration();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].message.payload.type, 'stop-generation');
  } finally {
    delete globalThis.window;
  }
});

test('generation mutual-exclusion submit rule', () => {
  const canSubmit = ({ disabled, loading, busy, generating, value }) =>
    !disabled && !loading && !busy && !generating && Boolean(String(value || '').trim());
  assert.equal(canSubmit({ generating: true, value: 'hi' }), false);
  assert.equal(canSubmit({ busy: true, value: 'hi' }), false);
  assert.equal(canSubmit({ generating: false, busy: false, value: 'hi' }), true);
  assert.equal(canSubmit({ generating: false, busy: false, value: '  ' }), false);
});
