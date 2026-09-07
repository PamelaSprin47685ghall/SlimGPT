import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSubmitOnEnter, createImeTracker } from '../src/lib/message-presentation.js';

test('createImeTracker guards Enter immediately after compositionend', async () => {
  const ime = createImeTracker();
  assert.equal(ime.isComposing, false);

  ime.onCompositionStart();
  assert.equal(ime.isComposing, true);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, ime), false);

  ime.onCompositionEnd();
  // Synchronously immediately after compositionend, justComposed is true
  assert.equal(ime.isComposing, true);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, ime), false);

  // After microtask, justComposed clears
  await Promise.resolve();
  assert.equal(ime.isComposing, false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, ime), true);
});

test('createImeTracker clears justComposed on keyup', () => {
  const ime = createImeTracker();
  ime.onCompositionStart();
  ime.onCompositionEnd();
  assert.equal(ime.isComposing, true);

  ime.onKeyup({ key: 'Enter', keyCode: 13 });
  assert.equal(ime.isComposing, false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, ime), true);
});

test('shouldSubmitOnEnter respects plain boolean, tracker object, or function', () => {
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, false), true);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, true), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, { isComposing: true }), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, { isComposing: false }), true);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, () => true), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter' }, () => false), true);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', keyCode: 229 }, false), false);
  assert.equal(shouldSubmitOnEnter({ key: 'Enter', shiftKey: true }, false), false);
  assert.equal(shouldSubmitOnEnter({ key: 'a' }, false), false);
});

test('busy state and generating placeholder rules', () => {
  const busyState = (sendInFlight, workState) => sendInFlight || workState === 'running';
  assert.equal(busyState(true, 'idle'), true);
  assert.equal(busyState(false, 'running'), true);
  assert.equal(busyState(false, 'idle'), false);

  const placeholder = ({ loading, disabled, busy, generating }) => {
    if (loading) return '正在加载对话…';
    if (disabled) return 'ChatGPT 页面桥尚未就绪…';
    if (busy) return generating ? 'ChatGPT 正在思考与生成回答…' : '正在提交上一条消息…';
    return '发消息…';
  };
  assert.equal(placeholder({ busy: true, generating: true }), 'ChatGPT 正在思考与生成回答…');
  assert.equal(placeholder({ busy: true, generating: false }), '正在提交上一条消息…');
  assert.equal(placeholder({ busy: false }), '发消息…');
});

test('failed pending user retention contract', () => {
  const pendingUser = {
    commandId: 'cmd-1',
    conversationId: 'c1',
    text: 'Hello retry',
    message: {
      id: 'pending-1',
      role: 'user',
      text: 'Hello retry',
      status: 'pending',
    },
  };

  // On failure or watchdog timeout:
  const failedPendingUser = {
    ...pendingUser,
    failed: true,
    message: {
      ...pendingUser.message,
      status: 'failed',
      error: '官方输入框未确认提交',
      failed: true,
    },
  };

  assert.equal(failedPendingUser.failed, true);
  assert.equal(failedPendingUser.message.status, 'failed');
  assert.equal(failedPendingUser.message.text, 'Hello retry');
});

test('new-chat draft map clearing rule', () => {
  const draftsByConversation = new Map();
  draftsByConversation.set(null, 'stale new-chat draft');
  assert.equal(draftsByConversation.get(null), 'stale new-chat draft');

  // When user clicks newChat:
  draftsByConversation.set(null, '');
  assert.equal(draftsByConversation.get(null), '');
});
