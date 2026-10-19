// Property / fuzz tests: malformed input never throws, every output keeps the
// contract shape, and random chunking is irrelevant. Seeded for reproducibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/protocol/index.js';
import { decodeChunks, fixture, json, rng } from './helpers.js';

const random = rng(0xC0FFEE);
const pick = (items) => items[Math.floor(random() * items.length)];
const ATOMS = [null, undefined, 0, -1, 1.5, NaN, Infinity, '', 'x', '\uE200', '\uE200cite\uE202', '【1†', '\uE201', true, false, [], {}, '__proto__', 'in_progress', 'finished_successfully'];
const KEYS = ['id', 'author', 'role', 'content', 'content_type', 'parts', 'text', 'thoughts', 'metadata', 'parent_id', 'status', 'recipient', 'channel',
  'content_references', 'matched_text', 'items', 'url', 'title', 'attachments', 'asset_pointer', 'finish_details', 'type', 'tool_calls', 'mapping',
  'children', 'parent', 'message', 'current_node', 'messages', 'page_info', 'conversation_id', 'name', 'citations', 'start_ix', '__proto__'];

function randomValue(depth = 0) {
  const roll = random();
  if (depth > 4 || roll < 0.4) return pick(ATOMS);
  if (roll < 0.6) return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(depth + 1));
  const value = {};
  for (let index = Math.floor(random() * 6); index > 0; index -= 1) value[pick(KEYS)] = randomValue(depth + 1);
  return value;
}

/** Randomly corrupt a valid object: delete, retype or replace fields. */
function mutate(value, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => (random() < 0.15 ? randomValue(depth) : mutate(item, depth + 1)));
  if (!value || typeof value !== 'object') return random() < 0.1 ? randomValue(depth) : value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const roll = random();
    if (roll < 0.08) continue;
    result[key] = roll < 0.18 ? randomValue(depth) : mutate(child, depth + 1);
  }
  return result;
}

function checkMessage(message) {
  if (message === null) return;
  assert.equal(typeof message.id, 'string');
  assert.ok(P.ROLES.includes(message.role));
  assert.ok(P.MESSAGE_STATUSES.includes(message.status));
  assert.ok(Array.isArray(message.blocks));
  assert.equal(typeof message.hidden, 'boolean');
  for (const block of message.blocks) {
    assert.ok(P.BLOCK_KINDS.includes(block.kind), block.kind);
    if (block.kind === 'text') {
      assert.equal(typeof block.markdown, 'string');
      assert.ok(Array.isArray(block.citations));
      if (message.role !== 'user') assert.doesNotMatch(block.markdown, /[\uE200-\uE2FF]/);
      for (const citation of block.citations) {
        assert.ok(citation.start >= 0 && citation.end <= block.markdown.length && citation.start <= citation.end);
        for (const source of citation.sources) assert.match(source.url, /^https?:\/\//i);
      }
    }
    if (block.kind === 'tool_call') assert.equal(typeof block.input, 'string');
    if (block.kind === 'tool_result') assert.equal(typeof block.output, 'string');
  }
}

const messageCases = json('messages.json').cases.map((testCase) => testCase.raw);
const histories = [json('regression-partial-page-reparent.json').full, json('regression-multimodal-user-turn.json').canonical];

test('fuzz: normalizeMessage is total and shape-correct on 4000 random/mutated inputs', () => {
  for (let round = 0; round < 4000; round += 1) {
    const raw = round % 2 ? randomValue() : mutate(pick(messageCases));
    let message;
    assert.doesNotThrow(() => { message = P.normalizeMessage(raw, pick([undefined, null, {}, { source: 'live' }, { parentId: 5 }])); });
    checkMessage(message);
    assert.doesNotThrow(() => P.messageToPlainText(message));
  }
});

test('fuzz: conversation pipeline is total on mutated histories and random live snapshots', () => {
  for (let round = 0; round < 1500; round += 1) {
    const body = round % 3 === 0 ? randomValue() : mutate(pick(histories));
    let conversation;
    assert.doesNotThrow(() => { conversation = P.parseConversation(round % 2 ? body : JSON.stringify(body ?? null) ?? ''); });
    const base = conversation ?? P.createConversation('c');
    let next = base;
    for (let step = 0; step < 4; step += 1) {
      assert.doesNotThrow(() => { next = P.applyLiveMessage(next, random() < 0.5 ? mutate(pick(messageCases)) : randomValue(), pick([undefined, { fallbackParentId: 'u1' }, { fallbackParentId: 7 }, null])); });
      assert.doesNotThrow(() => { next = P.mergeConversation(next, P.parseConversation(mutate(pick(histories))) ?? base); });
    }
    let turns;
    assert.doesNotThrow(() => { turns = P.selectTurns(next, pick([null, 'u1', 'a1', 'missing', 3])); });
    assert.ok(Array.isArray(turns));
    for (const turn of turns) {
      if (turn.user) checkMessage(turn.user);
      turn.replies.forEach(checkMessage);
      assert.ok(turn.replies.every((reply) => reply.role !== 'user' && !reply.hidden));
    }
    assert.doesNotThrow(() => P.switchBranch(next, pick(['u1', 'a1', 'x']), pick([1, -1, 2])));
    assert.doesNotThrow(() => P.conversationToMarkdown(next, { includeReasoning: true, includeTools: true }));
  }
});

test('fuzz: garbage arguments to every export never throw', () => {
  const garbage = [null, undefined, 0, '', '{}', '[]', 'x', {}, [], { nodes: new Map([['a', null]]), id: 'x' }, { nodes: 'x' }];
  for (const value of garbage) {
    for (const other of garbage) {
      assert.doesNotThrow(() => P.normalizeMessage(value, other));
      assert.doesNotThrow(() => P.parseConversation(value));
      assert.doesNotThrow(() => P.mergeConversation(value, other));
      assert.doesNotThrow(() => P.applyLiveMessage(value, other, other));
      assert.doesNotThrow(() => P.selectTurns(value, other));
      assert.doesNotThrow(() => P.switchBranch(value, other, 1));
      assert.doesNotThrow(() => P.createConversation(value));
      assert.doesNotThrow(() => P.parseConversationList(value));
      assert.doesNotThrow(() => P.messageToPlainText(value));
      assert.doesNotThrow(() => P.conversationToMarkdown(value, other));
      assert.doesNotThrow(() => P.createStreamDecoder(value).push(other));
    }
  }
});

test('fuzz: random bytes / corrupted streams never throw and stop after the first error', () => {
  const streams = ['v1-reasoning-then-answer.sse', 'v1-tools-ops.sse', 'legacy-json-snapshots.sse'].map((name) => fixture(`streams/${name}`));
  const alphabet = ['\n', '\r', ':', ' ', 'data', 'event', 'delta', '{', '}', '"', '[DONE]', 'v1', '\uE200', '\uFEFF', '\0', '😀'];
  for (let round = 0; round < 600; round += 1) {
    let text;
    if (round % 2) {
      text = Array.from({ length: 1 + Math.floor(random() * 80) }, () => pick(alphabet)).join('');
    } else {
      const chars = [...pick(streams)];
      for (let edits = 1 + Math.floor(random() * 5); edits > 0; edits -= 1) chars.splice(Math.floor(random() * chars.length), 1 + Math.floor(random() * 3), pick(alphabet));
      text = chars.join('');
    }
    let events;
    assert.doesNotThrow(() => { events = decodeChunks(text, [1 + Math.floor(random() * 30), 1 + Math.floor(random() * 7)]); });
    const errorIndex = events.findIndex((event) => event.type === 'error');
    if (errorIndex >= 0) assert.equal(errorIndex, events.length - 1, 'nothing after error');
    assert.ok(events.filter((event) => event.type === 'done').length <= 1);
    assert.ok(!(events.some((event) => event.type === 'done') && errorIndex >= 0), 'done and error are exclusive');
    for (const event of events) {
      if (event.type === 'error') assert.ok(P.STREAM_ERROR_CODES.includes(event.code));
      if (event.type === 'message') assert.equal(typeof event.raw.id, 'string');
    }
  }
});

test('property: citation extraction is stable under random marker soup', () => {
  const pieces = ['a', ' ', '\uE200', '\uE201', '\uE202', 'cite', 'turn0search0', '【', '】', '4:0', '†', 'source', '\n```\n', 'entity', '["x","N"]'];
  for (let round = 0; round < 3000; round += 1) {
    const text = Array.from({ length: Math.floor(random() * 30) }, () => pick(pieces)).join('');
    for (const status of ['in_progress', 'finished_successfully']) {
      const message = P.normalizeMessage({ id: 'r', author: { role: 'assistant' }, status, content: { content_type: 'text', parts: [text] },
        metadata: { content_references: [{ matched_text: '\uE200cite\uE202turn0search0\uE201', items: [{ url: 'https://x.y' }] }] } });
      checkMessage(message);
    }
  }
});
