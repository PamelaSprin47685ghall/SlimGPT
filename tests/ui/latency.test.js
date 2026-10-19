// Perceived latency (2026-10-19): the question shows the moment it is sent,
// and a streaming delta re-renders only its own turn. Plus the effort
// (思考强度) state. Real (sanitized) HAR stream where it matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';
import * as L from '../../src/ui/state/logic.js';
import { stabilizeTurns } from '../../src/ui/lib/stable-turns.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8');
const CONV = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const regenSse = fixture('streams/har-regenerate-after-stop.sse');
const afterStop = fixture('har-history-after-stop.json');
const afterRegen = fixture('har-history-after-regenerate.json');

function harness(state = L.initialState()) {
  const effects = [];
  const h = {
    state, effects,
    page(message) { const r = L.reducePage(h.state, message, P); h.state = r.state; effects.push(...r.effects); return h; },
    act(action) { const r = L.reduceAction(h.state, action, P); h.state = r.state; effects.push(...r.effects); return h; },
  };
  return h;
}
const hello = (efforts = []) => ({ type: 'hello', ready: true, loggedIn: true, auth: 'user', efforts });
const opened = () => harness().page(hello()).page({ type: 'location', conversationId: CONV, url: `https://chatgpt.com/c/${CONV}` })
  .act({ type: 'open', conversationId: CONV }).page({ type: 'conversation', conversationId: CONV, body: afterStop, page: 1, pages: 1 });
const lastTurn = (h) => L.displayTurns(h.state, P).at(-1);

test('send: the question is shown at once (with a generating placeholder) and leaves the composer', () => {
  const h = opened();
  const before = L.displayTurns(h.state, P).length;
  h.act({ type: 'draft', text: '再讲讲暗能量' }).act({ type: 'send', text: '再讲讲暗能量', commandId: 'c1' });
  const turns = L.displayTurns(h.state, P);
  assert.equal(turns.length, before + 1);
  assert.equal(lastTurn(h).user.blocks[0].markdown, '再讲讲暗能量');
  assert.equal(lastTurn(h).replies[0].status, 'streaming');
  assert.equal(L.currentDraft(h.state), '', 'composer cleared like the official one');
  assert.equal(L.canSend(h.state).reason, 'pending');
  assert.equal(L.currentTurns(h.state, P).length, before, 'export / branches never see the echo');
  // Confirmed, stream not started yet: still shown, still not sendable.
  h.page({ type: 'send-result', commandId: 'c1', ok: true, error: null });
  assert.equal(lastTurn(h).user.blocks[0].markdown, '再讲讲暗能量');
  assert.equal(L.canSend(h.state).reason, 'pending');
  // The official stream starts: the real user message replaces the echo.
  h.page({ type: 'stream-start', streamId: 's', conversationId: CONV, userMessageId: '00000000-0000-4000-8000-0000000000aa', parentMessageId: '00000000-0000-4000-8000-000000000003', resume: false, format: 'sse', userText: '再讲讲暗能量' });
  assert.equal(h.state.echo, null);
  assert.ok(!L.displayTurns(h.state, P).some((turn) => turn.user?.id.startsWith('echo-')));
  assert.equal(lastTurn(h).user.id, '00000000-0000-4000-8000-0000000000aa');
});

test('send failure brings the text back to the composer and drops the echo; a history without a stream clears it too', () => {
  const h = opened();
  h.act({ type: 'draft', text: '问题' }).act({ type: 'send', text: '问题', commandId: 'c1' });
  h.page({ type: 'send-result', commandId: 'c1', ok: false, error: 'composer-not-found' });
  assert.equal(h.state.echo, null);
  assert.equal(L.currentDraft(h.state), '问题');
  h.act({ type: 'send', text: '问题', commandId: 'c2' }).page({ type: 'send-result', commandId: 'c2', ok: true, error: null });
  h.page({ type: 'conversation', conversationId: CONV, body: afterRegen, page: 1, pages: 1 });
  assert.equal(h.state.echo, null, 'canonical history arrived for that conversation');
  h.act({ type: 'send', text: 'x', commandId: 'c3' }).page({ type: 'send-result', commandId: 'c3', ok: true, error: null });
  h.act({ type: 'send-timeout', commandId: 'c3' });
  assert.equal(h.state.echo, null, 'confirmed but never streamed: the timeout clears it quietly');
  assert.equal(h.state.sendError, null);
});

test('a new chat: the echo is shown on the new-chat view and handed over to the stream', () => {
  const h = harness().page(hello()).page({ type: 'location', conversationId: null, url: 'https://chatgpt.com/' });
  h.act({ type: 'send', text: '写一篇 800 字的文章介绍宇宙大炸', commandId: 'n1' });
  assert.equal(L.displayTurns(h.state, P).length, 1);
  h.page({ type: 'send-result', commandId: 'n1', ok: true, error: null })
    .page({ type: 'stream-start', streamId: 's', conversationId: null, userMessageId: USER, parentMessageId: 'client-created-root', resume: false, format: 'sse', userText: '写一篇 800 字的文章介绍宇宙大炸' });
  for (let i = 0; i < regenSse.length; i += 400) h.page({ type: 'stream-chunk', streamId: 's', chunk: regenSse.slice(i, i + 400) });
  assert.equal(h.state.currentId, CONV);
  assert.ok(!L.displayTurns(h.state, P).some((turn) => turn.user?.id.startsWith('echo-')));
});

test('streaming the real HAR SSE: earlier turns keep their identity, only the streaming turn changes', () => {
  const h = opened();
  h.page({ type: 'stream-start', streamId: 's', conversationId: CONV, userMessageId: null, parentMessageId: USER, resume: false, format: 'sse' });
  let shown = stabilizeTurns([], L.displayTurns(h.state, P));
  const events = regenSse.split(/(?<=\n\n)/);
  let changedOther = 0;
  let changedLast = 0;
  for (const chunk of events) {
    h.page({ type: 'stream-chunk', streamId: 's', chunk });
    const next = stabilizeTurns(shown, L.displayTurns(h.state, P));
    if (next.length === shown.length) {
      for (let i = 0; i < next.length - 1; i++) if (next[i] !== shown[i]) changedOther += 1;
      if (next.at(-1) !== shown.at(-1)) changedLast += 1;
    }
    shown = next;
  }
  assert.equal(changedOther, 0);
  assert.ok(changedLast > 10, `streaming turn updates (${changedLast})`);
  assert.equal(stabilizeTurns(shown, L.displayTurns(h.state, P)), shown, 'nothing changed: same array');
});

test('effort: a saved choice is re-applied only when the account offers a real choice; reports and failures', () => {
  const single = harness({ ...L.initialState(), settings: { effort: 'instant' } }).page(hello(['instant']));
  assert.ok(!single.effects.some((e) => e.message === 'set-effort'), 'one value: nothing to choose');
  const h = harness({ ...L.initialState(), settings: { effort: 'extended' } });
  h.page({ type: 'effort', available: true, effort: 'standard' });
  h.page(hello(['standard', 'extended']));
  assert.deepEqual(h.effects.filter((e) => e.message === 'set-effort').map((e) => e.fields), [{ effort: 'extended' }]);
  h.page({ type: 'command-result', commandId: null, command: 'set-effort', ok: false, error: 'control-not-found' });
  assert.equal(L.effortErrorText(h.state.effortError), '官方界面没有找到思考强度选项');
  h.page({ type: 'effort', available: true, effort: 'extended' });
  assert.deepEqual(h.state.effort, { available: true, current: 'extended' });
  h.page({ type: 'command-result', commandId: null, command: 'set-effort', ok: true, error: null });
  assert.equal(h.state.effortError, null);
  const again = harness({ ...L.initialState(), settings: { effort: 'extended' } }).page({ type: 'effort', available: true, effort: 'extended' }).page(hello(['standard', 'extended']));
  assert.ok(!again.effects.some((e) => e.message === 'set-effort'), 'already in effect');
});
