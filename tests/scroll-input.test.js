import test from 'node:test';
import assert from 'node:assert/strict';
import { nestedScrollerCanConsume, wheelDeltaPixels } from '../src/lib/scroll-input.js';

test('wheel navigation uses pixel, line, and page units consistently', () => {
  assert.equal(wheelDeltaPixels({ deltaY: 3, deltaMode: 0 }, 600), 3);
  assert.equal(wheelDeltaPixels({ deltaY: 3, deltaMode: 1 }, 600), 60);
  assert.equal(wheelDeltaPixels({ deltaY: -1, deltaMode: 2 }, 600), -600);
});

test('pinch zoom, horizontal gestures and already handled events never advance turns', () => {
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { defaultPrevented: true }, { deltaX: 200 }, { deltaY: NaN }]) {
    assert.equal(wheelDeltaPixels({ deltaY: 40, ...extra }, 600), 0);
  }
});

test('nested tool output consumes its own scroll until its boundary', () => {
  const outer = { nodeType: 1 };
  const pre = { nodeType: 1, scrollTop: 100, scrollHeight: 600, clientHeight: 200, parentElement: outer };
  const code = { nodeType: 1, scrollHeight: 0, parentElement: pre };
  const styleOf = () => ({ overflowY: 'auto' });
  assert.equal(nestedScrollerCanConsume(code, outer, 40, styleOf), true);
  assert.equal(nestedScrollerCanConsume(code, outer, -40, styleOf), true);
  pre.scrollTop = 400;
  assert.equal(nestedScrollerCanConsume(code, outer, 40, styleOf), false);
  assert.equal(nestedScrollerCanConsume(code, outer, -40, styleOf), true);
  pre.scrollTop = 0;
  assert.equal(nestedScrollerCanConsume(code, outer, -40, styleOf), false);
  assert.equal(nestedScrollerCanConsume(code, outer, 40, () => ({ overflowY: 'hidden' })), false);
});
