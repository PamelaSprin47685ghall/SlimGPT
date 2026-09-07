import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../main-mitm.js', import.meta.url), 'utf8');
const start = source.indexOf('  function canonicalFetchFailure(');
const end = source.indexOf('  function installWebSocketObserver(', start);
assert.ok(start >= 0 && end > start);
const load = new Function('backendFetch', 'backendFetchThis', 'location', 'CANONICAL_PAGE_TURNS', 'MAX_NON_STREAM_BODY',
  `${source.slice(start, end)}; return { fetchCanonicalConversationPages };`);
const list = (id, previous = false, cursor = 'cursor') => ({ conversation_id: 'c', current_node: id,
  messages: [{ id, author: { role: 'assistant' }, content: { parts: [id] } }],
  page_info: { has_previous_page: previous, start_cursor: cursor },
});
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function reader(fetch, maxBody = 20 * 1024 * 1024) {
  return load(fetch, undefined, { origin: 'https://chatgpt.com' }, 100, maxBody).fetchCanonicalConversationPages;
}

test('mapping pages with explicit pagination continue to the oldest page instead of stopping at the first current_node', async () => {
  const requested = [];
  const read = reader(async (url) => {
    requested.push(url);
    return response({ id: 'c', current_node: requested.length === 1 ? 'new' : 'old', mapping: {
      [requested.length === 1 ? 'new' : 'old']: { id: requested.length === 1 ? 'new' : 'old', parent: requested.length === 1 ? 'old' : null, message: null },
    }, page_info: { has_previous_page: requested.length === 1, start_cursor: 'old-cursor' } });
  });
  const pages = await read('c', new Headers());
  assert.equal(pages.length, 2);
  assert.equal(new URL(requested[1]).searchParams.get('before'), 'old-cursor');
});

test('the page limit cannot convert a still-incomplete chain into a complete result', async () => {
  let count = 0;
  const read = reader(async () => response(list(`m${++count}`, true, `cursor-${count}`)));
  await assert.rejects(read('c', new Headers(), { maxPages: 3 }), /limit|incomplete/i);
  assert.equal(count, 3);
});

test('unrecognized or malformed 200 responses are failures, not empty successful histories', async () => {
  for (const body of [{ error: 'server error' }, [], { messages: [], page_info: null }, { ...list('a'), messages: [null] }, { ...list('a'), page_info: { has_previous_page: 'false' } }]) {
    await assert.rejects(reader(async () => response(body))('c', new Headers()), /canonical|page/i);
  }
});

test('conversation identity is checked on every page, including wrapped responses', async () => {
  for (const body of [{ ...list('a'), conversation_id: 'foreign' }, { conversation_id: 'foreign', data: list('a') }, { data: { ...list('a'), conversation_id: 'foreign' } }]) {
    await assert.rejects(reader(async () => response(body))('c', new Headers()), /identity|conversation|mismatch/i);
  }
});

test('flat-list pagination requires explicit completeness, while legacy mapping remains supported', async () => {
  const { page_info, ...noPagination } = list('a');
  await assert.rejects(reader(async () => response(noPagination))('c', new Headers()), /pagination|page/i);
  const pages = await reader(async () => response({ id: 'c', current_node: 'root', mapping: { root: { id: 'root', message: null } } }))('c', new Headers());
  assert.equal(pages.length, 1);
});

test('fallback to the unified older-page endpoint does not consume a failed body', async () => {
  const requested = [];
  let canceled = false;
  const read = reader(async (url) => {
    requested.push(url);
    if (new URL(url).pathname.endsWith('/messages')) return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 404 });
    return response(list(requested.length === 1 ? 'latest' : 'oldest', requested.length === 1));
  });
  const pages = await read('c', new Headers());
  assert.equal(pages.length, 2);
  assert.equal(requested.length, 3);
  assert.equal(canceled, true);
});

test('a failed older page aborts the transaction and never retries as a different endpoint on rate limits', async () => {
  let count = 0;
  const read = reader(async () => ++count === 1 ? response(list('a', true)) : new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  await assert.rejects(read('c', new Headers()), (error) => error.status === 429 && error.retryAfterMs === 120000);
  assert.equal(count, 2);
});

test('repeated cursor terminates with failure, not an endless read loop', async () => {
  let count = 0;
  await assert.rejects(reader(async () => response(list(`m${++count}`, true, 'same')))('c', new Headers()), /cursor/i);
  assert.equal(count, 2);
});

test('the aggregate byte limit covers all pages, not only each individual page', async () => {
  let count = 0;
  const body = list('a', true);
  body.messages[0].content.parts = ['中文'.repeat(30)];
  const read = reader(async () => response({ ...body, page_info: { has_previous_page: ++count < 3, start_cursor: `cursor-${count}` } }));
  await assert.rejects(read('c', new Headers(), { maxTotalBytes: 500 }), /size|budget|limit/i);
});

test('one oversized streaming page is canceled before consuming the full response', async () => {
  let pulls = 0, canceled = false;
  const read = reader(async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(256)); },
    cancel() { canceled = true; },
  })), 128);
  await assert.rejects(read('c', new Headers()), /size|budget|limit/i);
  assert.equal(canceled, true);
  assert.ok(pulls < 5);
});

test('a stalled request can be aborted by its finite deadline', async () => {
  let signal;
  const read = reader((_url, options) => new Promise((_accept, reject) => {
    signal = options.signal;
    if (!signal) { reject(new Error('fixture missing request deadline')); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(read('c', new Headers(), { requestTimeoutMs: 5 }));
  assert.equal(signal?.aborted, true);
});

test('the request deadline also covers a body that stops sending after headers', async () => {
  let canceled = false;
  const read = reader(async () => new Response(new ReadableStream({ cancel() { canceled = true; } })));
  await assert.rejects(read('c', new Headers(), { requestTimeoutMs: 5 }), /timed out/);
  assert.equal(canceled, true);
});

test('empty canonical histories can complete in either modern or legacy shape', async () => {
  for (const body of [
    { conversation_id: 'c', messages: [], page_info: { has_previous_page: false }, current_node: null },
    { id: 'c', mapping: {}, current_node: null },
  ]) {
    assert.equal((await reader(async () => response(body))('c', new Headers())).length, 1);
  }
});
