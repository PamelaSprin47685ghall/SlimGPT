import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationView,
  consumeSse,
  conversationIdFromUrl,
  extractConversationItems,
  findConversationPayload,
  parseWebMobilePartialConversation,
  stepConversationBranch,
  upsertLiveMessage,
} from '../core.js';

const payload = {
  id: 'conv-1',
  title: 'Demo',
  current_node: 'a2',
  mapping: {
    root: { id: 'root', parent: null, children: ['u1'] },
    u1: { id: 'u1', parent: 'root', children: ['a1', 'a2'], message: { id: 'm-u1', author: { role: 'user' }, content: { parts: ['hello'] } } },
    a1: { id: 'a1', parent: 'u1', children: ['u2'], message: { id: 'm-a1', author: { role: 'assistant' }, content: { parts: ['branch one'] } } },
    u2: { id: 'u2', parent: 'a1', children: ['a3'], message: { id: 'm-u2', author: { role: 'user' }, content: { parts: ['follow up'] } } },
    a3: { id: 'a3', parent: 'u2', children: [], message: { id: 'm-a3', author: { role: 'assistant' }, content: { parts: ['deep leaf'] } } },
    a2: { id: 'a2', parent: 'u1', children: [], message: { id: 'm-a2', author: { role: 'assistant' }, content: { parts: ['branch two'] } } },
  },
};

test('conversation view follows current parent chain', () => {
  assert.deepEqual(buildConversationView(payload).map((message) => message.text), ['hello', 'branch two']);
});

test('branch stepping descends through selected sibling to a leaf', () => {
  const terminal = stepConversationBranch(payload, 'a2', -1);
  assert.equal(terminal, 'a3');
  assert.deepEqual(buildConversationView(payload, terminal).map((message) => message.text), ['hello', 'branch one', 'follow up', 'deep leaf']);
});

test('SSE parser preserves partial chunks', () => {
  const first = consumeSse('', 'data: {"message":{"id":"m1"', false);
  assert.equal(first.frames.length, 0);
  const second = consumeSse(first.rest, ',"content":"x"}}\n\ndata: [DONE]\n\n', false);
  assert.equal(second.frames[0].json.message.id, 'm1');
  assert.equal(second.frames[1].data, '[DONE]');
});

test('payload/list discovery tolerates wrappers', () => {
  assert.equal(findConversationPayload({ data: { value: payload } }), payload);
  assert.equal(extractConversationItems({ data: { items: [{ id: 'c1', title: 'One', update_time: 2 }] } })[0].title, 'One');
});

test('conversation id parser supports UI and API URLs', () => {
  assert.equal(conversationIdFromUrl('https://chatgpt.com/c/abc-123'), 'abc-123');
  assert.equal(conversationIdFromUrl('https://chatgpt.com/uc/anon-123'), 'anon-123');
  assert.equal(conversationIdFromUrl('https://chatgpt.com/backend-api/conversation/xyz'), 'xyz');
});

test('web-mobile partial HTML becomes a canonical conversation graph', () => {
  const html = '<template><span data-conversation="{&quot;backendConversationId&quot;:&quot;conv-mobile&quot;,&quot;messages&quot;:[{&quot;content&quot;:&quot;hello &amp; hi&quot;,&quot;id&quot;:&quot;u1&quot;,&quot;role&quot;:&quot;user&quot;},{&quot;content&quot;:&quot;OK&quot;,&quot;id&quot;:&quot;a1&quot;,&quot;renderedHtml&quot;:&quot;&lt;p&gt;OK&lt;/p&gt;&quot;,&quot;role&quot;:&quot;assistant&quot;}],&quot;title&quot;:&quot;Mobile demo&quot;}"></span></template>';
  const parsed = parseWebMobilePartialConversation(html);
  assert.equal(parsed.id, 'conv-mobile');
  assert.equal(parsed.current_node, 'a1');
  assert.equal(parsed.mapping.a1.parent, 'u1');
  assert.deepEqual(buildConversationView(parsed).map((message) => message.text), ['hello & hi', 'OK']);
});

test('web-mobile parser tolerates invalid numeric HTML entities', () => {
  const html = '<span data-conversation="{&quot;backendConversationId&quot;:&quot;conv-invalid&quot;,&quot;messages&quot;:[],&quot;title&quot;:&quot;&#99999999;&quot;}"></span>';
  const parsed = parseWebMobilePartialConversation(html);
  assert.equal(parsed.id, 'conv-invalid');
  assert.equal(parsed.title, '\ufffd');
});

test('live streamed messages update in place', () => {
  const first = upsertLiveMessage([], { id: 'm1', author: { role: 'assistant' }, content: { parts: ['hel'] } });
  const second = upsertLiveMessage(first, { id: 'm1', author: { role: 'assistant' }, content: { parts: ['hello'] } });
  assert.equal(second.length, 1);
  assert.equal(second[0].text, 'hello');
});
