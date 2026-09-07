import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../main-mitm.js', import.meta.url), 'utf8');
const start = source.indexOf('  function queueCanonicalConversation(');
const end = source.indexOf('  function installWebSocketObserver(', start);
const factory = new Function('env', `const {
  backendFetch, backendFetchThis, backendHeaders, backendSessionHeaders, location,
  CANONICAL_PAGE_TURNS, MAX_NON_STREAM_BODY, pendingCanonicalIds, canonicalFetches,
  canonicalQueueGenerations, canonicalAttemptedGenerations, canonicalFailureCounts,
  canonicalBackoffUntil, nextRequestId, emit, isProvisionalConversationId, Date,
} = env;
${source.slice(start, end)}
return { queueCanonicalConversation, drainCanonicalFetches };`);

const history = (id, previous = false) => new Response(JSON.stringify({ conversation_id: id, current_node: 'u',
  messages: [{ id: 'u', author: { role: 'user' }, content: { parts: ['fixture'] } }],
  page_info: { has_previous_page: previous, start_cursor: 'cursor' },
}), { headers: { 'content-type': 'application/json' } });
function harness(fetch) {
  const events = [];
  let time = 1_000_000, serial = 0;
  const env = {
    backendFetch: fetch, backendHeaders: new Headers(), backendSessionHeaders: null, location: { origin: 'https://chatgpt.com' },
    CANONICAL_PAGE_TURNS: 10, MAX_NON_STREAM_BODY: 1024 * 1024,
    pendingCanonicalIds: new Set(), canonicalFetches: new Map(), canonicalQueueGenerations: new Map(),
    canonicalAttemptedGenerations: new Map(), canonicalFailureCounts: new Map(), canonicalBackoffUntil: new Map(),
    nextRequestId: () => `sync-${++serial}`, emit: (event) => events.push(event),
    isProvisionalConversationId: (id) => id.startsWith('WEB:'),
    Date: { now: () => time, parse: Date.parse },
  };
  return { ...factory(env), env, events, advance: (ms) => { time += ms; } };
}
async function settle() { for (let i = 0; i < 6; i++) await new Promise((done) => setImmediate(done)); }

test('failed older reads publish no partial pages, report a classified failure, and honor the complete server backoff', async () => {
  let count = 0;
  const h = harness(async () => {
    count++;
    if (count === 1) return history('c', true);
    if (count === 2) return new Response('private server body', { status: 429, headers: { 'retry-after': '120' } });
    return history('c');
  });
  h.queueCanonicalConversation('c');
  await settle();
  assert.equal(h.events.some((event) => event.type === 'page-capture'), false);
  const failed = h.events.find((event) => event.state === 'error');
  assert.equal(failed.status, 429);
  assert.equal(failed.retryAfterMs, 120000);
  assert.equal(JSON.stringify(h.events).includes('private server body'), false);
  h.advance(60001);
  h.queueCanonicalConversation('c');
  await settle();
  assert.equal(count, 2, 'a server 120 second cooldown must not become 60 seconds');
  assert.equal(h.events.at(-1).code, 'backoff');
  h.advance(60000);
  h.queueCanonicalConversation('c');
  await settle();
  assert.equal(count, 3);
  const pages = h.events.filter((event) => event.type === 'page-capture');
  assert.equal(pages.length, 1);
  assert.equal(pages[0].canonicalPageCount, 1);
  assert.equal(pages[0].canonicalPageIndex, 0);
  assert.equal(pages[0].canonicalComplete, true);
  assert.equal(h.events.at(-1).state, 'complete');
});

test('concurrent long-history reads have bounded parallelism and drain queued conversations without polling', async () => {
  let active = 0, peak = 0, completed = 0;
  const releases = [];
  const h = harness((url) => new Promise((accept) => {
    active++; peak = Math.max(peak, active);
    releases.push(() => { active--; completed++; accept(history(new URL(url).pathname.split('/').at(-1))); });
  }));
  for (let i = 0; i < 8; i++) h.queueCanonicalConversation(`c${i}`);
  const initialActive = active;
  while (releases.length) {
    releases.shift()();
    await settle();
  }
  assert.equal(completed, 8);
  assert.ok(initialActive <= 3, 'each transaction can retain tens of MB: simultaneous histories need a fixed cap');
  assert.ok(peak <= 3);
  assert.equal(h.env.pendingCanonicalIds.size, 0);
  assert.equal(h.env.canonicalFetches.size, 0);
  assert.equal(h.events.filter((event) => event.canonicalComplete).length, 8);
});
