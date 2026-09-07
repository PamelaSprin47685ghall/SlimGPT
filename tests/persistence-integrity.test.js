import test from 'node:test';
import assert from 'node:assert/strict';
import { compactObservationLedger, loadObservationLedgerState, saveObservationLedger } from '../src/lib/storage.js';
import { hydrateConversationObservations, ingestConversationMessage } from '../core.js';

const record = (text, sequence, extra = {}) => ingestConversationMessage(null, {
  id: 'a', author: { role: 'assistant' }, response_id: 'r',
  content: { content_type: 'text', parts: [text] }, ...extra,
}, { textMode: 'snapshot', sequenceNumber: sequence, captureTransport: 'sse' });
const persisted = (current) => compactObservationLedger([{ id: 'c', observations: current.observations }])[0].observations;

test('cache preserves long text, wide objects and large arrays rather than changing valid content', () => {
  const text = '中'.repeat(600_000);
  const payload = {
    rows: Array.from({ length: 600 }, (_, i) => ({ i, text: `item ${i}` })),
    fields: Object.fromEntries(Array.from({ length: 240 }, (_, i) => [`field${i}`, i])),
  };
  const input = [{ id: 'c', observations: [{ id: 'a', text, tool: { kind: 'tool-result', payload } }] }];
  const output = compactObservationLedger(input);
  assert.equal(output[0]?.observations[0].text, text);
  assert.deepEqual(output[0].observations[0].tool.payload, payload);
  assert.deepEqual(input[0].observations[0].tool.payload, payload, 'compaction never mutates live observations');
});

test('cache budget counts UTF-8 bytes and rejects an oversized conversation as a whole', () => {
  const observations = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, text: '中'.repeat(300_000) }));
  const output = compactObservationLedger([{ id: 'c', observations }]);
  assert.equal(output.length, 0, '5.4 MB of UTF-8 must not pass a 4 MB budget');
});

test('nested JSON and special-looking keys survive cache serialization without prototype mutation', () => {
  let payload = JSON.parse('{"__proto__":{"data":"keep"},"constructor":"also data"}');
  const original = payload;
  for (let i = 0; i < 15; i += 1) payload = { child: payload };
  const output = compactObservationLedger([{ id: 'c', observations: [{ id: 'a', tool: { payload } }] }]);
  let actual = output[0].observations[0].tool.payload;
  for (let i = 0; i < 15; i += 1) actual = actual.child;
  assert.deepEqual(actual, original);
  assert.equal({}.data, undefined);
});

test('a newer peer snapshot replaces local text and metadata by protocol revision, not arrival time', () => {
  const local = record('old body', 10, { metadata: { citations: [{ url: 'https://example.com/old' }] } });
  const peer = record('corrected body', 12, { metadata: { citations: [], error: null } });
  peer.observations[0].lastSeenAt = 1;
  const result = hydrateConversationObservations(local, persisted(peer));
  assert.equal(result.observations[0].text, 'corrected body');
  assert.equal(result.observations[0].lastSequenceNumber, 12);
  assert.deepEqual(result.observations[0].metadata.citations, []);
  assert.equal(result.observations[0]._rawMessage, undefined, 'old raw state must not survive a newer parsed snapshot');
});

test('late peer snapshots cannot add old metadata back into a newer local correction', () => {
  const local = record('', 20, { metadata: { citations: [], model_slug: 'new' } });
  const peer = record('old body', 19, { metadata: { citations: [{ url: 'https://example.com/old' }], model_slug: 'old-long-name' } });
  peer.observations[0].lastSeenAt = Number.MAX_SAFE_INTEGER;
  const result = hydrateConversationObservations(local, persisted(peer));
  assert.equal(result.observations[0].text, '');
  assert.deepEqual(result.observations[0].metadata.citations, []);
  assert.equal(result.observations[0].metadata.model_slug, 'new');
});

test('a status-only update after reload keeps restored content without turning it into a synthetic raw message', () => {
  const reloaded = hydrateConversationObservations(null, persisted(record('keep me', 4)));
  const next = ingestConversationMessage(reloaded, {
    id: 'a', author: { role: 'assistant' }, response_id: 'r', status: 'finished_successfully', end_turn: true,
  }, { textMode: 'snapshot', sequenceNumber: 5 });
  assert.equal(next.observations[0].text, 'keep me');
  assert.equal(next.observations[0].status, 'finished_successfully');
  assert.equal(next.observations[0]._rawMessage?.content, undefined);
});

test('restored terminal state remains current when a newer snapshot clears an old error', () => {
  const local = record('', 5, { status: 'failed', metadata: { error: 'old failure', is_error: true } });
  const peer = record('recovered', 6, { status: 'finished_successfully', metadata: { error: null, is_error: false } });
  const result = hydrateConversationObservations(local, persisted(peer));
  assert.equal(result.observations[0].status, 'finished_successfully');
  assert.equal(result.observations[0].error, false);
  assert.equal(result.observations[0].metadata.error, null);
});

test('a conversation too complex to copy is omitted, diagnosed, and never partly cached', () => {
  const cycle = {};
  cycle.self = cycle;
  const omitted = [];
  const entries = compactObservationLedger([{ id: 'bad', observations: [{ id: 'first', text: 'one' }, { id: 'second', tool: { payload: cycle } }] }], {
    onOmitted: (item) => omitted.push(item),
  });
  assert.deepEqual(entries, []);
  assert.deepEqual(omitted, [{ id: 'bad', reason: 'invalid-value' }]);
});

test('intentional credential removal is labelled, while regular payload fields and nulls survive', () => {
  const entries = compactObservationLedger([{ id: 'c', observations: [{
    id: 'a', metadata: { error: null },
    tool: { kind: 'tool-result', payload: { value: 42, authorization: 'TEST_SECRET_DO_NOT_STORE' } },
  }] }]);
  const item = entries[0].observations[0];
  assert.equal(item.cacheRedacted, true);
  assert.deepEqual(item.tool.payload, { value: 42 });
  assert.equal(item.metadata.error, null);
  assert.equal(JSON.stringify(entries).includes('TEST_SECRET_DO_NOT_STORE'), false);
  assert.equal(compactObservationLedger(entries)[0].observations[0].cacheRedacted, true);
});

test('cache omission notices survive reload and are cleared by a successful later save', async () => {
  const keys = ['location', 'chrome', 'browser'];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const values = {};
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'chrome-extension:' } });
    Object.defineProperty(globalThis, 'browser', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: {
      get: async (key) => Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, values[name]])),
      set: async (next) => { Object.assign(values, structuredClone(next)); },
    } } } });
    await saveObservationLedger([{ id: 'large', observations: [{ id: 'a', text: '中'.repeat(1_500_000) }] }]);
    const reloaded = await loadObservationLedgerState();
    assert.deepEqual(reloaded.entries, []);
    assert.deepEqual(reloaded.omissions, [{ id: 'large', reason: 'budget' }]);
    await saveObservationLedger([{ id: 'large', observations: [{ id: 'a', text: 'now fits' }] }]);
    assert.deepEqual((await loadObservationLedgerState()).omissions, []);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('new envelope sequence supersedes an older raw-message sequence on subsequent updates', () => {
  let current = record('one', 1, { sequence_number: 1 });
  current = ingestConversationMessage(current, { id: 'a', response_id: 'r', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['two'] } }, {
    textMode: 'snapshot', sequenceNumber: 2,
  });
  assert.equal(current.observations[0].lastSequenceNumber, 2);
  assert.equal(hydrateConversationObservations(record('one', 1), persisted(current)).observations[0].text, 'two');
});

test('a failed legacy migration write does not discard the successfully restored content', async () => {
  const keys = ['location', 'chrome', 'browser', 'localStorage'];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const reads = [];
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'chrome-extension:' } });
    Object.defineProperty(globalThis, 'browser', { configurable: true, value: undefined });
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: {
      get: async (names) => { reads.push(names); return {}; },
      set: async () => { throw new Error('fixture quota failure'); },
    } } } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: () => JSON.stringify([{ id: 'legacy', observations: [{ id: 'a', text: 'restored legacy body' }] }]),
    } });
    const result = await loadObservationLedgerState();
    assert.equal(result.entries[0].observations[0].text, 'restored legacy body');
    assert.deepEqual(result.omissions, [{ id: '*', reason: 'write-failed' }]);
    assert.deepEqual(reads, [['observationLedger', 'observationLedgerOmissions']]);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
