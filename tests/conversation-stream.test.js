import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationStreamReader } from '../src/lib/conversation-stream.js';
import { createConversationSseDecoder } from '../core.js';
const event = (data, name = 'message', eol = '\n') => `event: ${name}${eol}data: ${JSON.stringify(data)}${eol}${eol}`;

test('incremental reader preserves every split and LF/CRLF/CR without reparsing the unfinished prefix', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = `\ufeff: comment${newline}${newline}` + event({ message: { text: '中文 🧪' } }, 'message', newline) + `data: [DONE]${newline}${newline}`;
    for (let split = 0; split <= text.length; split += 1) {
      const reader = createConversationStreamReader();
      const first = reader.push(text.slice(0, split));
      const last = reader.push(text.slice(split), true);
      assert.deepEqual([...first.values, ...last.values], [{ message: { text: '中文 🧪' } }]);
      assert.equal(last.failed, false, `${JSON.stringify(newline)} at ${split}`);
      assert.equal(reader.bufferedChars, 0);
    }
  }
});

test('a failed delta quarantines subsequent inherited operations instead of corrupting prior snapshots', () => {
  const reader = createConversationStreamReader();
  const initial = reader.push(event('v1', 'delta_encoding') + event({ p: '', o: 'add', v: { text: 'a' } }, 'delta') + event({ p: '/text', o: 'append', v: 'b' }, 'delta'));
  assert.deepEqual(initial.values.at(-1), { text: 'ab' });
  const failed = reader.push(event({ p: '/__proto__/bad', o: 'replace', v: true }, 'delta') + event({ v: 'WRONG' }, 'delta'));
  assert.equal(failed.error, 'invalid-delta');
  assert.deepEqual(failed.values, []);
  assert.deepEqual(reader.push(event({ v: 'WRONG' }, 'delta'), true).values, []);
  assert.deepEqual(initial.values.at(-1), { text: 'ab' });
  assert.equal(reader.bufferedChars, 0);
});

test('buffer budget applies to a single incomplete event, not a chunk with many valid events', () => {
  const reader = createConversationStreamReader({ maxBufferedChars: 90 });
  assert.equal(reader.push(event({ text: 'ok' }).repeat(500)).values.length, 500);
  assert.equal(reader.push('data: ' + 'x'.repeat(90)).error, 'buffer-limit');
  assert.equal(reader.bufferedChars, 0);
  assert.deepEqual(reader.push('\n\n').values, []);
});

test('truncation reports incompleteness without inventing a message or discarding completed predecessors', () => {
  const reader = createConversationStreamReader();
  const result = reader.push(event({ text: 'complete' }) + 'data: {"text":"unfinished"}\n', true);
  assert.deepEqual(result.values, [{ text: 'complete' }]);
  assert.equal(result.error, 'truncated-event');
  assert.equal(reader.bufferedChars, 0);
});

test('malformed JSON is not silently accepted and a new transport can independently recover', () => {
  const reader = createConversationStreamReader();
  assert.equal(reader.push('data: {"broken":\n\n').error, 'invalid-json');
  assert.equal(reader.push(event({ text: 'not trusted' }), true).error, null);
  const recovery = createConversationStreamReader();
  assert.deepEqual(recovery.push(event({ text: 'fresh response' }), true).values, [{ text: 'fresh response' }]);
});

test('empty chunks between split CRLF do not manufacture blank lines', () => {
  const reader = createConversationStreamReader();
  assert.deepEqual(reader.push('data: {"text":"ok"}\r').values, []);
  assert.deepEqual(reader.push('').values, []);
  assert.deepEqual(reader.push('\n\r\n', true).values, [{ text: 'ok' }]);
});

test('DONE is a transport marker, not a synthesized message or logical turn state', () => {
  const reader = createConversationStreamReader();
  assert.deepEqual(reader.push('data: [DONE]\n\n').values, []);
  assert.equal(reader.failed, false);
  assert.deepEqual(reader.push(event({ type: 'conversation_update', state: 'running' }), true).values, [{ type: 'conversation_update', state: 'running' }]);
});

test('encoding reset clears sparse channels, including channel numbers beyond array-index range', () => {
  const decoder = createConversationSseDecoder();
  const encoding = { event: 'delta_encoding', data: '"v1"' };
  const channel = 2 ** 32;
  decoder.decode(encoding);
  decoder.decode({ event: 'delta', json: { c: channel, p: '', o: 'add', v: { previous: 'must disappear' } } });
  decoder.decode(encoding);
  assert.deepEqual(decoder.decode({ event: 'delta', json: { c: channel, p: '/text', o: 'add', v: 'new' } }), { text: 'new' });
  assert.throws(() => decoder.decode({ event: 'delta', json: { c: Number.MAX_SAFE_INTEGER + 1, p: '', o: 'add', v: {} } }));
});
