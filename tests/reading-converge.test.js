import test from 'node:test';
import assert from 'node:assert/strict';
import { nestedScrollerCanConsume } from '../src/lib/scroll-input.js';

function nodeWith({ scrollTop = 0, scrollHeight = 0, clientHeight = 0, parent = null, tag = 'DIV', classes = [], inlineOverflowY } = {}) {
  const names = new Set(classes);
  return {
    nodeType: 1,
    tagName: tag,
    scrollTop,
    scrollHeight,
    clientHeight,
    parentElement: parent,
    style: inlineOverflowY === undefined ? {} : { overflowY: inlineOverflowY },
    classList: { contains: (name) => names.has(name) },
  };
}

test('computed style is never consulted for nodes without vertical overflow', () => {
  const outer = nodeWith();
  const flat = nodeWith({ scrollHeight: 200, clientHeight: 200, parent: outer });
  let calls = 0;
  const styleOf = () => { calls += 1; return { overflowY: 'auto' }; };
  assert.equal(nestedScrollerCanConsume(flat, outer, 40, styleOf), false);
  assert.equal(calls, 0);
});

test('known scroll containers skip computed-style inspection', () => {
  const outer = nodeWith();
  for (const fixture of [
    { tag: 'PRE', classes: [] },
    { tag: 'DIV', classes: ['table-wrap'] },
    { tag: 'DIV', classes: ['tool-payload'] },
  ]) {
    const scroller = nodeWith({ scrollTop: 10, scrollHeight: 600, clientHeight: 200, parent: outer, ...fixture });
    let calls = 0;
    const styleOf = () => { calls += 1; return { overflowY: 'auto' }; };
    assert.equal(nestedScrollerCanConsume(scroller, outer, 40, styleOf), true);
    assert.equal(nestedScrollerCanConsume(scroller, outer, -40, styleOf), true);
    assert.equal(calls, 0);
  }
});

test('explicit inline clipping beats the known-class fast path', () => {
  const outer = nodeWith();
  const clipped = nodeWith({
    scrollTop: 0, scrollHeight: 600, clientHeight: 200, parent: outer,
    classes: ['table-wrap'], inlineOverflowY: 'hidden',
  });
  let calls = 0;
  const styleOf = () => { calls += 1; return { overflowY: 'hidden' }; };
  assert.equal(nestedScrollerCanConsume(clipped, outer, 40, styleOf), false);
  assert.equal(calls, 1);
});

test('unmarked overflow containers still fall back to computed style', () => {
  const outer = nodeWith();
  const custom = nodeWith({ scrollTop: 100, scrollHeight: 600, clientHeight: 200, parent: outer });
  let calls = 0;
  const styleOf = () => { calls += 1; return { overflowY: 'auto' }; };
  assert.equal(nestedScrollerCanConsume(custom, outer, 40, styleOf), true);
  assert.equal(calls, 1);
});

test('boundary consumption still respects scroll position', () => {
  const outer = nodeWith();
  const atBottom = nodeWith({ scrollTop: 400, scrollHeight: 600, clientHeight: 200, parent: outer, classes: ['table-wrap'] });
  const styleOf = () => ({ overflowY: 'auto' });
  assert.equal(nestedScrollerCanConsume(atBottom, outer, 40, styleOf), false);
  assert.equal(nestedScrollerCanConsume(atBottom, outer, -40, styleOf), true);
  const atTop = nodeWith({ scrollTop: 0, scrollHeight: 600, clientHeight: 200, parent: outer, classes: ['table-wrap'] });
  assert.equal(nestedScrollerCanConsume(atTop, outer, -40, styleOf), false);
  assert.equal(nestedScrollerCanConsume(atTop, outer, 40, styleOf), true);
});
