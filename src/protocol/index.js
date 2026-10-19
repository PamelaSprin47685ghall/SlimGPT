// Public API of the protocol core (workstream A owns src/protocol/**).
//
// Contract rules (see docs/clean-break/PLAN.md §3):
//  * Pure functions. No DOM, no timers, no globals, no Svelte, no storage.
//  * Total: never throw on unexpected input. Unknown content becomes an
//    UnknownBlock; a broken stream becomes a StreamEvent { type: 'error' }.
//  * Immutable: every update returns a new Conversation; inputs are untouched.
//  * Snapshot-only: text is replaced, never heuristically merged/appended.
//  * Precedence: a canonical message with status 'done' is final; live
//    snapshots for that id are ignored. Live snapshots may update canonical
//    nodes that are 'streaming' or 'interrupted' (e.g. Continue generating).
//    A later canonical ingest always replaces live data for the same id.
//
// The page hook (workstream C) does NOT parse protocol bodies: it forwards raw
// response text over the bridge (src/shared/bridge-protocol.js). The UI
// (workstream B) imports protocol code only from this file.

/** @typedef {import('./types.js').Message} Message */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./types.js').Turn} Turn */
/** @typedef {import('./types.js').StreamEvent} StreamEvent */

export * from './types.js';

const notImplemented = (name) => {
  throw new Error(`protocol.${name} is not implemented yet (workstream A)`);
};

/**
 * Normalize one raw ChatGPT message object (as found in `mapping[id].message`,
 * an SSE `{message}` envelope, or `messages[]` of the optimized format).
 * @param {object} raw
 * @param {{ parentId?: string|null, source?: 'canonical'|'live' }} [context]
 * @returns {Message|null} null only when `raw` has no string id.
 */
export function normalizeMessage(raw, context = {}) {
  return notImplemented('normalizeMessage');
}

/**
 * Parse a complete canonical conversation response body (JSON text or object).
 * Accepts `{ mapping, current_node }` and the paged `{ messages, current_node, page_info }`
 * format. Returns null when the body is not a conversation.
 * @param {string|object} body
 * @returns {Conversation|null}
 */
export function parseConversation(body) {
  return notImplemented('parseConversation');
}

/**
 * Merge additional canonical pages / a refreshed canonical history into an
 * existing conversation. Canonical nodes replace same-id nodes (including live
 * ones). Known parents are never rewritten by a page that lacks them.
 * @param {Conversation|null} previous
 * @param {Conversation} incoming
 * @returns {Conversation}
 */
export function mergeConversation(previous, incoming) {
  return notImplemented('mergeConversation');
}

/**
 * Apply one live raw message snapshot. Parent resolution order:
 * raw.metadata.parent_id → raw.parent_id → fallbackParentId (the submitted
 * user message id known from the request) → existing node's parent.
 * Ignored for ids whose canonical message is 'done' (see precedence rule).
 * @param {Conversation} conversation
 * @param {object} raw
 * @param {{ fallbackParentId?: string|null }} [context]
 * @returns {Conversation}
 */
export function applyLiveMessage(conversation, raw, context = {}) {
  return notImplemented('applyLiveMessage');
}

/**
 * Create an empty conversation (new chat / not yet synced).
 * @param {string} id
 * @returns {Conversation}
 */
export function createConversation(id) {
  return notImplemented('createConversation');
}

/**
 * Turns along the path ending at `leafId` (default: currentNodeId).
 * Hidden messages are excluded. Reasoning/tool messages stay in their
 * protocol order inside the turn (no re-sorting).
 * @param {Conversation} conversation
 * @param {string|null} [leafId]
 * @returns {Turn[]}
 */
export function selectTurns(conversation, leafId = null) {
  return notImplemented('selectTurns');
}

/**
 * Leaf reached by switching the branch at `nodeId` by `delta` (−1/+1) and
 * then following the newest child down.
 * @param {Conversation} conversation
 * @param {string} nodeId
 * @param {number} delta
 * @returns {string|null}
 */
export function switchBranch(conversation, nodeId, delta) {
  return notImplemented('switchBranch');
}

/**
 * Incremental decoder for one `text/event-stream` response body.
 * Handles arbitrary chunk splits (incl. split CRLF / UTF-16 surrogates are the
 * caller's TextDecoder concern), legacy JSON events and the `delta_encoding: v1`
 * dialect. After an error it emits nothing further.
 * @param {{ maxBufferedChars?: number }} [options]
 * @returns {{ push(chunk: string): StreamEvent[], end(): StreamEvent[] }}
 */
export function createStreamDecoder(options = {}) {
  return notImplemented('createStreamDecoder');
}

/**
 * Extract the conversation list from a `/backend-api/conversations` body.
 * @param {string|object} body
 * @returns {{ id: string, title: string, updatedAt: number|null }[] | null}
 */
export function parseConversationList(body) {
  return notImplemented('parseConversationList');
}

/**
 * Plain-text projection used for previews, search and copy.
 * @param {Message} message
 * @returns {string}
 */
export function messageToPlainText(message) {
  return notImplemented('messageToPlainText');
}

/**
 * Markdown export of the selected path.
 * @param {Conversation} conversation
 * @param {{ leafId?: string|null, includeReasoning?: boolean, includeTools?: boolean }} [options]
 * @returns {string}
 */
export function conversationToMarkdown(conversation, options = {}) {
  return notImplemented('conversationToMarkdown');
}
