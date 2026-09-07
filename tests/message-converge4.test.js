import test from 'node:test';
import assert from 'node:assert/strict';
import { humanizeError } from '../src/lib/message-presentation.js';
import { extractSourcesList } from '../src/lib/content-references.js';
import {
  extractToolDuration,
  getGlobalToolFoldPref,
  setGlobalToolFoldPref,
} from '../src/lib/tool-presentation.js';
import {
  tableToMarkdown,
  getFileExtensionForLanguage,
  LANG_EXT_MAP,
} from '../src/lib/incremental-markdown.js';

test('humanizeError translates standard error codes to Chinese', () => {
  assert.equal(humanizeError('composer-input-unsupported'), '当前模型暂不支持此类输入');
  assert.equal(humanizeError('composer_input_unsupported'), '当前模型暂不支持此类输入');
  assert.equal(humanizeError('rate_limit'), '请求过于频繁，请稍后再试');
  assert.equal(humanizeError('rate_limit_exceeded'), '请求过于频繁，请稍后再试');
  assert.equal(humanizeError('insufficient_quota'), '额度已用尽或账户受限');
  assert.equal(humanizeError('quota_exceeded'), '额度已用尽或账户受限');
  assert.equal(humanizeError('auth_error'), '身份认证已过期，请重新登录');
  assert.equal(humanizeError('unauthorized'), '身份认证已过期，请重新登录');
  assert.equal(humanizeError('network_error'), '网络连接异常，请检查网络后重试');
  assert.equal(humanizeError('timeout'), '请求超时，请稍后重试');
});

test('humanizeError falls back to object message or detail when code unknown', () => {
  assert.equal(humanizeError({ code: 'unknown_err_123', message: 'Something went wrong' }), 'Something went wrong');
  assert.equal(humanizeError({ detail: 'Raw detail from server' }), 'Raw detail from server');
  assert.equal(humanizeError('Custom failure occurred'), 'Custom failure occurred');
});

test('extractSourcesList extracts deduplicated sources with domains and letter-avatars', () => {
  const metadata = {
    content_references: [
      {
        url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
        title: 'MDN JavaScript Guide',
      },
      {
        url: 'https://github.com/sveltejs/svelte',
        title: 'Svelte Repository',
      },
      {
        // duplicate url
        url: 'https://github.com/sveltejs/svelte',
        title: 'Duplicate Svelte',
      },
    ],
  };
  const sources = extractSourcesList(metadata);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].domain, 'developer.mozilla.org');
  assert.equal(sources[0].avatar, 'D');
  assert.equal(sources[0].title, 'MDN JavaScript Guide');
  assert.equal(sources[1].domain, 'github.com');
  assert.equal(sources[1].avatar, 'G');
});

test('extractToolDuration handles numeric seconds, ms, and timestamp diffs', () => {
  assert.equal(extractToolDuration({ duration: 1.5 }), '1.5s');
  assert.equal(extractToolDuration({ duration: 0.35 }), '350ms');
  assert.equal(extractToolDuration({ finished_duration_sec: 4.0 }), '4s');
  assert.equal(extractToolDuration({
    startTime: 1700000000000,
    endTime: 1700000002500,
  }), '2.5s');
  assert.equal(extractToolDuration({}), '');
});

test('getGlobalToolFoldPref and setGlobalToolFoldPref handle localStorage safely', () => {
  // Mock localStorage in Node test environment if not present
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  }

  setGlobalToolFoldPref(true);
  assert.equal(getGlobalToolFoldPref(), true);
  setGlobalToolFoldPref(false);
  assert.equal(getGlobalToolFoldPref(), false);
});

test('tableToMarkdown converts table element to Markdown grid', () => {
  // Minimal DOM node mock for table testing in Node
  const createMockTable = () => {
    const table = {
      querySelectorAll: (sel) => {
        if (sel === 'tr') {
          return [
            {
              querySelectorAll: () => [
                { textContent: 'Name' },
                { textContent: 'Role' },
              ],
            },
            {
              querySelectorAll: () => [
                { textContent: 'Alice' },
                { textContent: 'Admin' },
              ],
            },
            {
              querySelectorAll: () => [
                { textContent: 'Bob' },
                { textContent: 'User' },
              ],
            },
          ];
        }
        return [];
      },
    };
    return table;
  };

  const md = tableToMarkdown(createMockTable());
  assert.equal(md, '| Name | Role |\n| --- | --- |\n| Alice | Admin |\n| Bob | User |\n');
});

test('getFileExtensionForLanguage correctly maps code languages', () => {
  assert.equal(getFileExtensionForLanguage('python'), 'py');
  assert.equal(getFileExtensionForLanguage('py'), 'py');
  assert.equal(getFileExtensionForLanguage('javascript'), 'js');
  assert.equal(getFileExtensionForLanguage('ts'), 'ts');
  assert.equal(getFileExtensionForLanguage('typescript'), 'ts');
  assert.equal(getFileExtensionForLanguage('rust'), 'rs');
  assert.equal(getFileExtensionForLanguage('json'), 'json');
  assert.equal(getFileExtensionForLanguage('unknown-lang'), 'txt');
});
