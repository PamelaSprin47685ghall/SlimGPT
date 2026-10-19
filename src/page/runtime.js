// MAIN-world runtime (entry: hook.js, bundled to main-hook.js as an IIFE).
//
// Observes the official full-history fetch and SSE stream (never rewrites
// them), loads canonical history / the conversation list on request, and
// drives the official composer for explicit UI commands. No DOM message
// scraping, no HTML template parsing, no WebSocket/XHR hooks, no auto-continue.
//
// Auth mode: 'user' once an official request carries Authorization (sticky);
// 'anon' (logged-out free mode) on URL-only evidence of the logged-out app:
// a same-origin /unauth-mweb/ or /backend-anon/ request or resource, or a
// /uc/<id> route. Free mode has no server history: nothing is loaded from the
// server, the UI keeps conversations on the device.

import { PAGE_ORIGIN, EFFORT_VALUES } from '../shared/bridge-protocol.js';
import { createFetchTee, installFetchTee } from './fetch-tee.js';
import { createHistoryLoader, listPageComplete } from './history.js';
import { createComposerDriver } from './composer.js';
import { createDomAdapter } from './dom.js';
import { createTakeover } from './takeover.js';
import { createPageLink } from './link.js';
import { conversationIdFromRoute, isConversationId, isFreeModeRoute, isFreeModeUrl } from './endpoints.js';
import { HOOK_MARK } from './hook-mark.js';

const LOCATION_LOAD_DELAY_MS = 1_200;

/** Install the hook into `win`. Idempotent. */
export function installHook(win) {
  if (win.__SLIMGPT_HOOK_V2__) return;
  win.__SLIMGPT_HOOK_V2__ = true;
  const origin = win.location.origin;
  if (origin !== PAGE_ORIGIN) return;

  const nativeFetch = win.fetch.bind(win);
  const nativePushState = win.history.pushState;
  const nativeReplaceState = win.history.replaceState;
  const activeStreams = new Set();
  let loggedIn = null;
  /** @type {'user'|'anon'|'unknown'} */
  let auth = 'unknown';
  let resourceObserver = null;
  let lastHref = null;
  let lastConversationId = null;

  const link = createPageLink({ window: win, onCommand: handleCommand, onUiReady: announce });
  const post = link.post;

  const dom = createDomAdapter(win);
  /** @type {ReturnType<typeof createTakeover>} */
  let takeover;
  const composer = createComposerDriver({
    dom,
    officialUi: { run: (fn) => takeover.run(fn) },
    isStreaming: () => activeStreams.size > 0,
  });
  takeover = createTakeover({
    window: win,
    onChange: (visible, reason) => post('takeover', { visible, reason }),
    hasComposer: () => composer.hasComposer(),
    findBlocker: () => composer.findBlocker(),
  });

  const history = createHistoryLoader({
    fetch: nativeFetch,
    origin,
    emit: post,
    onAuthFailure: () => setLoggedIn(false),
  });

  const tee = createFetchTee({
    pageOrigin: origin,
    handlers: {
      onBackendHeaders(headers) {
        const first = !history.hasHeaders();
        history.setHeaders(headers);
        setAuth('user');
        setLoggedIn(true);
        if (first) history.loadList();
      },
      onFreeModeRequest: () => noteFreeMode(),
      onSubmission: (result) => composer.noteSubmission(result),
      onStreamStart(start) {
        activeStreams.add(start.streamId);
        post('stream-start', start);
      },
      onStreamChunk: (streamId, chunk) => post('stream-chunk', { streamId, chunk }),
      onStreamEnd(streamId, ok) {
        activeStreams.delete(streamId);
        post('stream-end', { streamId, ok });
      },
      onHistory(conversationId, body) {
        history.noteObserved(conversationId);
        post('conversation', { conversationId, body, page: 1, pages: 1 });
      },
      onList: (offset, body) => post('conversation-list', { body, offset, complete: listPageComplete(body, offset) }),
    },
  });
  installFetchTee(win, tee);

  function setLoggedIn(value) {
    if (loggedIn === value) return;
    loggedIn = value;
    sendHello();
  }

  function setAuth(value) {
    if (auth === value) return;
    auth = value;
    if (resourceObserver) {
      try { resourceObserver.disconnect(); } catch { /* ignore */ }
      resourceObserver = null;
    }
    sendHello();
  }

  /** Evidence of the logged-out app. A signed-in session ('user') always wins. */
  function noteFreeMode() {
    if (auth === 'unknown') setAuth('anon');
  }

  /** URL-only scan of loaded resources (the logged-out app's own scripts). */
  function watchResources() {
    const scan = (entries) => {
      if (auth !== 'unknown') return;
      for (const entry of entries) {
        if (typeof entry?.name === 'string' && isFreeModeUrl(entry.name, origin)) { noteFreeMode(); return; }
      }
    };
    try { scan(win.performance?.getEntriesByType?.('resource') || []); } catch { /* ignore */ }
    if (auth !== 'unknown' || typeof win.PerformanceObserver !== 'function') return;
    try {
      resourceObserver = new win.PerformanceObserver((list) => scan(list.getEntries()));
      resourceObserver.observe({ type: 'resource', buffered: true });
    } catch {
      resourceObserver = null;
    }
  }

  function sendHello() {
    // Effort control is unverified against the live UI: advertise none until it is.
    const ready = auth === 'anon' ? true : history.hasHeaders();
    const reportedLogin = auth === 'anon' ? false : loggedIn;
    post('hello', { ready, loggedIn: reportedLogin, auth, url: win.location.href, efforts: [] });
  }

  function announce() {
    sendHello();
    post('location', { url: win.location.href, conversationId: lastConversationId });
    post('takeover', { visible: takeover.isVisible(), reason: takeover.reason() });
  }

  function checkLocation() {
    const href = win.location.href;
    if (href === lastHref) return;
    lastHref = href;
    const conversationId = conversationIdFromRoute(href, origin);
    const changed = conversationId !== lastConversationId;
    lastConversationId = conversationId;
    if (isFreeModeRoute(href, origin)) noteFreeMode();
    post('location', { url: href, conversationId });
    if (changed && conversationId && auth !== 'anon') history.schedule(conversationId, LOCATION_LOAD_DELAY_MS);
  }

  function navigate(conversationId) {
    if (auth === 'anon') {
      // The logged-out app renders each conversation server-side (with its
      // continuation state in the composer form): a real navigation is the
      // only way to make the official composer target this conversation.
      const path = conversationId ? `/uc/${encodeURIComponent(conversationId)}` : '/';
      if (win.location.pathname === path) return false;
      win.location.assign(new URL(path, origin).href);
      return true;
    }
    const target = new URL(conversationId ? `/c/${encodeURIComponent(conversationId)}` : '/', origin);
    if (target.pathname === win.location.pathname) return false;
    const doc = win.document;
    const anchor = conversationId
      ? [...doc.querySelectorAll('a[href]')].find((element) => {
        try { return new URL(element.href, origin).pathname === target.pathname; } catch { return false; }
      })
      : (doc.querySelector('[data-testid="create-new-chat-button"]') || doc.querySelector('a[href="/"]'));
    if (anchor) {
      anchor.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    }
    if (win.location.pathname !== target.pathname) {
      Reflect.apply(nativePushState, win.history, [win.history.state, '', target.href]);
      win.dispatchEvent(new win.PopStateEvent('popstate', { state: win.history.state }));
    }
    checkLocation();
    return true;
  }

  async function handleCommand(message) {
    switch (message.type) {
      case 'open': {
        const id = message.conversationId;
        if (id !== null && !isConversationId(id)) return;
        const moved = navigate(id);
        if (id && auth !== 'anon') {
          if (moved) history.schedule(id, LOCATION_LOAD_DELAY_MS);
          else history.load(id, { force: true });
        }
        return;
      }
      case 'refresh':
        // Free mode has no server history endpoint.
        if (auth !== 'anon' && isConversationId(message.conversationId)) history.load(message.conversationId, { force: true });
        return;
      case 'refresh-list':
        if (auth !== 'anon') history.loadList();
        return;
      case 'send': {
        const commandId = String(message.commandId || '');
        const result = loggedIn === false && auth !== 'anon' ? { ok: false, error: 'not-logged-in' } : await composer.send(message.text);
        post('send-result', { commandId, ok: result.ok, error: result.error });
        return;
      }
      case 'stop':
        return reply(message, 'stop', composer.stop());
      case 'continue': {
        const target = message.conversationId ?? null;
        if (target !== null && (!isConversationId(target) || target !== lastConversationId)) {
          return reply(message, 'continue', Promise.resolve({ ok: false, error: 'invalid-argument' }));
        }
        return reply(message, 'continue', composer.continueGeneration());
      }
      case 'switch-branch':
        return reply(message, 'switch-branch', composer.switchBranch(message.messageId, Number(message.direction)));
      case 'set-effort': {
        const result = await reply(message, 'set-effort', composer.setEffort(message.effort));
        const reached = result.ok && EFFORT_VALUES.includes(message.effort) ? message.effort : null;
        post('effort', { available: result.ok || result.error !== 'control-not-found', effort: reached });
        return;
      }
      case 'show-official':
        takeover.hide();
        return;
      default:
    }
  }

  async function reply(message, command, pending) {
    const commandId = typeof message.commandId === 'string' ? message.commandId : null;
    let result;
    try {
      result = await pending;
    } catch {
      result = { ok: false, error: 'not-confirmed' };
    }
    post('command-result', { commandId, command, ok: Boolean(result.ok), error: result.ok ? null : result.error });
    return result;
  }

  // Location: observe the official router (native calls are untouched).
  win.history.pushState = function slimgptPushState() {
    const result = Reflect.apply(nativePushState, this, arguments);
    queueMicrotask(checkLocation);
    return result;
  };
  win.history.replaceState = function slimgptReplaceState() {
    const result = Reflect.apply(nativeReplaceState, this, arguments);
    queueMicrotask(checkLocation);
    return result;
  };
  win.addEventListener('popstate', checkLocation);
  win.addEventListener('pageshow', checkLocation);
  win.navigation?.addEventListener?.('currententrychange', checkLocation);

  link.install();
  takeover.install();
  checkLocation();
  watchResources();

  const markInstalled = () => {
    if (win.document.documentElement) win.document.documentElement.dataset[HOOK_MARK] = '2';
  };
  if (win.document.documentElement) markInstalled();
  else win.document.addEventListener('readystatechange', markInstalled, { once: true });
}

