// SlimGPT clean-break protocol contract (v2).
//
// This file is the single source of truth for the data model shared by the
// protocol core (workstream A), the UI shell (workstream B) and the page
// integration (workstream C). It contains JSDoc typedefs and frozen constants
// only: no logic, no DOM, no Svelte. Changing a shape here is a contract
// change and must be agreed by all workstreams.

/**
 * @typedef {'user' | 'assistant' | 'tool' | 'system'} Role
 */

/**
 * Lifecycle of one message. Derived ONLY from the raw message's own
 * `status` / `end_turn` / error fields, never from arrival order.
 * @typedef {'streaming' | 'done' | 'interrupted' | 'error'} MessageStatus
 */

/**
 * A resolved citation. `start`/`end` are UTF-16 offsets into the owning
 * TextBlock.markdown (after markers were removed). Rendering is the UI's job;
 * the parser never writes Markdown links or placeholder prose into text.
 * @typedef {Object} Citation
 * @property {number} start
 * @property {number} end
 * @property {{ url: string, title: string }[]} sources  Only server-supplied, http(s) URLs.
 */

/**
 * @typedef {Object} TextBlock
 * @property {'text'} kind
 * @property {string} markdown     Exact server text minus citation/entity markers.
 * @property {Citation[]} citations
 */

/**
 * @typedef {Object} ReasoningBlock
 * @property {'reasoning'} kind
 * @property {string} markdown
 * @property {string|null} summary
 * @property {number|null} durationSec
 */

/**
 * @typedef {Object} ToolCallBlock
 * @property {'tool_call'} kind
 * @property {string} tool          Recipient / function name, e.g. "python", "web.run".
 * @property {string|null} callId
 * @property {string} input         Raw input text exactly as sent (code or JSON text).
 * @property {string|null} language e.g. "python", "json" when known.
 */

/**
 * @typedef {Object} ToolResultBlock
 * @property {'tool_result'} kind
 * @property {string} tool
 * @property {string|null} callId
 * @property {string} output        Raw text output; structured outputs are JSON.stringify(…, null, 2).
 * @property {boolean} isError
 */

/**
 * @typedef {Object} ImageBlock
 * @property {'image'} kind
 * @property {string} assetPointer  Opaque server pointer. The UI shows a neutral card; never a fake URL.
 * @property {number|null} width
 * @property {number|null} height
 */

/**
 * @typedef {Object} FileBlock
 * @property {'file'} kind
 * @property {string} name
 * @property {number|null} size
 * @property {string|null} mime
 */

/**
 * @typedef {Object} ErrorBlock
 * @property {'error'} kind
 * @property {string} message
 */

/**
 * Anything the parser does not understand. Never silently dropped; the UI
 * shows a collapsed "unsupported content (<contentType>)" row with raw JSON.
 * @typedef {Object} UnknownBlock
 * @property {'unknown'} kind
 * @property {string} contentType
 * @property {unknown} raw
 */

/**
 * A document (kind 'textdoc') produced by an assistant directive such as
 * `:::writing{variant="document" id="58321" title="…"}` … `:::` (the official
 * UI renders it as a document card). Additive (2026-10-19).
 * @typedef {Object} DocumentBlock
 * @property {'textdoc'} kind
 * @property {string} directive    Directive name, e.g. "writing".
 * @property {string|null} variant e.g. "document", "email".
 * @property {string|null} title
 * @property {string} markdown     Body between the fence lines (markers removed).
 * @property {Citation[]} citations Offsets into `markdown`.
 */

/**
 * @typedef {TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock |
 *   ImageBlock | FileBlock | ErrorBlock | UnknownBlock | DocumentBlock} Block
 */

/**
 * The single unified message model. Every source (canonical history,
 * live SSE, cached snapshot) produces exactly this shape.
 * @typedef {Object} Message
 * @property {string} id
 * @property {string|null} parentId
 * @property {Role} role
 * @property {MessageStatus} status
 * @property {Block[]} blocks       In display order. May be empty only for a streaming placeholder.
 * @property {boolean} hidden       Server marked it hidden (system prompts, user context, memory writes...).
 * @property {string|null} model
 * @property {number|null} createdAt  Unix seconds.
 * @property {'canonical' | 'live'} source
 */

/**
 * One node of the conversation tree. `message` is null for routing/root nodes.
 * @typedef {Object} Node
 * @property {string} id
 * @property {string|null} parentId
 * @property {string[]} childIds
 * @property {Message|null} message
 */

/**
 * Immutable conversation state. All updates return a new object.
 * @typedef {Object} Conversation
 * @property {string} id
 * @property {string} title
 * @property {Map<string, Node>} nodes
 * @property {string|null} currentNodeId  Server's current leaf (or newest live leaf).
 * @property {boolean} complete           True once a full canonical history was ingested.
 */

/**
 * A user message plus every visible non-user message after it on the
 * selected path, up to the next visible user message. Ownership is decided
 * by the parent chain only.
 * @typedef {Object} Turn
 * @property {Message|null} user        null only for output that precedes the first user message.
 * @property {Message[]} replies
 * @property {{ index: number, count: number, siblingIds: string[] }} userBranch   Branch of the user message.
 * @property {{ index: number, count: number, siblingIds: string[] }} replyBranch  Branch of the first reply.
 */

/**
 * Events emitted by the stream decoder. `snapshot` is ALWAYS the complete
 * current raw message (deltas are applied inside the decoder); consumers
 * replace, never merge text.
 * @typedef {{ type: 'message', conversationId: string|null, raw: object } |
 *   { type: 'conversation-id', conversationId: string } |
 *   { type: 'title', conversationId: string|null, title: string } |
 *   { type: 'done' } |
 *   { type: 'error', code: StreamErrorCode }} StreamEvent
 */

/**
 * @typedef {'invalid-json' | 'invalid-delta' | 'unsupported-encoding' | 'buffer-limit' | 'truncated' | 'revision-gap'} StreamErrorCode
 */

export const ROLES = Object.freeze(['user', 'assistant', 'tool', 'system']);
export const MESSAGE_STATUSES = Object.freeze(['streaming', 'done', 'interrupted', 'error']);
export const BLOCK_KINDS = Object.freeze([
  'text', 'reasoning', 'tool_call', 'tool_result', 'image', 'file', 'error', 'unknown', 'textdoc',
]);
export const STREAM_ERROR_CODES = Object.freeze([
  'invalid-json', 'invalid-delta', 'unsupported-encoding', 'buffer-limit', 'truncated', 'revision-gap',
]);
