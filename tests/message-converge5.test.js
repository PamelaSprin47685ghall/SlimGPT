// Round-4 Message converge tests — additive only
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  humanizeError,
  matchNumericErrorCode,
  isDuplicateErrorDetail,
  calculateReadingMinutes,
  formatMessageTimestamp,
} from '../src/lib/message-presentation.js';
import {
  extractToolKeyArg,
  extractToolPairingState,
  extractToolCallIds,
} from '../src/lib/tool-presentation.js';
import { extractSourcesList } from '../src/lib/content-references.js';
import { buildConversationMarkdown } from '../src/lib/export.js';

// Numeric-code mapping
for (const [code, expected] of [
  ['429', '请求过于频繁，请稍后再试'],
  ['401', '身份认证已过期，请重新登录'],
  ['403', '访问受限或没有权限'],
  ['500', '服务器内部错误，请稍后重试'],
  ['503', '服务器暂时不可用，请稍后重试'],
]) {
  test(`numeric code ${code} maps to Chinese`, () => {
    assert.equal(humanizeError(`HTTP ${code}`), expected);
    assert.equal(matchNumericErrorCode(`error ${code} occurred`), expected);
  });
}

// New dict entries
test('new error dict entries map to Chinese', () => {
  assert.equal(humanizeError('usage_cap_exceeded'), '当前额度已用尽，请稍后再试');
  assert.equal(humanizeError('token_expired'), '登录令牌已过期，请重新登录');
  assert.equal(humanizeError('session_expired'), '会话已过期，请重新登录');
  assert.equal(humanizeError('cf_details'), 'Cloudflare 安全验证拦截，请在官方网页重试');
});

// Dedupe predicate
test('error detail dedupe predicate suppresses echo details', () => {
  assert.equal(isDuplicateErrorDetail('当前模型暂不支持此类输入', '当前模型暂不支持此类输入'), true);
  assert.equal(isDuplicateErrorDetail('  当前模型暂不支持此类输入  ', '当前模型暂不支持此类输入'), true);
  assert.equal(isDuplicateErrorDetail('请求过于频繁，请稍后再试', 'HTTP 429'), false);
  assert.equal(isDuplicateErrorDetail('', 'detail'), false);
  assert.equal(isDuplicateErrorDetail('title', ''), false);
});

// Reading-time math
test('reading-time math uses ceil(CJK/400, words/200)', () => {
  assert.equal(calculateReadingMinutes(''), 0);
  assert.equal(calculateReadingMinutes('   '), 0);
  // 400 CJK chars = 1 minute
  assert.equal(calculateReadingMinutes('中'.repeat(400)), 1);
  // 401 CJK chars = 2 minutes
  assert.equal(calculateReadingMinutes('中'.repeat(401)), 2);
  // 200 words = 1 minute
  const twoHundredWords = Array(200).fill('word').join(' ');
  assert.equal(calculateReadingMinutes(twoHundredWords), 1);
  // 201 words = 2 minutes
  const twoHundredOne = Array(201).fill('word').join(' ');
  assert.equal(calculateReadingMinutes(twoHundredOne), 2);
  // mixed: 200 CJK + 100 words = 0.5 + 0.5 = 1
  const mixed = '中'.repeat(200) + ' ' + Array(100).fill('word').join(' ');
  assert.equal(calculateReadingMinutes(mixed), 1);
});

// Ordinal numbering via extractSourcesList + export
test('export carries numbered sources in order', () => {
  const messages = [
    { role: 'user', text: 'q' },
    {
      role: 'assistant',
      text: 'answer [来源 1] [来源 2]',
      metadata: {
        content_references: [
          { url: 'https://example.com/a', title: 'Alpha' },
          { url: 'https://example.com/b', title: 'Beta' },
        ],
      },
    },
  ];
  const output = buildConversationMarkdown('Sources', messages);
  assert.ok(output.includes('## 参考来源'), 'export must include 参考来源 section');
  const idx1 = output.indexOf('[1] Alpha — https://example.com/a');
  const idx2 = output.indexOf('[2] Beta — https://example.com/b');
  assert.ok(idx1 >= 0 && idx2 >= 0, 'both sources must be numbered');
  assert.ok(idx1 < idx2, 'ordinal badges must be in 1..N order');
});

// KeyArg fallback
test('keyArg fallback finds first meaningful scalar before hash', () => {
  // Priority key takes precedence
  assert.equal(extractToolKeyArg({ query: 'hello' }), 'query: hello');
  // First meaningful scalar in nested payload
  assert.equal(extractToolKeyArg({ nested: { deep: 'meaningful text' } }), 'nested: deep: meaningful text');
  // Numeric scalar
  assert.equal(extractToolKeyArg({ payload: { count: 42 } }), 'payload: count: 42');
  // Fallback to hash/callId
  const callish = extractToolKeyArg({ hash: 'abc' }, { callId: 'call-12345678' });
  assert.ok(callish.includes('…') || callish.length <= 16, 'short callId fallback expected');
});

// Tool pairing honesty
test('tool pairing state grounds actual fields, never invents', () => {
  assert.equal(extractToolPairingState({ pairingState: 'paired' }), '已配对');
  assert.equal(extractToolPairingState({ pairing: 'waiting' }), '等待结果');
  assert.equal(extractToolPairingState({ resultState: 'none' }), '无结果');
  assert.equal(extractToolPairingState({ paired: true }), '已配对');
  assert.equal(extractToolPairingState({ paired: false }), '无结果');
  assert.equal(extractToolPairingState({}, null), '', 'no invented pairing');
  assert.equal(extractToolPairingState({ name: 'web.run' }), '', 'no invented pairing for plain tool');
});

// CallId extraction
test('extractToolCallIds collects ids from tool and message', () => {
  const ids = extractToolCallIds({ callId: 'c1', toolCallId: 'c2' }, { callIds: ['c3'] });
  assert.ok(ids.includes('c1') && ids.includes('c2') && ids.includes('c3'));
});

// Timestamp formatting
test('formatMessageTimestamp renders HH:mm with full-date tooltip', () => {
  const { time, full } = formatMessageTimestamp(1700000000000);
  assert.match(time, /^\d{2}:\d{2}$/);
  assert.ok(full.length > 0);
  assert.deepEqual(formatMessageTimestamp(null), { time: '', full: '' });
  assert.deepEqual(formatMessageTimestamp('not-a-date'), { time: '', full: '' });
});

// Sources list shape
test('extractSourcesList output shape has url/title/domain/avatar', () => {
  const list = extractSourcesList({
    content_references: [{ url: 'https://example.com/x', title: 'X' }],
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'https://example.com/x');
  assert.equal(list[0].title, 'X');
  assert.ok(list[0].domain.includes('example.com'));
  assert.ok(list[0].avatar.length > 0);
});
