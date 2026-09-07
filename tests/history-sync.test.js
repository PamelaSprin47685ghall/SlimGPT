import test from 'node:test';
import assert from 'node:assert/strict';
import { historySyncMessage } from '../src/lib/history-sync.js';

test('history failures are actionable and never expose raw response text or URLs', () => {
  for (const state of [
    { code: 'timeout' }, { code: 'invalid-history' }, { code: 'not-ready' },
    { status: 401 }, { status: 403 }, { status: 500 },
  ]) {
    const text = historySyncMessage({ state: 'error', ...state, message: 'secret cookie', url: 'https://x/?token=private' });
    assert.ok(text.length > 10);
    assert.equal(/secret|cookie|private|https/.test(text), false);
  }
  assert.equal(historySyncMessage({ state: 'loading' }), '');
  assert.match(historySyncMessage(null, 'missing-page'), /分页缺失/);
});

test('server-requested backoff remains visible rather than silently retrying early', () => {
  assert.match(historySyncMessage({ state: 'error', status: 429, retryAfterMs: 120000 }), /120 秒/);
  assert.match(historySyncMessage({ state: 'error', code: 'backoff', retryAfterMs: 1 }), /1 秒/);
  assert.equal(historySyncMessage({ state: 'error', code: 'backoff', retryAfterMs: Infinity }).includes('Infinity'), false);
});
