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

import { PAGE_ORIGIN, isEffortValue } from '../shared/bridge-protocol.js';
import { createEffortTracker } from './effort.js';
import { createFetchTee, installFetchTee } from './fetch-tee.js';
import { createHistoryLoader, listPageComplete } from './history.js';
import { createComposerDriver } from './composer.js';
import { createDomAdapter } from './dom.js';
import { createTakeover } from './takeover.js';
import { createPageLink } from './link.js';
import { conversationIdFromRoute, isConversationId, isFreeModeRoute, isFreeModeUrl } from './endpoints.js';
import { HOOK_MARK } from './hook-mark.js';

// After a route change, our own history load is only a fallback for when the
// official app does not fetch it. The official fetch starts within a few
// milliseconds of the route change; once it has started we wait for its
// response (up to OFFICIAL_HISTORY_GRACE_MS) instead of duplicating it.
const LOCATION_LOAD_DELAY_MS = 400;
const OFFICIAL_HISTORY_GRACE_MS = 8_000;

/** A paged path view (no `mapping`) that says some message has other versions. Text test only. */
export function pagedViewWithVersions(body) {
  return typeof body === 'string' && /"has_versions"\s*:\s*true/.test(body) && !/"mapping"\s*:/.test(body);
}

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
  const effort = createEffortTracker();

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
      onStreamChunk(streamId, chunk) {
        // The official app is idle again once the stream says [DONE], even if
        // the connection lingers; do not report the composer as busy.
        if (chunk.includes('data: [DONE]')) activeStreams.delete(streamId);
        post('stream-chunk', { streamId, chunk });
      },
      onStreamEnd(streamId, ok) {
        activeStreams.delete(streamId);
        post('stream-end', { streamId, ok });
      },
      onHistoryRequest: (conversationId) => history.noteRequested(conversationId, OFFICIAL_HISTORY_GRACE_MS),
      onHistory(conversationId, body) {
        post('conversation', { conversationId, body, page: 1, pages: 1 });
        // The official paged view hides sibling branches behind `has_versions`.
        history.noteObserved(conversationId, { wantsFullTree: pagedViewWithVersions(body) });
      },
      onList: (offset, body) => post('conversation-list', { body, offset, complete: listPageComplete(body, offset) }),
      onModels: (body) => { if (effort.noteModels(body)) announceEffort(); },
      onUserSettings: (body) => { if (effort.noteSettings(body)) announceEffort(); },
      onSubmitChoice: (choice) => { if (effort.noteSubmit(choice)) announceEffort(); },
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

  /** Effort values the signed-in account offers now (none when logged out). */
  const efforts = () => (auth === 'user' ? effort.efforts() : []);

  function sendHello() {
    const ready = auth === 'anon' ? true : history.hasHeaders();
    const reportedLogin = auth === 'anon' ? false : loggedIn;
    post('hello', { ready, loggedIn: reportedLogin, auth, url: win.location.href, efforts: efforts() });
  }

  function postEffort() {
    post('effort', { available: efforts().length > 1, effort: auth === 'user' ? effort.current() : null });
  }

  function announceEffort() {
    sendHello();
    postEffort();
  }

  function announce() {
    sendHello();
    post('location', { url: win.location.href, conversationId: lastConversationId });
    post('takeover', { visible: takeover.isVisible(), reason: takeover.reason() });
    postEffort();
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
      // Logged-out: device conversations are shown by the UI from local
      // storage, in place. A full load of /uc/<id> is not reliable (the
      // server often redirects it to /), so it is never used to open one.
      // Only "new chat" navigates, to give the official composer a fresh,
      // empty conversation.
      if (conversationId) return false;
      if (win.location.pathname === '/') return false;
      win.location.assign(new URL('/', origin).href);
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
      case 'switch-branch':
        return reply(message, 'switch-branch', composer.switchBranch(message.messageId, Number(message.direction)));
      case 'set-effort': {
        const value = message.effort;
        const offered = isEffortValue(value) && efforts().length > 1 && efforts().includes(value);
        const result = await reply(message, 'set-effort', offered ? composer.setEffort(value) : Promise.resolve({ ok: false, error: 'invalid-argument' }));
        if (result.ok) effort.noteChosen(value);
        postEffort();
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

