// Device-only records of logged-out conversations.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/protocol/index.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function liveConversation(conversationId, turns) {
  let conv = P.createConversation(conversationId);
  let parent = null;
  turns.forEach(([prompt, reply], index) => {
    const userId = id(1000 + index * 2);
    const replyId = id(1001 + index * 2);
    conv = P.applyLiveMessage(conv, P.userMessageFromPrompt({ id: userId, text: prompt, parentId: parent }));
    const decoder = P.createConversationSourceDecoder();
    const body = `${JSON.stringify({ version: 1, type: 'content', messageId: replyId, revision: 1, mode: 'replace', markdown: reply, status: 'complete' })}\n{"version":1,"type":"end"}\n`;
    for (const event of decoder.push(body)) if (event.type === 'message') conv = P.applyLiveMessage(conv, event.raw, { fallbackParentId: userId });
    parent = replyId;
  });
  return conv;
}

test('a conversation round-trips through a JSON record', () => {
  const conv = liveConversation(id(1), [['hi', 'Hello **there**'], ['and?', '```js\nx()\n```']]);
  const record = P.localRecordFromConversation(conv, { updatedAt: 1234 });
  assert.equal(record.title, 'hi');
  assert.equal(record.messages.length, 4);
  const back = P.conversationFromLocalRecord(JSON.parse(JSON.stringify(record)));
  assert.ok(back);
  assert.equal(back.id, id(1));
  const turns = P.selectTurns(back);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].user.blocks[0].markdown, 'and?');
  assert.equal(turns[1].replies[0].blocks[0].markdown, '```js\nx()\n```');
  assert.equal(turns[1].replies[0].status, 'done');
  assert.equal(P.conversationToMarkdown(back), P.conversationToMarkdown({ ...conv, title: 'hi' }));
});

test('interrupted replies stay interrupted after a reload', () => {
  let conv = P.applyLiveMessage(P.createConversation(id(2)), P.userMessageFromPrompt({ id: id(3), text: 'q' }));
  const decoder = P.createConversationSourceDecoder();
  for (const event of decoder.push(`${JSON.stringify({ version: 1, type: 'content', messageId: id(4), revision: 1, mode: 'replace', markdown: 'part' })}\n`)) {
    if (event.type === 'message') conv = P.applyLiveMessage(conv, event.raw, { fallbackParentId: id(3) });
  }
  const back = P.conversationFromLocalRecord(P.localRecordFromConversation(conv));
  assert.equal(P.selectTurns(back)[0].replies[0].status, 'interrupted');
});

test('invalid records are rejected without throwing', () => {
  for (const value of [null, 5, 'x', [], {}, { v: 2, id: id(1), messages: [] }, { v: 1, id: 'has space', messages: [] },
    { v: 1, id: id(1), messages: [{ id: id(2), role: 'system', text: 'x' }] }, { v: 1, id: id(1), messages: [{ id: id(2), role: 'user', text: 5 }] }]) {
    assert.equal(P.conversationFromLocalRecord(value), null);
  }
  assert.equal(P.localRecordFromConversation(null), null);
  assert.equal(P.localRecordFromConversation(P.createConversation(id(1))), null);
});

test('dangling and self parents are dropped', () => {
  const back = P.conversationFromLocalRecord({ v: 1, id: id(1), messages: [
    { id: id(2), parent: id(99), role: 'user', text: 'a', status: 'finished_successfully' },
    { id: id(3), parent: id(3), role: 'assistant', text: 'b', status: 'finished_successfully' },
  ] });
  assert.ok(back);
  assert.equal(back.nodes.get(id(2)).parentId, null);
  assert.equal(back.nodes.get(id(3)).parentId, null);
});

test('caps keep the newest records within count and size', () => {
  const records = Array.from({ length: 10 }, (_, n) => ({ v: 1, id: id(n + 1), title: `t${n}`, updatedAt: n, messages: [{ id: id(100 + n), role: 'user', text: 'x'.repeat(1000), status: 'finished_successfully' }] }));
  records.push({ v: 1, id: id(1), title: 'dup', updatedAt: 99, messages: [{ id: id(500), role: 'user', text: 'y', status: 'x' }] }, 'junk');
  const byCount = P.capLocalRecords(records, { maxCount: 3 });
  assert.deepEqual(byCount.map((record) => record.title), ['t9', 't8', 't7']);
  const bySize = P.capLocalRecords(records, { maxChars: 2500 });
  assert.equal(bySize.length, 2);
  assert.deepEqual(P.capLocalRecords('nope'), []);
  assert.equal(P.LOCAL_LIMITS.maxCount, 50);
});
