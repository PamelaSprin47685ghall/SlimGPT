// Live bug (bda5542): internal web search / browsing steps were shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';
import * as L from '../../src/ui/state/logic.js';
import { displayReplies, isQuietTool, visibleBlocks } from '../../src/ui/lib/visibility.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8');
const fx = JSON.parse(fixture('regression-phantom-branches.json'));
const { ids } = fx;

function turnsFromStream(size) {
  const sse = fixture(fx.streams.first.file);
  let state = L.reducePage(L.initialState(), { type: 'hello', ready: true, loggedIn: true }, P).state;
  const messages = [{ type: 'stream-start', streamId: 's1', conversationId: null, userMessageId: fx.streams.first.userMessageId, parentMessageId: fx.streams.first.parentMessageId, resume: false }];
  for (let i = 0; i < sse.length; i += size) messages.push({ type: 'stream-chunk', streamId: 's1', chunk: sse.slice(i, i + size) });
  return { state, messages };
}

test('tool classification: search/browse plumbing is quiet, python and others are not', () => {
  for (const tool of ['web', 'web.run', 'web.search', 'browser', 'browser.open', 'file_search', 'file_search.msearch', 'myfiles_browser', 'bio']) assert.ok(isQuietTool(tool), tool);
  for (const tool of ['python', 'canvas', 'image_gen', 'dalle.text2im', 'container.exec', 'webpage_maker', '']) assert.ok(!isQuietTool(tool), tool);
  const message = { blocks: [{ kind: 'tool_call', tool: 'python', input: '1+1' }, { kind: 'tool_result', tool: 'web.run', output: '…' }, { kind: 'reasoning', markdown: 'x' }] };
  assert.deepEqual(visibleBlocks(message).map((b) => b.kind), ['tool_call', 'reasoning']);
});

test('web search turn shows only the reasoning line and the answer, live and after history', () => {
  const { state: start, messages } = turnsFromStream(64);
  let state = start;
  let sawSearching = false;
  for (const message of messages) {
    state = L.reducePage(state, message, P).state;
    const turn = L.currentTurns(state, P).at(-1);
    if (!turn) continue;
    const shown = displayReplies(turn);
    assert.ok(!shown.replies.some((r) => r.id === ids.c1 || r.id === ids.r1), 'web.run call/result never displayed');
    if (shown.searching) sawSearching = true;
  }
  assert.ok(sawSearching, 'a quiet "searching" hint replaces the hidden steps while they stream');
  state = L.reducePage(state, { type: 'stream-end', streamId: 's1', ok: true }, P).state;
  state = L.reducePage(state, { type: 'conversation', conversationId: fx.conversationId, body: JSON.stringify(fx.canonicalAfterFirst), page: 1, pages: 1 }, P).state;
  const turn = L.currentTurns(state, P).at(-1);
  const shown = displayReplies(turn);
  assert.deepEqual(shown.replies.map((r) => r.id), [ids.t1, ids.a1]);
  assert.deepEqual(shown.replies[0].blocks.map((b) => b.kind), ['reasoning']);
  assert.equal(shown.searching, false);
  assert.equal(shown.branchNodeId, turn.replyBranch.siblingIds[turn.replyBranch.index], 'switcher targets the branch node, not the visible leaf');
});
