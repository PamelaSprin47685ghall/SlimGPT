// Turn selection and branch switching. Ownership is decided by the parent
// chain only: walk from the leaf to the root, keep visible messages, start a
// new turn at every visible user message.

import { isConversation } from './conversation.js';

/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./types.js').Turn} Turn */

const NO_BRANCH = Object.freeze({ index: 0, count: 0, siblingIds: Object.freeze([]) });

/** Root → leaf node ids. Stops at a missing parent or a cycle. */
export function pathTo(conversation, leafId) {
  const path = [];
  const seen = new Set();
  for (let cursor = leafId; cursor && conversation.nodes.has(cursor) && !seen.has(cursor);) {
    seen.add(cursor);
    path.push(cursor);
    cursor = conversation.nodes.get(cursor).parentId;
  }
  return path.reverse();
}

/** A message the reader actually sees in a turn. */
function isVisibleContent(message) {
  return Boolean(message) && !message.hidden && (message.role === 'user' || message.blocks.length > 0);
}

/**
 * Does the subtree under `nodeId` contain anything a reader would see?
 * Hidden system/context nodes, abandoned empty placeholders and other
 * stream-internal nodes never count as a branch (no phantom "2/2").
 */
function producesContent(conversation, nodeId) {
  const stack = [nodeId];
  const seen = new Set();
  while (stack.length && seen.size < 10_000) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = conversation.nodes.get(id);
    if (!node) continue;
    if (isVisibleContent(node.message)) return true;
    for (const child of node.childIds) stack.push(child);
  }
  return false;
}

function siblingsOf(conversation, nodeId) {
  const node = conversation.nodes.get(nodeId);
  const parent = node?.parentId ? conversation.nodes.get(node.parentId) : null;
  if (!parent) return [nodeId];
  const siblings = parent.childIds.filter((id) => id === nodeId || producesContent(conversation, id));
  return siblings.includes(nodeId) ? siblings : [...siblings, nodeId];
}

function branchInfo(conversation, nodeId) {
  if (!nodeId) return { index: 0, count: 0, siblingIds: [] };
  const siblingIds = siblingsOf(conversation, nodeId);
  return { index: siblingIds.indexOf(nodeId), count: siblingIds.length, siblingIds };
}

function defaultLeaf(conversation) {
  if (conversation.currentNodeId && conversation.nodes.has(conversation.currentNodeId)) return conversation.currentNodeId;
  // No current node: follow the newest child from the first root.
  for (const node of conversation.nodes.values()) {
    if (!node.parentId || !conversation.nodes.has(node.parentId)) return descend(conversation, node.id);
  }
  return null;
}

function newestChild(conversation, node) {
  let best = null;
  let bestTime = -Infinity;
  const productive = node.childIds.filter((id) => producesContent(conversation, id));
  for (const id of productive.length ? productive : node.childIds) {
    const child = conversation.nodes.get(id);
    if (!child) continue;
    const time = child.message?.createdAt ?? -Infinity;
    if (best === null || time >= bestTime) { best = id; bestTime = time; }
  }
  return best;
}

/** Follow the newest child down to a leaf. */
function descend(conversation, nodeId) {
  const seen = new Set();
  let cursor = nodeId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const next = newestChild(conversation, conversation.nodes.get(cursor));
    if (!next) break;
    cursor = next;
  }
  return cursor;
}

/**
 * @param {Conversation} conversation
 * @param {string|null} [leafId]
 * @returns {Turn[]}
 */
export function selectTurns(conversation, leafId = null) {
  try {
    if (!isConversation(conversation)) return [];
    const leaf = typeof leafId === 'string' && conversation.nodes.has(leafId) ? leafId : defaultLeaf(conversation);
    if (!leaf) return [];
    const path = pathTo(conversation, leaf);
    const turns = [];
    let turn = null;
    for (let index = 0; index < path.length; index += 1) {
      const node = conversation.nodes.get(path[index]);
      const message = node.message;
      if (!message || message.hidden) continue;
      if (message.role === 'user') {
        const next = path[index + 1] ?? null;
        turn = { user: message, replies: [], userBranch: branchInfo(conversation, node.id), replyBranch: branchInfo(conversation, next) };
        turns.push(turn);
      } else {
        if (!turn) {
          turn = { user: null, replies: [], userBranch: { ...NO_BRANCH, siblingIds: [] }, replyBranch: branchInfo(conversation, node.id) };
          turns.push(turn);
        }
        turn.replies.push(message);
      }
    }
    return turns;
  } catch {
    return [];
  }
}

/**
 * @param {Conversation} conversation
 * @param {string} nodeId
 * @param {number} delta
 * @returns {string|null} null when there is no sibling in that direction.
 */
export function switchBranch(conversation, nodeId, delta) {
  try {
    if (!isConversation(conversation) || !conversation.nodes.has(nodeId) || !Number.isInteger(delta)) return null;
    const siblings = siblingsOf(conversation, nodeId);
    const target = siblings[siblings.indexOf(nodeId) + delta];
    if (!target) return null;
    const current = conversation.currentNodeId;
    if (current && pathTo(conversation, current).includes(target)) return current;
    return descend(conversation, target);
  } catch {
    return null;
  }
}
