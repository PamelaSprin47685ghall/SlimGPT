// Citation spans (protocol Citation{start,end,sources}) are rendered as small
// numbered links. To let the streaming Markdown renderer place them inside
// the right paragraph/list item, each citation end is marked with one BMP
// private-use sentinel character that the renderer turns into a <sup>.

export const SENTINEL_BASE = 0xf000;
export const SENTINEL_LIMIT = 0x8ff; // U+F000..U+F8FF
const SENTINEL_RANGE = /[\uF000-\uF8FF]/;

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} markdown
 * @param {{start:number,end:number,sources:{url:string,title:string}[]}[]} citations
 * @returns {{ source: string, groups: {n:number,url:string,title:string}[][], fallback: {n:number,url:string,title:string}[] }}
 *   `groups[i]` belongs to sentinel SENTINEL_BASE+i. When the text already
 *   contains sentinel-range characters nothing is injected and every source is
 *   returned in `fallback` instead (rendered as a list after the text).
 */
export function injectCitations(markdown, citations) {
  const text = String(markdown ?? '');
  const numbers = new Map();
  const numbered = (source) => {
    const url = safeUrl(source?.url);
    if (!url) return null;
    if (!numbers.has(url)) numbers.set(url, { n: numbers.size + 1, url, title: String(source?.title || '') });
    return numbers.get(url);
  };
  const usable = (Array.isArray(citations) ? citations : [])
    .filter((c) => c && Number.isInteger(c.end) && c.end >= 0 && c.end <= text.length && Array.isArray(c.sources))
    .map((c, order) => ({ end: c.end, order, sources: c.sources }))
    .sort((a, b) => a.end - b.end || a.order - b.order);
  const groups = [];
  const cuts = [];
  for (const citation of usable) {
    const group = [];
    for (const source of citation.sources) {
      const entry = numbered(source);
      if (entry && !group.includes(entry)) group.push(entry);
    }
    if (!group.length) continue;
    cuts.push({ end: citation.end, group });
  }
  if (SENTINEL_RANGE.test(text) || cuts.length > SENTINEL_LIMIT) {
    return { source: text, groups: [], fallback: [...numbers.values()] };
  }
  let source = '';
  let cursor = 0;
  for (const cut of cuts) {
    source += text.slice(cursor, cut.end) + String.fromCharCode(SENTINEL_BASE + groups.length);
    groups.push(cut.group);
    cursor = cut.end;
  }
  return { source: source + text.slice(cursor), groups, fallback: [] };
}
