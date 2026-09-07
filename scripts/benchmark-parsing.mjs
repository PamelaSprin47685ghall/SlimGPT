import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildConversationRecordTimeline, ingestConversationMessage, ingestConversationPayload } from '../core.js';
import { createConversationStreamReader } from '../src/lib/conversation-stream.js';

// Synthetic, local-only workload. No browser, credentials, network or user
// conversation text is used. Timings are diagnostic, not brittle test gates.
const mapping = {};
let parent = null;
const turnCount = 300;
const body = '历史正文 中文 🧪 '.repeat(350);
for (let turn = 0; turn < turnCount; turn += 1) {
  for (let item = 0; item < 4; item += 1) {
    const id = `${turn}-${item}`;
    mapping[id] = { id, parent, children: [], message: {
      id, author: { role: item ? 'assistant' : 'user' },
      content: { content_type: 'text', parts: [item ? body : `问题 ${turn}`] },
      metadata: { turn_exchange_id: `turn-${turn}` }, status: 'finished_successfully',
    } };
    if (parent) mapping[parent].children.push(id);
    parent = id;
  }
}
const payload = { id: 'synthetic-benchmark', current_node: parent, mapping };
let record = ingestConversationPayload(null, payload);
assert.equal(buildConversationRecordTimeline(record).turns.length, turnCount);
const cold = [], warm = [];
for (let iteration = 0; iteration < 15; iteration += 1) {
  let start = performance.now();
  assert.equal(buildConversationRecordTimeline(ingestConversationPayload(null, { ...payload })).turns.length, turnCount);
  cold.push(performance.now() - start);
  record = ingestConversationMessage(record, {
    id: 'live', author: { role: 'assistant' }, parent_id: parent,
    metadata: { turn_exchange_id: `turn-${turnCount - 1}` },
    content: { content_type: 'text', parts: [`update ${iteration}`] },
  }, { textMode: 'snapshot' });
  start = performance.now();
  assert.equal(buildConversationRecordTimeline(record).turns.at(-1).replies.at(-1).text, `update ${iteration}`);
  warm.push(performance.now() - start);
}
const streamText = '汉字 🧪 '.repeat(150_000);
const encoded = `data: ${JSON.stringify({ text: streamText })}\n\n`;
const reader = createConversationStreamReader();
const start = performance.now();
let parsed = [];
for (let offset = 0; offset < encoded.length; offset += 256) {
  const result = reader.push(encoded.slice(offset, offset + 256), offset + 256 >= encoded.length);
  assert.equal(result.failed, false);
  parsed.push(...result.values);
}
assert.equal(parsed.length, 1);
assert.equal(parsed[0].text, streamText);
const percentile = (values, fraction) => Number(values.toSorted((a, b) => a - b)[Math.floor((values.length - 1) * fraction)].toFixed(2));
console.log(JSON.stringify({
  scenario: 'synthetic only; cold projection vs immutable-payload reuse, not a prior-release comparison',
  turns: turnCount, messages: Object.keys(mapping).length,
  coldProjectionMs: { median: percentile(cold, .5), p95: percentile(cold, .95) },
  liveUpdateMs: { median: percentile(warm, .5), p95: percentile(warm, .95) },
  singleLargeEvent: { characters: encoded.length, chunkCharacters: 256, elapsedMs: Number((performance.now() - start).toFixed(2)), contentExact: true },
}, null, 2));
