import katex from 'katex';

const cache = new Map();
const MAX_CACHE_ENTRIES = 512;

if (typeof self !== 'undefined') {
  self.onmessage = (event) => {
    const { requestId, cacheKey, text } = event.data || {};
    if (!requestId || !cacheKey) return;
    const source = String(text || "");
    const blocks = splitBlocks(source);
    const previous = cache.get(cacheKey);
    const htmlBlocks = [];

    let common = 0;
    if (previous) {
      while (
        common < blocks.length &&
        common < previous.blocks.length &&
        blocks[common] === previous.blocks[common]
      ) {
        htmlBlocks.push(previous.htmlBlocks[common]);
        common += 1;
      }
    }

    for (let index = common; index < blocks.length; index += 1) {
      htmlBlocks.push(renderBlock(blocks[index]));
    }

    cache.delete(cacheKey);
    cache.set(cacheKey, { blocks, htmlBlocks });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    self.postMessage({ requestId, cacheKey, html: htmlBlocks.join(""), sourceLength: source.length });
  };
}

export function splitBlocks(source) {
  if (!source) return [""];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let buffer = [];
  let inFence = false;
  let inMath = false;
  let inTable = false;

  const flush = () => {
    if (!buffer.length) return;
    blocks.push(buffer.join("\n"));
    buffer = [];
    inTable = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Code fence
    if (line.startsWith("```")) {
      if (!inFence) flush();
      inFence = !inFence;
      buffer.push(line);
      if (!inFence) flush();
      continue;
    }
    if (inFence) {
      buffer.push(line);
      continue;
    }

    // Display math $$ ... $$
    const trimmed = line.trim();
    if (trimmed.startsWith("$$")) {
      if (!inMath) {
        flush();
        // Check if single line $$...$$
        if (trimmed.length > 2 && trimmed.endsWith("$$")) {
          blocks.push(line);
          continue;
        }
        inMath = true;
        buffer.push(line);
      } else {
        buffer.push(line);
        inMath = false;
        flush();
      }
      continue;
    }
    if (inMath) {
      buffer.push(line);
      if (trimmed.endsWith("$$")) {
        inMath = false;
        flush();
      }
      continue;
    }

    if (!trimmed) {
      flush();
      continue;
    }

    const tableLine = isTableLine(line);
    if (tableLine) {
      if (!inTable && buffer.length) flush();
      inTable = true;
      buffer.push(line);
      continue;
    } else if (inTable) {
      flush();
    }

    if (buffer.length && isStandaloneBlockStart(line)) flush();
    buffer.push(line);
    if (isStandaloneSingleLine(line)) flush();
  }
  flush();
  return blocks.length ? blocks : [""];
}

function isTableLine(line) {
  const trimmed = line.trim();
  return (trimmed.startsWith("|") && trimmed.endsWith("|")) ||
    (trimmed.includes("|") && isTableDelimiter(trimmed));
}

function isStandaloneBlockStart(line) {
  return /^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|\||\$\$)/.test(line);
}

function isStandaloneSingleLine(line) {
  return /^#{1,6}\s/.test(line) || /^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim()) || /^___+$/.test(line.trim());
}

export function renderBlock(block) {
  if (!block) return "";
  const trimmed = block.trim();
  if (block.startsWith("```")) return renderFence(block);
  if (trimmed.startsWith("$$") && trimmed.endsWith("$$") && trimmed.length >= 4) {
    return renderMathBlock(trimmed);
  }
  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
    return renderMathBlock(trimmed);
  }
  
  const lines = block.split("\n");
  
  // Table check
  if (lines.length >= 2 && lines.some((l) => isTableDelimiter(l))) {
    return renderTable(block);
  }

  // Heading check
  const heading = lines[0].match(/^(#{1,6})\s+(.*?)(?:\s+#+)?$/);
  if (heading && lines.length === 1) {
    const level = heading[1].length;
    return `<h${level}>${inline(heading[2])}</h${level}>`;
  }

  // Blockquote check
  if (lines.every((line) => /^>\s?/.test(line))) {
    return `<blockquote>${lines.map((line) => inline(line.replace(/^>\s?/, ""))).join("<br>")}</blockquote>`;
  }

  // Unordered list
  if (lines.every((line) => /^[-*+]\s+/.test(line))) {
    return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^[-*+]\s+/, ""))}` ).join("</li>")}</li></ul>`;
  }

  // Ordered list
  if (lines.every((line) => /^\d+\.\s+/.test(line))) {
    return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\d+\.\s+/, ""))}` ).join("</li>")}</ol>`;
  }

  // Horizontal rule
  if (lines.length === 1 && (/^---+$/.test(lines[0].trim()) || /^\*\*\*+$/.test(lines[0].trim()) || /^___+$/.test(lines[0].trim()))) {
    return "<hr>";
  }

  return `<p>${lines.map(inline).join("<br>")}</p>`;
}

function renderMathBlock(block) {
  let expr = block.trim();
  if (expr.startsWith("$$") && expr.endsWith("$$")) {
    expr = expr.slice(2, -2).trim();
  } else if (expr.startsWith("\\[") && expr.endsWith("\\]")) {
    expr = expr.slice(2, -2).trim();
  }
  try {
    const rendered = katex.renderToString(expr, {
      displayMode: true,
      throwOnError: false,
    });
    return `<div class="math-block">${rendered}</div>`;
  } catch {
    return `<div class="math-block math-error"><pre><code>${escapeHtml(expr)}</code></pre></div>`;
  }
}

function isTableDelimiter(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
  const cells = splitTableRow(trimmed);
  return cells.length >= 1 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function splitTableRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  const cells = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (char === "`") {
      inCode = !inCode;
      current += char;
    } else if (char === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function renderTable(block) {
  const lines = block.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return `<p>${lines.map(inline).join("<br>")}</p>`;

  let delimiterIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isTableDelimiter(lines[i])) {
      delimiterIndex = i;
      break;
    }
  }

  if (delimiterIndex <= 0) return `<p>${lines.map(inline).join("<br>")}</p>`;

  const headerLines = lines.slice(0, delimiterIndex);
  const delimiterCells = splitTableRow(lines[delimiterIndex]);
  const bodyLines = lines.slice(delimiterIndex + 1);

  const alignments = delimiterCells.map((d) => {
    const t = d.trim();
    const left = t.startsWith(":");
    const right = t.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return "";
  });

  const alignAttr = (index) => {
    const a = alignments[index] || alignments[alignments.length - 1] || "";
    return a ? ` style="text-align:${a}"` : "";
  };

  let html = `<div class="table-wrap"><table><thead>`;
  for (const hLine of headerLines) {
    const cells = splitTableRow(hLine);
    html += `<tr>`;
    for (let i = 0; i < delimiterCells.length; i += 1) {
      html += `<th${alignAttr(i)}>${inline(cells[i] || "")}</th>`;
    }
    html += `</tr>`;
  }
  html += `</thead>`;

  if (bodyLines.length) {
    html += `<tbody>`;
    for (const bLine of bodyLines) {
      const cells = splitTableRow(bLine);
      html += `<tr>`;
      for (let i = 0; i < delimiterCells.length; i += 1) {
        html += `<td${alignAttr(i)}>${inline(cells[i] || "")}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody>`;
  }

  html += `</table></div>`;
  return html;
}

function renderFence(block) {
  const lines = block.split("\n");
  const opening = lines.shift() || "```";
  const language = opening.slice(3).trim().toLowerCase();
  if (lines[lines.length - 1]?.startsWith("```")) lines.pop();
  const code = lines.join("\n");
  const displayLang = language || "code";
  return `<div class="code-block" data-language="${escapeAttr(displayLang)}"><div class="code-header"><span class="code-lang">${escapeHtml(displayLang)}</span><button type="button" class="code-copy-btn" data-action="copy-code" aria-label="复制代码">复制</button></div><pre data-language="${escapeAttr(language)}"><code>${highlight(code, language)}</code></pre></div>`;
}

export function inline(source) {
  let text = escapeHtml(source);
  const tokens = [];
  const stash = (html) => {
    const token = `\u0000TOKEN${tokens.length}\u0000`;
    tokens.push(html);
    return token;
  };

  // Inline code
  text = text.replace(/`([^`]+)`/g, (_, value) => {
    return stash(`<code>${escapeHtml(unescapeEntities(value))}</code>`);
  });

  // Task list checkboxes
  text = text.replace(/^\[ \]\s*/, () => stash(`<input type="checkbox" disabled class="task-checkbox" /> `));
  text = text.replace(/^\[[xX]\]\s*/, () => stash(`<input type="checkbox" disabled checked class="task-checkbox" /> `));

  // LaTeX inline math \( ... \)
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
    const expr = unescapeEntities(math).trim();
    try {
      const rendered = katex.renderToString(expr, {
        displayMode: false,
        throwOnError: false,
      });
      return stash(rendered);
    } catch {
      return stash(`<span class="math-inline math-error">${escapeHtml(expr)}</span>`);
    }
  });

  // Inline math $...$
  text = text.replace(/(^|[^\$])\$([^\$\n]+?)\$(?!\$)/g, (match, prefix, math) => {
    const expr = unescapeEntities(math).trim();
    if (!expr) return match;
    try {
      const rendered = katex.renderToString(expr, {
        displayMode: false,
        throwOnError: false,
      });
      return `${prefix}${stash(rendered)}`;
    } catch {
      return `${prefix}${stash(`<span class="math-inline math-error">${escapeHtml(expr)}</span>`)}`;
    }
  });

  // Links
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    return stash(`<a href="${escapeAttr(unescapeEntities(url))}" target="_blank" rel="noreferrer noopener">${label}</a>`);
  });

  // Formatting
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(/\u0000TOKEN(\d+)\u0000/g, (_, index) => tokens[Number(index)] || "");
  return text;
}

function highlight(source, language) {
  const lang = (language || "").toLowerCase();
  if (!/^(js|javascript|ts|typescript|json|jsonc|css|scss|html|xml|svg|bash|sh|zsh|shell|python|py|sql|rust|rs|go|golang|c|cpp|c\+\+|java|yaml|yml|dockerfile|toml|ini|md|markdown)$/.test(lang)) {
    return escapeHtml(source);
  }
  if (/^(html|xml|svg)$/.test(lang)) {
    return highlightMatches(source, /<\/?([a-zA-Z][\w-]*)/g, (match) => {
      const prefix = match[0].startsWith("</") ? "&lt;/" : "&lt;";
      return `${prefix}<span class="tok-key">${escapeHtml(match[1])}</span>`;
    });
  }
  const keywords = "const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|true|false|null|undefined|def|in|and|or|not|elif|is|lambda|with|as|yield|pass|raise|except|None|True|False|package|func|struct|go|chan|defer|fn|mut|pub|impl|trait|match|enum|self|Self|int|char|float|double|void|bool|public|private|protected|static|final|SELECT|FROM|WHERE|INSERT|INTO|UPDATE|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|CREATE|TABLE|DROP|ALTER|INDEX";
  const pattern = new RegExp(`(["'\\x60])(?:\\\\.|(?!\\1)[\\s\\S])*\\1|\\b(?:${keywords})\\b|\\b\\d+(?:\\.\\d+)?\\b`, "g");
  return highlightMatches(source, pattern, (match) => {
    const token = match[0];
    const className = /^["'`]/.test(token) ? "tok-str" : /^\d/.test(token) ? "tok-num" : "tok-key";
    return `<span class="${className}">${escapeHtml(token)}</span>`;
  });
}

function highlightMatches(source, pattern, render) {
  let html = "";
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
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function unescapeEntities(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}