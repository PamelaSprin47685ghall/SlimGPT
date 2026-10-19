// Runs in a real, clean Chromium page (see scripts/markdown-smoke.mjs).
// Covers the production Markdown renderer of the new UI (src/ui/markdown),
// the block components and an end-to-end App flow over a fake bridge.
import { mount, unmount, tick, flushSync } from 'svelte';
import { createMarkdownRenderer } from '../../src/ui/markdown/renderer.js';
import { injectCitations } from '../../src/ui/markdown/citations.js';
import Message from '../../src/ui/components/Message.svelte';
import Block from '../../src/ui/components/blocks/Block.svelte';
import App from '../../src/ui/App.svelte';
import { createStore } from '../../src/ui/state.svelte.js';
import { createFakeProtocol, canonical } from '../ui/fake-protocol.js';
import * as RealProtocol from '../../src/protocol/index.js';
import messageFixtures from '../fixtures/protocol/messages.json';

const results = [];
const scenario = new URLSearchParams(location.search).get('scenario') || 'normal';
function equal(actual, expected, detail = '') {
  if (actual !== expected) throw new Error(`${detail}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(value, detail) { if (!value) throw new Error(detail); }
function render(text, cuts = [], final = true, citations) {
  const root = document.createElement('div');
  document.body.append(root);
  const renderer = createMarkdownRenderer(root);
  for (const cut of cuts) renderer.update(text.slice(0, cut), { citations });
  renderer.update(text, { final, citations });
  return { root, renderer };
}
const cleanups = [];
async function test(name, check) {
  try { await check(); results.push({ name: `[${scenario}] ${name}`, passed: true }); }
  catch (error) { results.push({ name: `[${scenario}] ${name}`, passed: false, error: String(error?.message || error) }); }
  while (cleanups.length) { try { await cleanups.pop()(); } catch { /* ignore */ } }
  for (const node of [...document.body.children]) if (node.id !== 'result' && node.tagName !== 'SCRIPT') node.remove();
}
async function waitFor(check, detail = 'Browser condition timed out') {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (check()) return;
    await new Promise((accept) => setTimeout(accept, 20));
  }
  throw new Error(detail);
}
function mockClipboard() {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const box = { copied: null };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { box.copied = value; } } });
  cleanups.push(() => { if (previous) Object.defineProperty(navigator, 'clipboard', previous); else delete navigator.clipboard; });
  return box;
}
function mountWith(component, props, dispatched = []) {
  const target = document.createElement('div');
  document.body.append(target);
  const protocol = createFakeProtocol();
  const instance = mount(component, { target, props, context: new Map([['slimgpt', { protocol, dispatch: (action) => dispatched.push(action) }]]) });
  cleanups.push(() => unmount(instance));
  flushSync();
  return target;
}
const msg = (fields) => ({ id: 'm1', parentId: null, role: 'assistant', status: 'done', blocks: [], hidden: false, model: null, createdAt: null, source: 'canonical', ...fields });
const text = (markdown, citations = []) => ({ kind: 'text', markdown, citations });

if (scenario === 'normal') {
  // ------------------------------------------------------------ renderer
  await test('unfinished fenced code is finalized with a copy button and exact code', () => {
    const { root } = render('```python\nprint("中文")');
    equal(root.querySelectorAll('.code-copy-btn').length, 1);
    equal(root.querySelector('pre code')?.textContent, 'print("中文")');
  });
  await test('closed code fences never lose or add a source newline', () => {
    for (const body of ['one\ntwo\n', 'one\n\n', '  中文\n']) {
      const { root } = render(`\`\`\`text\n${body}\`\`\``);
      equal(root.querySelector('pre code')?.textContent, body);
      equal(root.querySelectorAll('.code-copy-btn').length, 1);
    }
  });
  await test('unfinished inline tokens keep literal trailing bytes', () => {
    for (const value of ['hello *', 'hello **', 'hello `', 'hello [', 'hello \\', 'hello &']) equal(render(value).root.textContent, value, value);
  });
  await test('unfinished inline formatting cannot swallow neighboring literal characters', () => {
    for (const value of ['before **bold', 'before _em', 'before ~~struck', 'before [label', 'before [label](https://example.com', 'before `code', 'before ``two ticks']) {
      equal(render(value).root.textContent, value, value);
    }
  });
  await test('a table ending at EOF has its scroll wrapper and intact cells', () => {
    const { root } = render('| A | B |\n|---|---|\n| 一 | 二 |');
    equal(root.querySelectorAll('.table-wrap').length, 1);
    equal(root.querySelectorAll('td').length, 2);
    equal(root.querySelector('td')?.textContent.trim(), '一');
  });
  await test('one-byte streaming and whole-input rendering give the same DOM', () => {
    for (const value of ['Hello **bold** and *italic*.\n\nSecond.', '- one\n- two\n\nTail', '```js\nconst a = 1;\n```', '| A | B |\n|---|---|\n| 一 | 二 |', '[source](<https://example.com/a(b)> "Title")']) {
      const whole = render(value).root.innerHTML;
      const streamed = render(value, Array.from({ length: value.length }, (_, i) => i + 1)).root.innerHTML;
      equal(streamed, whole, value);
    }
  });
  await test('a suffix update retains the existing paragraph nodes (selection stays stable)', () => {
    const { root, renderer } = render('First paragraph.\n\nSecond', [], false);
    const first = root.querySelector('p');
    renderer.update('First paragraph.\n\nSecond continues.', { final: true });
    equal(root.querySelector('p'), first);
    equal(root.querySelectorAll('p').length, 2);
  });
  await test('replacement and deletion remove stale markup without duplicating controls', () => {
    const { root, renderer } = render('```js\nold\n```');
    renderer.update('```js\nnew\n```', { final: true });
    equal(root.querySelectorAll('.code-copy-btn').length, 1);
    ok(!root.textContent.includes('old'), 'old code survived correction');
    renderer.update('', { final: true });
    equal(root.textContent, '');
    equal(root.children.length, 0);
  });
  await test('image alternative text is an attribute, not an invisible child of img', () => {
    const { root } = render('![图像描述](https://example.invalid/a.png "Title")');
    equal(root.querySelector('img')?.alt, '图像描述');
    equal(root.querySelector('img')?.title, 'Title');
    equal(root.querySelector('img')?.childNodes.length, 0);
  });
  await test('rejected image destinations keep their description', () => {
    const { root } = render('![保留图片说明](javascript:alert)');
    equal(root.querySelector('img'), null);
    ok(root.textContent.includes('保留图片说明'), 'description disappeared with blocked image');
  });
  await test('unsafe links lose their href but keep their text', () => {
    const { root } = render('[点我](javascript:alert(1)) and [ok](https://example.com)');
    const [bad, good] = root.querySelectorAll('a');
    equal(bad.getAttribute('href'), null);
    equal(bad.textContent, '点我');
    equal(good.getAttribute('href'), 'https://example.com/');
    equal(good.target, '_blank');
  });
  await test('HTML-like source stays inert and images cannot execute event handlers', () => {
    const { root } = render('<script>window.__markdownInjected = true</script>\n\n<img src=x onerror="window.__markdownInjected=true">');
    equal(window.__markdownInjected, undefined);
    equal(root.querySelector('script, [onerror]'), null);
  });
  await test('CRLF code is normalized to LF without leaking CR characters', () => {
    const { root } = render('```text\r\none\r\ntwo\r\n```', [1, 2, 9, 10, 11]);
    equal(root.querySelector('pre code')?.textContent, 'one\ntwo\n');
  });
  await test('stopping inside a formula preserves its literal delimiters', () => {
    for (const value of ['Formula $x + y', 'Formula \\(x+y', '$$\nx + y', '\\[\nx + y']) equal(render(value).root.textContent, value, value);
  });
  await test('unfinished code preserves a genuine trailing newline but never an EOF sentinel', () => {
    for (const body of ['', 'abc', 'abc\n', 'abc\n\n', '`', '\\', '<>&']) {
      equal(render(`\`\`\`text\n${body}`).root.querySelector('pre code')?.textContent, body, body);
    }
  });
  await test('code copying is invariant under every transport split including CRLF boundaries', () => {
    const value = '```js\r\n  const x = "中文🧪";\r\n\r\n```';
    for (let cut = 0; cut <= value.length; cut++) {
      equal(render(value, [cut]).root.querySelector('pre code')?.textContent, '  const x = "中文🧪";\n\n', `split ${cut}`);
    }
  });
  await test('finalization is idempotent and a resumed partial span can later close normally', () => {
    const { root, renderer } = render('```js\nhello');
    renderer.update('```js\nhello', { final: true });
    equal(root.querySelectorAll('.code-copy-btn').length, 1);
    renderer.update('```js\nhello world\n```', { final: true });
    equal(root.querySelectorAll('.code-copy-btn').length, 1);
    equal(root.querySelector('pre code')?.textContent, 'hello world\n');
  });
  await test('completed code is keyboard-focusable and labelled', () => {
    const { root } = render('```text\nscrollable\n```');
    const pre = root.querySelector('pre');
    equal(pre.tabIndex, 0);
    pre.focus();
    equal(document.activeElement, pre);
    equal(pre.getAttribute('role'), 'region');
    equal(root.querySelector('.code-copy-btn')?.getAttribute('aria-live'), 'polite');
  });
  await test('code is highlighted by highlight.js after lazy load without changing its text', async () => {
    const source = 'const answer = "中文<&>"; // note\n';
    const { root } = render(`\`\`\`javascript\n${source}\`\`\``);
    const code = root.querySelector('pre code');
    await waitFor(() => code.classList.contains('hljs'), 'highlight.js never applied');
    ok(code.querySelector('.hljs-keyword, .hljs-string'), 'no highlight spans');
    equal(code.textContent, source);
    equal(root.querySelector('.code-lang')?.textContent, 'javascript');
  });
  await test('large code skips highlighting but retains every source character', async () => {
    const body = 'const x = "中文<&>";\n'.repeat(18_000);
    const { root } = render(`\`\`\`javascript\n${body}\`\`\``);
    await new Promise((accept) => setTimeout(accept, 100));
    equal(root.querySelector('pre code')?.textContent, body);
    equal(root.querySelectorAll('.hljs, [class^="hljs-"]').length, 0);
  });
  await test('the code copy button copies the exact source and reports success', async () => {
    const clip = mockClipboard();
    const { root } = render('```py\nprint(1)\n\n```');
    root.querySelector('.code-copy-btn').click();
    await waitFor(() => root.querySelector('.code-copy-btn.copied'));
    equal(clip.copied, 'print(1)\n\n');
    equal(root.querySelector('.code-copy-btn').textContent, '已复制');
  });
  await test('failed image loads keep alternative text visible without retrying the URL', () => {
    const { root } = render('![Photo description](https://example.invalid/image.png)');
    root.querySelector('img').dispatchEvent(new Event('error'));
    equal(root.querySelector('img'), null);
    ok(root.textContent.includes('Photo description'), 'failed load hid the description');
  });
  await test('finished inline math renders through the lazily loaded KaTeX module', async () => {
    const { root } = render('Formula \\(x^2 + y^2\\) end.');
    await waitFor(() => root.querySelector('.katex'), 'KaTeX did not render');
    equal(root.querySelector('annotation')?.textContent, 'x^2 + y^2');
    ok(root.textContent.endsWith(' end.'), 'math swallowed the trailing sentence');
  });
  await test('late math rendering after a correction cannot resurrect an obsolete equation', async () => {
    const { root, renderer } = render('\\(old + x\\)');
    renderer.update('replacement without math', { final: true });
    await new Promise((accept) => setTimeout(accept, 60));
    equal(root.querySelector('.katex'), null);
    equal(root.textContent, 'replacement without math');
  });

  // ------------------------------------------------------------ citations
  await test('citations render as numbered superscript links at the span end', () => {
    const { source, groups } = injectCitations('Alpha is first. Beta.', [
      { start: 0, end: 15, sources: [{ url: 'https://a.example/x', title: 'A 来源' }] },
      { start: 16, end: 21, sources: [{ url: 'https://b.example/', title: '' }, { url: 'https://a.example/x', title: 'A 来源' }] },
    ]);
    const { root } = render(source, [], true, groups);
    const sups = root.querySelectorAll('p > sup.cite');
    equal(sups.length, 2);
    equal([...sups].map((sup) => sup.textContent).join('|'), '1|21');
    equal(sups[0].querySelector('a').href, 'https://a.example/x');
    equal(sups[0].querySelector('a').title, 'A 来源 (a.example)');
    equal(root.querySelector('p').textContent.replace(/\d/g, ''), 'Alpha is first. Beta.');
    ok(!/[\uF000-\uF8FF]/.test(root.textContent), 'sentinel leaked');
  });
  await test('streamed citations equal whole rendering and never enter code', () => {
    const value = '- item one\n- item two\n\n```js\nx = 1\n```\n';
    const { source, groups } = injectCitations(value, [
      { start: 2, end: 10, sources: [{ url: 'https://a.example/', title: 'A' }] },
      { start: 26, end: 31, sources: [{ url: 'https://b.example/', title: 'B' }] },
    ]);
    const whole = render(source, [], true, groups).root;
    const streamed = render(source, Array.from({ length: source.length }, (_, i) => i + 1), true, groups).root;
    equal(streamed.innerHTML, whole.innerHTML);
    equal(whole.querySelector('li sup.cite a')?.textContent, '1');
    equal(whole.querySelector('pre code').textContent, 'x = 1\n');
  });

  // ------------------------------------------------------------ components
  await test('text message: streaming has no copy; finished copy uses messageToPlainText', async () => {
    const clip = mockClipboard();
    const target = mountWith(Message, { message: msg({ status: 'streaming', blocks: [text('Hello **wor')] }) });
    equal(target.querySelector('.msg-actions'), null);
    ok(target.textContent.includes('Hello'), 'streaming text not shown');
    const done = mountWith(Message, { message: msg({ blocks: [text('Hello **world**')] }) });
    equal(done.querySelector('strong')?.textContent, 'world');
    const copy = done.querySelector('.msg-actions .button.copy');
    equal(copy.textContent.trim(), '复制');
    copy.click();
    await waitFor(() => clip.copied !== null);
    equal(clip.copied, 'Hello **world**');
  });
  await test('error status and error blocks are styled alerts', () => {
    const a = mountWith(Message, { message: msg({ status: 'error', blocks: [] }) });
    equal(a.querySelector('[role="alert"].block-error')?.textContent, '消息生成失败或被官方界面中断');
    const b = mountWith(Message, { message: msg({ status: 'error', blocks: [{ kind: 'error', message: '服务器错误' }] }) });
    equal(b.querySelectorAll('.block-error').length, 1);
    equal(b.querySelector('.block-error').textContent, '服务器错误');
  });
  await test('tool call and result are collapsed cards with pretty JSON and raw copy', async () => {
    const clip = mockClipboard();
    const raw = '{"query":"天气","n":1}';
    const target = mountWith(Block, { block: { kind: 'tool_call', tool: 'web.run', callId: 'c1', input: raw, language: null } });
    const details = target.querySelector('details.tool');
    equal(details.open, false);
    equal(target.querySelector('pre'), null, 'collapsed body is not rendered');
    equal(target.querySelector('summary').textContent, '工具调用web.run');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    flushSync();
    equal(target.querySelector('pre code').textContent, JSON.stringify(JSON.parse(raw), null, 2));
    target.querySelector('.code-copy-btn').click();
    await waitFor(() => clip.copied !== null);
    equal(clip.copied, raw);
    const failed = mountWith(Block, { block: { kind: 'tool_result', tool: 'python', callId: 'c1', output: 'Traceback', isError: true } });
    ok(failed.querySelector('details.tool.is-error'), 'error result not marked');
    equal(failed.querySelector('.fold-label').textContent, '工具出错');
  });
  await test('images and audio are neutral media cards, never fake text or URLs', () => {
    const image = mountWith(Block, { block: { kind: 'image', assetPointer: 'file-service://secret', width: 10, height: 20 } });
    const figure = image.querySelector('figure.media-card[data-kind="image"]');
    ok(figure, 'no figure');
    equal(figure.querySelector('figcaption').textContent, '图片 10×20');
    ok(!image.innerHTML.includes('file-service'), 'asset pointer leaked');
    equal(image.querySelector('img'), null);
    const audio = mountWith(Block, { block: { kind: 'file', name: 'voice.wav', size: 2048, mime: 'audio/wav' } });
    equal(audio.querySelector('figure').dataset.kind, 'audio');
    equal(audio.querySelector('figcaption').textContent, '音频 voice.wav · 2.0 KB');
  });
  await test('reasoning and unknown content are collapsed and labelled', () => {
    const reasoning = mountWith(Block, { block: { kind: 'reasoning', markdown: '先想想', summary: '规划', durationSec: 3.2 } });
    equal(reasoning.querySelector('details.reasoning').open, false);
    equal(reasoning.querySelector('.fold-label').textContent, '思考 · 3 秒');
    equal(reasoning.querySelector('.md'), null);
    const unknown = mountWith(Block, { block: { kind: 'unknown', contentType: 'mystery', raw: { a: 1 } } });
    equal(unknown.querySelector('.fold-label').textContent, '暂不支持的内容');
    equal(unknown.querySelector('.fold-hint').textContent, 'mystery');
  });
  await test('interrupted reply offers 继续生成 only when allowed and dispatches continue', () => {
    const message = msg({ id: 'a9', status: 'interrupted', blocks: [text('partial')] });
    const off = mountWith(Message, { message, canContinue: false });
    ok(off.textContent.includes('回答未完成'), 'no interrupted note');
    equal(off.querySelector('.continue'), null, 'continue shown when not allowed');
    const actions = [];
    const on = mountWith(Message, { message, canContinue: true }, actions);
    equal(on.querySelector('.button.continue').textContent.trim(), '继续生成');
    on.querySelector('.button.continue').click();
    equal(JSON.stringify(actions), JSON.stringify([{ type: 'continue', messageId: 'a9' }]));
  });
  await test('branch switcher shows position, dispatches by node and disables while running', () => {
    const actions = [];
    const target = mountWith(Message, { message: msg({ id: 'u5', role: 'user', blocks: [text('q')] }), branch: { index: 1, count: 3, siblingIds: [] } }, actions);
    equal(target.querySelector('.branch-pos').textContent, '2/3');
    target.querySelector('[aria-label="下一分支"]').click();
    target.querySelector('[aria-label="上一分支"]').click();
    equal(JSON.stringify(actions), JSON.stringify([{ type: 'switch-branch', nodeId: 'u5', delta: 1 }, { type: 'switch-branch', nodeId: 'u5', delta: -1 }]));
    const busy = mountWith(Message, { message: msg({ id: 'u5', role: 'user', blocks: [text('q')] }), branch: { index: 1, count: 3, siblingIds: [] }, branchDisabled: true });
    const busyLinks = [...busy.querySelectorAll('.branch .link')];
    ok(busyLinks.length === 2 && busyLinks.every((b) => b.classList.contains('disabled')), 'links enabled while running');
    busyLinks[1].click();
    const single = mountWith(Message, { message: msg({ id: 'u6', role: 'user', blocks: [text('q')] }), branch: { index: 0, count: 1, siblingIds: [] } });
    equal(single.querySelector('.branch'), null);
  });

  // ------------------------------------------------------------ real protocol fixtures
  const realImplemented = (() => { try { RealProtocol.createConversation('probe'); return true; } catch { return false; } })();
  if (realImplemented) {
    await test('every protocol fixture renders through Message without leaking markers or pointers', () => {
      for (const testCase of messageFixtures.cases) {
        const message = RealProtocol.normalizeMessage(testCase.raw, { source: 'canonical' });
        if (!message) continue;
        const target = mountWith(Message, { message });
        const html = target.innerHTML;
        ok(!/[\uE200-\uE2FF\uF000-\uF8FF]/.test(target.textContent), `${testCase.name}: private-use marker leaked`);
        ok(!/sediment:\/\/|file-service:\/\//.test(html), `${testCase.name}: asset pointer leaked`);
        for (const block of message.blocks) {
          const selector = { text: '.md', reasoning: 'details.reasoning', tool_call: 'details.tool', tool_result: 'details.tool', image: 'figure[data-kind="image"]', file: 'figure.media-card', error: '.block-error', unknown: 'details.unknown' }[block.kind];
          ok(target.querySelector(selector), `${testCase.name}: ${block.kind} not rendered`);
        }
        if (message.status === 'error') ok(target.querySelector('[role="alert"]'), `${testCase.name}: error not styled`);
      }
    });
  }

  // ------------------------------------------------------------ app flow
  await test('app (Framework7): panel list, open, status subnavbar, IME-safe Enter send, stop, popover menu', async () => {
    const sent = [];
    let push;
    const protocol = createFakeProtocol();
    const store = createStore({
      protocol,
      bridgeFactory: ({ onMessage }) => {
        push = (type, fields = {}) => { onMessage({ type, ...fields }); flushSync(); };
        let n = 0;
        return { connected: true, send: (type, fields) => { sent.push([type, fields]); return true; }, nextId: (p) => `${p}-${++n}`,
          storageGet: async () => ({ drafts: { c1: '恢复的草稿' } }), storageSet: async () => ({}), destroy() {} };
      },
    });
    const target = document.createElement('div');
    target.style.height = '700px';
    document.body.append(target);
    const app = mount(App, { target, props: { store } });
    cleanups.push(() => unmount(app));
    flushSync();
    await tick();
    ok(target.querySelector('.framework7-root .panel.panel-left'), 'no Framework7 left panel');
    ok(target.querySelector('.view-main .page.chat .navbar'), 'no main view/page/navbar');
    equal(target.querySelector('.status .status-text')?.textContent.trim(), '连接中…');
    ok(target.querySelector('.status .preloader'), 'info status has a preloader');
    ok(target.querySelector('.composer .button.send').classList.contains('disabled'), 'send enabled before bridge');
    push('hello', { ready: true, loggedIn: true });
    equal(target.querySelector('.status'), null, 'status line must disappear when healthy');
    push('conversation-list', { body: JSON.stringify({ items: [{ id: 'c1', title: '第一个' }, { id: 'c2', title: '第二个' }] }), offset: 0, complete: true });
    const conv = () => [...target.querySelectorAll('.conv-list li')];
    equal(conv().map((li) => li.querySelector('.item-title').textContent.trim()).join('|'), '第一个|第二个');
    conv()[0].querySelector('a.item-link').click();
    flushSync();
    equal(JSON.stringify(sent.at(-1)), JSON.stringify(['open', { conversationId: 'c1' }]));
    ok(conv()[0].querySelector('.item-selected'), 'current conversation not selected');
    equal(target.querySelector('.page.chat .navbar .title').textContent.trim(), '第一个');
    equal(target.querySelector('.status .status-text')?.textContent.trim(), '正在同步对话…');
    push('conversation', { conversationId: 'c1', body: canonical('c1', [['u1', null, 'user'], ['a1', 'u1']], 'a1', '第一个'), page: 1, pages: 1 });
    equal(target.querySelectorAll('.msg').length, 2);
    equal(target.querySelector('.msg[data-role="user"] .md').textContent, 'text u1');
    const area = target.querySelector('.composer textarea');
    equal(area.value, '恢复的草稿', 'draft restored from storage');
    area.value = '新问题';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    ok(!sent.some(([type]) => type === 'send'), 'sent while IME composing');
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    const send = sent.find(([type]) => type === 'send');
    ok(send && send[1].text === '新问题', 'Enter did not send');
    push('send-result', { commandId: send[1].commandId, ok: true, error: null });
    equal(area.value, '', 'draft cleared after confirmation');
    push('stream-start', { streamId: 's1', conversationId: 'c1', userMessageId: 'u2', parentMessageId: 'a1', resume: false });
    push('stream-chunk', { streamId: 's1', chunk: JSON.stringify([{ type: 'message', conversationId: 'c1', raw: { id: 'u2', role: 'user', status: 'done' } }, { type: 'message', conversationId: 'c1', raw: { id: 'a2' } }]) });
    equal(target.querySelectorAll('.turn').length, 2);
    equal(conv()[0].querySelector('.item-after')?.textContent.trim(), '生成中', 'running indicator missing');
    const stop = target.querySelector('.composer .button.stop');
    ok(stop, 'stop button missing while streaming');
    stop.click();
    equal(sent.at(-1)[0], 'stop');
    push('stream-end', { streamId: 's1', ok: true });
    equal(JSON.stringify(sent.at(-1)), JSON.stringify(['refresh', { conversationId: 'c1' }]));
    equal(target.querySelector('.composer .button.stop'), null);
    push('conversation-error', { conversationId: 'c1', code: 'network', retryAfterSec: null });
    const status = target.querySelector('.status[data-tone="error"]');
    ok(status, 'sync error not shown');
    status.querySelector('.button').click();
    equal(JSON.stringify(sent.at(-1)), JSON.stringify(['refresh', { conversationId: 'c1' }]));
    const menuItems = [...document.querySelectorAll('.menu-popover .item-link')];
    equal(menuItems.map((a) => a.textContent.trim()).join('|'), '导出 Markdown|显示官方界面');
    ok(target.querySelector('[data-popover=".menu-popover"]'), 'menu link does not open the popover');
    menuItems[1].click();
    flushSync();
    equal(sent.at(-1)[0], 'show-official');
  });
} else {
  // Lazy chunks (highlight.js, KaTeX) fail to load: content must stay intact.
  await test('a highlight.js chunk failure leaves code raw, intact and copyable', async () => {
    const clip = mockClipboard();
    const source = '<script>alert(1)</script>\n  exact whitespace\n';
    const { root } = render(`\`\`\`html\n${source}\`\`\``);
    await new Promise((accept) => setTimeout(accept, 300));
    const code = root.querySelector('pre code');
    equal(code.textContent, source);
    equal(code.classList.contains('hljs'), false);
    equal(root.querySelector('pre script'), null);
    root.querySelector('.code-copy-btn').click();
    await waitFor(() => clip.copied !== null);
    equal(clip.copied, source);
  });
  await test('a KaTeX chunk failure keeps the literal expression visible', async () => {
    const { root } = render('Area \\(\\pi r^2\\) here.\n\n$$\nE = mc^2\n$$');
    await waitFor(() => root.querySelectorAll('.math-error').length === 2, 'math error state not applied');
    equal(root.querySelector('.katex'), null);
    ok(root.querySelector('.math-inline').textContent === '\\pi r^2', 'inline expression lost');
    ok(root.querySelector('.math-block').textContent === 'E = mc^2', 'block expression lost');
  });
}

document.getElementById('result').textContent = JSON.stringify({
  tests: results.length, passed: results.filter((result) => result.passed).length,
  failed: results.filter((result) => !result.passed).length, results,
});
