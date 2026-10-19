// Conversation state: canonical history ingest, page merges and live
// snapshots. Every function returns a new Conversation and never mutates its
// inputs. Child lists are derived from parent pointers, so a page can never
// invent a sibling (bug 1) and a live copy can never detach replies (bug 2).

import { normalizeMessage } from './message.js';
import { isObject, safeJsonParse } from './util.js';

/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./types.js').Node} Node */
/** @typedef {import('./types.js').Message} Message */

// Private bookkeeping carried alongside the public shape. Symbol keys are
// invisible to JSON, Object.keys and consumers' destructuring.
// WEAK_PARENTS: node ids whose parent was inferred from page order rather
// than stated by the server; such parents may be corrected by later data.
const WEAK_PARENTS = Symbol('slimgpt.weakParents');

function withPrivate(conversation, weakParents) {
  Object.defineProperty(conversation, WEAK_PARENTS, { value: weakParents, enumerable: false });
  return conversation;
}

const weakParentsOf = (conversation) => (conversation && conversation[WEAK_PARENTS]) || new Set();

/**
 * @param {string} id
 * @returns {Conversation}
 */
export function createConversation(id) {
  return withPrivate({
    id: typeof id === 'string' ? id : '',
    title: '',
    nodes: new Map(),
    currentNodeId: null,
    complete: false,
  }, new Set());
}

/** True when `value` looks like a Conversation produced by this module. */
export function isConversation(value) {
  return isObject(value) && value.nodes instanceof Map && typeof value.id === 'string';
}

function setNodeParent(node, parentId) {
  const message = node.message && node.message.parentId !== parentId ? { ...node.message, parentId } : node.message;
  return { ...node, parentId, message };
}

/**
 * Recompute childIds from parent pointers. Order: existing order hints
 * first, then by createdAt, then by insertion order.
 * @param {Map<string, Node>} nodes
 * @param {Map<string, string[]>} hints parentId → preferred child order
 */
function rebuildChildren(nodes, hints) {
  const children = new Map();
  let order = 0;
  const rank = new Map();
  for (const [id, node] of nodes) {
    rank.set(id, order++);
    if (node.parentId && nodes.has(node.parentId)) {
      if (!children.has(node.parentId)) children.set(node.parentId, []);
      children.get(node.parentId).push(id);
    }
  }
  const result = new Map();
  for (const [id, node] of nodes) {
    const list = children.get(id) || [];
    const hint = hints.get(id) || [];
    const hintIndex = new Map();
    hint.forEach((childId, index) => { if (!hintIndex.has(childId)) hintIndex.set(childId, index); });
    list.sort((a, b) => {
      const ha = hintIndex.has(a) ? hintIndex.get(a) : Infinity;
      const hb = hintIndex.has(b) ? hintIndex.get(b) : Infinity;
      if (ha !== hb) return ha - hb;
      const ca = nodes.get(a).message?.createdAt ?? Infinity;
      const cb = nodes.get(b).message?.createdAt ?? Infinity;
      if (ca !== cb) return ca - cb;
      return rank.get(a) - rank.get(b);
    });
    const same = list.length === node.childIds.length && list.every((childId, index) => node.childIds[index] === childId);
    result.set(id, same ? node : { ...node, childIds: list });
  }
  return result;
}

function hintsFrom(...nodeMaps) {
  const hints = new Map();
  for (const nodes of nodeMaps) {
    if (!nodes) continue;
    for (const [id, node] of nodes) {
      const list = hints.get(id) || [];
      for (const childId of node.childIds || []) if (!list.includes(childId)) list.push(childId);
      hints.set(id, list);
    }
  }
  return hints;
}

function parseMapping(body) {
  const mapping = body.mapping;
  const nodes = new Map();
  const hints = new Map();
  for (const [key, rawNode] of Object.entries(mapping)) {
    if (!isObject(rawNode)) continue;
    const id = typeof rawNode.id === 'string' && rawNode.id ? rawNode.id : key;
    if (!id || nodes.has(id)) continue;
    let parentId = typeof rawNode.parent === 'string' && rawNode.parent && rawNode.parent !== id ? rawNode.parent : null;
    let message = null;
    if (isObject(rawNode.message)) {
      const rawMessage = rawNode.message.id === id ? rawNode.message : { ...rawNode.message, id };
      message = normalizeMessage(rawMessage, { parentId, source: 'canonical' });
    }
    nodes.set(id, { id, parentId, childIds: [], message });
    if (Array.isArray(rawNode.children)) hints.set(id, rawNode.children.filter((child) => typeof child === 'string'));
  }
  return { nodes: rebuildChildren(nodes, hints), weak: new Set() };
}

function parseMessageList(messages) {
  const nodes = new Map();
  const weak = new Set();
  const stated = messages.some((raw) => isObject(raw) && (raw.parent_id || raw.metadata?.parent_id));
  let previousId = null;
  for (const raw of messages) {
    const message = normalizeMessage(raw, { source: 'canonical' });
    if (!message || nodes.has(message.id)) continue;
    let parentId = message.parentId;
    if (!parentId && !stated && previousId) {
      // The page states no parents at all: it is an ordered path, so chain it,
      // but remember the parent is only inferred.
      parentId = previousId;
      weak.add(message.id);
    }
    nodes.set(message.id, { id: message.id, parentId, childIds: [], message: parentId === message.parentId ? message : { ...message, parentId } });
    previousId = message.id;
  }
  return { nodes: rebuildChildren(nodes, new Map()), weak };
}

/**
 * @param {string|object} body
 * @returns {Conversation|null}
 */
export function parseConversation(body) {
  try {
    const value = typeof body === 'string' ? safeJsonParse(body, null) : body;
    if (!isObject(value)) return null;
    let parsed;
    let complete;
    if (isObject(value.mapping)) {
      parsed = parseMapping(value);
      complete = !isObject(value.page_info) || value.page_info.has_previous_page === false;
    } else if (Array.isArray(value.messages) && ('current_node' in value || 'page_info' in value || 'conversation_id' in value)) {
      parsed = parseMessageList(value.messages);
      complete = isObject(value.page_info) && value.page_info.has_previous_page === false;
    } else {
      return null;
    }
    const id = [value.conversation_id, value.id].find((item) => typeof item === 'string' && item) || '';
    // A page may declare a current node that lives on another page; keep the
    // declared id so a later merge can resolve it.
    const currentNodeId = typeof value.current_node === 'string' && value.current_node ? value.current_node : null;
    return withPrivate({
      id,
      title: typeof value.title === 'string' ? value.title : '',
      nodes: parsed.nodes,
      currentNodeId: currentNodeId ?? newestLeaf(parsed.nodes),
      complete,
    }, parsed.weak);
  } catch {
    return null;
  }
}

function newestLeaf(nodes) {
  let best = null;
  for (const node of nodes.values()) {
    if (node.childIds.length) continue;
    if (!best || (node.message?.createdAt ?? -Infinity) >= (best.message?.createdAt ?? -Infinity)) best = node;
  }
  return best ? best.id : null;
}

function isAncestor(nodes, ancestorId, nodeId) {
  const seen = new Set();
  for (let cursor = nodeId; cursor && !seen.has(cursor); cursor = nodes.get(cursor)?.parentId ?? null) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
  }
  return false;
}

/** Would setting node.parent = parentId create a cycle? */
function createsCycle(nodes, id, parentId) {
  return Boolean(parentId) && isAncestor(nodes, id, parentId);
}

/**
 * @param {Conversation|null} previous
 * @param {Conversation} incoming
 * @returns {Conversation}
 */
export function mergeConversation(previous, incoming) {
  try {
    if (!isConversation(incoming)) return isConversation(previous) ? previous : createConversation('');
    if (!isConversation(previous)) return incoming;
    const prevWeak = weakParentsOf(previous);
    const inWeak = weakParentsOf(incoming);
    const weak = new Set(prevWeak);
    const nodes = new Map(previous.nodes);
    for (const [id, inNode] of incoming.nodes) {
      const old = nodes.get(id);
      if (!old) {
        nodes.set(id, { ...inNode });
        if (inWeak.has(id)) weak.add(id);
        continue;
      }
      // Parent: a known, server-stated canonical parent is never rewritten.
      const oldParentKnown = Boolean(old.parentId) && !prevWeak.has(id) && old.message?.source !== 'live';
      let parentId = old.parentId;
      if (!oldParentKnown && inNode.parentId && !(inWeak.has(id) && old.parentId)) {
        parentId = inNode.parentId;
        if (inWeak.has(id)) weak.add(id); else weak.delete(id);
      }
      if (createsCycle(nodes, id, parentId)) parentId = old.parentId;
      // Message: canonical data always replaces (including live copies).
      const message = inNode.message ?? old.message;
      nodes.set(id, setNodeParent({ ...old, message }, parentId));
    }
    // A complete canonical history is the truth: live-only nodes it does not
    // contain (stream-internal placeholders, aborted drafts, temporary ids)
    // are dropped so they cannot linger as phantom branches. A node still
    // streaming re-appears with its next snapshot.
    // Exception: the live path that continues the canonical current node
    // (canonical fetched while a reply is still streaming).
    if (incoming.complete && incoming.nodes.size) {
      const keep = new Set();
      const leaf = previous.currentNodeId;
      if (leaf && nodes.get(leaf)?.message?.source === 'live' && incoming.currentNodeId && incoming.nodes.has(incoming.currentNodeId) &&
          isAncestor(nodes, incoming.currentNodeId, leaf)) {
        const seen = new Set();
        for (let cursor = leaf; cursor && !seen.has(cursor) && !incoming.nodes.has(cursor); cursor = nodes.get(cursor)?.parentId ?? null) {
          seen.add(cursor);
          keep.add(cursor);
        }
      }
      for (const [id, node] of nodes) {
        if (!incoming.nodes.has(id) && node.message?.source === 'live' && !keep.has(id)) nodes.delete(id);
      }
    }
    const merged = rebuildChildren(nodes, hintsFrom(previous.nodes, incoming.nodes));
    let currentNodeId = incoming.currentNodeId && merged.has(incoming.currentNodeId) ? incoming.currentNodeId : previous.currentNodeId;
    // Keep a newer live leaf that continues the canonical current path.
    const prevLeaf = previous.currentNodeId && merged.get(previous.currentNodeId);
    if (prevLeaf && currentNodeId && prevLeaf.id !== currentNodeId && prevLeaf.message?.source === 'live' &&
        isAncestor(merged, currentNodeId, prevLeaf.id)) currentNodeId = prevLeaf.id;
    if (currentNodeId && !merged.has(currentNodeId)) currentNodeId = newestLeaf(merged);
    return withPrivate({
      id: previous.id || incoming.id,
      title: incoming.title || previous.title,
      nodes: merged,
      currentNodeId,
      complete: previous.complete || incoming.complete,
    }, weak);
  } catch {
    return isConversation(previous) ? previous : (isConversation(incoming) ? incoming : createConversation(''));
  }
}

/**
 * Apply one live raw message snapshot (replace by id).
 * @param {Conversation} conversation
 * @param {object} raw
 * @param {{ fallbackParentId?: string|null }} [context]
 * @returns {Conversation}
 */
export function applyLiveMessage(conversation, raw, context = {}) {
  const base = isConversation(conversation) ? conversation : createConversation('');
  try {
    const message = normalizeMessage(raw, { source: 'live' });
    if (!message) return base;
    const existing = base.nodes.get(message.id) || null;
    const old = existing?.message || null;
    if (old && old.source === 'canonical' && old.status !== 'streaming' && old.status !== 'interrupted') return base;

    const fallback = isObject(context) && typeof context.fallbackParentId === 'string' && context.fallbackParentId
      ? context.fallbackParentId : null;
    let parentId;
    if (existing && existing.parentId && old?.source === 'canonical') parentId = existing.parentId;
    else parentId = message.parentId || (fallback !== message.id ? fallback : null) || existing?.parentId || null;
    const nodes = new Map(base.nodes);
    if (parentId && createsCycle(nodes, message.id, parentId)) parentId = existing?.parentId ?? null;

    const node = {
      id: message.id,
      parentId,
      childIds: existing ? existing.childIds : [],
      message: message.parentId === parentId ? message : { ...message, parentId },
    };
    nodes.set(message.id, node);
    const oldParentId = existing?.parentId ?? null;
    if (oldParentId !== parentId) {
      if (oldParentId && nodes.has(oldParentId)) {
        const p = nodes.get(oldParentId);
        nodes.set(oldParentId, { ...p, childIds: p.childIds.filter((child) => child !== message.id) });
      }
    }
    if (parentId && nodes.has(parentId)) {
      const p = nodes.get(parentId);
      if (!p.childIds.includes(message.id)) nodes.set(parentId, { ...p, childIds: [...p.childIds, message.id] });
    }
    if (!existing) {
      // Adopt orphans that were waiting for this parent (out-of-order arrival).
      for (const [id, other] of nodes) {
        if (other.parentId === message.id && id !== message.id && !node.childIds.includes(id)) {
          node.childIds = [...node.childIds, id];
        }
      }
    }

    // The newest live leaf becomes current (new turn, regenerate, edit) when
    // it continues the current path or is something the reader sees. A hidden
    // or still-empty side leaf (stream-internal system/context node) never
    // steals the current path.
    let currentNodeId = base.currentNodeId;
    // A non-hidden streaming placeholder counts: a regenerate shows its new
    // (still empty) reply at once.
    const visible = !message.hidden && (message.role === 'user' || message.blocks.length > 0 || message.status === 'streaming');
    if (!currentNodeId || !nodes.has(currentNodeId)) currentNodeId = message.id;
    else if (!node.childIds.length && (visible || isAncestor(nodes, currentNodeId, message.id))) currentNodeId = message.id;
    const weak = new Set(weakParentsOf(base));
    weak.delete(message.id);
    return withPrivate({ ...base, nodes, currentNodeId }, weak);
  } catch {
    return base;
  }
}

/**
 * Mark every live message that is still 'streaming' as 'interrupted'. Used
 * when a stream ends early (user pressed Stop, connection dropped): the
 * partial reply stays visible as an unfinished answer until the canonical
 * refresh replaces it. Canonical messages are untouched.
 * @param {Conversation} conversation
 * @returns {Conversation}
 */
export function interruptLiveMessages(conversation) {
  if (!isConversation(conversation)) return conversation;
  try {
    let nodes = null;
    for (const [id, node] of conversation.nodes) {
      if (node.message?.source !== 'live' || node.message.status !== 'streaming') continue;
      nodes ||= new Map(conversation.nodes);
      nodes.set(id, { ...node, message: { ...node.message, status: 'interrupted' } });
    }
    return nodes ? withPrivate({ ...conversation, nodes }, new Set(weakParentsOf(conversation))) : conversation;
  } catch {
    return conversation;
  }
}
