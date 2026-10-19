// Assistant "directive" containers:
//
//   :::writing{variant="document" id="58321" title="宇宙大爆炸"}
//   # body markdown …
//   :::
//
// Known writing directives become DocumentBlocks (kind 'textdoc'); any other directive only
// loses its fence lines and its inner Markdown stays ordinary text. Fences
// inside fenced code are ignored. An unclosed directive (still streaming)
// runs to the end of the text.

/** @typedef {import('./types.js').Citation} Citation */

const OPEN = /^ {0,3}:::([A-Za-z][\w.-]*)(\{.*\})?[ \t]*$/;
const CLOSE = /^ {0,3}:::[ \t]*$/;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DOCUMENT_DIRECTIVES = new Set(['writing', 'canvas', 'textdoc']);

/** Parse `{key="value" key2=value2}` attributes. */
export function parseDirectiveAttributes(source) {
  const attrs = {};
  if (typeof source !== 'string') return attrs;
  const body = source.replace(/^\{/, '').replace(/\}$/, '');
  for (const match of body.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s}]+))/g)) {
    attrs[match[1]] = (match[2] !== undefined ? match[2].replace(/\\(.)/g, '$1') : match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * Split cleaned text into text/document segments.
 * @param {string} markdown text after citation extraction
 * @param {Citation[]} citations offsets into `markdown`
 * @returns {Array<{ kind: 'text', markdown: string, citations: Citation[] } | { kind: 'textdoc', directive: string, variant: string|null, title: string|null, markdown: string, citations: Citation[] }>}
 */
export function splitDirectives(markdown, citations = []) {
  if (typeof markdown !== 'string' || !markdown.includes(':::')) return [{ kind: 'text', markdown, citations }];
  const lines = markdown.split('\n');
  const segments = [];
  let offset = 0;
  let textStart = 0;
  let codeFence = null;
  let open = null; // { name, attrs, bodyStart, depth, fenceStart }
  const slice = (start, end) => ({
    markdown: markdown.slice(start, end),
    citations: citations.filter((c) => c.start >= start && c.end <= end).map((c) => ({ ...c, start: c.start - start, end: c.end - start })),
  });
  const pushText = (start, end) => {
    const part = slice(start, end);
    if (part.markdown.trim() || part.citations.length) segments.push({ kind: 'text', ...part });
  };
  const closeDirective = (bodyEnd, after) => {
    const body = slice(open.bodyStart, Math.max(open.bodyStart, bodyEnd));
    pushText(textStart, open.fenceStart);
    if (DOCUMENT_DIRECTIVES.has(open.name.toLowerCase())) {
      segments.push({
        kind: 'textdoc', directive: open.name, variant: open.attrs.variant ?? null, title: open.attrs.title ?? null, ...body,
      });
    } else if (body.markdown.trim() || body.citations.length) {
      segments.push({ kind: 'text', ...body });
    }
    textStart = after;
    open = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineEnd = offset + line.length;
    const next = Math.min(markdown.length, lineEnd + 1);
    const fence = CODE_FENCE.exec(line);
    if (fence) {
      if (!codeFence) codeFence = fence[1];
      else if (fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length && !line.trim().slice(fence[1].length)) codeFence = null;
    } else if (!codeFence) {
      const opening = OPEN.exec(line);
      if (opening) {
        if (open) open.depth += 1;
        else open = { name: opening[1], attrs: parseDirectiveAttributes(opening[2] || ''), bodyStart: next, depth: 0, fenceStart: offset };
      } else if (open && CLOSE.test(line)) {
        if (open.depth > 0) open.depth -= 1;
        else closeDirective(Math.max(open.bodyStart, offset - 1), next);
      }
    }
    offset = next;
  }
  if (open) closeDirective(markdown.length, markdown.length);
  pushText(textStart, markdown.length);
  return segments.length ? segments : [{ kind: 'text', markdown, citations }];
}
