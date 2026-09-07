import test from 'node:test';
import assert from 'node:assert/strict';
import { nestedScrollerCanConsume } from '../src/lib/scroll-input.js';

function nodeWith({
  scrollTop = 0,
  scrollHeight = 0,
  clientHeight = 0,
  scrollWidth,
  clientWidth,
  parent = null,
  tag = 'DIV',
  classes = [],
  inlineOverflowY,
} = {}) {
  const names = new Set(classes);
  return {
    nodeType: 1,
    tagName: tag,
    scrollTop,
    scrollHeight,
    clientHeight,
    scrollWidth,
    clientWidth,
    parentElement: parent,
    style: inlineOverflowY === undefined ? {} : { overflowY: inlineOverflowY },
    classList: { contains: (name) => names.has(name) },
  };
}

test('table-wrap with horizontal scroll does not consume vertical scroll', () => {
  const outer = nodeWith();
  const table = nodeWith({
    scrollTop: 0,
    scrollHeight: 220,
    clientHeight: 200,
    scrollWidth: 800,
    clientWidth: 400,
    parent: outer,
    classes: ['table-wrap'],
  });
  let calls = 0;
  const styleOf = () => { calls += 1; return { overflowY: 'hidden' }; };
  assert.equal(nestedScrollerCanConsume(table, outer, 40, styleOf), false);
  assert.equal(nestedScrollerCanConsume(table, outer, -40, styleOf), false);
  assert.equal(calls, 0);
});

test('pre tag with vertical scroll consumes vertical scroll even if wide', () => {
  const outer = nodeWith();
  const pre = nodeWith({
    scrollTop: 10,
    scrollHeight: 600,
    clientHeight: 200,
    scrollWidth: 1000,
    clientWidth: 400,
    parent: outer,
    tag: 'PRE',
  });
  let calls = 0;
  const styleOf = () => { calls += 1; return { overflowY: 'auto' }; };
  assert.equal(nestedScrollerCanConsume(pre, outer, 40, styleOf), true);
  assert.equal(nestedScrollerCanConsume(pre, outer, -40, styleOf), true);
  assert.equal(calls, 0);
});
