// Strict allowlist of the official endpoints SlimGPT observes, plus small
// request-side helpers. Pure: no DOM, no globals.
//
// Observed (and nothing else):
//   POST /backend-api/conversation             official SSE stream (new turn)
//   POST /backend-api/f/conversation           official SSE stream (new turn)
//   POST /backend-api/(f/)conversation/resume  official SSE stream (resume)
//   GET  /backend-api/conversation/<uuid>      official full history
//   GET  /backend-api/conversations            conversation list
//   POST /unauth-mweb/conversation/updates     logged-out (free mode) NDJSON stream
// Matching is on the exact pathname of a same-origin URL; query strings are
// ignored, everything else (memories, prepare, init, textdocs, …) is rejected.

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUBMIT_PATH = /^\/backend-api\/(?:f\/)?conversation$/;
const RESUME_PATH = /^\/backend-api\/(?:f\/)?conversation\/resume$/;
const HISTORY_PATH = /^\/backend-api\/conversation\/([^/]+)$/;
const LIST_PATH = /^\/backend-api\/conversations$/;
const FREE_UPDATES_PATH = /^\/unauth-mweb\/conversation\/updates$/;
// Same-origin path prefixes only the logged-out app uses (evidence of free mode).
const FREE_MODE_PREFIXES = ['/unauth-mweb/', '/backend-anon/'];
const FREE_ROUTE_PATH = /^\/uc\/[^/]+\/?$/;
/** The only form fields read from a free-mode request (tokens are never touched). */
export const FREE_MODE_FIELDS = Object.freeze(['prompt', 'userMessageId', 'conversationState']);
export const MAX_PROMPT_CHARS = 200_000;
const ROUTE_PATH = /^\/(?:g\/[^/]+\/)?(?:c|uc)\/([^/]+)\/?$/;

/** Maximum request body we read to learn ids (the official body is small). */
export const MAX_REQUEST_BODY_CHARS = 1024 * 1024;

/** @param {unknown} value */
export function isConversationId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * @typedef {{ kind: 'submit'|'resume'|'free-submit' } | { kind: 'history', conversationId: string } | { kind: 'list', offset: number }} Endpoint
 */

/**
 * Classify one request. Returns null for anything not on the allowlist.
 * @param {string} method
 * @param {string|URL} rawUrl
 * @param {string} pageOrigin exact page origin, e.g. https://chatgpt.com
 * @returns {Endpoint|null}
 */
export function classifyEndpoint(method, rawUrl, pageOrigin) {
  let url;
  try {
    url = new URL(String(rawUrl), pageOrigin);
  } catch {
    return null;
  }
  if (!pageOrigin || url.origin !== pageOrigin) return null;
  const verb = String(method || 'GET').toUpperCase();
  const path = url.pathname;
  if (verb === 'POST') {
    if (SUBMIT_PATH.test(path)) return { kind: 'submit' };
    if (RESUME_PATH.test(path)) return { kind: 'resume' };
    if (FREE_UPDATES_PATH.test(path)) return { kind: 'free-submit' };
    return null;
  }
  if (verb !== 'GET') return null;
  const history = HISTORY_PATH.exec(path);
  if (history) {
    const id = safeDecode(history[1]);
    return isConversationId(id) ? { kind: 'history', conversationId: id } : null;
  }
  if (LIST_PATH.test(path)) {
    const offset = Number(url.searchParams.get('offset') || 0);
    return { kind: 'list', offset: Number.isInteger(offset) && offset >= 0 ? offset : 0 };
  }
  return null;
}

/**
 * True for any same-origin `/backend-api/` request (used only to learn the
 * official request headers; bodies of these requests are never read).
 * @param {string|URL} rawUrl
 * @param {string} pageOrigin
 */
export function isBackendRequest(rawUrl, pageOrigin) {
  try {
    const url = new URL(String(rawUrl), pageOrigin);
    return url.origin === pageOrigin && url.pathname.startsWith('/backend-api/');
  } catch {
    return false;
  }
}

/**
 * True for same-origin requests/resources of the logged-out app
 * (`/unauth-mweb/…`, `/backend-anon/…`). URL only; nothing is read.
 * @param {string|URL} rawUrl
 * @param {string} pageOrigin
 */
export function isFreeModeUrl(rawUrl, pageOrigin) {
  try {
    const url = new URL(String(rawUrl), pageOrigin);
    return url.origin === pageOrigin && FREE_MODE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

/** True for a logged-out conversation route (`/uc/<id>`). */
export function isFreeModeRoute(rawUrl, pageOrigin) {
  try {
    const url = new URL(String(rawUrl), pageOrigin);
    return url.origin === pageOrigin && FREE_ROUTE_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Conversation id of a chatgpt.com route (`/c/<id>`, `/g/<gizmo>/c/<id>`).
 * Provisional ids (`WEB:…`) and non-UUIDs return null.
 * @param {string|URL} rawUrl
 * @param {string} pageOrigin
 */
export function conversationIdFromRoute(rawUrl, pageOrigin) {
  try {
    const url = new URL(String(rawUrl), pageOrigin);
    if (url.origin !== pageOrigin) return null;
    const match = ROUTE_PATH.exec(url.pathname);
    const id = match ? safeDecode(match[1]) : null;
    return isConversationId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Ids carried by the official submit/resume request body. Reads only the
 * top-level envelope and the last user message id; never message content.
 * @param {unknown} bodyText
 * @returns {{ conversationId: string|null, userMessageId: string|null, parentMessageId: string|null }}
 */
export function readStreamRequestIds(bodyText) {
  const empty = { conversationId: null, userMessageId: null, parentMessageId: null };
  if (typeof bodyText !== 'string' || !bodyText || bodyText.length > MAX_REQUEST_BODY_CHARS) return empty;
  let value;
  try {
    value = JSON.parse(bodyText);
  } catch {
    return empty;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const conversationId = isConversationId(value.conversation_id) ? value.conversation_id : null;
  const parentMessageId = idString(value.parent_message_id);
  let userMessageId = null;
  if (Array.isArray(value.messages)) {
    for (let index = value.messages.length - 1; index >= 0; index -= 1) {
      const message = value.messages[index];
      if (message && typeof message === 'object' && message.author?.role === 'user') {
        userMessageId = idString(message.id);
        break;
      }
    }
  }
  return { conversationId, userMessageId, parentMessageId };
}

/**
 * Fields of a free-mode submit (form-urlencoded / FormData). Reads ONLY the
 * prompt, the user message id and the public conversation state; every token
 * field (chat requirements, proof, turnstile, session ids…) is ignored.
 * @param {{ get(name: string): unknown }|string|null} form  URLSearchParams/FormData, or urlencoded text
 * @returns {{ conversationId: string|null, userMessageId: string|null, parentMessageId: string|null, userText: string|null }}
 */
export function readFreeModeRequest(form) {
  const empty = { conversationId: null, userMessageId: null, parentMessageId: null, userText: null };
  let source = form;
  try {
    if (typeof form === 'string') {
      if (!form || form.length > MAX_REQUEST_BODY_CHARS) return empty;
      source = new URLSearchParams(form);
    }
    if (!source || typeof source.get !== 'function') return empty;
    const field = (name) => {
      const value = source.get(name);
      return typeof value === 'string' ? value : null;
    };
    const prompt = field('prompt');
    const userText = prompt !== null && prompt.length <= MAX_PROMPT_CHARS ? prompt : null;
    const userMessageId = isConversationId(field('userMessageId')) ? field('userMessageId') : null;
    let conversationId = null;
    let parentMessageId = null;
    const stateText = field('conversationState');
    if (stateText && stateText.length <= MAX_REQUEST_BODY_CHARS) {
      const state = JSON.parse(stateText);
      if (state && typeof state === 'object') {
        conversationId = isConversationId(state.backendConversationId) ? state.backendConversationId : null;
        parentMessageId = isConversationId(state.parentMessageId) ? state.parentMessageId : null;
      }
    }
    return { conversationId, userMessageId, parentMessageId, userText };
  } catch {
    return empty;
  }
}

function idString(value) {
  return typeof value === 'string' && value && value.length <= 200 && !/\s/.test(value) ? value : null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
