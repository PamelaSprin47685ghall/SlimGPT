// Live re-test of 1851577 (2026-10-19): stream end detection, partial lists,
// branches after reload, export of the question, reasoning rows. Real HAR
// data (sanitized) where it exists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';
import * as L from '../../src/ui/state/logic.js';
import { displayReplies } from '../../src/ui/lib/visibility.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8');
const CONV = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const ANSWER = '00000000-0000-4000-8000-000000000009';
const regenSse = fixture('streams/har-regenerate-after-stop.sse');
const pagedAfterRegen = fixture('har-history-after-regenerate.json');
const pagedAfterStop = fixture('har-history-after-stop.json');
const fullAfterRegen = fixture('har-full-mapping-after-regenerate.json');

function run(state, messages) {
  const effects = [];
  for (const message of messages) {
    const result = L.reducePage(state, message, P);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}
const hello = { type: 'hello', ready: true, loggedIn: true, auth: 'user' };
const history = (body) => ({ type: 'conversation', conversationId: CONV, body, page: 1, pages: 1 });
const chunks = (streamId, text, size = 113) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push({ type: 'stream-chunk', streamId, chunk: text.slice(i, i + size) });
  return out;
};
const refreshes = (effects) => effects.filter((e) => e.type === 'post' && e.message === 'refresh');
const count = (state) => L.currentTurns(state, P).map((turn) => turn.replyBranch.count);

test('stream end: not "generating" once the final answer is finished; one refresh at [DONE], none again at stream end', () => {
  const opened = run({ ...L.initialState(), currentId: CONV }, [hello, history(pagedAfterStop)]).state;
  const start = { type: 'stream-start', streamId: 'r', conversationId: CONV, userMessageId: null, parentMessageId: USER, resume: false };
  const finishedAt = regenSse.lastIndexOf('{"type":"message_marker"');
  const finalPatch = regenSse.indexOf('"p":"/message/status","o":"replace","v":"finished_successfully"');
  assert.ok(finalPatch > 0 && finishedAt > finalPatch);
  const before = run(opened, [start, ...chunks('r', regenSse.slice(0, finalPatch))]);
  assert.equal(L.isRunning(before.state), true);
  const done = run(before.state, chunks('r', regenSse.slice(finalPatch, finishedAt)));
  assert.equal(L.isRunning(done.state), false, 'finished_successfully + end_turn: composer back to send');
  assert.equal(L.runningIds(done.state).has(CONV), false, 'sidebar: no 生成中');
  assert.equal(refreshes(done.effects).length, 0, 'no refresh before [DONE]');
  const tail = run(done.state, chunks('r', regenSse.slice(finishedAt)));
  assert.deepEqual(refreshes(tail.effects).map((e) => e.fields.conversationId), [CONV], 'refresh right at [DONE]');
  const end = run(tail.state, [{ type: 'stream-end', streamId: 'r', ok: true }]);
  assert.equal(refreshes(end.effects).length, 0, 'the lingering connection end adds no second refresh');
  assert.equal(end.state.streamError, null);
});

test('sidebar: a partial first page (official limit=20) merges instead of replacing; a complete one replaces', () => {
  const item = (n) => ({ id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`, title: `c${n}`, update_time: 1792400000 - n });
  const body = (items, total) => JSON.stringify({ items, total, limit: items.length || 20, offset: 0 });
  let { state } = run(L.initialState(), [hello, { type: 'conversation-list', body: body([1, 2, 3, 4, 5].map(item), 5), offset: 0, complete: true }]);
  // A fresh chat (local) + the official app's own small first page.
  state = { ...state, list: [{ id: CONV, title: '新', updatedAt: 1, local: true }, ...state.list] };
  state = run(state, [{ type: 'conversation-list', body: body([item(2), item(1)], 40), offset: 0, complete: false }]).state;
  assert.deepEqual(L.visibleList(state).map((entry) => entry.title), ['新', 'c2', 'c1', 'c3', 'c4', 'c5']);
  state = run(state, [{ type: 'conversation-list', body: body([item(1), item(3)], 2), offset: 0, complete: true }]).state;
  assert.deepEqual(L.visibleList(state).map((entry) => entry.title), ['新', 'c1', 'c3']);
});

test('branches after reload: paged view (has_versions only) is 1/1; the full tree loaded for it brings 2/2, in either order', () => {
  const base = { ...L.initialState(), currentId: CONV };
  const pagedOnly = run(base, [hello, history(pagedAfterRegen)]).state;
  assert.deepEqual(count(pagedOnly), [1]);
  const pagedThenFull = run(pagedOnly, [history(fullAfterRegen)]).state;
  assert.deepEqual(count(pagedThenFull), [2]);
  const fullThenPaged = run(base, [hello, history(fullAfterRegen), history(pagedAfterRegen)]).state;
  assert.deepEqual(count(fullThenPaged), [2], 'a later official paged view does not hide the sibling');
  const turn = L.currentTurns(fullThenPaged, P)[0];
  assert.deepEqual([turn.user.id, turn.replies.map((reply) => reply.id)], [USER, [ANSWER]]);
  // Switch to the stopped branch and back.
  const shown = displayReplies(turn);
  const switched = L.reduceAction(fullThenPaged, { type: 'switch-branch', nodeId: shown.branchNodeId, delta: -1 }, P).state;
  const older = L.currentTurns(switched, P)[0];
  assert.equal(older.replyBranch.index, 0);
  assert.equal(older.replies[0].status, 'interrupted');
  assert.match(P.conversationToMarkdown(L.currentConversation(switched), { leafId: L.selectedLeaf(switched) }), /## User\n\n写一篇 800 字/);
});

test('export: a fresh chat stopped before the stream echoed the question still exports "## User" and the sidebar title', () => {
  // Stopped before the server echoed the question: drop its input_message event.
  const stopped = regenSse.slice(0, regenSse.indexOf('event: delta', regenSse.indexOf('\\u4e0b\\u9762')) + 30)
    .split('\n\n').filter((event) => !event.includes('"input_message"')).join('\n\n');
  assert.ok(!stopped.includes('"input_message"'));
  const { state } = run(L.initialState(), [hello,
    { type: 'stream-start', streamId: 'n', conversationId: null, userMessageId: USER, parentMessageId: 'client-created-root', resume: false, format: 'sse', userText: '写一篇 800 字的文章介绍宇宙大炸' },
    ...chunks('n', stopped), { type: 'stream-end', streamId: 'n', ok: false }]);
  assert.equal(state.currentId, CONV);
  const conv = L.currentConversation(state);
  const title = state.list.find((item) => item.id === CONV)?.title;
  assert.equal(title, '写一篇 800 字的文章介绍宇宙大炸');
  const md = P.conversationToMarkdown(conv, { leafId: L.selectedLeaf(state), title });
  assert.match(md, /^# 写一篇 800 字的文章介绍宇宙大炸\n\n## User\n\n写一篇 800 字的文章介绍宇宙大炸\n\n## Assistant\n\n/);
});

test('reasoning rows after reload ("思考" / "Searched 20 websites" / "Worked for a few seconds") collapse into one line', () => {
  const raw = (id, parent, content, extra = {}) => ({ id, author: { role: 'assistant' }, status: 'finished_successfully', end_turn: false, recipient: 'all', content, metadata: { parent_id: parent, ...extra.metadata }, ...extra.top });
  const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-0000000002${i}0`);
  const mapping = {};
  const add = (id, parent, message) => { mapping[id] = { id, parent, children: [], message }; if (parent) mapping[parent].children.push(id); };
  add(ids[0], null, null);
  add(ids[1], ids[0], { id: ids[1], author: { role: 'user' }, status: 'finished_successfully', content: { content_type: 'text', parts: ['news?'] }, metadata: {} });
  add(ids[2], ids[1], raw(ids[2], ids[1], { content_type: 'thoughts', thoughts: [{ summary: 'Planning', content: 'look it up' }] }));
  add(ids[3], ids[2], raw(ids[3], ids[2], { content_type: 'code', language: 'json', text: '{"search_query":[{"q":"news"}]}' }, { top: { recipient: 'web.run' } }));
  add(ids[4], ids[3], { id: ids[4], author: { role: 'tool', name: 'web.run' }, status: 'finished_successfully', content: { content_type: 'text', parts: ['results'] }, metadata: {}, recipient: 'all' });
  add(ids[5], ids[4], raw(ids[5], ids[4], { content_type: 'thoughts', thoughts: [{ summary: 'Searched 20 websites', content: '' }] }));
  add(ids[6], ids[5], raw(ids[6], ids[5], { content_type: 'reasoning_recap', content: 'Worked for a few seconds' }, { metadata: { finished_duration_sec: 7 } }));
  add(ids[7], ids[6], { ...raw(ids[7], ids[6], { content_type: 'text', parts: ['Here is the news.'] }), end_turn: true });
  const conv = P.parseConversation(JSON.stringify({ conversation_id: CONV, title: 't', mapping, current_node: ids[7] }));
  const [turn] = P.selectTurns(conv);
  const shown = displayReplies(turn);
  assert.deepEqual(shown.replies.map((reply) => reply.blocks.map((block) => block.kind)), [['reasoning'], ['text']]);
  const line = shown.replies[0].blocks[0];
  assert.equal(line.label, '思考 · 已搜索 20 个网站 · 7 秒');
  assert.match(line.markdown, /look it up/);
  assert.doesNotMatch(line.markdown, /Worked for|Searched/);
});
