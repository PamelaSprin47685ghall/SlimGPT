import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryLoader, errorCodeForStatus, listPageComplete, parseRetryAfter, sanitizeHeaders } from '../../src/page/history.js';

const O = 'https://chatgpt.com';
const ID = '6713a1f0-1234-4abc-8def-0123456789ab';
const json = (value, init = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), {
  status: init.status ?? 200,
  headers: { 'content-type': 'application/json', ...(init.headers || {}) },
});

function harness(routes, limits = {}) {
  const requests = [];
  const events = [];
  let clock = 1_000_000;
  const timers = new Map();
  let timerId = 0;
  const loader = createHistoryLoader({
    origin: O,
    fetch: async (url, init) => {
      requests.push({ url: new URL(url), headers: init.headers });
      const route = routes(new URL(url), requests.length);
      return typeof route === 'function' ? route() : route;
    },
    emit: (type, fields) => events.push({ type, ...fields }),
    onAuthFailure: () => events.push({ type: 'auth-failure' }),
    now: () => clock,
    setTimer: (fn, ms) => { timers.set(++timerId, { fn, at: clock + ms }); return timerId; },
    clearTimer: (id) => timers.delete(id),
    limits,
  });
  return {
    loader, requests, events,
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) { timers.delete(id); timer.fn(); }
      }
    },
    pendingTimers: () => timers.size,
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const authed = (h) => h.loader.setHeaders(new Headers({ authorization: 'Bearer t', 'content-type': 'application/json', 'content-length': '9', 'openai-sentinel-chat-requirements-token': 's', 'oai-device-id': 'd' }));

test('headers are sanitized: no body/sentinel headers, accept json, credentials stay in the page', () => {
  const headers = sanitizeHeaders(new Headers({ authorization: 'Bearer t', 'content-type': 'x', 'content-length': '1', accept: 'text/event-stream', 'openai-sentinel-proof-token': 'p', 'oai-language': 'zh' }));
  assert.deepEqual([...headers].sort(), [['accept', 'application/json'], ['authorization', 'Bearer t'], ['oai-language', 'zh']]);
});

test('status, retry-after and list completion helpers', () => {
  assert.equal(errorCodeForStatus(401), 'auth');
  assert.equal(errorCodeForStatus(403), 'auth');
  assert.equal(errorCodeForStatus(429), 'rate-limit');
  assert.equal(errorCodeForStatus(413), 'too-large');
  assert.equal(errorCodeForStatus(404), 'invalid');
  assert.equal(errorCodeForStatus(502), 'network');
  assert.equal(parseRetryAfter('7'), 7000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(listPageComplete('{"items":[{"id":"a"}],"total":1}', 0), true);
  assert.equal(listPageComplete('{"items":[{"id":"a"}],"has_more":true}', 0), false);
  assert.equal(listPageComplete('nope', 0), false);
});

test('loads queue until headers are known, then fetch the full history once (coalesced)', async () => {
  const h = harness(() => json({ conversation_id: ID, mapping: { a: {} }, current_node: 'a' }));
  h.loader.load(ID);
  h.loader.load(ID);
  assert.equal(h.requests.length, 0);
  authed(h);
  h.loader.load(ID);
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url.pathname, `/backend-api/conversation/${ID}`);
  assert.equal(h.requests[0].headers.get('authorization'), 'Bearer t');
  assert.equal(h.requests[0].headers.get('content-type'), null);
  assert.equal(h.requests[0].headers.get('accept'), 'application/json');
  assert.deepEqual(h.events.map((e) => [e.type, e.page, e.pages]), [['conversation', 1, 1]]);
  assert.equal(JSON.parse(h.events[0].body).mapping.a !== undefined, true);
});

test('refresh during an in-flight load triggers exactly one follow-up', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness(async (_url, n) => (n === 1 ? gate.then(() => json({ mapping: {} })) : json({ mapping: {} })));
  authed(h);
  h.loader.load(ID);
  h.loader.load(ID, { force: true });
  h.loader.load(ID, { force: true });
  await settle();
  assert.equal(h.requests.length, 1);
  release();
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.events.filter((e) => e.type === 'conversation').length, 2);
});

test('paged fallback (404 on the full endpoint) follows cursors and emits every page', async () => {
  const pages = {
    '': { conversation_id: ID, messages: [{ id: 'm3' }], page_info: { has_previous_page: true, start_cursor: 'c2' } },
    c2: { conversation_id: ID, messages: [{ id: 'm2' }], page_info: { has_previous_page: true, start_cursor: 'c1' } },
    c1: { conversation_id: ID, messages: [{ id: 'm1' }], page_info: { has_previous_page: false } },
  };
  const h = harness((url) => {
    if (url.pathname === `/backend-api/conversation/${ID}`) return json({ detail: 'gone' }, { status: 404 });
    if (url.pathname.endsWith('/messages') && url.searchParams.get('before') === 'c1') return json({}, { status: 404 });
    return json(pages[url.searchParams.get('before') || '']);
  });
  authed(h);
  h.loader.load(ID);
  await settle();
  assert.deepEqual(h.requests.map((r) => `${r.url.pathname}?${r.url.searchParams.get('before') || ''}`), [
    `/backend-api/conversation/${ID}?`,
    `/backend-api/conversations/${ID}?`,
    `/backend-api/conversations/${ID}/messages?c2`,
    `/backend-api/conversations/${ID}/messages?c1`,
    `/backend-api/conversations/${ID}?c1`,
  ]);
  assert.deepEqual(h.events.map((e) => [e.type, e.page, e.pages, JSON.parse(e.body).messages[0].id]), [
    ['conversation', 1, 3, 'm3'], ['conversation', 2, 3, 'm2'], ['conversation', 3, 3, 'm1'],
  ]);
});

test('a cursor that does not advance is invalid, never an endless loop', async () => {
  const h = harness((url) => (url.pathname.startsWith('/backend-api/conversation/')
    ? json({}, { status: 405 })
    : json({ messages: [{ id: url.searchParams.get('before') || 'x' }], page_info: { has_previous_page: true, start_cursor: 'same' } })));
  authed(h);
  h.loader.load(ID);
  await settle();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.events.map((e) => [e.type, e.code]), [['conversation-error', 'invalid']]);
});

test('identity mismatch and non-conversation bodies are invalid', async () => {
  const other = '00000000-0000-4000-8000-000000000000';
  for (const body of [{ conversation_id: other, mapping: {} }, { memories: [] }, 'not json']) {
    const h = harness(() => json(body));
    authed(h);
    h.loader.load(ID);
    await settle();
    assert.equal(h.events[0].type, 'conversation-error');
    assert.equal(h.events[0].code, 'invalid');
  }
});

test('429 honours Retry-After; loads inside the window answer locally without network', async () => {
  const h = harness(() => json({}, { status: 429, headers: { 'retry-after': '30' } }));
  authed(h);
  h.loader.load(ID);
  await settle();
  assert.deepEqual(h.events.at(-1), { type: 'conversation-error', conversationId: ID, code: 'rate-limit', retryAfterSec: 30 });
  h.advance(10_000);
  h.loader.load(ID, { force: true });
  await settle();
  assert.equal(h.requests.length, 1, 'no request during back-off');
  assert.equal(h.events.at(-1).retryAfterSec, 20);
  h.advance(21_000);
  assert.equal(h.requests.length, 1, 'no automatic retry');
  h.loader.load(ID);
  await settle();
  assert.equal(h.requests.length, 2);
});

test('exponential back-off without Retry-After; auth failures are reported', async () => {
  let status = 502;
  const h = harness(() => json({}, { status }));
  authed(h);
  const delays = [];
  for (let i = 0; i < 3; i += 1) {
    h.loader.load(ID);
    await settle();
    delays.push(h.events.at(-1).retryAfterSec);
    h.advance(h.events.at(-1).retryAfterSec * 1000);
  }
  assert.deepEqual(delays, [2, 3, 6]);
  status = 401;
  h.loader.load(ID);
  await settle();
  assert.equal(h.events.some((e) => e.type === 'auth-failure'), true);
  assert.equal(h.events.at(-1).code, 'auth');
});

test('network errors and oversize bodies map to network / too-large', async () => {
  const h = harness(() => { throw new TypeError('offline'); });
  authed(h);
  h.loader.load(ID);
  await settle();
  assert.equal(h.events.at(-1).code, 'network');
  const big = harness(() => json({ mapping: {}, pad: 'x'.repeat(5000) }), { maxPageBytes: 1000 });
  authed(big);
  big.loader.load(ID);
  await settle();
  assert.equal(big.events.at(-1).code, 'too-large');
});

test('schedule() defers to the official fetch: noteObserved cancels the own load', async () => {
  const h = harness(() => json({ mapping: {} }));
  authed(h);
  h.loader.schedule(ID, 1200);
  h.loader.noteObserved(ID);
  h.advance(5000);
  await settle();
  assert.equal(h.requests.length, 0);
  h.loader.schedule(ID, 1200);
  h.advance(1300);
  await settle();
  assert.equal(h.requests.length, 1);
});

test('official paged view with has_versions → one own full-tree load (cooldown-gated); 404 disables it', async () => {
  const h = harness((url) => (url.pathname.startsWith('/backend-api/conversation/') ? json({ conversation_id: ID, mapping: {} }) : json({}, { status: 500 })));
  authed(h);
  assert.equal(h.loader.noteObserved(ID), false, 'plain observation loads nothing');
  assert.equal(h.loader.noteObserved(ID, { wantsFullTree: true }), true);
  await settle();
  assert.deepEqual(h.requests.map((r) => r.url.pathname), [`/backend-api/conversation/${ID}`]);
  assert.equal(h.events.at(-1).type, 'conversation');
  assert.equal(h.loader.noteObserved(ID, { wantsFullTree: true }), false, 'within cooldown');
  h.advance(6000);
  assert.equal(h.loader.noteObserved(ID, { wantsFullTree: true }), true);
  await settle();
  assert.equal(h.requests.length, 2);

  const paged = { conversation_id: ID, messages: [], page_info: { has_previous_page: false } };
  const gone = harness((url) => (url.pathname.startsWith('/backend-api/conversation/') ? json({}, { status: 404 }) : json(paged)));
  authed(gone);
  gone.loader.noteObserved(ID, { wantsFullTree: true });
  await settle();
  assert.deepEqual(gone.requests.map((r) => r.url.pathname), [`/backend-api/conversation/${ID}`, `/backend-api/conversations/${ID}`]);
  gone.advance(60_000);
  assert.equal(gone.loader.noteObserved(ID, { wantsFullTree: true }), false, 'no full tree endpoint: do not keep asking');
});

test('invalid ids are refused', () => {
  const h = harness(() => json({}));
  authed(h);
  assert.equal(h.loader.load('../me'), false);
  assert.equal(h.loader.load('WEB:1'), false);
  assert.equal(h.requests.length, 0);
});

test('conversation list: bootstrap walks pages, refresh is first page only and cooldown-gated', async () => {
  const all = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}` }));
  const h = harness((url) => {
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    return json({ items: all.slice(offset, offset + limit), total: all.length, limit, offset });
  });
  assert.equal(h.loader.loadList(), false, 'waits for headers');
  authed(h);
  await settle();
  assert.deepEqual(h.events.map((e) => [e.offset, e.complete]), [[0, false], [100, false], [200, true]]);
  assert.equal(h.requests[0].url.searchParams.get('order'), 'updated');
  h.loader.loadList();
  await settle();
  assert.equal(h.requests.length, 3, 'cooldown');
  h.advance(6000);
  h.loader.loadList();
  await settle();
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[3].url.searchParams.get('offset'), '0');
});

test('conversation list stops on a repeated page instead of looping', async () => {
  const h = harness(() => json({ items: [{ id: 'a' }, { id: 'b' }], has_more: true }));
  authed(h);
  h.loader.loadList();
  await settle();
  assert.equal(h.requests.length, 2);
  assert.equal(h.events.length, 1);
});

test('noteRequested: an official history fetch in flight defers the fallback load (no duplicate), its response cancels it', async () => {
  const h = harness(() => json({ mapping: {} }));
  authed(h);
  h.loader.schedule(ID, 400);
  h.advance(100);
  h.loader.noteRequested(ID, 8000);
  h.advance(1000);
  await settle();
  assert.equal(h.requests.length, 0, 'fallback waits for the official response');
  h.loader.noteObserved(ID);
  h.advance(10000);
  await settle();
  assert.equal(h.requests.length, 0, 'the official response cancelled it');
  h.loader.noteRequested(ID, 10); // nothing scheduled: no-op
  h.advance(100);
  await settle();
  assert.equal(h.pendingTimers(), 0);
  h.loader.schedule(ID, 400);
  h.loader.noteRequested(ID, 8000);
  h.advance(8100);
  await settle();
  assert.equal(h.requests.length, 1, 'safety net when the official response never shows');
});
