import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifests = ['manifest.json', 'manifest.firefox.json', 'manifest.orion.json'];

test('all browser packages use the same permission-light takeover architecture', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(manifest.version, packageJson.version, `${path} version must match package.json`);
    assert.equal(manifest.background, undefined, `${path} must not have a background transport`);
    assert.deepEqual(
      manifest.permissions,
      ['storage'],
      `${path} may only request local extension storage for the conversation observation ledger`,
    );
    assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
    assert.ok(
      manifest.content_scripts.some((script) => script.js?.includes('isolated-bridge.js')),
      `${path} must install the takeover bridge`,
    );
    assert.ok(
      manifest.web_accessible_resources?.some((entry) => entry.resources?.includes('main-mitm.js')),
      `${path} must expose the shared page hook`,
    );
  }

  const firefox = JSON.parse(await readFile('manifest.firefox.json', 'utf8'));
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, {
    required: ['none'],
  });
  assert.deepEqual(firefox.browser_specific_settings.gecko_android, {});
});

test('the isolated bridge is ready before the page hook on browsers with MAIN-world scripts', async () => {
  for (const path of ['manifest.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(manifest.content_scripts[0].js, ['isolated-bridge.js']);
    assert.equal(manifest.content_scripts[0].world, 'ISOLATED');
    assert.deepEqual(manifest.content_scripts[1].js, ['main-mitm.js']);
    assert.equal(manifest.content_scripts[1].world, 'MAIN');
  }

  const bridge = await readFile('isolated-bridge.js', 'utf8');
  assert.equal(bridge.includes('event.source === window'), false);
});

test('the project has no PWA or debugger runtime', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const allDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.equal(allDependencies['vite-plugin-pwa'], undefined);
  assert.equal(packageJson.scripts['build:pwa'], undefined);

  const files = await Promise.all([
    readFile('main-mitm.js', 'utf8'),
    readFile('isolated-bridge.js', 'utf8'),
  ]);
  const source = files.join('\n');
  assert.equal(source.includes('chrome.debugger'), false);
  assert.equal(source.includes('display: none !important'), true);
  assert.equal(source.includes('#mobile-composer-prompt'), true);
  assert.equal(source.includes('[data-composer-submit]'), true);
  assert.equal(source.includes('waitForComposerElement(INITIAL_SHELL_READY_TIMEOUT)'), true);

  const bridge = files[1];
  const captureBlock = bridge.slice(bridge.indexOf("if (payload.type === 'page-capture')"));
  assert.ok(captureBlock.indexOf('...payload') < captureBlock.indexOf("type: 'canonical-capture'"));
});

test('page synchronization is event-driven instead of interval-polled', async () => {
  const source = await readFile('main-mitm.js', 'utf8');
  assert.equal(source.includes('setInterval('), false);
  assert.equal(source.includes('new MutationObserver'), true);
  assert.equal(source.includes('socket.addEventListener("message"'), true);
  assert.equal(source.includes('xhr.addEventListener("progress"'), true);
  assert.equal(source.includes('transport: "dom"'), true);
});

test('official slow stream consumers are terminated locally without redefining logical turn completion', async () => {
  const mitm = await readFile('main-mitm.js', 'utf8');
  const home = await readFile('src/pages/HomePage.svelte', 'utf8');
  const cloneAt = mitm.indexOf('clone = response.clone()');
  const divertAt = mitm.indexOf('return divertOfficialStream ? completeOfficialStream(response) : response');
  assert.ok(cloneAt >= 0 && divertAt > cloneAt, 'SlimGPT must clone and own the real stream before terminating the official parser');
  assert.ok(mitm.includes('new Response("data: [DONE]\\n\\n"'), 'the official consumer should receive a synthetic local terminal frame');
  assert.ok(mitm.includes('event.stopImmediatePropagation()'), 'heavy official websocket conversation parsing should be cut off');
  assert.ok(home.includes('[DONE] terminates this SSE segment only'), 'synthetic/transport DONE must not become logical turn completion');
  assert.ok(mitm.includes("emitExecutionState('stopped', 'ws-turn-stopped'"), 'logical stop should follow the server conversation lifecycle');
});

test('generated and header turn traces stay transport-only while body metadata supplies semantic turn identity', async () => {
  const source = await readFile('main-mitm.js', 'utf8');
  assert.ok(source.includes('transportTurnId: request?.headers?.get?.("x-oai-turn-trace-id") || null'));
  assert.ok(source.includes('session.transportTurnId = session.sessionId'));
  assert.ok(source.includes('turnId: null'));
  assert.ok(source.includes('metadata.turn_exchange_id'));
  assert.ok(source.includes('metadata.turn_trace_id'));
  assert.equal(source.includes('turnId: nextTurnSessionId()'), false);
});

test('intercepted turn sessions survive transport boundaries and clean up on server lifecycle completion', async () => {
  const source = await readFile('main-mitm.js', 'utf8');
  const captureStart = source.indexOf('async function captureReadableStream');
  const captureEnd = source.indexOf('function isExecutionStreamUrl', captureStart);
  const captureBlock = source.slice(captureStart, captureEnd);
  assert.equal(captureBlock.includes('releaseTurnSession('), false, 'SSE completion must not release the logical turn session');
  assert.ok(captureBlock.includes('queueCanonicalConversation(captureMeta.conversationId)'), 'stream close should event-drive canonical reconciliation');
  assert.ok(source.includes('snapshotActiveTurn(conversationScope)'), 'resume requests must inherit the active logical turn');
  assert.ok(source.includes("emitExecutionState('stopped', 'ws-turn-stopped'"));
  assert.ok(source.includes('activeTurnSessions.delete(conversationId)'), 'server turn completion must release the active session');
  assert.ok(source.includes('notificationMatchesTurnSession(notification, activeSession)'), 'a delayed stop notification must not delete a semantically different active turn');
  assert.ok(source.includes('adoptNotificationTurnIdentity(conversationId, notification)'), 'server semantic turn aliases should enrich the active session for later resume');
  assert.ok(source.includes('bindPendingTurnSession(conversationId)'), 'new-chat transport sessions must bind when the official route acquires its conversation id');
});

test('canonical pagination never publishes a partial history when an older cursor fails', async () => {
  const source = await readFile('main-mitm.js', 'utf8');
  const fetchStart = source.indexOf('async function fetchCanonicalConversationPages');
  const fetchEnd = source.indexOf('async function fetchLegacyCanonicalConversation', fetchStart);
  const fetchBlock = source.slice(fetchStart, fetchEnd);
  assert.ok(fetchBlock.includes('if (!response.ok)'));
  assert.ok(fetchBlock.includes('if (!pages.length) return fetchLegacyCanonicalConversation(conversationId, headers);'));
  assert.ok(fetchBlock.includes('return [];'), 'a failed older page must discard the partial page chain');
  assert.ok(fetchBlock.includes('if (!cursor || seenCursors.has(cursor)) return [];'), 'broken cursor chains must also remain incomplete');

  const syncStart = source.indexOf('async function fetchCanonicalConversation(conversationId)');
  const syncEnd = source.indexOf('async function fetchCanonicalConversationPages', syncStart);
  const syncBlock = source.slice(syncStart, syncEnd);
  const emptyGuard = syncBlock.indexOf('if (!pages.length) return;');
  const publishAt = syncBlock.indexOf('canonicalComplete: index === ordered.length - 1');
  const dequeueAt = syncBlock.indexOf('pendingCanonicalIds.delete(conversationId)');
  assert.ok(emptyGuard >= 0 && publishAt > emptyGuard, 'canonical pages may only publish after a complete non-empty chain exists');
  assert.ok(dequeueAt > emptyGuard, 'failed history must remain queued for a later event-driven retry');
});
