// v0.4.0 follow-up (2026-10-19): the question shows at once after send
// (not ~0.5–1 s later when the official response headers arrive), streaming
// re-renders only the turn it touches, and the 思考强度 setting.
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

function harness(state = L.initialState()) {
  const h = {
    state, effects: [],
    page(type, fields = {}) { const r = L.reducePage(h.state, { type, ...fields }, P); h.state = r.state; h.effects.push(...r.effects); return h; },
    act(type, fields = {}) { const r = L.reduceAction(h.state, { type, ...fields }, P); h.state = r.state; h.effects.push(...r.effects); return h; },
    posts: (name) => h.effects.filter((e) => e.type === 'post' && e.message === name),
  };
  return h;
}
const signedIn = (efforts = [], body = 'har-history-after-regenerate.json') => harness().page('hello', { ready: true, loggedIn: true, auth: 'user', efforts })
  .page('location', { conversationId: CONV, url: `https://chatgpt.com/c/${CONV}` })
  .act('open', { conversationId: CONV })
  .page('conversation', { conversationId: CONV, body: fixture(body), page: 1, pages: 1 });

test('send: the question and a generating placeholder show at once; the composer empties; stream-start takes over', () => {
  const h = signedIn();
  const before = L.displayTurns(h.state, P).length;
  h.act('draft', { text: '下一个问题' }).act('send', { text: '下一个问题', commandId: 'c1' });
  const shown = L.displayTurns(h.state, P);
  assert.equal(shown.length, before + 1);
  assert.equal(shown.at(-1).user.blocks[0].markdown, '下一个问题');
  assert.equal(shown.at(-1).replies[0].status, 'streaming');
  assert.equal(L.currentDraft(h.state), '', 'composer is empty while it is in flight');
  assert.equal(L.currentTurns(h.state, P).length, before, 'export / branch logic never see the echo');
  assert.equal(L.canSend(h.state).reason, 'pending');
  h.page('send-result', { commandId: 'c1', ok: true, error: null });
  assert.equal(L.displayTurns(h.state, P).length, before + 1, 'still shown between send-result and stream-start');
  assert.equal(L.canSend(h.state).reason, 'pending');
  h.page('stream-start', { streamId: 's', conversationId: CONV, userMessageId: '00000000-0000-4000-8000-0000000000aa', parentMessageId: '00000000-0000-4000-8000-000000000009', resume: false, format: 'sse', userText: '下一个问题' });
  assert.equal(h.state.echo, null);
  const live = L.displayTurns(h.state, P);
  assert.equal(live.length, before + 1, 'the real question replaced the echo (no duplicate)');
  assert.equal(live.at(-1).user.id, '00000000-0000-4000-8000-0000000000aa');
});

test('send failure / timeout: the echo goes away and the text is back in the composer', () => {
  const h = signedIn();
  h.act('draft', { text: '问题' }).act('send', { text: '问题', commandId: 'c1' });
  h.page('send-result', { commandId: 'c1', ok: false, error: 'composer-not-found' });
  assert.equal(h.state.echo, null);
  assert.equal(L.currentDraft(h.state), '问题');
  h.act('send', { text: '问题', commandId: 'c2' }).act('send-timeout', { commandId: 'c2' });
  assert.equal(h.state.echo, null);
  assert.equal(L.currentDraft(h.state), '问题');
  // Confirmed but no stream seen: the next history (with the question) clears it.
  h.act('send', { text: '问题', commandId: 'c3' }).page('send-result', { commandId: 'c3', ok: true, error: null });
  assert.ok(h.state.echo);
  h.page('conversation', { conversationId: CONV, body: fixture('har-history-after-regenerate.json'), page: 1, pages: 1 });
  assert.equal(h.state.echo, null);
});

test('stabilizeTurns keeps unchanged turn objects, replaces changed ones, and returns the old array when nothing changed', () => {
  const m = (id) => ({ id });
  const branch = (index, count, ids) => ({ index, count, siblingIds: ids });
  const turn = (user, replies, rb = branch(0, 1, ['x'])) => ({ user, replies, userBranch: branch(0, 0, []), replyBranch: rb });
  const u1 = m('u1'); const a1 = m('a1'); const u2 = m('u2'); const a2 = m('a2');
  const first = [turn(u1, [a1]), turn(u2, [a2])];
  const same = stabilizeTurns(first, [turn(u1, [a1]), turn(u2, [a2])]);
  assert.equal(same, first);
  const a2b = m('a2');
  const next = stabilizeTurns(first, [turn(u1, [a1]), turn(u2, [a2b])]);
  assert.notEqual(next, first);
  assert.equal(next[0], first[0], 'untouched turn kept');
  assert.notEqual(next[1], first[1], 'streaming turn replaced');
  const branched = stabilizeTurns(next, [turn(u1, [a1], branch(1, 2, ['x', 'y'])), next[1]]);
  assert.notEqual(branched[0], next[0], 'a branch change is a change');
});

test('a streamed delta changes only the streaming turn (real SSE)', () => {
  const h = signedIn([], 'har-history-after-stop.json');
  h.page('stream-start', { streamId: 's', conversationId: CONV, userMessageId: null, parentMessageId: USER, resume: false, format: 'sse' });
  let shown = stabilizeTurns([], L.displayTurns(h.state, P));
  let updates = 0;
  for (const chunk of regenSse.split(/(?<=\n\n)/)) {
    h.page('stream-chunk', { streamId: 's', chunk });
    const next = stabilizeTurns(shown, L.displayTurns(h.state, P));
    if (next !== shown) updates += 1;
    assert.ok(next.filter((t, i) => t !== shown[i]).length <= 1);
    shown = next;
  }
  assert.ok(updates > 10, `deltas reach the thread (${updates})`);
});

test('effort: re-applied only when there is a choice; reported effort and failures are kept', () => {
  const one = harness({ ...L.initialState(), settings: { effort: 'instant' } }).page('hello', { ready: true, loggedIn: true, auth: 'user', efforts: ['instant'] });
  assert.equal(one.posts('set-effort').length, 0, 'a single value is no choice');
  const two = harness({ ...L.initialState(), settings: { effort: 'extended' } }).page('effort', { available: true, effort: 'standard' })
    .page('hello', { ready: true, loggedIn: true, auth: 'user', efforts: ['standard', 'extended'] });
  assert.deepEqual(two.posts('set-effort').map((e) => e.fields), [{ effort: 'extended' }]);
  assert.deepEqual(two.state.effort, { available: true, current: 'standard' });
  two.page('command-result', { commandId: null, command: 'set-effort', ok: false, error: 'control-not-found' });
  assert.equal(L.effortErrorText(two.state.effortError), '官方界面没有找到思考强度选项');
  two.page('command-result', { commandId: null, command: 'stop', ok: false, error: 'control-not-found' });
  assert.equal(two.state.effortError, 'control-not-found', 'other commands do not touch it');
  two.page('effort', { available: true, effort: 'extended' }).page('command-result', { command: 'set-effort', ok: true, error: null });
  assert.deepEqual([two.state.effort.current, two.state.effortError], ['extended', null]);
  const same = harness({ ...L.initialState(), settings: { effort: 'extended' } }).page('effort', { available: true, effort: 'extended' })
    .page('hello', { ready: true, loggedIn: true, auth: 'user', efforts: ['standard', 'extended'] });
  assert.equal(same.posts('set-effort').length, 0, 'already in effect');
  const anon = harness({ ...L.initialState(), settings: { effort: 'extended' } }).page('hello', { ready: true, loggedIn: false, auth: 'anon', efforts: [] });
  assert.equal(anon.posts('set-effort').length, 0);
});
