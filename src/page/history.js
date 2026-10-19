// Canonical history + conversation list loader with paging and back-off.
//
// Event-driven only: a failure never schedules its own retry; it records a
// back-off window and reports `conversation-error`. Requests during that
// window are answered from the window (no network). Bodies are forwarded raw;
// only the paging envelope (`page_info`, ids, list `total`/`has_more`) is read.

import { isConversationId } from './endpoints.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxConcurrent: 2,
  maxPages: 100,
  maxPageBytes: 20 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  pageTurns: 10,
  listPageSize: 100,
  listMaxItems: 500,
  listCooldownMs: 5_000,
  fullTreeCooldownMs: 5_000,
  backoffBaseMs: 1_500,
  backoffMaxMs: 60_000,
});

const DROP_HEADERS = /^(?:content-type|content-length|accept|openai-sentinel-.*|x-conduit-token)$/i;

class HistoryError extends Error {
  constructor(code, retryAfterMs = null) {
    super(code);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Map an HTTP status to a ConversationErrorCode. */
export function errorCodeForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 413) return 'too-large';
  if (status === 404 || status === 400 || status === 422) return 'invalid';
  return 'network';
}

/** Parse Retry-After (seconds or HTTP date) to milliseconds, or null. */
export function parseRetryAfter(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Copy official request headers for a GET of JSON. */
export function sanitizeHeaders(source) {
  const headers = new Headers();
  for (const [name, value] of new Headers(source)) {
    if (!DROP_HEADERS.test(name)) headers.set(name, value);
  }
  headers.set('accept', 'application/json');
  return headers;
}

/**
 * @param {object} options
 * @param {typeof fetch} options.fetch       native fetch (not the tee)
 * @param {string} options.origin            page origin
 * @param {(type: string, fields: object) => void} options.emit
 * @param {() => void} [options.onAuthFailure]
 * @param {() => number} [options.now]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(id: unknown) => void} [options.clearTimer]
 * @param {Partial<typeof DEFAULT_LIMITS>} [options.limits]
 */
export function createHistoryLoader(options) {
  const fetchImpl = options.fetch;
  const origin = options.origin;
  const emit = options.emit;
  const now = options.now || Date.now;
  const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer || ((id) => clearTimeout(/** @type {any} */ (id)));
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };

  let headers = null;
  const queue = [];                 // conversation ids waiting for a slot / headers
  const inFlight = new Map();       // id -> { again: boolean }
  const backoff = new Map();        // id -> { until, failures }
  const scheduled = new Map();      // id -> timer
  let listInFlight = null;
  let listAgain = false;
  let listBootstrapped = false;
  let listLastAt = -Infinity;
  let listQueued = false;
  let singularMissing = false;     // the full-tree endpoint answered 404/405 (paged only)
  const lastLoaded = new Map();     // id -> time of the last successful own load

  function setHeaders(source) {
    headers = sanitizeHeaders(source);
    drain();
    if (listQueued) loadList();
  }

  function hasHeaders() {
    return headers !== null;
  }

  /**
   * Load a conversation now (coalesced). `force` requests a fresh read even if
   * one is in flight (one follow-up pass after it finishes).
   */
  function load(conversationId, { force = false } = {}) {
    if (!isConversationId(conversationId)) return false;
    cancelScheduled(conversationId);
    const blocked = backoff.get(conversationId);
    if (blocked && blocked.until > now()) {
      emit('conversation-error', {
        conversationId,
        code: blocked.code,
        retryAfterSec: Math.ceil((blocked.until - now()) / 1000),
      });
      return false;
    }
    const running = inFlight.get(conversationId);
    if (running) {
      if (force) running.again = true;
      return true;
    }
    if (!queue.includes(conversationId)) queue.push(conversationId);
    drain();
    return true;
  }

  /** Load after `delayMs` unless the official app's own history fetch arrives first. */
  function schedule(conversationId, delayMs) {
    if (!isConversationId(conversationId) || scheduled.has(conversationId) || inFlight.has(conversationId)) return;
    scheduled.set(conversationId, setTimer(() => {
      scheduled.delete(conversationId);
      load(conversationId);
    }, delayMs));
  }

  /**
   * The official app fetched this history itself (already forwarded). Its
   * paged path view (`/conversations/<id>`) carries only `has_versions`, not
   * the sibling branches: with `wantsFullTree` the full tree is loaded once
   * more (coalesced, cooldown- and back-off-gated) unless that endpoint is
   * known to be unavailable. Returns true when a load was started.
   */
  function noteObserved(conversationId, { wantsFullTree = false } = {}) {
    cancelScheduled(conversationId);
    if (!wantsFullTree) {
      backoff.delete(conversationId);
      return false;
    }
    if (singularMissing || !isConversationId(conversationId)) return false;
    const blocked = backoff.get(conversationId);
    if (blocked && blocked.until > now()) return false;
    const last = lastLoaded.get(conversationId);
    if (last !== undefined && now() - last < limits.fullTreeCooldownMs) return false;
    return load(conversationId);
  }

  function cancelScheduled(conversationId) {
    const timer = scheduled.get(conversationId);
    if (timer !== undefined) {
      clearTimer(timer);
      scheduled.delete(conversationId);
    }
  }

  function drain() {
    if (!headers) return;
    while (queue.length && inFlight.size < limits.maxConcurrent) {
      const id = /** @type {string} */ (queue.shift());
      if (inFlight.has(id)) continue;
      const state = { again: false };
      inFlight.set(id, state);
      void run(id, state);
    }
  }

  async function run(conversationId, state) {
    try {
      const pages = await fetchConversation(conversationId);
      backoff.delete(conversationId);
      lastLoaded.set(conversationId, now());
      if (lastLoaded.size > 500) lastLoaded.delete(lastLoaded.keys().next().value);
      pages.forEach((body, index) => {
        emit('conversation', { conversationId, body, page: index + 1, pages: pages.length });
      });
    } catch (error) {
      const code = error instanceof HistoryError ? error.code : 'network';
      const failures = (backoff.get(conversationId)?.failures || 0) + 1;
      const retryMs = error instanceof HistoryError && error.retryAfterMs != null
        ? error.retryAfterMs
        : Math.min(limits.backoffBaseMs * 2 ** Math.min(failures - 1, 8), limits.backoffMaxMs);
      backoff.set(conversationId, { until: now() + retryMs, failures, code });
      if (code === 'auth') safeCall(options.onAuthFailure);
      emit('conversation-error', { conversationId, code, retryAfterSec: Math.ceil(retryMs / 1000) });
      state.again = false;
    } finally {
      inFlight.delete(conversationId);
      if (state.again) load(conversationId);
      drain();
    }
  }

  /** @returns {Promise<string[]>} raw page bodies, newest first */
  async function fetchConversation(conversationId) {
    const id = encodeURIComponent(conversationId);
    const full = await get(new URL(`/backend-api/conversation/${id}`, origin));
    if (full.ok) {
      const envelope = parseEnvelope(full.text, conversationId);
      if (!envelope.mapping) throw new HistoryError('invalid');
      return [full.text];
    }
    if (full.status !== 404 && full.status !== 405) throw failure(full);
    const pages = await fetchPaged(conversationId);
    singularMissing = true;
    return pages;
  }

  async function fetchPaged(conversationId) {
    const id = encodeURIComponent(conversationId);
    const pages = [];
    const cursors = new Set();
    let total = 0;
    let before = null;
    for (let index = 0; index < limits.maxPages; index += 1) {
      const build = (path) => {
        const url = new URL(path, origin);
        url.searchParams.set('include_has_versions', 'true');
        url.searchParams.set('num_turns', String(limits.pageTurns));
        if (before) url.searchParams.set('before', before);
        return url;
      };
      let result;
      if (before) {
        result = await get(build(`/backend-api/conversations/${id}/messages`));
        if (!result.ok && [400, 404, 405].includes(result.status)) {
          result = await get(build(`/backend-api/conversations/${id}`));
        }
      } else {
        result = await get(build(`/backend-api/conversations/${id}`));
      }
      if (!result.ok) throw failure(result);
      total += result.text.length;
      if (total > limits.maxTotalBytes) throw new HistoryError('too-large');
      if (pages.length && pages[pages.length - 1] === result.text) throw new HistoryError('invalid');
      const envelope = parseEnvelope(result.text, conversationId);
      pages.push(result.text);
      const info = envelope.pageInfo;
      if (!info || info.has_previous_page !== true) {
        if (!info && !envelope.mapping) throw new HistoryError('invalid');
        return pages;
      }
      const cursor = typeof info.start_cursor === 'string' ? info.start_cursor : '';
      if (!cursor || cursors.has(cursor)) throw new HistoryError('invalid');
      cursors.add(cursor);
      before = cursor;
    }
    throw new HistoryError('too-large');
  }

  /**
   * @returns {Promise<{ ok: boolean, status: number, text: string, retryAfterMs: number|null }>}
   */
  async function get(url) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimer(() => controller?.abort(), limits.requestTimeoutMs);
    try {
      const response = await fetchImpl(url.href, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: new Headers(headers || undefined),
        signal: controller?.signal,
      });
      const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'), now());
      if (!response.ok) {
        try { await response.body?.cancel?.(); } catch { /* ignore */ }
        return { ok: false, status: response.status, text: '', retryAfterMs };
      }
      const declared = Number(response.headers?.get?.('content-length') || 0);
      if (declared > limits.maxPageBytes) throw new HistoryError('too-large');
      const text = await response.text();
      if (text.length > limits.maxPageBytes) throw new HistoryError('too-large');
      return { ok: true, status: response.status, text, retryAfterMs };
    } catch (error) {
      if (error instanceof HistoryError) throw error;
      throw new HistoryError('network');
    } finally {
      clearTimer(timer);
    }
  }

  function failure(result) {
    return new HistoryError(errorCodeForStatus(result.status), result.retryAfterMs);
  }

  /**
   * Conversation list: first call walks up to `listMaxItems`, later calls
   * refresh the first page only. Coalesced and cooldown-gated.
   */
  function loadList({ force = false } = {}) {
    if (!headers) {
      listQueued = true;
      return false;
    }
    listQueued = false;
    if (listInFlight) {
      listAgain = listAgain || force;
      return true;
    }
    if (!force && listBootstrapped && now() - listLastAt < limits.listCooldownMs) return false;
    listLastAt = now();
    listInFlight = runList(!listBootstrapped).finally(() => {
      listInFlight = null;
      if (listAgain) {
        listAgain = false;
        loadList({ force: true });
      }
    });
    return true;
  }

  async function runList(full) {
    const maxItems = full ? limits.listMaxItems : limits.listPageSize;
    let offset = 0;
    const seen = new Set();
    while (offset < maxItems) {
      const url = new URL('/backend-api/conversations', origin);
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('limit', String(Math.min(limits.listPageSize, maxItems - offset)));
      url.searchParams.set('order', 'updated');
      let result;
      try {
        result = await get(url);
      } catch {
        return;
      }
      if (!result.ok) {
        if (errorCodeForStatus(result.status) === 'auth') safeCall(options.onAuthFailure);
        return;
      }
      const info = listEnvelope(result.text);
      if (!info) return;
      const signature = `${info.count}:${info.firstId}:${info.lastId}`;
      if (info.count && seen.has(signature)) return;
      seen.add(signature);
      const next = offset + info.count;
      const complete = info.count === 0 || info.hasMore === false || (info.total != null && next >= info.total);
      emit('conversation-list', { body: result.text, offset, complete });
      listBootstrapped = true;
      if (complete) return;
      offset = next;
    }
  }

  return { setHeaders, hasHeaders, load, schedule, noteObserved, loadList };
}

/**
 * Whether a raw `/backend-api/conversations` page at `offset` is the last one.
 * @param {string} body
 * @param {number} offset
 */
export function listPageComplete(body, offset) {
  const info = listEnvelope(body);
  if (!info) return false;
  return info.count === 0 || info.hasMore === false || (info.total != null && offset + info.count >= info.total);
}

/** Envelope of a canonical page; throws HistoryError('invalid') on mismatch. */
function parseEnvelope(text, conversationId) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HistoryError('invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HistoryError('invalid');
  for (const key of ['conversation_id', 'id']) {
    if (typeof value[key] === 'string' && isConversationId(value[key]) && value[key] !== conversationId) {
      throw new HistoryError('invalid');
    }
  }
  const mapping = value.mapping && typeof value.mapping === 'object' && !Array.isArray(value.mapping);
  const pageInfo = value.page_info && typeof value.page_info === 'object' ? value.page_info : null;
  if (!mapping && !Array.isArray(value.messages)) throw new HistoryError('invalid');
  return { mapping, pageInfo };
}

function listEnvelope(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const root = value && typeof value === 'object' && !Array.isArray(value.items) && value.data ? value.data : value;
  if (!root || !Array.isArray(root.items)) return null;
  const items = root.items;
  const total = Number.isFinite(Number(root.total)) && root.total !== null ? Number(root.total) : null;
  const hasMore = typeof root.has_more === 'boolean' ? root.has_more : null;
  return {
    count: items.length,
    firstId: String(items[0]?.id ?? ''),
    lastId: String(items[items.length - 1]?.id ?? ''),
    total,
    hasMore,
  };
}

function safeCall(fn) {
  if (typeof fn !== 'function') return;
  try { fn(); } catch { /* ignore */ }
}
