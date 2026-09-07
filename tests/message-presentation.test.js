import test from 'node:test';
import assert from 'node:assert/strict';
import { formatModelLabel, isMessageStreaming, shouldSubmitOnEnter } from '../src/lib/message-presentation.js';
import { copyText } from '../src/lib/clipboard.js';

test('model labels never invent a different family or version', () => {
  assert.equal(formatModelLabel('gpt-5.4-pro'), 'GPT-5.4-pro');
  assert.equal(formatModelLabel('text-o3-pro-latest'), 'o3-pro');
  assert.equal(formatModelLabel('custom-prototype-model'), 'custom-prototype-model');
  assert.equal(formatModelLabel('o1-preview'), 'o1-preview');
  assert.equal(formatModelLabel('o3-mini'), 'o3-mini');
  assert.equal(formatModelLabel('o3-pro'), 'o3-pro');
  assert.equal(formatModelLabel('g-12345678-code-reviewer'), 'GPT · code reviewer');
  assert.equal(formatModelLabel('gizmo-translator'), 'GPT · translator');
  assert.equal(formatModelLabel('Web'), '');
  assert.equal(formatModelLabel('Mobile'), '');
});

test('all terminal message states stop streaming UI', () => {
  for (const status of ['failed', 'finished_successfully', 'finished', 'completed', 'cancelled', 'canceled', 'interrupted', 'incomplete']) {
    assert.equal(isMessageStreaming({ live: true, status }), false, status);
  }
  assert.equal(isMessageStreaming({ live: true, endTurn: true }), false);
  assert.equal(isMessageStreaming({ live: true, error: true }), false);
  assert.equal(isMessageStreaming({ live: true, status: 'in_progress' }), true);
});

test('IME commit and Shift+Enter never submit the composer', () => {
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }), true);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true }), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', isComposing: true }), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', keyCode: 229 }), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, true), false);
});

test('clipboard writes preserve exact whitespace and unicode', async () => {
  let copied;
  await copyText('  中文\n\n', { navigator: { clipboard: { writeText: async (text) => { copied = text; } } } });
  assert.equal(copied, '  中文\n\n');
});

function fallbackEnvironment(success) {
  const calls = [];
  const active = { isConnected: true, selectionStart: 1, selectionEnd: 3, selectionDirection: 'forward',
    focus: () => calls.push('restore-focus'), setSelectionRange: (...range) => calls.push(range) };
  const textarea = { style: {}, setAttribute() {}, focus() {}, select() {}, remove: () => calls.push('remove') };
  return { calls, textarea, environment: {
    navigator: { clipboard: { writeText: async () => { throw new Error('permission denied'); } } },
    document: { activeElement: active, body: { appendChild() {} }, createElement: () => textarea,
      execCommand: () => success },
  } };
}

test('denied clipboard API falls back, cleans up, and restores composer selection', async () => {
  const { calls, textarea, environment } = fallbackEnvironment(true);
  await copyText('fallback', environment);
  assert.equal(textarea.value, 'fallback');
  assert.deepEqual(calls, ['remove', 'restore-focus', [1, 3, 'forward']]);
});

test('failed fallback rejects visibly rather than claiming a successful copy', async () => {
  const { calls, environment } = fallbackEnvironment(false);
  await assert.rejects(copyText('text', environment), /复制失败/);
  assert.equal(calls[0], 'remove');
  await assert.rejects(copyText('text', {}), /剪贴板/);
});
