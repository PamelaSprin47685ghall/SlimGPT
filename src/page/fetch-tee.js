// Observe-only fetch tee. The official app always receives the very same
// Response object it would have received without SlimGPT; we read a
// `response.clone()` of allowlisted endpoints and forward raw text.
//
// Nothing here rewrites requests or responses, patches Response.prototype,
// or touches XHR/WebSocket.

import {
  classifyEndpoint, isBackendRequest, isFreeModeUrl, readFreeModeRequest, readStreamRequestIds, readSubmitChoice, MAX_REQUEST_BODY_CHARS,
} from './endpoints.js';

export const MAX_JSON_BODY_BYTES = 20 * 1024 * 1024;

/**
 * @typedef {object} TeeHandlers
 * @property {(headers: Headers) => void} [onBackendHeaders]   same-origin /backend-api/ request headers (with authorization)
 * @property {() => void} [onFreeModeRequest]   a same-origin logged-out app request was seen (URL only)
 * @property {(result: { ok: boolean, status: number }) => void} [onSubmission]   official submit request settled
 * @property {(start: { streamId: string, conversationId: string|null, userMessageId: string|null, parentMessageId: string|null, resume: boolean, format: 'sse'|'conversation-source', userText?: string|null }) => void} [onStreamStart]
 * @property {(streamId: string, chunk: string) => void} [onStreamChunk]
 * @property {(streamId: string, ok: boolean) => void} [onStreamEnd]
 * @property {(conversationId: string, body: string) => void} [onHistory]
 * @property {(conversationId: string) => void} [onHistoryRequest]   an official history fetch just started (URL only)
 * @property {(offset: number, body: string) => void} [onList]
 * @property {(body: string) => void} [onModels]   GET /backend-api/models body
 * @property {(body: string) => void} [onUserSettings]   GET /backend-api/settings/user body
 * @property {(choice: { model: string|null, effort: string|null }) => void} [onSubmitChoice]   model/effort of an official submit
 */

/**
 * @param {{ pageOrigin: string, handlers: TeeHandlers, maxJsonBytes?: number }} options
 */
export function createFetchTee({ pageOrigin, handlers, maxJsonBytes = MAX_JSON_BODY_BYTES }) {
  let streamCounter = 0;
  const wrapped = new WeakSet();

  /** @param {typeof fetch} upstream */
  function wrap(upstream) {
    if (typeof upstream !== 'function' || wrapped.has(upstream)) return upstream;
    const observed = async function slimgptObservedFetch(input, init) {
      let endpoint = null;
      let bodyText = null;
      try {
        const url = requestUrl(input);
        const method = requestMethod(input, init);
        if (url && isBackendRequest(url, pageOrigin)) {
          const headers = requestHeaders(input, init);
          if (headers?.has('authorization')) safeCall(handlers.onBackendHeaders, headers);
        }
        if (url && isFreeModeUrl(url, pageOrigin)) safeCall(handlers.onFreeModeRequest);
        endpoint = url ? classifyEndpoint(method, url, pageOrigin) : null;
        if (endpoint?.kind === 'history') safeCall(handlers.onHistoryRequest, endpoint.conversationId);
        if (endpoint && (endpoint.kind === 'submit' || endpoint.kind === 'resume')) {
          // Must be taken before upstream consumes a Request body.
          bodyText = readRequestBody(input, init);
        } else if (endpoint?.kind === 'free-submit') {
          bodyText = readFreeModeBody(input, init);
        }
      } catch {
        endpoint = null;
      }

      let response;
      try {
        response = await Reflect.apply(upstream, this, arguments);
      } catch (error) {
        if (endpoint?.kind === 'submit' || endpoint?.kind === 'free-submit') safeCall(handlers.onSubmission, { ok: false, status: 0 });
        throw error;
      }
      if (endpoint) {
        try {
          observe(endpoint, response, bodyText);
        } catch {
          // Observation must never affect the official app.
        }
      }
      return response;
    };
    wrapped.add(observed);
    return observed;
  }

  function observe(endpoint, response, bodyText) {
    if (endpoint.kind === 'submit' || endpoint.kind === 'free-submit') safeCall(handlers.onSubmission, { ok: response.ok, status: response.status });
    if (endpoint.kind === 'submit' && handlers.onSubmitChoice) {
      void Promise.resolve(bodyText).catch(() => null).then((text) => safeCall(handlers.onSubmitChoice, readSubmitChoice(text)));
    }
    if (!response.ok || !response.body) return;
    const mime = String(response.headers.get('content-type') || '').toLowerCase();
    if (endpoint.kind === 'submit' || endpoint.kind === 'resume') {
      if (!mime.includes('text/event-stream')) return;
      const copy = response.clone();
      const streamId = `s${Date.now().toString(36)}-${(++streamCounter).toString(36)}`;
      const ids = Promise.resolve(bodyText).catch(() => null).then(readStreamRequestIds);
      void pumpStream(copy, streamId, ids, { resume: endpoint.kind === 'resume', format: 'sse' });
      return;
    }
    if (endpoint.kind === 'free-submit') {
      if (!mime.includes('conversation-source') && !mime.includes('ndjson')) return;
      const copy = response.clone();
      const streamId = `s${Date.now().toString(36)}-${(++streamCounter).toString(36)}`;
      const fields = Promise.resolve(bodyText).catch(() => null).then(readFreeModeRequest);
      void pumpStream(copy, streamId, fields, { resume: false, format: 'conversation-source' });
      return;
    }
    if (!mime.includes('json')) return;
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxJsonBytes) return;
    const copy = response.clone();
    void readBounded(copy, maxJsonBytes).then((text) => {
      if (text == null) return;
      if (endpoint.kind === 'history') safeCall(handlers.onHistory, endpoint.conversationId, text);
      else if (endpoint.kind === 'list') safeCall(handlers.onList, endpoint.offset, text);
      else if (endpoint.kind === 'models') safeCall(handlers.onModels, text);
      else if (endpoint.kind === 'user-settings') safeCall(handlers.onUserSettings, text);
    });
  }

  async function pumpStream(copy, streamId, idsPromise, { resume, format }) {
    const ids = await idsPromise.catch(() => ({ conversationId: null, userMessageId: null, parentMessageId: null }));
    safeCall(handlers.onStreamStart, { streamId, ...ids, resume, format });
    let ok = false;
    let reader;
    try {
      reader = copy.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (chunk) safeCall(handlers.onStreamChunk, streamId, chunk);
      }
      const tail = decoder.decode();
      if (tail) safeCall(handlers.onStreamChunk, streamId, tail);
      ok = true;
    } catch {
      ok = false;
      try { await reader?.cancel(); } catch { /* already closed */ }
    }
    safeCall(handlers.onStreamEnd, streamId, ok);
  }

  return { wrap };
}

/**
 * Install the tee on `win.fetch`, re-wrapping if the page assigns a new fetch.
 * @param {Window & typeof globalThis} win
 * @param {{ wrap: (f: typeof fetch) => typeof fetch }} tee
 */
export function installFetchTee(win, tee) {
  let current = tee.wrap(win.fetch);
  try {
    Object.defineProperty(win, 'fetch', {
      configurable: true,
      enumerable: true,
      get() { return current; },
      set(next) {
        if (typeof next === 'function') current = tee.wrap(next);
      },
    });
  } catch {
    win.fetch = current;
  }
}

/** Read a cloned body as text, giving up (null) above `maxBytes`. */
export async function readBounded(response, maxBytes) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return null;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch {
    try { await reader.cancel(); } catch { /* ignore */ }
    return null;
  }
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return null;
}

function requestMethod(input, init) {
  return String(init?.method || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
}

function requestHeaders(input, init) {
  try {
    if (init && init.headers !== undefined) return new Headers(init.headers);
    if (typeof Request !== 'undefined' && input instanceof Request) return new Headers(input.headers);
    return null;
  } catch {
    return null;
  }
}

/**
 * Body text of the official request, without disturbing it: a string
 * `init.body` is used as is; a Request input is cloned. Streams, blobs and
 * form data are not read (the official app sends a JSON string).
 * @returns {string|Promise<string|null>|null}
 */
function readRequestBody(input, init) {
  if (init && init.body !== undefined && init.body !== null) {
    return typeof init.body === 'string' && init.body.length <= MAX_REQUEST_BODY_CHARS ? init.body : null;
  }
  if (typeof Request !== 'undefined' && input instanceof Request && input.body) {
    try {
      return input.clone().text().then((text) => (text.length <= MAX_REQUEST_BODY_CHARS ? text : null), () => null);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Form fields of a free-mode submit, without disturbing the request:
 * URLSearchParams/FormData are read in place (`get` does not consume them),
 * an urlencoded string is parsed, a Request input is cloned. Only the fields
 * named in FREE_MODE_FIELDS are ever read (see readFreeModeRequest).
 * @returns {{ get(name: string): unknown }|string|Promise<{ get(name: string): unknown }|string|null>|null}
 */
function readFreeModeBody(input, init) {
  const body = init && init.body !== undefined && init.body !== null ? init.body : null;
  if (body !== null) {
    if (typeof body === 'string') return body.length <= MAX_REQUEST_BODY_CHARS ? body : null;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body;
    if (typeof FormData !== 'undefined' && body instanceof FormData) return body;
    return null;
  }
  if (typeof Request !== 'undefined' && input instanceof Request && input.body) {
    try {
      const type = String(input.headers.get('content-type') || '').toLowerCase();
      const copy = input.clone();
      if (type.includes('multipart/form-data')) return copy.formData().catch(() => null);
      return copy.text().then((text) => (text.length <= MAX_REQUEST_BODY_CHARS ? text : null), () => null);
    } catch {
      return null;
    }
  }
  return null;
}

function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch { /* handler bugs never reach the official app */ }
}
