import {
  CHECKED,
  HREF,
  LANG,
  SRC,
  START,
  default_add_text,
  default_add_token,
  default_end_token,
  default_renderer,
  parser,
  parser_end,
  parser_write,
} from 'streaming-markdown';

let katexPromise = null;

export function createIncrementalMarkdown(root) {
  let source = '';
  let finalizedLength = -1;
  let state = createParser(root);
  let preview = null;

  function reset() {
    root.replaceChildren();
    source = '';
    finalizedLength = -1;
    state = createParser(root);
    preview = null;
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
    preview = document.createTextNode(pending);
    parent.appendChild(preview);
  }

  function update(nextSource, { final = false } = {}) {
    const next = String(nextSource || '');
    if (!next.startsWith(source) || (finalizedLength >= 0 && next !== source)) reset();
    const suffix = next.slice(source.length);
    if (suffix) {
      removePreview();
      parser_write(state, suffix);
      source = next;
      finalizedLength = -1;
    }
    if (final && finalizedLength !== source.length) {
      removePreview();
      parser_end(state);
      finalizedLength = source.length;
    } else if (!final && suffix) {
      showPreview();
    }
  }

  return { update, reset };
}

function createParser(root) {
  const renderer = default_renderer(root);
  renderer.add_token = (data, type) => {
    default_add_token(data, type);
    const node = data.nodes[data.index];
    if (!node || node === root) return;
    if (node.tagName === 'A') {
      node.target = '_blank';
      node.rel = 'noreferrer noopener';
    } else if (node.tagName === 'IMG') {
      node.loading = 'lazy';
      node.referrerPolicy = 'no-referrer';
    } else if (node.tagName === 'INPUT' && node.type === 'checkbox') {
      node.classList.add('task-checkbox');
    }
  };
  renderer.add_text = default_add_text;
  renderer.set_attr = setSafeAttribute;
  renderer.end_token = (data) => {
    finalizeNode(data);
    default_end_token(data);
  };
  return parser(renderer);
}

function setSafeAttribute(data, type, value) {
  const node = data.nodes[data.index];
  if (!node) return;
  if (type === HREF) {
    const url = sanitizeMarkdownUrl(value, false);
    if (url) node.setAttribute('href', url);
    return;
  }
  if (type === SRC) {
    const url = sanitizeMarkdownUrl(value, true);
    if (url) node.setAttribute('src', url);
    else node.remove();
    return;
  }
  if (type === LANG) {
    const language = normalizeCodeLanguage(value);
    if (language) {
      node.dataset.language = language;
      node.classList.add(`language-${language}`);
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
  const pre = code.parentElement;
  if (!pre || pre.parentElement?.classList.contains('code-block')) return;
  const language = normalizeCodeLanguage(code.dataset.language || [...code.classList]
    .find((name) => name.startsWith('language-'))?.slice(9));
  const source = code.textContent || '';
  code.innerHTML = highlightCode(source, language);

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
  copy.textContent = '复制';
  header.append(label, copy);
  pre.replaceWith(wrapper);
  wrapper.append(header, pre);
}

function wrapTable(table) {
  if (table.parentElement?.classList.contains('table-wrap')) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'table-wrap';
  table.replaceWith(wrapper);
  wrapper.append(table);
}

function renderMath(node, displayMode) {
  const replacement = document.createElement(displayMode ? 'div' : 'span');
  replacement.className = displayMode ? 'math-block' : 'math-inline';
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
    return allowed ? url.href : '';
  } catch {
    return '';
  }
}

export function normalizeCodeLanguage(value) {
  const language = String(value || '').trim().toLowerCase().replace(/^language-/, '').split(/\s+/, 1)[0];
  return /^[a-z0-9_+.#-]{1,32}$/.test(language) ? language : '';
}

function highlightCode(source, language) {
  if (!/^(js|javascript|ts|typescript|json|jsonc|css|scss|html|xml|svg|bash|sh|zsh|shell|python|py|sql|rust|rs|go|golang|c|cpp|c\+\+|java|yaml|yml|dockerfile|toml|ini|md|markdown)$/.test(language)) {
    return escapeHtml(source);
  }
  if (/^(html|xml|svg)$/.test(language)) {
    return highlightMatches(source, /<\/?([a-zA-Z][\w-]*)/g, (match) => {
      const prefix = match[0].startsWith('</') ? '&lt;/' : '&lt;';
      return `${prefix}<span class="tok-key">${escapeHtml(match[1])}</span>`;
    });
  }
  const keywords = 'const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|true|false|null|undefined|def|in|and|or|not|elif|is|lambda|with|as|yield|pass|raise|except|None|True|False|package|func|struct|go|chan|defer|fn|mut|pub|impl|trait|match|enum|self|Self|int|char|float|double|void|bool|public|private|protected|static|final|SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|CREATE|TABLE|DROP|ALTER|INDEX';
  const pattern = new RegExp(`(["'\\x60])(?:\\\\.|(?!\\1)[\\s\\S])*\\1|\\b(?:${keywords})\\b|\\b\\d+(?:\\.\\d+)?\\b`, 'g');
  return highlightMatches(source, pattern, (match) => {
    const token = match[0];
    const className = /^["'`]/.test(token) ? 'tok-str' : /^\d/.test(token) ? 'tok-num' : 'tok-key';
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
