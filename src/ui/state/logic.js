// Pure application logic of the UI frame.
//
// `reducePage(state, message, P)` handles one accepted page→UI bridge message
// and `reduceAction(state, action, P)` one user action. Both return
// `{ state, effects }` where `state` is a NEW object (inputs are never
// mutated, except the opaque stream decoder objects, which are stateful by
// design) and `effects` is a list of side effects for the store to perform:
//   { type: 'post', message: string, fields: object }   UI → page message
//   { type: 'save', key: 'settings'|'drafts'|'conversationIndex'|'localConversations' }
//
// Logged-out free mode (bridge.auth === 'anon') has no server history: its
// conversations are kept on this device only ('localConversations', capped)
// and their list items carry `device: true`. Signed-in mode stays server-truth
// only: nothing of it is stored as conversation content.
// `P` is the protocol module (src/protocol/index.js); tests inject a fake.

export const NEW_CHAT_KEY = '';
const MAX_BUFFERED_EVENTS = 500;
const MAX_DRAFTS = 50;
const MAX_INDEX = 200;

/** @returns {UiState} */
export function initialState() {
  return {
    bridge: { connected: false, ready: false, loggedIn: null, auth: 'unknown', timedOut: false },
    online: true,
    officialVisible: false,
    efforts: [],
    list: [],
    listComplete: false,
    currentId: null,
    opening: undefined,
    convs: {},
    leaf: {},
    sync: {},
    streams: {},
    pending: null,
    sendError: null,
    streamError: null,
    drafts: {},
    settings: { effort: '' },
  };
}

/**
 * @typedef {ReturnType<typeof initialState>} UiState
 */

const post = (message, fields = {}) => ({ type: 'post', message, fields });
const save = (key) => ({ type: 'save', key });
const keyOf = (id) => id ?? NEW_CHAT_KEY;

function withEntry(object, key, value) {
  const next = { ...object };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function upsertListItem(list, item, { front = false } = {}) {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index < 0) return front ? [item, ...list] : [...list, item];
  const next = list.slice();
  next[index] = { ...next[index], ...item };
  return next;
}

const AUTH_MODES = ['user', 'anon', 'unknown'];
const FREE_FORMAT = 'conversation-source';
const TITLE_CHARS = 60;

/** Restore persisted values (from storage-get) into a state. `P` rebuilds device-only conversations. */
export function hydrate(state, stored = {}, P = null) {
  const next = { ...state };
  if (stored.settings && typeof stored.settings === 'object') {
    next.settings = { ...state.settings, ...pickSettings(stored.settings) };
  }
  if (stored.drafts && typeof stored.drafts === 'object') {
    const drafts = {};
    for (const [key, value] of Object.entries(stored.drafts)) if (typeof value === 'string' && value) drafts[key] = value;
    next.drafts = { ...drafts, ...state.drafts };
  }
  if (Array.isArray(stored.conversationIndex) && !state.list.length) {
    next.list = stored.conversationIndex
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({ id: item.id, title: String(item.title || ''), updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : null }));
  }
  if (P && stored.localConversations !== undefined) {
    let records = [];
    try { records = P.capLocalRecords(stored.localConversations); } catch { records = []; }
    let convs = next.convs;
    let list = next.list;
    for (const record of records.slice().reverse()) {
      let conv = null;
      try { conv = P.conversationFromLocalRecord(record); } catch { conv = null; }
      if (!conv) continue;
      // A conversation that is live right now wins over its stored copy.
      if (!convs[record.id]) convs = withEntry(convs, record.id, conv);
      const known = list.find((item) => item.id === record.id);
      list = upsertListItem(list, { id: record.id, title: known?.title || record.title, updatedAt: known?.updatedAt ?? record.updatedAt, device: true }, { front: !known });
    }
    next.convs = convs;
    next.list = list;
  }
  return next;
}

function pickSettings(settings) {
  return { effort: typeof settings.effort === 'string' ? settings.effort : '' };
}

/** Values to persist for one storage key. `P` is needed for 'localConversations'. */
export function persistable(state, key, P = null) {
  if (key === 'settings') return state.settings;
  if (key === 'localConversations') {
    if (!P) return undefined;
    const records = [];
    for (const item of state.list) {
      if (!item.device || !state.convs[item.id]) continue;
      let record = null;
      try { record = P.localRecordFromConversation(state.convs[item.id], { title: item.title, updatedAt: item.updatedAt }); } catch { record = null; }
      if (record) records.push(record);
    }
    try { return P.capLocalRecords(records); } catch { return []; }
  }
  if (key === 'drafts') {
    const entries = Object.entries(state.drafts).filter(([, value]) => value && value.trim());
    return Object.fromEntries(entries.slice(-MAX_DRAFTS));
  }
  if (key === 'conversationIndex') return state.list.filter((item) => !item.device).slice(0, MAX_INDEX);
  return undefined;
}

// ---------------------------------------------------------------- page → UI

export function reducePage(state, message, P) {
  switch (message?.type) {
    case 'hello': return onHello(state, message);
    case 'location': return onLocation(state, message, P);
    case 'conversation-list': return onList(state, message, P);
    case 'conversation': return onConversation(state, message, P);
    case 'conversation-error': return onConversationError(state, message);
    case 'stream-start': return onStreamStart(state, message, P);
    case 'stream-chunk': return onStreamChunk(state, message, P);
    case 'stream-end': return onStreamEnd(state, message, P);
    case 'send-result': return onSendResult(state, message);
    case 'takeover': return { state: { ...state, officialVisible: !!message.visible }, effects: [] };
    default: return { state, effects: [] };
  }
}

function onHello(state, message) {
  const efforts = Array.isArray(message.efforts) ? message.efforts.filter((item) => typeof item === 'string' && item) : [];
  const auth = AUTH_MODES.includes(message.auth) ? message.auth : 'unknown';
  const next = {
    ...state,
    bridge: { connected: true, ready: !!message.ready, loggedIn: typeof message.loggedIn === 'boolean' ? message.loggedIn : null, auth, timedOut: false },
    efforts,
  };
  const effects = [];
  if (next.settings.effort && efforts.includes(next.settings.effort)) effects.push(post('set-effort', { effort: next.settings.effort }));
  return { state: next, effects };
}

function onLocation(state, message, P) {
  const id = typeof message.conversationId === 'string' && message.conversationId ? message.conversationId : null;
  // While the user is opening a conversation, ignore stale locations.
  if (state.opening !== undefined && id !== state.opening) return { state, effects: [] };
  let next = { ...state, opening: undefined };
  const effects = [];
  if (id !== state.currentId) next = { ...next, currentId: id, sendError: null };
  // Free mode has no server history to ask for.
  if (id && !isFreeMode(next) && !next.convs[id] && !next.sync[id]) {
    next = { ...next, sync: withEntry(next.sync, id, { state: 'loading' }) };
    effects.push(post('refresh', { conversationId: id }));
  }
  return { state: next, effects };
}

function onList(state, message, P) {
  const items = P.parseConversationList(message.body);
  if (!Array.isArray(items)) return { state, effects: [] };
  let list;
  if (!message.offset) {
    // Keep locally known conversations the server list does not have yet
    // (fresh chats) and device-only free-mode conversations.
    const ids = new Set(items.map((item) => item.id));
    const local = state.list.filter((item) => !ids.has(item.id) && (item.local || item.device));
    list = [...local, ...items];
  } else {
    list = state.list;
    for (const item of items) list = upsertListItem(list, item);
  }
  return { state: { ...state, list, listComplete: !!message.complete }, effects: [save('conversationIndex')] };
}

function onConversation(state, message, P) {
  const id = message.conversationId;
  if (typeof id !== 'string' || !id) return { state, effects: [] };
  const parsed = P.parseConversation(message.body);
  if (!parsed) {
    return { state: { ...state, sync: withEntry(state.sync, id, { state: 'error', code: 'invalid', retryAfterSec: null }) }, effects: [] };
  }
  const conv = P.mergeConversation(state.convs[id] || null, parsed);
  const page = Number(message.page) || 1;
  const pages = Number(message.pages) || 1;
  let next = {
    ...state,
    convs: withEntry(state.convs, id, conv),
    sync: withEntry(state.sync, id, page >= pages ? { state: 'ready' } : { state: 'loading', page, pages }),
  };
  if (next.opening === id) next.opening = undefined;
  // The full history replaced whatever the broken stream left behind.
  if (page >= pages && next.streamError?.conversationId === id) next.streamError = null;
  const selected = next.leaf[id];
  if (selected && !conv.nodes.has(selected)) next.leaf = withEntry(next.leaf, id, undefined);
  if (conv.title) {
    const known = next.list.find((item) => item.id === id);
    if (!known || known.title !== conv.title) next.list = upsertListItem(next.list, { id, title: conv.title, ...(known ? {} : { updatedAt: null }) }, { front: true });
  }
  return { state: next, effects: [] };
}

function onConversationError(state, message) {
  const id = message.conversationId;
  if (typeof id !== 'string' || !id) return { state, effects: [] };
  const entry = { state: 'error', code: String(message.code || 'network'), retryAfterSec: Number.isFinite(message.retryAfterSec) ? message.retryAfterSec : null };
  return { state: { ...state, sync: withEntry(state.sync, id, entry) }, effects: [] };
}

function onStreamStart(state, message, P) {
  const streamId = message.streamId;
  if (typeof streamId !== 'string' || !streamId) return { state, effects: [] };
  const conversationId = typeof message.conversationId === 'string' && message.conversationId ? message.conversationId : null;
  const device = message.format === FREE_FORMAT;
  const userMessageId = message.userMessageId || null;
  const parentMessageId = message.parentMessageId || null;
  // Free mode: the submitted prompt (forwarded by the page) becomes the user
  // message; the server never sends it back.
  const userRaw = device && userMessageId && typeof message.userText === 'string'
    ? P.userMessageFromPrompt({ id: userMessageId, text: message.userText, parentId: parentMessageId })
    : null;
  const stream = {
    conversationId,
    startedNew: conversationId === null,
    userMessageId,
    parentMessageId,
    resume: !!message.resume,
    device,
    title: userRaw ? titleFrom(message.userText) : '',
    decoder: device ? P.createConversationSourceDecoder() : P.createStreamDecoder(),
    failed: false,
    buffered: userRaw && !conversationId ? [userRaw] : [],
  };
  let next = { ...state, streams: withEntry(state.streams, streamId, stream), streamError: null };
  const effects = [];
  if (conversationId) {
    if (!next.convs[conversationId]) next.convs = withEntry(next.convs, conversationId, P.createConversation(conversationId));
    // Follow the newest leaf of a conversation that starts generating.
    next.leaf = withEntry(next.leaf, conversationId, undefined);
    if (userRaw) {
      next.convs = withEntry(next.convs, conversationId, P.applyLiveMessage(next.convs[conversationId], userRaw, { fallbackParentId: parentMessageId }));
    }
    if (device) {
      next = noteDeviceConversation(next, conversationId, stream.title);
      effects.push(save('localConversations'));
    }
  }
  return { state: next, effects };
}

function titleFrom(text) {
  const line = String(text || '').trim().replace(/\s+/g, ' ');
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/** Mark a free-mode conversation as device-only in the list (newest first). */
function noteDeviceConversation(state, id, title) {
  const known = state.list.find((item) => item.id === id);
  const item = { id, title: known?.title || title || '', updatedAt: Math.floor(Date.now() / 1000), device: true };
  return { ...state, list: upsertListItem(state.list.filter((entry) => entry.id !== id), { ...known, ...item }, { front: true }) };
}

function onStreamChunk(state, message, P) {
  const stream = state.streams[message.streamId];
  if (!stream || stream.failed || typeof message.chunk !== 'string') return { state, effects: [] };
  return applyStreamEvents(state, message.streamId, stream.decoder.push(message.chunk), P);
}

function onStreamEnd(state, message, P) {
  const stream = state.streams[message.streamId];
  if (!stream) return { state, effects: [] };
  let result = { state, effects: [] };
  let early = message.ok === false;
  if (!stream.failed) {
    // An early end (Stop, dropped connection) is an interrupted reply, not a
    // parse failure: no warning, the canonical refresh below settles it.
    const events = stream.decoder.end();
    if (events.some((event) => event?.type === 'error' && event.code === 'truncated')) early = true;
    result = applyStreamEvents(state, message.streamId, early ? events.filter((event) => event?.type !== 'error') : events, P);
  }
  const finalStream = result.state.streams[message.streamId] || stream;
  let next = { ...result.state, streams: withEntry(result.state.streams, message.streamId, undefined) };
  const effects = [...result.effects];
  const id = finalStream.conversationId;
  if (early && id && next.convs[id] && typeof P.interruptLiveMessages === 'function') {
    next = { ...next, convs: withEntry(next.convs, id, P.interruptLiveMessages(next.convs[id])) };
  }
  if (finalStream.device) {
    // Free mode: no server history exists; keep what we saw on this device.
    if (id) {
      const updated = noteDeviceConversation(next, id, finalStream.title);
      return { state: updated, effects: [...effects, save('localConversations')] };
    }
    return { state: next, effects };
  }
  // Canonical history is re-fetched after EVERY stream end; it is also the
  // recovery path after a stream error (which already asked once at failure).
  if (id && !effects.some((effect) => effect.message === 'refresh' && effect.fields.conversationId === id)) {
    effects.push(post('refresh', { conversationId: id }));
  }
  return { state: next, effects };
}

/** Apply decoder events of one stream. Exported for tests. */
export function applyStreamEvents(state, streamId, events, P) {
  let next = state;
  let stream = { ...state.streams[streamId] };
  const effects = [];
  const commit = () => { next = { ...next, streams: withEntry(next.streams, streamId, stream) }; };

  const applyMessage = (conversationId, raw) => {
    const conv = next.convs[conversationId] || P.createConversation(conversationId);
    const fallbackParentId = raw && raw.id === stream.userMessageId ? stream.parentMessageId : stream.userMessageId;
    next = { ...next, convs: withEntry(next.convs, conversationId, P.applyLiveMessage(conv, raw, { fallbackParentId })) };
  };

  const adoptConversation = (conversationId) => {
    if (stream.conversationId) return;
    stream = { ...stream, conversationId };
    if (!next.convs[conversationId]) next = { ...next, convs: withEntry(next.convs, conversationId, P.createConversation(conversationId)) };
    if (stream.startedNew && next.currentId === null) {
      // A brand-new chat got its server id: move the view (and nothing else) there.
      next = { ...next, currentId: conversationId, opening: undefined };
      if (next.pending && next.pending.conversationId === null) next.pending = { ...next.pending, conversationId };
    }
    if (stream.device) {
      next = noteDeviceConversation(next, conversationId, stream.title);
      effects.push(save('localConversations'));
    } else if (!next.list.some((item) => item.id === conversationId)) {
      next = { ...next, list: upsertListItem(next.list, { id: conversationId, title: '', updatedAt: Math.floor(Date.now() / 1000), local: true }, { front: true }) };
    }
    const buffered = stream.buffered;
    stream = { ...stream, buffered: [] };
    for (const raw of buffered) applyMessage(conversationId, raw);
  };

  for (const event of events || []) {
    if (!event || stream.failed) break;
    if (event.type === 'conversation-id' && event.conversationId) {
      adoptConversation(event.conversationId);
    } else if (event.type === 'message' && event.raw) {
      if (event.conversationId) adoptConversation(event.conversationId);
      if (stream.conversationId) applyMessage(stream.conversationId, event.raw);
      else if (stream.buffered.length < MAX_BUFFERED_EVENTS) stream = { ...stream, buffered: [...stream.buffered, event.raw] };
    } else if (event.type === 'title' && typeof event.title === 'string') {
      if (event.conversationId) adoptConversation(event.conversationId);
      const id = stream.conversationId;
      if (id) {
        next = { ...next, list: upsertListItem(next.list, { id, title: event.title }, { front: true }) };
        effects.push(save('conversationIndex'));
      }
    } else if (event.type === 'error') {
      stream = { ...stream, failed: true };
      next = { ...next, streamError: { conversationId: stream.conversationId, code: event.code || 'invalid-json', device: !!stream.device } };
      if (stream.device) {
        // No server copy to recover from: keep the last good (interrupted) text.
        if (stream.conversationId) effects.push(save('localConversations'));
      } else if (stream.conversationId) effects.push(post('refresh', { conversationId: stream.conversationId }));
    }
  }
  commit();
  return { state: next, effects };
}

function onSendResult(state, message) {
  const pending = state.pending;
  if (!pending || pending.commandId !== message.commandId) return { state, effects: [] };
  if (message.ok) {
    return {
      state: { ...state, pending: null, sendError: null, drafts: withEntry(state.drafts, keyOf(pending.draftKey ?? pending.conversationId), undefined) },
      effects: [save('drafts')],
    };
  }
  return { state: { ...state, pending: null, sendError: { code: message.error || 'send-not-confirmed', conversationId: pending.conversationId } }, effects: [] };
}

// ---------------------------------------------------------------- UI actions

export function reduceAction(state, action, P) {
  switch (action?.type) {
    case 'open': {
      const id = action.conversationId ?? null;
      let next = { ...state, currentId: id, opening: id, sendError: null };
      if (id && !state.convs[id]) next.sync = withEntry(next.sync, id, { state: 'loading' });
      return { state: next, effects: [post('open', { conversationId: id })] };
    }
    case 'send': {
      const text = String(action.text ?? '');
      const check = canSend(state, P);
      if (!text.trim() || !check.ok) {
        return { state: check.reason === 'bridge' ? { ...state, sendError: { code: 'bridge', conversationId: state.currentId } } : state, effects: [] };
      }
      const pending = { commandId: action.commandId, conversationId: state.currentId, draftKey: keyOf(state.currentId), text };
      return { state: { ...state, pending, sendError: null }, effects: [post('send', { commandId: action.commandId, text })] };
    }
    case 'send-timeout': {
      if (!state.pending || state.pending.commandId !== action.commandId) return { state, effects: [] };
      return { state: { ...state, pending: null, sendError: { code: 'timeout', conversationId: state.pending.conversationId } }, effects: [] };
    }
    case 'stop': return { state, effects: [post('stop')] };
    case 'retry-sync': {
      const id = action.conversationId ?? state.currentId;
      if (!id || isFreeMode(state)) return { state, effects: [] };
      return {
        state: { ...state, sync: withEntry(state.sync, id, { state: 'loading' }), streamError: null },
        effects: [post('refresh', { conversationId: id })],
      };
    }
    case 'switch-branch': {
      const conv = currentConversation(state);
      if (!conv) return { state, effects: [] };
      const leafId = P.switchBranch(conv, action.nodeId, action.delta);
      if (!leafId) return { state, effects: [] };
      return { state: { ...state, leaf: withEntry(state.leaf, conv.id, leafId === conv.currentNodeId ? undefined : leafId) }, effects: [] };
    }
    case 'latest-branch': {
      if (!state.currentId) return { state, effects: [] };
      return { state: { ...state, leaf: withEntry(state.leaf, state.currentId, undefined) }, effects: [] };
    }
    case 'draft': {
      const key = keyOf(state.currentId);
      const text = String(action.text ?? '');
      return { state: { ...state, drafts: withEntry(state.drafts, key, text || undefined) }, effects: [save('drafts')] };
    }
    case 'dismiss-send-error': return { state: { ...state, sendError: null }, effects: [] };
    case 'set-effort': {
      const effort = String(action.effort ?? '');
      const effects = [save('settings')];
      if (effort) effects.unshift(post('set-effort', { effort }));
      return { state: { ...state, settings: { ...state.settings, effort } }, effects };
    }
    case 'show-official': return { state, effects: [post('show-official')] };
    case 'online': return { state: { ...state, online: !!action.online }, effects: [] };
    case 'bridge-timeout':
      return state.bridge.connected ? { state, effects: [] } : { state: { ...state, bridge: { ...state.bridge, timedOut: true } }, effects: [] };
    default: return { state, effects: [] };
  }
}

// ---------------------------------------------------------------- selectors

/** Logged-out free mode (no server history, conversations kept on this device). */
export function isFreeMode(state) {
  return state.bridge.auth === 'anon';
}

/** Official features available in the current auth mode. */
export function features(state) {
  const free = isFreeMode(state);
  // continueGeneration: the official UI has no Continue control any more
  // (Stop leaves Copy/Regenerate/…), so it is never offered.
  return { branches: !free, continueGeneration: false };
}

/**
 * Sidebar items for the current mode: device-only (free-mode) conversations
 * are listed only in free mode, server conversations only outside it.
 */
export function visibleList(state) {
  if (isFreeMode(state)) return state.list.filter((item) => item.device);
  return state.list.filter((item) => !item.device);
}

export function currentConversation(state) {
  return state.currentId ? state.convs[state.currentId] || null : null;
}

/** Leaf selected by the user, or null to follow the server's current node. */
export function selectedLeaf(state) {
  const conv = currentConversation(state);
  const leaf = conv ? state.leaf[conv.id] : undefined;
  return leaf && conv.nodes.has(leaf) ? leaf : null;
}

export function currentTurns(state, P) {
  const conv = currentConversation(state);
  return conv ? P.selectTurns(conv, selectedLeaf(state)) : [];
}

export function isOffBranch(state) {
  const conv = currentConversation(state);
  const leaf = selectedLeaf(state);
  return !!(conv && leaf && leaf !== conv.currentNodeId);
}

export function isRunning(state, conversationId = state.currentId) {
  return Object.values(state.streams).some((stream) => !stream.failed && (stream.conversationId ?? null) === (conversationId ?? null));
}

export function runningIds(state) {
  return new Set(Object.values(state.streams).filter((stream) => !stream.failed && stream.conversationId).map((stream) => stream.conversationId));
}

export function currentDraft(state) {
  return state.drafts[keyOf(state.currentId)] || '';
}

export function currentTitle(state) {
  if (!state.currentId) return '新对话';
  const item = state.list.find((entry) => entry.id === state.currentId);
  return item?.title || currentConversation(state)?.title || '未命名对话';
}

/** Whether a message can be sent now, and why not. */
export function canSend(state) {
  if (!state.bridge.connected || !state.bridge.ready) return { ok: false, reason: 'bridge' };
  if (state.bridge.loggedIn === false && !isFreeMode(state)) return { ok: false, reason: 'login' };
  if (state.pending) return { ok: false, reason: 'pending' };
  if (isRunning(state)) return { ok: false, reason: 'running' };
  if (isOffBranch(state)) return { ok: false, reason: 'branch' };
  if (state.currentId && state.sync[state.currentId]?.state === 'loading' && !currentConversation(state)?.complete) return { ok: false, reason: 'loading' };
  return { ok: true, reason: null };
}

export function filterList(list, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return list;
  return list.filter((item) => (item.title || '').toLocaleLowerCase().includes(needle));
}

const SYNC_ERRORS = {
  auth: '登录状态失效，无法同步对话',
  'rate-limit': '请求过于频繁，同步暂停',
  network: '网络错误，对话同步失败',
  'too-large': '对话过大，无法完整同步',
  invalid: '对话数据无法解析',
};

/**
 * The single status line. Returns null when everything is fine.
 * @returns {{ tone: 'info'|'warn'|'error', text: string, action?: { label: string, type: string } } | null}
 */
export function statusLine(state) {
  if (!state.online) return { tone: 'warn', text: '网络离线' };
  if (!state.bridge.connected) return state.bridge.timedOut ? { tone: 'warn', text: 'ChatGPT 页面桥尚未就绪' } : { tone: 'info', text: '连接中…' };
  if (state.bridge.loggedIn === false && !isFreeMode(state)) return { tone: 'warn', text: '未登录 ChatGPT，请先在官方界面登录', action: { label: '显示官方界面', type: 'show-official' } };
  if (!state.bridge.ready) return { tone: 'info', text: 'ChatGPT 页面加载中…' };
  const id = state.currentId;
  const sync = id ? state.sync[id] : null;
  if (sync?.state === 'error') {
    const wait = sync.retryAfterSec ? `，约 ${sync.retryAfterSec} 秒后可重试` : '';
    return { tone: 'error', text: `${SYNC_ERRORS[sync.code] || '对话同步失败'}${wait}`, action: { label: '重试同步', type: 'retry-sync' } };
  }
  if (state.streamError && state.streamError.conversationId === id && state.streamError.device) {
    return { tone: 'warn', text: '回复流中断，已保留收到的部分；免费模式无法从服务器恢复' };
  }
  if (state.streamError && state.streamError.conversationId === id) {
    return { tone: 'warn', text: '回复流无法解析，正在同步完整会话', action: { label: '重试同步', type: 'retry-sync' } };
  }
  if (sync?.state === 'loading') {
    return { tone: 'info', text: sync.pages > 1 ? `正在同步对话（${sync.page}/${sync.pages}）…` : '正在同步对话…' };
  }
  if (isFreeMode(state)) return { tone: 'note', text: FREE_MODE_NOTE };
  return null;
}

export const FREE_MODE_NOTE = '未登录：使用免费模式，对话仅保存在本机';

const SEND_ERRORS = {
  'composer-not-found': '找不到官方输入框；内容仍保留，未发送',
  'send-not-confirmed': '官方页面未确认提交；内容仍保留，请在官方界面核实后再决定是否重试',
  busy: '官方页面仍在处理上一条消息；本条未发送',
  'blocked-by-official-ui': '官方界面有弹窗阻止发送；请打开官方界面处理',
  'not-logged-in': '未登录 ChatGPT；内容仍保留，未发送',
  bridge: 'ChatGPT 页面桥尚未就绪，稍候再试',
  timeout: '官方页面长时间未回应；内容仍保留，请在官方界面核实',
};

export function sendErrorText(code) {
  return SEND_ERRORS[code] || '发送失败；内容仍保留';
}

const BLOCKED = {
  bridge: 'ChatGPT 页面桥尚未就绪',
  login: '未登录 ChatGPT',
  pending: '正在经官方页面发送…',
  running: '正在生成回答，请稍候…',
  branch: '正在只读查看其他分支；发送前请切回最新分支',
  loading: '对话仍在加载，请加载完成后再发送',
};

export function blockedText(reason) {
  return BLOCKED[reason] || '';
}
