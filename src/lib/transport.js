const CHANNEL = 'slimgpt-ui-v1';
const HOST_ORIGIN = 'https://chatgpt.com';

export function createTransport() {
  return new TakeoverTransport();
}

class TakeoverTransport {
  mode = 'webextension-takeover';
  supportsLiveChat = true;
  #listeners = new Set();
  #started = false;

  start() {
    if (this.#started) return;
    this.#started = true;
    window.addEventListener('message', this.#handleMessage);
    this.send({ type: 'request-status' });
  }

  stop() {
    if (!this.#started) return;
    this.#started = false;
    window.removeEventListener('message', this.#handleMessage);
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(payload) {
    if (window.parent === window) {
      this.#emit({
        type: 'command-error',
        command: payload?.type,
        error: 'SlimGPT 必须作为 WebExtension takeover 运行在 chatgpt.com 页面中。',
      });
      return;
    }
    window.parent.postMessage({
      channel: CHANNEL,
      direction: 'ui-to-bridge',
      payload,
    }, HOST_ORIGIN);
  }

  openOfficial(conversationId) {
    this.send({ type: 'open-official', conversationId });
  }

  #handleMessage = (event) => {
    if (event.source !== window.parent || event.origin !== HOST_ORIGIN) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.direction !== 'bridge-to-ui') return;
    this.#emit(message.payload);
  };

  #emit(message) {
    for (const listener of this.#listeners) listener(message);
  }
}
