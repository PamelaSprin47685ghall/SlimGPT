// Contract tests for src/protocol (workstream A). They run against the
// fixtures in tests/fixtures/protocol and are reported as TODO until the
// implementation replaces the stubs, so the suite stays green meanwhile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8');
const json = (name) => JSON.parse(fixture(name));
const implemented = (() => {
  try { P.createConversation('probe'); return true; } catch { return false; }
})();
const t = (name, fn) => test(name, { todo: implemented ? false : 'protocol core not implemented yet' }, fn);

/** Assert that `actual` contains every field present in `expected` (deep, arrays by index & length). */
function assertSubset(actual, expected, path = '$') {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path} should be an array`);
    assert.equal(actual.length, expected.length, `${path}.length`);
    expected.forEach((item, index) => assertSubset(actual[index], item, `${path}[${index}]`));
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${path} should be an object`);
    for (const [key, value] of Object.entries(expected)) assertSubset(actual[key], value, `${path}.${key}`);
    return;
  }
  assert.deepEqual(actual, expected, path);
}

for (const testCase of json('messages.json').cases) {
  t(`normalizeMessage: ${testCase.name}`, () => {
    const before = JSON.stringify(testCase.raw);
    const message = P.normalizeMessage(testCase.raw, { source: 'canonical' });
    assert.equal(JSON.stringify(testCase.raw), before, 'input must not be mutated');
    assertSubset(message, testCase.expect);
    for (const block of message.blocks) {
      if (block.kind === 'text') assert.doesNotMatch(block.markdown, /[\uE200-\uE2FF]/, 'no private-use markers');
    }
  });
}

t('normalizeMessage is total on garbage input', () => {
  for (const raw of [null, undefined, 1, 'x', [], {}, { id: 3 }, { id: 'a', content: 5 }, { id: 'a', content: { parts: [null, 1, {}] } }]) {
    assert.doesNotThrow(() => P.normalizeMessage(raw));
  }
});

const sse = fixture('streams/v1-reasoning-then-answer.sse');
const sseExpected = json('streams/v1-reasoning-then-answer.expected.json');

function decodeAll(text, split) {
  const decoder = P.createStreamDecoder();
  const events = [];
  for (let index = 0; index < text.length; index += split) events.push(...decoder.push(text.slice(index, index + split)));
  events.push(...decoder.end());
  return events;
}

t('stream decoder: identical result at every chunk size and line ending', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = sse.replace(/\n/g, newline);
    for (let split = 1; split <= 64; split += 1) {
      const events = decodeAll(text, split);
      assert.ok(!events.some((event) => event.type === 'error'), `no error (split ${split})`);
      assertSubset(events.at(-1), sseExpected.endsWith);
      let conversation = P.createConversation(sseExpected.conversationId);
      for (const event of events) if (event.type === 'message') conversation = P.applyLiveMessage(conversation, event.raw);
      for (const [id, expected] of Object.entries(sseExpected.finalMessages)) {
        assertSubset(conversation.nodes.get(id)?.message, expected, `${id} (split ${split})`);
      }
      assert.equal(events.find((event) => event.type === 'title')?.title, sseExpected.title);
    }
  }
});

t('stream decoder: a delta before delta_encoding is an error and stops the stream', () => {
  const decoder = P.createStreamDecoder();
  const events = decoder.push('event: delta\ndata: {"v":"x"}\n\ndata: {"message":{"id":"m","author":{"role":"assistant"},"content":{"content_type":"text","parts":["y"]}}}\n\n');
  assert.equal(events[0]?.type, 'error');
  assert.equal(events.length, 1);
});

t('stream decoder: EOF inside an event is truncated, never a completed message', () => {
  const decoder = P.createStreamDecoder();
  decoder.push('data: {"message":{"id":"m","author":{"role":"assistant"},"content":{"content_type":"text","parts":["y"]}}}');
  assert.deepEqual(decoder.end().map((event) => event.type), ['error']);
});

t('regression: partial page never re-parents known nodes or invents branches', () => {
  const fx = json('regression-partial-page-reparent.json');
  const merged = P.mergeConversation(P.parseConversation(fx.full), P.parseConversation(fx.partial));
  const turns = P.selectTurns(merged);
  assert.deepEqual(turns.map((turn) => ({
    user: turn.user?.id, replies: turn.replies.map((reply) => reply.id), replyBranchCount: turn.replyBranch.count,
  })), fx.expect.turns);
});

t('regression: live snapshot of a canonical multimodal user keeps the turn intact', () => {
  const fx = json('regression-multimodal-user-turn.json');
  const conversation = P.applyLiveMessage(P.parseConversation(fx.canonical), fx.live);
  const turns = P.selectTurns(conversation);
  assert.deepEqual(turns.map((turn) => ({ user: turn.user?.id, replies: turn.replies.map((reply) => reply.id) })), fx.expect.turns);
  assert.deepEqual(turns[0].user.blocks.map((block) => block.kind), fx.expect.userBlocksKinds);
});

t('live messages never downgrade a canonical finished message', () => {
  const fx = json('regression-multimodal-user-turn.json');
  const conversation = P.applyLiveMessage(P.parseConversation(fx.canonical), {
    id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['A c'] }, status: 'in_progress',
  });
  assert.equal(conversation.nodes.get('a1').message.status, 'done');
});
