// createConversationSourceDecoder: the logged-out (free mode) response format
// `application/vnd.openai.conversation-source+ndjson` → StreamEvent[].
//
// One JSON object per line: `{ version: 1, type: 'control'|'shared'|'content'|'state'|'end', … }`.
// Only `content` lines carry message text: `{ messageId, revision, mode: 'replace'|'append',
// baseRevision?, markdown, status? }`. The decoder keeps the text per message and
// applies a line only when its revision chain is intact:
//   replace  → text := markdown (needs revision > current revision)
//   append   → text += markdown (needs baseRevision === current revision)
// A broken chain is never guessed: the last good snapshot is re-emitted as
// interrupted and the stream fails with `revision-gap` (needs recovery).
// `shared` (HTML templates) and unknown lines are ignored. Every `message`
// event carries a complete raw message snapshot in the canonical shape that
// normalizeMessage understands. After an `error` nothing else is emitted.

import { isObject, safeJsonParse } from './util.js';

/** @typedef {import('./types.js').StreamEvent} StreamEvent */

const NOT_JSON = Symbol('not-json');
const DEFAULT_MAX_LINE_CHARS = 16 * 1024 * 1024;
const DEFAULT_MAX_MESSAGE_CHARS = 4 * 1024 * 1024;
const MAX_ID_CHARS = 200;

const DONE_STATUSES = new Set(['complete', 'completed', 'finished', 'done']);
const LIVE_STATUSES = new Set(['', 'streaming', 'pending', 'in_progress', 'started']);
const ERROR_STATUSES = new Set(['error', 'failed']);

/** @param {unknown} value */
export const sourceId = (value) => (typeof value === 'string' && value && value.length <= MAX_ID_CHARS && !/\s/.test(value) ? value : null);

/** Map a conversation-source status to the canonical raw `status`. */
function rawStatus(status) {
  const value = typeof status === 'string' ? status.toLowerCase() : '';
  if (DONE_STATUSES.has(value)) return 'finished_successfully';
  if (LIVE_STATUSES.has(value)) return 'in_progress';
  if (ERROR_STATUSES.has(value)) return 'failed';
  return 'finished_partial_completion';
}

/**
 * Canonical-shaped raw message for one text message.
 * @param {{ id: string, role: 'user'|'assistant', text: string, status?: string, parentId?: string|null }} input
 */
export function sourceRawMessage({ id, role, text, status = 'finished_successfully', parentId = null }) {
  const raw = {
    id,
    author: { role },
    content: { content_type: 'text', parts: [typeof text === 'string' ? text : ''] },
    status,
    end_turn: role === 'assistant' && status === 'finished_successfully' ? true : null,
    metadata: parentId ? { parent_id: parentId } : {},
  };
  if (status === 'finished_partial_completion') raw.metadata.finish_details = { type: 'interrupted' };
  return raw;
}

/**
 * @param {{ maxLineChars?: number, maxMessageChars?: number }} [options]
 * @returns {{ push(chunk: string): StreamEvent[], end(): StreamEvent[] }}
 */
export function createConversationSourceDecoder(options = {}) {
  const opts = isObject(options) ? options : {};
  const maxLine = positive(opts.maxLineChars, DEFAULT_MAX_LINE_CHARS);
  const maxMessage = positive(opts.maxMessageChars, DEFAULT_MAX_MESSAGE_CHARS);
  let buffer = '';
  let failed = false;
  let finished = false;
  let conversationId = null;
  /** @type {Map<string, { revision: number, text: string, status: string, parentId: string|null }>} */
  const messages = new Map();

  const snapshot = (id, state) => ({
    type: 'message',
    conversationId,
    raw: sourceRawMessage({ id, role: 'assistant', text: state.text, status: state.status, parentId: state.parentId }),
  });

  /** Close every still-running message as interrupted (never invent text). */
  const interruptOpen = (events) => {
    for (const [id, state] of messages) {
      if (state.status === 'in_progress') {
        state.status = 'finished_partial_completion';
        events.push(snapshot(id, state));
      }
    }
  };

  const fail = (events, code) => {
    interruptOpen(events);
    failed = true;
    events.push({ type: 'error', code });
  };

  const noteConversation = (events, value) => {
    const id = sourceId(value);
    if (id && id !== conversationId) {
      conversationId = id;
      events.push({ type: 'conversation-id', conversationId: id });
    }
  };

  const handleContent = (events, line) => {
    const id = sourceId(line.messageId);
    if (!id) return;
    const revision = line.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) { fail(events, 'revision-gap'); return; }
    const markdown = line.markdown === undefined || line.markdown === null ? '' : line.markdown;
    if (typeof markdown !== 'string') { fail(events, 'invalid-json'); return; }
    const current = messages.get(id) || null;
    if (current && revision <= current.revision) return; // replayed/duplicate line: already applied
    let text;
    if (line.mode === 'replace') {
      text = markdown;
    } else if (line.mode === 'append') {
      if (!current || line.baseRevision !== current.revision) { fail(events, 'revision-gap'); return; }
      text = current.text + markdown;
    } else {
      fail(events, 'revision-gap');
      return;
    }
    if (text.length > maxMessage) { fail(events, 'buffer-limit'); return; }
    const parentId = sourceId(line.streamingParent?.metadata?.streaming_parent_id) || current?.parentId || null;
    const status = line.status === undefined && current ? current.status : rawStatus(line.status);
    const state = { revision, text, status, parentId };
    messages.set(id, state);
    events.push(snapshot(id, state));
  };

  const handleControl = (events, detail) => {
    if (!isObject(detail)) return;
    if (detail.kind === 'conversation-id' || detail.kind === 'terminal-received') noteConversation(events, detail.conversationId);
    if (detail.kind === 'terminal-received' && typeof detail.terminalKind === 'string' && detail.terminalKind !== 'complete') {
      const id = sourceId(detail.messageId);
      const state = id ? messages.get(id) : null;
      if (state && state.status === 'in_progress') {
        state.status = detail.terminalKind === 'error' || detail.terminalKind === 'failed' ? 'failed' : 'finished_partial_completion';
        events.push(snapshot(id, state));
      }
    }
  };

  const handleLine = (events, text) => {
    if (failed || finished) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const line = safeJsonParse(trimmed, NOT_JSON);
    if (line === NOT_JSON || !isObject(line)) { fail(events, 'invalid-json'); return; }
    if (line.version !== 1) { fail(events, 'unsupported-encoding'); return; }
    switch (line.type) {
      case 'control': handleControl(events, line.detail); return;
      case 'content': handleContent(events, line); return;
      case 'state': {
        const state = safeJsonParse(line.conversationState, null);
        if (isObject(state)) noteConversation(events, state.backendConversationId);
        return;
      }
      case 'end':
        interruptOpen(events);
        finished = true;
        events.push({ type: 'done' });
        return;
      default:
        // 'shared' HTML templates and future line types carry no message text.
    }
  };

  return {
    push(chunk) {
      const events = [];
      try {
        if (failed || finished || typeof chunk !== 'string' || !chunk) return events;
        buffer += chunk;
        let index;
        while (!failed && !finished && (index = buffer.indexOf('\n')) >= 0) {
          const text = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          handleLine(events, text);
        }
        if (!failed && !finished && buffer.length > maxLine) fail(events, 'buffer-limit');
        if (finished) buffer = '';
      } catch {
        if (!failed) fail(events, 'invalid-json');
      }
      return events;
    },
    end() {
      const events = [];
      try {
        if (failed || finished) return events;
        const tail = buffer;
        buffer = '';
        if (tail.trim()) handleLine(events, tail);
        if (!failed && !finished) fail(events, 'truncated');
      } catch {
        if (!failed) fail(events, 'truncated');
      }
      return events;
    },
  };
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
