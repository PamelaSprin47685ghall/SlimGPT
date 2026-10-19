// `/backend-api/conversations` list parsing.

import { isObject, safeJsonParse } from './util.js';

function toSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value / 1000 : value;
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  return null;
}

/**
 * @param {string|object} body
 * @returns {{ id: string, title: string, updatedAt: number|null }[] | null}
 */
export function parseConversationList(body) {
  try {
    const value = typeof body === 'string' ? safeJsonParse(body, null) : body;
    if (!isObject(value) || !Array.isArray(value.items)) return null;
    const seen = new Set();
    const list = [];
    for (const item of value.items) {
      if (!isObject(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      list.push({
        id: item.id,
        title: typeof item.title === 'string' ? item.title : '',
        updatedAt: toSeconds(item.update_time) ?? toSeconds(item.create_time),
      });
    }
    return list;
  } catch {
    return null;
  }
}
