import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyEndpoint, conversationIdFromRoute, isBackendRequest, isConversationId, readStreamRequestIds,
} from '../../src/page/endpoints.js';

const O = 'https://chatgpt.com';
const ID = '6713a1f0-1234-4abc-8def-0123456789ab';

test('allowlist accepts exactly the official stream, history and list endpoints', () => {
  assert.deepEqual(classifyEndpoint('POST', `${O}/backend-api/conversation`, O), { kind: 'submit' });
  assert.deepEqual(classifyEndpoint('post', '/backend-api/f/conversation', O), { kind: 'submit' });
  assert.deepEqual(classifyEndpoint('POST', '/backend-api/f/conversation/resume', O), { kind: 'resume' });
  assert.deepEqual(classifyEndpoint('POST', '/backend-api/conversation/resume', O), { kind: 'resume' });
  assert.deepEqual(classifyEndpoint('GET', `/backend-api/conversation/${ID}`, O), { kind: 'history', conversationId: ID });
  assert.deepEqual(classifyEndpoint('GET', `/backend-api/conversation/${ID}?x=1`, O), { kind: 'history', conversationId: ID });
  assert.deepEqual(classifyEndpoint('GET', '/backend-api/conversations?offset=28&limit=28', O), { kind: 'list', offset: 28 });
  assert.deepEqual(classifyEndpoint('GET', '/backend-api/conversations', O), { kind: 'list', offset: 0 });
});

test('allowlist rejects look-alikes (memories, prepare, init, sub-resources, other origins, wrong methods)', () => {
  const rejected = [
    ['GET', '/backend-api/memories'],
    ['GET', '/backend-api/memories?include_memory_entries=true'],
    ['GET', '/backend-api/me'],
    ['GET', '/backend-api/models'],
    ['POST', '/backend-api/conversation/prepare'],
    ['POST', '/backend-api/f/conversation/prepare'],
    ['POST', '/backend-api/conversation/init'],
    ['POST', '/backend-api/conversation/runtime'],
    ['GET', '/backend-api/conversation/init'],
    ['GET', `/backend-api/conversation/${ID}/textdocs`],
    ['GET', `/backend-api/conversation/${ID}/stream_status`],
    ['GET', `/backend-api/conversations/${ID}`],
    ['GET', '/backend-api/conversations/search?q=x'],
    ['GET', `/backend-api/conversation/${ID}/`],
    ['GET', '/backend-api/conversation/WEB:abc'],
    ['GET', '/backend-api/conversation'],
    ['PATCH', `/backend-api/conversation/${ID}`],
    ['GET', '/backend-api/conversation/resume'],
    ['POST', '/backend-api/conversations'],
    ['POST', '/backend-api/conversation/'],
    ['POST', '/backend-api/sentinel/chat-requirements'],
    ['POST', '/ces/v1/t'],
    ['GET', '/public-api/conversation_limit'],
    ['POST', 'https://chatgpt.com.evil.example/backend-api/conversation'],
    ['POST', 'https://ab.chatgpt.com/backend-api/conversation'],
    ['POST', 'http://chatgpt.com/backend-api/conversation'],
  ];
  for (const [method, url] of rejected) {
    assert.equal(classifyEndpoint(method, url, O), null, `${method} ${url}`);
  }
  assert.equal(classifyEndpoint('GET', '::bad::', 'not an origin'), null);
});

test('backend request detection is same-origin /backend-api/ only', () => {
  assert.equal(isBackendRequest('/backend-api/me', O), true);
  assert.equal(isBackendRequest('https://cdn.oaistatic.com/backend-api/x', O), false);
  assert.equal(isBackendRequest('/api/auth/session', O), false);
});

test('route conversation ids', () => {
  assert.equal(conversationIdFromRoute(`${O}/c/${ID}`, O), ID);
  assert.equal(conversationIdFromRoute(`${O}/c/${ID}?model=x#y`, O), ID);
  assert.equal(conversationIdFromRoute(`${O}/g/g-p-123abc-project/c/${ID}`, O), ID);
  assert.equal(conversationIdFromRoute(`${O}/`, O), null);
  assert.equal(conversationIdFromRoute(`${O}/c/WEB:1234`, O), null);
  assert.equal(conversationIdFromRoute(`${O}/c/${ID}/extra`, O), null);
  assert.equal(conversationIdFromRoute(`https://example.com/c/${ID}`, O), null);
  assert.equal(isConversationId(ID.toUpperCase()), true);
  assert.equal(isConversationId('memories'), false);
});

test('request body ids: envelope + last user message id only', () => {
  const body = JSON.stringify({
    action: 'next',
    conversation_id: ID,
    parent_message_id: 'p-1',
    messages: [
      { id: 'sys', author: { role: 'system' }, content: { parts: ['x'] } },
      { id: 'u-2', author: { role: 'user' }, content: { content_type: 'text', parts: ['hello'] } },
    ],
  });
  assert.deepEqual(readStreamRequestIds(body), { conversationId: ID, userMessageId: 'u-2', parentMessageId: 'p-1' });
  assert.deepEqual(readStreamRequestIds(JSON.stringify({ conversation_id: 'WEB:temp', messages: [] })),
    { conversationId: null, userMessageId: null, parentMessageId: null });
  for (const garbage of [null, '', '{', '[]', '"x"', 42, JSON.stringify({ messages: 'no' }), 'x'.repeat(1024 * 1024 + 1)]) {
    assert.deepEqual(readStreamRequestIds(garbage), { conversationId: null, userMessageId: null, parentMessageId: null });
  }
  assert.equal(readStreamRequestIds(JSON.stringify({ parent_message_id: 'has space' })).parentMessageId, null);
});
