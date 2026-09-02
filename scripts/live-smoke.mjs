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
      { urlPattern: 'https://chatgpt.com/*', resourceType: 'Document', requestStage: 'Request' },
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
  assert.equal(failOpen.frameDisplay, 'block', 'takeover iframe surface should stay mounted to avoid compositor flashes');
  assert.equal(failOpen.frameVisible, false, 'takeover must stay visually hidden without an official composer');
  assert.equal(failOpen.frameOpacity, '0');
  assert.equal(failOpen.framePointerEvents, 'none');
  assert.equal(failOpen.sleep, null, 'official body must remain awake on auth/challenge pages');

  await top.evaluate(`(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'fixture-cookie-dialog';
    dialog.innerHTML = '<p>Cookie consent fixture</p><button type="button">Accept</button>';
    document.body.appendChild(dialog);
    dialog.showModal();
    return true;
  })()`);
  await top.evaluate(installComposerExpression());
  await sleep(700);
  const blockedByModal = await top.evaluate(topStateExpression());
  assert.equal(blockedByModal.frameDisplay, 'block', 'modal handling must not tear down the iframe surface');
  assert.equal(blockedByModal.frameVisible, false, 'takeover must stay hidden while an official modal is open');
  assert.equal(blockedByModal.sleep, null, 'official body must remain actionable while a modal blocks takeover');

  await top.evaluate(`document.getElementById('fixture-cookie-dialog')?.close()`);
  await waitFor(async () => {
    const state = await top.evaluate(topStateExpression());
    return state.frameVisible === true && state.frameOpacity === '1' && state.sleep === '1';
  });
  const sleepingOfficial = await top.evaluate(topStateExpression());
  assert.equal(sleepingOfficial.bodyDisplay, 'none', 'takeover must remove the official body from layout');

  const frameTarget = await waitForTarget(
    port,
    (item) => item.type === 'iframe' && item.url.startsWith(`chrome-extension://${extensionId}/index.html`),
  );
  const ui = await connectCdp(frameTarget.webSocketDebuggerUrl);
  await ui.call('Runtime.enable');
  await ui.evaluate(`(() => {
    window.__slimgptWindowErrors = [];
    addEventListener('error', (event) => {
      window.__slimgptWindowErrors.push(String(event.message || ''));
    });
  })()`);
  await waitFor(async () => (await ui.evaluate(`document.querySelector('.status-pill')?.textContent?.trim()`)) === '已接管');

  const focusGuard = await top.evaluate(`(() => {
    const frame = document.getElementById('slimgpt-takeover-frame');
    const composer = document.querySelector('#mobile-composer-prompt');
    frame?.focus();
    composer?.focus();
    window.focus();
    return {
      activeId: document.activeElement?.id || '',
      frameFocused: document.activeElement === frame,
    };
  })()`);
  assert.equal(focusGuard.frameFocused, true, 'hidden official controls must not steal focus from the takeover frame');
  assert.equal(focusGuard.activeId, 'slimgpt-takeover-frame');

  const composerLayout = await ui.evaluate(`(() => {
    const textarea = document.querySelector('.composer-shell textarea');
    const style = getComputedStyle(textarea);
    return {
      clientHeight: textarea.clientHeight,
      scrollHeight: textarea.scrollHeight,
      overflowY: style.overflowY,
      lineHeight: style.lineHeight,
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
    };
  })()`);
  assert.equal(composerLayout.clientHeight, 34, 'single-line composer must align with the 34px send control');
  assert.ok(composerLayout.scrollHeight <= composerLayout.clientHeight, 'empty composer must not show a fake vertical scrollbar');
  assert.equal(composerLayout.overflowY, 'hidden');
  assert.equal(composerLayout.lineHeight, '20px');
  assert.equal(composerLayout.paddingTop, '7px');
  assert.equal(composerLayout.paddingBottom, '7px');

  await ui.evaluate(`(() => {
    const textarea = document.querySelector('.composer-shell textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, 'one\\ntwo\\nthree');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(50);
  const composerExpanded = await ui.evaluate(`(() => {
    const textarea = document.querySelector('.composer-shell textarea');
    return { height: textarea.clientHeight, overflowY: getComputedStyle(textarea).overflowY };
  })()`);
  assert.ok(composerExpanded.height > 34 && composerExpanded.height < 160, 'multiline composer must grow before scrolling');
  assert.equal(composerExpanded.overflowY, 'hidden');

  await ui.evaluate(`(() => {
    const textarea = document.querySelector('.composer-shell textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, Array.from({ length: 20 }, (_, index) => 'line ' + index).join('\\n'));
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(50);
  const composerOverflow = await ui.evaluate(`(() => {
    const textarea = document.querySelector('.composer-shell textarea');
    return { height: textarea.clientHeight, overflowY: getComputedStyle(textarea).overflowY };
  })()`);
  assert.equal(composerOverflow.height, 160, 'composer must stop growing at the configured maximum');
  assert.equal(composerOverflow.overflowY, 'auto', 'composer should scroll only after reaching its maximum height');

  await ui.evaluate(`(() => {
    const textarea = document.querySelector('.composer-shell textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  await top.evaluate(`(() => {
    history.replaceState(history.state, '', '/c/smoke');
    return Promise.all([
      fetch('/backend-api/me').then((response) => response.json()),
      fetch('/backend-api/conversation/smoke').then((response) => response.json())
    ]);
  })()`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).conversations === 3);
  assert.ok(
    (fixture.conversationListRequests || 0) >= 1,
    'an authenticated backend request must trigger proactive cloud conversation-index sync',
  );
  await waitFor(async () => {
    const state = await ui.evaluate(uiStateExpression());
    return state.title === 'Fixture conversation' && state.messages.includes('Fixture answer');
  });
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).sidebarWorkState === 'stopped');
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).mathNodes > 0);
  const canonicalUi = await ui.evaluate(uiStateExpression());
  assert.equal(canonicalUi.highlightedString, '"ok"', 'incremental Markdown renderer must emit valid, escaped string tokens');
  assert.ok(canonicalUi.mathNodes > 0, 'KaTeX must load on demand for finalized math');
  assert.equal(canonicalUi.unsafeNodes, 0, 'captured Markdown must not create raw scriptable elements');
  assert.equal(canonicalUi.mountedCards, 2, 'the center pane must mount only the active user+assistant turn');
  assert.equal(canonicalUi.overviewItems, 60, 'the right overview must index one row per user+assistant turn');
  assert.equal(canonicalUi.activeOverview, '60', 'a newly opened conversation should start at the latest turn');
  assert.ok(canonicalUi.modelLabel.toLowerCase().includes('gpt-5'), 'enhanced history must surface the captured model');
  assert.ok(canonicalUi.historyPreview.includes('Fixture answer'), 'enhanced history must surface the latest message preview');
  assert.equal(canonicalUi.sidebarWorkState, 'stopped', 'an hydrated composer with no stop control is direct idle evidence');
  await sleep(700);
  const persistedIndex = await ui.evaluate(`JSON.parse(localStorage.getItem('slimgpt:conversation-index:v1') || '[]')`);
  assert.deepEqual(Object.keys(persistedIndex[0]).sort(), ['create_time', 'id', 'last', 'model', 'route', 'title', 'update_time']);

  await ui.evaluate(`document.querySelector('[data-overview-index="0"]')?.click()`);
  await waitFor(async () => {
    const state = await ui.evaluate(uiStateExpression());
    return (
      state.activeOverview === '1' &&
      state.messages.includes('Fixture user message 1') &&
      state.messages.includes('Fixture assistant message 2')
    );
  });
  const firstTurn = await ui.evaluate(uiStateExpression());
  assert.ok(firstTurn.messages.includes('Fixture assistant message 2'), 'question and answer must stay together in one center-page turn');
  assert.equal(firstTurn.messages.includes('Fixture user message 3'), false, 'the next question must not leak into the active turn');
  assert.equal(firstTurn.mountedCards, 2);

  const longTurnScroll = await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    const style = scroller ? getComputedStyle(scroller) : null;
    return {
      clientHeight: scroller?.clientHeight || 0,
      scrollHeight: scroller?.scrollHeight || 0,
      overflowY: style?.overflowY || '',
      scrollbarWidth: style?.scrollbarWidth || '',
    };
  })()`);
  assert.ok(longTurnScroll.scrollHeight > longTurnScroll.clientHeight, 'a long answer must scroll inside its own question+answer turn');
  assert.equal(longTurnScroll.overflowY, 'auto');
  assert.notEqual(longTurnScroll.scrollbarWidth, 'none', 'only the active turn scroller should expose a visible scrollbar');

  await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    scroller.scrollTop = Math.floor((scroller.scrollHeight - scroller.clientHeight) / 2);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
  })()`);
  assert.ok((await ui.evaluate(`document.querySelector('.single-message-scroller')?.scrollTop || 0`)) <= 1, 'Home must jump to the current turn start');
  await ui.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))`);
  assert.ok(await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return Math.abs(scroller.scrollTop - max) <= 1;
  })()`), 'End must jump to the current turn end');

  await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    const delta = Math.max(400, scroller.clientHeight * 0.96);
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true, cancelable: true }));
  })()`);
  await sleep(80);
  const downwardRunway = await ui.evaluate(`(() => {
    const runway = document.querySelector('.turn-boundary-runway.down');
    const stage = document.querySelector('.conversation-turn-stage');
    return {
      active: document.querySelector('.overview-item.active .overview-number')?.textContent?.trim() || '',
      runwayRatio: runway && stage ? runway.clientHeight / stage.clientHeight : 0,
      ready: runway?.classList.contains('ready') || false,
      transform: document.querySelector('.single-message-content')?.style.transform || '',
    };
  })()`);
  assert.equal(downwardRunway.active, '1', 'filling the downward runway must not flip immediately');
  assert.ok(downwardRunway.runwayRatio > 0.9, 'boundary blank space should expand until it occupies the viewport');
  assert.equal(downwardRunway.ready, true);
  assert.match(downwardRunway.transform, /translateY\(-/);
  await ui.evaluate(`document.querySelector('.single-message-scroller')?.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }))`);
  await waitFor(async () => {
    const state = await ui.evaluate(uiStateExpression());
    return state.activeOverview === '2' && state.messages.includes('Fixture user message 3');
  });
  const secondTurn = await ui.evaluate(uiStateExpression());
  assert.ok(secondTurn.messages.includes('Fixture user message 3'));
  assert.ok(secondTurn.messages.includes('Fixture assistant message 4'));
  assert.equal(secondTurn.messages.includes('Fixture user message 5'), false);

  const secondTurnStart = await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    return scroller?.scrollTop || 0;
  })()`);
  assert.ok(secondTurnStart <= 1, 'downward turn navigation must land at the next turn start');

  await sleep(280);
  await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    scroller.scrollTop = 0;
    const delta = Math.max(400, scroller.clientHeight * 0.96);
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -delta, bubbles: true, cancelable: true }));
  })()`);
  await sleep(80);
  const upwardRunway = await ui.evaluate(`(() => ({
    active: document.querySelector('.overview-item.active .overview-number')?.textContent?.trim() || '',
    ready: document.querySelector('.turn-boundary-runway.up')?.classList.contains('ready') || false,
  }))()`);
  assert.equal(upwardRunway.active, '2', 'filling the upward runway must not flip immediately');
  assert.equal(upwardRunway.ready, true);
  await ui.evaluate(`document.querySelector('.single-message-scroller')?.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true, cancelable: true }))`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).activeOverview === '1');
  await waitFor(async () => await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    if (!scroller) return false;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return Math.abs(scroller.scrollTop - max) <= 1;
  })()`), 1_500);
  assert.ok(await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return Math.abs(scroller.scrollTop - max) <= 1;
  })()`), 'wheel-up across a turn boundary must land at the previous turn end');

  await sleep(280);
  await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    const delta = Math.max(400, scroller.clientHeight * 0.96);
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true, cancelable: true }));
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true }));
  })()`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).activeOverview === '2');
  assert.ok((await ui.evaluate(`document.querySelector('.single-message-scroller')?.scrollTop || 0`)) <= 1, 'wheel-down across a turn boundary must land at the next turn start');

  await sleep(280);
  await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    scroller.scrollTop = 0;
    const steps = Math.ceil(Math.max(360, scroller.clientHeight * 0.95) / 72);
    for (let index = 0; index < steps; index += 1) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    }
  })()`);
  assert.equal((await ui.evaluate(uiStateExpression())).activeOverview, '2', 'ArrowUp should fill the runway before crossing');
  await ui.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).activeOverview === '1');
  await waitFor(async () => await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    if (!scroller) return false;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return Math.abs(scroller.scrollTop - max) <= 1;
  })()`), 1_500);
  const arrowUpLanding = await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    return {
      scrollTop: scroller?.scrollTop || 0,
      maxScrollTop: Math.max(0, (scroller?.scrollHeight || 0) - (scroller?.clientHeight || 0)),
    };
  })()`);
  assert.ok(Math.abs(arrowUpLanding.scrollTop - arrowUpLanding.maxScrollTop) <= 1, 'ArrowUp across a turn boundary must land at the previous turn end');

  await sleep(280);
  await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    const steps = Math.ceil(Math.max(360, scroller.clientHeight * 0.95) / 72);
    for (let index = 0; index < steps; index += 1) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    }
  })()`);
  assert.equal((await ui.evaluate(uiStateExpression())).activeOverview, '1', 'ArrowDown should fill the runway before crossing');
  await ui.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).activeOverview === '2');
  assert.ok((await ui.evaluate(`document.querySelector('.single-message-scroller')?.scrollTop || 0`)) <= 1, 'ArrowDown across a turn boundary must land at the next turn start');

  await sleep(280);
  await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    scroller.scrollTop = 0;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }));
  })()`);
  assert.equal((await ui.evaluate(uiStateExpression())).activeOverview, '2', 'PageUp should fill the runway before crossing');
  await ui.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }))`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).activeOverview === '1');
  await waitFor(async () => await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    if (!scroller) return false;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return Math.abs(scroller.scrollTop - max) <= 1;
  })()`), 1_500);
  const pageUpLanding = await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    return {
      scrollTop: scroller?.scrollTop || 0,
      maxScrollTop: Math.max(0, (scroller?.scrollHeight || 0) - (scroller?.clientHeight || 0)),
    };
  })()`);
  assert.ok(Math.abs(pageUpLanding.scrollTop - pageUpLanding.maxScrollTop) <= 1, 'PageUp across a turn boundary must land at the previous turn end');

  await sleep(280);
  await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    scroller.scrollTop = scroller.scrollHeight;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }));
  })()`);
  assert.equal((await ui.evaluate(uiStateExpression())).activeOverview, '1', 'PageDown should fill the runway before crossing');
  await ui.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).activeOverview === '2');
  assert.ok((await ui.evaluate(`document.querySelector('.single-message-scroller')?.scrollTop || 0`)) <= 1, 'PageDown across a turn boundary must land at the next turn start');

  await ui.evaluate(`document.querySelector('[data-overview-index="0"]')?.click()`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).activeOverview === '1');
  const pageDownWithinTurnBefore = await ui.evaluate(`document.querySelector('.single-message-scroller')?.scrollTop || 0`);
  await ui.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))`);
  await sleep(80);
  const pageDownWithinTurn = await ui.evaluate(`(() => ({
    active: document.querySelector('.overview-item.active .overview-number')?.textContent?.trim() || '',
    scrollTop: document.querySelector('.single-message-scroller')?.scrollTop || 0,
  }))()`);
  assert.equal(pageDownWithinTurn.active, '1', 'PageDown must scroll within a long turn before crossing the turn boundary');
  assert.ok(pageDownWithinTurn.scrollTop > pageDownWithinTurnBefore, 'PageDown must move the active turn viewport down');

  await ui.evaluate(`document.querySelector('[data-overview-index="59"]')?.click()`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).activeOverview === '60');

  const wideMetrics = {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  };
  await top.call('Emulation.setDeviceMetricsOverride', wideMetrics);
  await sleep(120);
  const wideLayout = await ui.evaluate(`(() => {
    const shell = document.querySelector('.app-shell');
    const center = document.querySelector('.chat-pane');
    const content = document.querySelector('.single-message-content');
    const overview = document.querySelector('.overview-host');
    const sidebar = document.querySelector('.sidebar-host');
    const thinking = document.querySelector('.thinking-segmented');
    return {
      columns: getComputedStyle(shell).gridTemplateColumns,
      centerWidth: center?.clientWidth || 0,
      contentWidth: content?.clientWidth || 0,
      overviewWidth: overview?.clientWidth || 0,
      sidebarWidth: sidebar?.clientWidth || 0,
      thinkingButtons: thinking?.querySelectorAll('.button').length || 0,
      thinkingActive: thinking?.querySelectorAll('.button-active').length || 0,
      thinkingFramework7: thinking?.classList.contains('segmented') || false,
      thinkingOverflow: thinking ? thinking.scrollWidth - thinking.clientWidth : 0,
    };
  })()`);
  assert.ok(wideLayout.columns.split(' ').length >= 3, 'desktop must use a permanent left-center-right layout');
  assert.ok(wideLayout.contentWidth > 900, 'wide-screen mode must actually broaden the center conversation area');
  assert.ok(wideLayout.sidebarWidth >= 270 && wideLayout.overviewWidth >= 250);
  assert.equal(wideLayout.thinkingButtons, 5);
  assert.equal(wideLayout.thinkingActive, 1);
  assert.equal(wideLayout.thinkingFramework7, true, 'thinking levels must use the Framework7 Segmented component');
  assert.ok(wideLayout.thinkingOverflow <= 1, 'desktop thinking selector must not overflow');
  await ui.evaluate(`(() => {
    const active = document.querySelector('.thinking-segmented .button-active');
    active?.focus();
    active?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  })()`);
  await waitFor(async () => await ui.evaluate(`document.querySelector('.thinking-segmented .button-active')?.textContent?.trim() === '深入'`));
  assert.equal(await ui.evaluate(`document.querySelector('.thinking-segmented [aria-checked="true"]')?.getAttribute('data-thinking-level') || ''`), '3');
  await ui.evaluate(`document.querySelector('.thinking-segmented [data-thinking-level="2"]')?.click()`);
  await waitFor(async () => await ui.evaluate(`document.querySelector('.thinking-segmented .button-active')?.textContent?.trim() === '标准'`));

  const mobileMetrics = {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  };
  await top.call('Emulation.setDeviceMetricsOverride', mobileMetrics);
  await top.evaluate(`(() => {
    const frame = document.getElementById('slimgpt-takeover-frame');
    if (!frame) return false;
    frame.style.inset = '0 auto auto 0';
    frame.style.width = '390px';
    frame.style.height = '844px';
    return true;
  })()`);
  await sleep(180);
  const mobileInitial = await ui.evaluate(`(() => ({
    navbar: getComputedStyle(document.querySelector('.mobile-navbar')).display,
    sidebarOpen: document.querySelector('.sidebar-host')?.classList.contains('open') || false,
    overviewOpen: document.querySelector('.overview-host')?.classList.contains('open') || false,
    thinkingButtons: document.querySelectorAll('.thinking-segmented .button').length,
    thinkingWidth: document.querySelector('.thinking-segmented')?.getBoundingClientRect().width || 0,
    composerWidth: document.querySelector('.composer-wrap')?.getBoundingClientRect().width || 0,
    thinkingOverflow: (() => { const node = document.querySelector('.thinking-segmented'); return node ? node.scrollWidth - node.clientWidth : 0; })(),
  }))()`);
  assert.notEqual(mobileInitial.navbar, 'none');
  assert.equal(mobileInitial.sidebarOpen, false);
  assert.equal(mobileInitial.overviewOpen, false);
  assert.equal(mobileInitial.thinkingButtons, 5);
  assert.ok(
    mobileInitial.thinkingWidth > 250 && mobileInitial.thinkingWidth <= mobileInitial.composerWidth,
    `mobile thinking selector dimensions: ${JSON.stringify(mobileInitial)}`,
  );
  assert.ok(mobileInitial.thinkingOverflow <= 1, 'mobile thinking selector must fit without horizontal scrolling');

  await ui.evaluate(`[...document.querySelectorAll('.mobile-navbar .button')].find((button) => button.textContent.includes('☰'))?.click()`);
  await waitFor(async () => await ui.evaluate(`document.querySelector('.sidebar-host')?.classList.contains('open') || false`));
  assert.equal(await ui.evaluate(`document.querySelector('.overview-host')?.classList.contains('open') || false`), false);
  await ui.evaluate(`document.querySelector('.sidebar-scrim')?.click()`);
  await waitFor(async () => !(await ui.evaluate(`document.querySelector('.sidebar-host')?.classList.contains('open') || false`)));

  await ui.evaluate(`(() => {
    const button = [...document.querySelectorAll('.mobile-navbar .button')].find((node) => node.textContent.includes('概览'));
    if (!button) return false;
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: 360, clientY: 24 }));
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: 320, clientY: 24 }));
    return true;
  })()`);
  await sleep(80);
  assert.equal(
    await ui.evaluate(`document.querySelector('.overview-host')?.classList.contains('open') || false`),
    false,
    'a mobile swipe/drag across the overview control must not open the drawer',
  );
  await ui.evaluate(`(() => {
    const button = [...document.querySelectorAll('.mobile-navbar .button')].find((node) => node.textContent.includes('概览'));
    if (!button) return false;
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 12, pointerType: 'touch', isPrimary: true, clientX: 350, clientY: 24 }));
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 12, pointerType: 'touch', isPrimary: true, clientX: 352, clientY: 25 }));
    return true;
  })()`);
  await waitFor(async () => await ui.evaluate(`document.querySelector('.overview-host')?.classList.contains('open') || false`));
  assert.equal(await ui.evaluate(`document.querySelector('.sidebar-host')?.classList.contains('open') || false`), false);
  await ui.evaluate(`document.querySelector('.sidebar-scrim')?.click()`);
  await waitFor(async () => !(await ui.evaluate(`document.querySelector('.overview-host')?.classList.contains('open') || false`)));

  const resetMetrics = {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  };
  await top.call('Emulation.setDeviceMetricsOverride', resetMetrics);
  await top.evaluate(`(() => {
    const frame = document.getElementById('slimgpt-takeover-frame');
    if (!frame) return false;
    frame.style.inset = '0';
    frame.style.width = '100%';
    frame.style.height = '100%';
    return true;
  })()`);
  await sleep(120);

  const incrementalBase = `Stable incremental paragraph.\n\n\`\`\`js\nconst stable = "kept";\n\`\`\`\n\n${Array.from({ length: 140 }, (_, index) => `Streaming line ${index + 1}: ${'content '.repeat(10)}`).join('\n')}`;
  await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    if (!scroller) return false;
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll'));
    return true;
  })()`);
  await sleep(80);
  await top.evaluate(`(() => {
    history.replaceState(history.state, '', '/c/smoke');
    window.__slimgptIncrementalCaptures = [];
    if (!window.__slimgptIncrementalCaptureListener) {
      window.__slimgptIncrementalCaptureListener = (event) => {
        const payload = event.data?.payload;
        if (event.data?.channel === 'slimgpt-page-v1' && payload?.requestId === 'dom-incremental-stream-message') {
          window.__slimgptIncrementalCaptures.push(String(payload.data || ''));
        }
      };
      addEventListener('message', window.__slimgptIncrementalCaptureListener);
    }
    document.getElementById('incremental-stream-message')?.remove();
    const article = document.createElement('article');
    article.id = 'incremental-stream-message';
    article.setAttribute('data-message-id', 'incremental-stream-message');
    const content = document.createElement('div');
    content.setAttribute('data-message-author-role', 'assistant');
    content.textContent = ${JSON.stringify(incrementalBase)};
    article.appendChild(content);
    document.body.appendChild(article);
  })()`);
  await waitFor(async () => await top.evaluate(`window.__slimgptIncrementalCaptures?.some((value) => value.includes('Streaming line 140:')) || false`));
  await waitFor(async () => await ui.evaluate(`document.querySelector('.message-stage')?.innerText?.includes('Streaming line 140:') || false`));
  const initialIncremental = await ui.evaluate(`(() => {
    const card = [...document.querySelectorAll('.message-card')].find((node) => node.textContent.includes('Stable incremental paragraph.'));
    const paragraph = card?.querySelector('.message-markdown p');
    const code = card?.querySelector('.code-block');
    window.__slimgptStableParagraph = paragraph || null;
    window.__slimgptStableCode = code || null;
    const scroller = document.querySelector('.single-message-scroller');
    return {
      paragraph: Boolean(paragraph),
      code: Boolean(code),
      highlighted: Boolean(code?.querySelector('.tok-key')),
      tailRemaining: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : Infinity,
    };
  })()`);
  assert.equal(initialIncremental.paragraph, true);
  assert.equal(initialIncremental.code, true);
  assert.equal(initialIncremental.highlighted, true);
  assert.ok(initialIncremental.tailRemaining <= 56, 'a reader already at the tail must follow new streamed content');

  const incrementalExtension = `${incrementalBase}\nStreaming extension keeps completed blocks mounted.`;
  await top.evaluate(`(() => {
    const node = document.querySelector('#incremental-stream-message [data-message-author-role]')?.firstChild;
    if (node) node.nodeValue = ${JSON.stringify(incrementalExtension)};
  })()`);
  await waitFor(async () => await top.evaluate(`window.__slimgptIncrementalCaptures?.some((value) => value.includes('Streaming extension keeps completed blocks mounted.')) || false`));
  await waitFor(async () => await ui.evaluate(`document.querySelector('.message-stage')?.innerText?.includes('Streaming extension keeps completed blocks mounted') || false`));
  const appendedIncremental = await ui.evaluate(`(() => {
    const card = [...document.querySelectorAll('.message-card')].find((node) => node.textContent.includes('Stable incremental paragraph.'));
    const scroller = document.querySelector('.single-message-scroller');
    return {
      sameParagraph: card?.querySelector('.message-markdown p') === window.__slimgptStableParagraph,
      sameCode: card?.querySelector('.code-block') === window.__slimgptStableCode,
      tailRemaining: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : Infinity,
    };
  })()`);
  assert.equal(appendedIncremental.sameParagraph, true, 'completed paragraphs must retain their DOM identity while a response grows');
  assert.equal(appendedIncremental.sameCode, true, 'completed code blocks must retain their DOM identity while a response grows');
  assert.ok(appendedIncremental.tailRemaining <= 56);

  const detachedScrollTop = await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(0, max - 320);
    scroller.dispatchEvent(new Event('scroll'));
    return scroller.scrollTop;
  })()`);
  await sleep(80);
  const detachedExtension = `${incrementalExtension}\n${Array.from({ length: 30 }, (_, index) => `Detached tail ${index + 1}: ${'new '.repeat(12)}`).join('\n')}`;
  await top.evaluate(`(() => {
    const node = document.querySelector('#incremental-stream-message [data-message-author-role]')?.firstChild;
    if (node) node.nodeValue = ${JSON.stringify(detachedExtension)};
  })()`);
  await waitFor(async () => await ui.evaluate(`document.querySelector('.message-stage')?.innerText?.includes('Detached tail 30:') || false`));
  const detachedAfter = await ui.evaluate(`(() => {
    const scroller = document.querySelector('.single-message-scroller');
    return {
      scrollTop: scroller?.scrollTop || 0,
      tailRemaining: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : 0,
    };
  })()`);
  assert.ok(Math.abs(detachedAfter.scrollTop - detachedScrollTop) <= 4, 'streaming must not move a reader who left the tail');
  assert.ok(detachedAfter.tailRemaining > 56);

  await ui.evaluate(`(() => {
    window.__slimgptExportBlob = null;
    window.__slimgptExportName = '';
    URL.createObjectURL = (blob) => {
      window.__slimgptExportBlob = blob;
      return 'blob:slimgpt-smoke-export';
    };
    const nativeAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        window.__slimgptExportName = this.download;
        return;
      }
      return nativeAnchorClick.call(this);
    };
    [...document.querySelectorAll('.sidebar-actions .button')]
      .find((button) => button.textContent.includes('导出 Markdown'))?.click();
    return true;
  })()`);
  const markdownExport = await ui.evaluate(`(async () => ({
    filename: window.__slimgptExportName,
    content: window.__slimgptExportBlob ? await window.__slimgptExportBlob.text() : ''
  }))()`);
  assert.equal(markdownExport.filename, 'Fixture conversation.md');
  assert.ok(markdownExport.content.startsWith('# Fixture conversation\n\n## 你\n\nFixture user message 1'));
  assert.ok(markdownExport.content.includes('Fixture assistant message 118'), 'export must include messages outside the virtualized DOM');
  assert.ok(markdownExport.content.includes('```js\nconst value = "ok";\n```'), 'export must preserve Markdown code blocks');

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
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).sidebarWorkState === 'running');
  const sendSuccess = await ui.evaluate(uiStateExpression());
  assert.equal(sendSuccess.composerStatus, '消息已发送（官方已确认）', 'composer success requires the page-world send confirmation, not just the click');
  assert.equal(sendSuccess.sidebarWorkState, 'running', 'a visible official stop control must be treated as direct running evidence');

  await top.evaluate(`fetch('/backend-api/messages/misleading-terminal').then((response) => response.json())`);
  await sleep(180);
  assert.equal(
    (await ui.evaluate(uiStateExpression())).sidebarWorkState,
    'running',
    'a terminal-looking assistant message must not override direct running evidence',
  );

  await top.evaluate(`(() => {
    const form = document.getElementById('fixture-composer');
    form?.querySelector('[data-testid="stop-button"]')?.remove();
    const send = form?.querySelector('[data-composer-submit]');
    if (send) send.hidden = false;
  })()`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).sidebarWorkState === 'stopped');
  await top.evaluate(`fetch('/backend-api/messages/stale-running').then((response) => response.json())`);
  await sleep(180);
  assert.equal(
    (await ui.evaluate(uiStateExpression())).sidebarWorkState,
    'stopped',
    'a stale in-progress assistant event must not resurrect a stopped turn',
  );

  await top.evaluate(`(() => {
    window.__slimgptContinueClicks = 0;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Continue generating';
    button.addEventListener('click', () => {
      window.__slimgptContinueClicks += 1;
      button.remove();
    });
    document.body.appendChild(button);
  })()`);
  await waitFor(async () => (await top.evaluate('window.__slimgptContinueClicks || 0')) === 1, 4_000);

  // send-unconfirmed contract: a silent composer (button click swallowed) must
  // be reported as unconfirmed instead of success. The original fixture
  // composer is removed first so the silent one is the only composer found.
  await top.evaluate(`document.getElementById('fixture-composer')?.remove()`);
  await top.evaluate(`(() => {
    const form = document.createElement('form');
    form.id = 'fixture-composer-silent';
    form.style.cssText = 'position:fixed;left:20px;top:20px;width:500px;height:120px;display:block';
    const textarea = document.createElement('textarea');
    textarea.id = 'mobile-composer-prompt-silent';
    textarea.setAttribute('data-mobile-composer-prompt', '');
    textarea.style.cssText = 'display:block;width:400px;height:60px';
    const button = document.createElement('button');
    button.type = 'submit';
    button.setAttribute('data-composer-submit', '');
    button.style.cssText = 'display:block;width:100px;height:40px';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      // A dropped click: nothing happens, composer keeps its text.
    });
    form.append(textarea, button);
    document.body.appendChild(form);
    return true;
  })()`);
  const unconfirmedText = 'Unconfirmed send must not report success';
  await ui.evaluate(fillAndSubmitExpression(unconfirmedText));
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).composerStatus.includes('未确认'), 12_000);
  const unconfirmedSend = await ui.evaluate(uiStateExpression());
  assert.equal(unconfirmedSend.draft, unconfirmedText, 'unconfirmed sends must keep the draft');
  await top.evaluate(`document.getElementById('fixture-composer-silent')?.remove()`);
  await ui.evaluate(`(() => {
    const textarea = document.querySelector('.composer-shell textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(textarea, '');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  const failedText = 'Draft that must survive';
  await ui.evaluate(fillAndSubmitExpression(failedText));
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).composerStatus.includes('找不到官方输入框'), 7_000);
  const sendFailure = await ui.evaluate(uiStateExpression());
  assert.equal(sendFailure.draft, failedText, 'failed submissions must preserve the draft');

  await ui.evaluate(`document.querySelector('.desktop-chat-header .button')?.click()`);
  await waitFor(async () => (await top.evaluate(topStateExpression())).restore === true);
  const official = await top.evaluate(topStateExpression());
  assert.equal(official.frameDisplay, 'block', 'showing official UI must keep the takeover iframe mounted');
  assert.equal(official.frameVisible, false);
  assert.equal(official.frameOpacity, '0');
  assert.equal(official.framePointerEvents, 'none');
  assert.equal(official.sleep, null);
  assert.equal(official.bodyDisplay, 'block');
  await top.evaluate(`document.getElementById('slimgpt-restore-button')?.click()`);
  await waitFor(async () => (await top.evaluate(topStateExpression())).sleep === '1');
  const restored = await top.evaluate(topStateExpression());
  assert.equal(restored.bodyDisplay, 'none');

  const navigationDocumentToken = await top.evaluate(`(() => {
    window.__slimgptNavigationDocumentToken = crypto.randomUUID();
    window.__slimgptPopstatePaths = [];
    addEventListener('popstate', () => {
      window.__slimgptPopstatePaths.push(location.pathname);
      if (location.pathname === '/c/second') {
        setTimeout(() => fetch('/backend-api/conversation/second').then((response) => response.json()), 300);
      } else if (location.pathname === '/c/live-only') {
        setTimeout(() => fetch('/backend-api/messages/live-only').then((response) => response.json()), 300);
      }
    });
    return window.__slimgptNavigationDocumentToken;
  })()`);
  await top.evaluate(`(() => {
    fetch('/backend-api/f/conversation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: 'smoke' }),
    }).then((response) => response.json()).catch(() => {});
    return true;
  })()`);
  await ui.evaluate(`[...document.querySelectorAll('.conversation-item')]
    .find((button) => button.textContent.includes('Second conversation'))?.click()`);
  await waitFor(async () => {
    const url = await top.evaluate('location.href');
    return new URL(url).pathname === '/c/second';
  });
  await waitFor(async () => await ui.evaluate(`!!document.querySelector('.conversation-loading')`));
  const navigationLoading = {
    top: await top.evaluate(topStateExpression()),
    token: await top.evaluate('window.__slimgptNavigationDocumentToken || null'),
    popstatePaths: await top.evaluate('window.__slimgptPopstatePaths || []'),
    ui: await ui.evaluate(`(() => ({
      loading: !!document.querySelector('.conversation-loading'),
      loadingText: document.querySelector('.conversation-loading')?.innerText?.replace(/\\s+/g, ' ').trim() || '',
      composerDisabled: document.querySelector('.composer-shell textarea')?.disabled || false,
      draft: document.querySelector('.composer-shell textarea')?.value || '',
      mountedCards: document.querySelectorAll('.message-card').length,
    }))()`),
  };
  assert.equal(navigationLoading.token, navigationDocumentToken, 'conversation navigation must preserve the host document');
  assert.equal(navigationLoading.top.frameVisible, true, 'takeover frame must stay visible during conversation navigation');
  assert.equal(navigationLoading.top.frameOpacity, '1');
  assert.equal(navigationLoading.top.sleep, '1', 'official UI must remain render-slept behind the stable takeover frame');
  assert.equal(navigationLoading.ui.loading, true, 'right pane must show a loading state before target payload arrives');
  assert.equal(navigationLoading.ui.composerDisabled, true, 'composer must be disabled while the target conversation is loading');
  assert.equal(navigationLoading.ui.draft, '', 'drafts must be isolated per conversation instead of following navigation');
  assert.equal(navigationLoading.ui.mountedCards, 0, 'previous conversation must disappear as soon as navigation starts');
  assert.ok(navigationLoading.popstatePaths.includes('/c/second'), 'SPA fallback must notify the host router with popstate');

  await waitFor(async () => {
    const state = await ui.evaluate(uiStateExpression());
    return state.title === 'Second conversation' && state.messages.includes('Second answer');
  });
  assert.equal(await ui.evaluate(`!!document.querySelector('.conversation-loading')`), false, 'loading state must disappear after payload arrives');
  assert.equal(await top.evaluate('window.__slimgptNavigationDocumentToken'), navigationDocumentToken, 'payload load must not replace the host document');

  // Cross-conversation bleed regression: after navigating smoke → second, the
  // smoke conversation messages must not leak into the second conversation's
  // right pane.
  const bleedCheck = await ui.evaluate(uiStateExpression());
  assert.equal(bleedCheck.messages.includes('Fixture answer'), false, 'smoke conversation content must not bleed into the second conversation');
  assert.equal(bleedCheck.messages.includes('Fixture user message 1'), false, 'smoke conversation question must not bleed across conversations');
  await waitFor(async () => await ui.evaluate(`[...document.querySelectorAll('.conversation-item')]
    .some((item) => item.textContent.includes('Delayed smoke-only answer'))`));
  const delayedCaptureCheck = await ui.evaluate(uiStateExpression());
  assert.equal(delayedCaptureCheck.messages.includes('Delayed smoke-only answer'), false, 'a response started in smoke must retain that identity after navigation');

  await top.evaluate(`(() => {
    const capture = (requestId, conversationId, eventConversationId, id, text) => {
      const event = {
        message: {
          id,
          author: { role: 'assistant' },
          content: { parts: [text] },
          status: 'finished_successfully',
          end_turn: true,
        },
      };
      if (eventConversationId) event.conversation_id = eventConversationId;
      const payload = {
        type: 'page-capture',
        transport: 'fetch',
        phase: 'complete',
        requestId,
        url: 'https://chatgpt.com/backend-api/conversation',
        mimeType: 'application/json',
        timestamp: Date.now(),
        data: JSON.stringify(event),
      };
      if (conversationId) payload.conversationId = conversationId;
      window.postMessage({
        channel: 'slimgpt-page-v1',
        direction: 'page-to-extension',
        payload,
      }, location.origin);
    };
    capture('scoped-stale-smoke', 'smoke', null, 'scoped-stale-a1', 'Scoped stale smoke answer');
    capture('ambiguous-stale', null, null, 'ambiguous-stale-a1', 'Ambiguous stale answer');
    capture('conflicting-stale', 'smoke', 'second', 'conflicting-stale-a1', 'Conflicting stale answer');
  })()`);
  await waitFor(async () => await ui.evaluate(`[...document.querySelectorAll('.conversation-item')]
    .some((item) => item.textContent.includes('Scoped stale smoke answer'))`));
  await sleep(50);
  const isolatedCaptureCheck = await ui.evaluate(uiStateExpression());
  assert.equal(isolatedCaptureCheck.messages.includes('Scoped stale smoke answer'), false, 'a late capture scoped to smoke must not render in second');
  assert.equal(isolatedCaptureCheck.messages.includes('Ambiguous stale answer'), false, 'an unscoped late capture must be dropped instead of assigned to the visible conversation');
  assert.equal(isolatedCaptureCheck.messages.includes('Conflicting stale answer'), false, 'conflicting capture identities must fail closed');

  await ui.evaluate(`[...document.querySelectorAll('.conversation-item')]
    .find((button) => button.textContent.includes('Mobile fixture'))?.click()`);
  await waitFor(async () => (await top.evaluate('location.pathname')) === '/uc/mobile-smoke');
  assert.equal((await ui.evaluate(uiStateExpression())).draft, failedText, 'returning to a conversation must restore only its own draft');
  await ui.evaluate(`[...document.querySelectorAll('.conversation-item')]
    .find((button) => button.textContent.includes('Second conversation'))?.click()`);
  await waitFor(async () => (await top.evaluate('location.pathname')) === '/c/second');
  assert.equal((await ui.evaluate(uiStateExpression())).draft, '', 'restoring another conversation must not carry the previous draft');

  const toolRendering = await ui.evaluate(`(() => {
    const text = (selector) => {
      const node = document.querySelector(selector);
      return node ? String(node.textContent || '').trim() : '';
    };
    const tomlNodes = Array.from(document.querySelectorAll('.tool-toml-pre code.language-toml'));
    const toolNameNodes = Array.from(document.querySelectorAll('.tool-message-name'));
    return {
      calls: document.querySelectorAll('.message-card.tool-call').length,
      results: document.querySelectorAll('.message-card.tool-result').length,
      callAvatar: text('.message-card.tool-call .message-avatar'),
      resultAvatar: text('.message-card.tool-result .message-avatar'),
      markdownInsideTools: document.querySelectorAll('.message-card.tool-call .message-markdown, .message-card.tool-result .message-markdown').length,
      tomlBlocks: tomlNodes.length,
      tomlText: tomlNodes.map((node) => String(node.textContent || '')).join('\\n---\\n'),
      highlightedTokens: document.querySelectorAll('.tool-toml-pre .hljs-attr, .tool-toml-pre .hljs-string, .tool-toml-pre .hljs-number').length,
      toolNames: toolNameNodes.map((node) => String(node.textContent || '').trim()),
      replyKinds: Array.from(document.querySelectorAll('.turn-reply')).map((node) =>
        node.querySelector('.thinking-indicator') ? 'thinking'
          : node.querySelector('.message-card.tool-call') ? 'tool-call'
          : node.querySelector('.message-card.tool-result') ? 'tool-result'
          : 'message'
      ),
    };
  })()`);
  assert.equal(toolRendering.calls, 1, 'tool calls must render as their own card/avatar instead of Markdown');
  assert.equal(toolRendering.results, 1, 'tool results must render as their own card/avatar instead of Markdown');
  assert.equal(toolRendering.callAvatar, '↗');
  assert.equal(toolRendering.resultAvatar, '↙');
  assert.equal(toolRendering.markdownInsideTools, 0, 'structured tool payloads must bypass the Markdown renderer');
  assert.equal(toolRendering.tomlBlocks, 2, 'tool call and result must each render a TOML code block');
  assert.ok(toolRendering.tomlText.includes('query = "SlimGPT"'));
  assert.ok(toolRendering.tomlText.includes('[options]'));
  assert.ok(toolRendering.tomlText.includes('next = "<null>"'));
  assert.ok(toolRendering.highlightedTokens > 0, 'TOML code must be syntax highlighted');
  assert.deepEqual(toolRendering.toolNames, ['web.run', 'web.run']);
  assert.deepEqual(toolRendering.replyKinds, ['tool-call', 'tool-result', 'message', 'thinking'], 'the transient thinking indicator must remain after tool activity');

  await ui.evaluate(`[...document.querySelectorAll('.conversation-item')]
    .find((button) => button.textContent.includes('Live only conversation'))?.click()`);
  await waitFor(async () => (await top.evaluate('location.pathname')) === '/c/live-only');
  await waitFor(async () => await ui.evaluate(`!!document.querySelector('.conversation-loading')`));
  await waitFor(async () => {
    const state = await ui.evaluate(uiStateExpression());
    return state.messages.includes('Live-only answer') && !state.loading;
  });
  // The live-only conversation carries no finished assistant payload; its
  // work-state indicator must not be stuck at "working" here.
  const liveOnlyNavigation = await ui.evaluate(`(() => ({
    loading: !!document.querySelector('.conversation-loading'),
    messages: document.querySelector('.message-stage')?.innerText?.replace(/\\s+/g, ' ').trim() || '',
    composerStatus: document.querySelector('.composer-status')?.textContent?.trim() || '',
  }))()`);
  assert.equal(liveOnlyNavigation.loading, false, 'visible live/stream content must dismiss the loading overlay without a full conversation payload');
  assert.ok(liveOnlyNavigation.messages.includes('Live-only answer'));
  assert.equal(liveOnlyNavigation.composerStatus.includes('加载超时'), false);

  // Unrecognized content contract: a live message with a future/unknown
  // content type and no text must surface as explicit unrecognized content,
  // never as a perpetual "thinking" spinner. This rides the real fetch
  // capture pipeline (message events with structured content), matching how
  // ChatGPT actually delivers non-text messages.
  await top.evaluate(`history.replaceState(history.state, '', '/c/live-only');
    fetch('/backend-api/messages/unknown-content').then((response) => response.json()).catch(() => {});`);
  await waitFor(async () => {
    const state = await ui.evaluate(uiStateExpression());
    return state.messages.includes('官方消息（非文本内容）');
  });
  assert.equal(
    await ui.evaluate(`!!document.querySelector('.message-card .unrecognized-notice')`),
    true,
    'unknown content types must show the explicit unrecognized notice',
  );
  assert.equal(
    await ui.evaluate(`!!document.querySelector('.message-card .unrecognized-notice .thinking-spinner')`),
    false,
    'unrecognized content must not render the thinking spinner',
  );
  await top.evaluate(`history.replaceState(history.state, '', '/c/live-only')`);

  await top.evaluate(`(() => {
    const article = document.createElement('article');
    article.setAttribute('data-message-id', 'dom-stream-a2');
    const content = document.createElement('div');
    content.setAttribute('data-message-author-role', 'assistant');
    content.textContent = 'DOM stream one';
    article.appendChild(content);
    document.body.appendChild(article);
  })()`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).messages.includes('DOM stream one'));
  await top.evaluate(`(() => {
    const node = document.querySelector('[data-message-id="dom-stream-a2"] [data-message-author-role="assistant"]');
    if (node?.firstChild) node.firstChild.nodeValue = 'DOM stream two';
  })()`);
  await waitFor(async () => {
    const state = await ui.evaluate(uiStateExpression());
    return state.messages.includes('DOM stream two') && !state.messages.includes('DOM stream one');
  });
  const domRealtime = await ui.evaluate(`document.querySelector('.message-stage')?.innerText?.replace(/\\s+/g, ' ').trim() || ''`);
  assert.ok(domRealtime.includes('DOM stream two'), 'official character-data streaming mutations must update SlimGPT without polling');

  await top.evaluate(`(() => {
    const article = document.createElement('article');
    article.setAttribute('data-message-id', 'late-dom-before-switch');
    const content = document.createElement('div');
    content.setAttribute('data-message-author-role', 'assistant');
    content.textContent = 'Late live-only DOM answer';
    article.appendChild(content);
    document.body.appendChild(article);
  })()`);
  await ui.evaluate(`[...document.querySelectorAll('.conversation-item')]
    .find((button) => button.textContent.includes('Fixture conversation'))?.click()`);
  await waitFor(async () => {
    const url = await top.evaluate('location.href');
    return new URL(url).pathname === '/c/smoke';
  });
  const conversationNavigation = await top.evaluate('location.href');
  assert.equal(await top.evaluate('window.__slimgptNavigationDocumentToken'), navigationDocumentToken, 'cached conversation switches must also stay in-document');
  await sleep(450);
  const restoredSmokeState = await ui.evaluate(uiStateExpression());
  assert.equal(restoredSmokeState.draft, '', 'a conversation without a draft must remain empty after switching back');
  assert.equal(restoredSmokeState.messages.includes('Late live-only DOM answer'), false, 'DOM mutations queued before navigation must retain their source conversation');
  assert.ok(restoredSmokeState.messages.includes('Scoped stale smoke answer'), 'late scoped content must remain owned by its source conversation');
  assert.ok(restoredSmokeState.messages.includes('Delayed smoke-only answer'), 'request-scoped content must remain available in its source conversation');
  assert.equal(restoredSmokeState.messages.includes('Ambiguous stale answer'), false);
  assert.equal(restoredSmokeState.messages.includes('Conflicting stale answer'), false);

  await top.evaluate(`fetch('/backend-api/messages/smoke-partial').then((response) => response.json())`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).overviewItems === 61);
  await ui.evaluate(`document.querySelector('[data-overview-index="0"]')?.click()`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).messages.includes('Fixture user message 1'));
  const historyAfterPartial = await ui.evaluate(uiStateExpression());
  assert.equal(historyAfterPartial.overviewItems, 61, 'a short optimized payload must append to, not replace, cached history');
  assert.ok(historyAfterPartial.messages.includes('Fixture user message 1'), 'oldest cached turns must remain reachable after a short payload arrives');
  await ui.evaluate(`document.querySelector('[data-overview-index="60"]')?.click()`);
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).messages.includes('Partial tail answer'));

  const resumed = new Promise((resolve) => {
    fixture.onResumeRequest = (count) => {
      if (count >= 2) resolve(count);
    };
  });
  const officialResumeBody = await top.evaluate(`fetch('/backend-api/f/conversation/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversation_id: 'smoke', offset: 0 }),
  }).then((response) => response.text())`);
  assert.equal(officialResumeBody, 'data: [DONE]\n\n', 'takeover must stop the official resume parser after cloning its stream');
  const resumeReconnectCount = await Promise.race([
    resumed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('resume reconnect timeout')), 10_000)),
  ]);
  delete fixture.onResumeRequest;
  assert.equal(resumeReconnectCount, 2, 'an interrupted resume stream must reconnect exactly once before [DONE]');
  await waitFor(async () => (await ui.evaluate(uiStateExpression())).messages.includes('Diverted resume answer'));

  await ui.evaluate(`document.querySelector('.new-chat')?.click()`);
  await waitFor(async () => (await top.evaluate('location.pathname')) === '/');
  const newChatNavigation = {
    token: await top.evaluate('window.__slimgptNavigationDocumentToken || null'),
    top: await top.evaluate(topStateExpression()),
    empty: await ui.evaluate(`!!document.querySelector('.empty-state')`),
  };
  assert.equal(newChatNavigation.token, navigationDocumentToken, 'new-chat navigation must preserve the host document');
  assert.equal(newChatNavigation.top.frameVisible, true, 'new-chat navigation must keep the takeover visible');
  assert.equal(newChatNavigation.empty, true, 'new-chat navigation should switch the right pane without a page flash');

  await top.evaluate(`fetch('/backend-api/conversation/second').then((response) => response.json())`);
  await sleep(150);
  const backgroundCaptureOnNewChat = await ui.evaluate(uiStateExpression());
  assert.equal(backgroundCaptureOnNewChat.title, '新对话', 'a background conversation payload must not hijack the new-chat route');
  assert.equal(backgroundCaptureOnNewChat.messages.includes('Second answer'), false, 'background payload content must stay in its own cache');

  await sleep(250);
  const resizeObserverErrors = await ui.evaluate(`window.__slimgptWindowErrors.filter((message) => /ResizeObserver loop/i.test(message))`);
  assert.deepEqual(resizeObserverErrors, [], 'turn-paged message rendering must not trigger ResizeObserver loop errors');

  return {
    mode: 'fixture',
    chrome: await chromeVersion(),
    extensionId,
    failOpen,
    blockedByModal,
    canonicalUi,
    mobileUi,
    sendSuccess,
    sendFailure,
    official,
    restored,
    navigationLoading,
    liveOnlyNavigation,
    wideLayout,
    mobileDrawers: true,
    composerLayout,
    composerExpanded,
    composerOverflow,
    markdownExport: {
      filename: markdownExport.filename,
      bytes: markdownExport.content.length,
    },
    conversationNavigation,
    newChatNavigation,
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
      const expect = process.env.SLIMGPT_LIVE_EXPECT || 'OK';
      await ui.evaluate(fillAndSubmitExpression(prompt));
      await waitFor(async () => (await ui.evaluate(uiStateExpression())).composerStatus === '消息已发送（官方已确认）', 10_000);
      await waitFor(async () => (await ui.evaluate(uiStateExpression())).assistant.includes(expect), 45_000);
      // Execution-state contract: stop only after a direct page/server
      // lifecycle observation says the turn is no longer running.
      await waitFor(async () => (await ui.evaluate(uiStateExpression())).sidebarWorkState === 'stopped', 45_000);
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
  } else if (url.includes('/backend-api/f/conversation/resume')) {
    fixture.resumeRequests = (fixture.resumeRequests || 0) + 1;
    body = fixture.resumeRequests === 1
      ? fixture.resume.replace(/\ndata: \[DONE\]\n\n$/, '')
      : fixture.resume;
    fixture.onResumeRequest?.(fixture.resumeRequests);
    contentType = 'text/event-stream; charset=utf-8';
  } else if (new URL(url).pathname === '/backend-api/f/conversation') {
    await sleep(650);
    body = JSON.stringify(fixture.delayedScopedEvent);
    contentType = 'application/json; charset=utf-8';
  } else if (new URL(url).pathname === '/backend-api/me') {
    body = JSON.stringify({ id: 'fixture-user' });
    contentType = 'application/json; charset=utf-8';
  } else if (url.includes('/backend-api/conversations')) {
    fixture.conversationListRequests = (fixture.conversationListRequests || 0) + 1;
    body = JSON.stringify(fixture.list);
    contentType = 'application/json; charset=utf-8';
  } else if (url.includes('/backend-api/conversation/second')) {
    body = JSON.stringify(fixture.secondConversation);
    contentType = 'application/json; charset=utf-8';
    } else if (url.includes('/backend-api/messages/smoke-partial')) {
      body = JSON.stringify(fixture.smokePartialConversation);
      contentType = 'application/json; charset=utf-8';
    } else if (url.includes('/backend-api/messages/misleading-terminal')) {
      body = JSON.stringify(fixture.misleadingTerminalEvent);
      contentType = 'application/json; charset=utf-8';
    } else if (url.includes('/backend-api/messages/stale-running')) {
      body = JSON.stringify(fixture.staleRunningEvent);
      contentType = 'application/json; charset=utf-8';
    } else if (url.includes('/backend-api/messages/live-only')) {
      body = JSON.stringify(fixture.liveOnlyEvent);
      contentType = 'application/json; charset=utf-8';
    } else if (url.includes('/backend-api/messages/unknown-content')) {
      body = JSON.stringify(fixture.unknownContentEvent);
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
    const content = index === 1
      ? `Fixture assistant message 2\n\n${Array.from({ length: 90 }, (_, line) => `Long answer line ${line + 1}: ${'detail '.repeat(12)}`).join('\n')}`
      : index === 119
      ? 'Fixture answer <img src=x onerror="window.__slimgptXss=1">\n\n```js\nconst value = "ok";\n```\n\nInline math $E=mc^2$.'
      : `Fixture ${role} message ${index + 1}`;
    mapping[parent].children.push(id);
    mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        id,
        author: { role },
        content: { parts: [content] },
        metadata: index === 119 ? { model_slug: 'gpt-5' } : {},
      },
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
  const secondConversation = {
    id: 'second',
    title: 'Second conversation',
    current_node: 'second-a1',
    create_time: 3,
    update_time: 4,
    mapping: {
      root: { id: 'root', parent: null, children: ['second-u1'] },
      'second-u1': {
        id: 'second-u1',
        parent: 'root',
        children: ['second-thinking'],
        message: { id: 'second-u1', author: { role: 'user' }, content: { parts: ['Second question'] } },
      },
      'second-thinking': {
        id: 'second-thinking',
        parent: 'second-u1',
        children: ['second-call'],
        message: {
          id: 'second-thinking',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: [] },
          status: 'in_progress',
          end_turn: false,
        },
      },
      'second-call': {
        id: 'second-call',
        parent: 'second-thinking',
        children: ['second-tool'],
        message: {
          id: 'second-call',
          author: { role: 'assistant' },
          recipient: 'web.run',
          content: {
            content_type: 'code',
            language: 'json',
            text: '{"query":"SlimGPT","options":{"limit":3,"exact":true}}',
          },
        },
      },
      'second-tool': {
        id: 'second-tool',
        parent: 'second-call',
        children: ['second-a1'],
        message: {
          id: 'second-tool',
          author: { role: 'tool', name: 'web.run' },
          content: {
            content_type: 'text',
            parts: ['{"ok":true,"items":[{"title":"One","score":0.9}],"next":null}'],
          },
        },
      },
      'second-a1': {
        id: 'second-a1',
        parent: 'second-tool',
        children: [],
        message: { id: 'second-a1', author: { role: 'assistant' }, content: { parts: ['Second answer'] } },
      },
    },
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
    list: { items: [
      { id: 'live-only', title: 'Live only conversation', update_time: 5 },
      { id: 'second', title: 'Second conversation', update_time: 4 },
      { id: 'smoke', title: 'Fixture conversation', update_time: 2, secret: 'INDEX_SECRET_MUST_NOT_PERSIST' },
    ] },
    conversation,
    secondConversation,
    delayedScopedEvent: {
      message: {
        id: 'delayed-smoke-a1',
        author: { role: 'assistant' },
        content: { parts: ['Delayed smoke-only answer'] },
        status: 'finished_successfully',
        end_turn: true,
      },
    },
    liveOnlyEvent: {
      conversation_id: 'live-only',
      message: {
        id: 'live-only-a1',
        author: { role: 'assistant' },
        content: { parts: ['Live-only answer'] },
        create_time: 5,
      },
    },
    smokePartialConversation: {
      id: 'smoke',
      conversation_id: 'smoke',
      title: 'Fixture conversation',
      current_node: 'smoke-partial-a1',
      messages: [
        {
          id: 'smoke-partial-u1',
          author: { role: 'user' },
          content: { parts: ['Partial tail question'] },
          status: 'finished_successfully',
          end_turn: true,
        },
        {
          id: 'smoke-partial-a1',
          author: { role: 'assistant' },
          content: { parts: ['Partial tail answer'] },
          status: 'finished_successfully',
          end_turn: true,
        },
      ],
    },
    misleadingTerminalEvent: {
      conversation_id: 'mobile-smoke',
      message: {
        id: 'misleading-terminal-a1',
        author: { role: 'assistant' },
        content: { parts: ['Intermediate terminal-looking message'] },
        status: 'finished_successfully',
        end_turn: true,
        create_time: 5.5,
      },
    },
    staleRunningEvent: {
      conversation_id: 'mobile-smoke',
      message: {
        id: 'stale-running-a1',
        author: { role: 'assistant' },
        content: { parts: ['Late stale in-progress message'] },
        status: 'in_progress',
        end_turn: false,
        create_time: 5.6,
      },
    },
    unknownContentEvent: {
      conversation_id: 'live-only',
      message: {
        id: 'unknown-content-a1',
        author: { role: 'assistant' },
        content: { content_type: 'unknown_future_type', parts: [''] },
        status: 'in_progress',
        end_turn: false,
        create_time: 6,
      },
    },
    resume: `data: ${JSON.stringify({
      message: {
        id: 'resume-a1',
        author: { role: 'assistant' },
        content: { parts: ['Diverted resume answer'] },
        status: 'finished_successfully',
        end_turn: true,
      },
    })}\n\ndata: [DONE]\n\n`,
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
    textarea.__reactProps$fixture = {};
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
      const message = document.createElement('div');
      message.setAttribute('data-message-id', 'fixture-submitted-user');
      const content = document.createElement('div');
      content.setAttribute('data-message-author-role', 'user');
      content.textContent = textarea.value;
      message.appendChild(content);
      document.body.appendChild(message);
      textarea.value = '';
      button.hidden = true;
      let stop = form.querySelector('[data-testid="stop-button"]');
      if (!stop) {
        stop = document.createElement('button');
        stop.type = 'button';
        stop.setAttribute('data-testid', 'stop-button');
        stop.setAttribute('aria-label', 'Stop generating');
        stop.textContent = 'Stop generating';
        stop.style.cssText = 'display:block;width:100px;height:40px';
        form.appendChild(stop);
      }
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
    frameVisible: document.getElementById('slimgpt-takeover-frame')?.dataset.slimgptVisible === '1',
    frameOpacity: document.getElementById('slimgpt-takeover-frame')?.style.opacity || '',
    framePointerEvents: document.getElementById('slimgpt-takeover-frame')?.style.pointerEvents || '',
    restore: !!document.getElementById('slimgpt-restore-button'),
    sleep: document.documentElement.getAttribute('data-slimgpt-render-sleep'),
    bodyDisplay: document.body ? getComputedStyle(document.body).display : '',
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
    mathNodes: document.querySelectorAll('.message-markdown .katex').length,
    unsafeNodes: document.querySelectorAll('.message-markdown img, .message-markdown script, .message-markdown iframe').length,
    mountedCards: document.querySelectorAll('.message-card').length,
    loading: !!document.querySelector('.conversation-loading'),
    overviewItems: document.querySelectorAll('.overview-item').length,
    activeOverview: document.querySelector('.overview-item.active .overview-number')?.textContent?.trim() || '',
    modelLabel: document.querySelector('.conversation-item.active .conversation-model')?.textContent?.trim() || '',
    historyPreview: document.querySelector('.conversation-item.active .conversation-preview')?.textContent?.trim() || '',
    conversations: document.querySelectorAll('.conversation-item').length,
    workIndicator: document.querySelector('.work-indicator')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
    sidebarWorkState: document.querySelector('.conversation-work-state')?.dataset?.state || '',
    sidebarWorkLabel: document.querySelector('.conversation-work-state')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
    thinkingActiveLevel: document.querySelector('.thinking-segmented [aria-checked="true"]')?.getAttribute('data-thinking-level') || ''
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
