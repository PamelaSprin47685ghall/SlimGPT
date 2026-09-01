import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBlocks, renderBlock } from '../markdown-worker.js';

function render(text) {
  const blocks = splitBlocks(String(text || ''));
  return blocks.map(renderBlock).join('');
}

test('markdown renders GFM tables with alignment', () => {
  const markdown = `| Header 1 | Header 2 | Header 3 |
| :--- | :---: | ---: |
| Left | Center | Right |
| Val 1 | Val 2 | Val 3 |`;

  const html = render(markdown);
  assert.ok(html.includes('<div class="table-wrap"><table>'), 'Must wrap in table-wrap');
  assert.ok(html.includes('<thead><tr>'), 'Must have thead');
  assert.ok(html.includes('<th style="text-align:left">Header 1</th>'), 'Must support left align');
  assert.ok(html.includes('<th style="text-align:center">Header 2</th>'), 'Must support center align');
  assert.ok(html.includes('<th style="text-align:right">Header 3</th>'), 'Must support right align');
  assert.ok(html.includes('<tbody><tr>'), 'Must have tbody');
  assert.ok(html.includes('<td style="text-align:left">Left</td>'), 'Must render cell with alignment');
});

test('markdown renders code blocks with language header and copy button', () => {
  const markdown = '```js\nconst greeting = "hello";\n```';
  const html = render(markdown);
  assert.ok(html.includes('class="code-block"'), 'Must have code-block container');
  assert.ok(html.includes('class="code-header"'), 'Must have code-header');
  assert.ok(html.includes('class="code-copy-btn"'), 'Must have copy button');
  assert.ok(html.includes('<span class="tok-key">const</span>'), 'Must highlight keywords');
  assert.ok(html.includes('<span class="tok-str">&quot;hello&quot;</span>') || html.includes('<span class="tok-str">"hello"</span>'), 'Must highlight strings safely');
});

test('markdown renders task lists, math, and inline styles', () => {
  const markdown = `- [ ] Open task with $E = mc^2$\n- [x] Completed task with **bold** and *italic* and ~~strike~~`;
  const html = render(markdown);
  assert.ok(html.includes('<input type="checkbox" disabled class="task-checkbox"'), 'Must render task checkbox');
  assert.ok(html.includes('<input type="checkbox" disabled checked class="task-checkbox"'), 'Must render checked task checkbox');
  assert.ok(html.includes('class="katex"') || html.includes('katex-mathml'), 'Must render inline math with KaTeX');
  assert.ok(html.includes('<strong>bold</strong>'), 'Must render bold');
  assert.ok(html.includes('<em>italic</em>'), 'Must render italic');
  assert.ok(html.includes('<del>strike</del>'), 'Must render strikethrough');
});

test('markdown renders display math blocks with KaTeX', () => {
  const markdown = `$$\n\\sum_{i=1}^n x_i = \\frac{n(n+1)}{2}\n$$`;
  const html = render(markdown);
  assert.ok(html.includes('class="math-block"'), 'Must wrap in math-block container');
  assert.ok(html.includes('class="katex-display"') || html.includes('class="katex"'), 'Must render display math with KaTeX');
});

test('markdown handles LaTeX syntax errors gracefully', () => {
  const markdown = `$$\n\\invalidmacro{test\n$$`;
  const html = render(markdown);
  assert.ok(html.length > 0, 'Must not crash on invalid LaTeX');
});

test('markdown prevents XSS injection via images/scripts/iframes', () => {
  const malicious = `<img src=x onerror=alert(1)> [link](javascript:alert(1)) <script>alert(2)</script>`;
  const html = render(malicious);
  assert.equal(html.includes('<script>'), false, 'Must not contain raw script tags');
  assert.equal(html.includes('<img'), false, 'Must not contain raw img tags');
  assert.ok(html.includes('&lt;img') || html.includes('&lt;script'), 'Must escape html tags');
});
