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
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    const found = findConversationPayload(child, depth + 1);
    if (found) return found;
  }
  return null;
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

export function findMessageEvents(value, depth = 0, output = []) {
  if (!value || typeof value !== "object" || depth > 6) return output;
  if (looksLikeMessage(value.message)) {
    output.push({
      message: value.message,
      conversationId: value.conversation_id || value.conversationId || null,
    });
  }
  if (looksLikeMessage(value) && (value.author || value.content)) {
    output.push({ message: value, conversationId: null });
    return output;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== "object") continue;
    findMessageEvents(child, depth + 1, output);
  }
  return dedupeMessageEvents(output);
}

function dedupeMessageEvents(events) {
  const seen = new Set();
  return events.filter(({ message }) => {
    const id = message?.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
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

export function conversationIdFromUrl(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url, "https://chatgpt.com/");
    const routeMatch = parsed.pathname.match(/\/(?:c|uc)\/([^/?#]+)/);
    if (routeMatch) return routeMatch[1];
    const apiMatch = parsed.pathname.match(/\/conversation\/([^/?#]+)/);
    if (apiMatch) return apiMatch[1];
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
    .filter((node) => node?.message)
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
    current.replies.push(message);
  }

  return turns;
}

export function messageNodeToView(node, mapping) {
  const message = node.message || {};
  const siblings = node.parent && mapping[node.parent]?.children
    ? mapping[node.parent].children.filter((id) => mapping[id]?.message)
    : [node.id];
  const siblingIndex = Math.max(0, siblings.indexOf(node.id));
  const thought = extractThought(message);
  const tool = getToolMessageInfo(message);
  const text = contentToText(message.content);
  const status = message.status || (message.metadata?.is_error ? "failed" : null);
  const error = status === "failed" || Boolean(message.metadata?.is_error) || Boolean(message.metadata?.error);
  const metadata = message.metadata || {};
  const model = metadata.model_slug || metadata.default_model_slug || metadata.model || null;
  const reasoningEffort = metadata.reasoning_effort || metadata.reasoning_effort_level || null;
  const thinkingLevel = metadata.thinking_level ? getThinkingLevel(metadata.thinking_level) : (reasoningEffort ? getThinkingLevel(reasoningEffort) : null);

  return {
    id: message.id || node.id,
    nodeId: node.id,
    role: message.author?.role || "unknown",
    name: message.author?.name || null,
    text,
    thought,
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
    isThinking: (status === "in_progress" || status === "thinking") && !text && !tool,
  };
}

export function extractThought(message) {
  if (!message || typeof message !== "object") return null;
  const metadata = message.metadata || {};
  if (typeof metadata.thought === "string" && metadata.thought.trim()) {
    return metadata.thought.trim();
  }
  if (typeof metadata.reasoning === "string" && metadata.reasoning.trim()) {
    return metadata.reasoning.trim();
  }
  if (typeof metadata.reasoning_content === "string" && metadata.reasoning_content.trim()) {
    return metadata.reasoning_content.trim();
  }
  const content = message.content;
  if (content && typeof content === "object") {
    if (content.content_type === "thought") {
      const text = typeof content.text === "string" ? content.text : (Array.isArray(content.parts) ? content.parts.map(partToThoughtText).filter(Boolean).join("\n") : "");
      return text.trim() || null;
    }
    if (Array.isArray(content.parts)) {
      const thoughtParts = [];
      for (const part of content.parts) {
        if (part && typeof part === "object") {
          if (part.content_type === "thought" || part.thought) {
            const t = partToThoughtText(part);
            if (t && t.trim()) thoughtParts.push(t.trim());
          }
        }
      }
      if (thoughtParts.length) return thoughtParts.join("\n\n");
    }
  }
  return null;
}

function partToThoughtText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.thought === "string") return part.thought;
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  return "";
}

export function getToolMessageInfo(message) {
  if (!message || typeof message !== "object") return null;
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

  return {
    kind,
    name,
    recipient: recipient || null,
    contentType: contentType || null,
    payload: extractToolPayload(message, toolCalls),
  };
}

function extractToolPayload(message, toolCalls) {
  if (toolCalls?.length) return toolCalls.length === 1 ? toolCalls[0] : { calls: toolCalls };
  const content = message.content;
  if (content == null) return "";
  if (typeof content !== "object") return content;
  if (content.result != null) return content.result;
  if (content.text != null) return content.text;
  if (Array.isArray(content.parts)) {
    if (content.parts.length === 1) return content.parts[0];
    return { parts: content.parts };
  }
  const payload = {};
  for (const [key, value] of Object.entries(content)) {
    if (["content_type", "language", "response_format_name"].includes(key)) continue;
    payload[key] = value;
  }
  return Object.keys(payload).length ? payload : "";
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function contentToText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (typeof content.text === "string") return content.text;
  if (Array.isArray(content.parts)) {
    return content.parts.map(partToText).filter(Boolean).join("\n");
  }
  if (content.result != null) return typeof content.result === "string" ? content.result : JSON.stringify(content.result, null, 2);
  return "";
}

function partToText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (part.content_type === "thought" || part.thought) return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (part.asset_pointer) return `[Attachment: ${part.asset_pointer}]`;
  return "";
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
  const thought = extractThought(rawMessage);
  const tool = getToolMessageInfo(rawMessage);
  const text = contentToText(rawMessage.content);
  const status = rawMessage.status || (rawMessage.metadata?.is_error ? "failed" : null);
  const error = status === "failed" || Boolean(rawMessage.metadata?.is_error) || Boolean(rawMessage.metadata?.error);
  const metadata = rawMessage.metadata || {};
  const model = metadata.model_slug || metadata.default_model_slug || metadata.model || null;
  const reasoningEffort = metadata.reasoning_effort || metadata.reasoning_effort_level || null;
  const thinkingLevel = metadata.thinking_level ? getThinkingLevel(metadata.thinking_level) : (reasoningEffort ? getThinkingLevel(reasoningEffort) : null);

  const item = {
    id: rawMessage.id,
    nodeId: rawMessage.id,
    role: rawMessage.author?.role || "assistant",
    name: rawMessage.author?.name || null,
    text,
    thought,
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
    isThinking: (status === "in_progress" || status === "thinking") && !text && !tool,
    live: true,
  };

  const index = messages.findIndex((message) => message.id === item.id);
  if (index === -1) return [...messages, item];
  const next = messages.slice();
  const previous = next[index];
  next[index] = {
    ...previous,
    ...item,
    name: item.name || previous.name || null,
    thought: item.thought || previous.thought || null,
    model: item.model || previous.model || null,
    reasoningEffort: item.reasoningEffort || previous.reasoningEffort || null,
    metadata: Object.keys(item.metadata || {}).length ? item.metadata : (previous.metadata || {}),
    tool: item.tool || previous.tool || null,
    isThinking: item.isThinking,
  };
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
    body.length,
    body.slice(0, 96),
    body.slice(-96),
  ].join("|");
}
