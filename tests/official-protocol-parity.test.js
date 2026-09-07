import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { consumeSse, createConversationSseDecoder } from '../core.js';

// The page hook is a standalone MAIN-world script, not an ES module. Test
// its actual pure protocol functions, without installing a browser hook in
// Node or exposing test-only globals in the shipped extension.
const source = readFileSync(new URL('../main-mitm.js', import.meta.url), 'utf8');
const start = source.indexOf('  function createOfficialSemanticStream(');
const end = source.indexOf('  function completeOfficialStream(', start);
assert.ok(start >= 0 && end > start, 'standalone protocol helpers must remain discoverable');
const official = new Function(`${source.slice(start, end)}\nreturn { createOfficialSemanticStream, decodeOfficialCompactDelta, applyOfficialDelta };`)();

test('hidden official consumer and SlimGPT agree on compact and expanded delta semantics', () => {
  const decoder = createConversationSseDecoder();
  decoder.decode({ event: 'delta_encoding', data: '"v1"' });
  const values = new Map();
  let previous = { channel: 0, op: 'add', path: '', value: undefined };
  const operations = [
    { channel: 4, op: 'add', path: '', value: { parts: ['一'], text: 'a' } },
    { channel: 4, op: 'add', path: '/parts/-', value: '二' },
    { p: '/text', o: 'append', v: 'b' },
    { v: 'b' },
    { p: '/parts', o: 'truncate', v: 1 },
    { p: '', o: 'patch', v: [{ p: '/text', o: 'replace', v: 'corrected' }, { p: '/parts/0', o: 'remove' }] },
    { c: 0, p: '', o: 'add', v: { text: 'independent' } },
    { c: 4, p: '/text', o: 'append', v: '!' },
  ];
  for (const raw of operations) {
    const delta = official.decodeOfficialCompactDelta(raw, previous);
    const value = official.applyOfficialDelta(values.get(delta.channel), delta);
    previous = delta;
    values.set(delta.channel, value);
    assert.deepEqual(value, decoder.decode({ event: 'delta', json: raw }), JSON.stringify(raw));
  }
});

test('official semantic projection keeps final/user identity for every SSE split and line ending', async () => {
  const user = { message: { id: 'u', author: { role: 'user' }, content: { parts: ['private question'] } }, conversation_id: 'c' };
  const answer = { message: { id: 'a', parent_id: 'u', author: { role: 'assistant' }, channel: 'final', status: 'finished_successfully', end_turn: true, content: { parts: ['private answer'] } }, conversation_id: 'c' };
  for (const newline of ['\n', '\r\n', '\r']) {
    const body = `\ufeffdata: ${JSON.stringify(user)}${newline}${newline}data: ${JSON.stringify(answer)}${newline}${newline}data: [DONE]${newline}${newline}`;
    for (let split = 0; split <= body.length; split += 1) {
      const projection = official.createOfficialSemanticStream();
      projection.setContext({ turnUserMessageId: 'u' });
      projection.accept(body.slice(0, split));
      projection.accept(body.slice(split));
      projection.finish(true);
      const text = await new Response(projection.readable).text();
      const frames = consumeSse('', text, true).frames;
      const messages = frames.map((frame) => frame.json?.message).filter(Boolean);
      assert.deepEqual(messages.map((message) => message.id), ['u', 'a'], `${JSON.stringify(newline)} at ${split}`);
      assert.equal(messages[1].parent_id, 'u');
      assert.equal(text.includes('private answer'), false, 'expensive answer must not reach hidden renderer');
      assert.equal(text.includes('private question'), false);
    }
  }
});

test('official projection never publishes a final from an unterminated frame', async () => {
  const projection = official.createOfficialSemanticStream();
  projection.accept(`data: ${JSON.stringify({ message: { id: 'partial', author: { role: 'assistant' }, end_turn: true, content: { parts: ['cut off'] } } })}`);
  projection.finish(false);
  assert.equal(await new Response(projection.readable).text(), '');
});

test('abnormal EOF preserves completed final identity and resume control without fabricating DONE', async () => {
  const projection = official.createOfficialSemanticStream();
  const resume = { type: 'resume_conversation_token', token: 'fixture-only', conversation_id: 'c' };
  const final = { message: { id: 'a', author: { role: 'assistant' }, end_turn: true, content: { parts: ['expensive answer'] } } };
  projection.accept(`data: ${JSON.stringify(resume)}\n\ndata: ${JSON.stringify(final)}\n\n`);
  projection.finish(false);
  const body = await new Response(projection.readable).text();
  assert.equal(body.includes('resume_conversation_token'), true);
  assert.equal(body.includes('"id":"a"'), true);
  assert.equal(body.includes('expensive answer'), false);
  assert.equal(body.includes('[DONE]'), false);
});
