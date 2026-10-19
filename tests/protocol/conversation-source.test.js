// Logged-out (free mode) conversation-source NDJSON decoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/protocol/index.js';
import { fixture, rng } from './helpers.js';

const BODY = fixture('anon-conversation-source.ndjson');
const CONV = '00000000-0000-4000-8000-000000000002';
const REPLY = '00000000-0000-4000-8000-000000000003';
const USER = '00000000-0000-4000-8000-000000000004';
const FINAL_TEXT = '- Hello! 👋\n- Ready to help with Python, coding, or anything else.\n\n```python\ndef hello():\n    print("Hello, world!")\n\nhello()\n```';

function decode(text, sizes = [text.length || 1], options) {
  const decoder = P.createConversationSourceDecoder(options);
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

const line = (value) => `${JSON.stringify({ version: 1, ...value })}\n`;
const content = (revision, mode, markdown, extra = {}) => line({ type: 'content', messageId: REPLY, revision, mode, markdown, ...extra });
const lastMessage = (events) => events.filter((event) => event.type === 'message').at(-1);

test('captured free-mode stream decodes to one complete assistant snapshot', () => {
  const events = decode(BODY);
  assert.deepEqual(events.map((event) => event.type), ['conversation-id', 'message', 'message', 'message', 'message', 'done']);
  assert.equal(events[0].conversationId, CONV);
  const final = lastMessage(events);
  assert.equal(final.conversationId, CONV);
  assert.equal(final.raw.id, REPLY);
  assert.equal(final.raw.status, 'finished_successfully');
  assert.equal(final.raw.metadata.parent_id, USER);
  assert.equal(final.raw.content.parts[0], FINAL_TEXT);
  const message = P.normalizeMessage(final.raw);
  assert.equal(message.role, 'assistant');
  assert.equal(message.status, 'done');
  assert.deepEqual(message.blocks.map((block) => block.kind), ['text']);
  assert.equal(message.blocks[0].markdown, FINAL_TEXT);
});

test('intermediate snapshots are streaming and grow by exact appends', () => {
  const messages = decode(BODY).filter((event) => event.type === 'message');
  assert.equal(messages[0].raw.content.parts[0], '- Hello! 👋');
  assert.equal(P.normalizeMessage(messages[0].raw).status, 'streaming');
  for (let index = 1; index < messages.length; index += 1) {
    assert.ok(messages[index].raw.content.parts[0].startsWith(messages[index - 1].raw.content.parts[0]));
  }
});

test('any chunk split yields identical events', () => {
  const expected = JSON.stringify(decode(BODY));
  for (const sizes of [[1], [2], [3], [7], [64], [1, 5, 2, 13], [4096]]) {
    assert.equal(JSON.stringify(decode(BODY, sizes)), expected, `sizes ${sizes}`);
  }
  const random = rng(7);
  for (let round = 0; round < 40; round += 1) {
    const sizes = Array.from({ length: 6 }, () => 1 + Math.floor(random() * 90));
    assert.equal(JSON.stringify(decode(BODY, sizes)), expected, `sizes ${sizes}`);
  }
});

test('CRLF line endings are accepted', () => {
  assert.equal(JSON.stringify(decode(BODY.replace(/\n/g, '\r\n'), [5])), JSON.stringify(decode(BODY)));
});

test('append whose baseRevision does not match fails with revision-gap, keeping the last good text', () => {
  const body = content(1, 'replace', 'Hello') + content(3, 'append', ' world', { baseRevision: 2 }) + line({ type: 'end' });
  const events = decode(body);
  assert.deepEqual(events.map((event) => event.type), ['message', 'message', 'error']);
  assert.equal(events[2].code, 'revision-gap');
  assert.equal(events[1].raw.content.parts[0], 'Hello');
  assert.equal(P.normalizeMessage(events[1].raw).status, 'interrupted');
});

test('append for an unknown message is a revision gap, never a guess', () => {
  const events = decode(content(2, 'append', 'tail', { baseRevision: 1 }) + line({ type: 'end' }));
  assert.deepEqual(events.map((event) => event.type), ['error']);
  assert.equal(events[0].code, 'revision-gap');
});

test('replayed revisions are ignored; replace takes the full text', () => {
  const body = content(1, 'replace', 'A') + content(2, 'append', 'B', { baseRevision: 1 }) +
    content(2, 'append', 'B', { baseRevision: 1 }) + content(1, 'replace', 'stale') +
    content(3, 'replace', 'Fresh', { status: 'complete' }) + line({ type: 'end' });
  const events = decode(body);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(lastMessage(events).raw.content.parts[0], 'Fresh');
  assert.equal(events.filter((event) => event.type === 'message').length, 3);
});

test('stream without an end line is truncated and open messages become interrupted', () => {
  const cut = BODY.slice(0, BODY.indexOf('"revision":3'));
  const events = decode(cut.slice(0, cut.lastIndexOf('\n') + 1));
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).code, 'truncated');
  assert.equal(P.normalizeMessage(lastMessage(events).raw).status, 'interrupted');
});

test('end before completion marks the message interrupted, then done', () => {
  const events = decode(content(1, 'replace', 'partial') + line({ type: 'end' }));
  assert.deepEqual(events.map((event) => event.type), ['message', 'message', 'done']);
  assert.equal(P.normalizeMessage(events[1].raw).status, 'interrupted');
});

test('non-complete terminal marks the message interrupted', () => {
  const body = content(1, 'replace', 'x') +
    line({ type: 'control', detail: { kind: 'terminal-received', conversationId: CONV, messageId: REPLY, terminalKind: 'aborted' } }) +
    line({ type: 'end' });
  const events = decode(body);
  const statuses = events.filter((event) => event.type === 'message').map((event) => P.normalizeMessage(event.raw).status);
  assert.deepEqual(statuses, ['streaming', 'interrupted']);
  assert.ok(events.some((event) => event.type === 'conversation-id' && event.conversationId === CONV));
});

test('conversation id is also learned from state lines', () => {
  const state = JSON.stringify({ backendConversationId: CONV, parentMessageId: REPLY });
  const events = decode(line({ type: 'state', conversationState: state }) + line({ type: 'end' }));
  assert.deepEqual(events, [{ type: 'conversation-id', conversationId: CONV }, { type: 'done' }]);
});

test('broken lines and wrong versions fail closed', () => {
  assert.equal(decode('{not json}\n').at(-1).code, 'invalid-json');
  assert.equal(decode('[1,2]\n').at(-1).code, 'invalid-json');
  assert.equal(decode(`${JSON.stringify({ version: 2, type: 'end' })}\n`).at(-1).code, 'unsupported-encoding');
  assert.equal(decode(content(1, 'replace', 5)).at(-1).code, 'invalid-json');
  assert.equal(decode(content(1, 'merge', 'x')).at(-1).code, 'revision-gap');
  assert.equal(decode('x'.repeat(100), [100], { maxLineChars: 50 }).at(-1).code, 'buffer-limit');
  assert.equal(decode(content(1, 'replace', 'x'.repeat(100)), [1000], { maxMessageChars: 50 }).at(-1).code, 'buffer-limit');
});

test('nothing is emitted after an error or after done', () => {
  const decoder = P.createConversationSourceDecoder();
  assert.equal(decoder.push('garbage\n').at(-1).type, 'error');
  assert.deepEqual(decoder.push(BODY), []);
  assert.deepEqual(decoder.end(), []);
  const done = P.createConversationSourceDecoder();
  done.push(line({ type: 'end' }));
  assert.deepEqual(done.push(content(1, 'replace', 'late')), []);
  assert.deepEqual(done.end(), []);
});

test('shared HTML and unknown line types are ignored', () => {
  const body = line({ type: 'shared', html: '<template></template>' }) + line({ type: 'future', x: 1 }) + line({ type: 'end' });
  assert.deepEqual(decode(body), [{ type: 'done' }]);
});

test('fuzz: random bytes and mutations never throw and stay within the event contract', () => {
  const random = rng(42);
  const alphabet = '{}[]":,\n\r abc01-\\';
  for (let round = 0; round < 300; round += 1) {
    let text;
    if (round % 2) {
      text = Array.from({ length: 1 + Math.floor(random() * 200) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    } else {
      const chars = BODY.split('');
      for (let edit = 0; edit < 5; edit += 1) chars[Math.floor(random() * chars.length)] = alphabet[Math.floor(random() * alphabet.length)];
      text = chars.join('');
    }
    const events = decode(text, [1 + Math.floor(random() * 50)]);
    let terminal = false;
    for (const event of events) {
      assert.ok(!terminal, 'event after terminal');
      assert.ok(['message', 'conversation-id', 'done', 'error'].includes(event.type));
      if (event.type === 'error') assert.ok(P.STREAM_ERROR_CODES.includes(event.code));
      if (event.type === 'done' || event.type === 'error') terminal = true;
      if (event.type === 'message') assert.ok(P.normalizeMessage(event.raw));
    }
    assert.ok(terminal, 'every body ends in done or error');
  }
  const decoder = P.createConversationSourceDecoder();
  for (const value of [null, undefined, 5, {}, [], '']) assert.doesNotThrow(() => decoder.push(value));
});

test('user prompt becomes a canonical user message; live turn assembles', () => {
  const user = P.userMessageFromPrompt({ id: USER, text: 'hello there' });
  assert.equal(P.normalizeMessage(user).role, 'user');
  assert.equal(P.userMessageFromPrompt({ id: '', text: 'x' }), null);
  assert.equal(P.userMessageFromPrompt(null), null);
  let conv = P.applyLiveMessage(P.createConversation(CONV), user);
  for (const event of decode(BODY)) if (event.type === 'message') conv = P.applyLiveMessage(conv, event.raw, { fallbackParentId: USER });
  const turns = P.selectTurns(conv);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user.blocks[0].markdown, 'hello there');
  assert.equal(turns[0].replies[0].blocks[0].markdown, FINAL_TEXT);
});
