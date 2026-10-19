// Shared helpers for tests/protocol (not a test file itself).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../../src/protocol/index.js';

export const fixture = (name) => readFileSync(new URL(`../fixtures/protocol/${name}`, import.meta.url), 'utf8');
export const json = (name) => JSON.parse(fixture(name));

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Assert that `actual` contains every field present in `expected`. */
export function assertSubset(actual, expected, path = '$') {
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

/** Decode `text` pushed in the given chunk lengths (cycled). */
export function decodeChunks(text, sizes, options) {
  const decoder = P.createStreamDecoder(options);
  const events = [];
  let index = 0;
  let turn = 0;
  while (index < text.length) {
    const size = Math.max(1, sizes[turn++ % sizes.length]);
    events.push(...decoder.push(text.slice(index, index + size)));
    index += size;
  }
  events.push(...decoder.end());
  return events;
}

/** Feed stream events into a conversation like the UI does. */
export function applyEvents(conversation, events, context) {
  let next = conversation;
  for (const event of events) if (event.type === 'message') next = P.applyLiveMessage(next, event.raw, context);
  return next;
}

/** Minimal mapping builder: [[id, parent, rawMessage|null], ...]. */
export function mapping(conversationId, currentNode, rows, extra = {}) {
  const result = {};
  for (const [id, parent, message] of rows) result[id] = { id, parent, children: [], message };
  for (const [id, parent] of rows) if (parent && result[parent]) result[parent].children.push(id);
  return { id: conversationId, title: extra.title ?? 'T', current_node: currentNode, mapping: result, ...extra };
}

export const user = (id, text, extra = {}) => ({ id, author: { role: 'user' }, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', ...extra });
export const assistant = (id, text, extra = {}) => ({ id, author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', end_turn: true, ...extra });

export const turnShape = (turns) => turns.map((turn) => ({ user: turn.user?.id ?? null, replies: turn.replies.map((reply) => reply.id) }));
