import {
  CHECKED,
  TABLE,
  HREF,
  LANG,
  SRC,
  START,
  CODE_FENCE, CODE_BLOCK, CODE_INLINE, EQUATION_BLOCK, EQUATION_INLINE,
  ITALIC_AST, ITALIC_UND, STRONG_AST, STRONG_UND, STRIKE, LINK, IMAGE,
  default_add_text,
  default_add_token,
  default_end_token,
  default_renderer,
  parser,
  parser_end,
  parser_write,
} from 'streaming-markdown';

let katexPromise = null;
const literalPrefixes = new Map([
  [ITALIC_AST, '*'], [ITALIC_UND, '_'], [STRONG_AST, '**'], [STRONG_UND, '__'],
  [STRIKE, '~~'], [LINK, '['], [IMAGE, '!['],
]);

export function createIncrementalMarkdown(root) {
  let source = '';
  let finalizedLength = -1;
  let state = createParser(root);
  let preview = null;
  let lastWasCR = false;

  function reset() {
    root.replaceChildren();
    source = '';
    finalizedLength = -1;
    state = createParser(root);
    preview = null;
    lastWasCR = false;
  }

  function removePreview() {
    preview?.remove();
    preview = null;
  }

  function showPreview() {
    const pending = String(state.pending || '');
    if (!pending) return;
    const data = state.renderer.data;
    const parent = data.nodes[data.index] || root;
    if (parent.tagName === 'IMG') return;
    preview = document.createTextNode(pending);
    parent.appendChild(preview);
  }

  function update(nextSource, { final = false } = {}) {
    const next = String(nextSource || '');
    if (!next.startsWith(source) || (finalizedLength >= 0 && next !== source)) reset();
    const suffix = next.slice(source.length);
    if (suffix) {
      removePreview();
      // A CRLF split across updates is still one newline; normalize before
      // the parser so code copying does not depend on transport boundaries.
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

function createParser(root) {
  const renderer = default_renderer(root);
  const tokens = new WeakMap();
  let state;
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
      node.referrerPolicy = 'no-referrer';
      node.alt = '';
      node.addEventListener('error', () => replaceUnavailableImage(node), { once: true });
    } else if (node.tagName === 'INPUT' && node.type === 'checkbox') {
      node.classList.add('task-checkbox');
    }
  };
  renderer.add_text = (data, text) => {
    const node = data.nodes[data.index];
    if (node?.tagName === 'IMG') node.alt += text;
    else {
      default_add_text(data, text);
      if (node?.tagName === 'A' && /^来源 \d+$/.test(node.textContent?.trim() || '')) {
        node.classList.add('citation-badge');
        if (!node.getAttribute('title') && node.getAttribute('href')) {
          try {
            const u = new URL(node.getAttribute('href'));
            node.setAttribute('title', u.hostname);
          } catch {}
        } else if (node.getAttribute('title') && node.getAttribute('href')) {
          try {
            const u = new URL(node.getAttribute('href'));
            if (!node.getAttribute('title').includes(`(${u.hostname})`)) {
              node.setAttribute('title', `${node.getAttribute('title')} (${u.hostname})`);
            }
          } catch {}
        }
      }
    }
  };

  renderer.set_attr = setSafeAttribute;
  renderer.end_token = (data) => {
    const node = data.nodes[data.index];
    if (tokens.get(node)?.type === CODE_FENCE && state.pending.startsWith('\n')) {
      // The parser withholds the newline before a closing fence. That newline
      // belongs to the code payload and must survive display/copy.
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
    const tail = state.text + state.pending;
    const beforeBody = before?.tagName === 'IMG' ? before.alt : before?.textContent || '';
    const incompleteBody = beforeBody + tail;
    const pendingEscape = state.pending === '\\' && ![CODE_FENCE, CODE_BLOCK, CODE_INLINE, EQUATION_INLINE, EQUATION_BLOCK].includes(beforeInfo?.type);
    if (pendingEscape) {
      renderer.add_text(data, tail);
      state.text = state.pending = '';
    } else parser_end(state);
    while (data.index > 0) {
      const node = data.nodes[data.index];
      const info = tokens.get(node);
      if (info?.type === CODE_FENCE || info?.type === CODE_BLOCK) {
        if (node === before) node.textContent = incompleteBody;
        finalizeCodeBlock(node);
      } else if (info?.prefix) {
        // At EOF an unclosed span is literal, not valid emphasis/link/math.
        // In particular do not drop a final backtick or incomplete equation.
        const body = node === before ? incompleteBody : node.tagName === 'IMG' ? node.alt : node.textContent || '';
        node.replaceWith(document.createTextNode(info.prefix + body));
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
      node.classList.remove('link-sanitized');
      node.removeAttribute('tabindex');
    } else {
      node.removeAttribute('href');
      node.classList.add('link-sanitized');
      node.tabIndex = 0;
      node.setAttribute('title', '已拦截不安全或不受支持的链接协议 [已拦截]');
      if (!node.querySelector('.link-sanitized-badge')) {
        const badge = document.createElement('span');
        badge.className = 'link-sanitized-badge';
        badge.textContent = ' [已拦截]';
        badge.setAttribute('aria-hidden', 'true');
        node.appendChild(badge);
      }
    }
    if (url && destination.title) node.setAttribute('title', destination.title);
    else if (url) node.removeAttribute('title');
    return;
  }
  if (type === SRC) {
    const destination = parseMarkdownDestination(value);
    const url = sanitizeMarkdownUrl(destination.href, true);
    if (url) node.setAttribute('src', url);
    else data.nodes[data.index] = replaceUnavailableImage(node);
    if (url && destination.title) node.setAttribute('title', destination.title);
    else node.removeAttribute('title');
    return;
  }
  if (type === LANG) {
    const language = normalizeCodeLanguage(value);
    if (language) {
      node.dataset.language = language;
      node.classList.add(`language-${language}`);
      const block = node.closest?.('.code-block');
      if (block) {
        block.dataset.language = language;
        const langLabel = block.querySelector('.code-lang');
        if (langLabel) langLabel.textContent = language;
      }
    }
    return;
  }
  if (type === CHECKED) {
    node.checked = true;
    return;
  }
  if (type === START && /^\d+$/.test(String(value))) node.setAttribute('start', String(value));
}

function finalizeNode(data) {
  const node = data.nodes[data.index];
  if (!node) return;
  if (node.tagName === 'CODE' && node.parentElement?.tagName === 'PRE') {
    finalizeCodeBlock(node);
  } else if (node.tagName === 'TABLE') {
    wrapTable(node);
  } else if (node.tagName === 'EQUATION-BLOCK' || node.tagName === 'EQUATION-INLINE') {
    data.nodes[data.index] = renderMath(node, node.tagName === 'EQUATION-BLOCK');
  }
}

function finalizeCodeBlock(code) {
  ensureCodeShell(code);
  const wrapper = code.closest('.code-block');
  const pre = code.parentElement;
  pre.tabIndex = 0;
  pre.setAttribute('role', 'region');
  pre.setAttribute('aria-label', '代码，可滚动');
  const language = normalizeCodeLanguage(code.dataset.language || [...code.classList]
    .find((name) => name.startsWith('language-'))?.slice(9));
  const source = code.textContent || '';
  code.innerHTML = highlightCode(source, language);
}

function ensureCodeShell(code) {
  const pre = code.parentElement;
  if (!pre || pre.parentElement?.classList.contains('code-block')) return;
  pre.tabIndex = 0;
  pre.setAttribute('role', 'region');
  pre.setAttribute('aria-label', '代码，可滚动');
  const language = normalizeCodeLanguage(code.dataset.language || [...code.classList]
    .find((name) => name.startsWith('language-'))?.slice(9));

  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';
  wrapper.dataset.language = language || 'code';
  const header = document.createElement('div');
  header.className = 'code-header';
  const label = document.createElement('span');
  label.className = 'code-lang';
  label.textContent = language || 'code';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'code-copy-btn';
  copy.dataset.action = 'copy-code';
  copy.setAttribute('aria-label', '复制代码');
  copy.setAttribute('aria-live', 'polite');
  copy.textContent = '复制';
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
  if (displayMode) {
    replacement.tabIndex = 0;
    replacement.setAttribute('role', 'region');
    replacement.setAttribute('aria-label', '数学公式，可水平滚动');
  }
  const expression = String(node.textContent || '').trim();
  replacement.textContent = expression;
  node.replaceWith(replacement);
  void loadKatex().then((katex) => {
    if (!replacement.isConnected) return;
    try {
      katex.render(expression, replacement, {
        displayMode,
        throwOnError: false,
        strict: false,
        trust: false,
      });
    } catch {
      replacement.classList.add('math-error');
      replacement.textContent = expression;
    }
  }).catch(() => replacement.classList.add('math-error'));
  return replacement;
}

function loadKatex() {
  katexPromise ||= import('katex').then((module) => module.default || module);
  return katexPromise;
}

export function sanitizeMarkdownUrl(value, image = false) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!image && raw.startsWith('#')) return raw;
  try {
    const url = new URL(raw, 'https://chatgpt.com');
    const allowed = image
      ? url.protocol === 'https:' || url.protocol === 'http:'
      : url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
    return allowed && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

export function parseMarkdownDestination(value) {
  // streaming-markdown supplies the whole destination to HREF, including
  // optional <angle brackets> and a quoted title. Passing that straight to
  // URL() resolves it as a bogus relative chatgpt.com path.
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

function highlightCode(source, language) {
  if (source.length > 200_000) return escapeHtml(source);
  if (!/^(js|javascript|ts|typescript|json|jsonc|css|scss|html|xml|svg|bash|sh|zsh|shell|python|py|sql|rust|rs|go|golang|c|cpp|c\+\+|java|yaml|yml|dockerfile|toml|ini|md|markdown)$/.test(language)) {
    return escapeHtml(source);
  }
  if (/^(html|xml|svg)$/.test(language)) {
    return highlightMatches(source, /(<!--[\s\S]*?-->)|<\/?([a-zA-Z][\w-]*)/g, (match) => {
      if (match[1]) {
        return `<span class="tok-comment">${escapeHtml(match[1])}</span>`;
      }
      const prefix = match[0].startsWith('</') ? '&lt;/' : '&lt;';
      return `${prefix}<span class="tok-key">${escapeHtml(match[2])}</span>`;
    });
  }
  const keywords = 'const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|true|false|null|undefined|def|in|and|or|not|elif|is|lambda|with|as|yield|pass|raise|except|None|True|False|package|func|struct|go|chan|defer|fn|mut|pub|impl|trait|match|enum|self|Self|int|char|float|double|void|bool|public|private|protected|static|final|SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|CREATE|TABLE|DROP|ALTER|INDEX';
  const pattern = new RegExp(`(//[^\\n]*|/\\*[\\s\\S]*?\\*/|#[^\\n]*)|(["'\\x60])(?:\\\\[\\s\\S]|(?!\\2)[^\\\\])*\\2|\\b(?:${keywords})\\b|\\b\\d+(?:\\.\\d+)?\\b`, 'g');
  return highlightMatches(source, pattern, (match) => {
    const token = match[0];
    const className = match[1] ? 'tok-comment' : match[2] ? 'tok-str' : /^\d/.test(token) ? 'tok-num' : 'tok-key';
    return `<span class="${className}">${escapeHtml(token)}</span>`;
  });
}

function highlightMatches(source, pattern, render) {
  let html = '';
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    html += escapeHtml(source.slice(cursor, match.index));
    html += render(match);
    cursor = match.index + match[0].length;
  }
  return html + escapeHtml(source.slice(cursor));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
