// Page-world end of the bridge: posts page→UI messages straight to the
// takeover frame (exact extension origin) and accepts UI→page commands only
// from that frame's window at that exact origin. Bodies are therefore never
// broadcast on the chatgpt.com window message bus.

import { acceptBridgeMessage, bridgeMessage, BRIDGE_COMMANDS } from '../shared/bridge-protocol.js';
import { isExtensionOrigin, isFromExactly, originOf } from '../shared/origin.js';
import { FRAME_ID } from './takeover.js';

export const MAX_QUEUED_CHARS = 32 * 1024 * 1024;
const STATE_TYPES = ['hello', 'location', 'takeover'];

/**
 * The takeover frame and its exact origin, or null when the element is not
 * an extension frame (a page-created iframe with the same id is ignored).
 * @param {Document} doc
 */
export function resolveFrame(doc) {
  const element = doc.getElementById(FRAME_ID);
  if (!element || element.tagName !== 'IFRAME') return null;
  const origin = originOf(/** @type {HTMLIFrameElement} */ (element).src);
  if (!isExtensionOrigin(origin)) return null;
  return { element: /** @type {HTMLIFrameElement} */ (element), origin: /** @type {string} */ (origin) };
}

/**
 * Accept a UI→page command event. Storage commands belong to the isolated
 * bridge and are ignored here.
 * @param {MessageEvent} event
 * @param {{ element: HTMLIFrameElement, origin: string }|null} frame
 */
export function acceptUiCommand(event, frame) {
  if (!frame || !isFromExactly(event, frame.element.contentWindow, frame.origin)) return null;
  const message = acceptBridgeMessage(event.data, 'ui-to-page');
  if (!message || BRIDGE_COMMANDS.includes(/** @type {string} */ (message.type))) return null;
  return message;
}

/**
 * @param {object} options
 * @param {Window & typeof globalThis} options.window
 * @param {(message: Record<string, any>) => void} options.onCommand
 * @param {() => void} options.onUiReady   frame (re)loaded or UI said ui-ready
 */
export function createPageLink({ window: win, onCommand, onUiReady }) {
  const doc = win.document;
  let ready = false;
  let queue = [];
  let queuedChars = 0;
  let overflowed = false;
  let boundFrame = null;

  function bindFrame() {
    const frame = resolveFrame(doc);
    if (!frame || frame.element === boundFrame) return frame;
    boundFrame = frame.element;
    frame.element.addEventListener('load', () => markReady());
    return frame;
  }

  function markReady() {
    ready = true;
    // State messages are re-sent fresh by onUiReady; queued copies are stale.
    queue = queue.filter((item) => !STATE_TYPES.includes(item.type));
    onUiReady();
    flush();
  }

  /** Post one page→UI message (queued until the frame is ready). */
  function post(type, fields = {}) {
    const message = bridgeMessage('page-to-ui', type, fields);
    const frame = bindFrame();
    if (ready && frame?.element.contentWindow) {
      frame.element.contentWindow.postMessage(message, frame.origin);
      return;
    }
    enqueue(message);
  }

  function enqueue(message) {
    const size = (typeof message.body === 'string' ? message.body.length : 0) +
      (typeof message.chunk === 'string' ? message.chunk.length : 0) + 64;
    queue.push(message);
    queuedChars += size;
    if (queuedChars > MAX_QUEUED_CHARS) {
      // Never deliver a partial stream or history: drop data messages, keep
      // the stream boundaries so the UI knows to refresh.
      overflowed = true;
      const open = new Set();
      for (const item of queue) {
        if (item.type === 'stream-start') open.add(item.streamId);
        if (item.type === 'stream-end') open.delete(item.streamId);
      }
      queue = queue.filter((item) => !['stream-start', 'stream-chunk', 'stream-end', 'conversation', 'conversation-list'].includes(item.type));
      for (const streamId of open) queue.push(bridgeMessage('page-to-ui', 'stream-end', { streamId, ok: false }));
      queuedChars = queue.length * 64;
    }
  }

  function flush() {
    const frame = bindFrame();
    if (!frame?.element.contentWindow) return;
    const pending = queue;
    queue = [];
    queuedChars = 0;
    for (const message of pending) frame.element.contentWindow.postMessage(message, frame.origin);
    overflowed = false;
  }

  function install() {
    win.addEventListener('message', (event) => {
      const message = acceptUiCommand(event, bindFrame());
      if (!message) return;
      if (message.type === 'ui-ready') {
        markReady();
        return;
      }
      onCommand(message);
    });
    // The bridge mounts the frame at document_start; bind as soon as it exists.
    if (!bindFrame()) {
      const observer = new win.MutationObserver(() => {
        if (bindFrame()) observer.disconnect();
      });
      observer.observe(doc, { childList: true, subtree: true });
      doc.addEventListener('DOMContentLoaded', () => { bindFrame(); observer.disconnect(); }, { once: true });
    }
  }

  return { install, post, isReady: () => ready, hadOverflow: () => overflowed };
}
