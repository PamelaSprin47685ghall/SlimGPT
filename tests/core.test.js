import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationView,
  consumeSse,
  conversationIdFromUrl,
  extractConversationItems,
  extractModelsList,
  extractThought,
  findConversationPayload,
  getThinkingLevel,
  getToolMessageInfo,
  groupConversationTurns,
  messageNodeToView,
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

test('conversation turns keep each user question with its following replies', () => {
  const turns = groupConversationTurns([
    { id: 'u1', role: 'user', text: 'question one' },
    { id: 'a1', role: 'assistant', text: 'answer one' },
    { id: 'tool1', role: 'tool', text: 'tool detail' },
    { id: 'u2', role: 'user', text: 'question two' },
    { id: 'a2', role: 'assistant', text: 'answer two' },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].user.text, 'question one');
  assert.deepEqual(turns[0].replies.map((message) => message.text), ['answer one', 'tool detail']);
  assert.equal(turns[1].user.text, 'question two');
  assert.deepEqual(turns[1].replies.map((message) => message.text), ['answer two']);
});

test('transient thinking indicators stay after tool activity', () => {
  const turns = groupConversationTurns([
    { id: 'u1', role: 'user', text: 'research this' },
    { id: 'thinking', role: 'assistant', text: '', status: 'in_progress', isThinking: true },
    { id: 'call', role: 'assistant', text: '', tool: { kind: 'call', name: 'web.run' } },
    { id: 'result', role: 'tool', text: 'result', tool: { kind: 'result', name: 'web.run' } },
  ]);

  assert.deepEqual(turns[0].replies.map((message) => message.id), ['call', 'result', 'thinking']);
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

test('tool calls and tool results are classified from message structure, not arbitrary JSON text', () => {
  const call = getToolMessageInfo({
    author: { role: 'assistant' },
    recipient: 'web.run',
    content: {
      content_type: 'code',
      language: 'json',
      text: '{"search_query":[{"q":"SlimGPT"}]}',
    },
  });
  assert.equal(call.kind, 'tool-call');
  assert.equal(call.name, 'web.run');
  assert.equal(call.payload, '{"search_query":[{"q":"SlimGPT"}]}');

  const result = getToolMessageInfo({
    author: { role: 'tool', name: 'web.run' },
    content: {
      content_type: 'text',
      parts: ['{"ok":true,"items":[1,2]}'],
    },
  });
  assert.equal(result.kind, 'tool-result');
  assert.equal(result.name, 'web.run');

  assert.equal(getToolMessageInfo({
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: ['```json\n{"ordinary":true}\n```'] },
  }), null, 'ordinary assistant JSON must remain normal Markdown');
});

test('extractThought extracts reasoning from metadata or content parts', () => {
  const fromMeta = extractThought({
    metadata: { thought: 'Let me think about this step by step.' },
  });
  assert.equal(fromMeta, 'Let me think about this step by step.');

  const fromParts = extractThought({
    content: {
      parts: [
        { content_type: 'thought', text: 'Analyzing math problem.' },
        'Final answer is 42.',
      ],
    },
  });
  assert.equal(fromParts, 'Analyzing math problem.');

  const none = extractThought({
    content: { parts: ['Just normal text'] },
  });
  assert.equal(none, null);
});

test('messageNodeToView handles empty messages and identifies thinking state', () => {
  const node = {
    id: 'msg-thinking',
    parent: 'root',
    message: {
      id: 'msg-thinking',
      author: { role: 'assistant' },
      content: { parts: [''] },
      status: 'in_progress',
      metadata: { model_slug: 'gpt-5.6', reasoning_effort: 'high' },
    },
  };
  const view = messageNodeToView(node, { root: { children: ['msg-thinking'] }, 'msg-thinking': node });
  assert.equal(view.isThinking, true);
  assert.equal(view.text, '');
  assert.equal(view.model, 'gpt-5.6');
  assert.equal(view.reasoningEffort, 'high');
  assert.equal(view.error, false);
});

test('upsertLiveMessage preserves reasoning thoughts and model metadata during streaming', () => {
  const initial = upsertLiveMessage([], {
    id: 'stream-1',
    author: { role: 'assistant' },
    content: { parts: [{ content_type: 'thought', text: 'Step 1' }] },
    status: 'in_progress',
    metadata: { model_slug: 'gpt-5.6-pro' },
  });
  assert.equal(initial[0].thought, 'Step 1');
  assert.equal(initial[0].model, 'gpt-5.6-pro');
  assert.equal(initial[0].isThinking, true);

  const streamed = upsertLiveMessage(initial, {
    id: 'stream-1',
    author: { role: 'assistant' },
    content: { parts: ['Here is the answer.'] },
    status: 'finished_successfully',
    metadata: { model_slug: 'gpt-5.6-pro' },
  });
  assert.equal(streamed[0].text, 'Here is the answer.');
  assert.equal(streamed[0].thought, 'Step 1');
  assert.equal(streamed[0].isThinking, false);
});

test('extractModelsList extracts and normalizes models from ChatGPT /backend-api/models', () => {
  const payload = {
    models: [
      {
        slug: 'gpt-5.6',
        title: 'GPT-5.6 Sol',
        description: 'Unified flagship reasoning model',
        tags: ['gpt-5.6', 'multimodal', 'reasoning'],
      },
      {
        slug: 'gpt-5.6-pro',
        title: 'GPT-5.6 Sol Pro',
        description: 'Maximum reasoning effort model',
        tags: ['reasoning', 'gpt-5.6-pro'],
        qualitative_properties: { reasoning_effort: ['none', 'medium', 'high', 'xhigh', 'max'] },
      },
    ],
  };
  const models = extractModelsList(payload);
  assert.equal(models.length, 2);
  assert.equal(models[0].slug, 'gpt-5.6');
  assert.equal(models[0].isReasoning, true);
  assert.equal(models[1].slug, 'gpt-5.6-pro');
  assert.equal(models[1].isReasoning, true);
});

test('getThinkingLevel resolves 5-level thinking slider from instant to pro', () => {
  const instant = getThinkingLevel(1);
  assert.equal(instant.id, 'instant');
  assert.equal(instant.level, 1);

  const medium = getThinkingLevel('medium');
  assert.equal(medium.id, 'medium');
  assert.equal(medium.level, 2);

  const high = getThinkingLevel('high');
  assert.equal(high.id, 'high');
  assert.equal(high.level, 3);

  const extraHigh = getThinkingLevel('extra_high');
  assert.equal(extraHigh.id, 'extra_high');
  assert.equal(extraHigh.level, 4);

  const pro = getThinkingLevel(5);
  assert.equal(pro.id, 'pro');
  assert.equal(pro.level, 5);
});
