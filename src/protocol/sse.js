// The only text/event-stream framer. Incremental and allocation-light: it
// keeps only the current incomplete line plus the fields of the event being
// built, so 1-character chunks stay O(n). CR, LF and CRLF are all line
// endings, including a CRLF split across chunks. EOF is NOT an event
// delimiter: a pending event at end() is reported as truncated.

/**
 * @typedef {{ event: string, data: string, id: string|null }} SseFrame
 */

/**
 * @param {{ maxBufferedChars?: number }} [options]
 */
export function createSseFramer(options = {}) {
  const maxBufferedChars = Number.isFinite(options.maxBufferedChars) && options.maxBufferedChars > 0
    ? options.maxBufferedChars
    : 16 * 1024 * 1024;
  let line = '';
  let skipLf = false;
  let atStart = true;
  let eventName = '';
  let dataLines = [];
  let dataChars = 0;
  let eventId = null;
  let hasFields = false;
  let overflow = false;

  const dispatch = (frames) => {
    if (dataLines.length) {
      frames.push({ event: eventName || 'message', data: dataLines.join('\n'), id: eventId });
    }
    eventName = '';
    dataLines = [];
    dataChars = 0;
    hasFields = false;
  };

  const processLine = (text, frames) => {
    if (text === '') {
      dispatch(frames);
      return;
    }
    if (text.charCodeAt(0) === 58 /* : */) return; // comment
    hasFields = true;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === 'data') {
      dataLines.push(value);
      dataChars += value.length + 1;
    } else if (field === 'event') {
      eventName = value;
    } else if (field === 'id') {
      if (!value.includes('\0')) eventId = value;
    }
  };

  return {
    /**
     * @param {string} chunk
     * @returns {{ frames: SseFrame[], overflow: boolean }}
     */
    push(chunk) {
      const frames = [];
      if (overflow) return { frames, overflow };
      let text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
      if (atStart && text.length) {
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        atStart = false;
      }
      let start = 0;
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code === 10 /* \n */) {
          if (skipLf && index === start && line === '') {
            skipLf = false;
            start = index + 1;
            continue;
          }
          skipLf = false;
          processLine(line + text.slice(start, index), frames);
          line = '';
          start = index + 1;
        } else if (code === 13 /* \r */) {
          skipLf = false;
          processLine(line + text.slice(start, index), frames);
          line = '';
          start = index + 1;
          skipLf = true;
        } else if (skipLf) {
          skipLf = false;
        }
      }
      if (start < text.length) line += text.slice(start);
      if (line.length + dataChars > maxBufferedChars) overflow = true;
      return { frames, overflow };
    },
    /**
     * Signal EOF. `truncated` is true when an event was still being built.
     * @returns {{ truncated: boolean }}
     */
    end() {
      const truncated = line.length > 0 || hasFields || dataLines.length > 0;
      line = '';
      dataLines = [];
      hasFields = false;
      return { truncated };
    },
  };
}
