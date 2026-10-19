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

const RECAP = /^\s*(?:(?:worked|thought|reasoned|thinking)\s+for\b|已?思考(?:了|用时)?|用时)/i;
const SEARCHED = /(?:searched|browsed)\s+(\d+)\s+(?:web)?sites?|(?:searched|browsed)\s+(\d+)\s+websites?|已?搜索(?:了)?\s*(\d+)\s*个网站/i;

/**
 * One collapsed "思考" line for a run of reasoning blocks (thoughts, search
 * summaries like "Searched 20 websites", recaps like "Worked for a few
 * seconds"): label "思考 · 已搜索 20 个网站 · 12 秒", body = all thoughts.
 */
export function mergeReasoning(blocks) {
  let searched = 0;
  let durationSec = null;
  const bodies = [];
  const hints = [];
  for (const block of blocks) {
    if (Number.isFinite(block.durationSec)) durationSec = block.durationSec;
    const summary = typeof block.summary === 'string' ? block.summary.trim() : '';
    const markdown = typeof block.markdown === 'string' ? block.markdown.trim() : '';
    const search = SEARCHED.exec(summary);
    if (search) { searched += Number(search[1] || search[2] || search[3]) || 0; continue; }
    if (summary && RECAP.test(summary) && !markdown) continue;
    if (summary) hints.push(summary);
    if (markdown) bodies.push(summary && blocks.length > 1 ? `**${summary}**\n\n${markdown}` : markdown);
  }
  const parts = ['思考'];
  if (searched) parts.push(`已搜索 ${searched} 个网站`);
  if (durationSec) parts.push(`${Math.max(1, Math.round(durationSec))} 秒`);
  return {
    kind: 'reasoning',
    markdown: bodies.join('\n\n'),
    summary: hints.length === 1 && blocks.length === 1 ? hints[0] : null,
    durationSec,
    label: parts.join(' · '),
  };
}

const isReasoningOnly = (blocks) => blocks.length > 0 && blocks.every((block) => block.kind === 'reasoning');

/**
 * Replies to render, plus where the reply branch switcher goes: on the
 * first rendered reply, switching the branch node of the turn (which may be
 * a hidden/quiet node between the user message and the visible reply).
 * Consecutive reasoning-only replies (after hiding search plumbing) collapse
 * into one reasoning line, the same live and after reload.
 * @param {import('../../protocol/types.js').Turn} turn
 */
export function displayReplies(turn) {
  const replies = [];
  let run = null;
  for (const reply of turn.replies) {
    if (isQuietMessage(reply)) continue;
    const blocks = visibleBlocks(reply);
    if (!isReasoningOnly(blocks)) { run = null; replies.push(reply); continue; }
    if (!run) { run = { messages: [], blocks: [] }; replies.push(run); }
    run.messages.push(reply);
    run.blocks.push(...blocks);
  }
  for (let index = 0; index < replies.length; index += 1) {
    const item = replies[index];
    if (!item.messages) continue;
    const [first] = item.messages;
    if (item.messages.length === 1 && item.blocks.length === 1 && !SEARCHED.test(item.blocks[0].summary || '')) { replies[index] = first; continue; }
    const streaming = item.messages.some((message) => message.status === 'streaming');
    replies[index] = { ...first, status: streaming ? 'streaming' : first.status, blocks: [mergeReasoning(item.blocks)] };
  }
  const searching = turn.replies.some((reply) => reply.status === 'streaming' && isQuietMessage(reply)) &&
    !replies.some((reply) => reply.status === 'streaming');
  const branchNodeId = turn.replyBranch?.siblingIds?.[turn.replyBranch.index] ?? null;
  return { replies, searching, branchNodeId };
}
