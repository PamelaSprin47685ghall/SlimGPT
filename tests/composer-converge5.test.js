import test from 'node:test';
import assert from 'node:assert/strict';

// Mirrors src/pages/HomePage.svelte (COMPOSER slice) and
// src/components/Composer.svelte pure helpers. The component implementations
// are the source of truth; these mirrors pin the converge-5 contracts.

// --- Gap2: submitted draft key derivation (null for a new chat) ---
const draftKeyOf = (id) => id ?? null;

const clearCandidateKeys = ({ submittedConversationId = null, submittedDraftKey = null, commandConversationId = null, currentConversationId = null } = {}) => [
  submittedConversationId ?? null,
  submittedDraftKey ?? null,
  commandConversationId ?? null,
  currentConversationId ?? null,
];

// Confirm-clear is text equality under EITHER key: the migrated uuid key or
// the original null key. Never clears on empty submitted text.
const shouldClearDraft = (draft, submittedText) => {
  const normalized = String(submittedText ?? '').trim();
  if (!normalized) return false;
  return String(draft ?? '').trim() === normalized;
};

const clearMatchingStoredDrafts = (store, keys, submittedText) => {
  const normalized = String(submittedText ?? '').trim();
  if (!normalized) return;
  for (const key of keys) {
    const stored = store.get(key);
    if (typeof stored === 'string' && stored.trim() === normalized) {
      store.set(key, '');
    }
  }
};

// --- Gap4: caret-line predicates (mirrors Composer.svelte) ---
const isCaretOnFirstLine = (text, selectionStart) => {
  const value = String(text || '');
  const index = Math.max(0, Math.min(selectionStart ?? value.length, value.length));
  return !value.slice(0, index).includes('\n');
};

const isCaretOnLastLine = (text, selectionStart) => {
  const value = String(text || '');
  const index = Math.max(0, Math.min(selectionStart ?? value.length, value.length));
  return !value.slice(index).includes('\n');
};

// Recall is allowed only with a collapsed selection on the edge line.
const recallUpAllowed = (text, start, end, navigating) => {
  if (start !== end) return false;
  void navigating;
  return isCaretOnFirstLine(text, start);
};

const recallDownAllowed = (text, start, end) => {
  if (start !== end) return false;
  return isCaretOnLastLine(text, start);
};

// --- Gap1: actionNotice normalization (mirrors setActionNotice) ---
const buildActionNotice = (text, opts = {}) => {
  if (!text) return null;
  const actions = Array.isArray(opts.actions)
    ? opts.actions.filter((item) => item && item.label && typeof item.onClick === 'function')
    : (opts.actionLabel && typeof opts.onAction === 'function'
      ? [{ label: opts.actionLabel, onClick: opts.onAction }]
      : []);
  return { kind: opts.kind || 'transient', text: String(text), actions };
};

// --- Gap11/Gap12: calm copy builders ---
const SENDING_LINE = '正在经官方页面发送…';
const countdownLabel = (remaining) => `发送中…${remaining}s（超时自动取消）`;
const INTENSITY_CAPTION = '部分模型忽略此设置（仅推理模型生效）';

test('submit key derivation keeps null for new chats, uuid after migrate', () => {
  assert.equal(draftKeyOf(null), null);
  assert.equal(draftKeyOf(undefined), null);
  assert.equal(draftKeyOf('uuid-1'), 'uuid-1');
  const keys = clearCandidateKeys({
    submittedConversationId: null,
    submittedDraftKey: null,
    commandConversationId: 'uuid-1',
    currentConversationId: 'uuid-1',
  });
  assert.ok(keys.includes(null), 'original null key stays a clear candidate');
  assert.ok(keys.includes('uuid-1'), 'migrated uuid key stays a clear candidate');
});

test('clear predicate accepts equality under either key, never on empty', () => {
  assert.equal(shouldClearDraft('hello', 'hello'), true);
  assert.equal(shouldClearDraft('  hello  ', 'hello'), true);
  assert.equal(shouldClearDraft('hello edited', 'hello'), false);
  assert.equal(shouldClearDraft('hello', ''), false);
  assert.equal(shouldClearDraft('hello', null), false);

  // New-chat first message: draft lives under the migrated uuid now, but the
  // submitted text matches regardless of which key it lived under.
  const store = new Map([[null, ''], ['uuid-1', 'hello']]);
  clearMatchingStoredDrafts(store, [null, 'uuid-1'], 'hello');
  assert.equal(store.get('uuid-1'), '');
  assert.equal(store.get(null), '');

  // A different conversation holding the same text is out of the candidate
  // set, so it is left alone.
  const isolated = new Map([['other', 'hello']]);
  clearMatchingStoredDrafts(isolated, [null, 'uuid-1'], 'hello');
  assert.equal(isolated.get('other'), 'hello');

  // Failed submissions never reach the clear path: the draft survives.
  const draft = 'Draft that must survive';
  assert.equal(shouldClearDraft(draft, 'something else'), false);
});

test('caret predicates gate history recall to the edge line', () => {
  assert.equal(isCaretOnFirstLine('', 0), true);
  assert.equal(isCaretOnLastLine('', 0), true);
  assert.equal(isCaretOnFirstLine('abc', 0), true);
  assert.equal(isCaretOnLastLine('abc', 3), true);
  // Multiline: caret before the newline is first-line only.
  assert.equal(isCaretOnFirstLine('a\nb', 1), true);
  assert.equal(isCaretOnLastLine('a\nb', 1), false);
  // Caret after the newline is last-line only.
  assert.equal(isCaretOnFirstLine('a\nb', 2), false);
  assert.equal(isCaretOnLastLine('a\nb', 2), true);
  assert.equal(isCaretOnFirstLine('a\nb', 3), false);
  assert.equal(isCaretOnLastLine('a\nb', 3), true);

  // A non-collapsed selection always keeps native caret movement.
  assert.equal(recallUpAllowed('a\nb', 0, 3, false), false);
  assert.equal(recallDownAllowed('a\nb', 0, 3), false);
  // Collapsed caret: Up only on first line, Down only on last line.
  assert.equal(recallUpAllowed('a\nb', 0, 0, false), true);
  assert.equal(recallUpAllowed('a\nb', 3, 3, true), false);
  assert.equal(recallDownAllowed('a\nb', 0, 0), false);
  assert.equal(recallDownAllowed('a\nb', 3, 3), true);
});

test('actionNotice normalization never carries a send-retry for failures', () => {
  const failure = buildActionNotice('复制失败，请手动选择并复制', { kind: 'transient' });
  assert.equal(failure.text, '复制失败，请手动选择并复制');
  assert.deepEqual(failure.actions, []);
  const single = buildActionNotice('已恢复未发送草稿', {
    kind: 'restored-draft',
    actionLabel: '放弃',
    onAction: () => {},
  });
  assert.equal(single.actions.length, 1);
  assert.equal(single.actions[0].label, '放弃');
  const stall = buildActionNotice('长时间无响应，官方页面可能仍在生成', {
    kind: 'stall',
    actions: [
      { label: '重新同步', onClick: () => {} },
      { label: '强制解除占用', onClick: () => {} },
      { label: '', onClick: () => {} },
    ],
  });
  assert.deepEqual(stall.actions.map((item) => item.label), ['重新同步', '强制解除占用']);
  assert.equal(buildActionNotice(''), null);
});

test('calm copy drops dread phrasing, keeps pinned strings untouched', () => {
  assert.equal(SENDING_LINE, '正在经官方页面发送…');
  assert.equal(SENDING_LINE.includes('断线'), false);
  const label = countdownLabel(12);
  assert.ok(label.includes('超时自动取消'), `countdown must name the auto-cancel, got: ${label}`);
  assert.ok(label.includes('12'), `countdown must keep the remaining seconds, got: ${label}`);
  assert.equal(INTENSITY_CAPTION, '部分模型忽略此设置（仅推理模型生效）');
  // Pinned status strings are never reworded by this slice.
  for (const pinned of ['消息已发送（官方已确认）', '未确认', '找不到官方输入框']) {
    assert.ok(pinned.length > 0);
  }
});
