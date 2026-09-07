const INDEX_KEY = 'slimgpt:conversation-index:v1';
const SETTINGS_KEY = 'slimgpt:user-settings:v1';
const MODELS_CACHE_KEY = 'slimgpt:models-cache:v1';
const OBSERVATION_LEDGER_KEY = 'slimgpt:observation-ledger:v1';
const LEDGER_OMISSIONS_KEY = 'slimgpt:observation-ledger-omissions:v1';
const STORAGE_BRIDGE_CHANNEL = 'slimgpt-ui-v1';
const STORAGE_BRIDGE_HOST_ORIGIN = 'https://chatgpt.com';
const STORAGE_BRIDGE_TIMEOUT = 10_000;
const MAX_LEDGER_CONVERSATIONS = 24;
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;
const MAX_LEDGER_DEPTH = 64;
const MAX_LEDGER_NODES = 200_000;
const ledgerEncoder = new TextEncoder();

let storageBridgeRequestCounter = 0;
let storageBridgeWindow = null;
let storageBridgeMessageHandler = null;
const storageBridgeRequests = new Map();
const storageBridgeListeners = new Set();

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
  'search_model_queries',
  'inline_cot_expandable_content',
  'aggregate_result',
  'attachments',
  'content_references',
  'citations',
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
  const storage = storageArea();
  if (storage) {
    const value = await storage.get('conversationIndex');
    if (Array.isArray(value.conversationIndex)) return value.conversationIndex;
    const legacy = readLegacyJson(INDEX_KEY, []);
    const items = Array.isArray(legacy) ? legacy : [];
    if (items.length) await storage.set({ conversationIndex: items });
    return items;
  }
  const stored = readLegacyJson(INDEX_KEY, []);
  return Array.isArray(stored) ? stored : [];
}

export async function saveConversationIndex(items) {
  const limited = items.slice(0, 500);
  const storage = storageArea();
  if (storage) {
    await storage.set({ conversationIndex: limited });
    return;
  }
  localStorage.setItem(INDEX_KEY, JSON.stringify(limited));
}

export async function loadObservationLedger() {
  return (await loadObservationLedgerState()).entries;
}

export async function loadObservationLedgerState() {
  let stored = [];
  let omissions = [];
  let migrationStorage = null;
  try {
    const storage = storageArea();
    if (storage) {
      // Read payload and omission manifest together, so a concurrent save
      // cannot pair one cache revision with another revision's warnings.
      const value = await storage.get(['observationLedger', 'observationLedgerOmissions']);
      omissions = value.observationLedgerOmissions || [];
      if (Array.isArray(value.observationLedger)) stored = value.observationLedger;
      else {
        stored = readLegacyJson(OBSERVATION_LEDGER_KEY, []);
        if (stored.length) migrationStorage = storage;
      }
    } else {
      stored = readLegacyJson(OBSERVATION_LEDGER_KEY, []);
      omissions = readLegacyJson(LEDGER_OMISSIONS_KEY, []);
    }
  } catch {
    return { entries: [], omissions: [{ id: '*', reason: 'read-failed' }] };
  }
  const revalidatedOmissions = [];
  const entries = compactObservationLedger(stored, { onOmitted: (item) => revalidatedOmissions.push(item) });
  omissions = [...(Array.isArray(omissions) ? omissions : []), ...revalidatedOmissions];
  if (migrationStorage) {
    try {
      await migrationStorage.set({ observationLedger: entries, observationLedgerOmissions: omissions });
    } catch {
      // A failed migration write must not throw away a successful read.
      omissions.push({ id: '*', reason: 'write-failed' });
    }
  }
  return { entries, omissions };
}

export async function saveObservationLedger(records, options = {}) {
  const omissions = [];
  const compact = compactObservationLedger(records, { onOmitted: (item) => {
    omissions.push(item);
    options.onOmitted?.(item);
  } });
  const storage = storageArea();
  if (storage) {
    await storage.set({ observationLedger: compact, observationLedgerOmissions: omissions });
    return compact;
  }
  localStorage.setItem(OBSERVATION_LEDGER_KEY, JSON.stringify(compact));
  localStorage.setItem(LEDGER_OMISSIONS_KEY, JSON.stringify(omissions));
  return compact;
}

export function compactObservationLedger(records, { onOmitted } = {}) {
  const source = normalizeLedgerSource(records);
  const output = [];
  let usedBytes = 2;

  for (const entry of source) {
    const id = String(entry?.id || '').trim();
    const observations = Array.isArray(entry?.observations)
      ? entry.observations
      : [];
    if (!id || !observations.length) continue;

    if (output.length >= MAX_LEDGER_CONVERSATIONS) {
      onOmitted?.({ id, reason: 'conversation-limit' });
      continue;
    }
    const context = { nodes: 0, bytes: 0, ancestors: new Set(), redacted: false };
    let kept;
    try {
      kept = observations.map((item) => compactObservation(item, context)).filter(Boolean);
    } catch (error) {
      onOmitted?.({ id, reason: error.code || 'invalid-value' });
      continue;
    }
    if (!kept.length) continue;
    const compactEntry = { id, observations: kept };
    const entryBytes = ledgerEncoder.encode(JSON.stringify(compactEntry)).byteLength + 1;
    // Persistence is all-or-nothing per conversation. Never create a hidden
    // message-level sliding window just to satisfy a storage budget.
    if (entryBytes + 2 > MAX_LEDGER_BYTES || usedBytes + entryBytes > MAX_LEDGER_BYTES) {
      onOmitted?.({ id, reason: 'budget' });
      continue;
    }
    output.push(compactEntry);
    usedBytes += entryBytes;
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

function compactObservation(observation, context) {
  if (!observation?.id) return null;
  context.redacted = false;
  const compact = compactValue({
    id: observation.id,
    nodeId: observation.nodeId,
    itemId: observation.itemId,
    contentIndex: observation.contentIndex,
    lastSequenceNumber: observation.lastSequenceNumber,
    cacheRedacted: observation.cacheRedacted,
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
  }, context);
  if (context.redacted) compact.cacheRedacted = true;
  return compact && typeof compact === 'object' ? compact : null;
}

function compactMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const output = {};
  for (const key of PERSISTED_METADATA_KEYS) {
    if (!Object.hasOwn(metadata, key)) continue;
    // Null is meaningful: it can clear a previously observed error/value.
    output[key] = metadata[key];
  }
  return output;
}

function rejectLedgerValue(code) {
  const error = new Error('Conversation cannot be cached without changing its content');
  error.code = code;
  throw error;
}

function compactValue(value, context, depth = 0) {
  context.nodes += 1;
  if (context.nodes > MAX_LEDGER_NODES || depth > MAX_LEDGER_DEPTH) rejectLedgerValue('structure-limit');
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) rejectLedgerValue('invalid-value');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_LEDGER_BYTES) rejectLedgerValue('budget');
    context.bytes += ledgerEncoder.encode(value).byteLength;
    if (context.bytes > MAX_LEDGER_BYTES) rejectLedgerValue('budget');
    return value;
  }
  if (typeof value !== 'object') rejectLedgerValue('invalid-value');
  if (context.ancestors.has(value)) rejectLedgerValue('invalid-value');
  context.ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => compactValue(item, context, depth + 1));
    const pairs = [];
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (/^(?:authorization|cookie|set-cookie|access_token|refresh_token|session_token|resume_token|conduit_token|credential|credentials)$/i.test(key)) {
        context.redacted = true;
        continue;
      }
      context.bytes += ledgerEncoder.encode(key).byteLength;
      if (context.bytes > MAX_LEDGER_BYTES) rejectLedgerValue('budget');
      pairs.push([key, compactValue(child, context, depth + 1)]);
    }
    // __proto__ and constructor are legitimate payload keys, not setters.
    return Object.fromEntries(pairs);
  } finally {
    context.ancestors.delete(value);
  }
}

export async function loadUserSettings() {
  const storage = storageArea();
  if (storage) {
    const value = await storage.get('userSettings');
    if (value.userSettings && typeof value.userSettings === 'object') {
      return { ...DEFAULT_SETTINGS, ...value.userSettings };
    }
    const stored = readLegacyJson(SETTINGS_KEY, {});
    const legacy = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    if (Object.keys(legacy).length) await storage.set({ userSettings: legacy });
    return { ...DEFAULT_SETTINGS, ...legacy };
  }
  const stored = readLegacyJson(SETTINGS_KEY, {});
  return {
    ...DEFAULT_SETTINGS,
    ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}),
  };
}

export async function saveUserSettings(settings) {
  const safe = { ...DEFAULT_SETTINGS, ...settings };
  const storage = storageArea();
  if (storage) {
    await storage.set({ userSettings: safe });
    return safe;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(safe));
  return safe;
}

export async function loadCachedModels() {
  const storage = storageArea();
  if (storage) {
    const value = await storage.get('cachedModels');
    if (Array.isArray(value.cachedModels) && value.cachedModels.length) return value.cachedModels;
    const legacy = readLegacyJson(MODELS_CACHE_KEY, []);
    const models = Array.isArray(legacy) ? legacy : [];
    if (models.length) await storage.set({ cachedModels: models });
    return models.length ? models : DEFAULT_MODELS;
  }
  const stored = readLegacyJson(MODELS_CACHE_KEY, []);
  return Array.isArray(stored) && stored.length ? stored : DEFAULT_MODELS;
}

export async function saveCachedModels(models) {
  if (!Array.isArray(models) || !models.length) return;
  const storage = storageArea();
  if (storage) {
    await storage.set({ cachedModels: models });
    return;
  }
  localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(models));
}

function readLegacyJson(key, fallback) {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function extensionStorageArea(
  protocol = globalThis.location?.protocol || '',
  chromeApi = globalThis.chrome,
  browserApi = globalThis.browser,
) {
  if (!/^(?:chrome|moz)-extension:$/.test(protocol)) return null;
  return chromeApi?.storage?.local || browserApi?.storage?.local || null;
}

function storageArea(
  protocol = globalThis.location?.protocol || '',
  chromeApi = globalThis.chrome,
  browserApi = globalThis.browser,
  windowApi = globalThis.window,
) {
  return extensionStorageArea(protocol, chromeApi, browserApi) ||
    extensionStorageBridgeArea(protocol, windowApi);
}

function extensionStorageBridgeArea(protocol, windowApi) {
  if (
    !/^(?:chrome|moz)-extension:$/.test(protocol) ||
    !windowApi?.addEventListener ||
    !windowApi?.parent?.postMessage ||
    windowApi.parent === windowApi
  ) {
    return null;
  }
  ensureStorageBridgeListener(windowApi);
  return {
    async get(keys) {
      return requestStorageBridge('storage-get', {
        keys: Array.isArray(keys) ? keys : [keys],
      });
    },
    async set(values) {
      await requestStorageBridge('storage-set', { values });
    },
  };
}

function ensureStorageBridgeListener(windowApi) {
  if (storageBridgeWindow === windowApi && storageBridgeMessageHandler) return;
  if (storageBridgeWindow && storageBridgeMessageHandler) {
    storageBridgeWindow.removeEventListener?.('message', storageBridgeMessageHandler);
  }
  for (const request of storageBridgeRequests.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('Storage bridge context changed'));
  }
  storageBridgeRequests.clear();
  storageBridgeWindow = windowApi;
  storageBridgeMessageHandler = (event) => {
    if (
      event.source !== windowApi.parent ||
      event.origin !== STORAGE_BRIDGE_HOST_ORIGIN ||
      event.data?.channel !== STORAGE_BRIDGE_CHANNEL ||
      event.data?.direction !== 'bridge-to-ui'
    ) {
      return;
    }
    const payload = event.data.payload;
    if (payload?.type === 'storage-result') {
      const request = storageBridgeRequests.get(payload.requestId);
      if (!request) return;
      storageBridgeRequests.delete(payload.requestId);
      clearTimeout(request.timer);
      if (payload.ok) request.resolve(payload.values || {});
      else request.reject(new Error(payload.error || 'Storage bridge request failed'));
      return;
    }
    if (payload?.type === 'storage-change' && payload.values && typeof payload.values === 'object') {
      for (const listener of storageBridgeListeners) listener(payload.values);
    }
  };
  windowApi.addEventListener('message', storageBridgeMessageHandler);
}

function requestStorageBridge(type, payload) {
  const windowApi = storageBridgeWindow;
  if (!windowApi) return Promise.reject(new Error('Storage bridge is unavailable'));
  const requestId = `storage-${Date.now().toString(36)}-${(++storageBridgeRequestCounter).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      storageBridgeRequests.delete(requestId);
      reject(new Error('Storage bridge request timed out'));
    }, STORAGE_BRIDGE_TIMEOUT);
    storageBridgeRequests.set(requestId, { resolve, reject, timer });
    windowApi.parent.postMessage({
      channel: STORAGE_BRIDGE_CHANNEL,
      direction: 'ui-to-bridge',
      payload: { type, requestId, ...payload },
    }, STORAGE_BRIDGE_HOST_ORIGIN);
  });
}

export function subscribeStorageChanges(
  listener,
  protocol = globalThis.location?.protocol || '',
  chromeApi = globalThis.chrome,
  browserApi = globalThis.browser,
  windowApi = globalThis.window,
) {
  if (typeof listener !== 'function') return () => {};

  if (/^(?:chrome|moz)-extension:$/.test(protocol)) {
    const changed = chromeApi?.storage?.onChanged || browserApi?.storage?.onChanged;
    if (changed?.addListener) {
      const onChanged = (changes, areaName) => {
        if (areaName && areaName !== 'local') return;
        const update = {};
        if (changes?.conversationIndex) update.conversationIndex = changes.conversationIndex.newValue;
        if (changes?.observationLedger) update.observationLedger = changes.observationLedger.newValue;
        if (changes?.observationLedgerOmissions) update.observationLedgerOmissions = changes.observationLedgerOmissions.newValue;
        if (changes?.userSettings) update.userSettings = changes.userSettings.newValue;
        if (changes?.executionPulse) update.executionPulse = changes.executionPulse.newValue;
        if (Object.keys(update).length) listener(update);
      };
      changed.addListener(onChanged);
      return () => changed.removeListener?.(onChanged);
    }

    const bridge = extensionStorageBridgeArea(protocol, windowApi);
    if (!bridge) return () => {};
    storageBridgeListeners.add(listener);
    return () => storageBridgeListeners.delete(listener);
  }

  if (!windowApi?.addEventListener) return () => {};
  const onStorage = (event) => {
    const update = {};
    try {
      if (event.key === INDEX_KEY) update.conversationIndex = JSON.parse(event.newValue || '[]');
      else if (event.key === OBSERVATION_LEDGER_KEY) update.observationLedger = JSON.parse(event.newValue || '[]');
      else if (event.key === LEDGER_OMISSIONS_KEY) update.observationLedgerOmissions = JSON.parse(event.newValue || '[]');
      else if (event.key === SETTINGS_KEY) update.userSettings = JSON.parse(event.newValue || '{}');
    } catch {
      return;
    }
    if (Object.keys(update).length) listener(update);
  };
  windowApi.addEventListener('storage', onStorage);
  return () => windowApi.removeEventListener?.('storage', onStorage);
}
