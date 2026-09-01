const cache = new Map();
const MAX_CACHE_ENTRIES = 512;

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

function splitBlocks(source) {
  if (!source) return [""];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let buffer = [];
  let inFence = false;

  const flush = () => {
    if (!buffer.length) return;
    blocks.push(buffer.join("\n"));
    buffer = [];
  };

  for (const line of lines) {
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
    if (!line.trim()) {
      flush();
      continue;
    }
    if (buffer.length && isStandaloneBlockStart(line)) flush();
    buffer.push(line);
    if (isStandaloneSingleLine(line)) flush();
  }
  flush();
  return blocks.length ? blocks : [""];
}

function isStandaloneBlockStart(line) {
  return /^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s)/.test(line);
}

function isStandaloneSingleLine(line) {
  return /^#{1,6}\s/.test(line) || /^---+$/.test(line.trim());
}

function renderBlock(block) {
  if (!block) return "";
  if (block.startsWith("```")) return renderFence(block);
  const lines = block.split("\n");
  const heading = lines[0].match(/^(#{1,6})\s+(.*)$/);
  if (heading && lines.length === 1) {
    const level = heading[1].length;
    return `<h${level}>${inline(heading[2])}</h${level}>`;
  }
  if (lines.every((line) => /^>\s?/.test(line))) {
    return `<blockquote>${lines.map((line) => inline(line.replace(/^>\s?/, ""))).join("<br>")}</blockquote>`;
  }
  if (lines.every((line) => /^[-*+]\s+/.test(line))) {
    return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^[-*+]\s+/, ""))}</li>`).join("")}</ul>`;
  }
  if (lines.every((line) => /^\d+\.\s+/.test(line))) {
    return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
  }
  if (lines.length === 1 && /^---+$/.test(lines[0].trim())) return "<hr>";
  return `<p>${lines.map(inline).join("<br>")}</p>`;
}

function renderFence(block) {
  const lines = block.split("\n");
  const opening = lines.shift() || "```";
  const language = opening.slice(3).trim().toLowerCase();
  if (lines[lines.length - 1]?.startsWith("```")) lines.pop();
  const code = lines.join("\n");
  return `<pre data-language="${escapeAttr(language)}"><code>${highlight(code, language)}</code></pre>`;
}

function inline(source) {
  let text = escapeHtml(source);
  const tokens = [];
  const stash = (html) => {
    const token = `\u0000TOKEN${tokens.length}\u0000`;
    tokens.push(html);
    return token;
  };
  text = text.replace(/`([^`]+)`/g, (_, value) => {
    return stash(`<code>${escapeHtml(unescapeEntities(value))}</code>`);
  });
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    return stash(`<a href="${escapeAttr(unescapeEntities(url))}" target="_blank" rel="noreferrer noopener">${label}</a>`);
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  text = text.replace(/\u0000TOKEN(\d+)\u0000/g, (_, index) => tokens[Number(index)] || "");
  return text;
}

function highlight(source, language) {
  if (!/^(js|javascript|ts|typescript|json|css|html|xml|bash|sh|shell|python|py)$/.test(language)) {
    return escapeHtml(source);
  }
  if (/^(html|xml)$/.test(language)) {
    return highlightMatches(source, /<\/?([a-zA-Z][\w-]*)/g, (match) => {
      const prefix = match[0].startsWith("</") ? "&lt;/" : "&lt;";
      return `${prefix}<span class="tok-key">${escapeHtml(match[1])}</span>`;
    });
  }
  const keywords = "const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|true|false|null|undefined|def|in|and|or|not";
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
