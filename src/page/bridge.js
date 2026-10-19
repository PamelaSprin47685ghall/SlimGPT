// ISOLATED-world entry (bundled to isolated-bridge.js as an IIFE).
//  * mounts the takeover frame (hidden until the page hook shows it),
//  * proxies extension storage for the frame (exact-origin checked),
//  * injects the page hook as a web-accessible script where MAIN-world
//    content scripts are unavailable (Orion, older engines).
// It does not relay page traffic: the page hook posts directly to the frame.

import { acceptStorageCommand, runStorageCommand } from './bridge-core.js';
import { FRAME_ID } from './takeover.js';
import { HOOK_MARK } from './hook-mark.js';
import { originOf } from '../shared/origin.js';

const HOOK_FILE = 'main-hook.js';
const HOOK_FALLBACK_MS = 150;

(() => {
  if (globalThis.__SLIMGPT_BRIDGE_V2__) return;
  globalThis.__SLIMGPT_BRIDGE_V2__ = true;
  const api = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
  if (!api?.runtime?.getURL) return;
  const extensionOrigin = originOf(api.runtime.getURL('/'));
  if (!extensionOrigin) return;
  const storage = api.storage?.local;
  /** @type {HTMLIFrameElement|null} */
  let frame = null;

  whenRoot(() => {
    if (document.getElementById(FRAME_ID)) return;
    frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.src = api.runtime.getURL('index.html?takeover=1');
    frame.title = 'SlimGPT';
    frame.setAttribute('allow', 'clipboard-write');
    frame.dataset.slimgptVisible = '0';
    Object.assign(frame.style, {
      position: 'fixed', inset: '0', width: '100%', height: '100%',
      border: '0', margin: '0', padding: '0', zIndex: '2147483647',
      background: 'Canvas', colorScheme: 'light dark', display: 'block',
      opacity: '0', pointerEvents: 'none', transition: 'opacity 90ms ease-out',
    });
    document.documentElement.appendChild(frame);
    ensureHook();
  });

  window.addEventListener('message', (event) => {
    const message = acceptStorageCommand(event, frame?.contentWindow, extensionOrigin);
    if (!message || !storage) return;
    void runStorageCommand(storage, message).then((result) => {
      frame?.contentWindow?.postMessage(result, extensionOrigin);
    });
  });

  function ensureHook() {
    const installed = () => document.documentElement?.dataset[HOOK_MARK] === '2';
    const inject = () => {
      if (installed()) return;
      const script = document.createElement('script');
      script.src = api.runtime.getURL(HOOK_FILE);
      script.async = false;
      script.addEventListener('load', () => script.remove(), { once: true });
      script.addEventListener('error', () => script.remove(), { once: true });
      (document.head || document.documentElement).appendChild(script);
    };
    // eslint-disable-next-line no-undef
    if (__SLIMGPT_TARGET__ === 'orion') inject();
    else setTimeout(inject, HOOK_FALLBACK_MS);
  }

  function whenRoot(fn) {
    if (document.documentElement) return fn();
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      fn();
    });
    observer.observe(document, { childList: true });
  }
})();
