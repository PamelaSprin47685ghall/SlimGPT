// Citation / entity marker handling for assistant text.
//
// Server text may contain:
//   * private-use markers  \uE200<type>\uE202<arg>…\uE201  (cite, filecite,
//     entity, navlist, image_group, …), possibly half-received while streaming;
//   * legacy markers       【4:0†source】 (older browsing / file search).
// All markers are removed from the text. Markers that the server resolved in
// `metadata.content_references` / `metadata.citations` become zero-width
// Citation spans anchored where the marker was. Entity markers keep their
// display name as plain text. Nothing else is ever inserted: no Markdown
// links, no placeholder prose. Presentation is the UI's job.

import { isObject, safeHttpUrl, safeJsonParse } from './util.js';

const OPEN = '\uE200';
const CLOSE = '\uE201';
const SEP = '\uE202';
const PRIVATE_USE = /[\uE200-\uE2FF]/g;
const LEGACY = /【\d+(?::\d+)?†[^】\n]{0,80}】/g;
const LEGACY_PARTIAL_TAIL = /【(?:\d+(?::\d+)?(?:†[^】\n]{0,80})?)?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** @typedef {import('./types.js').Citation} Citation */

/**
 * Collect http(s) sources reachable from one reference object (bounded walk).
 * @returns {{ url: string, title: string }[]}
 */
function collectSources(reference) {
  const out = [];
  const seen = new Set();
  const stack = [{ value: reference, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < 2000) {
    const { value, depth } = stack.pop();
    if (!isObject(value) || depth > 8) continue;
    visited += 1;
    const url = safeHttpUrl(value.url) || safeHttpUrl(value.href);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push({ url, title: typeof value.title === 'string' ? value.title : '' });
    }
    const nested = [];
    for (const key of ['items', 'sources', 'webpages', 'fallback_items', 'metadata']) {
      const child = value[key];
      if (Array.isArray(child)) nested.push(...child);
      else if (isObject(child)) nested.push(child);
    }
    for (let index = nested.length - 1; index >= 0; index -= 1) stack.push({ value: nested[index], depth: depth + 1 });
  }
  return out;
}

/**
 * Index server-supplied references by the exact marker text they resolve
 * and (for legacy citations) by their start offset in the original text.
 */
function buildReferenceIndex(metadata) {
  const byMarker = new Map();
  const byLegacyStart = new Map();
  if (!isObject(metadata)) return { byMarker, byLegacyStart };
  const add = (map, key, sources) => {
    if (!sources.length) return;
    map.set(key, [...(map.get(key) || []), ...sources]);
  };
  const references = Array.isArray(metadata.content_references) ? metadata.content_references : [];
  for (const reference of references) {
    if (!isObject(reference) || typeof reference.matched_text !== 'string' || !reference.matched_text) continue;
    add(byMarker, reference.matched_text, collectSources(reference));
  }
  const citations = Array.isArray(metadata.citations) ? metadata.citations : [];
  for (const citation of citations) {
    if (!isObject(citation)) continue;
    const sources = collectSources(citation);
    if (Number.isSafeInteger(citation.start_ix)) add(byLegacyStart, citation.start_ix, sources);
    if (typeof citation.matched_text === 'string' && citation.matched_text) add(byMarker, citation.matched_text, sources);
  }
  return { byMarker, byLegacyStart };
}

function dedupe(sources) {
  const map = new Map();
  for (const source of sources) if (!map.has(source.url)) map.set(source.url, source);
  return [...map.values()];
}

function entityName(body) {
  const parts = body.split(SEP);
  if (parts[0] !== 'entity') return null;
  const parsed = safeJsonParse(parts.slice(1).join(SEP));
  if (Array.isArray(parsed) && typeof parsed[1] === 'string') return parsed[1].replace(PRIVATE_USE, '');
  return '';
}

/** Ranges of the original text that are inside fenced code blocks. */
function fencedRanges(text) {
  const ranges = [];
  let offset = 0;
  let open = null;
  for (const line of text.split('\n')) {
    const match = FENCE.exec(line);
    if (match) {
      if (!open) open = { start: offset, marker: match[1] };
      else if (match[1][0] === open.marker[0] && match[1].length >= open.marker.length) {
        ranges.push([open.start, offset + line.length]);
        open = null;
      }
    }
    offset += line.length + 1;
  }
  if (open) ranges.push([open.start, text.length]);
  return ranges;
}

/**
 * Remove citation/entity markers from assistant text and return structured
 * citations anchored in the cleaned text.
 * @param {string} text
 * @param {object} [metadata] raw message metadata
 * @param {{ streaming?: boolean }} [options]
 * @returns {{ markdown: string, citations: Citation[] }}
 */
export function extractCitations(text, metadata, options = {}) {
  const source = typeof text === 'string' ? text : '';
  if (!source) return { markdown: '', citations: [] };
  const hasPrivate = source.search(PRIVATE_USE) >= 0;
  const hasLegacy = source.includes('【');
  if (!hasPrivate && !hasLegacy) return { markdown: source, citations: [] };

  const { byMarker, byLegacyStart } = buildReferenceIndex(metadata);
  const fences = hasLegacy ? fencedRanges(source) : [];
  const inFence = (index) => fences.some(([start, end]) => index >= start && index < end);

  // Collect marker spans in the original text: [start, end, replacement, sources]
  const spans = [];
  for (let index = source.indexOf(OPEN); index >= 0; index = source.indexOf(OPEN, index + 1)) {
    const close = source.indexOf(CLOSE, index + 1);
    const nextOpen = source.indexOf(OPEN, index + 1);
    if (close < 0 || (nextOpen >= 0 && nextOpen < close)) {
      // Unterminated marker. If another marker starts later, only this opener
      // is dropped; otherwise it is a half-received tail and the rest goes.
      if (nextOpen >= 0) spans.push({ start: index, end: nextOpen, text: '', sources: [] });
      else { spans.push({ start: index, end: source.length, text: '', sources: [] }); break; }
      continue;
    }
    const marker = source.slice(index, close + 1);
    const body = marker.slice(1, -1);
    const name = entityName(body);
    spans.push({ start: index, end: close + 1, text: name ?? '', sources: dedupe(byMarker.get(marker) || []) });
    index = close;
  }
  if (hasLegacy) {
    LEGACY.lastIndex = 0;
    for (const match of source.matchAll(LEGACY)) {
      if (inFence(match.index) || spans.some((span) => match.index < span.end && match.index + match[0].length > span.start)) continue;
      const sources = dedupe([...(byMarker.get(match[0]) || []), ...(byLegacyStart.get(match.index) || [])]);
      spans.push({ start: match.index, end: match.index + match[0].length, text: '', sources });
    }
    if (options.streaming) {
      const tail = LEGACY_PARTIAL_TAIL.exec(source);
      if (tail && !inFence(tail.index) && !spans.some((span) => tail.index < span.end && source.length > span.start)) {
        spans.push({ start: tail.index, end: source.length, text: '', sources: [] });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);

  let markdown = '';
  let cursor = 0;
  const citations = [];
  for (const span of spans) {
    if (span.start < cursor) continue;
    markdown += source.slice(cursor, span.start).replace(PRIVATE_USE, '');
    const anchor = markdown.length;
    markdown += span.text;
    if (span.sources.length) citations.push({ start: anchor, end: anchor, sources: span.sources });
    cursor = span.end;
  }
  markdown += source.slice(cursor).replace(PRIVATE_USE, '');
  return { markdown, citations };
}
