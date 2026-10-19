// Local (device-only) records of logged-out conversations. The free mode has
// no server history, so the UI keeps a compact copy of what it saw: plain
// text of user/assistant messages plus the parent chain. Records rebuild into
// a Conversation through the canonical parser, so they render exactly like
// server history. Pure and total.

import { isObject } from './util.js';
import { sourceId, sourceRawMessage } from './conversation-source.js';
import { parseConversation } from './conversation.js';


// Source text of a block for the local (device) store; documents go back to
// their directive form so re-parsing yields the same blocks.
function blockSource(block) {
  if (block?.kind === 'text') return block.markdown;
  if (block?.kind === 'textdoc') {
    const attr = (key, value) => (value ? ` ${key}="${String(value).replace(/["\\\n]/g, ' ')}"` : '');
    return `:::${block.directive || 'writing'}{${(attr('variant', block.variant) + attr('title', block.title)).trim()}}\n${block.markdown}\n:::`;
  }
  return null;
}

export const LOCAL_RECORD_VERSION = 1;
export const LOCAL_LIMITS = Object.freeze({ maxCount: 50, maxChars: 1_500_000, maxTitleChars: 120 });

const STATUS_TO_RAW = { done: 'finished_successfully', streaming: 'finished_partial_completion', interrupted: 'finished_partial_completion', error: 'failed' };
const RAW_STATUSES = new Set(['finished_successfully', 'finished_partial_completion', 'failed']);

/**
 * Compact record of a conversation (user/assistant text only).
 * @param {import('./types.js').Conversation} conversation
 * @param {{ title?: string, updatedAt?: number|null }} [meta]
 * @returns {object|null} null when there is nothing worth keeping.
 */
export function localRecordFromConversation(conversation, meta = {}) {
  try {
    if (!isObject(conversation) || !sourceId(conversation.id) || !(conversation.nodes instanceof Map)) return null;
    const messages = [];
    for (const node of conversation.nodes.values()) {
      const message = node?.message;
      if (!message || message.hidden || (message.role !== 'user' && message.role !== 'assistant')) continue;
      const text = (message.blocks || []).map(blockSource).filter((part) => part !== null).join('\n\n');
      messages.push({ id: message.id, parent: node.parentId ?? null, role: message.role, text, status: STATUS_TO_RAW[message.status] || 'finished_partial_completion' });
    }
    if (!messages.length) return null;
    const title = String((isObject(meta) && meta.title) || conversation.title || firstUserText(messages)).slice(0, LOCAL_LIMITS.maxTitleChars);
    const updatedAt = isObject(meta) && Number.isFinite(meta.updatedAt) ? meta.updatedAt : null;
    return { v: LOCAL_RECORD_VERSION, id: conversation.id, title, updatedAt, currentNode: conversation.currentNodeId ?? null, messages };
  } catch {
    return null;
  }
}

/**
 * Rebuild a Conversation from a stored record (null when invalid).
 * @param {unknown} record
 * @returns {import('./types.js').Conversation|null}
 */
export function conversationFromLocalRecord(record) {
  const clean = sanitizeRecord(record);
  if (!clean) return null;
  const mapping = {};
  for (const item of clean.messages) {
    mapping[item.id] = { id: item.id, parent: item.parent, children: [], message: sourceRawMessage({ id: item.id, role: item.role, text: item.text, status: item.status, parentId: item.parent }) };
  }
  for (const item of clean.messages) if (item.parent && mapping[item.parent]) mapping[item.parent].children.push(item.id);
  const current = clean.currentNode && mapping[clean.currentNode] ? clean.currentNode : clean.messages[clean.messages.length - 1].id;
  return parseConversation({ conversation_id: clean.id, title: clean.title, current_node: current, mapping });
}

/**
 * Validate stored records and enforce the count/size caps (newest kept).
 * @param {unknown} records
 * @param {{ maxCount?: number, maxChars?: number }} [limits]
 * @returns {object[]}
 */
export function capLocalRecords(records, limits = {}) {
  const maxCount = Number.isInteger(limits?.maxCount) && limits.maxCount > 0 ? limits.maxCount : LOCAL_LIMITS.maxCount;
  const maxChars = Number.isFinite(limits?.maxChars) && limits.maxChars > 0 ? limits.maxChars : LOCAL_LIMITS.maxChars;
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  const clean = [];
  for (const record of records) {
    const item = sanitizeRecord(record);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    clean.push(item);
  }
  clean.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const kept = [];
  let chars = 0;
  for (const item of clean) {
    if (kept.length >= maxCount) break;
    const size = item.messages.reduce((sum, message) => sum + message.text.length + 120, item.title.length + 120);
    if (chars + size > maxChars) continue;
    chars += size;
    kept.push(item);
  }
  return kept;
}

function sanitizeRecord(record) {
  try {
    if (!isObject(record) || record.v !== LOCAL_RECORD_VERSION || !sourceId(record.id) || !Array.isArray(record.messages)) return null;
    const messages = [];
    const ids = new Set();
    for (const item of record.messages) {
      if (!isObject(item) || !sourceId(item.id) || ids.has(item.id)) continue;
      if (item.role !== 'user' && item.role !== 'assistant') continue;
      if (typeof item.text !== 'string') continue;
      ids.add(item.id);
      messages.push({
        id: item.id,
        parent: sourceId(item.parent),
        role: item.role,
        text: item.text,
        status: RAW_STATUSES.has(item.status) ? item.status : 'finished_partial_completion',
      });
    }
    if (!messages.length) return null;
    for (const item of messages) if (item.parent && (!ids.has(item.parent) || item.parent === item.id)) item.parent = null;
    return {
      v: LOCAL_RECORD_VERSION,
      id: record.id,
      title: typeof record.title === 'string' ? record.title.slice(0, LOCAL_LIMITS.maxTitleChars) : '',
      updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : null,
      currentNode: sourceId(record.currentNode),
      messages,
    };
  } catch {
    return null;
  }
}

function firstUserText(messages) {
  const first = messages.find((item) => item.role === 'user' && item.text.trim());
  return first ? first.text.trim().replace(/\s+/g, ' ') : '';
}
