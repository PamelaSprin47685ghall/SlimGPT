import assert from 'node:assert/strict';
import test from 'node:test';
import { createFetchTee, installFetchTee } from '../../src/page/fetch-tee.js';

const O = 'https://chatgpt.com';
const ID = '6713a1f0-1234-4abc-8def-0123456789ab';

function streamResponse(parts, { type = 'text/event-stream', status = 200, fail = false } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < parts.length) controller.enqueue(encoder.encode(parts[index++]));
      else if (fail) controller.error(new Error('network'));
      else controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': type } });
}

function recorder() {
  const events = [];
  const handlers = {
    onBackendHeaders: (headers) => events.push(['headers', headers.get('authorization')]),
    onSubmission: (result) => events.push(['submission', result]),
    onStreamStart: (start) => events.push(['start', start]),
    onStreamChunk: (id, chunk) => events.push(['chunk', id, chunk]),
    onStreamEnd: (id, ok) => events.push(['end', id, ok]),
    onHistory: (id, body) => events.push(['history', id, body]),
    onList: (offset, body) => events.push(['list', offset, body]),
  };
  return { events, handlers };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('SSE: official app gets the identical Response, untouched; the tee forwards raw chunks in order', async () => {
  const parts = ['event: delta_encoding\ndata: "v1"\n\n', 'data: {"v":"Hel', 'lo"}\n\n', 'data: [DONE]\n\n'];
  const original = streamResponse(parts);
  const { events, handlers } = recorder();
  const tee = createFetchTee({ pageOrigin: O, handlers });
  const fetch = tee.wrap(async () => original);
  const body = JSON.stringify({ conversation_id: ID, parent_message_id: 'p1', messages: [{ id: 'u1', author: { role: 'user' } }] });
  const response = await fetch(`${O}/backend-api/f/conversation`, {
    method: 'POST', body, headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
  });
  assert.equal(response, original, 'observe-only: same object');
  assert.equal(await response.text(), parts.join(''), 'official body byte-identical');
  await settle();
  assert.deepEqual(events[0], ['headers', 'Bearer t']);
  assert.deepEqual(events[1], ['submission', { ok: true, status: 200 }]);
  const start = events.find((event) => event[0] === 'start')[1];
  assert.deepEqual({ ...start, streamId: 'x' }, { streamId: 'x', conversationId: ID, userMessageId: 'u1', parentMessageId: 'p1', userText: null, resume: false, format: 'sse' });
  const chunks = events.filter((event) => event[0] === 'chunk');
  assert.equal(chunks.map((event) => event[2]).join(''), parts.join(''));
  assert.ok(chunks.every((event) => event[1] === start.streamId));
  const startAt = events.findIndex((event) => event[0] === 'start');
  assert.ok(events.findIndex((event) => event[0] === 'chunk') > startAt);
  assert.deepEqual(events.at(-1), ['end', start.streamId, true]);
});

test('SSE transport failure ends the stream with ok=false; official still sees its own error', async () => {
  const original = streamResponse(['data: {"a":1}\n\n'], { fail: true });
  const { events, handlers } = recorder();
  const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async () => original);
  const response = await fetch('/backend-api/f/conversation/resume', { method: 'POST', body: '{}' });
  await assert.rejects(response.text());
  await settle();
  assert.equal(events.find((event) => event[0] === 'start')[1].resume, true);
  assert.equal(events.at(-1)[2], false);
});

test('Request input bodies are cloned, never consumed', async () => {
  const { events, handlers } = recorder();
  let seenBody = null;
  const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async (request) => {
    seenBody = await request.text();
    return streamResponse(['data: [DONE]\n\n']);
  });
  const payload = JSON.stringify({ conversation_id: ID, messages: [{ id: 'u9', author: { role: 'user' } }] });
  await fetch(new Request(`${O}/backend-api/conversation`, { method: 'POST', body: payload }));
  await settle();
  assert.equal(seenBody, payload);
  assert.equal(events.find((event) => event[0] === 'start')[1].userMessageId, 'u9');
});

test('a ReadableStream init.body is not read (ids unknown, official request intact)', async () => {
  const { events, handlers } = recorder();
  const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async (_url, init) => {
    assert.equal(init.body.locked, false);
    return streamResponse(['data: [DONE]\n\n']);
  });
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{}')); c.close(); } });
  await fetch(`${O}/backend-api/conversation`, { method: 'POST', body, duplex: 'half' });
  await settle();
  assert.equal(events.find((event) => event[0] === 'start')[1].userMessageId, null);
});

test('history and list GETs are forwarded raw; failures, non-JSON and look-alikes are not', async () => {
  const { events, handlers } = recorder();
  const routes = {
    [`/backend-api/conversation/${ID}`]: () => new Response('{"mapping":{}}', { headers: { 'content-type': 'application/json' } }),
    '/backend-api/conversations': () => new Response('{"items":[]}', { headers: { 'content-type': 'application/json; charset=utf-8' } }),
    '/backend-api/memories': () => new Response('{"memories":[{"id":"m","content":"x"}]}', { headers: { 'content-type': 'application/json' } }),
    [`/backend-api/conversation/${ID}x`]: () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    '/backend-api/conversation/init': () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
  };
  const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async (url) => {
    const path = new URL(url, O).pathname;
    return routes[path] ? routes[path]() : new Response('nope', { status: 500 });
  });
  for (const path of Object.keys(routes)) await (await fetch(`${O}${path}?offset=0`)).text();
  await fetch(`${O}/backend-api/conversation/${ID}`.replace(ID, '00000000-0000-4000-8000-000000000000'));
  await settle();
  assert.deepEqual(events, [
    ['history', ID, '{"mapping":{}}'],
    ['list', 0, '{"items":[]}'],
  ]);
});

test('oversized history bodies are dropped, not truncated', async () => {
  const { events, handlers } = recorder();
  const big = 'x'.repeat(2048);
  const fetch = createFetchTee({ pageOrigin: O, handlers, maxJsonBytes: 1024 }).wrap(async () =>
    new Response(big, { headers: { 'content-type': 'application/json' } }));
  assert.equal((await (await fetch(`/backend-api/conversation/${ID}`)).text()).length, 2048);
  await settle();
  assert.deepEqual(events, []);
});

test('upstream rejection propagates unchanged and reports a failed submission', async () => {
  const { events, handlers } = recorder();
  const boom = new TypeError('Failed to fetch');
  const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async () => { throw boom; });
  await assert.rejects(fetch('/backend-api/conversation', { method: 'POST', body: '{}' }), (error) => error === boom);
  assert.deepEqual(events, [['submission', { ok: false, status: 0 }]]);
});

test('handler exceptions never reach the official caller', async () => {
  const handlers = { onSubmission() { throw new Error('bug'); }, onStreamStart() { throw new Error('bug'); } };
  const original = streamResponse(['data: [DONE]\n\n']);
  const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async () => original);
  const response = await fetch('/backend-api/conversation', { method: 'POST', body: '{}' });
  assert.equal(await response.text(), 'data: [DONE]\n\n');
});

test('non-SSE submit responses are not streamed; other origins are ignored', async () => {
  const { events, handlers } = recorder();
  const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async () =>
    new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));
  await fetch('/backend-api/conversation', { method: 'POST', body: '{}' });
  await fetch('https://example.com/backend-api/conversation', { method: 'POST', body: '{}', headers: { authorization: 'Bearer leak' } });
  await settle();
  assert.deepEqual(events, [['submission', { ok: true, status: 200 }]]);
});

test('installFetchTee re-wraps a later window.fetch assignment exactly once', async () => {
  const calls = [];
  const win = { fetch: async () => new Response('a') };
  const tee = createFetchTee({ pageOrigin: O, handlers: {} });
  installFetchTee(win, tee);
  const first = win.fetch;
  assert.equal(win.fetch, first);
  const replacement = async () => { calls.push('replacement'); return new Response('b'); };
  win.fetch = replacement;
  assert.notEqual(win.fetch, replacement);
  assert.equal(await (await win.fetch('/x')).text(), 'b');
  win.fetch = win.fetch; // assigning the wrapper back must not double-wrap
  assert.equal(await (await win.fetch('/x')).text(), 'b');
  assert.deepEqual(calls, ['replacement', 'replacement']);
});

// ------------------------------------------------------------ free mode (logged out)

const CONV = '00000000-0000-4000-8000-000000000002';
const USER_ID = '00000000-0000-4000-8000-000000000004';
const PARENT_ID = '00000000-0000-4000-8000-000000000003';
const SECRET = 'eyJSECRET.TOKEN.VALUE';
const NDJSON = 'application/vnd.openai.conversation-source+ndjson';
const FREE_URL = `${O}/unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=00000000-0000-4000-8000-000000000001`;

function freeForm() {
  const form = new URLSearchParams();
  form.set('conversationState', JSON.stringify({ backendConversationId: CONV, messages: [], parentMessageId: PARENT_ID }));
  form.set('oai-session-id', 'session-secret');
  form.set('prompt', 'hello, free mode');
  form.set('assistantMessageId', 'pending-x');
  form.set('userMessageId', USER_ID);
  for (const name of ['chatRequirementsToken', 'proofToken', 'turnstileToken']) form.set(name, SECRET);
  return form;
}

function freeEvents(events) {
  const start = events.find((event) => event[0] === 'start')?.[1];
  return { start, text: JSON.stringify(events) };
}

test('free mode: NDJSON stream is teed with prompt + ids only, official Response untouched', async () => {
  const lines = ['{"version":1,"type":"control","detail":{"kind":"started"}}\n', '{"version":1,"type":"end"}\n'];
  const original = streamResponse(lines, { type: NDJSON });
  const { events, handlers } = recorder();
  const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async () => original);
  const response = await fetch(FREE_URL, { method: 'POST', body: freeForm().toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(response, original);
  assert.equal(await response.text(), lines.join(''));
  await settle();
  const { start, text } = freeEvents(events);
  assert.deepEqual(events[0], ['submission', { ok: true, status: 200 }]);
  assert.deepEqual({ ...start, streamId: 'x' }, {
    streamId: 'x', conversationId: CONV, userMessageId: USER_ID, parentMessageId: PARENT_ID,
    userText: 'hello, free mode', resume: false, format: 'conversation-source',
  });
  assert.ok(!text.includes(SECRET) && !text.includes('session-secret'), 'tokens are never forwarded');
  assert.equal(events.filter((event) => event[0] === 'chunk').map((event) => event[2]).join(''), lines.join(''));
  assert.deepEqual(events.at(-1), ['end', start.streamId, true]);
});

test('free mode: URLSearchParams, FormData and Request bodies are read without consuming them', async () => {
  for (const make of [
    () => [FREE_URL, { method: 'POST', body: freeForm() }],
    () => { const data = new FormData(); for (const [k, v] of freeForm()) data.set(k, v); return [FREE_URL, { method: 'POST', body: data }]; },
    () => [new Request(FREE_URL, { method: 'POST', body: freeForm() })],
  ]) {
    const { events, handlers } = recorder();
    let upstreamSaw = null;
    const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async (input, init) => {
      upstreamSaw = input instanceof Request ? await input.text() : init.body;
      return streamResponse(['{"version":1,"type":"end"}\n'], { type: NDJSON });
    });
    await fetch(...make());
    await settle();
    const { start, text } = freeEvents(events);
    assert.ok(upstreamSaw, 'official request body intact');
    assert.equal(start.userText, 'hello, free mode');
    assert.equal(start.userMessageId, USER_ID);
    assert.equal(start.conversationId, CONV);
    assert.ok(!text.includes(SECRET));
  }
});

test('free mode: first message has no conversation id; non-NDJSON answers are not teed', async () => {
  const form = freeForm();
  form.set('conversationState', JSON.stringify({ messages: [], parentMessageId: 'client-created-root' }));
  const { events, handlers } = recorder();
  const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async () => streamResponse(['{"version":1,"type":"end"}\n'], { type: NDJSON }));
  await fetch(FREE_URL, { method: 'POST', body: form });
  await settle();
  const { start } = freeEvents(events);
  assert.equal(start.conversationId, null);
  assert.equal(start.parentMessageId, null);

  const other = recorder();
  const jsonFetch = createFetchTee({ pageOrigin: O, handlers: other.handlers }).wrap(async () => new Response('{"error":1}', { status: 200, headers: { 'content-type': 'application/json' } }));
  await jsonFetch(FREE_URL, { method: 'POST', body: freeForm() });
  await settle();
  assert.deepEqual(other.events, [['submission', { ok: true, status: 200 }]]);

  const failed = recorder();
  const rejectFetch = createFetchTee({ pageOrigin: O, handlers: failed.handlers }).wrap(async () => new Response('', { status: 429 }));
  await rejectFetch(FREE_URL, { method: 'POST', body: freeForm() });
  assert.deepEqual(failed.events, [['submission', { ok: false, status: 429 }]]);
});

test('free mode: only the exact updates path is captured; free-mode URLs are signalled', async () => {
  const { events, handlers } = recorder();
  let signals = 0;
  handlers.onFreeModeRequest = () => { signals += 1; };
  const fetch = createFetchTee({ pageOrigin: O, handlers }).wrap(async () => streamResponse(['{"version":1,"type":"end"}\n'], { type: NDJSON }));
  await fetch(`${O}/unauth-mweb/conversation/updates/extra`, { method: 'POST', body: freeForm() });
  await fetch(`${O}/unauth-mweb/conversation/prepare`, { method: 'POST', body: '{}' });
  await fetch(`${O}/backend-anon/beacons/home`);
  await fetch(`https://evil.example/unauth-mweb/conversation/updates`, { method: 'POST', body: freeForm() });
  await fetch(`${O}/unauth-mweb/conversation/updates`, { method: 'GET' });
  await settle();
  assert.deepEqual(events, []);
  assert.equal(signals, 4);
});

test('history request start is reported before the response; models / settings bodies and the submit model are observed read-only', async () => {
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tee = createFetchTee({ pageOrigin: O, handlers: {
    onHistoryRequest: (id) => events.push(['history-request', id]),
    onHistory: (id) => events.push(['history', id]),
    onModels: (body) => events.push(['models', JSON.parse(body).default_model_slug]),
    onUserSettings: (body) => events.push(['settings', JSON.parse(body).available_options.backend_reasoning_effort]),
    onSubmitChoice: (choice) => events.push(['choice', choice]),
  } });
  const upstream = async (url) => {
    const path = new URL(url, O).pathname;
    if (path.startsWith('/backend-api/conversations/')) { await gate; return new Response('{"messages":[]}', { headers: { 'content-type': 'application/json' } }); }
    if (path === '/backend-api/models') return new Response('{"default_model_slug":"auto","models":[]}', { headers: { 'content-type': 'application/json' } });
    if (path === '/backend-api/settings/user') return new Response('{"available_options":{"backend_reasoning_effort":["instant"]}}', { headers: { 'content-type': 'application/json' } });
    return streamResponse(['data: [DONE]\n\n']);
  };
  const fetch = tee.wrap(upstream);
  const pending = fetch(`/backend-api/conversations/${ID}?num_turns=10&include_has_versions=true`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(events, [['history-request', ID]], 'reported at request start');
  release();
  await pending;
  await fetch('/backend-api/models?iim=false');
  await fetch('/backend-api/settings/user');
  const body = JSON.stringify({ action: 'next', model: 'gpt-6', messages: [] });
  const response = await fetch('/backend-api/f/conversation', { method: 'POST', body });
  await response.text();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const later = events.slice(1).map((event) => JSON.stringify(event)).sort();
  assert.deepEqual(later, [['history', ID], ['models', 'auto'], ['settings', ['instant']], ['choice', { model: 'gpt-6', effort: null }]].map((event) => JSON.stringify(event)).sort());
});
