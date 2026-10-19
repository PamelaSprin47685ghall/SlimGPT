// Wire protocol between the page world (chatgpt.com, workstream C) and the
// extension UI frame (workstream B). Owned by workstream C; changes need B's
// agreement. Every message is `{ channel, v: 2, type, ...fields }` and is
// posted with an exact target origin. Bodies are forwarded RAW (strings);
// all parsing happens in the UI through src/protocol.
//
// Hops (both checked exactly):
//   page hook (MAIN world)  --postMessage(frameOrigin)-->   UI frame
//   UI frame                --postMessage(PAGE_ORIGIN)-->   page hook (commands)
//   UI frame                --postMessage(PAGE_ORIGIN)-->   isolated bridge (storage-* only)
//   isolated bridge         --postMessage(frameOrigin)-->   UI frame (storage-result)
// The UI must accept only `event.source === window.parent &&
// event.origin === PAGE_ORIGIN`; the page accepts only
// `event.source === frame.contentWindow && event.origin === <extension origin>`.
//
// Page → UI
//   hello            { ready: boolean, loggedIn: boolean|null, auth: AuthMode, url: string, efforts: EffortValue[] }   (efforts additive, C: [] = selector hidden)
//                    auth 'user' = signed in (server history); 'anon' = logged-out free mode
//                    (no server history: the UI keeps conversations on this device);
//                    'unknown' = not determined yet. ready: user → official headers seen;
//                    anon → free-mode page detected.
//   location         { url: string, conversationId: string|null }
//   conversation-list{ body: string, offset: number, complete: boolean }
//   conversation     { conversationId: string, body: string, page: number, pages: number }
//   conversation-error { conversationId: string, code: ConversationErrorCode, retryAfterSec: number|null }
//   stream-start     { streamId: string, conversationId: string|null, userMessageId: string|null, parentMessageId: string|null, resume: boolean,
//                      format: 'sse'|'conversation-source', userText?: string }
//                    format 'conversation-source' = free-mode NDJSON (decode with
//                    createConversationSourceDecoder); userText = the submitted prompt
//                    (free mode only, the one request field forwarded besides ids).
//   stream-chunk     { streamId: string, chunk: string }
//   stream-end       { streamId: string, ok: boolean }
//   send-result      { commandId: string, ok: boolean, error: SendErrorCode|null }
//   command-result   { commandId: string|null, command: 'stop'|'continue'|'switch-branch'|'set-effort', ok: boolean, error: CommandErrorCode|null }   (additive, C)
//   effort           { available: boolean, effort: EffortValue|null }                                       (additive, C)
//   takeover         { visible: boolean, reason: 'ready'|'user'|'blocking-official-ui'|'composer-unavailable' }
//   storage-result   { requestId: string, ok: boolean, values: object, error: string|null }   (sent by the isolated bridge)
//
// UI → Page
//   ui-ready         {}                                     (additive, C) frame mounted; page answers hello/location/takeover/effort
//   open             { conversationId: string|null }       null = new chat
//   send             { commandId: string, text: string }
//   stop             { commandId?: string }
//   continue         { conversationId: string|null, messageId: string|null, commandId?: string }   (additive, C) click the official "Continue generating"
//   switch-branch    { commandId: string, messageId: string, direction: -1|1 }   (additive, C) one step on the official branch arrows
//   refresh          { conversationId: string }
//   refresh-list     {}                                     (additive, C)
//   show-official    {}
//   set-effort       { commandId?: string, effort: EffortValue }
//   storage-get      { requestId: string, keys: string[] }  (answered by bridge with storage-result)
//   storage-set      { requestId: string, values: object }
//
// Streams: chunks of one streamId arrive in order between stream-start and
// stream-end. `stream-end.ok === false` means the transport failed or was
// aborted; the UI should then request `refresh`. The page never re-writes the
// official response; it observes a tee (Response.clone()).

export const PAGE_CHANNEL = 'slimgpt-page-v2';
export const UI_CHANNEL = 'slimgpt-ui-v2';
export const BRIDGE_VERSION = 2;

/** The only page origin SlimGPT runs on (matches host_permissions). */
export const PAGE_ORIGIN = 'https://chatgpt.com';

export const PAGE_TO_UI = Object.freeze([
  'hello', 'location', 'conversation-list', 'conversation', 'conversation-error',
  'stream-start', 'stream-chunk', 'stream-end', 'send-result', 'command-result', 'effort',
  'takeover', 'storage-result',
]);

export const UI_TO_PAGE = Object.freeze([
  'ui-ready', 'open', 'send', 'stop', 'continue', 'switch-branch', 'refresh', 'refresh-list',
  'show-official', 'set-effort', 'storage-get', 'storage-set',
]);

/** UI→page types handled by the isolated bridge instead of the page hook. */
export const BRIDGE_COMMANDS = Object.freeze(['storage-get', 'storage-set']);

/** @typedef {'composer-not-found'|'send-not-confirmed'|'busy'|'blocked-by-official-ui'|'not-logged-in'|'empty-text'|'send-control-not-ready'|'request-rejected'} SendErrorCode */
export const SEND_ERROR_CODES = Object.freeze([
  'composer-not-found', 'send-not-confirmed', 'busy', 'blocked-by-official-ui', 'not-logged-in',
  'empty-text', 'send-control-not-ready', 'request-rejected',
]);

/** @typedef {'control-not-found'|'not-confirmed'|'busy'|'blocked-by-official-ui'|'invalid-argument'} CommandErrorCode */
export const COMMAND_ERROR_CODES = Object.freeze([
  'control-not-found', 'not-confirmed', 'busy', 'blocked-by-official-ui', 'invalid-argument',
]);

/** @typedef {'auth'|'rate-limit'|'network'|'too-large'|'invalid'} ConversationErrorCode */
export const CONVERSATION_ERROR_CODES = Object.freeze(['auth', 'rate-limit', 'network', 'too-large', 'invalid']);

/**
 * Reasoning effort, lowest → highest, mapped linearly onto the official
 * slider's range. @typedef {'lowest'|'low'|'medium'|'high'|'highest'} EffortValue
 */
export const EFFORT_VALUES = Object.freeze(['lowest', 'low', 'medium', 'high', 'highest']);

/** @typedef {'user'|'anon'|'unknown'} AuthMode */
export const AUTH_MODES = Object.freeze(['user', 'anon', 'unknown']);

/** @typedef {'sse'|'conversation-source'} StreamFormat */
export const STREAM_FORMATS = Object.freeze(['sse', 'conversation-source']);

// localConversations: device-only records of logged-out conversations (capped, see src/protocol/local.js).
export const STORAGE_KEYS = Object.freeze(['settings', 'drafts', 'conversationIndex', 'conversationCache', 'localConversations']);

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
