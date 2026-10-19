// Plain-text and Markdown projections. Presentation of citations happens
// here (export only), never inside parsed message text.

import { isConversation } from './conversation.js';
import { selectTurns } from './turns.js';
import { isObject } from './util.js';

/** @typedef {import('./types.js').Message} Message */
/** @typedef {import('./types.js').Conversation} Conversation */

/**
 * @param {Message} message
 * @returns {string}
 */
export function messageToPlainText(message) {
  try {
    if (!isObject(message) || !Array.isArray(message.blocks)) return '';
    const primary = [];
    const secondary = [];
    for (const block of message.blocks) {
      if (!isObject(block)) continue;
      if (block.kind === 'text' && block.markdown) primary.push(block.markdown);
      else if (block.kind === 'error' && block.message) primary.push(block.message);
      else if (block.kind === 'tool_call' && block.input) secondary.push(block.input);
      else if (block.kind === 'tool_result' && block.output) secondary.push(block.output);
      else if (block.kind === 'reasoning' && (block.markdown || block.summary)) secondary.push(block.markdown || block.summary);
    }
    return (primary.length ? primary : secondary).join('\n\n');
  } catch {
    return '';
  }
}

/** A code fence longer than any backtick run in `text`. */
export function fenceFor(text) {
  let longest = 0;
  for (const match of String(text).matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function fenced(text, language = '') {
  const fence = fenceFor(text);
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return `${fence}${language || ''}\n${body}${fence}`;
}

function textWithCitations(block, numbering) {
  const citations = Array.isArray(block.citations) ? [...block.citations].sort((a, b) => a.start - b.start) : [];
  if (!citations.length) return block.markdown;
  let out = '';
  let cursor = 0;
  for (const citation of citations) {
    const at = Math.min(Math.max(citation.end, cursor), block.markdown.length);
    out += block.markdown.slice(cursor, at);
    cursor = at;
    const links = citation.sources.map((source) => {
      if (!numbering.has(source.url)) numbering.set(source.url, numbering.size + 1);
      return `[${numbering.get(source.url)}](${source.url})`;
    });
    if (links.length) out += ` ${links.join(' ')}`;
  }
  return out + block.markdown.slice(cursor);
}

function blockToMarkdown(block, options, numbering) {
  switch (block.kind) {
    case 'text':
      return block.markdown ? textWithCitations(block, numbering) : '';
    case 'reasoning': {
      if (!options.includeReasoning) return '';
      const body = [block.summary ? `**${block.summary}**` : '', block.markdown].filter(Boolean).join('\n\n');
      return body ? body.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n') : '';
    }
    case 'tool_call':
      return options.includeTools ? `Tool call: \`${block.tool}\`\n\n${fenced(block.input, block.language || '')}` : '';
    case 'tool_result':
      return options.includeTools ? `Tool result: \`${block.tool}\`${block.isError ? ' (error)' : ''}\n\n${fenced(block.output)}` : '';
    case 'image':
      return '*(image)*';
    case 'file':
      return `*(file: ${block.name})*`;
    case 'error':
      return `> **Error:** ${block.message}`;
    case 'unknown':
      return options.includeTools ? `*(unsupported content: ${block.contentType})*` : '';
    default:
      return '';
  }
}

function messageToMarkdown(message, options, numbering) {
  return message.blocks.map((block) => blockToMarkdown(block, options, numbering)).filter(Boolean).join('\n\n');
}

/**
 * @param {Conversation} conversation
 * @param {{ leafId?: string|null, includeReasoning?: boolean, includeTools?: boolean }} [options]
 * @returns {string}
 */
export function conversationToMarkdown(conversation, options = {}) {
  try {
    if (!isConversation(conversation)) return '';
    const opts = isObject(options) ? options : {};
    const settings = { includeReasoning: opts.includeReasoning === true, includeTools: opts.includeTools === true };
    const numbering = new Map();
    const sections = [];
    if (conversation.title) sections.push(`# ${conversation.title.replace(/\s+/g, ' ').trim()}`);
    for (const turn of selectTurns(conversation, opts.leafId ?? null)) {
      if (turn.user) {
        const body = messageToMarkdown(turn.user, settings, numbering);
        sections.push(`## User\n\n${body}`.trimEnd());
      }
      const replies = turn.replies.map((reply) => messageToMarkdown(reply, settings, numbering)).filter(Boolean);
      if (replies.length) sections.push(`## Assistant\n\n${replies.join('\n\n')}`);
    }
    return sections.length ? `${sections.join('\n\n')}\n` : '';
  } catch {
    return '';
  }
}
