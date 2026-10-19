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
//    nodes that are 'streaming' or 'interrupted' (e.g. a reply cut off by Stop).
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

import { normalizeMessage as normalizeMessageImpl } from './message.js';
import {
  applyLiveMessage as applyLiveMessageImpl,
  createConversation as createConversationImpl,
  interruptLiveMessages as interruptLiveMessagesImpl,
  mergeConversation as mergeConversationImpl,
  parseConversation as parseConversationImpl,
} from './conversation.js';
import { selectTurns as selectTurnsImpl, switchBranch as switchBranchImpl } from './turns.js';
import { createStreamDecoder as createStreamDecoderImpl } from './stream.js';
import { createConversationSourceDecoder as createConversationSourceDecoderImpl, sourceRawMessage } from './conversation-source.js';
import {
  capLocalRecords as capLocalRecordsImpl,
  conversationFromLocalRecord as conversationFromLocalRecordImpl,
  localRecordFromConversation as localRecordFromConversationImpl,
} from './local.js';

export { LOCAL_LIMITS } from './local.js';
import { parseConversationList as parseConversationListImpl } from './conversation-list.js';
import {
  conversationToMarkdown as conversationToMarkdownImpl,
  messageToPlainText as messageToPlainTextImpl,
} from './text.js';

/**
 * Normalize one raw ChatGPT message object (as found in `mapping[id].message`,
 * an SSE `{message}` envelope, or `messages[]` of the optimized format).
 * @param {object} raw
 * @param {{ parentId?: string|null, source?: 'canonical'|'live' }} [context]
 * @returns {Message|null} null only when `raw` has no string id.
 */
export function normalizeMessage(raw, context = {}) {
  return normalizeMessageImpl(raw, context);
}

/**
 * Parse a complete canonical conversation response body (JSON text or object).
 * Accepts `{ mapping, current_node }` and the paged `{ messages, current_node, page_info }`
 * format. Returns null when the body is not a conversation. A page's
 * `currentNodeId` keeps the server-declared id even when that node lives on
 * another page (selectTurns then falls back to the newest root path).
 * Parents are derived from `metadata.parent_id`/`parent_id`; a page that
 * states no parents at all is treated as an ordered path (inferred parents
 * that later server-stated parents may correct).
 * @param {string|object} body
 * @returns {Conversation|null}
 */
export function parseConversation(body) {
  return parseConversationImpl(body);
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
  return mergeConversationImpl(previous, incoming);
}

/**
 * Apply one live raw message snapshot. Parent resolution order:
 * raw.metadata.parent_id → raw.parent_id → fallbackParentId (the submitted
 * user message id known from the request) → existing node's parent.
 * Ignored for ids whose canonical message is 'done'/'error' (see precedence rule);
 * a canonical node's known parent is never rewritten by a live snapshot.
 * The new/updated message becomes `currentNodeId` when it is a leaf.
 * @param {Conversation} conversation
 * @param {object} raw
 * @param {{ fallbackParentId?: string|null }} [context]
 * @returns {Conversation}
 */
export function applyLiveMessage(conversation, raw, context = {}) {
  return applyLiveMessageImpl(conversation, raw, context);
}

/**
 * Create an empty conversation (new chat / not yet synced).
 * @param {string} id
 * @returns {Conversation}
 */
export function createConversation(id) {
  return createConversationImpl(id);
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
  return selectTurnsImpl(conversation, leafId);
}

/**
 * Leaf reached by switching the branch at `nodeId` by `delta` (−1/+1) and
 * then following the newest child down. If the target sibling contains the
 * conversation's current leaf, that leaf is returned. Returns null when there
 * is no sibling in that direction or the node is unknown.
 * @param {Conversation} conversation
 * @param {string} nodeId
 * @param {number} delta
 * @returns {string|null}
 */
export function switchBranch(conversation, nodeId, delta) {
  return switchBranchImpl(conversation, nodeId, delta);
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
  return createStreamDecoderImpl(options);
}

/**
 * Incremental decoder for one logged-out (free mode) response body
 * (`application/vnd.openai.conversation-source+ndjson`). Emits the same
 * StreamEvents as createStreamDecoder. `content` lines are applied only when
 * their revision chain is intact (replace: newer revision; append:
 * baseRevision === current revision); a broken chain re-emits the last good
 * snapshot as interrupted and fails with `revision-gap` (needs recovery).
 * A body without its `end` line fails with `truncated`.
 * @param {{ maxLineChars?: number, maxMessageChars?: number }} [options]
 * @returns {{ push(chunk: string): StreamEvent[], end(): StreamEvent[] }}
 */
export function createConversationSourceDecoder(options = {}) {
  return createConversationSourceDecoderImpl(options);
}

/**
 * Raw (canonical-shaped) user message for a prompt submitted in free mode, so
 * the UI can show the user's turn before/without server history.
 * @param {{ id: string, text: string, parentId?: string|null }} input
 * @returns {object|null} null when id/text are unusable.
 */
export function userMessageFromPrompt(input) {
  if (!input || typeof input !== 'object' || typeof input.id !== 'string' || !input.id || typeof input.text !== 'string') return null;
  return sourceRawMessage({ id: input.id, role: 'user', text: input.text, parentId: typeof input.parentId === 'string' ? input.parentId : null });
}

/**
 * Compact device-only record of a (logged-out) conversation: user/assistant
 * text plus parent chain. null when there is nothing to keep.
 * @param {Conversation} conversation
 * @param {{ title?: string, updatedAt?: number|null }} [meta]
 * @returns {object|null}
 */
export function localRecordFromConversation(conversation, meta = {}) {
  return localRecordFromConversationImpl(conversation, meta);
}

/**
 * Rebuild a Conversation from a local record through the canonical parser.
 * @param {unknown} record
 * @returns {Conversation|null}
 */
export function conversationFromLocalRecord(record) {
  return conversationFromLocalRecordImpl(record);
}

/**
 * Validate local records and keep the newest within the count/size caps.
 * @param {unknown} records
 * @param {{ maxCount?: number, maxChars?: number }} [limits]
 * @returns {object[]}
 */
export function capLocalRecords(records, limits = {}) {
  return capLocalRecordsImpl(records, limits);
}

/**
 * Extract the conversation list from a `/backend-api/conversations` body.
 * @param {string|object} body
 * @returns {{ id: string, title: string, updatedAt: number|null }[] | null}
 */
export function parseConversationList(body) {
  return parseConversationListImpl(body);
}

/**
 * Plain-text projection used for previews, search and copy.
 * @param {Message} message
 * @returns {string}
 */
export function messageToPlainText(message) {
  return messageToPlainTextImpl(message);
}

/**
 * Markdown export of the selected path.
 * @param {Conversation} conversation
 * @param {{ leafId?: string|null, includeReasoning?: boolean, includeTools?: boolean, title?: string }} [options]
 *   `title` overrides the conversation's own (e.g. the sidebar title of a live chat).
 * @returns {string}
 */
export function conversationToMarkdown(conversation, options = {}) {
  return conversationToMarkdownImpl(conversation, options);
}

/**
 * Mark live messages that are still streaming as interrupted (additive, for
 * a stream that ended early: Stop or a dropped connection). Never throws.
 * @param {Conversation} conversation
 * @returns {Conversation}
 */
export function interruptLiveMessages(conversation) {
  return interruptLiveMessagesImpl(conversation);
}
