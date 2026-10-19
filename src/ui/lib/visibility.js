// What the thread shows. Internal browsing/search plumbing (web.run calls,
// search results, page opens) is hidden; reasoning stays as one collapsed
// line; tools the user cares about (python, canvas, image generation, …)
// stay as collapsed cards.

const QUIET_TOOL = /^(?:web|web\.run|web\.search|browser|browser\.\w+|search|file_search|file_search\.\w+|myfiles_browser|bio|memory|context_stuff|tether)(?:$|[.:])/i;

/** @param {string} tool */
export function isQuietTool(tool) {
  return QUIET_TOOL.test(String(tool || '').trim());
}

/** Blocks of one message that the thread renders. */
export function visibleBlocks(message) {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  return blocks.filter((block) => !((block.kind === 'tool_call' || block.kind === 'tool_result') && isQuietTool(block.tool)));
}

/** True when the message is only internal search/browse plumbing. */
export function isQuietMessage(message) {
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
  return blocks.length > 0 && visibleBlocks(message).length === 0;
}

/**
 * Replies to render, plus where the reply branch switcher goes: on the
 * first rendered reply, switching the branch node of the turn (which may be
 * a hidden/quiet node between the user message and the visible reply).
 * @param {import('../../protocol/types.js').Turn} turn
 */
export function displayReplies(turn) {
  const replies = turn.replies.filter((reply) => !isQuietMessage(reply));
  const searching = turn.replies.some((reply) => reply.status === 'streaming' && isQuietMessage(reply)) &&
    !replies.some((reply) => reply.status === 'streaming');
  const branchNodeId = turn.replyBranch?.siblingIds?.[turn.replyBranch.index] ?? null;
  return { replies, searching, branchNodeId };
}
