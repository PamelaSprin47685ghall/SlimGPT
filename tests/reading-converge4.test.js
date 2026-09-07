import test from 'node:test';
import assert from 'node:assert/strict';
import { nestedScrollerCanConsume, wheelDeltaPixels } from '../src/lib/scroll-input.js';

function mockElement({
  scrollTop = 0,
  scrollHeight = 100,
  clientHeight = 100,
  scrollWidth = 100,
  clientWidth = 100,
  classes = [],
  tagName = 'DIV',
  parent = null,
  inlineOverflowY,
} = {}) {
  const classSet = new Set(classes);
  return {
    nodeType: 1,
    tagName,
    scrollTop,
    scrollHeight,
    clientHeight,
    scrollWidth,
    clientWidth,
    classList: {
      contains: (c) => classSet.has(c),
    },
    parentElement: parent,
    style: inlineOverflowY === undefined ? {} : { overflowY: inlineOverflowY },
  };
}

test('PageUp/PageDown probe checks with clientHeight * 0.8 in nestedScrollerCanConsume', () => {
  let calls = 0;
  const styleOf = () => { calls += 1; return { overflowY: 'auto' }; };
  const boundary = mockElement({ scrollHeight: 1000, clientHeight: 500 });
  const inner = mockElement({
    scrollHeight: 800,
    clientHeight: 200,
    scrollTop: 100,
    classes: ['markdown-body'],
    parent: boundary,
  });

  // Delta of 400 (PageDown probe on 500px clientHeight is ~400)
  // Inner can scroll down: remaining is 800 - 200 - 100 = 500 > 1
  assert.equal(nestedScrollerCanConsume(inner, boundary, 400, styleOf), true);
  // Fast path for known class skips computed-style lookup
  assert.equal(calls, 0);

  // When inner is scrolled to bottom
  inner.scrollTop = 600;
  assert.equal(nestedScrollerCanConsume(inner, boundary, 400, styleOf), false);
  // But inner can still scroll up
  assert.equal(nestedScrollerCanConsume(inner, boundary, -400, styleOf), true);
});

test('boundary scroller itself is never considered a nested scroller', () => {
  const styleOf = () => ({ overflowY: 'auto' });
  const boundary = mockElement({ scrollHeight: 1000, clientHeight: 500 });
  assert.equal(nestedScrollerCanConsume(boundary, boundary, 400, styleOf), false);
});

test('known scrollable classes include markdown-body and thought-content', () => {
  let calls = 0;
  const styleOf = () => { calls += 1; return { overflowY: 'auto' }; };
  const boundary = mockElement({ scrollHeight: 1000, clientHeight: 500 });
  const thought = mockElement({
    scrollHeight: 600,
    clientHeight: 200,
    scrollTop: 50,
    classes: ['thought-content'],
    parent: boundary,
  });
  assert.equal(nestedScrollerCanConsume(thought, boundary, 100, styleOf), true);
  assert.equal(nestedScrollerCanConsume(thought, boundary, -100, styleOf), true);
  // Fast path used, no style calls
  assert.equal(calls, 0);
});
