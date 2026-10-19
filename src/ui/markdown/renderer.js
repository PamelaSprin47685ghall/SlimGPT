// Incremental (streaming) Markdown renderer for the UI frame.
//
// Ported from src/lib/incremental-markdown.js (legacy) and trimmed:
//  * streaming-markdown builds the DOM; appended text is parsed incrementally,
//    any non-append change resets and re-renders (snapshot semantics).
//  * unfinished spans at EOF stay literal; code keeps every source byte.
//  * code is highlighted by a lazily loaded highlight.js, math by lazily
//    loaded KaTeX. If either chunk fails to load the raw text stays visible.
//  * citations arrive as private-use sentinels (see ./citations.js) and are
//    rendered as <sup class="cite"> links.
//  * links/images are sanitized to http(s)/mailto; raw HTML stays inert text.
import {
  CHECKED, TABLE, HREF, LANG, SRC, START,
  CODE_FENCE, CODE_BLOCK, CODE_INLINE, EQUATION_BLOCK, EQUATION_INLINE,
  ITALIC_AST, ITALIC_UND, STRONG_AST, STRONG_UND, STRIKE, LINK, IMAGE,
  default_add_text, default_add_token, default_end_token, default_renderer,
  parser, parser_end, parser_write,
} from 'streaming-markdown';
import { copyWithFeedback } from '../lib/clipboard.js';
import { SENTINEL_BASE, SENTINEL_LIMIT } from './citations.js';

const MAX_HIGHLIGHT_CHARS = 100_000;
const SENTINELS = /[\uF000-\uF8FF]/;
const literalPrefixes = new Map([
  [ITALIC_AST, '*'], [ITALIC_UND, '_'], [STRONG_AST, '**'], [STRONG_UND, '__'],
  [STRIKE, '~~'], [LINK, '['], [IMAGE, '!['],
]);

let katexPromise = null;
let hljsPromise = null;
const loadKatex = () => (katexPromise ||= import('./katex-loader.js').then((m) => m.default));
const loadHighlighter = () => (hljsPromise ||= import('./highlight-loader.js').then((m) => m.default));

/**
 * @param {HTMLElement} root
 * @returns {{ update(source: string, options?: { final?: boolean, citations?: object[][] }): void, reset(): void }}
 */
export function createMarkdownRenderer(root) {
  let source = '';
  let finalizedLength = -1;
  const context = { citations: [] };
  let state = createParser(root, context);
  let preview = null;
  let lastWasCR = false;

  function reset() {
    root.replaceChildren();
    source = '';
    finalizedLength = -1;
    state = createParser(root, context);
    preview = null;
    lastWasCR = false;
  }

  function removePreview() {
    preview?.remove();
    preview = null;
  }

  function showPreview() {
    const pending = String(state.pending || '').replace(/[\uF000-\uF8FF]/g, '');
    if (!pending) return;
    const data = state.renderer.data;
    const parent = data.nodes[data.index] || root;
    if (parent.tagName === 'IMG') return;
    preview = document.createTextNode(pending);
    parent.appendChild(preview);
  }

  function update(nextSource, { final = false, citations } = {}) {
    const next = String(nextSource ?? '');
    if (citations !== undefined && !sameCitations(context.citations, citations)) {
      context.citations = citations || [];
      if (source) reset();
    }
    if (!next.startsWith(source) || (finalizedLength >= 0 && next !== source)) reset();
    const suffix = next.slice(source.length);
    if (suffix) {
      removePreview();
      // A CRLF split across updates is still one newline.
      let normalized = suffix;
      if (lastWasCR && normalized.startsWith('\n')) normalized = normalized.slice(1);
      lastWasCR = suffix.endsWith('\r');
      parser_write(state, normalized.replace(/\r\n|\r/g, '\n'));
      source = next;
      finalizedLength = -1;
    }
    if (final && finalizedLength !== source.length) {
      removePreview();
      state.finish();
      finalizedLength = source.length;
    } else if (!final && suffix) {
      showPreview();
    }
  }

  return { update, reset };
}

function sameCitations(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function insideLiteral(node, root) {
  for (let current = node; current && current !== root; current = current.parentElement) {
    if (/^(CODE|PRE|A|IMG|EQUATION-BLOCK|EQUATION-INLINE)$/.test(current.tagName)) return true;
  }
  return false;
}

function citationElement(group) {
  const sup = document.createElement('sup');
  sup.className = 'cite';
  for (const source of group) {
    const link = document.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = String(source.n);
    let host = '';
    try { host = new URL(source.url).hostname; } catch { host = ''; }
    link.title = source.title ? `${source.title}${host ? ` (${host})` : ''}` : host;
    sup.append(link);
  }
  return sup;
}

function createParser(root, context) {
  const renderer = default_renderer(root);
  const tokens = new WeakMap();
  let state;

  const addPlain = (data, text) => {
    const node = data.nodes[data.index];
    if (node?.tagName === 'IMG') node.alt += text;
    else default_add_text(data, text);
  };

  renderer.add_token = (data, type) => {
    default_add_token(data, type);
    const node = data.nodes[data.index];
    if (!node || node === root) return;
    let prefix = literalPrefixes.get(type) || '';
    if (type === CODE_INLINE) prefix = '`'.repeat(state.fence_start || 1);
    if (type === EQUATION_INLINE) prefix = state.pending.startsWith('\\') ? '\\(' : '$';
    if (type === EQUATION_BLOCK) prefix = state.pending.startsWith('\\') ? '\\[\n' : '$$\n';
    tokens.set(node, { type, prefix });
    if (node.tagName === 'A') {
      node.target = '_blank';
      node.rel = 'noreferrer noopener';
    } else if (type === TABLE) {
      wrapTable(node);
    } else if (type === CODE_BLOCK || type === CODE_FENCE) {
      ensureCodeShell(node);
    } else if (node.tagName === 'IMG') {
      node.loading = 'lazy';
      node.decoding = 'async';
      node.referrerPolicy = 'no-referrer';
      node.alt = '';
      node.addEventListener('error', () => replaceUnavailableImage(node), { once: true });
    } else if (node.tagName === 'INPUT' && node.type === 'checkbox') {
      node.disabled = true;
    }
  };

  renderer.add_text = (data, text) => {
    if (!SENTINELS.test(text)) { addPlain(data, text); return; }
    const node = data.nodes[data.index];
    const literal = insideLiteral(node, root);
    let buffer = '';
    for (const char of text) {
      const index = char.charCodeAt(0) - SENTINEL_BASE;
      if (char.length === 1 && index >= 0 && index <= SENTINEL_LIMIT) {
        if (buffer) { addPlain(data, buffer); buffer = ''; }
        const group = context.citations[index];
        if (group?.length && !literal && node) node.append(citationElement(group));
        else if (!group) buffer += char;
      } else buffer += char;
    }
    if (buffer) addPlain(data, buffer);
  };

  renderer.set_attr = setSafeAttribute;
  renderer.end_token = (data) => {
    const node = data.nodes[data.index];
    if (tokens.get(node)?.type === CODE_FENCE && state.pending.startsWith('\n')) {
      // The parser withholds the newline before a closing fence; it belongs to the code.
      node.append(document.createTextNode('\n'));
    }
    finalizeNode(data);
    default_end_token(data);
  };
  state = parser(renderer);
  state.finish = () => {
    // parser_end only feeds a synthetic newline; it does not close open code,
    // tables or inline tokens. Remember the real tail before that sentinel.
    const data = renderer.data;
    const before = data.nodes[data.index];
    const beforeInfo = tokens.get(before);
    const tail = (state.text + state.pending).replace(/[\uF000-\uF8FF]/g, '');
    const beforeBody = before?.tagName === 'IMG' ? before.alt : before?.textContent || '';
    const beforeChildren = before ? [...before.childNodes] : [];
    const pendingEscape = state.pending === '\\' && ![CODE_FENCE, CODE_BLOCK, CODE_INLINE, EQUATION_INLINE, EQUATION_BLOCK].includes(beforeInfo?.type);
    if (pendingEscape) {
      renderer.add_text(data, tail);
      state.text = state.pending = '';
    } else parser_end(state);
    while (data.index > 0) {
      const node = data.nodes[data.index];
      const info = tokens.get(node);
      if (info?.type === CODE_FENCE || info?.type === CODE_BLOCK) {
        if (node === before) node.textContent = beforeBody + tail;
        finalizeCodeBlock(node);
      } else if (info?.prefix) {
        // At EOF an unclosed span is literal, not emphasis/link/math.
        const fragment = document.createDocumentFragment();
        fragment.append(info.prefix);
        const flat = node.tagName === 'IMG' || node.tagName.startsWith('EQUATION');
        if (flat && node === before && !pendingEscape) fragment.append(beforeBody + tail);
        else if (flat) fragment.append(node.tagName === 'IMG' ? node.alt : node.textContent || '');
        else if (node === before && !pendingEscape) fragment.append(...beforeChildren, tail);
        else fragment.append(...node.childNodes);
        node.replaceWith(fragment);
      } else finalizeNode(data);
      default_end_token(data);
    }
  };
  return state;
}

function replaceUnavailableImage(image) {
  const replacement = document.createElement('span');
  replacement.className = 'image-unavailable';
  replacement.textContent = `〔图片未能显示${image.alt ? `：${image.alt}` : ''}〕`;
  image.replaceWith(replacement);
  return replacement;
}

function setSafeAttribute(data, type, value) {
  const node = data.nodes[data.index];
  if (!node) return;
  if (type === HREF) {
    const destination = parseMarkdownDestination(value);
    const url = sanitizeMarkdownUrl(destination.href, false);
    if (url) {
      node.setAttribute('href', url);
      if (destination.title) node.setAttribute('title', destination.title);
      else node.removeAttribute('title');
    } else {
      node.removeAttribute('href');
      node.classList.add('link-blocked');
      node.setAttribute('title', '已拦截不安全的链接');
    }
    return;
  }
  if (type === SRC) {
    const destination = parseMarkdownDestination(value);
    const url = sanitizeMarkdownUrl(destination.href, true);
    if (!url) { data.nodes[data.index] = replaceUnavailableImage(node); return; }
    node.setAttribute('src', url);
    if (destination.title) node.setAttribute('title', destination.title);
    else node.removeAttribute('title');
    return;
  }
  if (type === LANG) {
    const language = normalizeCodeLanguage(value);
    if (!language) return;
    node.dataset.language = language;
    const block = node.closest?.('.code-block');
    const label = block?.querySelector('.code-lang');
    if (label) label.textContent = language;
    return;
  }
  if (type === CHECKED) { node.checked = true; return; }
  if (type === START && /^\d+$/.test(String(value))) node.setAttribute('start', String(value));
}

function finalizeNode(data) {
  const node = data.nodes[data.index];
  if (!node) return;
  if (node.tagName === 'CODE' && node.parentElement?.tagName === 'PRE') finalizeCodeBlock(node);
  else if (node.tagName === 'TABLE') wrapTable(node);
  else if (node.tagName === 'EQUATION-BLOCK' || node.tagName === 'EQUATION-INLINE') {
    data.nodes[data.index] = renderMath(node, node.tagName === 'EQUATION-BLOCK');
  }
}

function finalizeCodeBlock(code) {
  ensureCodeShell(code);
  const source = code.textContent || '';
  code.textContent = source;
  const language = normalizeCodeLanguage(code.dataset.language);
  if (!language || source.length > MAX_HIGHLIGHT_CHARS) return;
  loadHighlighter().then((hljs) => {
    if (!code.isConnected || code.textContent !== source || !hljs.getLanguage(language)) return;
    code.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value;
    code.classList.add('hljs');
  }).catch(() => {
    // Highlighting is cosmetic; raw code stays visible and copyable.
  });
}

function ensureCodeShell(code) {
  const pre = code.parentElement;
  if (!pre || pre.parentElement?.classList.contains('code-block')) return;
  pre.tabIndex = 0;
  pre.setAttribute('role', 'region');
  pre.setAttribute('aria-label', '代码，可滚动');
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';
  const header = document.createElement('div');
  header.className = 'code-header';
  const label = document.createElement('span');
  label.className = 'code-lang';
  label.textContent = normalizeCodeLanguage(code.dataset.language) || 'code';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'code-copy-btn';
  copy.setAttribute('aria-label', '复制代码');
  copy.setAttribute('aria-live', 'polite');
  copy.textContent = '复制';
  copy.addEventListener('click', (event) => {
    event.stopPropagation();
    void copyWithFeedback(copy, pre.querySelector('code')?.textContent || '', '复制');
  });
  header.append(label, copy);
  pre.replaceWith(wrapper);
  wrapper.append(header, pre);
}

function wrapTable(table) {
  if (table.parentElement?.classList.contains('table-wrap')) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrap';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', '表格，可水平滚动');
  table.replaceWith(wrapper);
  wrapper.append(table);
}

function renderMath(node, displayMode) {
  const replacement = document.createElement(displayMode ? 'div' : 'span');
  replacement.className = displayMode ? 'math-block' : 'math-inline';
  const expression = String(node.textContent || '').trim();
  replacement.textContent = expression;
  if (displayMode) {
    replacement.tabIndex = 0;
    replacement.setAttribute('role', 'region');
    replacement.setAttribute('aria-label', '数学公式，可水平滚动');
  }
  node.replaceWith(replacement);
  loadKatex().then((katex) => {
    if (!replacement.isConnected) return;
    try {
      katex.render(expression, replacement, { displayMode, throwOnError: false, strict: false, trust: false });
    } catch {
      replacement.classList.add('math-error');
      replacement.textContent = expression;
    }
  }).catch(() => {
    replacement.classList.add('math-error');
  });
  return replacement;
}

export function sanitizeMarkdownUrl(value, image = false) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!image && raw.startsWith('#')) return raw;
  try {
    const url = new URL(raw, 'https://chatgpt.com');
    const allowed = url.protocol === 'https:' || url.protocol === 'http:' || (!image && url.protocol === 'mailto:');
    return allowed && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export function parseMarkdownDestination(value) {
  // streaming-markdown supplies the whole destination, including optional
  // <angle brackets> and a quoted title.
  const raw = String(value ?? '').trim();
  const match = raw.match(/^(?:<([^<>\r\n]+)>|(\S+?))(?:[ \t]+(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\(((?:\\.|[^)\\])*)\)))?$/);
  if (!match) return { href: '', title: '' };
  return { href: decodeMarkdownAttribute(match[1] ?? match[2]), title: decodeMarkdownAttribute(match[3] ?? match[4] ?? match[5]) };
}

function decodeMarkdownAttribute(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return String(value || '').replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (original, entity) => {
      if (entity[0] !== '#') return named[entity.toLowerCase()] || original;
      const hex = entity[1].toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
    });
}

export function normalizeCodeLanguage(value) {
  const language = String(value || '').trim().toLowerCase().replace(/^language-/, '').split(/\s+/, 1)[0];
  return /^[a-z0-9_+.#-]{1,32}$/.test(language) ? language : '';
}
