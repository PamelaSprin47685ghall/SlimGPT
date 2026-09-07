import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Execute the private production parser without booting the DOM interception
// hook. These tests exercise behavior, not the presence of source substrings.
const source = readFileSync(new URL('../main-mitm.js', import.meta.url), 'utf8');
const start = source.indexOf('  function createOfficialSemanticStream()');
const end = source.indexOf('  async function captureReadableStream(', start);
assert.ok(start >= 0 && end > start, 'production interception functions must be available');
const { createOfficialSemanticStream, completeOfficialStream } = new Function(
  'observedFetchResponses',
  `${source.slice(start, end)}; return { createOfficialSemanticStream, completeOfficialStream };`,
)(new WeakSet());

function sse(value, event = '', newline = '\n') {
  return `${event ? `event: ${event}${newline}` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}${newline}${newline}`;
}
const finalMessage = {
  conversation_id: 'conversation',
  message: { id: 'answer', author: { role: 'assistant' }, channel: 'final',
    end_turn: true, status: 'finished_successfully',
    content: { content_type: 'text', parts: ['PRIVATE_RESPONSE_BODY_'.repeat(400)] },
    metadata: { turn_exchange_id: 'turn', parent_id: 'question' },
  },
};

async function project(chunks, graceful = true) {
  const stream = createOfficialSemanticStream();
  stream.setContext({ turnUserMessageId: 'question' });
  for (const chunk of chunks) stream.accept(chunk);
  stream.finish(graceful);
  return new Response(stream.readable).text();
}

test('official projection preserves final structure for all line endings and chunk splits', async () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const text = '\ufeff' + sse(finalMessage, '', newline) + sse('[DONE]', '', newline);
    // Include every split around frame boundaries plus a split within the body.
    for (const index of [0, 1, 7, 47, text.length - 1, text.length - 2, text.length - 3, text.length - 4, text.length]) {
      const result = await project([text.slice(0, index), text.slice(index)]);
      assert.ok(result.includes('"id":"answer"'), `${JSON.stringify(newline)} split ${index}`);
      assert.ok(result.includes('"parent_id":"question"'));
      assert.equal(result.includes('PRIVATE_RESPONSE_BODY_'), false);
      assert.ok(result.endsWith('data: [DONE]\n\n'));
      assert.ok(result.length < 2000, 'the official renderer must not receive heavy response text');
    }
  }
});

test('a control event reusing a delta channel cannot erase the last final item', async () => {
  const result = await project([
    sse('"v1"', 'delta_encoding'),
    sse({ channel: 0, op: 'add', path: '', value: finalMessage }, 'delta'),
    sse({ c: 0, o: 'replace', p: '', v: { type: 'message_stream_complete', conversation_id: 'conversation' } }, 'delta'),
  ]);
  assert.ok(result.includes('"id":"answer"'));
  assert.ok(result.includes('message_stream_complete'));
});

test('delta-encoded resume controls survive abnormal transport EOF', async () => {
  const result = await project([
    sse('"v1"', 'delta_encoding'),
    sse({ c: 0, o: 'add', p: '', v: { type: 'resume_conversation_token', token: 'test-only-token' } }, 'delta'),
  ], false);
  assert.ok(result.includes('resume_conversation_token'));
  assert.equal(result.includes('[DONE]'), false);
});

test('an unterminated trailing message never becomes an official final item', async () => {
  const result = await project([`data: ${JSON.stringify(finalMessage)}\n`], false);
  assert.equal(result.includes('"id":"answer"'), false);
  assert.equal(result.includes('[DONE]'), false);
});

test('failed official deltas cannot resume from stale channel state or fabricate successful DONE', async () => {
  const result = await project([
    sse('"v1"', 'delta_encoding'),
    sse({ p: '', o: 'add', v: { ...finalMessage, message: { ...finalMessage.message, id: 'untrusted', end_turn: false, status: 'in_progress' } } }, 'delta'),
    sse({ p: '/__proto__/bad', o: 'replace', v: true }, 'delta'),
    sse({ p: '/message/end_turn', o: 'replace', v: true }, 'delta'),
    sse('[DONE]'),
  ]);
  assert.equal(result.includes('"id":"untrusted"'), false);
  assert.equal(result.includes('[DONE]'), false);
});

test('diverted response clones and every body reader consume only projected bytes', async () => {
  const original = new Response('PRIVATE_ORIGINAL_BODY', { headers: { 'content-type': 'text/plain' } });
  const originalReader = original.body.getReader();
  await originalReader.read();
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('projected only'));
    controller.close();
  } });
  const diverted = completeOfficialStream(original, body, Promise.resolve());
  assert.equal(diverted, original, 'preserve native network response identity');
  assert.equal(diverted.bodyUsed, false);
  const clone = diverted.clone();
  assert.equal(await clone.text(), 'projected only');
  assert.equal(new TextDecoder().decode(await diverted.arrayBuffer()), 'projected only');
  assert.equal(diverted.bodyUsed, true);
  await assert.rejects(diverted.text(), TypeError);
  originalReader.releaseLock();
});
