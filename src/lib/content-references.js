// References are presentation metadata, not disposable punctuation. Resolve
// only URLs explicitly supplied by the server; never guess a URL from an id.
export function renderContentReferences(text, metadata = {}) {
  const source = String(text ?? '');
  if (!source.includes('\uE200')) return source;
  const references = referenceIndex(metadata);
  const numbers = new Map();
  const link = ({ url, title }) => {
    if (!numbers.has(url)) numbers.set(url, numbers.size + 1);
    const label = `来源 ${numbers.get(url)}`;
    // streaming-markdown treats angle destinations and optional link titles
    // as part of the href. Use its supported destination syntax instead of
    // silently navigating to a bogus relative ChatGPT URL.
    const titleText = typeof title === 'string' ? title : '';
    const shouldIncludeTitle = metadata?.withTitle === true || metadata?.includeTitle === true || metadata?.linkTitles === true || (metadata?.withTitle !== false && Boolean(titleText && metadata?.title !== undefined));
    if (shouldIncludeTitle && titleText) {
      const escapedTitle = titleText.replace(/[\r\n]+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      if (escapedTitle) return `[${label}](${url} "${escapedTitle}")`;
    }
    return `[${label}](${url})`;
  };
  return mapMarkdownProse(source, (prose) => prose.replace(/\uE200([^\uE200\uE201\n]*)\uE201/g, (marker, body) => {
    const [type, ...parts] = body.split('\uE202');
    if (type === 'cite' || type === 'filecite') {
      const known = [...(references.get(marker) || [])];
      for (const id of parts) known.push(...(references.get(id) || []));
      const unique = [...new Map(known.map((item) => [item.url, item])).values()].filter((item) => item.url);
      return unique.length ? unique.map(link).join(' ') : (metadata?.rawPlaceholder ? '〔来源信息未同步〕' : (metadata?.wrapPlaceholder ? '<span class="citation-unsynced">〔来源信息未同步〕</span>' : '〔来源信息未同步〕'));
    }
    if (type === 'entity') {
      try {
        const entity = JSON.parse(parts.join('\uE202'));
        if (Array.isArray(entity) && typeof entity[1] === 'string') return escapeLabel(entity[1]);
      } catch { /* Unknown entity dialect: keep a visible placeholder. */ }
      return '〔实体信息未同步〕';
    }
    const labels = {
      navlist: '来源列表', filenavlist: '文件列表', i: '图片', image_group: '图片',
      products: '商品卡片', product: '商品卡片', finance: '行情图表',
      forecast: '天气卡片', schedule: '赛程', standing: '排名',
    };
    const known = (references.get(marker) || []).filter((item) => item.url);
    return known.length ? known.map(link).join(' ') : `〔${labels[type] || '官方卡片'}：暂未展开〕`;
  }));
}

function referenceIndex(metadata) {
  const index = new Map();
  const roots = [metadata?.content_references, metadata?.citations].filter(Array.isArray).flat();
  const visited = new Set();
  const collect = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || visited.has(value) || visited.size >= 4000 || depth > 32) return [];
    visited.add(value);
    const links = [];
    const url = safeReferenceUrl(value.url || value.href);
    if (url) links.push({ url, title: typeof value.title === 'string' ? value.title : '' });
    for (const key of ['items', 'sources', 'citations', 'references', 'webpages', 'metadata']) {
      const child = value[key];
      for (const nested of Array.isArray(child) ? child : [child]) links.push(...collect(nested, depth + 1));
    }
    // A grouped citation owns its descendants, but a child's id must never
    // inherit sibling URLs: that would attach unrelated evidence to a claim.
    for (const key of ['matched_text', 'ref_id', 'reference_id', 'citation_id']) {
      const id = value[key];
      if (typeof id === 'string') index.set(id, [...(index.get(id) || []), ...links]);
    }
    return links;
  };
  for (const reference of roots) collect(reference);
  return index;
}

function safeReferenceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href.replace(/[<>"\\()\[\]]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch { return ''; }
}

function escapeLabel(value) {
  return String(value).replace(/[\\`*_{}\[\]<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

// Literal code (including an unfinished streaming fence) is never rewritten.
// Keep this scanner independent of DOM/Markdown parser state so exports and
// live views use the same text and the user's code survives byte-for-byte.
function mapMarkdownProse(source, transform) {
  let output = '';
  let cursor = 0;
  let proseStart = 0;
  const preserve = (end) => {
    output += transform(source.slice(proseStart, cursor)) + source.slice(cursor, end);
    cursor = end;
    proseStart = end;
  };
  while (cursor < source.length) {
    if (cursor === 0 || source[cursor - 1] === '\n') {
      const fence = source.slice(cursor).match(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/);
      if (fence) {
        const marker = fence[1][0];
        const closing = new RegExp(`^ {0,3}${marker === '`' ? '`' : '~'}{${fence[1].length},}[ \\t]*\\r?$`, 'gm');
        closing.lastIndex = cursor + fence[0].length;
        const match = closing.exec(source);
        preserve(match ? match.index + match[0].length : source.length);
        continue;
      }
    }
    if (source[cursor] === '`' && (cursor === 0 || source[cursor - 1] !== '\\')) {
      let count = 1;
      while (source[cursor + count] === '`') count += 1;
      const delimiter = '`'.repeat(count);
      let end = source.indexOf(delimiter, cursor + count);
      while (end >= 0 && (source[end - 1] === '`' || source[end + count] === '`')) end = source.indexOf(delimiter, end + count);
      if (end >= 0) {
        preserve(end + count);
        continue;
      }
      cursor += count;
      continue;
    }
    cursor += 1;
  }
  return output + transform(source.slice(proseStart));
}
