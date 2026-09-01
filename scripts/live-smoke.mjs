import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const flags = new Set(process.argv.slice(2));
const live = flags.has('--live');
const headed = flags.has('--headed');
const cloneProfile = flags.has('--clone-profile');
const sendLive = flags.has('--send-live');
const keepOpen = flags.has('--keep-open');
const extensionPath = resolve('dist-extension');
const chromePath = await findChrome();
const userDataDir = await mkdtemp(join(tmpdir(), 'slimgpt-live-'));
const port = await reservePort();

if (cloneProfile) await cloneChromeProfile(userDataDir);

const chromeArgs = [
  headed ? null : '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  'about:blank',
].filter(Boolean);
const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
chrome.stderr.setEncoding('utf8');
chrome.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-12_000);
});

let browserCdp = null;
try {
  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
  browserCdp = await connectCdp(version.webSocketDebuggerUrl);
  const loaded = await browserCdp.call('Extensions.loadUnpacked', { path: extensionPath });
  const result = live
    ? await runLiveSmoke(browserCdp, loaded.id)
    : await runFixtureSmoke(browserCdp, loaded.id);
  console.log(JSON.stringify(result, null, 2));

  if (keepOpen) {
    console.error(`Chrome kept open on port ${port}; temp profile: ${userDataDir}`);
    await new Promise(() => {});
  }
} finally {
  if (!keepOpen) {
    try {
      await browserCdp?.call('Browser.close');
    } catch {
      chrome.kill('SIGTERM');
    }
    await Promise.race([onceExit(chrome), sleep(4_000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
    await Promise.race([onceExit(chrome), sleep(1_000)]);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
  if (stderr && chrome.exitCode && chrome.exitCode !== 0 && chrome.exitCode !== 143) {
    console.error(stderr);
  }
}

async function runFixtureSmoke(browser, extensionId) {
  const fixture = makeFixture();
  const created = await browser.call('Target.createTarget', { url: 'about:blank' });
  const topTarget = await waitForTarget(port, (item) => item.id === created.targetId);
  const top = await connectCdp(topTarget.webSocketDebuggerUrl);
  await top.call('Page.enable');
  await top.call('Runtime.enable');
  await top.call('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://chatgpt.com/slimgpt-smoke*', resourceType: 'Document', requestStage: 'Request' },
      { urlPattern: 'https://chatgpt.com/backend-api/*', requestStage: 'Request' },
      { urlPattern: 'https://chatgpt.com/unauth-mweb/conversation/updates*', requestStage: 'Request' },
    ],
  });
  top.on('Fetch.requestPaused', (event) => {
    void fulfillFixtureRequest(top, event, fixture);
  });
  await top.call('Page.navigate', { url: 'https://chatgpt.com/slimgpt-smoke' });

  await waitFor(async () => (await top.evaluate(`!!document.getElementById('slimgpt-takeover-frame')`)));
  await sleep(250);
  const failOpen = await top.evaluate(topStateExpression());
  assert.equal(failOpen.pageHook, true, 'page-world hook must install');
  assert.equal(failOpen.frameDisplay, 'none', 'takeover must stay hidden without an official composer');
  assert.equal(failOpen.sleep, null, 'official body must remain awake on auth/challenge pages');

  await top.evaluate(installComposerExpression());
  await waitFor(async () => {
    const state = await top.evaluate(topStateExpression());
    return state.frameDisplay === 'block' && state.sleep === '1';
  });

  const frameTarget = await waitForTarget(
    port,
    (item) => item.type === 'iframe' && item.url.startsWith(`chrome-extension://${extensionId}/index.html`),
  );
  const ui = await connectCdp(frameTarget.webSocketDebuggerUrl);
  await ui.call('Runtime.enable');
  await waitFor(async () => (await ui.evaluate(`document.querySelector('.status-pill')?.textContent?.trim()`)) === '已接管');

  await top.evaluate(`Promise.all([
    fetch('/backend-api/conversations?offset=0').then((response) => response.json()),
    fetch('/backend-api/conversation/smoke').then((response) => response.json())
  ])`);
  await waitFor(async () => {
    const state = await ui.evaluate(uiStateExpression());
    return state.title === 'Fixture conversation' && state.messages.includes('Fixture answer');
  });
  const canonicalUi = await ui.evaluate(uiStateExpression());
  assert.equal(canonicalUi.highlightedString, '"ok"', 'Markdown worker must emit valid, escaped string tokens');
  assert.equal(canonicalUi.unsafeNodes, 0, 'captured Markdown must not create raw scriptable elements');
  assert.ok(canonicalUi.mountedRows < 40, `virtual list mounted ${canonicalUi.mountedRows} of 120 messages`);
  assert.ok(canonicalUi.virtualHeight > 8_000, 'virtual list must preserve scroll height for unmounted rows');
  await sleep(700);
  const persistedIndex = await ui.evaluate(`JSON.parse(localStorage.getItem('slimgpt:conversation-index:v1') || '[]')`);
  assert.deepEqual(Object.keys(persistedIndex[0]).sort(), ['create_time', 'id', 'route', 'title', 'update_time']);

  await top.evaluate(`(() => {
    window.__slimgptRelayedPayloads = [];
    window.addEventListener('message', (event) => {
      const payload = event.data?.payload;
      if (event.data?.channel === 'slimgpt-page-v1' && payload?.type === 'page-capture') {
        window.__slimgptRelayedPayloads.push(String(payload.data || ''));
      }
    });
    history.replaceState({}, '', '/uc/mobile-smoke');
    return fetch('/unauth-mweb/conversation/updates?operationId=fixture').then((response) => response.text());
  })()`);
  await waitFor(async () => {
    const state = await ui.evaluate(uiStateExpression());
    return state.title === 'Mobile fixture' && state.messages.includes('Streaming fixture answer');
  });
  const mobileUi = await ui.evaluate(uiStateExpression());
  const relayedContainsSecret = await top.evaluate(
    `window.__slimgptRelayedPayloads.some((value) => value.includes('SECRET_MUST_STAY_IN_PAGE'))`,
  );
  assert.equal(relayedContainsSecret, false, 'mobile conduit/resume tokens must not be relayed to the extension UI');

  const submittedText = 'Fixture composer submission';
  await ui.evaluate(fillAndSubmitExpression(submittedText));
  await waitFor(async () => (await top.evaluate(`window.__slimgptSubmitted || ''`)) === submittedText);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).draft === '');
  const sendSuccess = await ui.evaluate(uiStateExpression());
  assert.equal(sendSuccess.composerStatus, '消息已提交');

  await top.evaluate(`document.getElementById('fixture-composer')?.remove()`);
  const failedText = 'Draft that must survive';
  await ui.evaluate(fillAndSubmitExpression(failedText));
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).composerStatus.includes('找不到官方输入框'), 7_000);
  const sendFailure = await ui.evaluate(uiStateExpression());
  assert.equal(sendFailure.draft, failedText, 'failed submissions must preserve the draft');

  await ui.evaluate(`document.querySelector('.desktop-chat-header .button')?.click()`);
  await waitFor(async () => (await top.evaluate(topStateExpression())).restore === true);
  const official = await top.evaluate(topStateExpression());
  assert.equal(official.frameDisplay, 'none');
  assert.equal(official.sleep, null);
  await top.evaluate(`document.getElementById('slimgpt-restore-button')?.click()`);
  await waitFor(async () => (await top.evaluate(topStateExpression())).sleep === '1');
  const restored = await top.evaluate(topStateExpression());

  return {
    mode: 'fixture',
    chrome: await chromeVersion(),
    extensionId,
    failOpen,
    canonicalUi,
    mobileUi,
    sendSuccess,
    sendFailure,
    official,
    restored,
  };
}

async function runLiveSmoke(browser, extensionId) {
  const created = await browser.call('Target.createTarget', { url: 'https://chatgpt.com/' });
  const topTarget = await waitForTarget(port, (item) => item.id === created.targetId, 30_000);
  const top = await connectCdp(topTarget.webSocketDebuggerUrl);
  await top.call('Runtime.enable');
  await sleep(4_000);
  const state = await top.evaluate(topStateExpression());
  assert.equal(state.takeover, true, 'SlimGPT frame must mount on the real ChatGPT origin');
  assert.equal(state.pageHook, true, 'page-world hook must install on the real ChatGPT origin');

  let uiState = null;
  try {
    const frameTarget = await waitForTarget(
      port,
      (item) => item.type === 'iframe' && item.url.startsWith(`chrome-extension://${extensionId}/index.html`),
      10_000,
    );
    const ui = await connectCdp(frameTarget.webSocketDebuggerUrl);
    await ui.call('Runtime.enable');
    uiState = await ui.evaluate(uiStateExpression());
    if (sendLive) {
      assert.equal(state.composer, true, 'real ChatGPT composer is required for --send-live');
      const prompt = process.env.SLIMGPT_LIVE_PROMPT || 'SlimGPT live smoke test: reply with exactly OK';
      await ui.evaluate(fillAndSubmitExpression(prompt));
      await waitFor(async () => (await ui.evaluate(uiStateExpression())).composerStatus === '消息已提交', 10_000);
      await waitFor(async () => (await ui.evaluate(uiStateExpression())).assistant.includes('OK'), 45_000);
      uiState = await ui.evaluate(uiStateExpression());
    }
  } catch (error) {
    if (sendLive) throw error;
    uiState = { unavailable: String(error?.message || error) };
  }

  return {
    mode: 'live',
    chrome: await chromeVersion(),
    extensionId,
    profileClone: cloneProfile,
    headed,
    sendLive,
    state,
    uiState,
  };
}

async function fulfillFixtureRequest(client, event, fixture) {
  const url = event.request.url;
  let body = null;
  let contentType = 'text/plain; charset=utf-8';
  if (event.resourceType === 'Document') {
    body = fixture.document;
    contentType = 'text/html; charset=utf-8';
  } else if (url.includes('/backend-api/conversations')) {
    body = JSON.stringify(fixture.list);
    contentType = 'application/json; charset=utf-8';
  } else if (url.includes('/backend-api/conversation/smoke')) {
    body = JSON.stringify(fixture.conversation);
    contentType = 'application/json; charset=utf-8';
  } else if (url.includes('/unauth-mweb/conversation/updates')) {
    body = fixture.mobile;
    contentType = 'text/vnd.openai.web-mobile-partial+html; charset=utf-8';
  }

  if (body == null) {
    await client.call('Fetch.continueRequest', { requestId: event.requestId });
    return;
  }
  await client.call('Fetch.fulfillRequest', {
    requestId: event.requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: contentType },
      { name: 'Cache-Control', value: 'no-store' },
    ],
    body: Buffer.from(body).toString('base64'),
  });
}

function makeFixture() {
  const mapping = { root: { id: 'root', parent: null, children: [] } };
  let parent = 'root';
  for (let index = 0; index < 120; index += 1) {
    const id = `message-${index}`;
    const role = index % 2 === 0 ? 'user' : 'assistant';
    const content = index === 119
      ? 'Fixture answer <img src=x onerror="window.__slimgptXss=1">\n\n```js\nconst value = "ok";\n```'
      : `Fixture ${role} message ${index + 1}`;
    mapping[parent].children.push(id);
    mapping[id] = {
      id,
      parent,
      children: [],
      message: { id, author: { role }, content: { parts: [content] } },
    };
    parent = id;
  }
  const conversation = {
    id: 'smoke',
    title: 'Fixture conversation',
    current_node: parent,
    create_time: 1,
    update_time: 2,
    mapping,
  };
  const mobileConversation = {
    backendConversationId: 'mobile-smoke',
    messages: [
      { content: 'Mobile fixture question', id: 'mu1', role: 'user' },
      { content: 'Streaming fixture answer', id: 'ma1', renderedHtml: '<p>Streaming fixture answer</p>', role: 'assistant' },
    ],
    parentMessageId: 'ma1',
    title: 'Mobile fixture',
  };
  const encodedConversation = escapeHtmlAttribute(JSON.stringify(mobileConversation));
  return {
    document: '<!doctype html><html><head><meta charset="utf-8"><title>Fixture ChatGPT</title></head><body><main id="official">Official fixture</main></body></html>',
    list: { items: [{ id: 'smoke', title: 'Fixture conversation', update_time: 2, secret: 'INDEX_SECRET_MUST_NOT_PERSIST' }] },
    conversation,
    mobile: [
      '<template data-web-mobile-dpu-frame="1"><span data-conversation-id="mobile-smoke" data-message-id="ma1" data-resume-token="SECRET_MUST_STAY_IN_PAGE"></span></template>',
      '<template data-web-mobile-dpu-frame="2"><template for="assistant-pending-fixture-pending" data-web-mobile-dpu-apply="replace"><p data-assistant-stream-block="" data-assistant-stream-block-index="0">Streaming fixture answer</p></template></template>',
      `<template data-web-mobile-dpu-frame="3"><span data-conversation="${encodedConversation}"></span></template>`,
    ].join(''),
  };
}

function installComposerExpression() {
  return `(() => {
    const form = document.createElement('form');
    form.id = 'fixture-composer';
    form.style.cssText = 'position:fixed;left:20px;top:20px;width:500px;height:120px;display:block';
    const textarea = document.createElement('textarea');
    textarea.id = 'mobile-composer-prompt';
    textarea.setAttribute('data-mobile-composer-prompt', '');
    textarea.style.cssText = 'display:block;width:400px;height:60px';
    const button = document.createElement('button');
    button.type = 'submit';
    button.setAttribute('data-composer-submit', '');
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('data-visually-disabled', '');
    button.style.cssText = 'display:block;width:100px;height:40px';
    textarea.addEventListener('input', () => {
      button.removeAttribute('aria-disabled');
      button.removeAttribute('data-visually-disabled');
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      window.__slimgptSubmitted = textarea.value;
      textarea.value = '';
    });
    form.addEventListener('submit', (event) => event.preventDefault());
    form.append(textarea, button);
    document.body.appendChild(form);
    return true;
  })()`;
}

function fillAndSubmitExpression(text) {
  return `(() => {
    const textarea = document.querySelector('.composer-shell textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, ${JSON.stringify(text)});
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.composer-shell .send-button').click();
    return true;
  })()`;
}

function topStateExpression() {
  return `(() => ({
    url: location.href,
    title: document.title,
    takeover: !!document.getElementById('slimgpt-takeover-frame'),
    frameDisplay: document.getElementById('slimgpt-takeover-frame')?.style.display || '',
    restore: !!document.getElementById('slimgpt-restore-button'),
    sleep: document.documentElement.getAttribute('data-slimgpt-render-sleep'),
    pageHook: !!window.__SLIMGPT_MITM_INSTALLED__,
    composer: !!document.querySelector('#mobile-composer-prompt, textarea[data-mobile-composer-prompt], #prompt-textarea')
  }))()`;
}

function uiStateExpression() {
  return `(() => ({
    title: document.querySelector('.header-title-group strong')?.textContent?.trim() || '',
    status: document.querySelector('.status-pill')?.textContent?.trim() || '',
    composerStatus: document.querySelector('.composer-status')?.textContent?.trim() || '',
    draft: document.querySelector('.composer-shell textarea')?.value || '',
    messages: document.querySelector('.message-stage')?.innerText?.replace(/\\s+/g, ' ').trim() || '',
    assistant: [...document.querySelectorAll('.role-assistant')].map((row) => row.innerText).join(' '),
    highlightedString: document.querySelector('.tok-str')?.textContent || '',
    unsafeNodes: document.querySelectorAll('.message-markdown img, .message-markdown script, .message-markdown iframe').length,
    mountedRows: document.querySelectorAll('.message-row').length,
    virtualHeight: Number.parseFloat(document.querySelector('.virtual-spacer')?.style.height || '0'),
    conversations: document.querySelectorAll('.conversation-item').length
  }))()`;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function cloneChromeProfile(destination) {
  const source = join(homedir(), '.config', 'google-chrome');
  const localState = join(source, 'Local State');
  const parsed = JSON.parse(await readFile(localState, 'utf8'));
  const profile = parsed.profile?.last_used || 'Default';
  await cp(localState, join(destination, 'Local State'));
  await cp(join(source, profile), join(destination, profile), {
    recursive: true,
    filter: (entry) => {
      const relative = entry.slice(join(source, profile).length + 1);
      if (!relative) return true;
      const first = relative.split('/')[0];
      return !new Set(['Cache', 'Code Cache', 'GPUCache', 'Service Worker', 'DawnCache', 'GraphiteDawnCache']).has(first);
    },
  });
}

async function findChrome() {
  const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known binary.
    }
  }
  throw new Error('Chrome/Chromium binary not found; set CHROME_BIN');
}

async function chromeVersion() {
  return new Promise((resolveVersion) => {
    const child = spawn(chromePath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('exit', () => resolveVersion(output.trim()));
  });
}

async function reservePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForJson(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Browser is still starting.
    }
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForTarget(portNumber, predicate, timeoutMs = 20_000) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${portNumber}/json`);
    const items = await response.json();
    return items.find(predicate) || null;
  }, timeoutMs);
}

async function waitFor(check, timeoutMs = 12_000, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw lastError || new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result || {});
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params || {});
  });
  return {
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolveCall, rejectCall) => {
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) {
      const values = listeners.get(method) || [];
      values.push(listener);
      listeners.set(method, values);
    },
    async evaluate(expression) {
      const result = await this.call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
      return result.result?.value;
    },
  };
}

function onceExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
