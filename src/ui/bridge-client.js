// postMessage client for the UI frame. The frame lives in an iframe that the
// ISOLATED-world bridge mounts on https://chatgpt.com; every message goes to
// window.parent with that exact origin and incoming messages are accepted
// only from window.parent with that exact origin and a valid v2 envelope.
import { acceptBridgeMessage, bridgeMessage } from '../shared/bridge-protocol.js';

export const PAGE_ORIGIN = 'https://chatgpt.com';

/**
 * @param {{ window?: Window, origin?: string, onMessage: (message: object) => void, timeoutMs?: number }} options
 */
export function createBridgeClient({ window: win = globalThis.window, origin = PAGE_ORIGIN, onMessage, timeoutMs = 5000 }) {
  const parent = win?.parent && win.parent !== win ? win.parent : null;
  const waiting = new Map();
  let sequence = 0;

  const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(sequence += 1).toString(36)}`;

  function listener(event) {
    if (!parent || event.source !== parent || event.origin !== origin) return;
    const message = acceptBridgeMessage(event.data, 'page-to-ui');
    if (!message) return;
    if (message.type === 'storage-result') {
      const entry = waiting.get(message.requestId);
      if (entry) {
        waiting.delete(message.requestId);
        clearTimeout(entry.timer);
        const values = message.values && typeof message.values === 'object' ? message.values : {};
        entry.resolve(message.ok === false ? entry.failValue : values);
      }
      return;
    }
    onMessage(message);
  }

  win?.addEventListener?.('message', listener);

  // Tell the page we are listening (it then sends hello/location/takeover and
  // flushes anything queued). The frame load event does the same; this covers
  // late hook installs (Orion) and frame reloads.
  if (parent) parent.postMessage(bridgeMessage('ui-to-page', 'ui-ready'), origin);

  /** @returns {boolean} false when there is no parent page to talk to. */
  function send(type, fields = {}) {
    if (!parent) return false;
    parent.postMessage(bridgeMessage('ui-to-page', type, fields), origin);
    return true;
  }

  function request(type, fields, failValue = {}) {
    if (!parent) return Promise.resolve({});
    const requestId = nextId('req');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(requestId); resolve(failValue); }, timeoutMs);
      waiting.set(requestId, { resolve, timer, failValue });
      send(type, { ...fields, requestId });
    });
  }

  return {
    connected: !!parent,
    send,
    nextId,
    /**
     * @param {string[]} keys
     * @returns {Promise<object|null>} never rejects; null when storage could not
     *   be read (timeout / error), so callers do not mistake it for "empty"
     */
    storageGet: (keys) => request('storage-get', { keys }, null),
    /** @param {object} values */
    storageSet: (values) => request('storage-set', { values }),
    destroy() {
      win?.removeEventListener?.('message', listener);
      for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.resolve(entry.failValue); }
      waiting.clear();
    },
  };
}
