import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/protocol/index.js';
import { applyEvents, assertSubset, decodeChunks, fixture, json, rng, turnShape } from './helpers.js';

const STREAMS = ['v1-reasoning-then-answer.sse', 'v1-tools-ops.sse', 'legacy-json-snapshots.sse', 'regression-progressive-text.sse'];
const types = (events) => events.map((event) => event.type);
/** Final conversation state, compared structurally (order of events matters for snapshots). */
const finalState = (events) => {
  const conversation = applyEvents(P.createConversation('x'), events);
  return JSON.stringify([...conversation.nodes.values()].map((node) => [node.id, node.parentId, node.message]));
};

test('every fixture stream decodes identically at chunk sizes 1..64 and LF/CRLF/CR', () => {
  for (const name of STREAMS) {
    const base = fixture(`streams/${name}`);
    const reference = decodeChunks(base, [base.length]);
    assert.equal(reference.at(-1).type, 'done', name);
    const referenceState = finalState(reference);
    for (const newline of ['\n', '\r\n', '\r']) {
      const text = base.replace(/\n/g, newline);
      for (let split = 1; split <= 64; split += 1) {
        const events = decodeChunks(text, [split]);
        assert.deepEqual(types(events), types(reference), `${name} split ${split} ${JSON.stringify(newline)}`);
        assert.equal(finalState(events), referenceState, `${name} split ${split}`);
      }
    }
  }
});

test('property: random chunk boundaries never change the result (seeded)', () => {
  const random = rng(0x5eed);
  for (const name of STREAMS) {
    const base = fixture(`streams/${name}`);
    const reference = JSON.stringify(decodeChunks(base, [base.length]));
    for (let round = 0; round < 150; round += 1) {
      const newline = ['\n', '\r\n', '\r'][Math.floor(random() * 3)];
      const text = base.replace(/\n/g, newline);
      const sizes = Array.from({ length: 16 }, () => 1 + Math.floor(random() * 40));
      const events = decodeChunks(text, sizes);
      assert.equal(JSON.stringify(events), reference, `${name} round ${round} sizes ${sizes}`);
    }
  }
});

test('v1 tools stream: truncate/remove/patch ops, tool call → result → answer, title, ids', () => {
  const expected = json('streams/v1-tools-ops.expected.json');
  const events = decodeChunks(fixture('streams/v1-tools-ops.sse'), [3]);
  assert.deepEqual(events.filter((event) => event.type === 'conversation-id'), [{ type: 'conversation-id', conversationId: 'c-5' }]);
  assert.equal(events.find((event) => event.type === 'title').title, expected.title);
  const conversation = applyEvents(P.createConversation(expected.conversationId), events);
  for (const [id, shape] of Object.entries(expected.finalMessages)) assertSubset(conversation.nodes.get(id).message, shape, id);
  assert.equal(conversation.nodes.get('k3').message.blocks.length, 1);
  assert.deepEqual(turnShape(P.selectTurns(conversation)), expected.turns);
  assert.equal(conversation.currentNodeId, 'k3');
  // The removed metadata key is really gone from the last snapshot.
  const last = events.filter((event) => event.type === 'message' && event.raw.id === 'k3').at(-1);
  assert.equal('tmp' in last.raw.metadata, false);
});

test('every message event is a complete snapshot; earlier snapshots are never mutated', () => {
  const events = decodeChunks(fixture('streams/v1-reasoning-then-answer.sse'), [1]);
  const answers = events.filter((event) => event.type === 'message' && event.raw.id === 'a1').map((event) => event.raw.content.parts[0]);
  assert.deepEqual(answers, ['', 'aa', 'aaa', 'aaa\n', 'aaa\n\n', 'aaa\n\n!']);
});

test('legacy JSON stream: snapshots replace, keep-alive comments ignored', () => {
  const events = decodeChunks(fixture('streams/legacy-json-snapshots.sse'), [5]);
  const conversation = applyEvents(P.createConversation('c-9'), events);
  assert.deepEqual(turnShape(P.selectTurns(conversation)), [{ user: 'u9', replies: ['a9'] }]);
  assert.equal(conversation.nodes.get('a9').message.blocks[0].markdown, 'Answer');
  assert.equal(conversation.nodes.get('a9').message.status, 'done');
});

test('unsupported delta encoding is an error and stops the stream', () => {
  const decoder = P.createStreamDecoder();
  const events = decoder.push('event: delta_encoding\ndata: "v2"\n\ndata: {"message":{"id":"m","author":{"role":"assistant"},"content":{"content_type":"text","parts":["y"]}}}\n\n');
  assert.deepEqual(events, [{ type: 'error', code: 'unsupported-encoding' }]);
  assert.deepEqual(decoder.push('data: [DONE]\n\n'), []);
  assert.deepEqual(decoder.end(), []);
});

test('invalid JSON and invalid deltas are errors; nothing is emitted afterwards', () => {
  const bad = P.createStreamDecoder();
  assert.deepEqual(bad.push('data: {not json\n\n'), [{ type: 'error', code: 'invalid-json' }]);
  assert.deepEqual(bad.push('data: [DONE]\n\n'), []);
  for (const delta of ['{"p":"/__proto__/x","o":"add","v":1}', '{"p":"/a","o":"explode","v":1}', '{"p":"/a/5","o":"replace","v":1}', '"scalar"', '{"c":-1,"v":1}']) {
    const decoder = P.createStreamDecoder();
    const events = decoder.push(`event: delta_encoding\ndata: "v1"\n\nevent: delta\ndata: ${delta}\n\n`);
    assert.deepEqual(events.map((event) => event.code ?? event.type), ['invalid-delta'], delta);
  }
  assert.equal({}.x, undefined, 'prototype not polluted');
});

test('buffer limit protects against unbounded events', () => {
  const decoder = P.createStreamDecoder({ maxBufferedChars: 100 });
  const events = decoder.push(`data: ${'x'.repeat(200)}`);
  assert.deepEqual(events, [{ type: 'error', code: 'buffer-limit' }]);
  assert.deepEqual(decoder.end(), []);
});

test('EOF variants: clean end without [DONE] after completion is done; abrupt end is truncated', () => {
  const complete = P.createStreamDecoder();
  complete.push('data: {"type":"message_stream_complete","conversation_id":"c"}\n\n');
  assert.deepEqual(types(complete.end()), ['done']);
  const abrupt = P.createStreamDecoder();
  abrupt.push('data: {"message":{"id":"m","author":{"role":"assistant"},"content":{"content_type":"text","parts":["y"]}}}\n\n');
  assert.deepEqual(abrupt.end(), [{ type: 'error', code: 'truncated' }]);
  const midLine = P.createStreamDecoder();
  midLine.push('data: [DO');
  assert.deepEqual(types(midLine.end()), ['error']);
});

test('framing details: BOM, comments, multi-line data, event ids, split CRLF', () => {
  const decoder = P.createStreamDecoder();
  const text = '\uFEFF: hello\r\nid: 7\r\ndata: {"message":\r\ndata: {"id":"m","author":{"role":"assistant"},"content":{"content_type":"text","parts":["a\\nb"]}}}\r\n\r\ndata: [DONE]\r\n\r\n';
  const events = [];
  for (const piece of text.split(/(?<=\r)/)) events.push(...decoder.push(piece));
  events.push(...decoder.end());
  assert.deepEqual(types(events), ['message', 'done']);
  assert.equal(events[0].raw.content.parts[0], 'a\nb');
});

test('frames after [DONE] are ignored and end() emits nothing more', () => {
  const decoder = P.createStreamDecoder();
  const events = decoder.push('data: [DONE]\n\ndata: {"message":{"id":"late","author":{"role":"assistant"},"content":{"content_type":"text","parts":["z"]}}}\n\n');
  assert.deepEqual(types(events), ['done']);
  assert.deepEqual(decoder.end(), []);
});

test('push accepts non-string chunks without throwing', () => {
  const decoder = P.createStreamDecoder();
  for (const chunk of [undefined, null, 5, {}, [], '']) assert.doesNotThrow(() => decoder.push(chunk));
  assert.doesNotThrow(() => decoder.end());
});
