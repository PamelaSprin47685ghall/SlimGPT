// Browser half of scripts/stream-bench.mjs: replays a real (sanitized) SSE
// through the production store + App in Chromium at a realistic rate and
// measures what the reader sees. Not part of the test suite.
import { mount, unmount, tick } from 'svelte';
import App from '../../src/ui/App.svelte';
import { createStore } from '../../src/ui/state.svelte.js';
import * as P from '../../src/protocol/index.js';
import sse from '../fixtures/protocol/streams/har-regenerate-after-stop.sse?raw';
import afterStop from '../fixtures/protocol/har-history-after-stop.json?raw';
import afterRegen from '../fixtures/protocol/har-history-after-regenerate.json?raw';

const CONV = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const params = new URLSearchParams(location.search);
const INTERVAL = Number(params.get('interval') || 60);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())));
const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0).toFixed(2);
  return { n: values.length, mean: +(values.reduce((a, b) => a + b, 0) / (values.length || 1)).toFixed(2), p50: pick(0.5), p95: pick(0.95), max: pick(1) };
};

/** History with `turns` earlier turns before the fixture question. */
function history(turns) {
  if (!turns) return afterStop;
  const base = JSON.parse(afterStop);
  const mapping = {};
  let parent = null;
  let time = 1792300000;
  const add = (id, role, text) => {
    mapping[id] = { id, parent, children: [], message: { id, author: { role }, create_time: time++, status: 'finished_successfully', end_turn: role === 'assistant', recipient: 'all', content: { content_type: 'text', parts: [text] }, metadata: {} } };
    if (parent) mapping[parent].children.push(id);
    parent = id;
  };
  for (let i = 0; i < turns; i++) {
    add(`10000000-0000-4000-8000-${String(2 * i).padStart(12, '0')}`, 'user', `问题 ${i}`);
    add(`10000000-0000-4000-8000-${String(2 * i + 1).padStart(12, '0')}`, 'assistant', `## 回答 ${i}\n\n${'一些文字，**加粗**、`code` 和 $x^2$。\n\n'.repeat(12)}\`\`\`js\nconsole.log(${i});\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`);
  }
  const question = base.messages.find((message) => message.id === USER);
  add(USER, 'user', question?.content?.parts?.[0] || '问题');
  return JSON.stringify({ conversation_id: CONV, title: base.title, current_node: USER, mapping });
}

let report;
async function scenario(turns, listSize = 300) {
  let push;
  const store = createStore({
    protocol: P,
    bridgeFactory: ({ onMessage }) => {
      push = (type, fields = {}) => onMessage({ type, ...fields });
      let n = 0;
      return { connected: true, send: () => true, nextId: (p) => `${p}-${++n}`, storageGet: async () => ({}), storageSet: async () => ({}), destroy() {} };
    },
  });
  const target = document.createElement('div');
  target.style.height = '800px';
  document.body.append(target);
  const app = mount(App, { target, props: { store } });
  await tick();
  push('hello', { ready: true, loggedIn: true, auth: 'user' });
  // A realistic sidebar: 300 conversations.
  const items = [{ id: CONV, title: 't' }];
  for (let i = 0; i < listSize - 1; i++) items.push({ id: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`, title: `对话 ${i}` });
  push('conversation-list', { body: JSON.stringify({ items }), offset: 0, complete: true });
  push('location', { conversationId: CONV, url: `https://chatgpt.com/c/${CONV}` });
  store.dispatch({ type: 'open', conversationId: CONV });
  const t = performance.now();
  push('conversation', { conversationId: CONV, body: history(turns), page: 1, pages: 1 });
  await tick();
  const openMs = (await frame()) - t;
  const expected = turns + 1;
  for (let i = 0; i < 400 && target.querySelectorAll('.turn').length < expected; i++) await frame();
  const openCompleteMs = performance.now() - t;
  await sleep(300);

  if (params.get('probe')) {
    const noop = [];
    const rounds = params.get('probe') === 'long' ? 600 : 30;
    if (rounds > 30) await sleep(1500);
    for (let i = 0; i < rounds; i++) { const a = performance.now(); push('takeover', { visible: false, reason: 'ready' }); await tick(); noop.push(performance.now() - a); }
    const draft = [];
    for (let i = 0; i < 30; i++) { const a = performance.now(); store.dispatch({ type: 'draft', text: `x${i}` }); await tick(); draft.push(performance.now() - a); }
    report.probe = { ...(report.probe || {}), [`turns${turns}-list${listSize}`]: { noop: stats(noop), draft: stats(draft) } };
  }
  const answerText = () => {
    const msgs = target.querySelectorAll('.msg[data-role="assistant"]');
    return msgs[msgs.length - 1]?.querySelector('.msg-body')?.textContent || '';
  };
  const events = sse.split(/(?<=\n\n)/);
  push('stream-start', { streamId: 's', conversationId: CONV, userMessageId: null, parentMessageId: USER, resume: false, format: 'sse' });
  const script = [];
  const toFrame = [];
  let firstText = null;
  let idleMs = null;
  let longTasks = 0;
  const observer = new PerformanceObserver((list) => { longTasks += list.getEntries().length; });
  try { observer.observe({ type: 'longtask' }); } catch { /* unsupported */ }
  for (const chunk of events) {
    const before = answerText().length;
    const t0 = performance.now();
    push('stream-chunk', { streamId: 's', chunk });
    await tick();
    const t1 = performance.now();
    const t2 = await frame();
    script.push(t1 - t0);
    toFrame.push(t2 - t0);
    if (firstText === null && answerText().length > before && /[\u4e00-\u9fff]/.test(answerText())) firstText = { scriptMs: +(t1 - t0).toFixed(2), frameMs: +(t2 - t0).toFixed(2) };
    if (chunk.includes('data: [DONE]')) {
      idleMs = target.querySelector('.composer .button.stop') ? null : +(t1 - t0).toFixed(2);
      if (idleMs === null) {
        const start = t0;
        for (let i = 0; i < 200 && target.querySelector('.composer .button.stop'); i++) await sleep(5);
        idleMs = +(performance.now() - start).toFixed(2);
      }
    }
    await sleep(INTERVAL);
  }
  push('stream-end', { streamId: 's', ok: true });
  await tick();
  // The canonical refresh after [DONE].
  const r0 = performance.now();
  push('conversation', { conversationId: CONV, body: afterRegen, page: 1, pages: 1 });
  await tick();
  const refreshMs = (await frame()) - r0;
  observer.disconnect();
  const result = {
    turns, listSize, chunks: events.length, interval: INTERVAL, openFirstFrameMs: +openMs.toFixed(2), openCompleteMs: +openCompleteMs.toFixed(2), perChunkScriptMs: stats(script), perChunkToFrameMs: stats(toFrame),
    firstText, doneToIdleMs: idleMs, refreshMs: +refreshMs.toFixed(2), longTasks, renderedChars: answerText().length,
  };
  unmount(app);
  target.remove();
  return result;
}

async function postMessageHop() {
  const frameEl = document.createElement('iframe');
  frameEl.srcdoc = '<script>addEventListener("message",(e)=>{parent.__hop.push(performance.timeOrigin+performance.now()-e.data.at)})<\/script>';
  window.__hop = [];
  document.body.append(frameEl);
  await new Promise((resolve) => frameEl.addEventListener('load', resolve, { once: true }));
  for (let i = 0; i < 100; i++) {
    frameEl.contentWindow.postMessage({ at: performance.timeOrigin + performance.now(), chunk: sse.slice(0, 400) }, '*');
    await sleep(5);
  }
  await sleep(50);
  frameEl.remove();
  return stats(window.__hop);
}

(async () => {
  report = { userAgent: navigator.userAgent, scenarios: [] };
  try {
    report.postMessageHopMs = await postMessageHop();
    for (const turns of [0, 100, 300]) report.scenarios.push(await scenario(turns));
    if (params.get('probe')) report.scenarios.push(await scenario(0, 1));
  } catch (error) {
    report.error = String(error?.stack || error);
  }
  await fetch('/report', { method: 'POST', body: JSON.stringify(report) });
})();
