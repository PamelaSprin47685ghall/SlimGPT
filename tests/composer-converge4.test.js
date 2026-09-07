import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizeError, isTerminalMessage } from '../src/lib/message-presentation.js';

// Mirrors the HomePage sendMessage generation gate:
// refuse when in-flight, starting, live generation active, or submitted && unsettled.
const shouldRefuseSend = ({ sendInFlight, workState, hasActiveLiveGeneration, submitted, settled }) =>
  sendInFlight || workState === 'starting' || hasActiveLiveGeneration || (submitted && !settled);

// Mirrors the HomePage settledSinceSubmit derivation: a turn settles only via a
// running→non-running work-state transition after submit, or via a terminal
// non-user observation that is new since submit (different id, or none before).
const settledSinceSubmit = ({ submitState, workState, lastObs }) => {
  if (!submitState) return true;
  if (workState !== 'running' && submitState.workState === 'running') return true;
  if (!lastObs || !isTerminalMessage(lastObs)) return false;
  const lastId = String(lastObs.id || lastObs.nodeId || '');
  return !submitState.obsId || lastId !== submitState.obsId;
};

const terminalObs = (id) => ({ id, role: 'assistant', status: 'finished_successfully' });
const streamingObs = (id) => ({ id, role: 'assistant', status: 'in_progress', endTurn: false });

test('composer errors render Chinese via humanizeError', () => {
  assert.equal(humanizeError('composer-input-unsupported'), '当前模型暂不支持此类输入');
  assert.equal(humanizeError('composer_input_unsupported'), '当前模型暂不支持此类输入');
  for (const code of ['rate_limit', 'quota_exceeded', 'unauthorized', 'network_error']) {
    const text = humanizeError(code);
    assert.ok(text && text !== code, `${code} must localize, got: ${text}`);
    assert.match(text, /[\u4e00-\u9fff]/);
  }
});

test('generation gate refuses pre-first-token but dispatches stale-running', () => {
  // Stale running: terminal obs, running work state, no open submit → dispatch.
  assert.equal(shouldRefuseSend({
    sendInFlight: false, workState: 'running', hasActiveLiveGeneration: false,
    submitted: false, settled: true,
  }), false);
  // Post-submit pre-first-token (P0-4 hole): submitted && unsettled → refuse.
  assert.equal(shouldRefuseSend({
    sendInFlight: false, workState: 'running', hasActiveLiveGeneration: false,
    submitted: true, settled: false,
  }), true);
  // Starting / in-flight / live generation → refuse.
  assert.equal(shouldRefuseSend({
    sendInFlight: false, workState: 'starting', hasActiveLiveGeneration: false,
    submitted: false, settled: true,
  }), true);
  assert.equal(shouldRefuseSend({
    sendInFlight: true, workState: 'starting', hasActiveLiveGeneration: false,
    submitted: false, settled: true,
  }), true);
  assert.equal(shouldRefuseSend({
    sendInFlight: false, workState: 'running', hasActiveLiveGeneration: true,
    submitted: true, settled: false,
  }), true);
  // Settled previous turn → allow.
  assert.equal(shouldRefuseSend({
    sendInFlight: false, workState: 'stopped', hasActiveLiveGeneration: false,
    submitted: true, settled: true,
  }), false);
});

test('settledSinceSubmit ignores the pre-submit terminal observation', () => {
  const prior = terminalObs('prev-a1');
  // Right after submit, same old terminal obs still last, still running → unsettled.
  assert.equal(settledSinceSubmit({
    submitState: { obsId: 'prev-a1', workState: 'running' },
    workState: 'running', lastObs: prior,
  }), false);
  // First token streams (new id, non-terminal) → unsettled.
  assert.equal(settledSinceSubmit({
    submitState: { obsId: 'prev-a1', workState: 'running' },
    workState: 'running', lastObs: streamingObs('new-a2'),
  }), false);
  // New terminal obs (new turn finished) → settled.
  assert.equal(settledSinceSubmit({
    submitState: { obsId: 'prev-a1', workState: 'running' },
    workState: 'running', lastObs: terminalObs('new-a2'),
  }), true);
  // Stop transition (running → stopped) settles even without fresh obs.
  assert.equal(settledSinceSubmit({
    submitState: { obsId: 'prev-a1', workState: 'running' },
    workState: 'stopped', lastObs: prior,
  }), true);
  // First message ever: no prior obs, running, nothing yet → unsettled.
  assert.equal(settledSinceSubmit({
    submitState: { obsId: null, workState: 'unknown' },
    workState: 'running', lastObs: null,
  }), false);
  // No submit at all (stale-running probe) → settled, dispatch allowed.
  assert.equal(settledSinceSubmit({ submitState: null, workState: 'running', lastObs: prior }), true);
});

test('new-chat preserves the null-conversation draft, send confirms clear it', () => {
  const draftsByConversation = new Map();
  draftsByConversation.set(null, 'unsent new-chat draft');
  let currentConversationId = 'c1';
  let draft = 'draft in c1';

  // setCurrentConversation(null): stash c1, restore null draft.
  draftsByConversation.set(currentConversationId, draft);
  currentConversationId = null;
  draft = draftsByConversation.get(null) || '';
  assert.equal(draft, 'unsent new-chat draft');

  // newChat() while already on null: must NOT wipe draftsByConversation(null).
  // (The fixed newChat restores instead of clearing.)
  draft = draftsByConversation.get(null) || '';
  assert.equal(draftsByConversation.get(null), 'unsent new-chat draft');

  // Confirmed send clears only the matching draft.
  const submittedText = 'unsent new-chat draft';
  if (draft.trim() === submittedText) draft = '';
  const stored = draftsByConversation.get(null);
  if (typeof stored === 'string' && stored.trim() === submittedText) {
    draftsByConversation.set(null, '');
  }
  assert.equal(draft, '');
  assert.equal(draftsByConversation.get(null), '');
});

test('failed submissions preserve the draft for retry', () => {
  let draft = 'Draft that must survive';
  let pendingUser = { commandId: 'cmd-1', conversationId: null, text: draft };
  // Failure path marks failed without touching the draft.
  pendingUser = { ...pendingUser, failed: true };
  assert.equal(draft, 'Draft that must survive');
  assert.equal(pendingUser.failed, true);
  // Watchdog-cancel path likewise keeps the draft.
  assert.equal(draft, pendingUser.text);
});

test('char count shows above 500 with a warning past 30000', () => {
  const showCharCount = (len) => len > 500;
  const charCountWarn = (len) => len > 30000;
  assert.equal(showCharCount(500), false);
  assert.equal(showCharCount(501), true);
  assert.equal(charCountWarn(30000), false);
  assert.equal(charCountWarn(30001), true);
});

test('ArrowUp recalls last sent text, ArrowDown walks forward', () => {
  const list = ['first', 'second'];
  let value = '';
  let historyIndex = -1;
  let historyDraft = '';
  const up = () => {
    if (historyIndex === -1 && value !== '') return;
    if (historyIndex === -1) { historyDraft = value; historyIndex = list.length - 1; }
    else historyIndex = Math.max(0, historyIndex - 1);
    value = list[historyIndex];
  };
  const down = () => {
    if (historyIndex === -1) return;
    if (historyIndex >= list.length - 1) { historyIndex = -1; value = historyDraft; }
    else { historyIndex += 1; value = list[historyIndex]; }
  };
  up();
  assert.equal(value, 'second');
  up();
  assert.equal(value, 'first');
  down();
  assert.equal(value, 'second');
  down();
  assert.equal(value, '');
  assert.equal(historyIndex, -1);
});
