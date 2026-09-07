import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../isolated-bridge.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function publishExecutionPulse(');
const end = source.indexOf('  function installStorageChangeForwarder(', start);
assert.ok(start >= 0 && end > start);
function harness() {
  const stored = [];
  const chrome = { storage: { local: { set: async (value) => stored.push(value) } } };
  const publish = new Function('chrome', 'EXECUTION_PULSE_SOURCE', `${source.slice(start, end)}; return publishExecutionPulse;`)(chrome, 'fixture-tab');
  return { stored, publish };
}

test('an unknown execution pulse stays unknown rather than certifying a completed turn', async () => {
  const h = harness();
  await h.publish({ conversationId: 'c', state: 'unknown', source: 'connection-lost' });
  assert.equal(h.stored[0].executionPulse.payload.state, 'unknown');
  await h.publish({ conversationId: 'c', state: 'unsupported' });
  assert.equal(h.stored.length, 1);
});

test('cross-window pulses keep normalized turn ownership but exclude raw transport envelopes', async () => {
  const h = harness();
  await h.publish({ conversationId: 'c', state: 'running', turnUserMessageId: 'u', turnAliases: ['turn', 'turn', null],
    data: 'PRIVATE TRANSPORT', headers: { authorization: 'SECRET' } });
  const pulse = h.stored[0].executionPulse.payload;
  assert.equal(pulse.turnUserMessageId, 'u');
  assert.deepEqual(pulse.turnAliases, ['turn']);
  assert.equal(JSON.stringify(pulse).includes('SECRET'), false);
  assert.equal(Object.hasOwn(pulse, 'data'), false);
});
