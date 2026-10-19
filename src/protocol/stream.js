// createStreamDecoder: SSE framing + v1 deltas → StreamEvent[].
// Every `message` event carries the complete current raw message snapshot;
// consumers replace by id. After an `error` nothing else is emitted.

import { createDeltaDecoder } from './delta.js';
import { createSseFramer } from './sse.js';
import { isObject, safeJsonParse } from './util.js';

/** @typedef {import('./types.js').StreamEvent} StreamEvent */

const NOT_JSON = Symbol('not-json');

/**
 * @param {{ maxBufferedChars?: number }} [options]
 * @returns {{ push(chunk: string): StreamEvent[], end(): StreamEvent[] }}
 */
export function createStreamDecoder(options = {}) {
  const framer = createSseFramer(isObject(options) ? options : {});
  let encoding = null;
  let delta = null;
  let failed = false;
  let finished = false;
  let completeSeen = false;
  let conversationId = null;

  const fail = (events, code) => {
    failed = true;
    events.push({ type: 'error', code });
  };

  const noteConversation = (events, value) => {
    const id = isObject(value) && typeof value.conversation_id === 'string' && value.conversation_id ? value.conversation_id : null;
    if (id && id !== conversationId) {
      conversationId = id;
      events.push({ type: 'conversation-id', conversationId: id });
    }
  };

  /** Interpret one decoded JSON value (legacy event or v1 channel value). */
  const handleValue = (events, value) => {
    if (!isObject(value)) return;
    noteConversation(events, value);
    const type = typeof value.type === 'string' ? value.type : '';
    if (type === 'title_generation' && typeof value.title === 'string') {
      events.push({ type: 'title', conversationId: value.conversation_id ?? conversationId, title: value.title });
      return;
    }
    if (type === 'message_stream_complete') { completeSeen = true; return; }
    const raw = type === 'input_message' ? value.input_message : value.message;
    if (isObject(raw) && typeof raw.id === 'string' && raw.id) {
      events.push({ type: 'message', conversationId: value.conversation_id ?? conversationId, raw });
    }
  };

  const handleFrame = (events, frame) => {
    if (failed || finished) return;
    if (frame.data === '[DONE]') {
      finished = true;
      events.push({ type: 'done' });
      return;
    }
    if (frame.event === 'delta_encoding') {
      const declared = safeJsonParse(frame.data, frame.data);
      if (declared !== 'v1') { fail(events, 'unsupported-encoding'); return; }
      encoding = 'v1';
      delta = createDeltaDecoder();
      return;
    }
    const json = safeJsonParse(frame.data, NOT_JSON);
    if (frame.event === 'delta') {
      if (encoding !== 'v1' || !delta) { fail(events, 'invalid-delta'); return; }
      if (json === NOT_JSON) { fail(events, 'invalid-json'); return; }
      const result = delta.decode(json);
      if (!result.ok) { fail(events, 'invalid-delta'); return; }
      handleValue(events, result.value);
      return;
    }
    if (json === NOT_JSON) {
      // Bare keep-alive scalars are harmless; anything else is a broken body.
      if (frame.data.trim() === '') return;
      fail(events, 'invalid-json');
      return;
    }
    handleValue(events, json);
  };

  return {
    push(chunk) {
      const events = [];
      try {
        if (failed || finished) return events;
        const { frames, overflow } = framer.push(chunk);
        for (const frame of frames) handleFrame(events, frame);
        if (overflow && !failed && !finished) fail(events, 'buffer-limit');
      } catch {
        if (!failed) fail(events, 'invalid-json');
      }
      return events;
    },
    end() {
      const events = [];
      try {
        if (failed || finished) return events;
        const { truncated } = framer.end();
        if (truncated || !completeSeen) fail(events, 'truncated');
        else { finished = true; events.push({ type: 'done' }); }
      } catch {
        if (!failed) fail(events, 'truncated');
      }
      return events;
    },
  };
}
