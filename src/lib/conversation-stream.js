import { consumeSse, createConversationSseDecoder } from '../../core.js';

/** Incremental, bounded SSE framing. A broken delta stream is quarantined
 * for this transport, never continued with inherited state from before the
 * missing operation. Previously decoded snapshots remain usable. */
export function createConversationStreamReader({ maxBufferedChars = 20 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBufferedChars) || maxBufferedChars < 1) throw new RangeError('Invalid stream buffer limit');
  let decoder = createConversationSseDecoder();
  let lines = [];
  let lineParts = [];
  let lineLength = 0;
  let bufferedChars = 0;
  let hasData = false;
  let skipLF = false;
  let beginning = true;
  let failed = false;
  let closed = false;

  const clear = () => { lines = []; lineParts = []; lineLength = 0; bufferedChars = 0; hasData = false; };
  const fail = (code) => Object.assign(new Error(code), { code });
  const append = (part) => {
    bufferedChars += part.length;
    if (bufferedChars > maxBufferedChars) throw fail('buffer-limit');
    if (part) { lineParts.push(part); lineLength += part.length; }
  };
  const endLine = (values) => {
    if (lineLength) {
      const line = lineParts.join('');
      lines.push(line);
      hasData ||= line === 'data' || line.startsWith('data:');
      lineParts = [];
      lineLength = 0;
      if (++bufferedChars > maxBufferedChars) throw fail('buffer-limit');
      return;
    }
    const [frame] = consumeSse('', `${lines.join('\n')}\n\n`).frames;
    clear();
    if (!frame || frame.data === '[DONE]') return;
    if (frame.json == null && /^[\s]*[\[{]/.test(frame.data)) throw fail('invalid-json');
    const value = decoder.decode(frame);
    if (value && typeof value === 'object') values.push(value);
  };

  return {
    get failed() { return failed; },
    get bufferedChars() { return bufferedChars; },
    push(chunk, complete = false) {
      const values = [];
      if (closed || failed) { if (complete) closed = true; return { values, error: null, failed }; }
      let error = null;
      try {
        const text = String(chunk ?? '');
        let cursor = 0;
        if (text.length) {
          if (beginning && text[0] === '\uFEFF') cursor = 1;
          beginning = false;
          if (skipLF && text[cursor] === '\n') cursor += 1;
          skipLF = false;
        }
        const endings = /\r\n|\r|\n/g;
        endings.lastIndex = cursor;
        let match;
        while ((match = endings.exec(text))) {
          append(text.slice(cursor, match.index));
          endLine(values);
          cursor = endings.lastIndex;
          skipLF = match[0] === '\r' && cursor === text.length;
        }
        append(text.slice(cursor));
        if (complete) {
          if (hasData || /^data(?::|$)/.test(lineParts.join(''))) throw fail('truncated-event');
          clear();
          decoder = null;
          closed = true;
        }
      } catch (cause) {
        // Error codes, not raw response fragments, enter diagnostics.
        error = ['buffer-limit', 'invalid-json', 'truncated-event'].includes(cause.code) ? cause.code : 'invalid-delta';
        failed = true;
        closed = complete;
        decoder = null;
        clear();
      }
      return { values, error, failed };
    },
  };
}
