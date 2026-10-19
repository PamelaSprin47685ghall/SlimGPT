// Pure pieces of the ISOLATED-world bridge (storage proxy + frame checks),
// kept separate from bridge.js so they can be tested without a browser.

import { acceptBridgeMessage, bridgeMessage, STORAGE_KEYS } from '../shared/bridge-protocol.js';
import { isFromExactly } from '../shared/origin.js';

export const MAX_STORAGE_VALUE_CHARS = 8 * 1024 * 1024;

/**
 * Accept a storage command from the takeover frame only.
 * @param {MessageEvent} event
 * @param {Window|null|undefined} frameWindow
 * @param {string} extensionOrigin exact origin from runtime.getURL('/')
 */
export function acceptStorageCommand(event, frameWindow, extensionOrigin) {
  if (!isFromExactly(event, frameWindow, extensionOrigin)) return null;
  const message = acceptBridgeMessage(event.data, 'ui-to-page');
  if (!message || (message.type !== 'storage-get' && message.type !== 'storage-set')) return null;
  if (typeof message.requestId !== 'string' || !message.requestId) return null;
  return message;
}

/**
 * Execute a storage command against `storage` (browser.storage.local-like,
 * promise API). Only STORAGE_KEYS are readable/writable.
 * @param {{ get: (keys: string[]) => Promise<object>, set: (values: object) => Promise<void> }} storage
 * @param {Record<string, any>} message
 */
export async function runStorageCommand(storage, message) {
  const requestId = message.requestId;
  try {
    if (message.type === 'storage-get') {
      const keys = Array.isArray(message.keys) ? message.keys.filter((key) => STORAGE_KEYS.includes(key)) : [];
      const values = keys.length ? await storage.get(keys) : {};
      const filtered = {};
      for (const key of keys) if (values && key in values) filtered[key] = values[key];
      return bridgeMessage('page-to-ui', 'storage-result', { requestId, ok: true, values: filtered, error: null });
    }
    const values = {};
    const source = message.values && typeof message.values === 'object' ? message.values : {};
    for (const [key, value] of Object.entries(source)) {
      if (!STORAGE_KEYS.includes(key)) continue;
      if (JSON.stringify(value ?? null).length > MAX_STORAGE_VALUE_CHARS) {
        return bridgeMessage('page-to-ui', 'storage-result', { requestId, ok: false, values: {}, error: `value too large: ${key}` });
      }
      values[key] = value;
    }
    if (Object.keys(values).length) await storage.set(values);
    return bridgeMessage('page-to-ui', 'storage-result', { requestId, ok: true, values: {}, error: null });
  } catch (error) {
    return bridgeMessage('page-to-ui', 'storage-result', {
      requestId, ok: false, values: {}, error: String(error?.message || error),
    });
  }
}
