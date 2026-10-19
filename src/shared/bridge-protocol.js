// Wire protocol between the page world (chatgpt.com, workstream C) and the
// extension UI frame (workstream B). Owned by workstream C; changes need B's
// agreement. Every message is `{ channel, v: 2, type, ...fields }` and is
// posted with an exact target origin. Bodies are forwarded RAW (strings);
// all parsing happens in the UI through src/protocol.
//
// Page → UI
//   hello            { ready: boolean, loggedIn: boolean|null, url: string }
//   location         { url: string, conversationId: string|null }
//   conversation-list{ body: string, offset: number, complete: boolean }
//   conversation     { conversationId: string, body: string, page: number, pages: number }
//   conversation-error { conversationId: string, code: 'auth'|'rate-limit'|'network'|'too-large'|'invalid', retryAfterSec: number|null }
//   stream-start     { streamId: string, conversationId: string|null, userMessageId: string|null, parentMessageId: string|null, resume: boolean }
//   stream-chunk     { streamId: string, chunk: string }
//   stream-end       { streamId: string, ok: boolean }
//   send-result      { commandId: string, ok: boolean, error: SendErrorCode|null }
//   takeover         { visible: boolean }
//
// UI → Page
//   open             { conversationId: string|null }       null = new chat
//   send             { commandId: string, text: string }
//   stop             {}
//   refresh          { conversationId: string }
//   show-official    {}
//   set-effort       { effort: string }
//   storage-get      { requestId: string, keys: string[] }  (answered by bridge with storage-result)
//   storage-set      { requestId: string, values: object }

export const PAGE_CHANNEL = 'slimgpt-page-v2';
export const UI_CHANNEL = 'slimgpt-ui-v2';
export const BRIDGE_VERSION = 2;

export const PAGE_TO_UI = Object.freeze([
  'hello', 'location', 'conversation-list', 'conversation', 'conversation-error',
  'stream-start', 'stream-chunk', 'stream-end', 'send-result', 'takeover', 'storage-result',
]);

export const UI_TO_PAGE = Object.freeze([
  'open', 'send', 'stop', 'refresh', 'show-official', 'set-effort', 'storage-get', 'storage-set',
]);

/** @typedef {'composer-not-found'|'send-not-confirmed'|'busy'|'blocked-by-official-ui'|'not-logged-in'} SendErrorCode */
export const SEND_ERROR_CODES = Object.freeze([
  'composer-not-found', 'send-not-confirmed', 'busy', 'blocked-by-official-ui', 'not-logged-in',
]);

export const STORAGE_KEYS = Object.freeze(['settings', 'drafts', 'conversationIndex', 'conversationCache']);

/**
 * Shape check for an incoming bridge message. Returns the message when it is
 * a well-formed v2 message of an allowed type for `direction`, else null.
 * @param {unknown} data
 * @param {'page-to-ui'|'ui-to-page'} direction
 */
export function acceptBridgeMessage(data, direction) {
  if (!data || typeof data !== 'object') return null;
  const message = /** @type {Record<string, unknown>} */ (data);
  const channel = direction === 'page-to-ui' ? PAGE_CHANNEL : UI_CHANNEL;
  const allowed = direction === 'page-to-ui' ? PAGE_TO_UI : UI_TO_PAGE;
  if (message.channel !== channel || message.v !== BRIDGE_VERSION) return null;
  if (typeof message.type !== 'string' || !allowed.includes(message.type)) return null;
  return message;
}

/**
 * @param {'page-to-ui'|'ui-to-page'} direction
 * @param {string} type
 * @param {object} [fields]
 */
export function bridgeMessage(direction, type, fields = {}) {
  const channel = direction === 'page-to-ui' ? PAGE_CHANNEL : UI_CHANNEL;
  return { ...fields, channel, v: BRIDGE_VERSION, type };
}
