import hljs from 'highlight.js/lib/core';
import ini from 'highlight.js/lib/languages/ini';
import { stringify } from 'smol-toml';

hljs.registerLanguage('toml', ini);

export function formatToolPayloadAsToml(payload) {
  const parsed = parseJsonPayload(payload);
  const normalized = normalizeTomlValue(parsed);
  const root = isPlainObject(normalized)
    ? normalized
    : Array.isArray(normalized)
      ? { items: normalized }
      : { value: normalized };

  if (!Object.keys(root).length) return 'value = "<empty object>"\n';
  try {
    return ensureTrailingNewline(prettifyTomlStrings(stringify(root)));
  } catch {
    return ensureTrailingNewline(prettifyTomlStrings(stringify({ value: safeFallbackString(payload) })));
  }
}

export function highlightToml(toml) {
  return hljs.highlight(String(toml || ''), { language: 'toml', ignoreIllegals: true }).value;
}

export function parseJsonPayload(payload) {
  if (typeof payload !== 'string') return payload;
  let text = payload.trim();
  if (!text) return '';
  const fenced = text.match(/^```(?:json|jsonc|javascript|js)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  if (!looksLikeJsonContainer(text)) return payload;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string' && parsed !== text && looksLikeJsonContainer(parsed.trim())) {
      return parseJsonPayload(parsed);
    }
    return parsed;
  } catch {
    return payload;
  }
}

function normalizeTomlValue(value, seen = new WeakSet()) {
  if (value === null) return '<null>';
  if (value === undefined) return '<undefined>';
  if (typeof value === 'string') {
    const parsed = parseJsonPayload(value);
    return parsed !== value ? normalizeTomlValue(parsed, seen) : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (value instanceof Date) return value;
  if (seen.has(value)) return '<circular>';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => normalizeTomlValue(item, seen));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = normalizeTomlValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function looksLikeJsonContainer(value) {
  const text = String(value || '').trim();
  return (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date));
}

function ensureTrailingNewline(value) {
  const text = String(value || '').trimEnd();
  return `${text}\n`;
}

function prettifyTomlStrings(source) {
  const text = String(source || '');
  let result = '';
  let index = 0;

  while (index < text.length) {
    if (text[index] !== '"') {
      result += text[index];
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const char = text[index];
      if (!escaped && char === '"') {
        index += 1;
        break;
      }
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
      index += 1;
    }

    const literal = text.slice(start, index);
    let value;
    try {
      value = JSON.parse(literal);
    } catch {
      result += literal;
      continue;
    }

    const nextNonSpace = text.slice(index).match(/^\s*(.)/)?.[1] || '';
    const isQuotedKey = nextNonSpace === '=';
    if (!isQuotedKey && typeof value === 'string' && value.includes('\n')) {
      result += formatMultilineBasicString(value);
    } else {
      result += literal;
    }
  }

  return result;
}

function formatMultilineBasicString(value) {
  let body = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\u0008/g, '\\b')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/\r/g, '\\r')
    .replace(/"""/g, '\\"""');

  // TOML trims the first newline immediately after an opening multiline
  // delimiter. Keep a leading newline explicit so round-tripping preserves it.
  if (body.startsWith('\n')) body = `\\n${body.slice(1)}`;
  return `"""${body}"""`;
}

function safeFallbackString(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}
