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

export function extractToolDuration(tool, message = null) {
  const rawDuration = tool?.duration ?? tool?.durationSec ?? tool?.duration_sec ??
    tool?.finished_duration_sec ?? tool?.timing?.duration ??
    message?.duration ?? message?.durationSec ?? message?.duration_sec ??
    message?.finished_duration_sec ?? message?.metadata?.duration;

  if (typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0) {
    return rawDuration < 1 ? `${Math.round(rawDuration * 1000)}ms` : `${rawDuration.toFixed(1).replace(/\.0$/, '')}s`;
  }
  if (typeof rawDuration === 'string' && rawDuration.trim()) {
    const num = Number(rawDuration);
    if (Number.isFinite(num) && num > 0) {
      return num < 1 ? `${Math.round(num * 1000)}ms` : `${num.toFixed(1).replace(/\.0$/, '')}s`;
    }
    return rawDuration.trim();
  }

  // Compute from start/end timestamps if present
  const start = tool?.startTime ?? tool?.start_time ?? tool?.created_at ?? tool?.createTime ?? message?.startTime ?? message?.start_time;
  const end = tool?.endTime ?? tool?.end_time ?? tool?.finished_at ?? tool?.finishTime ?? message?.endTime ?? message?.end_time;
  if (start != null && end != null) {
    const s = typeof start === 'number' ? (start < 10_000_000_000 ? start * 1000 : start) : Date.parse(start);
    const e = typeof end === 'number' ? (end < 10_000_000_000 ? end * 1000 : end) : Date.parse(end);
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
      const diffSec = (e - s) / 1000;
      return diffSec < 1 ? `${Math.round(e - s)}ms` : `${diffSec.toFixed(1).replace(/\.0$/, '')}s`;
    }
  }

  return '';
}

export function getGlobalToolFoldPref() {
  try {
    const val = localStorage.getItem('slimgpt-tools-fold');
    return val === 'true' || val === '1' || val === 'collapsed' || val === 'fold';
  } catch {
    return false;
  }
}

export function setGlobalToolFoldPref(fold) {
  try {
    localStorage.setItem('slimgpt-tools-fold', fold ? 'true' : 'false');
  } catch {}
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
    const scalar = findFirstMeaningfulScalar(target);
    if (scalar) return scalar;
  } else if (typeof target === 'string' && target.trim()) {
    return target.slice(0, 60).replace(/\s+/g, ' ').trim();
  } else if (typeof target === 'number' && Number.isFinite(target)) {
    return String(target);
  }
  const callId = tool?.callId || tool?.toolCallId || (tool?.callIds && tool.callIds[0]) || '';
  if (typeof callId === 'string' && callId.trim()) {
    return formatShortCallId(callId.trim());
  }
  return '';
}

function formatShortCallId(id) {
  if (!id) return '';
  if (id.length <= 8) return id;
  return `…${id.slice(-6)}`;
}

export function extractToolPairingState(tool, message = null) {
  const state = tool?.pairingState ?? tool?.resultState ?? tool?.pairing ?? tool?.pairingStatus ??
    message?.pairingState ?? message?.resultState ?? message?.pairing ?? message?.pairingStatus;
  if (typeof state === 'string' && state.trim()) {
    const s = state.trim().toLowerCase();
    if (s === 'paired' || s === '已配对') return '已配对';
    if (s === 'waiting' || s === 'pending' || s === 'waiting_result' || s === '等待结果') return '等待结果';
    if (s === 'none' || s === 'no_result' || s === 'unpaired' || s === '无结果') return '无结果';
    return state.trim();
  }
  const paired = tool?.paired ?? message?.paired;
  if (typeof paired === 'boolean') {
    return paired ? '已配对' : '无结果';
  }
  const hasResult = tool?.hasResult ?? tool?.has_result ?? message?.hasResult ?? message?.has_result;
  if (typeof hasResult === 'boolean') {
    return hasResult ? '已配对' : '等待结果';
  }
  return '';
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
  return findFirstMeaningfulScalar(obj);
}

function findFirstMeaningfulScalar(val, depth = 0) {
  if (depth > 6 || val == null) return '';
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed && !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(trimmed) && !/^(true|false|null|undefined)$/i.test(trimmed)) {
      return trimmed.length > 60 ? trimmed.slice(0, 60).replace(/\s+/g, ' ').trim() + '…' : trimmed.replace(/\s+/g, ' ').trim();
    }
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    return String(val);
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      const res = findFirstMeaningfulScalar(item, depth + 1);
      if (res) return res;
    }
  } else if (typeof val === 'object') {
    for (const [k, v] of Object.entries(val)) {
      if (['id', 'call_id', 'callId', 'tool_call_id', 'type', 'name'].includes(k)) continue;
      const res = findFirstMeaningfulScalar(v, depth + 1);
      if (res) return `${k}: ${res}`;
    }
  }
  return '';
}

function formatKeyValue(key, val) {
  if (typeof val === 'string' && val.trim()) return `${key}: ${val.trim()}`;
  if (Array.isArray(val) && val.length > 0) return `${key}: ${val.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join(', ')}`;
  if (typeof val === 'number' || typeof val === 'boolean') return `${key}: ${String(val)}`;
  return '';
}
