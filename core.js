import { renderContentReferences } from './src/lib/content-references.js';
import { isTerminalMessage } from './src/lib/message-presentation.js';
import { resolveOwnershipGraph, semanticOwnershipKeys } from './src/lib/ownership-graph.js';

export function decodeCaptureBody(capture) {
  if (!capture?.base64Encoded) return String(capture?.data ?? "");
  try {
    const bytes = Uint8Array.from(atob(capture.data), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
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
  const source = (String(buffer || "") + String(chunk || "")).replace(/^\uFEFF/, "");
  const frames = [];
  let blockStart = 0;
  let lineStart = 0;
  // Do not normalize a trailing CR yet: the next chunk may begin with LF.
  // Otherwise a split CRLF becomes two line endings and dispatches early.
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    if (!flush && match[0] === "\r" && match.index === source.length - 1) break;
    const end = match.index + match[0].length;
    if (match.index === lineStart) {
      const frame = parseSseBlock(source.slice(blockStart, lineStart));
      if (frame) frames.push(frame);
      blockStart = end;
    }
    lineStart = end;
  }
  let rest = source.slice(blockStart);
  // EOF is not an event delimiter. A truncated packet must never become a
  // complete message merely because its transport disconnected.
  if (flush) rest = "";
  return { rest, frames };
}

const CONVERSATION_DELTA_FIELDS = [
  ["channel", "c"],
  ["path", "p"],
  ["op", "o"],
  ["value", "v"],
];

export function createConversationSseDecoder() {
  let encoding = null;
  let previousDelta = initialConversationDelta();
  const previousValueByChannel = new Map();

  return {
    decode(frame) {
      if (!frame || frame.data === "[DONE]") return null;
      if (frame.event === "delta_encoding") {
        const declared = parseSseScalar(frame.data);
        if (declared !== "v1") throw new Error(`Unsupported conversation delta encoding: ${String(declared)}`);
        encoding = declared;
        previousDelta = initialConversationDelta();
        previousValueByChannel.clear();
        return null;
      }
      if (frame.event !== "delta") return frame.json ?? null;
      if (encoding !== "v1") throw new Error("Conversation delta received before delta_encoding");
      const rawDelta = frame.json ?? parseSseScalar(frame.data);
      const delta = decodeCompactConversationDelta(rawDelta, previousDelta);
      const value = applyConversationDelta(previousValueByChannel.get(delta.channel), delta);
      previousDelta = delta;
      previousValueByChannel.set(delta.channel, value);
      return value;
    },
  };
}

function initialConversationDelta() {
  return { channel: 0, op: "add", path: "", value: undefined };
}

function parseSseScalar(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return value;
  }
}

function decodeCompactConversationDelta(rawDelta, previousDelta) {
  if (!rawDelta || typeof rawDelta !== "object" || Array.isArray(rawDelta)) {
    throw new Error("Unexpected conversation delta payload");
  }
  const compact = { ...rawDelta };
  for (const [field, short] of CONVERSATION_DELTA_FIELDS) {
    if (field !== "value" && !(short in rawDelta) && !(field in rawDelta)) compact[short] = previousDelta[field];
  }
  const delta = expandConversationDelta(compact);
  if (!Number.isSafeInteger(delta.channel) || delta.channel < 0) {
    throw new Error("Invalid conversation delta channel");
  }
  if (typeof delta.path !== "string") throw new Error("Invalid conversation delta path");
  if (!["add", "remove", "replace", "append", "truncate", "patch"].includes(delta.op)) {
    throw new Error("Unknown conversation delta operation");
  }
  return delta;
}

function expandConversationDelta(compact) {
  const delta = { ...compact };
  for (const [field, short] of CONVERSATION_DELTA_FIELDS) {
    if (!(short in compact)) continue;
    delta[field] = compact[short];
    delete delta[short];
  }
  if (delta.op === "patch") {
    if (!Array.isArray(delta.value)) throw new Error("Invalid conversation patch payload");
    delta.value = delta.value.map(expandConversationDelta);
  }
  return delta;
}

function applyConversationDelta(previousValue, delta) {
  const root = Symbol("conversation-delta-root");
  const path = [root, ...parseConversationDeltaPath(delta.path)];
  const result = { [root]: previousValue };
  let source = result;
  let target = result;

  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const nextKey = path[index + 1];
    const sourceChild = source && typeof source === "object" ? source[key] : undefined;
    const targetChild = cloneConversationDeltaContainer(sourceChild, nextKey);
    target[key] = targetChild;
    source = sourceChild;
    target = targetChild;
  }

  applyConversationDeltaOperation(target, path[path.length - 1], delta);
  return result[root];
}

function parseConversationDeltaPath(value) {
  if (!value) return [];
  const source = value[0] === "/" ? value.slice(1) : value;
  return source.split("/").map((part) => {
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (["__proto__", "prototype", "constructor"].includes(decoded)) {
      throw new Error("Unsafe conversation delta path");
    }
    return /^(?:0|[1-9]\d*)$/.test(decoded) ? Number.parseInt(decoded, 10) : decoded;
  });
}

function cloneConversationDeltaContainer(value, nextKey) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === "object") return { ...value };
  return typeof nextKey === "number" ? [] : {};
}

function applyConversationDeltaOperation(target, key, delta) {
  if (Array.isArray(target)) {
    if (key === "-" && delta.op === "add") key = target.length;
    if (!Number.isSafeInteger(key) || key < 0 || key > target.length || (key === target.length && delta.op !== "add")) {
      throw new Error("Invalid conversation delta array index");
    }
  }
  switch (delta.op) {
    case "patch": {
      let value = target[key];
      for (const patch of delta.value) value = applyConversationDelta(value, patch);
      target[key] = value;
      break;
    }
    case "add":
      if (Array.isArray(target)) target.splice(key, 0, delta.value);
      else target[key] = delta.value;
      break;
    case "remove":
      if (Array.isArray(target)) target.splice(key, 1);
      else delete target[key];
      break;
    case "replace":
      target[key] = delta.value;
      break;
    case "append": {
      const previous = target[key];
      if (typeof previous === "string") target[key] = previous + delta.value;
      else if (Array.isArray(previous)) {
        target[key] = previous.concat(Array.isArray(delta.value) ? delta.value : [delta.value]);
      } else if (
        previous && delta.value &&
        typeof previous === "object" && typeof delta.value === "object" &&
        !Array.isArray(previous) && !Array.isArray(delta.value)
      ) {
        target[key] = { ...previous, ...delta.value };
      } else {
        target[key] = delta.value;
      }
      break;
    }
    case "truncate":
      if (typeof target[key] === "string") target[key] = target[key].substring(0, delta.value);
      else if (Array.isArray(target[key])) target[key] = target[key].slice(0, delta.value);
      break;
  }
}

function parseSseBlock(block) {
  const data = [];
  let event = "message";
  let id = null;
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "event") event = value || "message";
    else if (field === "id" && !value.includes("\0")) id = value;
  }
  if (!data.length) return null;
  const text = data.join("\n");
  return { event, id, data: text, json: parseJson(text) };
}

export function findConversationPayload(root, options = {}) {
  if (!root || typeof root !== "object") return null;
  const stack = [root];
  const visited = new WeakSet();
  let inspected = 0;
  while (stack.length && inspected < 8_000) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    inspected += 1;
    if (looksLikeMessage(value)) continue;
    if (value.mapping && typeof value.mapping === "object" && !Array.isArray(value.mapping) &&
        (value.current_node || (value.current_node === null && !Object.keys(value.mapping).length && conversationIdFromPayload(value)))) return value;
    if (
      Array.isArray(value.messages) &&
      (value.current_node || value.page_info) &&
      (value.conversation_id || value.id || options.conversationId) &&
      (value.messages.length === 0 || value.messages.some(looksLikeMessage))
    ) {
      return optimizedConversationToCanonical(value, options);
    }
    const children = Object.values(value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return null;
}

export function mergeConversationPayload(previous, incoming) {
  if (!previous?.mapping || typeof previous.mapping !== "object") return incoming;
  if (!incoming?.mapping || typeof incoming.mapping !== "object") return previous;
  [previous, incoming] = disambiguateCanonicalPages(previous, incoming);

  const mapping = {};

  for (const [id, node] of Object.entries(previous.mapping)) {
    mapping[id] = cloneConversationNode(node, id);
  }
  for (const [id, node] of Object.entries(incoming.mapping)) {
    mapping[id] = mergeConversationNode(mapping[id], node, id);
  }

  for (const node of Object.values(mapping)) {
    if (node?.parent && mapping[node.parent]) addConversationChild(mapping[node.parent], node.id);
  }

  const currentNode = selectMergedConversationCurrentNode(previous, incoming, mapping);
  const messageOrder = uniqueStrings([
    ...(Array.isArray(previous.message_order) ? previous.message_order : []),
    ...(Array.isArray(incoming.message_order) ? incoming.message_order : []),
  ]);
  return {
    ...previous,
    ...incoming,
    metadata: {
      ...(previous.metadata || {}),
      ...(incoming.metadata || {}),
    },
    mapping,
    current_node: currentNode,
    ...(messageOrder.length ? { message_order: messageOrder } : {}),
  };
}

function disambiguateCanonicalPages(previous, incoming) {
  const identities = new Map();
  for (const payload of [previous, incoming]) {
    for (const node of Object.values(payload.mapping)) {
      if (!node?.message?.id) continue;
      const id = String(node.message.id);
      const variants = identities.get(id) || [];
      const identity = normalizedObservationIdentity(node.message);
      if (!variants.some((candidate) => observationIdentitiesCompatible(candidate, identity))) variants.push(identity);
      identities.set(id, variants);
    }
  }
  const collisions = new Set([...identities].filter(([, variants]) => variants.length > 1).map(([id]) => id));
  if (!collisions.size) return [previous, incoming];
  return [previous, incoming].map((payload) => {
    const rename = new Map(Object.entries(payload.mapping).map(([id, node]) => [
      id, collisions.has(String(node?.message?.id)) ? canonicalItemNodeId(node.message) : id,
    ]));
    return {
      ...payload,
      current_node: rename.get(payload.current_node) || payload.current_node,
      ...(Array.isArray(payload.message_order) ? { message_order: uniqueStrings(payload.message_order.map((id) => rename.get(id) || id)) } : {}),
      mapping: Object.fromEntries(Object.entries(payload.mapping).map(([id, node]) => [rename.get(id), {
        ...node, id: rename.get(id),
        parent: rename.get(node?.parent) || node?.parent || null,
        children: uniqueStrings((node?.children || []).map((child) => rename.get(child) || child)),
      }])),
    };
  });
}

export function mergeProgressiveText(previousValue, incomingValue) {
  const previous = typeof previousValue === "string" ? previousValue : "";
  const incoming = typeof incomingValue === "string" ? incomingValue : "";
  if (!incoming) return previous;
  if (!previous || previous === incoming) return incoming;
  if (incoming.startsWith(previous)) return incoming;
  if (previous.startsWith(incoming)) return previous;
  if (incoming.includes(previous)) return incoming;
  if (previous.includes(incoming)) return previous;

  const overlap = longestTextOverlap(previous, incoming);
  if (overlap > 0) return `${previous}${incoming.slice(overlap)}`;

  // Streaming reasoning/tool arguments are frequently delivered as deltas
  // rather than cumulative snapshots. In the absence of an overlap, keeping
  // both observations is safer than replacing already-observed text.
  return `${previous}${incoming}`;
}

function longestTextOverlap(previous, incoming) {
  const max = Math.min(previous.length, incoming.length, 4096);
  for (let length = max; length > 0; length -= 1) {
    if (previous.slice(-length) === incoming.slice(0, length)) return length;
  }
  return 0;
}

export function mergeObservedMessage(previous, incoming, options = {}) {
  if (!previous || typeof previous !== "object") return cloneConversationMessage(incoming);
  if (!incoming || typeof incoming !== "object") return cloneConversationMessage(previous);

  const previousFinished = isFinishedConversationMessage(previous);
  const incomingFinished = isFinishedConversationMessage(incoming);
  const preserveFinishedLifecycle = previousFinished && !incomingFinished;
  const snapshot = options.textMode === "snapshot";
  const delta = options.textMode === "delta";

  return {
    ...previous,
    ...incoming,
    author: snapshot ? mergeSnapshotObject(previous.author, incoming.author) : mergeObservedObject(previous.author, incoming.author),
    content: delta ? mergeExplicitDelta(previous.content, incoming.content, "content") : snapshot
      ? mergeSnapshotContent(previous.content, incoming.content)
      : mergeObservedContent(previous.content, incoming.content),
    metadata: delta ? mergeExplicitDelta(previous.metadata, incoming.metadata) : snapshot ? mergeSnapshotObject(previous.metadata, incoming.metadata) : mergeObservedMetadata(previous.metadata, incoming.metadata),
    tool_calls: delta ? mergeExplicitDelta(previous.tool_calls, incoming.tool_calls, "tool_calls") : snapshot
      ? cloneObservedValue(incoming.tool_calls === undefined ? previous.tool_calls : incoming.tool_calls)
      : mergeObservedValue(previous.tool_calls, incoming.tool_calls, "tool_calls"),
    status: preserveFinishedLifecycle ? previous.status : (incoming.status ?? previous.status),
    end_turn: preserveFinishedLifecycle ? previous.end_turn : (incoming.end_turn ?? previous.end_turn),
  };
}

function mergeExplicitDelta(previous, incoming, key = "") {
  if (incoming === undefined) return cloneObservedValue(previous);
  if (typeof incoming === "string" && typeof previous === "string") {
    return /^(?:content|parts|text|arguments|thought|reasoning|reasoning_content|summary|transcript|result)$/.test(key)
      ? previous + incoming : incoming;
  }
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    const output = previous.map(cloneObservedValue);
    for (let index = 0; index < incoming.length; index += 1) {
      const value = incoming[index];
      const id = value && typeof value === "object" ? value.id ?? value.call_id ?? value.tool_call_id : null;
      const found = id == null ? index : previous.findIndex((item) => (item?.id ?? item?.call_id ?? item?.tool_call_id) === id);
      const target = found < 0 ? output.length : found;
      output[target] = mergeExplicitDelta(output[target], value, key);
    }
    return output;
  }
  if (previous && incoming && typeof previous === "object" && typeof incoming === "object" && !Array.isArray(previous) && !Array.isArray(incoming)) {
    return Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(incoming)])]
      .map((name) => [name, mergeExplicitDelta(previous[name], incoming[name], name)]));
  }
  return cloneObservedValue(incoming);
}

function mergeSnapshotObject(previous, incoming) {
  if (incoming === undefined) return cloneObservedValue(previous);
  if (!incoming || typeof incoming !== "object") return cloneObservedValue(incoming);
  return cloneObservedValue({ ...(previous || {}), ...incoming });
}

function mergeSnapshotContent(previous, incoming) {
  if (incoming === undefined) return cloneObservedValue(previous);
  return cloneObservedValue(incoming);
}

function mergeObservedContent(previous, incoming) {
  if (incoming == null) return cloneObservedValue(previous);
  if (previous == null) return cloneObservedValue(incoming);
  if (typeof previous === "string" || typeof incoming === "string") {
    return mergeProgressiveText(String(previous || ""), String(incoming || ""));
  }
  if (typeof previous !== "object" || typeof incoming !== "object") return cloneObservedValue(incoming);

  const output = { ...previous, ...incoming };
  for (const key of new Set([...Object.keys(previous), ...Object.keys(incoming)])) {
    if (!(key in incoming)) {
      output[key] = cloneObservedValue(previous[key]);
      continue;
    }
    if (!(key in previous)) {
      output[key] = cloneObservedValue(incoming[key]);
      continue;
    }
    output[key] = mergeObservedValue(previous[key], incoming[key], key);
  }
  return output;
}

function mergeObservedMetadata(previous, incoming) {
  const output = mergeObservedObject(previous, incoming);
  if (!output || typeof output !== "object") return output;
  for (const key of [
    "thought",
    "reasoning",
    "reasoning_content",
    "initial_text",
    "finished_text",
  ]) {
    if (typeof previous?.[key] === "string" || typeof incoming?.[key] === "string") {
      output[key] = mergeProgressiveText(previous?.[key], incoming?.[key]);
    }
  }
  return output;
}

function mergeObservedObject(previous, incoming) {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) return cloneObservedValue(incoming ?? previous);
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return cloneObservedValue(incoming ?? previous);
  const output = { ...previous };
  for (const [key, value] of Object.entries(incoming)) {
    output[key] = key in previous
      ? mergeObservedValue(previous[key], value, key)
      : cloneObservedValue(value);
  }
  return output;
}

function mergeObservedValue(previous, incoming, key = "") {
  if (incoming == null || incoming === "") return cloneObservedValue(previous);
  if (previous == null || previous === "") return cloneObservedValue(incoming);

  if (typeof previous === "string" && typeof incoming === "string") {
    if (/^(?:text|content|summary|thought|reasoning|reasoning_content|arguments|transcript|initial_text|finished_text|result)$/i.test(key)) {
      return mergeProgressiveText(previous, incoming);
    }
    return incoming;
  }

  if (Array.isArray(previous) && Array.isArray(incoming)) {
    return mergeObservedArray(previous, incoming, key);
  }
  if (
    previous && incoming &&
    typeof previous === "object" && typeof incoming === "object" &&
    !Array.isArray(previous) && !Array.isArray(incoming)
  ) {
    return mergeObservedObject(previous, incoming);
  }
  return cloneObservedValue(incoming);
}

function mergeObservedArray(previous, incoming, key) {
  if (!incoming.length) return previous.map(cloneObservedValue);
  if (!previous.length) return incoming.map(cloneObservedValue);

  if (previous.every((item) => typeof item === "string") && incoming.every((item) => typeof item === "string")) {
    const length = Math.max(previous.length, incoming.length);
    const output = [];
    for (let index = 0; index < length; index += 1) {
      if (index >= incoming.length) output.push(previous[index]);
      else if (index >= previous.length) output.push(incoming[index]);
      else output.push(mergeProgressiveText(previous[index], incoming[index]));
    }
    return output;
  }

  const stableKey = (item, index) => {
    if (!item || typeof item !== "object") return `index:${index}`;
    return String(
      item.id ??
      item.call_id ??
      item.tool_call_id ??
      item.message_id ??
      `index:${index}`
    );
  };
  const output = previous.map(cloneObservedValue);
  const indexByKey = new Map(output.map((item, index) => [stableKey(item, index), index]));
  for (let index = 0; index < incoming.length; index += 1) {
    const item = incoming[index];
    const itemKey = stableKey(item, index);
    if (!indexByKey.has(itemKey)) {
      indexByKey.set(itemKey, output.length);
      output.push(cloneObservedValue(item));
      continue;
    }
    const target = indexByKey.get(itemKey);
    output[target] = mergeObservedValue(output[target], item, key);
  }
  return output;
}

function cloneObservedValue(value) {
  if (Array.isArray(value)) return value.map(cloneObservedValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneObservedValue(child)]));
}

function cloneConversationNode(node, fallbackId) {
  if (!node || typeof node !== "object") {
    return { id: fallbackId, parent: null, children: [] };
  }
  return {
    ...node,
    id: node.id || fallbackId,
    children: Array.isArray(node.children) ? [...new Set(node.children.filter(Boolean))] : [],
    message: node.message ? cloneConversationMessage(node.message) : node.message,
  };
}

function mergeConversationNode(previous, incoming, fallbackId) {
  if (!previous) return cloneConversationNode(incoming, fallbackId);
  if (!incoming || typeof incoming !== "object") return previous;
  const parent = incoming.parent || previous.parent || null;
  const children = [...new Set([
    ...(Array.isArray(previous.children) ? previous.children : []),
    ...(Array.isArray(incoming.children) ? incoming.children : []),
  ].filter(Boolean))];
  return {
    ...previous,
    ...incoming,
    id: incoming.id || previous.id || fallbackId,
    parent,
    children,
    message: mergeConversationMessage(previous.message, incoming.message),
  };
}

function cloneConversationMessage(message) {
  if (!message || typeof message !== "object") return message;
  return {
    ...message,
    author: message.author && typeof message.author === "object" ? { ...message.author } : message.author,
    content: message.content && typeof message.content === "object" ? { ...message.content } : message.content,
    metadata: message.metadata && typeof message.metadata === "object" ? { ...message.metadata } : message.metadata,
  };
}

function mergeConversationMessage(previous, incoming) {
  return mergeObservedMessage(previous, incoming, { textMode: "snapshot" });
}

function isFinishedConversationMessage(message) {
  return isTerminalMessage(message);
}

function addConversationChild(node, childId) {
  if (!node || !childId) return;
  const children = Array.isArray(node.children) ? node.children : [];
  if (!children.includes(childId)) node.children = [...children, childId];
}

function selectMergedConversationCurrentNode(previous, incoming, mapping) {
  const previousCurrent = mapping[previous.current_node] ? previous.current_node : null;
  const incomingCurrent = mapping[incoming.current_node] ? incoming.current_node : null;
  if (!previousCurrent) return incomingCurrent;
  if (!incomingCurrent) return previousCurrent;
  if (previousCurrent === incomingCurrent) return previousCurrent;
  if (isConversationAncestor(mapping, incomingCurrent, previousCurrent)) return previousCurrent;
  if (isConversationAncestor(mapping, previousCurrent, incomingCurrent)) return incomingCurrent;

  const source = String(incoming.metadata?.source || "");
  if (source === "web-mobile-partial" || source === "optimized-conversation") return previousCurrent;
  return incomingCurrent;
}

function isConversationAncestor(mapping, ancestorId, descendantId) {
  if (!ancestorId || !descendantId || ancestorId === descendantId) return ancestorId === descendantId;
  const seen = new Set();
  let current = descendantId;
  while (current && mapping[current] && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = mapping[current].parent || null;
  }
  return false;
}

function optimizedConversationToCanonical(value, options = {}) {
  const mapping = {};
  const messageOrder = [];
  const variants = new Map();
  for (const message of value.messages) {
    if (!looksLikeMessage(message)) continue;
    const identities = variants.get(String(message.id)) || [];
    const identity = normalizedObservationIdentity(message);
    if (!identities.some((candidate) => observationIdentitiesCompatible(candidate, identity))) identities.push(identity);
    variants.set(String(message.id), identities);
  }
  const references = new Map();
  const indexReference = (reference, id) => {
    if (!reference) return;
    const nodes = references.get(reference) || new Set();
    nodes.add(id);
    references.set(reference, nodes);
  };

  for (const message of value.messages) {
    if (!looksLikeMessage(message)) continue;
    const messageId = String(message.id);
    const identity = normalizedObservationIdentity(message);
    const id = variants.get(messageId).length > 1 ? canonicalItemNodeId(message) : messageId;
    const requestedParent = message.metadata?.parent_id || message.parent_id || null;
    const parent = requestedParent && requestedParent !== id
      ? String(requestedParent)
      : null;
    mapping[id] = {
      id,
      parent,
      children: [],
      message: mapping[id]?.message
        ? mergeObservedMessage(mapping[id].message, message, { textMode: "snapshot" })
        : message,
    };
    if (!messageOrder.includes(id)) messageOrder.push(id);
    for (const reference of [id, messageId, identity.itemId]) indexReference(reference, id);
  }

  for (const node of Object.values(mapping)) {
    const parents = references.get(node.parent);
    if (parents?.size === 1) node.parent = parents.values().next().value;
    if (node.parent && mapping[node.parent]) mapping[node.parent].children.push(node.id);
    // Paginated conversation pages may point to a parent on an older page.
    // Preserve that external parent id so page merges can reconnect the
    // canonical chain later; only a genuinely absent parent is a root.
    else if (!node.parent) node.parent = null;
  }

  const { messages, conversation_id: declaredConversationId, ...rest } = value;
  const conversationId = declaredConversationId || value.id || options.conversationId || null;
  const terminalCandidates = references.get(value.current_node);
  const currentNode = mapping[value.current_node] ? value.current_node
    : terminalCandidates?.size === 1 ? terminalCandidates.values().next().value : null;
  return {
    ...rest,
    id: value.id || conversationId,
    conversation_id: conversationId || value.id,
    mapping,
    current_node: currentNode,
    message_order: messageOrder,
    metadata: {
      ...(rest.metadata || {}),
      source: rest.metadata?.source || "optimized-conversation",
    },
  };
}

function canonicalItemNodeId(message) {
  const identity = normalizedObservationIdentity(message);
  return `${message.id}::${encodeURIComponent([
    identity.itemId, identity.responseId, identity.outputIndex, identity.contentIndex,
    identity.callId || identity.toolCallId, identity.phase, identity.itemKind,
    identity.turnUserMessageId, identity.semanticTurnAliases?.[0],
  ].map((value) => value ?? "").join("\0"))}`;
}

export function extractConversationItems(root) {
  if (!root || typeof root !== "object") return [];
  const stack = [root];
  const visited = new WeakSet();
  let inspected = 0;
  while (stack.length && inspected < 8_000) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    inspected += 1;
    if (looksLikeMessage(value)) continue;
    if (Array.isArray(value.items)) {
      const items = value.items.filter((item) => item && typeof item === "object" && item.id);
      if (items.length && items.some((item) => "title" in item || "update_time" in item || "create_time" in item)) {
        return items;
      }
    }
    const children = Object.values(value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child && typeof child === "object") stack.push(child);
    }
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
  if (looksLikeMessage(value)) return [];
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

export function findMessageEvents(value, options = {}) {
  const output = [];
  collectMessageEvents(value, output);
  return dedupeMessageEvents(output, options);
}

const CONVERSATION_LIFECYCLE_EVENT_TYPES = new Set([
  "conversation-update",
  "conversation_update",
  "main-stream-complete",
  "main_stream_complete",
  "input-message",
  "input_message",
  "add-conversation-item",
  "add_conversation_item",
  "add-turn-message",
  "add_turn_message",
  "replace-turn-message",
  "replace_turn_message",
  "convert-turn-to-paragen",
  "convert_turn_to_paragen",
  "resolve-paragen",
  "resolve_paragen",
  "discard-items",
  "discard_items",
]);

// New chats begin life under an official client-only WEB:* thread id.  The
// server announces the durable conversation id in protocol lifecycle events
// before every visible message necessarily carries that id.  Keep this
// extraction deliberately narrow: arbitrary tool payloads may contain other
// conversation ids and must never steal ownership of the active turn.
export function findConversationLifecycleEvents(root) {
  if (!root || typeof root !== "object") return [];
  const output = [];
  const stack = [{ value: root, context: {} }];
  const visited = new WeakSet();
  let inspected = 0;

  while (stack.length && inspected < 12_000) {
    const entry = stack.pop();
    const value = entry?.value;
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    inspected += 1;

    // Tool output and quoted JSON are data, not server lifecycle envelopes.
    if (looksLikeMessage(value)) continue;
    const context = mergeMessageEventContext(entry.context, value);
    const rawType = firstNonEmptyString(value.type, value.event) || "";
    const normalizedType = rawType.toLowerCase();
    const conversationId = firstNonEmptyString(value.conversation_id, value.conversationId) || null;
    if (
      conversationId &&
      !isProvisionalConversationId(conversationId) &&
      CONVERSATION_LIFECYCLE_EVENT_TYPES.has(normalizedType)
    ) {
      output.push({
        ...context,
        type: rawType,
        conversationId,
      });
    }

    for (const child of Object.values(value)) {
      if (!child || typeof child !== "object") continue;
      stack.push({ value: child, context });
    }
  }

  const seen = new Set();
  return output.filter((event) => {
    const key = [
      event.conversationId,
      String(event.type || "").toLowerCase(),
      event.turnId || "",
      event.responseId || "",
      event.itemId || "",
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectMessageEvents(root, output) {
  if (!root || typeof root !== "object") return;
  const stack = [{
    value: root,
    scope: { conversationId: null, conflicted: false },
    context: {},
  }];
  const visited = new WeakSet();
  let inspected = 0;
  const MAX_INSPECTED_OBJECTS = 12_000;

  while (stack.length && inspected < MAX_INSPECTED_OBJECTS) {
    const entry = stack.pop();
    const value = entry?.value;
    if (!value || typeof value !== "object") continue;
    if (visited.has(value)) continue;
    visited.add(value);
    inspected += 1;

    const directConversationId = value.conversation_id || value.conversationId || null;
    const scope = mergeConversationScope(entry.scope, directConversationId);
    const context = mergeMessageEventContext(entry.context, value);

    if (looksLikeMessage(value.message)) {
      const messageScope = mergeConversationScope(
        scope,
        value.message.conversation_id || value.message.conversationId || null,
      );
      output.push({
        ...mergeMessageEventContext(context, value.message),
        message: value.message,
        conversationId: messageScope.conversationId,
        conversationIdConflict: messageScope.conflicted,
      });
    }
    if (looksLikeMessage(value) && (value.author || value.content)) {
      output.push({
        ...context,
        message: value,
        conversationId: scope.conversationId,
        conversationIdConflict: scope.conflicted,
      });
      continue;
    }

    const children = Object.values(value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (!child || typeof child !== "object") continue;
      stack.push({ value: child, scope, context });
    }
  }
}

function mergeMessageEventContext(previous, value) {
  const sequenceNumber = firstFiniteNumber(value?.sequence_number, value?.metadata?.sequence_number, previous?.sequenceNumber);
  const outputIndex = firstFiniteNumber(value?.output_index, value?.metadata?.output_index, previous?.outputIndex);
  const responseId = firstNonEmptyString(
    value?.response_id,
    value?.responseId,
    value?.response?.id,
    previous?.responseId,
  ) || null;
  const itemId = firstNonEmptyString(
    value?.item_id,
    value?.itemId,
    value?.output_item_id,
    value?.outputItemId,
    value?.item?.id,
    previous?.itemId,
  ) || null;
  const eventType = firstNonEmptyString(value?.type, previous?.eventType) || null;
  const turnIdentity = messageTurnIdentity(value);
  const phase = firstNonEmptyString(
    value?.phase,
    value?.channel,
    turnIdentity.phase,
    previous?.phase,
  ) || null;
  const channel = firstNonEmptyString(
    value?.channel,
    value?.metadata?.channel,
    previous?.channel,
  ) || null;
  const callIdentity = messageCallIdentity(value);
  return {
    parentMessageId: looksLikeMessage(value) || looksLikeMessage(value?.message)
      ? firstNonEmptyString(value.parent_id, value.parent, value.metadata?.parent_id, previous?.parentMessageId) || null
      : previous?.parentMessageId || null,
    contentIndex: firstFiniteNumber(value?.content_index, value?.metadata?.content_index, previous?.contentIndex),
    turnUserMessageId: firstNonEmptyString(value?.turn_user_message_id, value?.turnUserMessageId, value?.metadata?.turn_user_message_id, previous?.turnUserMessageId) || null,
    sequenceNumber: sequenceNumber ?? null,
    outputIndex: outputIndex ?? null,
    responseId,
    itemId,
    eventType,
    turnId: turnIdentity.turnId || previous?.turnId || null,
    turnAliases: mergeAuthoritativeAliases(turnIdentity.turnAliases, previous?.turnAliases),
    turnExchangeId: turnIdentity.turnExchangeId || previous?.turnExchangeId || null,
    workingTurnId: turnIdentity.workingTurnId || previous?.workingTurnId || null,
    turnRequestId: turnIdentity.requestId || previous?.turnRequestId || null,
    turnTraceId: turnIdentity.turnTraceId || previous?.turnTraceId || null,
    phase,
    channel,
    callId: callIdentity.callId || previous?.callId || null,
    toolCallId: callIdentity.toolCallId || previous?.toolCallId || null,
  };
}

function mergeConversationScope(scope, candidate) {
  if (scope.conflicted || typeof candidate !== "string" || !candidate.trim()) return scope;
  const conversationId = candidate.trim();
  if (isProvisionalConversationId(conversationId)) return scope;
  if (scope.conversationId && scope.conversationId !== conversationId) {
    return { conversationId: null, conflicted: true };
  }
  return scope.conversationId === conversationId
    ? scope
    : { conversationId, conflicted: false };
}

function dedupeMessageEvents(events, options = {}) {
  const merged = [];
  for (const event of events) {
    const { message, conversationId, conversationIdConflict } = event;
    if (!message?.id) continue;
    const scope = conversationIdConflict ? "conflict" : (conversationId || "unscoped");
    const eventIdentity = normalizedObservationIdentity(message, event);
    const index = merged.findIndex((candidate) => {
      const candidateScope = candidate.conversationIdConflict
        ? "conflict"
        : (candidate.conversationId || "unscoped");
      const candidateIdentity = normalizedObservationIdentity(candidate.message, candidate);
      return candidateScope === scope &&
        observationSubjectsMatch(candidateIdentity, eventIdentity) &&
        observationIdentitiesCompatible(candidateIdentity, eventIdentity);
    });
    if (index === -1) {
      merged.push(event);
      continue;
    }
    const previous = merged[index];
    merged[index] = {
      ...previous,
      ...event,
      turnAliases: uniqueStrings([
        ...(previous.turnAliases || []),
        ...(event.turnAliases || []),
      ]),
      message: mergeObservedMessage(previous.message, event.message, options),
      conversationIdConflict: Boolean(previous.conversationIdConflict || event.conversationIdConflict),
      conversationId: previous.conversationIdConflict || event.conversationIdConflict
        ? null
        : (event.conversationId || previous.conversationId || null),
    };
  }
  return merged;
}

function looksLikeMessage(value) {
  return Boolean(value && typeof value === "object" && value.id && (value.author || value.content));
}

export function conversationIdFromPayload(payload, fallbackUrl = "") {
  const direct = payload?.conversation_id || payload?.conversationId || payload?.id;
  if (typeof direct === "string" && direct && !isProvisionalConversationId(direct)) return direct;
  return conversationIdFromUrl(fallbackUrl);
}

export function resolveConversationScope(...candidates) {
  let conversationId = null;
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const normalized = candidate.trim();
    if (isProvisionalConversationId(normalized)) continue;
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
    if (routeMatch && !isProvisionalConversationId(routeMatch[1])) return routeMatch[1];
    const apiMatch = parsed.pathname.match(/^\/backend-api\/(?:f\/)?conversations?\/([^/?#]+)(?:\/messages)?\/?$/);
    if (
      apiMatch &&
      !["prepare", "resume", "runtime", "messages"].includes(apiMatch[1]) &&
      !isProvisionalConversationId(apiMatch[1])
    ) return apiMatch[1];
  } catch {
    // Ignore malformed URLs from transient capture records.
  }
  return null;
}

export function isProvisionalConversationId(value) {
  return typeof value === "string" && /^WEB:/i.test(value.trim());
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
    .filter((node) => {
      const message = node?.message;
      if (!message) return false;
      if (!message.metadata?.is_visually_hidden_from_conversation) return true;
      return Boolean(getToolMessageInfo(message) || extractThought(message));
    })
    .map((node) => messageNodeToView(node, mapping));
}

function buildCanonicalConversationView(payload, terminalId = null) {
  if (!payload?.mapping || typeof payload.mapping !== "object") return [];
  const targetId = terminalId || payload.current_node;
  if (
    !Array.isArray(payload.message_order) ||
    !payload.message_order.length ||
    (targetId && (!payload.message_order.includes(targetId) || targetId !== payload.current_node))
  ) {
    return buildConversationView(payload, targetId);
  }
  const rows = [];
  for (let index = 0; index < payload.message_order.length; index += 1) {
    const id = payload.message_order[index];
    const node = payload.mapping[id];
    const message = node?.message;
    if (!message) continue;
    if (
      message.metadata?.is_visually_hidden_from_conversation &&
      !getToolMessageInfo(message) &&
      !extractThought(message)
    ) continue;
    rows.push({
      ...messageNodeToView(node, payload.mapping),
      canonicalOrdinal: index,
    });
  }
  return rows;
}

// Canonical payloads are immutable: ingestion returns a new payload for every
// history refresh, while live packets replace observations only. Keep the
// projection with that payload, not with a conversation id or a timer.
const canonicalProjectionCache = new WeakMap();
function canonicalProjection(payload, terminal) {
  if (!payload?.mapping) return { rows: [], allRows: [], selectedNodes: new Set(), parentIndex: new Map() };
  let entry = canonicalProjectionCache.get(payload);
  if (!entry || entry.mapping !== payload.mapping || entry.order !== payload.message_order || entry.current !== payload.current_node) {
    entry = { mapping: payload.mapping, order: payload.message_order, current: payload.current_node, terminals: new Map() };
    canonicalProjectionCache.set(payload, entry);
  }
  const target = terminal || payload.current_node || null;
  if (entry.terminals.has(target)) return entry.terminals.get(target);
  const rows = buildCanonicalConversationView(payload, target);
  const rowByNode = new Map(rows.map((row) => [row.nodeId, row]));
  const allRows = Object.values(payload.mapping).map((node) => rowByNode.get(node.id) || messageNodeToView(node, payload.mapping));
  const selectedNodes = new Set();
  // Include non-rendered ancestors for proven parent traversal, but never
  // traverse through nodes belonging only to a different selected branch.
  for (const row of rows) {
    let cursor = row.nodeId;
    while (cursor && payload.mapping[cursor] && !selectedNodes.has(cursor)) {
      selectedNodes.add(cursor);
      cursor = payload.mapping[cursor].parent;
    }
  }
  const projection = {
    rows, allRows, selectedNodes,
    parentIndex: uniqueObservationByMessageId(allRows.filter((row) => selectedNodes.has(row.nodeId))),
  };
  // Branch switching must not retain a full rendered copy for every version.
  if (entry.terminals.size >= 3) entry.terminals.delete(entry.terminals.keys().next().value);
  entry.terminals.set(target, projection);
  return projection;
}

export function groupConversationTurns(messages) {
  return groupConversationTimeline(messages).turns;
}

export function groupConversationTimeline(messages) {
  const source = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const turns = [];
  const unresolved = [];
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
      unresolved.push(message);
      continue;
    }
    appendTurnReply(current, message);
  }

  return { turns, unresolved };
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
  const role = message.author?.role;
  if (role !== 'assistant' && role !== 'tool') return false;
  const metadata = message.metadata || {};
  const phase = firstNonEmptyString(message.phase, message.channel, metadata.phase, metadata.channel);
  if (phase === 'final' || phase === 'commentary') return false;
  const recipient = firstNonEmptyString(message.recipient, metadata.recipient, message.content?.recipient);
  if (recipient && recipient !== 'all') return false;
  if (messageCallIdentity(message).callIds.length) return false;
  if (['execution_output', 'tether_browsing_display', 'tether_quote'].includes(message.content?.content_type)) return false;
  if (role === 'assistant' && (phase === 'analysis' || phase === 'reasoning')) return true;
  // Progress labels are copied onto unrelated items. A legacy reasoning
  // worker needs positive worker metadata, not merely a "Thinking" label.
  return hasExplicitAsyncReasoningMetadata(metadata) &&
    Boolean(firstNonEmptyString(metadata.async_source) && firstNonEmptyString(metadata.cot_version));
}

function hasExplicitAsyncReasoningMetadata(metadata) {
  return Boolean(metadata?.initial_text || metadata?.finished_text);
}

export function messageTurnIdentity(message) {
  if (!message || typeof message !== "object") {
    return {
      turnId: null,
      turnAliases: [],
      turnExchangeId: null,
      workingTurnId: null,
      requestId: null,
      turnTraceId: null,
      phase: null,
    };
  }
  const metadata = message.metadata && typeof message.metadata === "object"
    ? message.metadata
    : {};
  const turnExchangeId = firstNonEmptyString(
    metadata.turn_exchange_id,
    metadata.turnExchangeId,
    message.turn_exchange_id,
    message.turnExchangeId,
  ) || null;
  const workingTurnId = firstNonEmptyString(
    metadata.working_turn_id,
    metadata.workingTurnId,
    message.working_turn_id,
    message.workingTurnId,
  ) || null;
  const requestId = firstNonEmptyString(
    metadata.request_id,
    metadata.requestId,
    message.request_id,
    message.requestId,
  ) || null;
  const turnTraceId = firstNonEmptyString(
    metadata.turn_trace_id,
    metadata.turnTraceId,
    message.turn_trace_id,
    message.turnTraceId,
  ) || null;
  // `turn_exchange_id` is the strongest observed ChatGPT-Web grouping key.
  // `working_turn_id` and `request_id` are retained as aliases because long
  // tool/reasoning turns can surface different subsets of these fields.
  const turnAliases = uniqueStrings([
    turnExchangeId,
    workingTurnId,
    requestId,
    turnTraceId,
  ]);
  const phase = firstNonEmptyString(
    message.phase,
    message.channel,
    metadata.phase,
    metadata.channel,
  ) || null;
  return {
    turnId: turnAliases[0] || null,
    turnAliases,
    turnExchangeId,
    workingTurnId,
    requestId,
    turnTraceId,
    phase,
  };
}

export function messageProtocolIdentity(message, context = {}) {
  const source = message && typeof message === "object" ? message : {};
  const metadata = source.metadata && typeof source.metadata === "object" ? source.metadata : {};
  const content = source.content && typeof source.content === "object" ? source.content : {};
  const turnIdentity = messageTurnIdentity(source);
  const callIdentity = messageCallIdentity(source);
  const sequenceNumber = firstFiniteNumber(
    source.sequence_number,
    source.sequenceNumber,
    metadata.sequence_number,
    metadata.sequenceNumber,
    context.sequenceNumber,
  );
  const outputIndex = firstFiniteNumber(
    source.output_index,
    source.outputIndex,
    metadata.output_index,
    metadata.outputIndex,
    context.outputIndex,
  );
  const contentIndex = firstFiniteNumber(source.content_index, source.contentIndex, metadata.content_index, context.contentIndex);
  const responseId = firstNonEmptyString(
    source.response_id,
    source.responseId,
    metadata.response_id,
    metadata.responseId,
    context.responseId,
  ) || null;
  const itemId = firstNonEmptyString(
    source.item_id,
    source.itemId,
    source.output_item_id,
    source.outputItemId,
    metadata.item_id,
    metadata.itemId,
    metadata.output_item_id,
    metadata.outputItemId,
    context.itemId,
  ) || null;
  const phase = firstNonEmptyString(
    source.phase,
    source.channel,
    metadata.phase,
    metadata.channel,
    turnIdentity.phase,
    context.phase,
  ) || null;
  const channel = firstNonEmptyString(
    source.channel,
    metadata.channel,
    context.channel,
  ) || null;
  const parentMessageId = firstNonEmptyString(
    context.parentMessageId,
    source.parent_id,
    metadata.parent_id,
  ) || null;
  const turnUserMessageId = firstNonEmptyString(
    source.turn_user_message_id,
    source.turnUserMessageId,
    metadata.turn_user_message_id,
    metadata.turnUserMessageId,
    context.turnUserMessageId,
  ) || null;
  const contentType = firstNonEmptyString(
    content.content_type,
    source.content_type,
    metadata.content_type,
  ) || null;
  const role = firstNonEmptyString(source.author?.role, source.role) || null;
  return {
    conversationId: firstNonEmptyString(
      context.conversationId,
      source.conversation_id,
      source.conversationId,
    ) || null,
    messageId: firstNonEmptyString(source.id, context.messageId) || null,
    itemId,
    parentMessageId,
    semanticTurnAliases: mergeAuthoritativeAliases(turnIdentity.turnAliases, [
      ...(context.turnAliases || []),
      context.semanticTurnId,
      context.turnId,
    ]),
    turnUserMessageId,
    responseId,
    transportSessionId: firstNonEmptyString(
      context.transportSessionId,
      context.transportTurnId,
    ) || null,
    sequenceNumber,
    outputIndex,
    contentIndex,
    callId: firstNonEmptyString(callIdentity.callId, context.callId) || null,
    toolCallId: firstNonEmptyString(callIdentity.toolCallId, context.toolCallId) || null,
    callIds: uniqueStrings([
      ...(context.callIds || []),
      ...(callIdentity.callIds || []),
    ]),
    phase,
    channel,
    role,
    contentType,
    eventType: firstNonEmptyString(context.eventType) || null,
    turnExchangeId: turnIdentity.turnExchangeId || firstNonEmptyString(context.turnExchangeId) || null,
    workingTurnId: turnIdentity.workingTurnId || firstNonEmptyString(context.workingTurnId) || null,
    requestId: turnIdentity.requestId || firstNonEmptyString(context.turnRequestId) || null,
    turnTraceId: turnIdentity.turnTraceId || firstNonEmptyString(context.turnTraceId) || null,
  };
}

function mergeAuthoritativeAliases(direct, inherited) {
  const own = uniqueStrings(direct);
  const context = uniqueStrings(inherited);
  if (!own.length) return context;
  return !context.length || own.some((alias) => context.includes(alias)) ? uniqueStrings([...own, ...context]) : own;
}

export function captureMessageContext(event, capture = {}) {
  const identity = messageProtocolIdentity(event?.message, event || {});
  const aliases = identity.semanticTurnAliases;
  const captureAliases = uniqueStrings([...(capture.turnAliases || []), capture.turnId]);
  const identityHasTyped = identity.turnExchangeId || identity.workingTurnId || identity.requestId || identity.turnTraceId;
  const captureHasTyped = capture.turnExchangeId || capture.workingTurnId || capture.turnRequestId || capture.turnTraceId;
  const captureExchange = capture.turnExchangeId || (!captureHasTyped ? capture.turnId : null);
  const conflict = capture.transport === "dom" ||
    (identity.turnExchangeId && captureExchange && identity.turnExchangeId !== captureExchange) ||
    (!identityHasTyped && !captureHasTyped && aliases.length && captureAliases.length && !aliases.some((alias) => captureAliases.includes(alias))) ||
    (identity.turnUserMessageId && capture.turnUserMessageId && identity.turnUserMessageId !== capture.turnUserMessageId);
  return {
    parentMessageId: identity.parentMessageId,
    turnExchangeId: identity.turnExchangeId || (!conflict ? capture.turnExchangeId : null) || null,
    workingTurnId: identity.workingTurnId || (!conflict ? capture.workingTurnId : null) || null,
    turnRequestId: identity.requestId || (!conflict ? capture.turnRequestId : null) || null,
    turnTraceId: identity.turnTraceId || (!conflict ? capture.turnTraceId : null) || null,
    semanticTurnId: aliases[0] || (!conflict ? capture.turnId : null) || null,
    turnAliases: uniqueStrings([...aliases, ...(!conflict ? captureAliases : [])]),
    turnUserMessageId: identity.turnUserMessageId || (!conflict ? capture.turnUserMessageId : null) || null,
    turnParentMessageId: !conflict ? capture.turnParentMessageId || null : null,
    transportTurnId: capture.transportTurnId || capture.transportSessionId || null,
  };
}

function messageCallIdentity(message) {
  if (!message || typeof message !== "object") {
    return { callId: null, toolCallId: null, callIds: [] };
  }
  const metadata = message.metadata && typeof message.metadata === "object" ? message.metadata : {};
  const content = message.content && typeof message.content === "object" ? message.content : {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : Array.isArray(metadata.tool_calls)
      ? metadata.tool_calls
      : Array.isArray(content.tool_calls)
        ? content.tool_calls
        : [];
  const callId = firstNonEmptyString(
    message.call_id,
    metadata.call_id,
    content.call_id,
    toolCalls[0]?.call_id,
    toolCalls[0]?.id,
  ) || null;
  const toolCallId = firstNonEmptyString(
    message.tool_call_id,
    metadata.tool_call_id,
    content.tool_call_id,
    toolCalls[0]?.tool_call_id,
    toolCalls[0]?.id,
  ) || null;
  const callIds = uniqueStrings([
    callId,
    toolCallId,
    ...toolCalls.flatMap((call) => [call?.id, call?.call_id, call?.tool_call_id]),
  ]);
  return { callId, toolCallId, callIds };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    if (typeof value === 'string' && !value.trim()) continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function normalizedObservationIdentity(message, context = {}) {
  const identity = messageProtocolIdentity(message, context);
  const tool = getToolMessageInfo(message);
  return {
    ...identity,
    itemKind: tool?.kind || identity.contentType || identity.role || null,
  };
}

function observationIdentitiesCompatible(left, right) {
  if (!left || !right) return true;
  if (left.turnUserMessageId && right.turnUserMessageId && left.turnUserMessageId !== right.turnUserMessageId) return false;
  if (left.turnExchangeId && right.turnExchangeId && left.turnExchangeId !== right.turnExchangeId) return false;
  const leftTyped = left.turnExchangeId || left.workingTurnId || left.requestId || left.turnRequestId || left.turnTraceId;
  const rightTyped = right.turnExchangeId || right.workingTurnId || right.requestId || right.turnRequestId || right.turnTraceId;
  if (!leftTyped && !rightTyped && left.semanticTurnAliases?.length && right.semanticTurnAliases?.length &&
      !left.semanticTurnAliases.some((alias) => right.semanticTurnAliases.includes(alias))) return false;
  for (const key of ["responseId", "itemId", "outputIndex", "contentIndex", "callId", "toolCallId", "phase"]) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue != null && rightValue != null && leftValue !== rightValue) return false;
  }
  if (
    left.itemKind != null &&
    right.itemKind != null &&
    left.itemKind !== right.itemKind &&
    !isGenericObservationKind(left) &&
    !isGenericObservationKind(right)
  ) {
    return false;
  }
  if (left.callIds?.length && right.callIds?.length) {
    const overlap = left.callIds.some((value) => right.callIds.includes(value));
    if (!overlap && (left.callId || left.toolCallId) && (right.callId || right.toolCallId)) return false;
  }
  return true;
}

function isGenericObservationKind(identity) {
  return Boolean(
    identity &&
    !identity.contentType &&
    identity.itemKind &&
    identity.role &&
    identity.itemKind === identity.role
  );
}

function observationSubjectsMatch(left, right) {
  if (!left || !right) return false;
  if (left.messageId && right.messageId && left.messageId === right.messageId) return true;
  return Boolean(left.itemId && right.itemId && left.itemId === right.itemId);
}

function observationIdentityKey(identity) {
  const semantic = identity?.semanticTurnAliases?.[0] || "";
  return [
    identity?.messageId || "message",
    identity?.responseId || "",
    identity?.itemId || "",
    identity?.outputIndex ?? "",
    identity?.contentIndex ?? "",
    identity?.callId || identity?.toolCallId || "",
    identity?.phase || "",
    identity?.itemKind || identity?.contentType || identity?.role || "",
    semantic,
  ].join("\u0000");
}

function uniqueStrings(values) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
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
  const text = isAsyncReasoning ? '' : contentToText(message.content, metadata, { literal: message.author?.role === 'user' });
  const status = message.status || (metadata.is_error ? "failed" : null);
  const error = status === "failed" || Boolean(metadata.is_error) || Boolean(metadata.error);
  const model = metadata.model_slug || metadata.default_model_slug || metadata.model || null;
  const reasoningEffort = metadata.thinking_effort || metadata.reasoning_effort || metadata.reasoning_effort_level || null;
  const thinkingLevel = metadata.thinking_level ? getThinkingLevel(metadata.thinking_level) : (reasoningEffort ? getThinkingLevel(reasoningEffort) : null);
  const durationSec = metadata.finished_duration_sec ?? null;
  const thinkingDuration = formatThinkingDuration(durationSec, metadata.reasoning_start_time, metadata.reasoning_end_time, metadata);
  const protocolIdentity = messageProtocolIdentity(message, {
    parentMessageId: node.parent || null,
  });

  const ct = String(message.content?.content_type || "");
  const isSpinner = ct === "tether_browsing_display" && !message.content?.result && !message.content?.summary;

  const role = isAsyncReasoning ? "assistant" : (message.author?.role || "unknown");

  return {
    id: message.id || node.id,
    nodeId: node.id,
    itemId: protocolIdentity.itemId,
    turnUserMessageId: protocolIdentity.turnUserMessageId,
    contentIndex: protocolIdentity.contentIndex,
    parentId: protocolIdentity.parentMessageId,
    turnId: protocolIdentity.semanticTurnAliases[0] || null,
    turnAliases: protocolIdentity.semanticTurnAliases,
    turnExchangeId: protocolIdentity.turnExchangeId,
    workingTurnId: protocolIdentity.workingTurnId,
    turnRequestId: protocolIdentity.requestId,
    turnTraceId: protocolIdentity.turnTraceId,
    responseId: protocolIdentity.responseId,
    sequenceNumber: protocolIdentity.sequenceNumber,
    outputIndex: protocolIdentity.outputIndex,
    callId: protocolIdentity.callId,
    toolCallId: protocolIdentity.toolCallId,
    callIds: protocolIdentity.callIds,
    phase: protocolIdentity.phase,
    channel: protocolIdentity.channel,
    eventType: protocolIdentity.eventType,
    role,
    contentType: ct || null,
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
    observationKey: observationIdentityKey({
      ...protocolIdentity,
      messageId: message.id || node.id,
      itemKind: tool?.kind || ct || role,
    }),
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
  const callIdentity = messageCallIdentity(message);

  let kind = null;
  if (
    role === "tool" ||
    contentType === "execution_output" ||
    contentType === "tether_browsing_display" ||
    contentType === "tether_quote" ||
    (role !== "assistant" && realAuthor.startsWith("tool:"))
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

  const title = firstNonEmptyString(metadata.reasoning_title) || null;

  return {
    kind,
    name,
    title,
    recipient: recipient || null,
    contentType: contentType || null,
    callId: callIdentity.callId,
    toolCallId: callIdentity.toolCallId,
    callIds: callIdentity.callIds,
    payload: extractToolPayload(message, toolCalls),
  };
}

function extractToolPayload(message, toolCalls) {
  if (toolCalls?.length) return toolCalls.length === 1 ? toolCalls[0] : { calls: toolCalls };
  const content = message.content;
  const metadata = message.metadata || {};

  if (Array.isArray(metadata.search_result_groups) && metadata.search_result_groups.length) {
    return {
      queries: metadata.search_model_queries?.queries || metadata.search_queries || undefined,
      results: metadata.search_result_groups,
    };
  }

  if (Array.isArray(metadata.inline_cot_expandable_content?.search_result_groups)) {
    return {
      results: metadata.inline_cot_expandable_content.search_result_groups,
    };
  }

  if (metadata.search_model_queries && typeof metadata.search_model_queries === "object") {
    return metadata.search_model_queries;
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

export function contentToText(content, metadata = {}, options = {}) {
  const contentType = String(content?.content_type || "").toLowerCase();
  if (contentType === "thought" || contentType === "thoughts" || contentType === "reasoning_recap") {
    return "";
  }

  let text = "";
  if (content) {
    if (typeof content === "string") text = content;
    else if (typeof content.text === "string") text = content.text;
    else if (typeof content.transcript === "string") text = content.transcript;
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

  if (!options.literal) text = cleanCitationMarkers(text, metadata);
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

export function cleanCitationMarkers(text, metadata = {}) {
  if (!text || typeof text !== "string") return text;
  return renderContentReferences(text, metadata);
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

export function upsertLiveMessage(messages, rawMessage, options = {}) {
  if (!rawMessage?.id) return messages;
  const incomingIdentity = normalizedObservationIdentity(rawMessage, options);
  const index = findCompatibleObservationIndex(messages, incomingIdentity);
  const previous = index >= 0 ? messages[index] : null;
  if (options.captureTransport === "dom" && previous?.captureTransport && previous.captureTransport !== "dom") return messages;
  const lastSequence = finiteNumber(previous?.lastSequenceNumber);
  if (lastSequence != null && incomingIdentity.sequenceNumber != null && incomingIdentity.sequenceNumber < lastSequence) return messages;
  const mergedRaw = previous?._rawMessage
    ? mergeObservedMessage(previous._rawMessage, rawMessage, options)
    : cloneConversationMessage(rawMessage);
  const protocolIdentity = messageProtocolIdentity(mergedRaw, options);
  const item = liveMessageToView(mergedRaw, options);
  if (previous && mergedRaw.content === undefined) {
    // The ledger intentionally stores parsed observations, not transport
    // bodies. A status-only envelope after reload cannot erase that view or
    // be turned into fabricated raw content for subsequent delta decoding.
    item.text = previous.text;
    item.contentType = previous.contentType;
    item.unrecognized = previous.unrecognized;
    const metadata = rawMessage.metadata || {};
    const replacesThought = ['thought', 'reasoning', 'reasoning_content'].some((key) => Object.hasOwn(metadata, key));
    if (!replacesThought) item.thought = previous.thought;
    if (!Object.hasOwn(rawMessage, 'tool_calls') && !Object.hasOwn(metadata, 'tool_calls')) item.tool = previous.tool;
  }
  item.cacheRedacted = mergedRaw.content === undefined ? Boolean(previous?.cacheRedacted) : false;
  item._rawMessage = mergedRaw;
  item.parentId = protocolIdentity.parentMessageId || previous?.parentId || null;
  item.itemId = protocolIdentity.itemId || previous?.itemId || null;
  item.turnId = protocolIdentity.semanticTurnAliases[0] || previous?.turnId || null;
  item.turnAliases = uniqueStrings([
    ...(previous?.turnAliases || []),
    ...(protocolIdentity.semanticTurnAliases || []),
  ]);
  item.turnExchangeId = protocolIdentity.turnExchangeId || previous?.turnExchangeId || null;
  item.workingTurnId = protocolIdentity.workingTurnId || previous?.workingTurnId || null;
  item.turnRequestId = protocolIdentity.requestId || previous?.turnRequestId || null;
  item.turnTraceId = protocolIdentity.turnTraceId || previous?.turnTraceId || null;
  item.phase = protocolIdentity.phase || previous?.phase || null;
  item.channel = protocolIdentity.channel || previous?.channel || null;
  item.eventType = protocolIdentity.eventType || previous?.eventType || null;
  item.transportTurnId = protocolIdentity.transportSessionId || previous?.transportTurnId || null;
  item.turnUserMessageId = protocolIdentity.turnUserMessageId || previous?.turnUserMessageId || null;
  item.turnParentMessageId = options.turnParentMessageId || previous?.turnParentMessageId || null;
  item.captureId = options.captureId || previous?.captureId || null;
  item.captureTransport = options.captureTransport || previous?.captureTransport || null;
  item.observationOrdinal = previous?.observationOrdinal ?? options.observationOrdinal ?? null;
  item.sequenceNumber = previous?.sequenceNumber ?? protocolIdentity.sequenceNumber ?? null;
  // The merged raw body may retain an older sequence field when the newest
  // revision arrived on its envelope. Do not let that shadow the new event.
  item.lastSequenceNumber = incomingIdentity.sequenceNumber ?? previous?.lastSequenceNumber ?? null;
  item.outputIndex = previous?.outputIndex ?? protocolIdentity.outputIndex ?? null;
  item.contentIndex = protocolIdentity.contentIndex ?? previous?.contentIndex ?? null;
  item.responseId = protocolIdentity.responseId || previous?.responseId || null;
  item.callId = protocolIdentity.callId || previous?.callId || item.tool?.callId || null;
  item.toolCallId = protocolIdentity.toolCallId || previous?.toolCallId || item.tool?.toolCallId || null;
  item.callIds = uniqueStrings([
    ...(previous?.callIds || []),
    ...(protocolIdentity.callIds || []),
    ...(item.tool?.callIds || []),
  ]);
  item.observationMode = options.textMode || previous?.observationMode || null;
  item.firstSeenAt = previous?.firstSeenAt || Date.now();
  item.lastSeenAt = Date.now();
  item.observationKey = observationIdentityKey(viewObservationIdentity(item));

  if (index === -1) return [...messages, item];
  const next = messages.slice();
  // The raw delta has already been applied above. Never append its rendered
  // cumulative value a second time.
  next[index] = mergeLiveView(previous, item, options.textMode === "delta" ? { ...options, textMode: "snapshot" } : options);
  return next;
}

function findCompatibleObservationIndex(messages, incomingIdentity) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    const candidateIdentity = viewObservationIdentity(candidate);
    if (!observationSubjectsMatch(candidateIdentity, incomingIdentity)) continue;
    if (observationIdentitiesCompatible(candidateIdentity, incomingIdentity)) return index;
  }
  return -1;
}

function viewObservationIdentity(item) {
  return {
    turnExchangeId: item?.turnExchangeId || null,
    workingTurnId: item?.workingTurnId || null,
    turnRequestId: item?.turnRequestId || null,
    turnTraceId: item?.turnTraceId || null,
    turnUserMessageId: item?.turnUserMessageId || null,
    messageId: item?.id || null,
    itemId: item?.itemId || null,
    responseId: item?.responseId || null,
    outputIndex: firstFiniteNumber(item?.outputIndex),
    contentIndex: firstFiniteNumber(item?.contentIndex),
    sequenceNumber: firstFiniteNumber(item?.sequenceNumber),
    callId: item?.callId || item?.tool?.callId || null,
    toolCallId: item?.toolCallId || item?.tool?.toolCallId || null,
    callIds: uniqueStrings([
      ...(item?.callIds || []),
      ...(item?.tool?.callIds || []),
    ]),
    phase: item?.phase || null,
    channel: item?.channel || null,
    itemKind: item?.tool?.kind || item?.contentType || item?.role || null,
    contentType: item?.contentType || null,
    role: item?.role || null,
    semanticTurnAliases: semanticTurnAliases(item),
  };
}

function liveMessageToView(rawMessage, options = {}) {
  const metadata = rawMessage.metadata || {};
  const isAsyncReasoning = isAsyncReasoningMessage(rawMessage);
  const thought = extractThought(rawMessage);
  const tool = getToolMessageInfo(rawMessage);
  const text = isAsyncReasoning ? '' : contentToText(rawMessage.content, metadata, { literal: rawMessage.author?.role === 'user' });
  const status = rawMessage.status || (metadata.is_error ? "failed" : null);
  const error = status === "failed" || Boolean(metadata.is_error) || Boolean(metadata.error);
  const model = metadata.model_slug || metadata.default_model_slug || metadata.model || null;
  const reasoningEffort = metadata.thinking_effort || metadata.reasoning_effort || metadata.reasoning_effort_level || null;
  const thinkingLevel = metadata.thinking_level ? getThinkingLevel(metadata.thinking_level) : (reasoningEffort ? getThinkingLevel(reasoningEffort) : null);
  const durationSec = metadata.finished_duration_sec ?? null;
  const thinkingDuration = formatThinkingDuration(durationSec, metadata.reasoning_start_time, metadata.reasoning_end_time, metadata);
  const protocolIdentity = messageProtocolIdentity(rawMessage, options);

  const ct = String(rawMessage.content?.content_type || "");
  const isSpinner = ct === "tether_browsing_display" && !rawMessage.content?.result && !rawMessage.content?.summary;
  const role = isAsyncReasoning ? "assistant" : (rawMessage.author?.role || "assistant");

  const item = {
    id: rawMessage.id,
    nodeId: rawMessage.id,
    itemId: protocolIdentity.itemId,
    turnUserMessageId: protocolIdentity.turnUserMessageId,
    contentIndex: protocolIdentity.contentIndex,
    parentId: protocolIdentity.parentMessageId,
    turnId: protocolIdentity.semanticTurnAliases[0] || null,
    turnAliases: protocolIdentity.semanticTurnAliases,
    turnExchangeId: protocolIdentity.turnExchangeId,
    workingTurnId: protocolIdentity.workingTurnId,
    turnRequestId: protocolIdentity.requestId,
    turnTraceId: protocolIdentity.turnTraceId,
    responseId: protocolIdentity.responseId,
    sequenceNumber: protocolIdentity.sequenceNumber,
    outputIndex: protocolIdentity.outputIndex,
    callId: protocolIdentity.callId,
    toolCallId: protocolIdentity.toolCallId,
    callIds: protocolIdentity.callIds,
    phase: protocolIdentity.phase,
    channel: protocolIdentity.channel,
    eventType: protocolIdentity.eventType,
    role,
    contentType: ct || null,
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
  item.observationKey = observationIdentityKey({
    ...protocolIdentity,
    messageId: rawMessage.id,
    itemKind: tool?.kind || ct || role,
  });
  return item;
}

function mergeLiveView(previous, item, options = {}) {
  // Lifecycle fields only move forward: a status-less capture (DOM observer)
  // or an early in_progress delta must never regress a finished message.
  const finished = isTerminalMessage;
  const mergedStatus = item.status ?? previous.status ?? null;
  const mergedEndTurn = item.endTurn ?? previous.endTurn ?? null;
  const next = {
    ...previous,
    ...item,
    status: mergedStatus,
    endTurn: mergedEndTurn,
    error: options.textMode === "snapshot" ? item.error : (item.error || previous.error || false),
    name: item.name || previous.name || null,
    thought: options.textMode === "snapshot" ? item.thought : (mergeProgressiveText(previous.thought, item.thought) || null),
    thinkingDuration: item.thinkingDuration || previous.thinkingDuration || null,
    text: options.textMode === "snapshot" ? item.text : mergeProgressiveText(previous.text, item.text),
    model: item.model || previous.model || null,
    reasoningEffort: item.reasoningEffort || previous.reasoningEffort || null,
    thinkingLevel: item.thinkingLevel || previous.thinkingLevel || null,
    metadata: Object.keys(item.metadata || {}).length ? item.metadata : (previous.metadata || {}),
    tool: options.textMode === "snapshot" ? item.tool : mergeToolObservation(previous.tool, item.tool),
    isThinking: finished(previous) ? false : item.isThinking,
    unrecognized: Boolean(item.unrecognized),
  };
  if (finished(previous) && !finished({ status: mergedStatus, endTurn: mergedEndTurn })) {
    // Regressed (e.g. a stale in_progress capture): restore the finished state.
    return {
      ...next,
      status: previous.status,
      endTurn: previous.endTurn,
    };
  }
  return next;
}

function mergeToolObservation(previous, incoming) {
  if (!previous) return incoming || null;
  if (!incoming) return previous;
  if (previous.kind !== incoming.kind || previous.name !== incoming.name) return incoming;
  return {
    ...previous,
    ...incoming,
    title: incoming.title || previous.title || null,
    payload: mergeObservedValue(previous.payload, incoming.payload, "payload"),
  };
}

export function createConversationRecord(previous = null) {
  return {
    payload: previous?.payload || null,
    terminal: previous?.terminal || previous?.payload?.current_node || null,
    canonicalComplete: Boolean(previous?.canonicalComplete),
    canonicalSyncId: previous?.canonicalSyncId || null,
    canonicalSyncPayload: previous?.canonicalSyncPayload || null,
    canonicalSyncPages: previous?.canonicalSyncPages || [],
    canonicalSyncPageCount: previous?.canonicalSyncPageCount ?? null,
    canonicalRetiredSyncIds: previous?.canonicalRetiredSyncIds || [],
    canonicalSyncError: previous?.canonicalSyncError || null,
    observations: Array.isArray(previous?.observations) ? previous.observations : [],
  };
}

export function ingestConversationPayload(record, incomingPayload, options = {}) {
  const previous = createConversationRecord(record);
  const canonicalSyncId = typeof options.canonicalSyncId === "string" && options.canonicalSyncId
    ? options.canonicalSyncId
    : null;
  if (canonicalSyncId) {
    // Completion is a property of a contiguous, validated transaction, not
    // one packet's flag. The bridge may drop startup packets or replay them.
    if (previous.canonicalRetiredSyncIds.includes(canonicalSyncId)) return previous;
    const pageIndex = options.canonicalPageIndex;
    const suppliedCount = options.canonicalPageCount;
    const startsNewSync = previous.canonicalSyncId !== canonicalSyncId;
    const fail = (reason) => rejectCanonicalSync(previous, canonicalSyncId, reason);
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= 100) return fail('invalid-page-index');
    if (suppliedCount !== undefined && (!Number.isSafeInteger(suppliedCount) || suppliedCount < 1 || suppliedCount > 100)) return fail('invalid-page-count');
    if (startsNewSync && pageIndex !== 0) return fail('missing-page');
    const pageCount = suppliedCount ?? (startsNewSync ? null : previous.canonicalSyncPageCount);
    if (!startsNewSync && previous.canonicalSyncPageCount != null && pageCount !== previous.canonicalSyncPageCount) return fail('changed-page-count');
    if (pageCount != null && (pageIndex >= pageCount || (options.canonicalComplete === true) !== (pageIndex === pageCount - 1))) return fail('invalid-completion');
    if (!incomingPayload?.mapping || typeof incomingPayload.mapping !== 'object' || Array.isArray(incomingPayload.mapping)) return fail('invalid-page');
    const scope = resolveConversationScope(
      options.conversationId, incomingPayload.id, incomingPayload.conversation_id, incomingPayload.conversationId,
      conversationIdFromPayload(previous.payload),
      startsNewSync ? null : conversationIdFromPayload(previous.canonicalSyncPayload),
    );
    if (scope.conflicted) return fail('conversation-mismatch');
    const receipts = startsNewSync ? [] : previous.canonicalSyncPages;
    if (pageIndex > receipts.length) return fail('missing-page');
    if (pageIndex < receipts.length) {
      const received = receipts[pageIndex];
      return received.complete === (options.canonicalComplete === true) &&
        JSON.stringify(received.payload) === JSON.stringify(incomingPayload)
        ? previous : fail('conflicting-page');
    }
    const retired = startsNewSync && previous.canonicalSyncId
      ? retireCanonicalSync(previous.canonicalRetiredSyncIds, previous.canonicalSyncId)
      : previous.canonicalRetiredSyncIds;
    const stagedBase = startsNewSync ? null : previous.canonicalSyncPayload;
    const stagedPayload = stagedBase
      ? mergeConversationPayload(stagedBase, incomingPayload)
      : incomingPayload;
    if (!stagedPayload) return previous;
    if (options.canonicalComplete !== true) {
      return {
        ...previous,
        canonicalSyncId,
        canonicalSyncPayload: stagedPayload,
        canonicalSyncPages: [...receipts, { payload: incomingPayload, complete: false }],
        canonicalSyncPageCount: pageCount,
        canonicalRetiredSyncIds: retired,
        canonicalSyncError: null,
      };
    }

    const previousPayload = previous.payload;
    const payload = retainCanonicalTail(stagedPayload, previousPayload);
    const followedLatest = !previousPayload || !previous.terminal || previous.terminal === previousPayload.current_node;
    const terminal = followedLatest
      ? payload.current_node
      : (payload.mapping?.[previous.terminal] ? previous.terminal : payload.current_node);
    return {
      payload,
      terminal,
      canonicalComplete: true,
      canonicalSyncId: null,
      canonicalSyncPayload: null,
      canonicalSyncPages: [],
      canonicalSyncPageCount: null,
      canonicalRetiredSyncIds: retireCanonicalSync(retired, canonicalSyncId),
      canonicalSyncError: null,
      observations: previous.observations,
    };
  }

  const explicitCompleteness = Object.prototype.hasOwnProperty.call(options, "canonicalComplete");
  const previousPayload = previous.payload;
  const payload = previousPayload
    ? mergeConversationPayload(previousPayload, incomingPayload)
    : incomingPayload;
  if (!payload) return previous;

  const followedLatest = !previousPayload || !previous.terminal || previous.terminal === previousPayload.current_node;
  const terminal = followedLatest
    ? payload.current_node
    : (payload.mapping?.[previous.terminal] ? previous.terminal : payload.current_node);
  let observations = previous.observations;
  if (previous.canonicalComplete && options.canonicalComplete === false) {
    // A short history response may contain fresh output outside the known
    // branch. Preserve that observation without inventing a parent edge or
    // turning partial user history into extra pages. Already-known alternate
    // branches remain branches, not live observations.
    const selected = new Set(buildCanonicalConversationView(payload, terminal).map((row) => row.nodeId));
    for (const node of Object.values(incomingPayload?.mapping || {})) {
      if (!node?.message || selected.has(node.id)) continue;
      const alreadyObserved = observations.some((item) => item.id === node.message.id);
      if (previousPayload?.mapping?.[node.id] && !alreadyObserved) continue;
      const row = messageNodeToView(node, payload.mapping);
      if (row.role === 'user' || isInternalConversationContext(row)) continue;
      observations = upsertLiveMessage(observations, node.message, {
        textMode: 'snapshot',
        parentMessageId: node.parent || null,
        captureTransport: 'canonical-partial',
      });
    }
  }
  return {
    ...previous,
    payload,
    terminal,
    canonicalComplete: previous.canonicalComplete ||
      (explicitCompleteness ? options.canonicalComplete === true : true),
    canonicalSyncId: previous.canonicalSyncId,
    canonicalSyncPayload: previous.canonicalSyncPayload,
    observations,
  };
}

function retireCanonicalSync(ids, id) {
  return [...ids.filter((value) => value !== id), id].slice(-32);
}

export function finishCanonicalSync(record, syncId) {
  const current = createConversationRecord(record);
  if (!syncId || current.canonicalRetiredSyncIds.includes(syncId)) return record || current;
  // The sender finished but this receiver did not commit: at least one page
  // was lost. Release staging and retire the transaction, not the last good
  // history. Late fragments must not revive it after this boundary.
  return rejectCanonicalSync(current, syncId, 'missing-page');
}

function rejectCanonicalSync(record, id, reason) {
  const clear = record.canonicalSyncId === id || !record.canonicalSyncId;
  return {
    ...record,
    ...(clear ? { canonicalSyncId: null, canonicalSyncPayload: null, canonicalSyncPages: [], canonicalSyncPageCount: null } : {}),
    canonicalRetiredSyncIds: retireCanonicalSync(record.canonicalRetiredSyncIds, id),
    canonicalSyncError: reason,
  };
}

function retainCanonicalTail(staged, previous) {
  if (!previous?.mapping || !previous.current_node || !staged?.current_node ||
      staged.mapping[previous.current_node] ||
      !isConversationAncestor(previous.mapping, staged.current_node, previous.current_node)) return staged;
  const tail = [];
  let cursor = previous.current_node;
  while (cursor !== staged.current_node) {
    const node = previous.mapping[cursor];
    if (!staged.mapping[cursor]) tail.push({ ...node, children: [] });
    cursor = node.parent;
  }
  tail.reverse();
  // Retain only the proven newer suffix. Re-merging the entire old payload
  // here would overwrite newly corrected ancestors with stale snapshots.
  return mergeConversationPayload(staged, {
    id: staged.id, current_node: previous.current_node,
    mapping: Object.fromEntries(tail.map((node) => [node.id, node])),
    ...(staged.message_order ? { message_order: tail.map((node) => node.id) } : {}),
  });
}

export function ingestConversationMessage(record, rawMessage, options = {}) {
  const previous = createConversationRecord(record);
  return {
    ...previous,
    observations: upsertLiveMessage(previous.observations, rawMessage, options),
  };
}

export function hydrateConversationObservations(record, observations) {
  let current = createConversationRecord(record);
  if (!Array.isArray(observations)) return current;
  for (const observation of observations) {
    if (!observation?.id) continue;
    const hydratedIdentity = viewObservationIdentity(observation);
    const index = current.observations.findIndex((item) => (
      observationSubjectsMatch(viewObservationIdentity(item), hydratedIdentity) &&
      observationIdentitiesCompatible(viewObservationIdentity(item), hydratedIdentity)
    ));
    const next = current.observations.slice();
    if (index === -1) next.push({ ...observation });
    else next[index] = mergeHydratedObservation(observation, next[index]);
    current = {
      ...current,
      observations: next,
    };
  }
  return current;
}

export function bindConversationTurnUser(record, turnId, userMessageId) {
  const current = createConversationRecord(record);
  if (!turnId || !userMessageId) return current;
  let changed = false;
  const observations = current.observations.map((observation) => {
    if (
      !observation ||
      !semanticTurnAliases(observation).includes(turnId) ||
      observation.turnUserMessageId === userMessageId
    ) {
      return observation;
    }
    changed = true;
    return { ...observation, turnUserMessageId: userMessageId };
  });
  return changed ? { ...current, observations } : current;
}

function mergeHydratedObservation(persisted, current) {
  if (!current) return { ...persisted };
  const currentRevision = firstFiniteNumber(current.lastSequenceNumber, current.sequenceNumber);
  const peerRevision = firstFiniteNumber(persisted.lastSequenceNumber, persisted.sequenceNumber);
  const peerIsNewer = currentRevision != null && peerRevision != null && peerRevision > currentRevision;
  const winner = peerIsNewer ? persisted : current;
  const loser = peerIsNewer ? current : persisted;
  const winnerFinished = isFinishedViewMessage(winner);
  const loserFinished = isFinishedViewMessage(loser);
  const snapshot = winner.observationMode === 'snapshot';
  const merged = {
    ...loser,
    ...winner,
    text: snapshot ? (winner.text ?? '') : mergeProgressiveText(loser.text, winner.text),
    thought: snapshot ? winner.thought : (mergeProgressiveText(loser.thought, winner.thought) || null),
    tool: snapshot ? winner.tool : mergeToolObservation(loser.tool, winner.tool),
    metadata: snapshot ? mergeSnapshotObject(loser.metadata, winner.metadata) : mergeObservedMetadata(loser.metadata, winner.metadata),
    status: winnerFinished || !loserFinished ? winner.status : loser.status,
    endTurn: winnerFinished || !loserFinished ? winner.endTurn : loser.endTurn,
    firstSeenAt: Math.min(
      Number(persisted.firstSeenAt || Number.MAX_SAFE_INTEGER),
      Number(current.firstSeenAt || Number.MAX_SAFE_INTEGER),
    ),
    lastSeenAt: Math.max(Number(persisted.lastSeenAt || 0), Number(current.lastSeenAt || 0)),
  };
  // An old raw body cannot serve as the decoder base for a newer parsed peer
  // snapshot; the next complete network snapshot will re-establish it.
  if (peerIsNewer && !persisted._rawMessage) delete merged._rawMessage;
  return merged;
}

export function setConversationRecordTerminal(record, terminal) {
  const previous = createConversationRecord(record);
  if (!terminal || !previous.payload?.mapping?.[terminal]) return previous;
  return { ...previous, terminal };
}

export function buildConversationRecordView(record) {
  const timeline = buildConversationRecordTimeline(record);
  return [...timeline.turns, ...timeline.unresolved]
    .flatMap((turn) => [turn.user, ...(turn.replies || [])].filter(Boolean));
}

export function buildConversationRecordTurns(record, pendingUserMessage = null) {
  return buildConversationRecordTimeline(record, pendingUserMessage).turns;
}

export function buildConversationRecordTimeline(record, pendingUserMessage = null) {
  const current = createConversationRecord(record);
  const projection = canonicalProjection(current.payload, current.terminal);
  const allPayloadRows = projection.rows;
  const canonical = current.canonicalComplete ? allPayloadRows : [];
  const followingLatest = !current.payload ||
    !current.terminal ||
    current.terminal === current.payload.current_node;
  const branchObservations = current.canonicalComplete
    ? observationsWithoutForeignBranches(projection, current.observations)
    : current.observations;
  const observations = followingLatest
    ? branchObservations
    : observationsForSelectedBranch(canonical, branchObservations);
  const observationsByMessageId = groupObservationsByMessageId(observations);
  const usedObservations = new Set();
  const canonicalRows = canonical.map((row) => {
    const candidates = observationSubjectCandidates(observationsByMessageId, row);
    const canonicalIdentity = viewObservationIdentity(row);
    const observation = candidates.find((candidate) => (
      !usedObservations.has(candidate) &&
      observationIdentitiesCompatible(canonicalIdentity, viewObservationIdentity(candidate))
    ));
    if (!observation) return row;
    usedObservations.add(observation);
    return mergeCanonicalAndObservedView(row, observation);
  });

  const provisionalSourceRows = current.canonicalComplete ? [] : currentTurnOutputSuffix(allPayloadRows);
  const provisionalPayloadRows = provisionalSourceRows.map((row, index) => ({
    ...row, observationOnly: true, provisionalCanonical: true,
    observationOrdinal: Number.MAX_SAFE_INTEGER - provisionalSourceRows.length + index,
  }));
  const liveOnly = [
    ...observations.filter((observation) => observation?.id && !usedObservations.has(observation)),
    ...provisionalPayloadRows.filter((row) => !observationSubjectCandidates(observationsByMessageId, row)
      .some((observation) => observationIdentitiesCompatible(viewObservationIdentity(row), viewObservationIdentity(observation)))),
  ].sort(compareObservationOrder);
  const users = [...canonicalRows, ...liveOnly].filter(isVisibleConversationUser);
  if (pendingUserMessage && !users.some((user) => user.id === pendingUserMessage.id)) users.push(pendingUserMessage);
  const renderedNodeIds = new Set(canonicalRows.map((row) => row.nodeId));
  const hiddenParents = current.canonicalComplete
    ? projection.allRows.filter((row) => projection.selectedNodes.has(row.nodeId) && !renderedNodeIds.has(row.nodeId)) : [];
  const ownership = resolveOwnershipGraph([...canonicalRows, ...liveOnly, ...hiddenParents], users);

  const turns = [];
  const turnByUserId = new Map();
  const turnBySemanticId = new Map();
  const itemTurn = new Map();
  const responseTurn = new Map();
  const callTurn = new Map();
  // Canonical ChatGPT history is an ordered item stream. Real persisted
  // pages routinely contain hundreds of reasoning/tool/system items for a
  // handful of visible user turns, and many legitimate items have no parent
  // or belong to parallel parent chains. Establish user turns first, then
  // bind every canonical output by semantic turn identity/proven item chain.
  for (const row of canonicalRows) {
    if (isInternalConversationContext(row)) continue;
    if (isVisibleConversationUser(row)) {
      const turn = createTurnForUser(row, "canonical");
      turns.push(turn);
      indexTurn(turn, row, turnByUserId, turnBySemanticId, itemTurn);
      indexProtocolTurn(turn, row, responseTurn, callTurn);
    }
  }
  for (const user of users) {
    if (turnByUserId.has(user.id)) continue;
    const turn = createTurnForUser(user, user === pendingUserMessage ? 'pending' : 'observed');
    turns.push(turn);
    indexTurn(turn, user, turnByUserId, turnBySemanticId, itemTurn);
    indexProtocolTurn(turn, user, responseTurn, callTurn);
  }
  // Hidden context nodes can bridge a proven parent chain, but never render
  // as user turns. Keep these nodes in the traversal index only.
  const canonicalByMessageId = current.canonicalComplete ? projection.parentIndex : new Map();
  const canonicalUnassigned = new Map();
  const resolveCanonicalTarget = (row) => {
    const resolution = ownership.resolved.get(row);
    if (resolution) return { target: turnByUserId.get(resolution.userMessageId) || null, conflicted: false };
    // Do not fall back to untyped alias lookup after the complete graph has
    // detected a contradiction or a missing protocol anchor.
    if (ownership.failures.has(row)) return { target: null, conflicted: true };
    let target = row.turnUserMessageId ? turnByUserId.get(row.turnUserMessageId) : null;
    if (target) return { target, conflicted: false };
    if (row.turnUserMessageId) return { target: null, conflicted: true };
    const semanticResolution = resolveTurnFromSemanticIdentity(row, turnBySemanticId);
    target = semanticResolution.turn;
    let conflicted = semanticResolution.conflicted;
    if (!target && !conflicted) {
      const protocolResolution = resolveTurnFromProtocolIdentity(row, itemTurn, responseTurn, callTurn);
      target = protocolResolution.turn;
      conflicted = protocolResolution.conflicted;
    }
    if (!target && !conflicted) {
      target = resolveObservationTurnFromParents(row, canonicalByMessageId, itemTurn);
    }
    return { target, conflicted };
  };
  let canonicalPending = canonicalRows.filter((row) => !isInternalConversationContext(row) && row.role !== "user");
  let canonicalProgress = true;
  while (canonicalPending.length && canonicalProgress) {
    canonicalProgress = false;
    const remaining = [];
    for (const row of canonicalPending) {
      const { target } = resolveCanonicalTarget(row);
      if (!target) {
        remaining.push(row);
        continue;
      }
      const proof = ownership.resolved.get(row);
      appendTurnReply(target, { ...row, ownership: proof ? { userMessageId: proof.userMessageId, evidence: proof.evidence } : null });
      indexTurnItem(target, row, itemTurn);
      indexSemanticTurnAliases(target, row, turnBySemanticId);
      indexProtocolTurn(target, row, responseTurn, callTurn);
      canonicalProgress = true;
    }
    canonicalPending = remaining;
  }
  for (const row of canonicalPending) {
    const { conflicted } = resolveCanonicalTarget(row);
    const key = unresolvedObservationGroupKey(row, canonicalByMessageId, { ignoreIdentity: conflicted });
    let target = canonicalUnassigned.get(key);
    if (!target) {
      target = { id: `turn-canonical-unassigned-${key}`, turnKey: `canonical-unassigned:${key}`, user: null, replies: [], source: "canonical-unassigned" };
      canonicalUnassigned.set(key, target);
      turns.push(target);
    }
    appendTurnReply(target, { ...row, ownershipFailure: ownership.failures.get(row) });
  }

  if (pendingUserMessage) {
    const pendingId = pendingUserMessage.id || pendingUserMessage.nodeId;
    const alreadyPresent = pendingId && turnByUserId.has(pendingId);
    if (!alreadyPresent) {
      const pendingTurn = createTurnForUser(pendingUserMessage, "pending");
      turns.push(pendingTurn);
      indexTurn(pendingTurn, pendingUserMessage, turnByUserId, turnBySemanticId, itemTurn);
      indexProtocolTurn(pendingTurn, pendingUserMessage, responseTurn, callTurn);
    }
  }

  // User observations establish a turn before any output item is attached.
  for (const observation of liveOnly) {
    if (!isVisibleConversationUser(observation)) continue;
    if (turnByUserId.has(observation.id)) continue;
    const turn = createTurnForUser(observation, "observed");
    turns.push(turn);
    indexTurn(turn, observation, turnByUserId, turnBySemanticId, itemTurn);
    indexProtocolTurn(turn, observation, responseTurn, callTurn);
  }

  const observationByMessageId = uniqueObservationByMessageId(liveOnly);
  const attachObservation = (target, observation) => {
    const proof = ownership.resolved.get(observation);
    appendTurnReply(target, { ...observation, ownership: proof ? { userMessageId: proof.userMessageId, evidence: proof.evidence } : null, ownershipFailure: ownership.failures.get(observation) });
    indexTurnItem(target, observation, itemTurn);
    indexSemanticTurnAliases(target, observation, turnBySemanticId);
    indexProtocolTurn(target, observation, responseTurn, callTurn);
  };
  const resolveObservationTarget = (observation) => {
    const resolution = ownership.resolved.get(observation);
    if (resolution) return { target: turnByUserId.get(resolution.userMessageId) || null, identityConflict: false };
    if (ownership.failures.has(observation)) return { target: null, identityConflict: true };
    let target = null;
    let identityConflict = false;

    if (observation.turnUserMessageId) target = turnByUserId.get(observation.turnUserMessageId) || null;
    if (observation.turnUserMessageId && !target) return { target: null, identityConflict: true };
    if (!target) {
      const semanticResolution = resolveTurnFromSemanticIdentity(observation, turnBySemanticId);
      target = semanticResolution.turn;
      identityConflict = semanticResolution.conflicted;
    }
    if (!target && !identityConflict) {
      const protocolResolution = resolveTurnFromProtocolIdentity(observation, itemTurn, responseTurn, callTurn);
      target = protocolResolution.turn;
      identityConflict = protocolResolution.conflicted;
    }
    if (!target && !identityConflict) {
      target = resolveObservationTurnFromParents(
        observation,
        observationByMessageId,
        itemTurn,
      );
    }
    return { target, identityConflict };
  };
  const attachResolvableUntilStable = (input) => {
    let pending = input;
    let changed = true;
    while (changed && pending.length) {
      changed = false;
      const next = [];
      for (const observation of pending) {
        const { target } = resolveObservationTarget(observation);
        if (!target) {
          next.push(observation);
          continue;
        }
        attachObservation(target, observation);
        changed = true;
      }
      pending = next;
    }
    return pending;
  };

  let pendingOutputs = liveOnly.filter((observation) => (
    !isInternalConversationContext(observation) && observation.role !== "user"
  ));

  // Resolve to fixed point so arrival order cannot decide ownership. A tool
  // result/response item that arrives before its anchor gets another chance
  // after the anchor is indexed later in the same observed batch.
  pendingOutputs = attachResolvableUntilStable(pendingOutputs);

  // Strong semantic identity without a canonical user creates a current
  // observed session, never a historical fallback. Creating those sessions
  // can in turn unlock response/call/parent-linked items on another pass.
  const afterSemanticSessions = [];
  for (const observation of pendingOutputs) {
    if (ownership.failures.has(observation)) {
      afterSemanticSessions.push(observation);
      continue;
    }
    if (observation.turnUserMessageId && !turnByUserId.has(observation.turnUserMessageId)) {
      afterSemanticSessions.push(observation);
      continue;
    }
    const semanticResolution = resolveTurnFromSemanticIdentity(observation, turnBySemanticId);
    const protocolResolution = resolveTurnFromProtocolIdentity(observation, itemTurn, responseTurn, callTurn);
    const identityConflict = semanticResolution.conflicted || protocolResolution.conflicted;
    let target = semanticResolution.turn || protocolResolution.turn || null;

    if (!target && !identityConflict && semanticTurnAliases(observation).length) {
      const semanticId = semanticTurnAliases(observation)[0];
      target = {
        id: `turn-session-${semanticId}`,
        turnKey: semanticId,
        user: null,
        replies: [],
        source: "observed-session",
      };
      turns.push(target);
      indexSemanticTurnAliases(target, observation, turnBySemanticId);
    }

    if (!target) {
      afterSemanticSessions.push(observation);
      continue;
    }
    attachObservation(target, observation);
  }

  pendingOutputs = attachResolvableUntilStable(afterSemanticSessions);

  const unassignedTurns = new Map();
  for (const observation of pendingOutputs) {
    // Never guess a historical turn. Unknown output is grouped only with
    // evidence from the same response/request/parent component, never in
    // one global bucket that can reorder unrelated episodes.
    const { identityConflict } = resolveObservationTarget(observation);
    const groupKey = unresolvedObservationGroupKey(
      observation,
      observationByMessageId,
      { ignoreIdentity: identityConflict },
    );
    let target = unassignedTurns.get(groupKey) || null;
    if (!target) {
      target = {
        id: `turn-unassigned-${groupKey}`,
        turnKey: `unassigned:${groupKey}`,
        user: null,
        replies: [],
        source: "unassigned",
      };
      unassignedTurns.set(groupKey, target);
      turns.push(target);
    }
    attachObservation(target, observation);
  }

  for (const turn of turns) sortTurnReplies(turn);
  const populated = turns.filter((turn) => turn.user || turn.replies.length);
  return {
    turns: populated.filter((turn) => Boolean(turn.user)),
    unresolved: populated.filter((turn) => !turn.user),
    protocolIssues: populated.filter((turn) => !turn.user).flatMap((turn) => turn.replies.map((row) => row.ownershipFailure).filter(Boolean)),
  };
}

function groupObservationsByMessageId(observations) {
  const grouped = new Map();
  for (const observation of observations || []) {
    for (const id of uniqueStrings([observation?.id, observation?.nodeId, observation?.itemId])) {
      const items = grouped.get(id) || [];
      if (!items.includes(observation)) items.push(observation);
      grouped.set(id, items);
    }
  }
  return grouped;
}

function observationSubjectCandidates(index, item) {
  const candidates = [];
  const seen = new Set();
  for (const id of uniqueStrings([item?.id, item?.nodeId, item?.itemId])) {
    for (const observation of index.get(id) || []) {
      if (seen.has(observation)) continue;
      seen.add(observation);
      candidates.push(observation);
    }
  }
  return candidates;
}

function uniqueObservationByMessageId(observations) {
  const grouped = groupObservationsByMessageId(observations);
  const unique = new Map();
  for (const [id, items] of grouped) unique.set(id, items.length === 1 ? items[0] : null);
  return unique;
}

function currentTurnOutputSuffix(rows) {
  const source = Array.isArray(rows) ? rows : [];
  let lastVisibleUser = -1;
  for (let index = 0; index < source.length; index += 1) {
    if (isVisibleConversationUser(source[index])) lastVisibleUser = index;
  }
  const suffix = lastVisibleUser >= 0
    ? source.slice(lastVisibleUser + 1)
    : source.slice(-1);
  return suffix.filter((row) => row?.role !== "user" && !isInternalConversationContext(row));
}

function sortTurnReplies(turn) {
  const replies = Array.isArray(turn?.replies) ? turn.replies : [];
  if (replies.length < 2) return;
  const idIndex = new Map();
  const indexReplyId = (id, index) => {
    if (!id) return;
    if (!idIndex.has(id)) {
      idIndex.set(id, index);
      return;
    }
    if (idIndex.get(id) !== index) idIndex.set(id, null);
  };
  replies.forEach((reply, index) => {
    indexReplyId(reply?.id, index);
    indexReplyId(reply?.nodeId, index);
    indexReplyId(reply?.itemId, index);
  });
  const indegree = new Array(replies.length).fill(0);
  const children = Array.from({ length: replies.length }, () => []);
  const edges = new Set();
  const addEdge = (parentIndex, childIndex) => {
    if (parentIndex == null || childIndex == null || parentIndex === childIndex) return;
    const key = `${parentIndex}:${childIndex}`;
    if (edges.has(key)) return;
    edges.add(key);
    children[parentIndex].push(childIndex);
    indegree[childIndex] += 1;
  };
  for (let index = 0; index < replies.length; index += 1) {
    const parentIndex = idIndex.get(replies[index]?.parentId);
    addEdge(parentIndex, index);
  }

  // Tool results are ordered after the call they explicitly answer, even if
  // transport delivery is interleaved or arrives out of order.
  const callIndex = new Map();
  for (let index = 0; index < replies.length; index += 1) {
    if (replies[index]?.tool?.kind !== "tool-call") continue;
    for (const callId of itemCallIds(replies[index])) {
      if (!callIndex.has(callId)) callIndex.set(callId, index);
      else if (callIndex.get(callId) !== index) callIndex.set(callId, null);
    }
  }
  for (let index = 0; index < replies.length; index += 1) {
    if (replies[index]?.tool?.kind !== "tool-result") continue;
    for (const callId of itemCallIds(replies[index])) {
      const parentIndex = callIndex.get(callId);
      if (parentIndex != null) addEdge(parentIndex, index);
    }
  }
  const originalIndex = new Map(replies.map((reply, index) => [reply, index]));
  const ready = [];
  for (let index = 0; index < replies.length; index += 1) if (indegree[index] === 0) ready.push(index);
  const compareIndex = (left, right) => compareTurnReplyOrder(
    replies[left],
    replies[right],
    originalIndex.get(replies[left]),
    originalIndex.get(replies[right]),
  );
  ready.sort(compareIndex);
  const ordered = [];
  while (ready.length) {
    const index = ready.shift();
    ordered.push(replies[index]);
    for (const child of children[index]) {
      indegree[child] -= 1;
      if (indegree[child] === 0) {
        ready.push(child);
        ready.sort(compareIndex);
      }
    }
  }
  if (ordered.length === replies.length) {
    turn.replies = ordered;
  }
}

function compareTurnReplyOrder(left, right, leftIndex, rightIndex) {
  const sameResponse = !left?.responseId || !right?.responseId || left.responseId === right.responseId;
  const leftOutput = finiteNumber(left?.outputIndex);
  const rightOutput = finiteNumber(right?.outputIndex);
  if (sameResponse && leftOutput != null && rightOutput != null && leftOutput !== rightOutput) return leftOutput - rightOutput;
  const leftSequence = finiteNumber(left?.sequenceNumber);
  const rightSequence = finiteNumber(right?.sequenceNumber);
  if (sameResponse && leftSequence != null && rightSequence != null && leftSequence !== rightSequence) return leftSequence - rightSequence;
  const leftCanonical = finiteNumber(left?.canonicalOrdinal);
  const rightCanonical = finiteNumber(right?.canonicalOrdinal);
  if (leftCanonical != null && rightCanonical != null && leftCanonical !== rightCanonical) return leftCanonical - rightCanonical;
  const leftOrdinal = finiteNumber(left?.observationOrdinal);
  const rightOrdinal = finiteNumber(right?.observationOrdinal);
  if (leftOrdinal != null && rightOrdinal != null && leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
  return leftIndex - rightIndex;
}

function finiteNumber(value) {
  return firstFiniteNumber(value);
}

function isVisibleConversationUser(message) {
  if (message?.role !== "user") return false;
  if (isInternalConversationContext(message)) return false;
  return Boolean(
    String(message?.text || "").trim() ||
    message?.unrecognized ||
    message?.tool
  );
}

function isInternalConversationContext(message) {
  const contentType = String(message?.contentType || message?.metadata?.content_type || "").toLowerCase();
  if (message?.role === "system" || message?.role === "developer") return true;
  return contentType === "user_editable_context" ||
    contentType === "model_editable_context" ||
    Boolean(message?.metadata?.is_visually_hidden_from_conversation && !message?.tool && !message?.thought);
}

function createTurnForUser(user, source) {
  const userId = user?.id || user?.nodeId || `anonymous-${source}`;
  const turnKey = semanticTurnAliases(user)[0] || `user:${userId}`;
  return {
    id: `turn-${turnKey}`,
    turnKey,
    user,
    replies: [],
    source,
  };
}

function indexTurn(turn, user, turnByUserId, turnBySemanticId, itemTurn) {
  for (const userId of uniqueStrings([user?.id, user?.nodeId, user?.itemId, user?.turnUserMessageId])) indexUniqueTurn(turnByUserId, userId, turn);
  indexSemanticTurnAliases(turn, user, turnBySemanticId);
  indexTurnItem(turn, user, itemTurn);
}

function semanticTurnAliases(item) {
  return uniqueStrings([
    ...(item?.turnAliases || []),
    item?.turnId,
    item?.turnExchangeId,
    item?.workingTurnId,
    item?.turnRequestId,
    item?.turnTraceId,
  ]);
}

function indexSemanticTurnAliases(turn, item, turnBySemanticId) {
  for (const alias of semanticTurnAliases(item)) {
    indexUniqueTurn(turnBySemanticId, alias, turn);
  }
}

function resolveTurnFromSemanticIdentity(observation, turnBySemanticId) {
  const candidates = new Set();
  let conflicted = false;
  for (const alias of semanticTurnAliases(observation)) {
    if (!turnBySemanticId.has(alias)) continue;
    const turn = turnBySemanticId.get(alias);
    if (!turn) conflicted = true;
    else candidates.add(turn);
  }
  if (candidates.size > 1) conflicted = true;
  return {
    turn: conflicted ? null : (candidates.values().next().value || null),
    conflicted,
  };
}

function indexTurnItem(turn, item, itemTurn) {
  for (const id of uniqueStrings([item?.id, item?.nodeId, item?.itemId])) {
    indexUniqueTurn(itemTurn, id, turn);
  }
}

function indexProtocolTurn(turn, item, responseTurn, callTurn) {
  if (item?.responseId) indexUniqueTurn(responseTurn, item.responseId, turn);
  for (const callId of itemCallIds(item)) indexUniqueTurn(callTurn, callId, turn);
}

function indexUniqueTurn(index, key, turn) {
  if (!key) return;
  if (!index.has(key)) {
    index.set(key, turn);
    return;
  }
  const previous = index.get(key);
  if (previous && previous !== turn) index.set(key, null);
}

function resolveTurnFromProtocolIdentity(observation, itemTurn, responseTurn, callTurn) {
  const candidates = new Set();
  let conflicted = false;
  const consider = (index, key) => {
    if (!key || !index.has(key)) return;
    const turn = index.get(key);
    if (!turn) conflicted = true;
    else candidates.add(turn);
  };
  consider(itemTurn, observation?.itemId);
  consider(responseTurn, observation?.responseId);
  for (const callId of itemCallIds(observation)) {
    consider(callTurn, callId);
  }
  if (candidates.size > 1) conflicted = true;
  return {
    turn: conflicted ? null : (candidates.values().next().value || null),
    conflicted,
  };
}

function itemCallIds(item) {
  return uniqueStrings([
    ...(item?.callIds || []),
    item?.callId,
    item?.toolCallId,
    ...(item?.tool?.callIds || []),
    item?.tool?.callId,
    item?.tool?.toolCallId,
  ]);
}

function resolveObservationTurnFromParents(observation, observationByMessageId, itemTurn) {
  const visited = new Set();
  let parentId = observation?.parentId || null;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    if (itemTurn.has(parentId)) {
      const turn = itemTurn.get(parentId);
      if (observation.turnExchangeId && turn?.user?.turnExchangeId && observation.turnExchangeId !== turn.user.turnExchangeId) return null;
      return turn;
    }
    const parent = observationByMessageId.get(parentId);
    if (!parent) break;
    if (isVisibleConversationUser(parent)) break;
    parentId = parent.parentId || null;
  }
  return null;
}

function unresolvedObservationGroupKey(observation, observationByMessageId, options = {}) {
  if (!options.ignoreIdentity) {
    const semanticId = semanticTurnAliases(observation)[0];
    if (semanticId) return `turn:${semanticId}`;
    if (observation?.responseId) return `response:${observation.responseId}`;
  }
  if (observation?.transportTurnId) return `transport:${observation.transportTurnId}`;
  if (observation?.captureId) return `capture:${observation.captureId}`;
  const visited = new Set();
  let current = observation;
  while (current?.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    const parent = observationByMessageId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return `root:${current?.id || observation?.id || "unknown"}`;
}

function compareObservationOrder(left, right) {
  const sameResponse = !left?.responseId || !right?.responseId || left.responseId === right.responseId;
  const leftOutput = finiteNumber(left?.outputIndex);
  const rightOutput = finiteNumber(right?.outputIndex);
  if (sameResponse && leftOutput != null && rightOutput != null && leftOutput !== rightOutput) {
    return leftOutput - rightOutput;
  }
  const leftSequence = finiteNumber(left?.sequenceNumber);
  const rightSequence = finiteNumber(right?.sequenceNumber);
  if (sameResponse && leftSequence != null && rightSequence != null && leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }
  const leftOrdinal = finiteNumber(left?.observationOrdinal);
  const rightOrdinal = finiteNumber(right?.observationOrdinal);
  if (leftOrdinal != null && rightOrdinal != null && leftOrdinal !== rightOrdinal) {
    return leftOrdinal - rightOrdinal;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function observationsWithoutForeignBranches(projection, observations) {
  if (!observations?.length) return observations || [];
  const { allRows, selectedNodes } = projection;
  const canonicalById = uniqueObservationByMessageId(allRows);
  const sideByNode = new Map([...selectedNodes].map((id) => [id, 1]));
  const sideOf = (row) => {
    const visited = new Set();
    let current = row;
    while (current && !visited.has(current.nodeId)) {
      const side = sideByNode.get(current.nodeId);
      if (side != null) {
        // Reaching a selected ancestor from a nonselected node proves a fork.
        const result = visited.size ? (side ? 2 : 0) : side;
        for (const id of visited) sideByNode.set(id, result);
        return result;
      }
      visited.add(current.nodeId);
      current = canonicalById.get(current.parentId);
    }
    // Disconnected partial-window observations are not a proven other branch.
    for (const id of visited) sideByNode.set(id, 0);
    return 0;
  };
  const canonicalEntries = allRows.map((row) => ({ row, side: sideOf(row), fixed: true }));
  const subjects = new Map();
  const responses = new Map();
  const calls = new Map();
  const add = (index, key, entry) => {
    if (!key) return;
    const group = index.get(key) || [];
    group.push(entry);
    index.set(key, group);
  };
  const indexEntry = (entry) => {
    for (const id of uniqueStrings([entry.row.id, entry.row.nodeId, entry.row.itemId])) add(subjects, id, entry);
    add(responses, entry.row.responseId, entry);
    for (const id of itemCallIds(entry.row)) add(calls, id, entry);
  };
  for (const entry of canonicalEntries) indexEntry(entry);
  const canonicalSubjects = groupObservationsByMessageId(allRows);
  const entries = observations.map((row) => {
    const identity = viewObservationIdentity(row);
    const matches = observationSubjectCandidates(canonicalSubjects, row)
      .filter((candidate) => observationIdentitiesCompatible(identity, viewObservationIdentity(candidate)));
    const side = matches.reduce((mask, candidate) => mask | sideOf(candidate), 0);
    return { row, side, fixed: Boolean(side) };
  });
  for (const entry of entries) indexEntry(entry);
  const ownerCache = new Map();
  const ownerOf = (row) => {
    if (ownerCache.has(row)) return ownerCache.get(row);
    const visited = new Set();
    let current = row;
    let owner = null;
    while (current && !visited.has(current)) {
      visited.add(current);
      if (current.turnUserMessageId || isVisibleConversationUser(current)) {
        owner = current.turnUserMessageId || current.id;
        break;
      }
      current = canonicalById.get(current.parentId);
    }
    ownerCache.set(row, owner);
    return owner;
  };
  const sameTurnEvidence = (row, anchor) => {
    const aliases = semanticTurnAliases(row);
    const anchorAliases = semanticTurnAliases(anchor);
    if (aliases.length && anchorAliases.length && !aliases.some((alias) => anchorAliases.includes(alias))) return false;
    const anchorOwner = ownerOf(anchor);
    return !(row.turnUserMessageId && anchorOwner && row.turnUserMessageId !== anchorOwner);
  };
  const evidence = (group, entry) => (group || []).reduce((mask, anchor) => (
    anchor !== entry && sameTurnEvidence(entry.row, anchor.row) ? mask | anchor.side : mask
  ), 0);
  // Masks only accumulate. Conflicting anchors (3) stay visible; a cycle
  // without a proven canonical anchor stays unknown (0), not guessed away.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (entry.fixed) continue;
      let mask = evidence(responses.get(entry.row.responseId), entry);
      for (const id of itemCallIds(entry.row)) mask |= evidence(calls.get(id), entry);
      if (!mask) mask = evidence(subjects.get(entry.row.parentId), entry);
      const next = entry.side | mask;
      if (entry.side !== next) { entry.side = next; changed = true; }
    }
  }
  return entries.filter((entry) => entry.side !== 2).map((entry) => entry.row);
}

function observationsForSelectedBranch(canonicalRows, observations) {
  const canonicalIds = new Set();
  const canonicalUserIds = new Set();
  const canonicalTurnAliases = new Set();
  for (const row of canonicalRows || []) {
    if (row?.id) canonicalIds.add(row.id);
    if (row?.nodeId) canonicalIds.add(row.nodeId);
    if (row?.role === "user") {
      if (row?.id) canonicalUserIds.add(row.id);
      if (row?.nodeId) canonicalUserIds.add(row.nodeId);
      for (const alias of semanticTurnAliases(row)) canonicalTurnAliases.add(alias);
    }
  }
  const source = (observations || []).filter((observation) => observation?.id);
  const byId = uniqueObservationByMessageId(source);
  const anchored = new Set();
  const foreign = new Set();
  const responseGroups = new Map();
  const callGroups = new Map();

  const addGroup = (groups, key, observation) => {
    if (!key) return;
    const group = groups.get(key) || [];
    group.push(observation);
    groups.set(key, group);
  };

  for (const observation of source) {
    const aliases = semanticTurnAliases(observation);
    const exactUser = observation.turnUserMessageId || null;
    const hasSelectedAlias = aliases.some((alias) => canonicalTurnAliases.has(alias));
    const hasForeignUser = Boolean(exactUser && !canonicalUserIds.has(exactUser));
    const hasForeignSemantic = Boolean(aliases.length && !hasSelectedAlias);
    if (hasForeignUser || hasForeignSemantic) foreign.add(observation);
    if (
      !foreign.has(observation) && (
        (exactUser && canonicalUserIds.has(exactUser)) ||
        hasSelectedAlias ||
        canonicalIds.has(observation.id) ||
        canonicalIds.has(observation.nodeId) ||
        canonicalIds.has(observation.parentId)
      )
    ) {
      anchored.add(observation);
    }
    addGroup(responseGroups, observation.responseId, observation);
    for (const callId of itemCallIds(observation)) addGroup(callGroups, callId, observation);
  }

  const groupCanPropagate = (group) => !group.some((observation) => foreign.has(observation));
  let changed = true;
  while (changed) {
    changed = false;
    for (const observation of source) {
      if (anchored.has(observation) || foreign.has(observation)) continue;
      const parent = observation.parentId ? byId.get(observation.parentId) : null;
      if (parent && anchored.has(parent)) {
        anchored.add(observation);
        changed = true;
        continue;
      }
      const responseGroup = observation.responseId ? responseGroups.get(observation.responseId) : null;
      if (responseGroup?.some((candidate) => anchored.has(candidate)) && groupCanPropagate(responseGroup)) {
        anchored.add(observation);
        changed = true;
        continue;
      }
      for (const callId of itemCallIds(observation)) {
        const callGroup = callGroups.get(callId);
        if (!callGroup?.some((candidate) => anchored.has(candidate)) || !groupCanPropagate(callGroup)) continue;
        anchored.add(observation);
        changed = true;
        break;
      }
    }
  }

  return source.filter((observation) => anchored.has(observation));
}

export function mergeConversationViewObservations(canonicalRows, observations) {
  const rows = Array.isArray(canonicalRows) ? canonicalRows.map((row) => ({ ...row })) : [];
  const observed = Array.isArray(observations) ? observations.filter(Boolean) : [];

  for (const observation of observed) {
    const observationIdentity = viewObservationIdentity(observation);
    const existingIndex = rows.findIndex((row) => (
      observationSubjectsMatch(viewObservationIdentity(row), observationIdentity) &&
      observationIdentitiesCompatible(viewObservationIdentity(row), observationIdentity)
    ));
    if (existingIndex >= 0) {
      rows[existingIndex] = mergeCanonicalAndObservedView(rows[existingIndex], observation);
      continue;
    }

    const nextRow = { ...observation, observationOnly: true };
    const insertionIndex = observationInsertionIndex(rows, nextRow);
    rows.splice(insertionIndex, 0, nextRow);
  }
  return rows;
}

function mergeCanonicalAndObservedView(canonical, observation) {
  const canonicalFinished = isFinishedViewMessage(canonical);
  const observedFinished = isFinishedViewMessage(observation);
  const preserveCanonicalLifecycle = canonicalFinished && !observedFinished;
  const snapshot = observation.observationMode === "snapshot";
  const preferCanonicalContent = (snapshot && canonicalFinished) || observation.captureTransport === "dom";
  return {
    ...canonical,
    ...observation,
    nodeId: canonical.nodeId || observation.nodeId,
    parentId: canonical.parentId || observation.parentId || null,
    itemId: observation.itemId || canonical.itemId || null,
    turnId: observation.turnId || canonical.turnId || null,
    turnAliases: uniqueStrings([
      ...(canonical.turnAliases || []),
      ...(observation.turnAliases || []),
    ]),
    turnExchangeId: observation.turnExchangeId || canonical.turnExchangeId || null,
    workingTurnId: observation.workingTurnId || canonical.workingTurnId || null,
    turnRequestId: observation.turnRequestId || canonical.turnRequestId || null,
    turnTraceId: observation.turnTraceId || canonical.turnTraceId || null,
    turnUserMessageId: observation.turnUserMessageId || canonical.turnUserMessageId || null,
    turnParentMessageId: observation.turnParentMessageId || canonical.turnParentMessageId || null,
    responseId: observation.responseId || canonical.responseId || null,
    sequenceNumber: observation.sequenceNumber ?? canonical.sequenceNumber ?? null,
    outputIndex: observation.outputIndex ?? canonical.outputIndex ?? null,
    callId: observation.callId || canonical.callId || null,
    toolCallId: observation.toolCallId || canonical.toolCallId || null,
    callIds: uniqueStrings([
      ...(canonical.callIds || []),
      ...(observation.callIds || []),
    ]),
    phase: observation.phase || canonical.phase || null,
    channel: observation.channel || canonical.channel || null,
    eventType: observation.eventType || canonical.eventType || null,
    canonicalOrdinal: canonical.canonicalOrdinal ?? observation.canonicalOrdinal ?? null,
    siblingIndex: canonical.siblingIndex ?? observation.siblingIndex,
    siblingCount: canonical.siblingCount ?? observation.siblingCount,
    siblingNodeIds: canonical.siblingNodeIds || observation.siblingNodeIds,
    text: preferCanonicalContent ? canonical.text : snapshot ? observation.text : mergeProgressiveText(canonical.text, observation.text),
    cacheRedacted: preferCanonicalContent ? false : Boolean(observation.cacheRedacted),
    thought: preferCanonicalContent ? canonical.thought : snapshot ? observation.thought : (mergeProgressiveText(canonical.thought, observation.thought) || null),
    tool: preferCanonicalContent ? canonical.tool : snapshot ? observation.tool : mergeToolObservation(canonical.tool, observation.tool),
    metadata: mergeObservedMetadata(canonical.metadata, observation.metadata),
    status: preserveCanonicalLifecycle ? canonical.status : (observation.status ?? canonical.status),
    endTurn: preserveCanonicalLifecycle ? canonical.endTurn : (observation.endTurn ?? canonical.endTurn),
    error: canonical.error || observation.error || false,
    live: preserveCanonicalLifecycle ? false : Boolean(observation.live),
    isThinking: preserveCanonicalLifecycle ? false : Boolean(observation.isThinking),
    unrecognized: Boolean(canonical.unrecognized || observation.unrecognized),
  };
}

function isFinishedViewMessage(message) {
  return isTerminalMessage(message);
}

function observationInsertionIndex(rows, observation) {
  if (observation.parentId) {
    let parentIndex = -1;
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index]?.id === observation.parentId || rows[index]?.nodeId === observation.parentId) parentIndex = index;
    }
    if (parentIndex >= 0) {
      let index = parentIndex + 1;
      while (index < rows.length && rows[index]?.observationOnly && rows[index]?.parentId === observation.parentId) index += 1;
      return index;
    }
  }
  return rows.length;
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
  let hash = 2166136261;
  for (let index = 0; index < body.length; index += 1) hash = Math.imul(hash ^ body.charCodeAt(index), 16777619);
  return [
    capture?.requestId || "",
    capture?.url || "",
    capture?.transport || "",
    capture?.conversationId || "",
    capture?.conversationIdConflict ? "conflict" : "",
    capture?.canonicalSyncId || "",
    capture?.canonicalPageIndex ?? "",
    capture?.canonicalComplete ? "complete" : "",
    body.length,
    hash >>> 0,
    body.slice(0, 96),
    body.slice(-96),
  ].join("|");
}
