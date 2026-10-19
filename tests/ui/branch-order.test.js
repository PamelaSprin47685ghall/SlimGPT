// Live verification of b273184 (2026-10-19): opening a regenerated
// conversation from the sidebar before a reload showed ‹ 1/2 › over the newer
// answer. The branch position depended on the order children were listed by
// the server / merged in. Branches are now ordered by create_time (ties by
// id), so the position always matches the shown node, whatever the order of
// sources (paged view first, then full mapping; or the reverse).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';
import * as L from '../../src/ui/state/logic.js';
import { displayReplies } from '../../src/ui/lib/visibility.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8');
const CONV = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-0000000000ff';
const USER = '00000000-0000-4000-8000-000000000002';
const ANSWER = '00000000-0000-4000-8000-000000000009';
const paged = fixture('har-history-after-regenerate.json');
const full = fixture('har-full-mapping-after-regenerate.json');
// Same mapping, but the server lists nodes and children newest-first.
const fullReversed = (() => {
  const body = JSON.parse(full);
  const mapping = Object.entries(body.mapping).reverse()
    .map(([id, node]) => [id, { ...node, children: [...node.children].reverse() }]);
  return JSON.stringify({ ...body, mapping: Object.fromEntries(mapping) });
})();

function run(state, messages) {
  for (const message of messages) state = L.reducePage(state, message, P).state;
  return state;
}
const history = (body) => ({ type: 'conversation', conversationId: CONV, body, page: 1, pages: 1 });
const shown = (state) => {
  const turn = L.currentTurns(state, P)[0];
  const replies = displayReplies(turn);
  return { user: turn.user.id, replies: turn.replies.map((reply) => reply.id), at: `${turn.replyBranch.index + 1}/${turn.replyBranch.count}`, node: replies.branchNodeId, branch: turn.replyBranch };
};

for (const [label, mapping] of [['server order', full], ['newest-first server order', fullReversed]]) {
  for (const [order, sources] of [['paged then full', [paged, mapping]], ['full then paged', [mapping, paged]]]) {
    test(`sidebar open before reload (${label}, ${order}): newer answer reads ‹ 2/2 ›, ‹ goes to the stopped one`, () => {
      // A logged-in session on another conversation; the regenerated one is in the list.
      let state = run(L.initialState(), [
        { type: 'hello', ready: true, loggedIn: true, auth: 'user' },
        { type: 'location', conversationId: OTHER, url: `https://chatgpt.com/c/${OTHER}` },
        { type: 'list', offset: 0, complete: true, items: [{ id: CONV, title: '宇宙大爆炸' }, { id: OTHER, title: 'x' }] },
      ]);
      state = L.reduceAction(state, { type: 'open', conversationId: CONV }, P).state;
      state = run(state, [{ type: 'location', conversationId: CONV, url: `https://chatgpt.com/c/${CONV}` }, ...sources.map(history)]);
      const now = shown(state);
      assert.deepEqual([now.user, now.replies, now.at], [USER, [ANSWER], '2/2']);
      assert.equal(now.branch.siblingIds[now.branch.index], now.node, 'the index is the displayed branch');
      const back = L.reduceAction(state, { type: 'switch-branch', nodeId: now.node, delta: -1 }, P).state;
      const older = shown(back);
      assert.equal(older.at, '1/2');
      assert.equal(L.currentTurns(back, P)[0].replies[0].status, 'interrupted');
      const again = L.reduceAction(back, { type: 'switch-branch', nodeId: older.node, delta: 1 }, P).state;
      assert.deepEqual([shown(again).replies, shown(again).at], [[ANSWER], '2/2']);
    });
  }
}

test('branch order: create_time first, ties by id, an untimed (streaming) branch is newest', () => {
  const node = (id, parent, children, time, role = 'assistant', text = id) => [id, {
    id, parent, children,
    message: { id, author: { role }, create_time: time, status: 'finished_successfully', content: { content_type: 'text', parts: [text] }, metadata: {} },
  }];
  const body = (current, times) => JSON.stringify({
    conversation_id: CONV, current_node: current,
    mapping: Object.fromEntries([
      node('u', null, ['c', 'a', 'b', 'z'], 1, 'user', 'q'),
      node('c', 'u', [], times.c), node('a', 'u', [], times.a), node('b', 'u', [], times.b), node('z', 'u', [], times.z),
    ]),
  });
  const ids = (conv) => P.selectTurns(conv)[0].replyBranch.siblingIds;
  assert.deepEqual(ids(P.parseConversation(body('c', { a: 10, b: 10, c: 5, z: 20 }))), ['c', 'a', 'b', 'z']);
  assert.deepEqual(ids(P.parseConversation(body('c', { a: 10, b: 10, c: null, z: 20 }))), ['a', 'b', 'z', 'c']);
  const conv = P.parseConversation(body('z', { a: 30, b: 10, c: 5, z: 20 }));
  const turn = P.selectTurns(conv)[0];
  assert.deepEqual([turn.replyBranch.siblingIds, turn.replyBranch.index], [['c', 'b', 'z', 'a'], 2]);
  // No current node: the default leaf is the newest branch.
  const noCurrent = P.parseConversation(JSON.stringify({ ...JSON.parse(body('z', { a: 30, b: 10, c: 5, z: 20 })), current_node: null }));
  assert.equal(P.selectTurns(noCurrent)[0].replies[0].id, 'a');
});
