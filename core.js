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

export function messageNodeToView(node, mapping) {
  const message = node.message || {};
  const siblings = node.parent && mapping[node.parent]?.children
    ? mapping[node.parent].children.filter((id) => mapping[id]?.message)
    : [node.id];
  const siblingIndex = Math.max(0, siblings.indexOf(node.id));

  return {
    id: message.id || node.id,
    nodeId: node.id,
    role: message.author?.role || "unknown",
    name: message.author?.name || null,
    text: contentToText(message.content),
    createTime: message.create_time || null,
    status: message.status || null,
    endTurn: message.end_turn ?? null,
    siblingIndex,
    siblingCount: siblings.length,
    siblingNodeIds: siblings,
    metadata: message.metadata || {},
  };
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
  const item = {
    id: rawMessage.id,
    nodeId: rawMessage.id,
    role: rawMessage.author?.role || "assistant",
    name: rawMessage.author?.name || null,
    text: contentToText(rawMessage.content),
    createTime: rawMessage.create_time || null,
    status: rawMessage.status || null,
    endTurn: rawMessage.end_turn ?? null,
    siblingIndex: 0,
    siblingCount: 1,
    siblingNodeIds: [rawMessage.id],
    metadata: rawMessage.metadata || {},
    live: true,
  };

  const index = messages.findIndex((message) => message.id === item.id);
  if (index === -1) return [...messages, item];
  const next = messages.slice();
  next[index] = { ...next[index], ...item };
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
