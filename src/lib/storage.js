const INDEX_KEY = 'slimgpt:conversation-index:v1';
const SETTINGS_KEY = 'slimgpt:user-settings:v1';
const MODELS_CACHE_KEY = 'slimgpt:models-cache:v1';
const OBSERVATION_LEDGER_KEY = 'slimgpt:observation-ledger:v1';
const MAX_LEDGER_CONVERSATIONS = 24;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_LEDGER_STRING = 512 * 1024;
const MAX_LEDGER_ARRAY = 256;
const MAX_LEDGER_OBJECT_KEYS = 160;

const PERSISTED_METADATA_KEYS = new Set([
  'model_slug',
  'default_model_slug',
  'model',
  'thinking_effort',
  'reasoning_effort',
  'reasoning_effort_level',
  'thinking_level',
  'reasoning_start_time',
  'reasoning_end_time',
  'finished_duration_sec',
  'thought',
  'reasoning',
  'reasoning_content',
  'initial_text',
  'finished_text',
  'async_source',
  'cot_version',
  'parent_id',
  'turn_exchange_id',
  'working_turn_id',
  'request_id',
  'turn_trace_id',
  'phase',
  'channel',
  'real_author',
  'tool_name',
  'reasoning_title',
  'tool_calls',
  'search_result_groups',
  'search_queries',
  'inline_cot_expandable_content',
  'aggregate_result',
  'attachments',
  'is_error',
  'error',
]);

export const THINKING_LEVELS = [
  {
    level: 1,
    id: 'instant',
    slug: 'instant',
    model: 'gpt-5.6',
    effort: 'none',
    label: 'Instant',
    cnLabel: '即时',
    icon: '⚡',
    tip: 'GPT-5.6 极速响应，日常简单问答',
  },
  {
    level: 2,
    id: 'medium',
    slug: 'medium',
    model: 'gpt-5.6',
    effort: 'medium',
    label: 'Medium',
    cnLabel: '标准',
    icon: '✨',
    tip: 'GPT-5.6 标准思考，平衡速度与深度（默认）',
  },
  {
    level: 3,
    id: 'high',
    slug: 'high',
    model: 'gpt-5.6',
    effort: 'high',
    label: 'High',
    cnLabel: '高',
    icon: '🧠',
    tip: 'GPT-5.6 扩展思考，复杂逻辑与多步推理',
  },
  {
    level: 4,
    id: 'extra_high',
    slug: 'extra_high',
    model: 'gpt-5.6',
    effort: 'xhigh',
    label: 'Extra High',
    cnLabel: '超高',
    icon: '🔥',
    tip: 'GPT-5.6 强力思考，高难度任务与深度代码分析',
  },
  {
    level: 5,
    id: 'pro',
    slug: 'pro',
    model: 'gpt-5.6-pro',
    effort: 'max',
    label: 'Pro',
    cnLabel: 'Pro',
    icon: '👑',
    tip: 'GPT-5.6 Sol Pro 专家级计算，最深层学术与代码推理',
  },
];

export const DEFAULT_SETTINGS = {
  thinkingLevel: 2, // 1 to 5 (1: Instant, 2: Medium [default], 3: High, 4: Extra High, 5: Pro)
};

export async function loadConversationIndex() {
  const storage = extensionStorageArea();
  if (storage) {
    const value = await storage.get('conversationIndex');
    return Array.isArray(value.conversationIndex) ? value.conversationIndex : [];
  }
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
  } catch {
    return [];
  }
}

export async function saveConversationIndex(items) {
  const limited = items.slice(0, 500);
  const storage = extensionStorageArea();
  if (storage) {
    await storage.set({ conversationIndex: limited });
    return;
  }
  localStorage.setItem(INDEX_KEY, JSON.stringify(limited));
}

export async function loadObservationLedger() {
  let stored = [];
  try {
    const storage = extensionStorageArea();
    if (storage) {
      const value = await storage.get('observationLedger');
      stored = value.observationLedger;
    } else {
      stored = JSON.parse(localStorage.getItem(OBSERVATION_LEDGER_KEY) || '[]');
    }
  } catch {
    return [];
  }
  return compactObservationLedger(stored);
}

export async function saveObservationLedger(records) {
  const compact = compactObservationLedger(records);
  const storage = extensionStorageArea();
  if (storage) {
    await storage.set({ observationLedger: compact });
    return compact;
  }
  localStorage.setItem(OBSERVATION_LEDGER_KEY, JSON.stringify(compact));
  return compact;
}

export function compactObservationLedger(records) {
  const source = normalizeLedgerSource(records);
  const output = [];
  let usedBytes = 2;

  for (const entry of source.slice(0, MAX_LEDGER_CONVERSATIONS)) {
    const id = String(entry?.id || '').trim();
    const observations = Array.isArray(entry?.observations)
      ? entry.observations
      : [];
    if (!id || !observations.length) continue;

    const kept = observations.map(compactObservation).filter(Boolean);
    if (!kept.length) continue;
    const compactEntry = { id, observations: kept };
    const entryBytes = JSON.stringify(compactEntry).length + 1;
    // Persistence is all-or-nothing per conversation. Never create a hidden
    // message-level sliding window just to satisfy a storage budget.
    if (entryBytes + 2 > MAX_LEDGER_BYTES) continue;
    if (usedBytes + entryBytes > MAX_LEDGER_BYTES) continue;
    output.push(compactEntry);
    usedBytes += entryBytes;
    if (usedBytes >= MAX_LEDGER_BYTES) break;
  }
  return output;
}

function normalizeLedgerSource(records) {
  let source;
  if (records instanceof Map) {
    source = [...records.entries()].map(([id, record]) => ({
      id,
      observations: record?.observations || [],
    }));
  } else if (Array.isArray(records)) {
    source = records.map((entry) => ({
      id: entry?.id,
      observations: entry?.observations || entry?.record?.observations || [],
    }));
  } else {
    return [];
  }
  return source.sort((left, right) => ledgerRecency(right) - ledgerRecency(left));
}

function ledgerRecency(entry) {
  let latest = 0;
  for (const observation of entry?.observations || []) {
    latest = Math.max(
      latest,
      Number(observation?.lastSeenAt || 0),
      Number(observation?.createTime || 0) * 1000,
    );
  }
  return latest;
}

function compactObservation(observation) {
  if (!observation?.id) return null;
  const compact = compactValue({
    id: observation.id,
    nodeId: observation.nodeId,
    itemId: observation.itemId,
    contentType: observation.contentType,
    role: observation.role,
    name: observation.name,
    text: observation.text,
    thought: observation.thought,
    thinkingDuration: observation.thinkingDuration,
    createTime: observation.createTime,
    status: observation.status,
    error: observation.error,
    endTurn: observation.endTurn,
    siblingIndex: observation.siblingIndex,
    siblingCount: observation.siblingCount,
    siblingNodeIds: observation.siblingNodeIds,
    metadata: compactMetadata(observation.metadata),
    tool: observation.tool,
    model: observation.model,
    reasoningEffort: observation.reasoningEffort,
    thinkingLevel: observation.thinkingLevel,
    unrecognized: observation.unrecognized,
    parentId: observation.parentId,
    turnId: observation.turnId,
    turnAliases: observation.turnAliases,
    turnExchangeId: observation.turnExchangeId,
    workingTurnId: observation.workingTurnId,
    turnRequestId: observation.turnRequestId,
    turnTraceId: observation.turnTraceId,
    phase: observation.phase,
    channel: observation.channel,
    eventType: observation.eventType,
    transportTurnId: observation.transportTurnId,
    turnUserMessageId: observation.turnUserMessageId,
    turnParentMessageId: observation.turnParentMessageId,
    captureId: observation.captureId,
    captureTransport: observation.captureTransport,
    observationOrdinal: observation.observationOrdinal,
    sequenceNumber: observation.sequenceNumber,
    outputIndex: observation.outputIndex,
    responseId: observation.responseId,
    callId: observation.callId,
    toolCallId: observation.toolCallId,
    callIds: observation.callIds,
    observationKey: observation.observationKey,
    observationMode: observation.observationMode,
    firstSeenAt: observation.firstSeenAt,
    lastSeenAt: observation.lastSeenAt,
  });
  return compact && typeof compact === 'object' ? compact : null;
}

function compactMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const output = {};
  for (const key of PERSISTED_METADATA_KEYS) {
    if (metadata[key] == null) continue;
    output[key] = compactValue(metadata[key]);
  }
  return output;
}

function compactValue(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length <= MAX_LEDGER_STRING) return value;
    return `${value.slice(0, MAX_LEDGER_STRING)}\n… [SlimGPT local cache truncated oversized field]`;
  }
  if (depth >= 10) return null;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_LEDGER_ARRAY).map((item) => compactValue(item, depth + 1));
  }
  if (typeof value !== 'object') return null;
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_LEDGER_OBJECT_KEYS)) {
    if (/^(?:authorization|cookie|set-cookie|access_token|refresh_token|session_token|resume_token|conduit_token|credential|credentials)$/i.test(key)) continue;
    output[key] = compactValue(child, depth + 1);
  }
  return output;
}

export async function loadUserSettings() {
  const storage = extensionStorageArea();
  if (storage) {
    const value = await storage.get('userSettings');
    return { ...DEFAULT_SETTINGS, ...(value.userSettings || {}) };
  }
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveUserSettings(settings) {
  const safe = { ...DEFAULT_SETTINGS, ...settings };
  const storage = extensionStorageArea();
  if (storage) {
    await storage.set({ userSettings: safe });
    return safe;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(safe));
  return safe;
}

export async function loadCachedModels() {
  const storage = extensionStorageArea();
  if (storage) {
    const value = await storage.get('cachedModels');
    return Array.isArray(value.cachedModels) && value.cachedModels.length ? value.cachedModels : DEFAULT_MODELS;
  }
  try {
    const stored = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || '[]');
    return Array.isArray(stored) && stored.length ? stored : DEFAULT_MODELS;
  } catch {
    return DEFAULT_MODELS;
  }
}

export async function saveCachedModels(models) {
  if (!Array.isArray(models) || !models.length) return;
  const storage = extensionStorageArea();
  if (storage) {
    await storage.set({ cachedModels: models });
    return;
  }
  localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(models));
}

export function extensionStorageArea(
  protocol = globalThis.location?.protocol || '',
  chromeApi = globalThis.chrome,
  browserApi = globalThis.browser,
) {
  if (!/^(?:chrome|moz)-extension:$/.test(protocol)) return null;
  return chromeApi?.storage?.local || browserApi?.storage?.local || null;
}
