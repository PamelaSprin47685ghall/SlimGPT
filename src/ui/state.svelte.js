// Reactive app store: wraps the pure logic in ./state/logic.js, performs its
// effects through the bridge client and persists drafts/settings.
import * as P from '../protocol/index.js';
import { STORAGE_KEYS } from '../shared/bridge-protocol.js';
import { createBridgeClient } from './bridge-client.js';
import * as L from './state/logic.js';

const SEND_TIMEOUT_MS = 45_000;
const BRIDGE_GRACE_MS = 4_000;
const SAVE_DELAY_MS = 400;

export function createStore({ protocol = P, bridgeFactory = createBridgeClient, window: win = globalThis.window } = {}) {
  let state = $state.raw(L.initialState());
  const saveTimers = new Map();
  let bridge = null;
  // Nothing is written before the stored values are read back: an early save
  // (e.g. a free-mode stream right after reload) would otherwise overwrite
  // the device conversations with only the new one.
  let hydrated = false;
  let localUnreadable = false;
  const deferred = new Set();

  function run(effects) {
    for (const effect of effects) {
      if (effect.type === 'post') bridge?.send(effect.message, effect.fields);
      else if (effect.type === 'save') scheduleSave(effect.key);
    }
  }

  function scheduleSave(key) {
    if (!STORAGE_KEYS.includes(key) || !bridge?.connected) return;
    if (!hydrated) { deferred.add(key); return; }
    if (key === 'localConversations' && localUnreadable) return;
    clearTimeout(saveTimers.get(key));
    saveTimers.set(key, setTimeout(() => {
      saveTimers.delete(key);
      void bridge.storageSet({ [key]: L.persistable(state, key, protocol) });
    }, SAVE_DELAY_MS));
  }

  function onPage(message) {
    const result = L.reducePage(state, message, protocol);
    state = result.state;
    run(result.effects);
  }

  function dispatch(action) {
    if (action.type === 'send') action = { ...action, commandId: bridge?.nextId('cmd') ?? `cmd-${Date.now()}` };
    const result = L.reduceAction(state, action, protocol);
    state = result.state;
    run(result.effects);
    if (action.type === 'send' && state.pending?.commandId === action.commandId) {
      const commandId = action.commandId;
      setTimeout(() => dispatch({ type: 'send-timeout', commandId }), SEND_TIMEOUT_MS);
    }
  }

  function start() {
    bridge = bridgeFactory({ window: win, onMessage: onPage });
    const online = () => dispatch({ type: 'online', online: true });
    const offline = () => dispatch({ type: 'online', online: false });
    win?.addEventListener?.('online', online);
    win?.addEventListener?.('offline', offline);
    if (win?.navigator && win.navigator.onLine === false) offline();
    const grace = setTimeout(() => dispatch({ type: 'bridge-timeout' }), BRIDGE_GRACE_MS);
    const afterHydrate = () => {
      hydrated = true;
      for (const key of deferred) scheduleSave(key);
      deferred.clear();
    };
    let reading;
    try { reading = Promise.resolve(bridge.storageGet(['settings', 'drafts', 'conversationIndex', 'localConversations'])); } catch (error) { reading = Promise.reject(error); }
    void reading
      .then((stored) => {
        if (!stored || typeof stored !== 'object') localUnreadable = true;
        state = L.hydrate(state, stored || {}, protocol);
      }, () => { localUnreadable = true; })
      .finally(afterHydrate);
    return () => {
      clearTimeout(grace);
      win?.removeEventListener?.('online', online);
      win?.removeEventListener?.('offline', offline);
      bridge?.destroy();
    };
  }

  return {
    get state() { return state; },
    protocol,
    dispatch,
    start,
  };
}
