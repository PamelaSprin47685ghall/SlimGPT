import { formatRawToolPayload } from './tool-payload.js';

export function createToolFormatterLoader(importer = () => import('./tool-format.js')) {
  let pending = null;
  return () => {
    if (!pending) pending = Promise.resolve().then(importer).catch((error) => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

export const loadToolFormatter = createToolFormatterLoader();

export function presentToolPayload(payload, { formatter = null, raw = false } = {}) {
  if (formatter && !raw) {
    try {
      const text = formatter.formatToolPayloadAsToml(payload);
      return { format: 'TOML', text, html: formatter.highlightToml(text), failed: false };
    } catch {
      // Formatting is optional presentation. Failure must never take down a
      // conversation or replace its payload with an empty/error-only bubble.
      return { format: 'RAW', text: formatRawToolPayload(payload), html: '', failed: true };
    }
  }
  return { format: 'RAW', text: formatRawToolPayload(payload), html: '', failed: false };
}

export function extractToolCallIds(tool, message = null) {
  const ids = [
    tool?.callId,
    tool?.toolCallId,
    ...(tool?.callIds || []),
    message?.callId,
    message?.toolCallId,
    ...(message?.callIds || []),
  ].filter((id) => typeof id === 'string' && id.trim());
  return [...new Set(ids)];
}

export function extractToolKeyArg(payload, tool = null) {
  if (!payload && !tool) return '';
  let target = payload;
  if (typeof target === 'string') {
    try { target = JSON.parse(target); } catch {}
  }
  if (target && typeof target === 'object') {
    if (target.function?.arguments) {
      let args = target.function.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch {}
      }
      if (typeof args === 'object' && args !== null) {
        const res = extractKeyFromObject(args);
        if (res) return res;
      } else if (typeof args === 'string' && args.trim()) {
        return args.slice(0, 60).replace(/\s+/g, ' ').trim();
      }
    }
    if (Array.isArray(target.calls) && target.calls.length > 0) {
      const first = target.calls[0];
      if (first?.function?.arguments) {
        let args = first.function.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch {}
        }
        if (typeof args === 'object' && args !== null) {
          const res = extractKeyFromObject(args);
          if (res) return res;
        } else if (typeof args === 'string' && args.trim()) {
          return args.slice(0, 60).replace(/\s+/g, ' ').trim();
        }
      }
    }
    const objRes = extractKeyFromObject(target);
    if (objRes) return objRes;
  } else if (typeof target === 'string' && target.trim()) {
    return target.slice(0, 60).replace(/\s+/g, ' ').trim();
  }
  const callId = tool?.callId || tool?.toolCallId || (tool?.callIds && tool.callIds[0]) || '';
  if (typeof callId === 'string' && callId.trim()) {
    return formatShortCallId(callId.trim());
  }
  return '';
}

function formatShortCallId(id) {
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function extractKeyFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const priorityKeys = ['query', 'q', 'url', 'search_query', 'command', 'action', 'prompt', 'code'];
  for (const key of priorityKeys) {
    if (obj[key] !== undefined) {
      const formatted = formatKeyValue(key, obj[key]);
      if (formatted) return formatted;
    }
  }
  for (const [key, val] of Object.entries(obj)) {
    if (['id', 'call_id', 'callId', 'type', 'name'].includes(key)) continue;
    const formatted = formatKeyValue(key, val);
    if (formatted) return formatted;
  }
  return '';
}

function formatKeyValue(key, val) {
  if (typeof val === 'string' && val.trim()) return `${key}: ${val.trim()}`;
  if (Array.isArray(val) && val.length > 0) return `${key}: ${val.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join(', ')}`;
  if (typeof val === 'number' || typeof val === 'boolean') return `${key}: ${String(val)}`;
  return '';
}
