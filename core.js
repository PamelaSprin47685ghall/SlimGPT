export function decodeCaptureBody(capture) {
  if (!capture?.base64Encoded) return String(capture?.data ?? "");
  try {
    return atob(capture.data);
  } catch {
    return "";
  }
}

export function parseJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function parseWebMobilePartialConversation(text) {
  if (typeof text !== "string" || !text.includes("data-conversation=")) return null;
  const matches = [...text.matchAll(/\bdata-conversation="([^"]+)"/g)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const value = parseJson(decodeHtmlAttribute(matches[index][1]));
    if (!value?.backendConversationId || !Array.isArray(value.messages)) continue;
    return webMobileConversationToCanonical(value);
  }
  return null;
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => decodeCodePoint(code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => decodeCodePoint(code, 16))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function decodeCodePoint(value, radix) {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "\ufffd";
  return String.fromCodePoint(codePoint);
}

function webMobileConversationToCanonical(value) {
  const mapping = {};
  let parent = null;

  for (const item of value.messages) {
    if (!item?.id || !item?.role) continue;
    const nodeId = item.id;
    mapping[nodeId] = {
      id: nodeId,
      parent,
      children: [],
      message: {
        id: item.id,
        author: { role: item.role },
        content: {
          content_type: "text",
          parts: [typeof item.content === "string" ? item.content : ""],
        },
        status: "finished_successfully",
        end_turn: item.role === "assistant",
        metadata: item.renderedHtml ? { rendered_html: item.renderedHtml } : {},
      },
    };
    if (parent && mapping[parent]) mapping[parent].children.push(nodeId);
    parent = nodeId;
  }

  return {
    id: value.backendConversationId,
    title: value.title || "Untitled",
    mapping,
    current_node: parent,
    update_time: Date.now() / 1000,
    metadata: { source: "web-mobile-partial" },
  };
}

export function consumeSse(buffer, chunk, flush = false) {
  let source = String(buffer || "") + String(chunk || "");
  source = source.replace(/\r\n/g, "\n");
  const frames = [];

  while (true) {
    const boundary = source.indexOf("\n\n");
    if (boundary === -1) break;
    const block = source.slice(0, boundary);
    source = source.slice(boundary + 2);
    const frame = parseSseBlock(block);
    if (frame) frames.push(frame);
  }

  if (flush && source.trim()) {
    const frame = parseSseBlock(source);
    if (frame) frames.push(frame);
    source = "";
  }

  return { rest: source, frames };
}

function parseSseBlock(block) {
  const data = [];
  let event = "message";
  let id = null;
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
    else if (line.startsWith("id:")) id = line.slice(3).trim() || null;
  }
  if (!data.length) return null;
  const text = data.join("\n");
  return { event, id, data: text, json: parseJson(text) };
}

export function findConversationPayload(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (value.mapping && typeof value.mapping === "object" && value.current_node) return value;
  if (
    Array.isArray(value.messages) &&
    value.current_node &&
    (value.conversation_id || value.id) &&
    value.messages.some(looksLikeMessage)
  ) {
    return optimizedConversationToCanonical(value);
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findConversationPayload(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function optimizedConversationToCanonical(value) {
  const mapping = {};
  let previousId = null;

  for (const message of value.messages) {
    if (!looksLikeMessage(message)) continue;
    const id = String(message.id);
    const requestedParent = message.metadata?.parent_id || message.parent_id || null;
    const parent = requestedParent && requestedParent !== id
      ? String(requestedParent)
      : previousId;
    mapping[id] = {
      id,
      parent,
      children: [],
      message,
    };
    previousId = id;
  }

  for (const node of Object.values(mapping)) {
    if (node.parent && mapping[node.parent]) mapping[node.parent].children.push(node.id);
    else node.parent = null;
  }

  const { messages, conversation_id: conversationId, ...rest } = value;
  const currentNode = mapping[value.current_node] ? value.current_node : previousId;
  return {
    ...rest,
    id: value.id || conversationId,
    conversation_id: conversationId || value.id,
    mapping,
    current_node: currentNode,
  };
}

export function extractConversationItems(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return [];
  if (Array.isArray(value.items)) {
    const items = value.items.filter((item) => item && typeof item === "object" && item.id);
    if (items.length && items.some((item) => "title" in item || "update_time" in item || "create_time" in item)) {
      return items;
    }
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const items = extractConversationItems(child, depth + 1);
    if (items.length) return items;
  }
  return [];
}

export const THINKING_LEVELS = [
  { level: 1, id: 'instant', slug: 'instant', model: 'gpt-5.6', effort: 'none', label: 'Instant', cnLabel: '即时', icon: '⚡', tip: 'GPT-5.6 极速响应，日常简单问答' },
  { level: 2, id: 'medium', slug: 'medium', model: 'gpt-5.6', effort: 'medium', label: 'Medium', cnLabel: '标准', icon: '✨', tip: 'GPT-5.6 标准思考，平衡速度与深度（默认）' },
  { level: 3, id: 'high', slug: 'high', model: 'gpt-5.6', effort: 'high', label: 'High', cnLabel: '高', icon: '🧠', tip: 'GPT-5.6 扩展思考，复杂逻辑与多步推理' },
  { level: 4, id: 'extra_high', slug: 'extra_high', model: 'gpt-5.6', effort: 'xhigh', label: 'Extra High', cnLabel: '超高', icon: '🔥', tip: 'GPT-5.6 强力思考，高难度任务与深度代码分析' },
  { level: 5, id: 'pro', slug: 'pro', model: 'gpt-5.6-pro', effort: 'max', label: 'Pro', cnLabel: 'Pro', icon: '👑', tip: 'GPT-5.6 Sol Pro 专家级计算，最深层学术与代码推理' },
];

export function getThinkingLevel(value) {
  const num = Number(value);
  if (Number.isInteger(num) && num >= 1 && num <= 5) {
    return THINKING_LEVELS[num - 1];
  }
  const str = String(value || '').toLowerCase().trim();
  if (str === 'none' || str === 'instant') return THINKING_LEVELS[0];
  if (str === 'medium' || str === 'auto' || str === 'standard' || str === 'balanced') return THINKING_LEVELS[1];
  if (str === 'high' || str === 'deep' || str === 'extended') return THINKING_LEVELS[2];
  if (str === 'extra_high' || str === 'extra high' || str === 'xhigh' || str === 'heavy') return THINKING_LEVELS[3];
  if (str === 'pro' || str === 'max') return THINKING_LEVELS[4];
  const found = THINKING_LEVELS.find((item) => item.id === str || item.slug === str || item.effort === str);
  return found || THINKING_LEVELS[1]; // Default level 2 (Medium)
}

export function extractModelsList(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return [];
  let raw = [];
  if (Array.isArray(value.models)) raw = value.models;
  else if (Array.isArray(value.data?.models)) raw = value.data.models;
  else if (Array.isArray(value.items) && value.items.some((item) => item?.slug || (item?.id && item?.tags))) {
    raw = value.items;
  }

  if (raw.length) {
    return raw
      .filter((item) => item && (item.slug || item.id))
      .map((item) => {
        const slug = String(item.slug || item.id || "").trim();
        const title = String(item.title || item.name || formatDefaultModelTitle(slug)).trim();
        const description = String(item.description || "").trim();
        const tags = Array.isArray(item.tags) ? item.tags : [];
        const isReasoning =
          tags.includes("reasoning") ||
          slug.startsWith("o1") ||
          slug.startsWith("o3") ||
          slug.startsWith("o4") ||
          slug === "auto" ||
          Boolean(item.qualitative_properties?.reasoning || item.qualitative_properties?.reasoning_effort);

        return {
          id: slug,
          slug,
          label: title,
          description,
          tags,
          isReasoning,
          qualitativeProperties: item.qualitative_properties || {},
        };
      });
  }

  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = extractModelsList(child, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function formatDefaultModelTitle(slug) {
  const map = {
    "gpt-5.6": "GPT-5.6 Sol",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-pro": "GPT-5.6 Sol Pro",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5": "GPT-5.6",
    auto: "GPT-5.6 (Auto)",
  };
  return map[slug] || slug;
}

export function findMessageEvents(value) {
  const output = [];
  collectMessageEvents(value, 0, { conversationId: null, conflicted: false }, output);
  return dedupeMessageEvents(output);
}

function collectMessageEvents(value, depth, inheritedScope, output) {
  if (!value || typeof value !== "object" || depth > 6) return;
  const directConversationId = value.conversation_id || value.conversationId || null;
  const scope = mergeConversationScope(inheritedScope, directConversationId);

  if (looksLikeMessage(value.message)) {
    const messageScope = mergeConversationScope(
      scope,
      value.message.conversation_id || value.message.conversationId || null,
    );
    output.push({
      message: value.message,
      conversationId: messageScope.conversationId,
      conversationIdConflict: messageScope.conflicted,
    });
  }
  if (looksLikeMessage(value) && (value.author || value.content)) {
    output.push({
      message: value,
      conversationId: scope.conversationId,
      conversationIdConflict: scope.conflicted,
    });
    return;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    collectMessageEvents(child, depth + 1, scope, output);
  }
}

function mergeConversationScope(scope, candidate) {
  if (scope.conflicted || typeof candidate !== "string" || !candidate.trim()) return scope;
  const conversationId = candidate.trim();
  if (scope.conversationId && scope.conversationId !== conversationId) {
    return { conversationId: null, conflicted: true };
  }
  return scope.conversationId === conversationId
    ? scope
    : { conversationId, conflicted: false };
}

function dedupeMessageEvents(events) {
  const seen = new Set();
  return events.filter(({ message, conversationId, conversationIdConflict }) => {
    const id = message?.id;
    if (!id) return false;
    const scope = conversationIdConflict ? "conflict" : (conversationId || "unscoped");
    const key = `${scope}\u0000${id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function looksLikeMessage(value) {
  return Boolean(value && typeof value === "object" && value.id && (value.author || value.content));
}

export function conversationIdFromPayload(payload, fallbackUrl = "") {
  const direct = payload?.conversation_id || payload?.conversationId || payload?.id;
  if (typeof direct === "string" && direct) return direct;
  return conversationIdFromUrl(fallbackUrl);
}

export function resolveConversationScope(...candidates) {
  let conversationId = null;
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const normalized = candidate.trim();
    if (conversationId && conversationId !== normalized) {
      return { conversationId: null, conflicted: true };
    }
    conversationId = normalized;
  }
  return { conversationId, conflicted: false };
}

export function conversationIdFromUrl(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url, "https://chatgpt.com/");
    const routeMatch = parsed.pathname.match(/\/(?:c|uc)\/([^/?#]+)/);
    if (routeMatch) return routeMatch[1];
    const apiMatch = parsed.pathname.match(/^\/backend-api\/(?:f\/)?conversations?\/([^/?#]+)\/?$/);
    if (apiMatch && !["prepare", "resume", "runtime"].includes(apiMatch[1])) return apiMatch[1];
  } catch {
    // Ignore malformed URLs from transient capture records.
  }
  return null;
}

export function buildConversationView(payload, terminalId = null) {
  if (!payload?.mapping || typeof payload.mapping !== "object") return [];
  const mapping = payload.mapping;
  let cursor = terminalId || payload.current_node;
  const chain = [];
  const visited = new Set();

  while (cursor && mapping[cursor] && !visited.has(cursor)) {
    visited.add(cursor);
    const node = mapping[cursor];
    chain.push(node);
    cursor = node.parent;
  }
  chain.reverse();

  return chain
    .filter((node) => node?.message && !node.message.metadata?.is_visually_hidden_from_conversation)
    .map((node) => messageNodeToView(node, mapping));
}

export function groupConversationTurns(messages) {
  const source = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const turns = [];
  let current = null;

  for (const message of source) {
    if (message?.role === "user") {
      current = {
        id: `turn-${message.id || message.nodeId || turns.length}`,
        user: message,
        replies: [],
      };
      turns.push(current);
      continue;
    }

    if (!current) {
      current = {
        id: `turn-preamble-${message?.id || message?.nodeId || turns.length}`,
        user: null,
        replies: [],
      };
      turns.push(current);
    }
    appendTurnReply(current, message);
  }

  return turns;
}

function appendTurnReply(turn, message) {
  if (isTransientThinkingMessage(message)) {
    turn.replies.push(message);
    return;
  }
  let index = turn.replies.length;
  while (index > 0 && isTransientThinkingMessage(turn.replies[index - 1])) index -= 1;
  turn.replies.splice(index, 0, message);
}

function isTransientThinkingMessage(message) {
  if (String(message?.text || "").trim() || message?.thought || message?.tool || message?.unrecognized) return false;
  if (message?.isThinking) return true;
  return message?.status === "in_progress" || message?.status === "thinking" || message?.status === "live";
}

export function isAsyncReasoningMessage(message) {
  if (!message || typeof message !== "object") return false;
  const metadata = message.metadata || {};
  return Boolean(
    metadata.initial_text ||
    metadata.finished_text ||
    (metadata.async_source && metadata.cot_version)
  );
}

export function messageNodeToView(node, mapping) {
  const message = node.message || {};
  const siblings = node.parent && mapping[node.parent]?.children
    ? mapping[node.parent].children.filter((id) => mapping[id]?.message)
    : [node.id];
  const siblingIndex = Math.max(0, siblings.indexOf(node.id));
  const metadata = message.metadata || {};
  const isAsyncReasoning = isAsyncReasoningMessage(message);
  const thought = extractThought(message);
  const tool = getToolMessageInfo(message);
  const text = contentToText(message.content, metadata);
  const status = message.status || (metadata.is_error ? "failed" : null);
  const error = status === "failed" || Boolean(metadata.is_error) || Boolean(metadata.error);
  const model = metadata.model_slug || metadata.default_model_slug || metadata.model || null;
  const reasoningEffort = metadata.thinking_effort || metadata.reasoning_effort || metadata.reasoning_effort_level || null;
  const thinkingLevel = metadata.thinking_level ? getThinkingLevel(metadata.thinking_level) : (reasoningEffort ? getThinkingLevel(reasoningEffort) : null);
  const durationSec = metadata.finished_duration_sec ?? null;
  const thinkingDuration = formatThinkingDuration(durationSec, metadata.reasoning_start_time, metadata.reasoning_end_time, metadata);

  const ct = String(message.content?.content_type || "");
  const isSpinner = ct === "tether_browsing_display" && !message.content?.result && !message.content?.summary;

  const role = isAsyncReasoning ? "assistant" : (message.author?.role || "unknown");

  return {
    id: message.id || node.id,
    nodeId: node.id,
    role,
    name: message.author?.name || null,
    text,
    thought,
    thinkingDuration,
    createTime: message.create_time || null,
    status,
    error,
    endTurn: message.end_turn ?? null,
    siblingIndex,
    siblingCount: siblings.length,
    siblingNodeIds: siblings,
    metadata,
    tool,
    model,
    reasoningEffort,
    thinkingLevel,
    unrecognized: !text && !thought && !tool && !isSpinner && hasNonTextExtras(message),
    isThinking: (status === "in_progress" || status === "thinking") && !text && !tool && !hasNonTextExtras(message),
  };
}

export function extractThought(message) {
  if (!message || typeof message !== "object") return null;
  const metadata = message.metadata || {};

  if (isAsyncReasoningMessage(message)) {
    const content = message.content;
    if (content && Array.isArray(content.parts)) {
      const parts = content.parts.map(partToThoughtText).filter(Boolean);
      if (parts.length) return parts.join("\n\n").trim();
    }
    if (typeof content?.text === "string" && content.text.trim()) {
      return content.text.trim();
    }
    if (metadata.finished_text && metadata.finished_text !== "已完成推理") {
      return metadata.finished_text;
    }
    if (metadata.initial_text) {
      return metadata.initial_text;
    }
    return null;
  }

  for (const key of ["thought", "reasoning", "reasoning_content"]) {
    if (typeof metadata[key] === "string" && metadata[key].trim()) {
      return metadata[key].trim();
    }
  }

  const content = message.content;
  if (!content || typeof content !== "object") return null;

  const contentType = String(content.content_type || "");

  if (contentType === "thought" || contentType === "thoughts") {
    if (Array.isArray(content.thoughts)) {
      const parts = [];
      for (const item of content.thoughts) {
        if (!item || typeof item !== "object") continue;
        const body = typeof item.content === "string" ? item.content.trim() : "";
        const summary = typeof item.summary === "string" ? item.summary.trim() : "";
        if (summary && body) {
          parts.push(`> **${summary}**\n\n${body}`);
        } else if (body) {
          parts.push(body);
        } else if (summary) {
          parts.push(`> **${summary}**`);
        }
      }
      if (parts.length) return parts.join("\n\n");
    }

    if (typeof content.text === "string" && content.text.trim()) {
      return content.text.trim();
    }
    if (Array.isArray(content.parts)) {
      const parts = content.parts.map(partToThoughtText).filter(Boolean);
      if (parts.length) return parts.join("\n\n");
    }
  }

  if (contentType === "reasoning_recap") {
    const recap = typeof content.content === "string" ? content.content.trim() : "";
    if (recap) return `⏱️ ${recap}`;
  }

  if (Array.isArray(content.parts)) {
    const thoughtParts = [];
    for (const part of content.parts) {
      if (part && typeof part === "object") {
        if (part.content_type === "thought" || part.content_type === "thoughts" || part.thought) {
          const t = partToThoughtText(part);
          if (t && t.trim()) thoughtParts.push(t.trim());
        }
      }
    }
    if (thoughtParts.length) return thoughtParts.join("\n\n");
  }

  return null;
}

function partToThoughtText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.thought === "string") return part.thought;
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (typeof part.summary === "string") return `> **${part.summary}**`;
  return "";
}

export function getToolMessageInfo(message) {
  if (!message || typeof message !== "object") return null;
  if (isAsyncReasoningMessage(message)) return null;

  const role = message.author?.role || "unknown";
  const content = message.content && typeof message.content === "object" ? message.content : {};
  const metadata = message.metadata && typeof message.metadata === "object" ? message.metadata : {};
  const authorMetadata = message.author?.metadata && typeof message.author.metadata === "object"
    ? message.author.metadata
    : {};
  const recipient = firstNonEmptyString(message.recipient, metadata.recipient, content.recipient);
  const realAuthor = firstNonEmptyString(authorMetadata.real_author, metadata.real_author);
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : Array.isArray(metadata.tool_calls)
      ? metadata.tool_calls
      : Array.isArray(content.tool_calls)
        ? content.tool_calls
        : null;
  const contentType = String(content.content_type || "");

  let kind = null;
  if (
    role === "tool" ||
    contentType === "execution_output" ||
    contentType === "tether_browsing_display" ||
    contentType === "tether_quote" ||
    realAuthor.startsWith("tool:")
  ) {
    kind = "tool-result";
  } else if (
    toolCalls?.length ||
    (role === "assistant" && recipient && recipient !== "all")
  ) {
    kind = "tool-call";
  }
  if (!kind) return null;

  const callName = toolCalls?.[0]?.function?.name || toolCalls?.[0]?.name || "";
  const realAuthorName = realAuthor.startsWith("tool:") ? realAuthor.slice(5) : "";
  const name = firstNonEmptyString(
    kind === "tool-call" ? recipient : "",
    message.author?.name,
    metadata.tool_name,
    content.name,
    callName,
    realAuthorName,
    recipient,
  ) || "tool";

  const title = (metadata.reasoning_title || "").trim() || null;

  return {
    kind,
    name,
    title,
    recipient: recipient || null,
    contentType: contentType || null,
    payload: extractToolPayload(message, toolCalls),
  };
}

function extractToolPayload(message, toolCalls) {
  if (toolCalls?.length) return toolCalls.length === 1 ? toolCalls[0] : { calls: toolCalls };
  const content = message.content;
  const metadata = message.metadata || {};

  if (Array.isArray(metadata.search_result_groups) && metadata.search_result_groups.length) {
    return {
      queries: metadata.search_queries || undefined,
      results: metadata.search_result_groups,
    };
  }

  if (Array.isArray(metadata.inline_cot_expandable_content?.search_result_groups)) {
    return {
      results: metadata.inline_cot_expandable_content.search_result_groups,
    };
  }

  if (metadata.aggregate_result && typeof metadata.aggregate_result === "object") {
    if (content?.text) {
      return content.text;
    }
    return metadata.aggregate_result;
  }

  if (content == null) return "";
  if (typeof content !== "object") return content;
  if (content.result != null && content.result !== "") return content.result;
  if (content.text != null && content.text !== "") return content.text;

  if (Array.isArray(content.parts)) {
    const validParts = content.parts.filter((p) => p !== "" && p != null);
    if (validParts.length === 1) return validParts[0];
    if (validParts.length > 1) return { parts: validParts };
  }

  const payload = {};
  for (const [key, value] of Object.entries(content)) {
    if (["content_type", "language", "response_format_name"].includes(key)) continue;
    if (value !== "" && value != null) payload[key] = value;
  }
  return Object.keys(payload).length ? payload : "";
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function contentToText(content, metadata = {}) {
  if (metadata && (metadata.initial_text || metadata.finished_text || (metadata.async_source && metadata.cot_version))) {
    return "";
  }

  let text = "";
  if (content) {
    if (typeof content === "string") text = content;
    else if (typeof content.text === "string") text = content.text;
    else if (Array.isArray(content.parts)) {
      text = content.parts.map(partToText).filter(Boolean).join("\n");
    } else if (content.result != null) {
      text = typeof content.result === "string" ? content.result : JSON.stringify(content.result, null, 2);
    }
  }

  if (Array.isArray(metadata?.attachments) && metadata.attachments.length) {
    const attachmentLabels = metadata.attachments.map(formatAttachmentBadge).filter(Boolean);
    if (attachmentLabels.length) {
      const attachBlock = attachmentLabels.join("\n");
      text = text.trim() ? `${text}\n\n${attachBlock}` : attachBlock;
    }
  }

  text = cleanCitationMarkers(text);
  return text;
}

function partToText(part) {
  if (typeof part === "string") return part;
  if (typeof part === "number" || typeof part === "boolean") return String(part);
  if (!part || typeof part !== "object") return "";
  if (part.content_type === "thought" || part.content_type === "thoughts" || part.thought) return "";
  if (part.content_type === "image_asset_pointer") {
    const mime = part.mime_type || "image";
    const dim = part.width && part.height ? ` (${part.width}×${part.height})` : "";
    return `🖼️ [图片: ${mime}${dim}]`;
  }
  if (typeof part.text === "string" && part.text.trim()) return part.text;
  if (typeof part.transcript === "string" && part.transcript.trim()) return part.transcript;
  if (Array.isArray(part.parts)) return part.parts.map(partToText).filter(Boolean).join("\n");
  const attachment = attachmentLabel(part.asset_pointer);
  if (attachment) return attachment;
  if (typeof part.content === "string") return part.content;
  if (typeof part.summary === "string" && part.summary.trim()) return part.summary;
  return "";
}

function attachmentLabel(pointer) {
  if (!pointer) return "";
  if (typeof pointer === "string") return `📎 [附件: ${pointer}]`;
  if (typeof pointer !== "object") return "";
  const id = pointer.asset_pointer || pointer.id || pointer.dalle_token || null;
  if (!id) return "";
  const kind = pointer.content_type ? ` (${pointer.content_type})` : "";
  return `📎 [附件: ${String(id).slice(0, 96)}${kind}]`;
}

function formatAttachmentBadge(att) {
  if (!att || typeof att !== "object") return "";
  const name = att.name || "file";
  const sizeStr = formatFileSize(att.size);
  return `📎 **[附件: ${name}${sizeStr ? ` (${sizeStr})` : ""}]**`;
}

function formatFileSize(bytes) {
  if (typeof bytes !== "number" || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function cleanCitationMarkers(text) {
  if (!text || typeof text !== "string") return text;
  return text
    .replace(/[\uE200\uE202\uE201\uE203]cite[\uE200\uE202\uE201\uE203][^\uE201]*[\uE201]?/g, "")
    .replace(/[\uE200\uE202\uE201\uE203]filecite[\uE200\uE202\uE201\uE203][^\uE201]*[\uE201]?/g, "")
    .replace(/cite[^]*/g, "")
    .replace(/filecite[^]*/g, "")
    .replace(/[^]*/g, "");
}

export function formatThinkingDuration(durationSec, startTime, endTime, metadata = {}) {
  let sec = typeof durationSec === "number" && Number.isFinite(durationSec) ? durationSec : null;
  if (sec == null && typeof startTime === "number" && typeof endTime === "number" && endTime >= startTime) {
    sec = Math.round(endTime - startTime);
  }
  if (sec == null && typeof metadata?.finished_text === "string") {
    const match = metadata.finished_text.match(/(?:思考了|Worked for)\s*([\dsmh分秒\s]+)/i);
    if (match) return match[1].trim();
  }
  if (sec == null || sec <= 0) return null;
  if (sec < 60) return `${sec} 秒`;
  const mins = Math.floor(sec / 60);
  const remainSec = sec % 60;
  return remainSec > 0 ? `${mins} 分 ${remainSec} 秒` : `${mins} 分钟`;
}

export function hasNonTextExtras(message) {
  const content = message?.content;
  if (!content || typeof content !== "object") return false;
  const contentType = String(content.content_type || "");

  const knownTypes = [
    "text",
    "thought",
    "thoughts",
    "reasoning_recap",
    "code",
    "execution_output",
    "multimodal_text",
    "tether_browsing_display",
    "tether_quote",
    "audio_transcript",
  ];

  if (Array.isArray(content.parts)) {
    let renderedText = false;
    let sawExtras = false;
    for (const part of content.parts) {
      if (typeof part === "string") {
        if (part.trim()) renderedText = true;
        continue;
      }
      if (!part || typeof part !== "object") continue;
      if (part.content_type === "thought" || part.content_type === "thoughts" || part.thought) continue;
      if (typeof part.text === "string" && part.text.trim()) {
        renderedText = true;
        continue;
      }
      if (typeof part.transcript === "string" && part.transcript.trim()) {
        renderedText = true;
        continue;
      }
      if (typeof part.content === "string" && part.content.trim()) {
        renderedText = true;
        continue;
      }
      if (part.asset_pointer || part.audio || part.image || part.upload_status || (part.content_type && part.content_type !== "text")) {
        sawExtras = true;
      }
    }
    if (renderedText) return false;
    if (sawExtras) return true;
    if (knownTypes.includes(contentType) || !contentType) return false;
  }

  const selfRendered = typeof content.transcript === "string" && content.transcript.trim();
  if (contentType && !knownTypes.includes(contentType) && content.text == null && content.result == null && !selfRendered) {
    return true;
  }
  if (Array.isArray(content.files) && content.files.length) return true;
  return false;
}

export function conversationThinkingLevel(payload) {
  if (!payload?.mapping || typeof payload.mapping !== "object") return null;
  const rows = buildConversationView(payload, payload.current_node);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const level = rows[index]?.thinkingLevel;
    if (level?.level) return level;
  }
  return null;
}

export function stepConversationBranch(payload, nodeId, delta) {
  const mapping = payload?.mapping;
  const node = mapping?.[nodeId];
  const parent = node?.parent ? mapping[node.parent] : null;
  if (!node || !parent?.children?.length) return payload?.current_node || nodeId;

  const siblings = parent.children.filter((id) => mapping[id]?.message);
  if (siblings.length < 2) return payload?.current_node || nodeId;
  const index = Math.max(0, siblings.indexOf(nodeId));
  const next = siblings[Math.max(0, Math.min(siblings.length - 1, index + delta))];
  return descendToLeaf(mapping, next);
}

function descendToLeaf(mapping, start) {
  let cursor = start;
  const visited = new Set();
  while (cursor && mapping[cursor] && !visited.has(cursor)) {
    visited.add(cursor);
    const children = mapping[cursor].children?.filter((id) => mapping[id]) || [];
    if (!children.length) break;
    cursor = children[children.length - 1];
  }
  return cursor;
}

export function upsertLiveMessage(messages, rawMessage) {
  if (!rawMessage?.id) return messages;
  const metadata = rawMessage.metadata || {};
  const isAsyncReasoning = isAsyncReasoningMessage(rawMessage);
  const thought = extractThought(rawMessage);
  const tool = getToolMessageInfo(rawMessage);
  const text = contentToText(rawMessage.content, metadata);
  const status = rawMessage.status || (metadata.is_error ? "failed" : null);
  const error = status === "failed" || Boolean(metadata.is_error) || Boolean(metadata.error);
  const model = metadata.model_slug || metadata.default_model_slug || metadata.model || null;
  const reasoningEffort = metadata.thinking_effort || metadata.reasoning_effort || metadata.reasoning_effort_level || null;
  const thinkingLevel = metadata.thinking_level ? getThinkingLevel(metadata.thinking_level) : (reasoningEffort ? getThinkingLevel(reasoningEffort) : null);
  const durationSec = metadata.finished_duration_sec ?? null;
  const thinkingDuration = formatThinkingDuration(durationSec, metadata.reasoning_start_time, metadata.reasoning_end_time, metadata);

  const ct = String(rawMessage.content?.content_type || "");
  const isSpinner = ct === "tether_browsing_display" && !rawMessage.content?.result && !rawMessage.content?.summary;
  const role = isAsyncReasoning ? "assistant" : (rawMessage.author?.role || "assistant");

  const item = {
    id: rawMessage.id,
    nodeId: rawMessage.id,
    role,
    name: rawMessage.author?.name || null,
    text,
    thought,
    thinkingDuration,
    createTime: rawMessage.create_time || null,
    status,
    error,
    endTurn: rawMessage.end_turn ?? null,
    siblingIndex: 0,
    siblingCount: 1,
    siblingNodeIds: [rawMessage.id],
    metadata,
    tool,
    model,
    reasoningEffort,
    thinkingLevel,
    conversationId: null,
    unrecognized: !text && !thought && !tool && !isSpinner && hasNonTextExtras(rawMessage),
    isThinking: (status === "in_progress" || status === "thinking") && !text && !tool && !hasNonTextExtras(rawMessage),
    live: true,
  };

  const index = messages.findIndex((message) => message.id === item.id);
  if (index === -1) return [...messages, item];
  const next = messages.slice();
  const previous = next[index];
  // Lifecycle fields only move forward: a status-less capture (DOM observer)
  // or an early in_progress delta must never regress a finished message.
  const finished = (message) => message?.status === "finished_successfully" || message?.status === "finished" || message?.endTurn === true;
  const mergedStatus = item.status ?? previous.status ?? null;
  const mergedEndTurn = item.endTurn ?? previous.endTurn ?? null;
  next[index] = {
    ...previous,
    ...item,
    status: mergedStatus,
    endTurn: mergedEndTurn,
    error: item.error || previous.error || false,
    name: item.name || previous.name || null,
    thought: item.thought || previous.thought || null,
    thinkingDuration: item.thinkingDuration || previous.thinkingDuration || null,
    text: item.text || previous.text || "",
    model: item.model || previous.model || null,
    reasoningEffort: item.reasoningEffort || previous.reasoningEffort || null,
    thinkingLevel: item.thinkingLevel || previous.thinkingLevel || null,
    metadata: Object.keys(item.metadata || {}).length ? item.metadata : (previous.metadata || {}),
    tool: item.tool || previous.tool || null,
    isThinking: finished(previous) ? false : item.isThinking,
    unrecognized: item.unrecognized || previous.unrecognized || false,
  };
  if (finished(previous) && !finished({ status: mergedStatus, endTurn: mergedEndTurn })) {
    // Regressed (e.g. a stale in_progress capture): restore the finished state.
    next[index] = {
      ...next[index],
      status: previous.status,
      endTurn: previous.endTurn,
    };
  }
  return next;
}

export function estimateMessageHeight(message) {
  const text = message?.text || "";
  const lines = text.split("\n").length;
  const wrappedLines = Math.ceil(text.length / 82);
  const codeFences = (text.match(/```/g) || []).length;
  return Math.max(84, Math.min(920, 72 + Math.max(lines, wrappedLines) * 21 + codeFences * 24));
}

export function fingerprintCapture(capture, text) {
  const body = String(text || "");
  return [
    capture?.url || "",
    capture?.transport || "",
    capture?.conversationId || "",
    capture?.conversationIdConflict ? "conflict" : "",
    body.length,
    body.slice(0, 96),
    body.slice(-96),
  ].join("|");
}
