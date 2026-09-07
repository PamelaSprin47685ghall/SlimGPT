import { createIncrementalMarkdown } from '../../src/lib/incremental-markdown.js';
import { mount, unmount, tick } from 'svelte';
import ToolPayloadBlock from '../../src/components/ToolPayloadBlock.svelte';

const results = [];
function equal(actual, expected, detail = '') {
  if (actual !== expected) throw new Error(`${detail}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function ok(value, detail) { if (!value) throw new Error(detail); }
function render(text, cuts = [], final = true) {
  const root = document.createElement('div');
  document.body.append(root);
  const renderer = createIncrementalMarkdown(root);
  for (const cut of cuts) renderer.update(text.slice(0, cut));
  renderer.update(text, { final });
  return { root, renderer };
}
async function test(name, check) {
  try { await check(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error.message || error) }); }
  for (const node of [...document.body.children]) if (node.id !== 'result' && node.tagName !== 'SCRIPT') node.remove();
}
async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((accept) => setTimeout(accept, 20));
  }
  throw new Error('Browser condition timed out');
}

if (new URLSearchParams(location.search).get('scenario') !== 'tool-load-failure') {
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
  for (const text of ['hello *', 'hello **', 'hello `', 'hello [', 'hello \\', 'hello &']) {
    const { root } = render(text);
    equal(root.textContent, text, text);
  }
});
await test('a table ending at EOF has its scroll wrapper and intact cells', () => {
  const { root } = render('| A | B |\n|---|---|\n| 一 | 二 |');
  equal(root.querySelectorAll('.table-wrap').length, 1);
  equal(root.querySelectorAll('td').length, 2);
  equal(root.querySelector('td')?.textContent.trim(), '一');
});
await test('one-byte streaming and whole-input rendering give the same DOM', () => {
  for (const text of ['Hello **bold** and *italic*.\n\nSecond.', '- one\n- two\n\nTail', '```js\nconst a = 1;\n```', '| A | B |\n|---|---|\n| 一 | 二 |', '[source](<https://example.com/a(b)> "Title")']) {
    const whole = render(text).root.innerHTML;
    const streamed = render(text, Array.from({ length: text.length }, (_, i) => i + 1)).root.innerHTML;
    equal(streamed, whole, text);
  }
});
await test('a suffix update retains the existing paragraph and selection nodes', () => {
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
await test('rejected image destinations do not silently discard their description', () => {
  const { root } = render('![保留图片说明](javascript:alert)');
  equal(root.querySelector('img'), null);
  ok(root.textContent.includes('保留图片说明'), 'description disappeared with blocked image');
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
  for (const text of ['Formula $x + y', 'Formula \\(x+y', '$$\nx + y', '\\[\nx + y']) {
    equal(render(text).root.textContent, text, 'unfinished math was silently treated as finished');
  }
});
await test('unfinished code preserves a genuine trailing newline but never an EOF sentinel', () => {
  for (const body of ['', 'abc', 'abc\n', 'abc\n\n', '`', '\\', '<>&']) {
    equal(render(`\`\`\`text\n${body}`).root.querySelector('pre code')?.textContent, body, body);
  }
});
await test('code copying is invariant under every transport split including CRLF boundaries', () => {
  const text = '```js\r\n  const x = "中文🧪";\r\n\r\n```';
  for (let cut = 0; cut <= text.length; cut++) {
    const { root } = render(text, [cut]);
    equal(root.querySelector('pre code')?.textContent, '  const x = "中文🧪";\n\n', `split ${cut}`);
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
await test('completed code is keyboard-focusable without pretending to be editable', () => {
  const { root } = render('```text\nscrollable\n```');
  const pre = root.querySelector('pre');
  equal(pre.tabIndex, 0);
  pre.focus();
  equal(document.activeElement, pre);
  equal(pre.getAttribute('role'), 'region');
  equal(root.querySelector('.code-copy-btn')?.getAttribute('aria-live'), 'polite');
});
await test('large code skips expensive highlighting but retains every source character', () => {
  const body = 'const x = "中文<&>";\n'.repeat(18_000);
  const { root } = render(`\`\`\`javascript\n${body}\`\`\``);
  equal(root.querySelector('pre code')?.textContent, body);
  equal(root.querySelectorAll('.code-copy-btn').length, 1);
  equal(root.querySelectorAll('.tok-str, .tok-key, .tok-num').length, 0);
});
await test('failed image loads keep alternative text visible without retrying the URL', () => {
  const { root } = render('![Photo description](https://example.invalid/image.png)');
  const image = root.querySelector('img');
  image.dispatchEvent(new Event('error'));
  equal(root.querySelector('img'), null);
  ok(root.textContent.includes('Photo description'), 'failed load hid the description');
});
await test('unfinished inline formatting cannot swallow neighboring literal characters', () => {
  for (const text of ['before **bold', 'before _em', 'before ~~struck', 'before [label', 'before [label](https://example.com', 'before `code', 'before ``two ticks']) {
    equal(render(text).root.textContent, text, text);
  }
});
await test('finished inline math renders through the real lazily loaded KaTeX module', async () => {
  await import('katex');
  const { root } = render('Formula \\(x^2 + y^2\\) end.');
  for (let i = 0; i < 100 && !root.querySelector('.katex'); i++) await new Promise((accept) => setTimeout(accept, 10));
  ok(root.querySelector('.katex'), 'KaTeX did not render');
  equal(root.querySelector('annotation')?.textContent, 'x^2 + y^2');
  ok(root.textContent.endsWith(' end.'), 'math swallowed the trailing sentence');
});
await test('late math rendering after a correction cannot resurrect an obsolete equation', async () => {
  const { root, renderer } = render('\\(old + x\\)');
  renderer.update('replacement without math', { final: true });
  await new Promise((accept) => setTimeout(accept, 40));
  equal(root.querySelector('.katex'), null);
  equal(root.textContent, 'replacement without math');
});
await test('real tool component shows raw content during lazy load then supports both formats', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const payload = '  {"answer":"中文","values":[1,2,3]}\n';
  const instance = mount(ToolPayloadBlock, { target: root, props: { tool: { name: 'fixture', kind: 'tool-result', payload } } });
  try {
    await tick();
    equal(root.querySelector('pre code')?.textContent, payload);
    equal(root.querySelector('.tool-code-language')?.textContent, 'RAW');
    await waitFor(() => root.querySelector('.tool-code-language')?.textContent === 'TOML');
    ok(root.querySelector('pre code').textContent.includes('answer = "中文"'), 'formatted payload missing');
    root.querySelector('.tool-format-toggle').click();
    await tick();
    equal(root.querySelector('pre code')?.textContent, payload);
    equal(root.querySelector('.tool-code-language')?.textContent, 'RAW');
  } finally { await unmount(instance); }
});
} else {
await test('a real formatter chunk HTTP failure leaves the whole tool payload visible and copyable', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const text = '<script>plain payload</script>\n  exact whitespace\n';
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let copied;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { copied = value; } } });
  const instance = mount(ToolPayloadBlock, { target: root, props: { tool: { name: 'fixture', kind: 'tool-result', payload: text } } });
  try {
    await waitFor(() => root.querySelector('.tool-format-notice')?.textContent.includes('未能加载'));
    equal(root.querySelector('pre code')?.textContent, text);
    equal(root.querySelector('pre script'), null);
    equal(root.querySelector('.tool-code-language')?.textContent, 'RAW');
    root.querySelector('.tool-code-copy:not(.tool-format-toggle)').click();
    await waitFor(() => root.querySelector('.copied'));
    equal(copied, text);
  } finally {
    await unmount(instance);
    if (previous) Object.defineProperty(navigator, 'clipboard', previous);
    else delete navigator.clipboard;
  }
});
}

document.getElementById('result').textContent = JSON.stringify({
  tests: results.length, passed: results.filter((result) => result.passed).length,
  failed: results.filter((result) => !result.passed).length, results,
});
