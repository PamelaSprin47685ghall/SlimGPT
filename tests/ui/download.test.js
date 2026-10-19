// Live bug (bda5542): 导出 Markdown produced no file. Framework7's global
// click handler preventDefault()s every <a> click unless it is `.external`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadText, safeFileName } from '../../src/ui/lib/download.js';

function fakeDoc({ prevent = false } = {}) {
  const appended = [];
  const doc = {
    defaultView: null,
    body: { append: (el) => appended.push(el) },
    createElement: () => ({
      style: {}, className: '', removed: false,
      remove() { this.removed = true; },
      dispatchEvent(event) {
        this.dispatched = event;
        // Framework7 behaviour: prevent unless the link matches `.external`.
        if (prevent && !this.className.split(' ').includes('external')) return false;
        return true;
      },
    }),
  };
  return { doc, appended };
}

test('download anchor is appended, marked external, clicked and removed', (t) => {
  t.mock.method(globalThis, 'setTimeout', () => 0);
  globalThis.MouseEvent ??= class { constructor(type, init) { Object.assign(this, { type }, init); } };
  const { doc, appended } = fakeDoc({ prevent: true });
  assert.equal(downloadText('# hi', 'a.md', undefined, doc), true);
  const [link] = appended;
  assert.equal(link.download, 'a.md');
  assert.match(link.href, /^blob:/);
  assert.equal(link.className, 'external');
  assert.equal(link.dispatched.type, 'click');
  assert.ok(link.removed);
});

test('download reports failure so the caller can fall back to the clipboard', () => {
  const broken = { body: { append() { throw new Error('no body'); } }, createElement: () => ({ style: {} }) };
  assert.equal(downloadText('x', 'a.md', undefined, broken), false);
  assert.equal(safeFileName('a/b: c?'), 'a b c.md');
});
