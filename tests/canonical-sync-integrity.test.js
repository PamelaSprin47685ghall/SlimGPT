import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationRecordTimeline, findConversationPayload, finishCanonicalSync, ingestConversationPayload, ingestConversationMessage, setConversationRecordTerminal } from '../core.js';

const node = (id, parent, text = id, role = id.startsWith('u') ? 'user' : 'assistant') => ({
  id, parent, children: [], message: { id, author: { role }, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully' },
});
const page = (...nodes) => ({ id: 'c', current_node: nodes.at(-1)?.id || null, mapping: Object.fromEntries(nodes.map((n) => [n.id, n])) });
const initial = () => ingestConversationPayload(null, page(node('u-old', null), node('a-old', 'u-old')), { canonicalComplete: true });
const first = () => page(node('u1', null), node('a1', 'u1'));
const middle = () => page(node('u2', 'a1'), node('a2', 'u2'));
const last = () => page(node('u3', 'a2'), node('a3', 'u3'));
const accept = (record, payload, index, complete = false, id = 'sync', extra = {}) => ingestConversationPayload(record, payload, {
  canonicalSyncId: id, canonicalPageIndex: index, canonicalComplete: complete, canonicalPageCount: 3, ...extra,
});

test('three canonical pages commit together and never expose an intermediate historical root', () => {
  let record = accept(null, first(), 0);
  assert.equal(record.canonicalComplete, false);
  assert.equal(record.payload, null);
  assert.equal(buildConversationRecordTimeline(record).turns.length, 0);
  record = accept(record, middle(), 1);
  assert.equal(record.payload, null);
  record = accept(record, last(), 2, true);
  assert.equal(record.canonicalComplete, true);
  assert.deepEqual(buildConversationRecordTimeline(record).turns.map((turn) => turn.user.id), ['u1', 'u2', 'u3']);
  assert.equal(record.payload.mapping.u3.parent, 'a2');
});

test('a missing first or middle capture cannot masquerade as a complete history', () => {
  const existing = initial();
  for (const record of [accept(null, last(), 2, true), accept(accept(existing, first(), 0), last(), 2, true)]) {
    assert.ok(record.canonicalSyncError, 'lost page must be observable');
    assert.equal(record.payload?.current_node || null, record.payload ? 'a-old' : null);
    assert.ok(!record.payload?.mapping.u3);
  }
});

test('a replayed page zero does not reset the pages already collected', () => {
  let record = accept(initial(), first(), 0);
  record = accept(record, middle(), 1);
  record = accept(record, first(), 0);
  record = accept(record, last(), 2, true);
  assert.equal(record.payload.mapping.u2.parent, 'a1');
  assert.equal(record.payload.current_node, 'a3');
});

test('contradictory replayed pages invalidate rather than splice two versions together', () => {
  let record = accept(initial(), first(), 0);
  record = accept(record, page(node('u1', null, 'different snapshot')), 0);
  record = accept(record, middle(), 1);
  record = accept(record, last(), 2, true);
  assert.ok(record.canonicalSyncError);
  assert.equal(record.payload.current_node, 'a-old');
});

test('a retired sync cannot override a newer completed snapshot', () => {
  let record = accept(initial(), first(), 0, false, 'old-sync');
  record = accept(record, page(node('u-new', null), node('a-new', 'u-new')), 0, true, 'new-sync', { canonicalPageCount: 1 });
  record = accept(record, middle(), 1, false, 'old-sync');
  record = accept(record, last(), 2, true, 'old-sync');
  assert.equal(record.payload.current_node, 'a-new');
  assert.equal(record.canonicalSyncError, null);
});

test('page count and completion must agree, including single-page transactions', () => {
  for (const extra of [
    { canonicalPageCount: 3 }, { canonicalPageCount: 0 }, { canonicalPageCount: -1 },
    { canonicalPageCount: '1' }, { canonicalPageCount: 1.5 }, { canonicalPageCount: Infinity },
  ]) {
    const record = accept(initial(), first(), 0, true, 'invalid-count', extra);
    assert.ok(record.canonicalSyncError, JSON.stringify(extra));
    assert.equal(record.payload.current_node, 'a-old');
  }
  let record = accept(initial(), first(), 0);
  record = accept(record, middle(), 1, true, 'sync', { canonicalPageCount: 2 });
  assert.ok(record.canonicalSyncError, 'total cannot change in the middle');
  assert.equal(record.payload.current_node, 'a-old');
});

test('page indices must be explicit nonnegative integers, never coercible flags', () => {
  for (const index of [undefined, null, '', '0', false, -1, 0.5]) {
    const record = accept(initial(), first(), index, true, 'bad-index', { canonicalPageCount: 1 });
    assert.ok(record.canonicalSyncError, String(index));
    assert.equal(record.payload.current_node, 'a-old');
  }
});

test('pages from another conversation cannot merge into the active transaction', () => {
  let record = accept(initial(), first(), 0);
  record = accept(record, { ...middle(), id: 'foreign' }, 1);
  record = accept(record, last(), 2, true);
  assert.ok(record.canonicalSyncError);
  assert.equal(record.payload.id, 'c');
  assert.equal(record.payload.current_node, 'a-old');
});

test('a failed refresh keeps the current user-selected branch and live observations', () => {
  const history = page(node('u', null), node('old', 'u'), node('latest', 'u'));
  let record = ingestConversationPayload(null, history);
  record = setConversationRecordTerminal(record, 'old');
  record = ingestConversationMessage(record, { id: 'live', author: { role: 'assistant' }, content: { parts: ['keep live'] } }, { textMode: 'snapshot' });
  record = accept(record, first(), 0);
  record = accept(record, last(), 2, true);
  assert.equal(record.terminal, 'old');
  assert.equal(record.observations[0].text, 'keep live');
});

test('retaining a proven newer tail must not overwrite corrected canonical ancestors', () => {
  let record = ingestConversationPayload(null, page(node('u', null), node('a', 'u', 'OLD WRONG'), node('tail', 'a', 'live tail')));
  const refreshed = page(node('u', null), node('a', 'u', 'CORRECTED'));
  record = accept(record, refreshed, 0, true, 'refresh', { canonicalPageCount: 1 });
  assert.equal(record.payload.current_node, 'tail');
  assert.equal(record.payload.mapping.tail.parent, 'a');
  assert.equal(record.payload.mapping.a.message.content.parts[0], 'CORRECTED');
});

test('legacy captures without a declared page count still need contiguous indices', () => {
  const partial = ingestConversationPayload(initial(), first(), { canonicalSyncId: 'legacy', canonicalPageIndex: 0, canonicalComplete: false });
  const completed = ingestConversationPayload(partial, middle(), { canonicalSyncId: 'legacy', canonicalPageIndex: 1, canonicalComplete: true });
  assert.equal(completed.payload.current_node, 'a2');
  assert.equal(completed.canonicalComplete, true);
});

test('an explicitly empty complete history replaces prior content without spinning forever', () => {
  for (const raw of [
    { conversation_id: 'c', messages: [], page_info: { has_previous_page: false }, current_node: null },
    { id: 'c', mapping: {}, current_node: null },
  ]) {
    const payload = findConversationPayload(raw);
    assert.ok(payload);
    const record = accept(initial(), payload, 0, true, 'empty', { canonicalPageCount: 1 });
    assert.equal(record.canonicalComplete, true);
    assert.equal(record.canonicalSyncError, null);
    assert.equal(buildConversationRecordTimeline(record).turns.length, 0);
  }
});

test('a sender completion with a lost last page releases staging and keeps the prior history', () => {
  let record = accept(initial(), first(), 0);
  record = accept(record, middle(), 1);
  record = finishCanonicalSync(record, 'sync');
  assert.equal(record.canonicalSyncError, 'missing-page');
  assert.equal(record.canonicalSyncPayload, null);
  assert.deepEqual(record.canonicalSyncPages, []);
  assert.equal(record.payload.current_node, 'a-old');
  const late = accept(record, last(), 2, true);
  assert.equal(late.payload.current_node, 'a-old');
});

test('an end notification alone cannot certify an old cached payload as a newly completed sync', () => {
  const existing = initial();
  const missing = finishCanonicalSync(existing, 'no-pages-arrived');
  assert.equal(missing.payload, existing.payload);
  assert.equal(missing.canonicalSyncError, 'missing-page');
  const success = accept(existing, first(), 0, true, 'success', { canonicalPageCount: 1 });
  assert.equal(finishCanonicalSync(success, 'success'), success);
});

test('conflicting conversation id aliases are rejected instead of selecting the convenient one', () => {
  const record = accept(initial(), { ...first(), id: 'foreign', conversation_id: 'c' }, 0, true, 'conflict', { canonicalPageCount: 1 });
  assert.equal(record.canonicalSyncError, 'conversation-mismatch');
  assert.equal(record.payload.current_node, 'a-old');
});
