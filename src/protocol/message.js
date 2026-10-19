// normalizeMessage: one raw ChatGPT message → the unified Message model.
// Pure and total: any input yields a Message (or null without a string id);
// unexpected content becomes an UnknownBlock instead of being dropped or
// turned into placeholder prose. Internal asset pointers only appear in
// ImageBlock.assetPointer, never in text.

import { extractCitations } from './citations.js';
import { ROLES } from './types.js';
import { finiteOrNull, firstString, isObject, safeClone, safeStringify, str } from './util.js';

/** @typedef {import('./types.js').Message} Message */
/** @typedef {import('./types.js').Block} Block */
/** @typedef {import('./types.js').MessageStatus} MessageStatus */

const HIDDEN_CONTENT_TYPES = new Set(['user_editable_context', 'model_editable_context']);
const HIDDEN_RECIPIENTS = new Set(['bio', 'bio.update', 'memory']);
const AUDIO_POINTERS = new Set(['audio_asset_pointer', 'real_time_user_audio_video_asset_pointer', 'video_container_asset_pointer']);

const textBlock = (markdown, citations = []) => ({ kind: 'text', markdown, citations });
const unknownBlock = (contentType, raw) => ({ kind: 'unknown', contentType: contentType || 'unknown', raw: safeClone(raw) });

/**
 * @param {Record<string, any>} raw
 * @param {Record<string, any>} content
 * @param {Record<string, any>} metadata
 * @returns {MessageStatus}
 */
export function deriveStatus(raw, content, metadata) {
  if (
    content.content_type === 'system_error' ||
    raw.status === 'failed' ||
    raw.status === 'error' ||
    metadata.is_error === true ||
    (metadata.error !== undefined && metadata.error !== null && metadata.error !== false && metadata.error !== '')
  ) return 'error';
  if (raw.status === 'in_progress') return 'streaming';
  const finish = isObject(metadata.finish_details) ? metadata.finish_details.type : null;
  if (raw.status === 'finished_partial_completion' || finish === 'max_tokens' || finish === 'interrupted') return 'interrupted';
  return 'done';
}

function roleOf(raw) {
  const role = isObject(raw.author) ? raw.author.role : null;
  return ROLES.includes(role) ? role : 'system';
}

function recipientOf(raw, content, metadata) {
  return firstString(raw.recipient, metadata.recipient, content.recipient);
}

/** Call id shared by a tool call and its result, when the server provides one. */
export function callIdOf(raw) {
  if (!isObject(raw)) return null;
  const metadata = isObject(raw.metadata) ? raw.metadata : {};
  const content = isObject(raw.content) ? raw.content : {};
  const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : Array.isArray(metadata.tool_calls) ? metadata.tool_calls : [];
  const first = isObject(calls[0]) ? calls[0] : {};
  return firstString(
    raw.call_id, metadata.call_id, content.call_id,
    raw.tool_call_id, metadata.tool_call_id, content.tool_call_id,
    first.call_id, first.id,
  ) || null;
}

function stringParts(content) {
  return Array.isArray(content.parts) ? content.parts.filter((part) => typeof part === 'string') : [];
}

function guessLanguage(language, text) {
  if (typeof language === 'string' && language && language !== 'unknown') return language;
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* not JSON */ }
  }
  return null;
}

function fileIdFromPointer(pointer) {
  const match = /([A-Za-z0-9_-]+)$/.exec(pointer);
  return match ? match[1] : '';
}

/**
 * Text of a user/assistant part list, plus media blocks, in display order.
 * @returns {Block[]}
 */
function partsToBlocks(parts, makeText, { tool } = {}) {
  const blocks = [];
  const hasTranscript = parts.some((part) => isObject(part) && part.content_type === 'audio_transcription' && str(part.text));
  for (const part of parts) {
    if (typeof part === 'string') {
      if (part) blocks.push(...makeText(part));
      continue;
    }
    if (!isObject(part)) {
      if (part !== null && part !== undefined) blocks.push(unknownBlock('part', part));
      continue;
    }
    const type = str(part.content_type);
    if (type === 'image_asset_pointer') {
      blocks.push({
        kind: 'image',
        assetPointer: str(part.asset_pointer),
        width: finiteOrNull(part.width),
        height: finiteOrNull(part.height),
      });
    } else if (type === 'audio_transcription') {
      if (str(part.text)) blocks.push(textBlock(part.text));
    } else if (AUDIO_POINTERS.has(type)) {
      if (!hasTranscript) {
        const format = str(part.format);
        blocks.push({ kind: 'file', name: type.startsWith('audio') ? 'audio' : 'media', size: finiteOrNull(part.size_bytes), mime: format ? `audio/${format}` : null });
      }
    } else if (type === 'text' || (!type && typeof part.text === 'string')) {
      if (str(part.text)) blocks.push(...makeText(part.text));
    } else if (type === 'thoughts' || type === 'thought' || typeof part.thought === 'string') {
      const body = firstString(part.thought, part.content, part.text);
      blocks.push({ kind: 'reasoning', markdown: body, summary: firstString(part.summary) || null, durationSec: null });
    } else {
      blocks.push(unknownBlock(type || 'part', part));
    }
  }
  if (tool && !blocks.length) return [];
  return blocks;
}

function attachmentBlocks(metadata, existing) {
  if (!Array.isArray(metadata.attachments)) return [];
  const imageIds = new Set(existing.filter((block) => block.kind === 'image').map((block) => fileIdFromPointer(block.assetPointer)));
  const blocks = [];
  for (const attachment of metadata.attachments) {
    if (!isObject(attachment)) continue;
    if (typeof attachment.id === 'string' && imageIds.has(attachment.id)) continue;
    blocks.push({
      kind: 'file',
      name: firstString(attachment.name, attachment.file_name) || 'file',
      size: finiteOrNull(attachment.size),
      mime: firstString(attachment.mime_type, attachment.mimeType) || null,
    });
  }
  return blocks;
}

function reasoningFromThoughts(content, metadata) {
  const duration = finiteOrNull(metadata.finished_duration_sec);
  const thoughts = Array.isArray(content.thoughts) ? content.thoughts.filter(isObject) : [];
  const blocks = thoughts.map((thought) => ({
    kind: 'reasoning',
    markdown: str(thought.content),
    summary: firstString(thought.summary) || null,
    durationSec: null,
  }));
  if (!blocks.length && str(content.text)) blocks.push({ kind: 'reasoning', markdown: content.text, summary: null, durationSec: null });
  if (blocks.length) blocks[blocks.length - 1].durationSec = duration;
  return blocks;
}

function toolOutputText(content, metadata) {
  const type = str(content.content_type);
  if (type === 'execution_output') return str(content.text);
  if (type === 'tether_browsing_display') return firstString(content.result, content.summary);
  if (type === 'tether_quote') {
    return [str(content.title), str(content.url), str(content.text)].filter(Boolean).join('\n');
  }
  if (type === 'text' || type === 'multimodal_text') {
    const text = stringParts(content).join('');
    if (text) return text;
  } else if (typeof content.text === 'string' && content.text) {
    return content.text;
  }
  for (const key of ['search_result_groups', 'aggregate_result', 'tether_browsing_display']) {
    if (metadata[key] !== undefined && metadata[key] !== null) return safeStringify(metadata[key]);
  }
  return '';
}

function toolResultIsError(raw, content, metadata) {
  if (metadata.is_error === true) return true;
  const aggregate = isObject(metadata.aggregate_result) ? metadata.aggregate_result : null;
  if (aggregate && (aggregate.status === 'failed' || aggregate.status === 'error' || isObject(aggregate.in_kernel_exception))) return true;
  return raw.status === 'failed';
}

function toolCallBlocksFromArray(calls) {
  const blocks = [];
  for (const call of calls) {
    if (!isObject(call)) continue;
    const fn = isObject(call.function) ? call.function : {};
    const args = call.arguments ?? fn.arguments ?? call.input ?? '';
    const input = typeof args === 'string' ? args : safeStringify(args);
    blocks.push({
      kind: 'tool_call',
      tool: firstString(fn.name, call.name, call.recipient) || 'tool',
      callId: firstString(call.call_id, call.id) || null,
      input,
      language: guessLanguage(null, input),
    });
  }
  return blocks;
}

/**
 * @param {Record<string, any>} raw
 * @param {{ role: string, content: Record<string, any>, metadata: Record<string, any>, streaming: boolean }} ctx
 * @returns {Block[]}
 */
function contentBlocks(raw, { role, content, metadata, streaming }) {
  const type = str(content.content_type);
  const recipient = recipientOf(raw, content, metadata);
  const channel = firstString(raw.channel, metadata.channel);
  const callId = callIdOf(raw);

  if (type === 'system_error') {
    return [{ kind: 'error', message: firstString(content.text, content.name, content.message) || 'system_error' }];
  }
  if (type === 'thoughts' || type === 'thought') return reasoningFromThoughts(content, metadata);
  if (type === 'reasoning_recap') {
    return [{ kind: 'reasoning', markdown: '', summary: firstString(content.content, content.text) || null, durationSec: finiteOrNull(metadata.finished_duration_sec) }];
  }
  if (HIDDEN_CONTENT_TYPES.has(type)) return [];

  // Tool results (role tool or tool-only content types).
  if (role === 'tool' || type === 'execution_output' || type === 'tether_browsing_display' || type === 'tether_quote') {
    const tool = firstString(raw.author?.name, metadata.tool_name) || 'tool';
    const parts = Array.isArray(content.parts) ? content.parts : [];
    if (type === 'multimodal_text' && parts.some((part) => isObject(part))) {
      const blocks = [];
      const text = stringParts(content).join('');
      if (text) blocks.push({ kind: 'tool_result', tool, callId, output: text, isError: toolResultIsError(raw, content, metadata) });
      blocks.push(...partsToBlocks(parts.filter((part) => typeof part !== 'string'), () => [], { tool: true }));
      return blocks;
    }
    if (!['text', 'multimodal_text', 'execution_output', 'tether_browsing_display', 'tether_quote', 'code', ''].includes(type)) {
      return [unknownBlock(type, content)];
    }
    return [{ kind: 'tool_result', tool, callId, output: toolOutputText(content, metadata), isError: toolResultIsError(raw, content, metadata) }];
  }

  // Tool calls from the assistant.
  const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : Array.isArray(metadata.tool_calls) ? metadata.tool_calls : null;
  if (role === 'assistant' && calls && calls.length) return toolCallBlocksFromArray(calls);
  if (role === 'assistant' && ((recipient && recipient !== 'all') || type === 'code')) {
    const input = type === 'code' || typeof content.text === 'string' ? str(content.text) : stringParts(content).join('');
    return [{
      kind: 'tool_call',
      tool: recipient && recipient !== 'all' ? recipient : 'code',
      callId,
      input,
      language: guessLanguage(content.language, input),
    }];
  }

  // Reasoning channel.
  if (role === 'assistant' && (channel === 'analysis' || channel === 'reasoning') && (type === 'text' || type === '')) {
    const markdown = stringParts(content).join('') || str(content.text);
    return markdown || streaming ? [{ kind: 'reasoning', markdown, summary: null, durationSec: finiteOrNull(metadata.finished_duration_sec) }] : [];
  }

  if (type === 'text' || type === 'multimodal_text') {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const makeText = role === 'user'
      ? (text) => [textBlock(text)]
      : (text) => {
        const { markdown, citations } = extractCitations(text, metadata, { streaming });
        return markdown || citations.length ? [textBlock(markdown, citations)] : [];
      };
    return partsToBlocks(parts, makeText);
  }
  if (!type && content.parts === undefined && content.text === undefined) return [];
  return [unknownBlock(type, content)];
}

/**
 * Normalize one raw ChatGPT message object. Never throws.
 * @param {unknown} raw
 * @param {{ parentId?: string|null, source?: 'canonical'|'live' }} [context]
 * @returns {Message|null}
 */
export function normalizeMessage(raw, context = {}) {
  try {
    return normalizeUnsafe(raw, isObject(context) ? context : {});
  } catch {
    return null;
  }
}

function normalizeUnsafe(raw, context) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const content = isObject(raw.content) ? raw.content : {};
  const metadata = isObject(raw.metadata) ? raw.metadata : {};
  const role = roleOf(raw);
  const status = deriveStatus(raw, content, metadata);
  const streaming = status === 'streaming';
  let blocks;
  if (raw.content !== undefined && raw.content !== null && !isObject(raw.content)) blocks = [unknownBlock('invalid', raw.content)];
  else blocks = contentBlocks(raw, { role, content, metadata, streaming });
  if (role === 'user' || role === 'assistant') blocks = blocks.concat(attachmentBlocks(metadata, blocks));
  if (status === 'error' && !blocks.some((block) => block.kind === 'error')) {
    const error = metadata.error;
    const message = typeof error === 'string' ? error : isObject(error) ? firstString(error.message, error.code) : '';
    // Always surface the failure; the message is '' when the server gave none.
    blocks.push({ kind: 'error', message });
  }

  const recipient = recipientOf(raw, content, metadata);
  const type = str(content.content_type);
  const hidden = Boolean(
    metadata.is_visually_hidden_from_conversation === true ||
    HIDDEN_CONTENT_TYPES.has(type) ||
    (role === 'assistant' && HIDDEN_RECIPIENTS.has(recipient)) ||
    (role === 'system' && status !== 'error' && !blocks.length) ||
    (!blocks.length && status !== 'streaming'),
  );

  const contextParent = typeof context.parentId === 'string' && context.parentId ? context.parentId : null;
  const ownParent = firstString(metadata.parent_id, raw.parent_id) || null;
  let parentId = context.parentId === undefined ? ownParent : contextParent;
  if (parentId === raw.id) parentId = null;

  return {
    id: raw.id,
    parentId,
    role,
    status,
    blocks,
    hidden,
    model: firstString(metadata.model_slug, metadata.default_model_slug) || null,
    createdAt: finiteOrNull(raw.create_time),
    source: context.source === 'live' ? 'live' : 'canonical',
  };
}
