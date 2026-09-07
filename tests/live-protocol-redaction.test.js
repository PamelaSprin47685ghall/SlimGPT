import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/live-smoke.mjs', import.meta.url), 'utf8');
const declaration = source.match(/^const SENSITIVE_DUMP_KEY = .*;$/m)?.[0];
const start = source.indexOf('function sanitizeDumpString(');
const end = source.indexOf('function prepareLiveProtocolDump(', start);
assert.ok(declaration && start >= 0 && end > start);
const redact = new Function(`${declaration}\n${source.slice(start, end)}\nreturn sanitizeLiveDumpValue;`)();

test('read-only diagnostics redact nested credential objects inside serialized response bodies', () => {
  const result = redact({ data: JSON.stringify({
    type: 'resume_conversation_token', resume_conversation_token: 'synthetic-resume-secret',
    conversation_conduit_metadata: { value: 'synthetic-conduit-secret' },
    message: { content: { parts: ['preserve the actual response'] } },
  }) });
  const body = JSON.parse(result.data);
  assert.equal(body.type, 'resume_conversation_token');
  assert.equal(body.resume_conversation_token, '[REDACTED]');
  assert.equal(body.conversation_conduit_metadata, '[REDACTED]');
  assert.deepEqual(body.message.content.parts, ['preserve the actual response']);
  assert.equal(JSON.stringify(result).includes('synthetic-'), false);
});

test('diagnostic URLs never retain query credentials, fragments or basic-auth credentials', () => {
  const result = redact({ pageUrl: 'https://user:password@example.com/c/id?token=synthetic-secret#private', url: 'https://example.com/backend-api/conversations/id?num_turns=100' });
  assert.equal(result.pageUrl, 'https://example.com/c/id');
  assert.equal(result.url, 'https://example.com/backend-api/conversations/id');
});

test('SSE diagnostic text retains event structure without raw resume tokens', () => {
  const result = redact({ data: 'data: {"type":"resume_conversation_token","resume_conversation_token":"synthetic-secret"}\n\n' });
  assert.equal(result.data.includes('"type":"resume_conversation_token"'), true);
  assert.equal(result.data.includes('synthetic-secret'), false);
});
