import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../../src/ui/state/logic.js';
import { createFakeProtocol, canonical } from './fake-protocol.js';

function harness(state = L.initialState()) {
  const P = createFakeProtocol();
  const effects = [];
  const h = {
    P, effects,
    state,
    page(type, fields = {}) { const r = L.reducePage(h.state, { type, ...fields }, P); h.state = r.state; effects.push(...r.effects); return r; },
    act(type, fields = {}) { const r = L.reduceAction(h.state, { type, ...fields }, P); h.state = r.state; effects.push(...r.effects); return r; },
    posts: (name) => effects.filter((e) => e.type === 'post' && (!name || e.message === name)),
    ready() { h.page('hello', { ready: true, loggedIn: true }); return h; },
  };
  return h;
}

const TREE = [['root', null, 'system'], ['u1', 'root', 'user'], ['a1', 'u1'], ['a2', 'u1'], ['u2', 'a2', 'user'], ['a3', 'u2']];

test('reducers never mutate their input state', () => {
  const h = harness().ready();
  const frozen = h.state;
  const snapshot = JSON.stringify(frozen);
  h.act('open', { conversationId: 'c1' });
  h.page('conversation', { conversationId: 'c1', body: canonical('c1', TREE, 'a3'), page: 1, pages: 1 });
  h.act('draft', { text: 'hi' });
  assert.equal(JSON.stringify(frozen), snapshot);
  assert.notEqual(h.state, frozen);
});

test('hello sets bridge status and re-applies a supported saved effort', () => {
  const h = harness({ ...L.initialState(), settings: { effort: 'heavy' } });
  h.page('hello', { ready: true, loggedIn: true, efforts: ['light', 'heavy'] });
  assert.deepEqual(h.state.bridge, { connected: true, ready: true, loggedIn: true, auth: 'unknown', timedOut: false });
  assert.deepEqual(h.posts('set-effort').map((e) => e.fields), [{ effort: 'heavy' }]);
  const h2 = harness({ ...L.initialState(), settings: { effort: 'heavy' } });
  h2.page('hello', { ready: true, loggedIn: true });
  assert.equal(h2.posts('set-effort').length, 0, 'not sent when the page does not offer efforts');
  assert.deepEqual(h2.state.efforts, []);
});

test('status line: offline > bridge > login > sync error > loading, with one action', () => {
  const h = harness();
  assert.equal(L.statusLine(h.state).text, '连接中…');
  h.act('bridge-timeout');
  assert.equal(L.statusLine(h.state).text, 'ChatGPT 页面桥尚未就绪');
  h.act('online', { online: false });
  assert.equal(L.statusLine(h.state).text, '网络离线');
  h.act('online', { online: true });
  h.page('hello', { ready: true, loggedIn: false });
  assert.equal(L.statusLine(h.state).action.type, 'show-official');
  h.page('hello', { ready: true, loggedIn: true });
  assert.equal(L.statusLine(h.state), null);
  h.act('open', { conversationId: 'c1' });
  assert.equal(L.statusLine(h.state).text, '正在同步对话…');
  h.page('conversation-error', { conversationId: 'c1', code: 'rate-limit', retryAfterSec: 30 });
  const status = L.statusLine(h.state);
  assert.equal(status.tone, 'error');
  assert.match(status.text, /30 秒/);
  assert.deepEqual(status.action, { label: '重试同步', type: 'retry-sync' });
  h.act('retry-sync');
  assert.deepEqual(h.posts('refresh').at(-1).fields, { conversationId: 'c1' });
  assert.equal(h.state.sync.c1.state, 'loading');
});

test('opening a conversation posts open and ignores stale locations until it arrives', () => {
  const h = harness().ready();
  h.act('open', { conversationId: 'c2' });
  assert.deepEqual(h.posts('open').at(-1).fields, { conversationId: 'c2' });
  h.page('location', { url: 'x', conversationId: 'c1' });
  assert.equal(h.state.currentId, 'c2', 'stale location must not switch back');
  h.page('location', { url: 'x', conversationId: 'c2' });
  assert.equal(h.state.opening, undefined);
  h.page('location', { url: 'x', conversationId: 'c9' });
  assert.equal(h.state.currentId, 'c9', 'official navigation is followed afterwards');
  assert.deepEqual(h.posts('refresh').at(-1).fields, { conversationId: 'c9' }, 'unknown conversation is fetched');
  h.act('open', { conversationId: null });
  assert.equal(h.state.currentId, null);
  assert.equal(L.currentTitle(h.state), '新对话');
});

test('paged canonical history merges pages and reports progress', () => {
  const h = harness().ready();
  h.act('open', { conversationId: 'c1' });
  h.page('conversation', { conversationId: 'c1', body: canonical('c1', TREE.slice(0, 3), 'a1', '标题'), page: 1, pages: 2 });
  assert.deepEqual(h.state.sync.c1, { state: 'loading', page: 1, pages: 2 });
  assert.equal(L.statusLine(h.state).text, '正在同步对话（1/2）…');
  h.page('conversation', { conversationId: 'c1', body: canonical('c1', TREE, 'a3', '标题'), page: 2, pages: 2 });
  assert.equal(h.state.sync.c1.state, 'ready');
  assert.deepEqual(h.P.calls.filter((c) => c[0] === 'mergeConversation'), [['mergeConversation', null, 'c1'], ['mergeConversation', 'c1', 'c1']]);
  assert.deepEqual(L.currentTurns(h.state, h.P).map((t) => [t.user?.id ?? null, t.replies.map((r) => r.id)]), [[null, ['root']], ['u1', ['a2']], ['u2', ['a3']]]);
  assert.equal(L.currentTitle(h.state), '标题');
  h.page('conversation', { conversationId: 'c1', body: 'not json', page: 1, pages: 1 });
  assert.equal(h.state.sync.c1.code, 'invalid');
});

test('branch switching is read-only: it blocks sending until back on the latest branch', () => {
  const h = harness().ready();
  h.act('open', { conversationId: 'c1' });
  h.page('conversation', { conversationId: 'c1', body: canonical('c1', TREE, 'a3'), page: 1, pages: 1 });
  assert.equal(L.canSend(h.state).ok, true);
  h.act('switch-branch', { nodeId: 'a2', delta: -1 });
  assert.equal(L.selectedLeaf(h.state), 'a1');
  assert.equal(L.isOffBranch(h.state), true);
  assert.equal(L.canSend(h.state).reason, 'branch');
  assert.equal(L.blockedText('branch'), '正在只读查看其他分支；发送前请切回最新分支');
  h.act('send', { text: 'hi', commandId: 'x' });
  assert.equal(h.posts('send').length, 0);
  h.act('switch-branch', { nodeId: 'a1', delta: 1 });
  assert.equal(L.selectedLeaf(h.state), null, 'returning to the server leaf follows it again');
  h.act('switch-branch', { nodeId: 'a2', delta: -1 });
  h.act('latest-branch');
  assert.equal(L.isOffBranch(h.state), false);
  h.act('switch-branch', { nodeId: 'a2', delta: -1 });
  h.page('conversation', { conversationId: 'c1', body: canonical('c1', TREE.filter((n) => n[0] !== 'a1'), 'a3'), page: 1, pages: 1 });
  // Fake merge keeps a1, so selection survives; a leaf missing from nodes is ignored by selectors.
  const gone = { ...h.state, leaf: { c1: 'zzz' } };
  assert.equal(L.selectedLeaf(gone), null);
});

test('live stream in an existing conversation: parent fallbacks, running state, refresh at end', () => {
  const h = harness().ready();
  h.act('open', { conversationId: 'c1' });
  h.page('conversation', { conversationId: 'c1', body: canonical('c1', TREE, 'a3'), page: 1, pages: 1 });
  h.act('switch-branch', { nodeId: 'a2', delta: -1 });
  h.page('stream-start', { streamId: 's1', conversationId: 'c1', userMessageId: 'u3', parentMessageId: 'a3', resume: false });
  assert.equal(L.selectedLeaf(h.state), null, 'a new stream follows the newest leaf');
  assert.equal(L.isRunning(h.state), true);
  assert.equal(L.canSend(h.state).reason, 'running');
  assert.deepEqual([...L.runningIds(h.state)], ['c1']);
  h.page('stream-chunk', { streamId: 's1', chunk: JSON.stringify([
    { type: 'message', conversationId: 'c1', raw: { id: 'u3', role: 'user', status: 'done' } },
    { type: 'message', conversationId: 'c1', raw: { id: 'a4' } },
  ]) });
  assert.deepEqual(h.P.calls.filter((c) => c[0] === 'applyLiveMessage'), [
    ['applyLiveMessage', 'c1', 'u3', 'a3'],
    ['applyLiveMessage', 'c1', 'a4', 'u3'],
  ]);
  assert.deepEqual(L.currentTurns(h.state, h.P).at(-1).replies.map((r) => r.id), ['a4']);
  h.page('stream-end', { streamId: 's1', ok: true });
  assert.equal(L.isRunning(h.state), false);
  assert.deepEqual(h.posts('refresh').at(-1).fields, { conversationId: 'c1' });
  h.page('stream-chunk', { streamId: 's1', chunk: '[]' });
});

test('new chat: events before the server id are buffered, then the view moves to the new id', () => {
  const h = harness().ready();
  h.act('open', { conversationId: null });
  h.act('draft', { text: '你好' });
  assert.equal(L.currentDraft(h.state), '你好');
  h.act('send', { text: '你好', commandId: 'cmd-1' });
  assert.deepEqual(h.posts('send').at(-1).fields, { commandId: 'cmd-1', text: '你好' });
  h.page('stream-start', { streamId: 's1', conversationId: null, userMessageId: 'u1', parentMessageId: 'root', resume: false });
  assert.equal(L.isRunning(h.state), true, 'running is visible in the new-chat view');
  h.page('stream-chunk', { streamId: 's1', chunk: JSON.stringify([{ type: 'message', conversationId: null, raw: { id: 'u1', role: 'user' } }]) });
  assert.equal(h.P.calls.filter((c) => c[0] === 'applyLiveMessage').length, 0);
  h.page('stream-chunk', { streamId: 's1', chunk: JSON.stringify([
    { type: 'conversation-id', conversationId: 'new-1' },
    { type: 'message', conversationId: 'new-1', raw: { id: 'a1' } },
    { type: 'title', conversationId: 'new-1', title: '问候' },
  ]) });
  assert.equal(h.state.currentId, 'new-1');
  assert.deepEqual(h.P.calls.filter((c) => c[0] === 'applyLiveMessage'), [
    ['applyLiveMessage', 'new-1', 'u1', 'root'],
    ['applyLiveMessage', 'new-1', 'a1', 'u1'],
  ]);
  assert.equal(h.state.list[0].id, 'new-1');
  assert.equal(L.currentTitle(h.state), '问候');
  assert.equal(h.state.pending.conversationId, 'new-1');
  h.page('send-result', { commandId: 'cmd-1', ok: true, error: null });
  assert.equal(h.state.pending, null);
  assert.equal(h.state.drafts[''], undefined, 'the new-chat draft is cleared after confirmation');
  // A server list refresh keeps the fresh local chat until the server lists it.
  h.page('conversation-list', { body: JSON.stringify({ items: [{ id: 'old', title: '旧', updatedAt: 1 }] }), offset: 0, complete: true });
  assert.deepEqual(h.state.list.map((i) => i.id), ['new-1', 'old']);
});

test('a stream decode error stops that stream, warns once and asks for canonical history', () => {
  const h = harness().ready();
  h.act('open', { conversationId: 'c1' });
  h.page('conversation', { conversationId: 'c1', body: canonical('c1', TREE, 'a3'), page: 1, pages: 1 });
  h.page('stream-start', { streamId: 's1', conversationId: 'c1', userMessageId: 'u3', parentMessageId: 'a3' });
  h.page('stream-chunk', { streamId: 's1', chunk: JSON.stringify([{ type: 'error', code: 'invalid-delta' }, { type: 'message', raw: { id: 'late' } }]) });
  assert.equal(h.P.calls.filter((c) => c[0] === 'applyLiveMessage').length, 0, 'nothing after error is applied');
  assert.equal(L.isRunning(h.state), false);
  assert.equal(L.statusLine(h.state).text, '回复流无法解析，正在同步完整会话');
  h.page('stream-chunk', { streamId: 's1', chunk: 'garbage that would throw' });
  h.page('stream-end', { streamId: 's1', ok: false });
  assert.equal(h.posts('refresh').length, 2, 'refresh at failure and again after the stream ended');
  h.page('conversation', { conversationId: 'c1', body: canonical('c1', TREE, 'a3'), page: 1, pages: 1 });
  h.act('retry-sync');
  assert.equal(h.state.streamError, null);
});

test('send: guarded, single in flight, failure keeps the draft and explains, timeout recovers', () => {
  const h = harness();
  h.act('send', { text: 'x', commandId: 'c0' });
  assert.equal(h.posts('send').length, 0);
  assert.equal(L.sendErrorText(h.state.sendError.code), 'ChatGPT 页面桥尚未就绪，稍候再试');
  h.ready();
  h.act('send', { text: '   ', commandId: 'c1' });
  assert.equal(h.posts('send').length, 0, 'blank text is not sent');
  h.act('draft', { text: '问题' });
  h.act('send', { text: '问题', commandId: 'c2' });
  h.act('send', { text: '问题', commandId: 'c3' });
  assert.deepEqual(h.posts('send').map((e) => e.fields.commandId), ['c2']);
  assert.equal(L.canSend(h.state).reason, 'pending');
  h.page('send-result', { commandId: 'other', ok: true });
  assert.ok(h.state.pending, 'unrelated results are ignored');
  h.page('send-result', { commandId: 'c2', ok: false, error: 'composer-not-found' });
  assert.equal(L.currentDraft(h.state), '问题');
  assert.equal(L.sendErrorText(h.state.sendError.code), '找不到官方输入框；内容仍保留，未发送');
  h.act('dismiss-send-error');
  assert.equal(h.state.sendError, null);
  h.act('send', { text: '问题', commandId: 'c4' });
  h.act('send-timeout', { commandId: 'c4' });
  assert.equal(h.state.pending, null);
  assert.equal(h.state.sendError.code, 'timeout');
  assert.equal(L.currentDraft(h.state), '问题');
});

test('stop, continue, show-official and effort map to page commands', () => {
  const h = harness().ready();
  h.act('open', { conversationId: 'c1' });
  h.act('stop');
  h.act('continue', { messageId: 'a9' });
  h.act('show-official');
  h.act('set-effort', { effort: 'extended' });
  h.act('set-effort', { effort: '' });
  assert.deepEqual(h.posts().slice(1).map((e) => [e.message, e.fields]), [
    ['stop', {}], ['continue', { conversationId: 'c1', messageId: 'a9' }], ['show-official', {}], ['set-effort', { effort: 'extended' }],
  ]);
  assert.equal(h.state.settings.effort, '');
  assert.ok(h.effects.some((e) => e.type === 'save' && e.key === 'settings'));
});

test('drafts are per conversation; persistence drops empty drafts and is restored by hydrate', () => {
  const h = harness().ready();
  h.act('open', { conversationId: 'a' });
  h.act('draft', { text: 'A 草稿' });
  h.act('open', { conversationId: 'b' });
  assert.equal(L.currentDraft(h.state), '');
  h.act('draft', { text: '  ' });
  h.act('open', { conversationId: 'a' });
  assert.equal(L.currentDraft(h.state), 'A 草稿');
  assert.deepEqual(L.persistable(h.state, 'drafts'), { a: 'A 草稿' });
  const restored = L.hydrate(L.initialState(), {
    drafts: { a: 'A 草稿', b: 3 }, settings: { effort: 'light', junk: 1 },
    conversationIndex: [{ id: 'x', title: 'X', updatedAt: 5 }, { nope: true }],
  });
  assert.deepEqual(restored.drafts, { a: 'A 草稿' });
  assert.deepEqual(restored.settings, { effort: 'light' });
  assert.deepEqual(restored.list, [{ id: 'x', title: 'X', updatedAt: 5 }]);
});

test('conversation list paging appends by offset; filter matches titles only', () => {
  const h = harness().ready();
  h.page('conversation-list', { body: JSON.stringify({ items: [{ id: '1', title: 'Rust 入门' }, { id: '2', title: '晚餐' }] }), offset: 0, complete: false });
  h.page('conversation-list', { body: JSON.stringify({ items: [{ id: '2', title: '晚餐计划' }, { id: '3', title: 'rust 宏' }] }), offset: 2, complete: true });
  h.page('conversation-list', { body: 'garbage', offset: 0, complete: true });
  assert.deepEqual(h.state.list.map((i) => [i.id, i.title]), [['1', 'Rust 入门'], ['2', '晚餐计划'], ['3', 'rust 宏']]);
  assert.equal(h.state.listComplete, true);
  assert.deepEqual(L.filterList(h.state.list, ' RUST ').map((i) => i.id), ['1', '3']);
  assert.equal(L.filterList(h.state.list, '').length, 3);
});

test('takeover visibility and unknown messages are handled without throwing', () => {
  const h = harness();
  h.page('takeover', { visible: true });
  assert.equal(h.state.officialVisible, true);
  for (const type of ['nope', 'stream-chunk', 'stream-end', 'conversation', 'conversation-error', 'stream-start']) {
    assert.doesNotThrow(() => h.page(type, {}));
  }
});
