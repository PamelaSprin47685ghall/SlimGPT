import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationRecordTimeline,
  buildConversationRecordTurns,
  buildConversationRecordView,
  buildConversationView,
  contentToText,
  consumeSse,
  createConversationSseDecoder,
  conversationIdFromUrl,
  conversationThinkingLevel,
  extractConversationItems,
  extractModelsList,
  extractThought,
  findConversationPayload,
  findConversationLifecycleEvents,
  findMessageEvents,
  fingerprintCapture,
  getThinkingLevel,
  getToolMessageInfo,
  groupConversationTimeline,
  groupConversationTurns,
  hasNonTextExtras,
  ingestConversationMessage,
  ingestConversationPayload,
  mergeConversationPayload,
  mergeConversationViewObservations,
  messageNodeToView,
  mergeProgressiveText,
  parseWebMobilePartialConversation,
  resolveConversationScope,
  isProvisionalConversationId,
  setConversationRecordTerminal,
  stepConversationBranch,
  upsertLiveMessage,
} from '../core.js';

test('conversation lifecycle events expose stable server ids without treating WEB client ids as ownership', () => {
  const events = findConversationLifecycleEvents({
    type: 'wrapper',
    payload: [
      {
        type: 'conversation_update',
        conversation_id: 'WEB:client-only',
        turn_exchange_id: 'turn-a',
      },
      {
        type: 'conversation_update',
        conversation_id: 'server-conversation',
        turn_exchange_id: 'turn-a',
      },
      {
        type: 'main_stream_complete',
        conversation_id: 'server-conversation',
        turn_exchange_id: 'turn-a',
      },
      {
        type: 'tool_update',
        conversation_id: 'unrelated-tool-conversation',
      },
    ],
  });

  assert.deepEqual(events.map((event) => [event.type, event.conversationId, event.turnId]), [
    ['main_stream_complete', 'server-conversation', 'turn-a'],
    ['conversation_update', 'server-conversation', 'turn-a'],
  ]);
});

test('message event scope ignores official WEB client ids when a stable server id appears below them', () => {
  const [event] = findMessageEvents({
    conversation_id: 'WEB:client-only',
    payload: {
      conversation_id: 'server-conversation',
      message: {
        id: 'assistant-1',
        author: { role: 'assistant' },
        content: { parts: ['stable'] },
      },
    },
  });
  assert.equal(event.conversationIdConflict, false);
  assert.equal(event.conversationId, 'server-conversation');
});

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

test('non-user preamble remains visible without creating a conversation page', () => {
  const timeline = groupConversationTimeline([
    { id: 'orphan', role: 'assistant', text: 'unassigned output' },
    { id: 'u1', role: 'user', text: 'question' },
    { id: 'a1', role: 'assistant', text: 'answer' },
  ]);

  assert.deepEqual(timeline.turns.map((turn) => turn.user.id), ['u1']);
  assert.deepEqual(timeline.unresolved.map((message) => message.id), ['orphan']);
});

test('explicit turn identity wins over misleading parent timing when attaching live output', () => {
  let record = ingestConversationPayload(null, {
    id: 'turn-identity',
    current_node: 'a2',
    mapping: {
      u1: { id: 'u1', parent: null, children: ['a1'], message: { id: 'u1', author: { role: 'user' }, content: { parts: ['first'] } } },
      a1: { id: 'a1', parent: 'u1', children: ['u2'], message: { id: 'a1', author: { role: 'assistant' }, content: { parts: ['first answer'] } } },
      u2: { id: 'u2', parent: 'a1', children: ['a2'], message: { id: 'u2', author: { role: 'user' }, content: { parts: ['last question'] }, metadata: { turn_exchange_id: 'turn-last' } } },
      a2: { id: 'a2', parent: 'u2', children: [], message: { id: 'a2', author: { role: 'assistant' }, content: { parts: ['last answer prefix'] } } },
    },
  });
  record = ingestConversationMessage(record, {
    id: 'reason-last',
    parent_id: 'a1',
    author: { role: 'assistant' },
    content: { content_type: 'thought', text: 'belongs to the last turn' },
    metadata: { turn_exchange_id: 'turn-last' },
  }, {
    observationOrdinal: 1,
  });
  record = ingestConversationMessage(record, {
    id: 'tool-last',
    parent_id: 'reason-last',
    author: { role: 'assistant' },
    recipient: 'web.run',
    content: { content_type: 'code', text: '{"q":"last"}' },
    metadata: { turn_exchange_id: 'turn-last' },
  }, {
    observationOrdinal: 2,
  });

  const turns = buildConversationRecordTurns(record);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].replies.map((item) => item.id), ['a1']);
  assert.deepEqual(turns[1].replies.map((item) => item.id), ['a2', 'reason-last', 'tool-last']);
});

test('unassigned live output stays in a tail bucket instead of contaminating the first turn', () => {
  let record = ingestConversationPayload(null, {
    id: 'unassigned-tail',
    current_node: 'a2',
    mapping: {
      u1: { id: 'u1', parent: null, children: ['a1'], message: { id: 'u1', author: { role: 'user' }, content: { parts: ['first'] } } },
      a1: { id: 'a1', parent: 'u1', children: ['u2'], message: { id: 'a1', author: { role: 'assistant' }, content: { parts: ['first answer'] } } },
      u2: { id: 'u2', parent: 'a1', children: ['a2'], message: { id: 'u2', author: { role: 'user' }, content: { parts: ['second'] } } },
      a2: { id: 'a2', parent: 'u2', children: [], message: { id: 'a2', author: { role: 'assistant' }, content: { parts: ['second answer'] } } },
    },
  });
  record = ingestConversationMessage(record, {
    id: 'orphan-tool',
    author: { role: 'tool', name: 'web.run' },
    content: { parts: ['orphan result'] },
  }, { observationOrdinal: 10 });

  const timeline = buildConversationRecordTimeline(record);
  assert.equal(timeline.turns.length, 2);
  assert.deepEqual(timeline.turns[0].replies.map((item) => item.id), ['a1']);
  assert.deepEqual(timeline.turns[1].replies.map((item) => item.id), ['a2']);
  assert.equal(timeline.unresolved.length, 1);
  assert.deepEqual(timeline.unresolved[0].replies.map((item) => item.id), ['orphan-tool']);
});

test('only canonical user messages create pages across a tool-heavy turn stream', () => {
  const inheritedTurnMetadata = {
    async_source: 'saserver-prod:conversation-turn-shared:EU',
    cot_version: 'v5',
  };
  const payload = findConversationPayload({
    id: 'corpus-page-invariant',
    conversation_id: 'corpus-page-invariant',
    current_node: 'final-3',
    messages: [
      {
        id: 'user-1', author: { role: 'user' },
        content: { content_type: 'text', parts: ['one'] },
        metadata: inheritedTurnMetadata,
      },
      {
        id: 'final-1', author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['answer one'] },
        metadata: { ...inheritedTurnMetadata, parent_id: 'user-1' },
      },
      {
        id: 'user-2', author: { role: 'user' },
        content: { content_type: 'text', parts: ['two'] },
        metadata: { ...inheritedTurnMetadata, parent_id: 'final-1' },
      },
      {
        id: 'call-2', author: { role: 'assistant' }, recipient: 'api_tool.call_tool',
        content: { content_type: 'code', text: '{"name":"read"}' },
        metadata: { ...inheritedTurnMetadata, parent_id: 'user-2' },
      },
      {
        id: 'result-2', author: { role: 'tool', name: 'api_tool.call_tool' },
        content: { content_type: 'code', text: '{"ok":true}' },
        metadata: { ...inheritedTurnMetadata, parent_id: 'call-2' },
      },
      {
        id: 'user-3', author: { role: 'user' },
        content: { content_type: 'text', parts: ['three'] },
        metadata: { ...inheritedTurnMetadata, parent_id: 'result-2' },
      },
      {
        id: 'final-3', author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['answer three'] },
        metadata: { ...inheritedTurnMetadata, parent_id: 'user-3' },
      },
      {
        id: 'orphan-output', author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['unknown owner'] },
      },
    ],
  });
  const record = ingestConversationPayload(null, payload, { canonicalComplete: true });

  const timeline = buildConversationRecordTimeline(record);
  assert.deepEqual(timeline.turns.map((turn) => turn.user.id), ['user-1', 'user-2', 'user-3']);
  assert.deepEqual(timeline.turns[1].replies.map((reply) => reply.tool?.kind), ['tool-call', 'tool-result']);
  assert.equal(timeline.unresolved.length, 1);
  assert.deepEqual(timeline.unresolved[0].replies.map((reply) => reply.id), ['orphan-output']);
});

test('a genuinely ambiguous parent without semantic identity stays unassigned', () => {
  let record = ingestConversationPayload(null, {
    id: 'ambiguous-parent', current_node: 'u2',
    mapping: {
      u1: { id: 'u1', parent: null, children: ['u2'], message: { id: 'u1', author: { role: 'user' }, content: { parts: ['first'] } } },
      u2: { id: 'u2', parent: 'u1', children: [], message: { id: 'u2', author: { role: 'user' }, content: { parts: ['second'] } } },
    },
  });
  record = ingestConversationMessage(record, {
    id: 'shared-parent', author: { role: 'assistant' }, content: { parts: ['first-bound parent'] },
  }, { turnUserMessageId: 'u1', responseId: 'response-one', phase: 'commentary', observationOrdinal: 1 });
  record = ingestConversationMessage(record, {
    id: 'shared-parent', author: { role: 'assistant' }, content: { parts: ['second-bound parent'] },
  }, { turnUserMessageId: 'u2', responseId: 'response-two', phase: 'final', observationOrdinal: 2 });
  record = ingestConversationMessage(record, {
    id: 'ambiguous-child', parent_id: 'shared-parent', author: { role: 'tool', name: 'web.run' }, content: { parts: ['unknown owner'] },
  }, { observationOrdinal: 3 });

  const timeline = buildConversationRecordTimeline(record);
  assert.equal(timeline.turns[0].replies.some((item) => item.id === 'ambiguous-child'), false);
  assert.equal(timeline.turns[1].replies.some((item) => item.id === 'ambiguous-child'), false);
  assert.equal(timeline.unresolved.at(-1).source, 'unassigned');
  assert.deepEqual(timeline.unresolved.at(-1).replies.map((item) => item.id), ['ambiguous-child']);
});

test('partial canonical pages remain hidden until the full canonical sync is complete', () => {
  let record = ingestConversationPayload(null, {
    id: 'partial-hidden',
    current_node: 'a2',
    metadata: { source: 'optimized-conversation' },
    mapping: {
      u2: { id: 'u2', parent: null, children: ['a2'], message: { id: 'u2', author: { role: 'user' }, content: { parts: ['middle question'] } } },
      a2: { id: 'a2', parent: 'u2', children: [], message: { id: 'a2', author: { role: 'assistant' }, content: { parts: ['middle answer'] } } },
    },
  }, { canonicalComplete: false });
  const provisionalTimeline = buildConversationRecordTimeline(record);
  assert.equal(provisionalTimeline.turns.length, 0, 'an incomplete page must not invent a historical user turn');
  assert.equal(provisionalTimeline.unresolved.length, 1);
  assert.deepEqual(provisionalTimeline.unresolved[0].replies.map((reply) => reply.text), ['middle answer']);

  record = ingestConversationPayload(record, {
    id: 'partial-hidden',
    current_node: 'a2',
    mapping: {
      u1: { id: 'u1', parent: null, children: ['a1'], message: { id: 'u1', author: { role: 'user' }, content: { parts: ['first question'] } } },
      a1: { id: 'a1', parent: 'u1', children: ['u2'], message: { id: 'a1', author: { role: 'assistant' }, content: { parts: ['first answer'] } } },
      u2: { id: 'u2', parent: 'a1', children: ['a2'], message: { id: 'u2', author: { role: 'user' }, content: { parts: ['middle question'] } } },
      a2: { id: 'a2', parent: 'u2', children: [], message: { id: 'a2', author: { role: 'assistant' }, content: { parts: ['middle answer'] } } },
    },
  }, { canonicalComplete: true });
  assert.deepEqual(buildConversationRecordTurns(record).map((turn) => turn.user.text), ['first question', 'middle question']);
});

test('paginated canonical pages reconnect an external parent across page boundaries', () => {
  const oldest = findConversationPayload({
    id: 'paged',
    conversation_id: 'paged',
    current_node: 'a1',
    messages: [
      { id: 'u1', author: { role: 'user' }, content: { parts: ['oldest question'] } },
      { id: 'a1', author: { role: 'assistant' }, content: { parts: ['oldest answer'] }, metadata: { parent_id: 'u1' } },
    ],
  });
  const newest = findConversationPayload({
    id: 'paged',
    conversation_id: 'paged',
    current_node: 'a2',
    messages: [
      { id: 'u2', author: { role: 'user' }, content: { parts: ['newest question'] }, metadata: { parent_id: 'a1' } },
      { id: 'a2', author: { role: 'assistant' }, content: { parts: ['newest answer'] }, metadata: { parent_id: 'u2' } },
    ],
  });
  assert.equal(newest.mapping.u2.parent, 'a1', 'a parent outside the current page must not be erased');

  let record = ingestConversationPayload(null, oldest, { canonicalComplete: false });
  record = ingestConversationPayload(record, newest, { canonicalComplete: true });
  const turns = buildConversationRecordTurns(record);
  assert.deepEqual(turns.map((turn) => turn.user.text), ['oldest question', 'newest question']);
  assert.deepEqual(turns[1].replies.map((reply) => reply.text), ['newest answer']);
});

test('three canonical pages preserve parent topology across both page boundaries', () => {
  const oldest = findConversationPayload({
    id: 'paged-three', conversation_id: 'paged-three', current_node: 'a1',
    messages: [
      { id: 'u1', author: { role: 'user' }, content: { parts: ['one'] } },
      { id: 'a1', author: { role: 'assistant' }, content: { parts: ['answer one'] }, metadata: { parent_id: 'u1' } },
    ],
  });
  const middle = findConversationPayload({
    id: 'paged-three', conversation_id: 'paged-three', current_node: 'a2',
    messages: [
      { id: 'u2', author: { role: 'user' }, content: { parts: ['two'] }, metadata: { parent_id: 'a1' } },
      { id: 'a2', author: { role: 'assistant' }, content: { parts: ['answer two'] }, metadata: { parent_id: 'u2' } },
    ],
  });
  const newest = findConversationPayload({
    id: 'paged-three', conversation_id: 'paged-three', current_node: 'a3',
    messages: [
      { id: 'u3', author: { role: 'user' }, content: { parts: ['three'] }, metadata: { parent_id: 'a2' } },
      { id: 'a3', author: { role: 'assistant' }, content: { parts: ['answer three'] }, metadata: { parent_id: 'u3' } },
    ],
  });

  let record = ingestConversationPayload(null, oldest, { canonicalComplete: false });
  record = ingestConversationPayload(record, middle, { canonicalComplete: false });
  record = ingestConversationPayload(record, newest, { canonicalComplete: true });
  const turns = buildConversationRecordTurns(record);
  assert.deepEqual(turns.map((turn) => turn.user?.text), ['one', 'two', 'three']);
  assert.deepEqual(turns.map((turn) => turn.replies.at(-1)?.text), ['answer one', 'answer two', 'answer three']);
});

test('an incomplete newest canonical page never fabricates its page head as conversation history', () => {
  const newestOnly = findConversationPayload({
    id: 'paged-failed', conversation_id: 'paged-failed', current_node: 'a3',
    messages: [
      { id: 'u3', author: { role: 'user' }, content: { parts: ['page-local user'] }, metadata: { parent_id: 'a2' } },
      { id: 'a3', author: { role: 'assistant' }, content: { parts: ['page-local answer'] }, metadata: { parent_id: 'u3' } },
    ],
  });
  const record = ingestConversationPayload(null, newestOnly, { canonicalComplete: false });
  const timeline = buildConversationRecordTimeline(record);
  assert.equal(timeline.turns.length, 0);
  assert.equal(timeline.unresolved.length, 1);
  assert.deepEqual(timeline.unresolved[0].replies.map((reply) => reply.id), ['a3']);
});

test('non-monotonic create_time never changes turn ownership or output-item order', () => {
  let record = ingestConversationPayload(null, {
    id: 'non-monotonic-time',
    current_node: 'second-user',
    mapping: {
      'first-user': {
        id: 'first-user',
        parent: null,
        children: ['second-user'],
        message: {
          id: 'first-user',
          author: { role: 'user' },
          content: { parts: ['first'] },
          create_time: 900,
        },
      },
      'second-user': {
        id: 'second-user',
        parent: 'first-user',
        children: [],
        message: {
          id: 'second-user',
          author: { role: 'user' },
          content: { parts: ['second'] },
          metadata: { turn_exchange_id: 'turn-second' },
          create_time: 1,
        },
      },
    },
  });
  record = ingestConversationMessage(record, {
    id: 'time-final',
    author: { role: 'assistant' },
    content: { parts: ['final'] },
    metadata: { turn_exchange_id: 'turn-second' },
    create_time: 2,
  }, { responseId: 'time-response', outputIndex: 2, sequenceNumber: 30, observationOrdinal: 1 });
  record = ingestConversationMessage(record, {
    id: 'time-reasoning',
    author: { role: 'assistant' },
    content: { content_type: 'thought', text: 'reasoning' },
    metadata: { turn_exchange_id: 'turn-second' },
    create_time: 999,
  }, { responseId: 'time-response', outputIndex: 0, sequenceNumber: 10, observationOrdinal: 2 });
  record = ingestConversationMessage(record, {
    id: 'time-tool',
    author: { role: 'assistant' },
    recipient: 'web.run',
    content: { content_type: 'code', text: '{"q":"time"}' },
    metadata: { turn_exchange_id: 'turn-second' },
    create_time: -100,
  }, { responseId: 'time-response', outputIndex: 1, sequenceNumber: 20, observationOrdinal: 3 });

  const turns = buildConversationRecordTurns(record);
  assert.deepEqual(turns.map((turn) => turn.user?.id), ['first-user', 'second-user']);
  assert.deepEqual(turns[0].replies, []);
  assert.deepEqual(turns[1].replies.map((item) => item.id), [
    'time-reasoning',
    'time-tool',
    'time-final',
  ]);
});

test('reasoning commentary and final remain distinct output items even when message ids repeat', () => {
  let record = ingestConversationPayload(null, {
    id: 'same-message-items', current_node: 'u1',
    mapping: {
      u1: {
        id: 'u1', parent: null, children: [],
        message: { id: 'u1', author: { role: 'user' }, content: { parts: ['research'] }, metadata: { turn_exchange_id: 'turn-items' } },
      },
    },
  });
  const common = { responseId: 'response-items' };
  record = ingestConversationMessage(record, {
    id: 'shared-output', author: { role: 'assistant' },
    content: { content_type: 'thought', text: 'reasoning item' },
    metadata: { turn_exchange_id: 'turn-items' },
  }, { ...common, phase: 'reasoning', outputIndex: 0, sequenceNumber: 9, observationOrdinal: 1 });
  record = ingestConversationMessage(record, {
    id: 'shared-output', author: { role: 'assistant' },
    content: { content_type: 'text', parts: ['commentary item'] },
    metadata: { turn_exchange_id: 'turn-items' },
  }, { ...common, phase: 'commentary', outputIndex: 1, sequenceNumber: 3, observationOrdinal: 2 });
  record = ingestConversationMessage(record, {
    id: 'shared-output', author: { role: 'assistant' },
    content: { content_type: 'text', parts: ['final item'] },
    metadata: { turn_exchange_id: 'turn-items' },
    status: 'finished_successfully', end_turn: true,
  }, { ...common, phase: 'final', outputIndex: 2, sequenceNumber: 1, observationOrdinal: 3 });

  const turns = buildConversationRecordTurns(record);
  assert.equal(record.observations.length, 3);
  assert.equal(new Set(record.observations.map((item) => item.observationKey)).size, 3);
  assert.deepEqual(turns[0].replies.map((item) => item.phase), ['reasoning', 'commentary', 'final']);
  assert.equal(turns[0].replies[0].thought, 'reasoning item');
  assert.equal(turns[0].replies[2].text, 'final item');
});

test('multiple tool calls pair by explicit call id even when results arrive out of order', () => {
  let record = ingestConversationPayload(null, {
    id: 'parallel-tools', current_node: 'u1',
    mapping: {
      u1: { id: 'u1', parent: null, children: [], message: { id: 'u1', author: { role: 'user' }, content: { parts: ['parallel tools'] } } },
    },
  });
  record = ingestConversationMessage(record, {
    id: 'call-one', author: { role: 'assistant' },
    tool_calls: [{ id: 'call-1', function: { name: 'web.run', arguments: '{"q":"one"}' } }], content: { parts: [] },
  }, { turnUserMessageId: 'u1', responseId: 'response-tools', outputIndex: 0, observationOrdinal: 1 });
  record = ingestConversationMessage(record, {
    id: 'call-two', author: { role: 'assistant' },
    tool_calls: [{ id: 'call-2', function: { name: 'web.run', arguments: '{"q":"two"}' } }], content: { parts: [] },
  }, { responseId: 'response-tools', outputIndex: 1, observationOrdinal: 2 });
  record = ingestConversationMessage(record, {
    id: 'result-two', call_id: 'call-2', author: { role: 'tool', name: 'web.run' }, content: { parts: ['two result'] },
  }, { responseId: 'response-tools', outputIndex: 3, observationOrdinal: 3 });
  record = ingestConversationMessage(record, {
    id: 'result-one', call_id: 'call-1', author: { role: 'tool', name: 'web.run' }, content: { parts: ['one result'] },
  }, { responseId: 'response-tools', outputIndex: 2, observationOrdinal: 4 });

  const replies = buildConversationRecordTurns(record)[0].replies;
  assert.deepEqual(replies.map((item) => item.id), ['call-one', 'call-two', 'result-one', 'result-two']);
  assert.equal(replies.find((item) => item.id === 'result-one').tool.callId, 'call-1');
  assert.equal(replies.find((item) => item.id === 'result-two').tool.callId, 'call-2');
});

test('ownership converges when a response-linked tool result is observed before its turn anchor', () => {
  let record = ingestConversationPayload(null, {
    id: 'late-anchor', current_node: 'u1',
    mapping: {
      u1: { id: 'u1', parent: null, children: [], message: { id: 'u1', author: { role: 'user' }, content: { parts: ['late anchor'] } } },
    },
  });
  record = ingestConversationMessage(record, {
    id: 'early-result', call_id: 'call-late', author: { role: 'tool', name: 'web.run' }, content: { parts: ['arrived first'] },
  }, { responseId: 'response-late-anchor', observationOrdinal: 1 });
  record = ingestConversationMessage(record, {
    id: 'late-call', author: { role: 'assistant' },
    tool_calls: [{ id: 'call-late', function: { name: 'web.run', arguments: '{"q":"late"}' } }], content: { parts: [] },
  }, { turnUserMessageId: 'u1', responseId: 'response-late-anchor', observationOrdinal: 2 });

  const turns = buildConversationRecordTurns(record);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].replies.map((item) => item.id), ['late-call', 'early-result']);
});

test('a resumed transport segment continues the response-bound logical turn', () => {
  let record = ingestConversationPayload(null, {
    id: 'resume-turn', current_node: 'u1',
    mapping: {
      u1: { id: 'u1', parent: null, children: [], message: { id: 'u1', author: { role: 'user' }, content: { parts: ['continue'] } } },
    },
  });
  record = ingestConversationMessage(record, {
    id: 'initial-item', author: { role: 'assistant' }, content: { parts: ['initial segment'] },
  }, {
    turnUserMessageId: 'u1', responseId: 'response-resume', transportTurnId: 'transport-initial', outputIndex: 0,
  });
  record = ingestConversationMessage(record, {
    id: 'resume-item', author: { role: 'assistant' }, content: { parts: ['resume segment'] },
  }, {
    responseId: 'response-resume', transportTurnId: 'transport-resume', outputIndex: 1,
  });
  const turns = buildConversationRecordTurns(record);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].replies.map((item) => item.id), ['initial-item', 'resume-item']);
});

test('transport session ids never leak ownership into the immediately following turn', () => {
  let record = ingestConversationPayload(null, {
    id: 'transport-isolation', current_node: 'u2',
    mapping: {
      u1: { id: 'u1', parent: null, children: ['u2'], message: { id: 'u1', author: { role: 'user' }, content: { parts: ['first'] } } },
      u2: { id: 'u2', parent: 'u1', children: [], message: { id: 'u2', author: { role: 'user' }, content: { parts: ['second'] } } },
    },
  });
  record = ingestConversationMessage(record, {
    id: 'old-tool', author: { role: 'assistant' }, recipient: 'web.run', content: { text: '{"q":"old"}' },
  }, { turnUserMessageId: 'u1', transportTurnId: 'transport-reused', responseId: 'old-response', outputIndex: 0 });
  record = ingestConversationMessage(record, {
    id: 'old-result', call_id: 'old-call', author: { role: 'tool', name: 'web.run' }, content: { parts: ['old result'] },
  }, { turnUserMessageId: 'u1', transportTurnId: 'transport-reused', responseId: 'old-response', outputIndex: 1 });
  record = ingestConversationMessage(record, {
    id: 'new-final', author: { role: 'assistant' }, content: { parts: ['new answer'] },
  }, { turnUserMessageId: 'u2', transportTurnId: 'transport-reused', responseId: 'new-response', outputIndex: 0 });

  const turns = buildConversationRecordTurns(record);
  assert.deepEqual(turns.map((turn) => turn.user?.id), ['u1', 'u2']);
  assert.deepEqual(turns[0].replies.map((item) => item.id), ['old-tool', 'old-result']);
  assert.deepEqual(turns[1].replies.map((item) => item.id), ['new-final']);
});

test('user_editable_context and model_editable_context never create visible empty turns', () => {
  const record = ingestConversationPayload(null, {
    id: 'internal-context',
    current_node: 'final',
    mapping: {
      u1: {
        id: 'u1', parent: null, children: ['ctx-user'],
        message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['real question'] } },
      },
      'ctx-user': {
        id: 'ctx-user', parent: 'u1', children: ['sys'],
        message: { id: 'ctx-user', author: { role: 'user' }, content: { content_type: 'user_editable_context', parts: ['internal'] } },
      },
      sys: {
        id: 'sys', parent: 'ctx-user', children: ['developer'],
        message: { id: 'sys', author: { role: 'system' }, content: { content_type: 'text', parts: ['system'] } },
      },
      developer: {
        id: 'developer', parent: 'sys', children: ['ctx-model'],
        message: { id: 'developer', author: { role: 'developer' }, content: { content_type: 'text', parts: ['hidden developer instruction'] } },
      },
      'ctx-model': {
        id: 'ctx-model', parent: 'developer', children: ['thought'],
        message: { id: 'ctx-model', author: { role: 'assistant' }, content: { content_type: 'model_editable_context', parts: ['internal model context'] } },
      },
      thought: {
        id: 'thought', parent: 'ctx-model', children: ['final'],
        message: { id: 'thought', author: { role: 'assistant' }, content: { content_type: 'thought', text: 'reasoning' } },
      },
      final: {
        id: 'final', parent: 'thought', children: [],
        message: { id: 'final', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['final answer'] } },
      },
    },
  });
  const turns = buildConversationRecordTurns(record);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user.text, 'real question');
  assert.deepEqual(turns[0].replies.map((reply) => reply.id), ['thought', 'final']);
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

test('persistent observations stay stored but only render on the branch they are anchored to', () => {
  let record = ingestConversationPayload(null, payload);
  record = ingestConversationMessage(record, {
    id: 'latest-branch-tool',
    parent_id: 'a2',
    author: { role: 'assistant' },
    recipient: 'web.run',
    content: { content_type: 'code', text: '{"branch":"latest"}' },
  });
  record = ingestConversationMessage(record, {
    id: 'old-branch-tool',
    parent_id: 'a3',
    author: { role: 'assistant' },
    recipient: 'web.run',
    content: { content_type: 'code', text: '{"branch":"old"}' },
  });
  record = setConversationRecordTerminal(record, 'a3');
  const rows = buildConversationRecordView(record);
  assert.equal(rows.some((row) => row.id === 'latest-branch-tool'), false);
  assert.equal(rows.some((row) => row.id === 'old-branch-tool'), true);
  assert.equal(record.observations.length, 2, 'branch filtering must never delete the stored ledger');
});

test('SSE parser preserves partial chunks', () => {
  const first = consumeSse('', 'data: {"message":{"id":"m1"', false);
  assert.equal(first.frames.length, 0);
  const second = consumeSse(first.rest, ',"content":"x"}}\n\ndata: [DONE]\n\n', false);
  assert.equal(second.frames[0].json.message.id, 'm1');
  assert.equal(second.frames[1].data, '[DONE]');
});

test('official v1 delta events reconstruct immutable per-channel conversation snapshots', () => {
  const decoder = createConversationSseDecoder();
  assert.equal(decoder.decode({ event: 'delta_encoding', data: '"v1"', json: null }), null);

  const first = decoder.decode({
    event: 'delta',
    json: {
      v: {
        conversation_id: 'delta-conversation',
        message: {
          id: 'delta-message',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['hello'] },
          status: 'in_progress',
        },
      },
    },
  });
  const second = decoder.decode({
    event: 'delta',
    json: { p: '/message/content/parts/0', o: 'append', v: ' world' },
  });
  const otherChannel = decoder.decode({
    event: 'delta',
    json: { c: 1, p: '', o: 'add', v: { type: 'side-channel', value: 1 } },
  });
  const finished = decoder.decode({
    event: 'delta',
    json: { c: 0, p: '/message/status', o: 'replace', v: 'finished_successfully' },
  });

  assert.equal(first.message.content.parts[0], 'hello', 'later deltas must not mutate an emitted snapshot');
  assert.equal(second.message.content.parts[0], 'hello world');
  assert.deepEqual(otherChannel, { type: 'side-channel', value: 1 });
  assert.equal(finished.message.content.parts[0], 'hello world');
  assert.equal(finished.message.status, 'finished_successfully');
});

test('capture identity keeps authoritative canonical completion distinct from an observed duplicate response', () => {
  const body = '{"conversation_id":"same"}';
  const observed = fingerprintCapture({
    requestId: 'fetch-observed',
    url: 'https://chatgpt.com/backend-api/conversations/same',
    transport: 'fetch',
    conversationId: 'same',
  }, body);
  const canonical = fingerprintCapture({
    requestId: 'sync-authoritative-1',
    canonicalSyncId: 'sync-authoritative',
    canonicalPageIndex: 0,
    canonicalComplete: true,
    url: 'https://chatgpt.com/backend-api/conversations/same',
    transport: 'fetch',
    conversationId: 'same',
  }, body);
  assert.notEqual(observed, canonical);
});

test('payload/list discovery tolerates wrappers', () => {
  assert.equal(findConversationPayload({ data: { value: payload } }), payload);
  assert.equal(extractConversationItems({ data: { items: [{ id: 'c1', title: 'One', update_time: 2 }] } })[0].title, 'One');
});

test('progressive text merge preserves deltas, snapshots, and overlap without truncation', () => {
  assert.equal(mergeProgressiveText('alpha', 'alphabet'), 'alphabet');
  assert.equal(mergeProgressiveText('alphabet', 'alpha'), 'alphabet');
  assert.equal(mergeProgressiveText('thinking about the pro', 'problem now'), 'thinking about the problem now');
  assert.equal(mergeProgressiveText('先分析', '问题，再继续'), '先分析问题，再继续');
});

test('DOM snapshot observations replace visible text instead of being appended as deltas', () => {
  let rows = upsertLiveMessage([], {
    id: 'dom-snapshot',
    author: { role: 'assistant' },
    content: { parts: ['snapshot one'] },
  }, { textMode: 'snapshot' });
  rows = upsertLiveMessage(rows, {
    id: 'dom-snapshot',
    author: { role: 'assistant' },
    content: { parts: ['snapshot two'] },
  }, { textMode: 'snapshot' });
  assert.equal(rows[0].text, 'snapshot two');
});

test('thought content is classified only as reasoning and never as assistant answer text', () => {
  const message = {
    id: 'thought-only',
    author: { role: 'assistant' },
    content: { content_type: 'thought', text: '完整的思考内容' },
    status: 'in_progress',
  };
  assert.equal(contentToText(message.content), '');
  assert.equal(extractThought(message), '完整的思考内容');
});

test('message discovery coalesces repeated same-id reasoning updates inside one transport frame', () => {
  const events = findMessageEvents({
    conversation_id: 'reasoning-c',
    updates: [
      {
        message: {
          id: 'reasoning-1',
          author: { role: 'assistant' },
          content: { content_type: 'thought', text: '先分析' },
          status: 'in_progress',
        },
      },
      {
        message: {
          id: 'reasoning-1',
          author: { role: 'assistant' },
          content: { content_type: 'thought', text: '问题，再继续推理。' },
          status: 'in_progress',
        },
      },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(extractThought(events[0].message), '先分析问题，再继续推理。');
});

test('message discovery preserves distinct protocol items that reuse one message id', () => {
  const events = findMessageEvents({
    conversation_id: 'same-id-events',
    events: [
      {
        response_id: 'response-same-id', output_index: 0, phase: 'reasoning',
        message: {
          id: 'shared-message', author: { role: 'assistant' },
          content: { content_type: 'thought', text: 'reasoning' },
        },
      },
      {
        response_id: 'response-same-id', output_index: 1, phase: 'commentary',
        message: {
          id: 'shared-message', author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['commentary'] },
        },
      },
      {
        response_id: 'response-same-id', output_index: 2, phase: 'final',
        message: {
          id: 'shared-message', author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['final'] },
        },
      },
    ],
  });
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.outputIndex), [0, 1, 2]);
  assert.deepEqual(events.map((event) => event.phase), ['reasoning', 'commentary', 'final']);
});

test('legacy observation merge also refuses to collapse distinct same-id protocol items', () => {
  const rows = mergeConversationViewObservations([], [
    {
      id: 'same-id', role: 'assistant', contentType: 'thought', thought: 'reasoning',
      responseId: 'response-legacy', outputIndex: 0, phase: 'reasoning',
    },
    {
      id: 'same-id', role: 'assistant', contentType: 'text', text: 'final',
      responseId: 'response-legacy', outputIndex: 1, phase: 'final',
    },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.phase), ['reasoning', 'final']);
});

test('generic canonical assistant rows merge with concrete text snapshots of the same message id', () => {
  let record = ingestConversationPayload(null, {
    id: 'generic-snapshot',
    current_node: 'a1',
    mapping: {
      u1: {
        id: 'u1', parent: null, children: ['a1'],
        message: { id: 'u1', author: { role: 'user' }, content: { parts: ['question'] } },
      },
      a1: {
        id: 'a1', parent: 'u1', children: [],
        message: { id: 'a1', author: { role: 'assistant' }, content: { parts: ['answer'] } },
      },
    },
  });
  record = ingestConversationMessage(record, {
    id: 'a1',
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: ['answer'] },
  }, { textMode: 'snapshot' });

  const turns = buildConversationRecordTurns(record);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].replies.map((row) => row.id), ['a1']);
});

test('conflicting semantic aliases fail closed instead of falling back to a misleading parent', () => {
  let record = ingestConversationPayload(null, {
    id: 'semantic-conflict', current_node: 'a2',
    mapping: {
      u1: { id: 'u1', parent: null, children: ['a1'], message: { id: 'u1', author: { role: 'user' }, content: { parts: ['one'] }, metadata: { turn_exchange_id: 'turn-one' } } },
      a1: { id: 'a1', parent: 'u1', children: ['u2'], message: { id: 'a1', author: { role: 'assistant' }, content: { parts: ['answer one'] } } },
      u2: { id: 'u2', parent: 'a1', children: ['a2'], message: { id: 'u2', author: { role: 'user' }, content: { parts: ['two'] }, metadata: { turn_exchange_id: 'turn-two' } } },
      a2: { id: 'a2', parent: 'u2', children: [], message: { id: 'a2', author: { role: 'assistant' }, content: { parts: ['answer two'] } } },
    },
  });
  record = ingestConversationMessage(record, {
    id: 'conflicted-live', parent_id: 'a1', author: { role: 'assistant' }, content: { parts: ['must stay unresolved'] },
  }, { turnAliases: ['turn-one', 'turn-two'], observationOrdinal: 1 });

  const timeline = buildConversationRecordTimeline(record);
  assert.equal(timeline.turns[0].replies.some((item) => item.id === 'conflicted-live'), false);
  assert.equal(timeline.turns[1].replies.some((item) => item.id === 'conflicted-live'), false);
  assert.equal(timeline.unresolved.at(-1).source, 'unassigned');
  assert.equal(timeline.unresolved.at(-1).replies[0].id, 'conflicted-live');
});

test('same-id streamed tool arguments accumulate instead of replacing earlier fragments', () => {
  let record = ingestConversationMessage(null, {
    id: 'tool-call-stream',
    author: { role: 'assistant' },
    tool_calls: [{ id: 'call-1', function: { name: 'web.run', arguments: '{"query":"Slim' } }],
    content: { parts: [] },
  });
  record = ingestConversationMessage(record, {
    id: 'tool-call-stream',
    author: { role: 'assistant' },
    tool_calls: [{ id: 'call-1', function: { name: 'web.run', arguments: 'GPT","limit":3}' } }],
    content: { parts: [] },
  });
  const [row] = buildConversationRecordView(record);
  assert.equal(row.tool?.payload?.function?.arguments, '{"query":"SlimGPT","limit":3}');
});

test('conversation record keeps non-canonical tool observations in protocol order across short canonical windows', () => {
  const basePayload = {
    id: 'record-c',
    current_node: 'a1',
    mapping: {
      u1: {
        id: 'u1', parent: null, children: ['a1'],
        message: { id: 'u1', author: { role: 'user' }, content: { parts: ['question'] }, create_time: 1 },
      },
      a1: {
        id: 'a1', parent: 'u1', children: [],
        message: { id: 'a1', author: { role: 'assistant' }, content: { parts: ['first answer'] }, create_time: 2 },
      },
    },
  };
  let record = ingestConversationPayload(null, basePayload);
  record = ingestConversationMessage(record, {
    id: 'tool-live-1',
    parent_id: 'a1',
    author: { role: 'assistant' },
    recipient: 'web.run',
    content: { text: '{"query":"one"}' },
    create_time: 300,
  }, { outputIndex: 0, sequenceNumber: 30, observationOrdinal: 1 });
  record = ingestConversationMessage(record, {
    id: 'tool-live-result-1',
    parent_id: 'tool-live-1',
    author: { role: 'tool', name: 'web.run' },
    content: { parts: ['{"ok":true}'] },
    create_time: 100,
  }, { outputIndex: 1, sequenceNumber: 10, observationOrdinal: 2 });
  record = ingestConversationPayload(record, {
    id: 'record-c',
    current_node: 'a2',
    metadata: { source: 'optimized-conversation' },
    mapping: {
      a2: {
        id: 'a2', parent: null, children: [],
        message: {
          id: 'a2',
          author: { role: 'assistant' },
          content: { parts: ['latest answer'] },
          metadata: { output_index: 2, sequence_number: 20 },
          create_time: 50,
        },
      },
    },
  });
  const rows = buildConversationRecordView(record);
  assert.deepEqual(rows.map((row) => row.id), ['u1', 'a1', 'tool-live-1', 'tool-live-result-1', 'a2']);
  assert.equal(rows[2].tool?.name, 'web.run');
  assert.equal(rows[3].tool?.kind, 'tool-result');
});

test('partial conversation payloads extend cached history instead of replacing it', () => {
  const partial = {
    id: 'conv-1',
    current_node: 'a4',
    metadata: { source: 'web-mobile-partial' },
    mapping: {
      u3: {
        id: 'u3',
        parent: null,
        children: ['a4'],
        message: { id: 'm-u3', author: { role: 'user' }, content: { parts: ['new question'] } },
      },
      a4: {
        id: 'a4',
        parent: 'u3',
        children: [],
        message: { id: 'm-a4', author: { role: 'assistant' }, content: { parts: ['new answer'] } },
      },
    },
  };

  const merged = mergeConversationPayload(payload, partial);
  assert.equal(merged.mapping.u3.parent, 'a2');
  assert.ok(merged.mapping.a2.children.includes('u3'));
  assert.equal(merged.current_node, 'a4');
  assert.deepEqual(
    buildConversationView(merged).map((message) => message.text),
    ['hello', 'branch two', 'new question', 'new answer'],
  );
});

test('late partial payloads cannot move the active conversation backwards or onto a stale branch', () => {
  const stalePartial = {
    id: 'conv-1',
    current_node: 'a1',
    metadata: { source: 'web-mobile-partial' },
    mapping: {
      u1: {
        id: 'u1',
        parent: null,
        children: ['a1'],
        message: { id: 'm-u1', author: { role: 'user' }, content: { parts: ['hello'] } },
      },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: [],
        message: { id: 'm-a1', author: { role: 'assistant' }, content: { parts: ['branch one'] } },
      },
    },
  };

  const merged = mergeConversationPayload(payload, stalePartial);
  assert.equal(merged.current_node, 'a2');
  assert.deepEqual(buildConversationView(merged).map((message) => message.text), ['hello', 'branch two']);
  assert.equal(merged.mapping.u1.parent, 'root');
});

test('message discovery carries the enclosing conversation identity into nested events', () => {
  const [event] = findMessageEvents({
    conversation_id: 'conversation-a',
    payload: {
      update: {
        message: {
          id: 'assistant-a',
          author: { role: 'assistant' },
          content: { parts: ['only A'] },
        },
      },
    },
  });

  assert.equal(event.conversationId, 'conversation-a');
  assert.equal(event.conversationIdConflict, false);
});

test('message discovery marks conflicting nested conversation identities unsafe', () => {
  const [event] = findMessageEvents({
    conversation_id: 'conversation-a',
    payload: {
      conversation_id: 'conversation-b',
      message: {
        id: 'assistant-conflict',
        author: { role: 'assistant' },
        content: { parts: ['must be dropped'] },
      },
    },
  });

  assert.equal(event.conversationId, null);
  assert.equal(event.conversationIdConflict, true);
});

test('message discovery never deduplicates across conversation boundaries', () => {
  const events = findMessageEvents([
    {
      conversation_id: 'conversation-a',
      message: {
        id: 'shared-message-id',
        author: { role: 'assistant' },
        content: { parts: ['A'] },
      },
    },
    {
      conversation_id: 'conversation-b',
      message: {
        id: 'shared-message-id',
        author: { role: 'assistant' },
        content: { parts: ['B'] },
      },
    },
  ]);

  assert.deepEqual(events.map((event) => event.conversationId), [
    'conversation-a',
    'conversation-b',
  ]);
});

test('conversation scope resolution fails closed when identity signals disagree', () => {
  assert.deepEqual(resolveConversationScope('conversation-a', 'conversation-a'), {
    conversationId: 'conversation-a',
    conflicted: false,
  });
  assert.deepEqual(resolveConversationScope('conversation-a', 'conversation-b'), {
    conversationId: null,
    conflicted: true,
  });
  assert.deepEqual(resolveConversationScope(null, ''), {
    conversationId: null,
    conflicted: false,
  });
});

test('WEB optimistic conversation ids never conflict with the real server conversation id', () => {
  assert.equal(isProvisionalConversationId('WEB:edbf28b7-2cfd-4c92-93b9-159366f631d7'), true);
  assert.deepEqual(
    resolveConversationScope('WEB:temporary-client-id', '6a981f4a-0bc0-83eb-b61c-b6692d63b50c'),
    { conversationId: '6a981f4a-0bc0-83eb-b61c-b6692d63b50c', conflicted: false },
  );
  assert.equal(conversationIdFromUrl('https://chatgpt.com/c/WEB:temporary-client-id'), null);
});

test('official older /messages pages are canonical even without current_node or conversation_id', () => {
  const page = findConversationPayload({
    messages: [
      {
        id: 'old-user',
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['old question'] },
        metadata: { turn_exchange_id: 'turn-old', working_turn_id: 'turn-old' },
      },
      {
        id: 'old-thought',
        author: { role: 'assistant' },
        content: { content_type: 'thoughts', thoughts: [{ content: 'old reasoning' }] },
        metadata: { turn_exchange_id: 'turn-old', working_turn_id: 'turn-old' },
      },
    ],
    page_info: {
      start_cursor: 'old-user',
      end_cursor: 'old-thought',
      has_previous_page: true,
      has_next_page: true,
    },
  }, { conversationId: 'real-conversation' });

  assert.equal(page.conversation_id, 'real-conversation');
  assert.equal(page.current_node, null);
  assert.deepEqual(page.message_order, ['old-user', 'old-thought']);
  assert.equal(page.mapping['old-thought'].parent, null);
});

test('real ChatGPT canonical item stream keeps null-parent thoughts tools and final in one semantic turn', () => {
  const turn = 'turn-real-shape';
  const record = ingestConversationPayload(null, findConversationPayload({
    conversation_id: 'real-shape',
    current_node: 'final',
    messages: [
      {
        id: 'user',
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['question'] },
        metadata: { turn_exchange_id: turn, working_turn_id: turn },
      },
      {
        id: 'thought',
        author: { role: 'assistant' },
        content: { content_type: 'thoughts', thoughts: [{ content: 'reasoning survives' }] },
        metadata: { turn_exchange_id: turn, working_turn_id: turn },
      },
      {
        id: 'call',
        author: { role: 'assistant' },
        recipient: 'api_tool.call_tool',
        content: { content_type: 'code', text: '{"name":"web.run"}' },
        metadata: { turn_exchange_id: turn, working_turn_id: turn },
      },
      {
        id: 'result',
        author: { role: 'tool', name: 'api_tool.call_tool' },
        content: { content_type: 'code', text: '{"ok":true}' },
        metadata: { turn_exchange_id: turn, working_turn_id: turn },
      },
      {
        id: 'final',
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['final answer'] },
        metadata: { turn_exchange_id: turn, working_turn_id: turn },
        status: 'finished_successfully',
        end_turn: true,
      },
    ],
    page_info: { has_previous_page: false, has_next_page: false },
  }), { canonicalComplete: true });

  const turns = buildConversationRecordTurns(record);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user.id, 'user');
  assert.deepEqual(turns[0].replies.map((row) => row.id), ['thought', 'call', 'result', 'final']);
  assert.ok(turns[0].replies.find((row) => row.id === 'thought')?.thought?.includes('reasoning survives'));
  assert.equal(turns[0].replies.find((row) => row.id === 'call')?.tool?.kind, 'tool-call');
  assert.equal(turns[0].replies.find((row) => row.id === 'result')?.tool?.kind, 'tool-result');
});

test('canonical sync pages stage transactionally and replace the previous complete item order only when complete', () => {
  let record = ingestConversationPayload(null, findConversationPayload({
    conversation_id: 'sync-stage',
    current_node: 'old-a',
    messages: [
      { id: 'old-u', author: { role: 'user' }, content: { parts: ['old'] } },
      { id: 'old-a', author: { role: 'assistant' }, content: { parts: ['old answer'] }, metadata: { parent_id: 'old-u' } },
    ],
  }), { canonicalComplete: true });

  const firstPage = findConversationPayload({
    messages: [{ id: 'new-u', author: { role: 'user' }, content: { parts: ['new'] } }],
    page_info: { has_previous_page: false, has_next_page: true },
  }, { conversationId: 'sync-stage' });
  record = ingestConversationPayload(record, firstPage, {
    canonicalSyncId: 'sync-2',
    canonicalPageIndex: 0,
    canonicalComplete: false,
  });
  assert.deepEqual(record.payload.message_order, ['old-u', 'old-a'], 'an incomplete refresh must keep the previous authoritative history visible');

  const lastPage = findConversationPayload({
    conversation_id: 'sync-stage',
    current_node: 'new-a',
    messages: [{ id: 'new-a', author: { role: 'assistant' }, content: { parts: ['new answer'] }, metadata: { parent_id: 'new-u' } }],
    page_info: { has_previous_page: true, has_next_page: false },
  });
  record = ingestConversationPayload(record, lastPage, {
    canonicalSyncId: 'sync-2',
    canonicalPageIndex: 1,
    canonicalComplete: true,
  });
  assert.deepEqual(record.payload.message_order, ['new-u', 'new-a']);
});

test('conversation id parser supports UI and API URLs', () => {
  assert.equal(conversationIdFromUrl('https://chatgpt.com/c/abc-123'), 'abc-123');
  assert.equal(conversationIdFromUrl('https://chatgpt.com/uc/anon-123'), 'anon-123');
  assert.equal(conversationIdFromUrl('https://chatgpt.com/backend-api/conversation/xyz'), 'xyz');
  assert.equal(conversationIdFromUrl('https://chatgpt.com/backend-api/conversations/xyz'), 'xyz');
  assert.equal(conversationIdFromUrl('https://chatgpt.com/backend-api/f/conversation/resume'), null);
  assert.equal(conversationIdFromUrl('https://chatgpt.com/unauth-mweb/conversation/updates'), null);
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

test('stable item identity merges progressive snapshots even when transport message ids change', () => {
  let rows = upsertLiveMessage([], {
    id: 'snapshot-a', author: { role: 'assistant' }, content: { parts: ['hel'] },
  }, { itemId: 'item-stable', responseId: 'response-stable', outputIndex: 0 });
  rows = upsertLiveMessage(rows, {
    id: 'snapshot-b', author: { role: 'assistant' }, content: { parts: ['hello'] },
  }, { itemId: 'item-stable', responseId: 'response-stable', outputIndex: 0 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'snapshot-b');
  assert.equal(rows[0].itemId, 'item-stable');
  assert.equal(rows[0].text, 'hello');
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

  assert.equal(getToolMessageInfo({
    author: { role: 'assistant', metadata: { real_author: 'tool:web' } },
    recipient: 'all',
    channel: 'final',
    content: { content_type: 'text', parts: ['Final answer after web search'] },
  }), null, 'tool provenance on a final assistant message must not turn the answer into a tool result');
});

test('turn-scoped async metadata never reclassifies users, tools, system context, or final output', () => {
  const inheritedTurnMetadata = {
    async_source: 'saserver-prod:conversation-turn-semantic-id:EU',
    cot_version: 'v5',
  };
  const view = (id, message) => {
    const node = {
      id,
      parent: null,
      children: [],
      message: {
        id,
        ...message,
        metadata: {
          ...inheritedTurnMetadata,
          ...(message.metadata || {}),
        },
      },
    };
    return messageNodeToView(node, { [id]: node });
  };

  const user = view('corpus-user', {
    author: { role: 'user' },
    content: { content_type: 'text', parts: ['real user message'] },
  });
  assert.equal(user.role, 'user');
  assert.equal(user.text, 'real user message');
  assert.equal(user.thought, null);

  const call = view('corpus-call', {
    author: { role: 'assistant' },
    recipient: 'api_tool.call_tool',
    content: { content_type: 'code', text: '{"name":"read"}' },
  });
  assert.equal(call.tool?.kind, 'tool-call');
  assert.equal(call.tool?.name, 'api_tool.call_tool');
  assert.equal(call.thought, null);

  const result = view('corpus-result', {
    author: { role: 'tool', name: 'api_tool.call_tool' },
    content: { content_type: 'code', text: '{"ok":true}' },
  });
  assert.equal(result.role, 'tool');
  assert.equal(result.tool?.kind, 'tool-result');
  assert.equal(result.thought, null);

  const final = view('corpus-final', {
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: ['final assistant output'] },
    end_turn: true,
  });
  assert.equal(final.role, 'assistant');
  assert.equal(final.text, 'final assistant output');
  assert.equal(final.thought, null);
  assert.equal(final.tool, null);

  const system = view('corpus-system', {
    author: { role: 'system' },
    content: { content_type: 'text', parts: ['internal context'] },
  });
  assert.equal(system.role, 'system');
  assert.equal(system.thought, null);
  assert.equal(system.tool, null);
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

test('status-less DOM echoes cannot regress a finished live message', () => {
  const finished = upsertLiveMessage([], {
    id: 'stream-finished',
    author: { role: 'assistant' },
    content: { parts: ['Complete answer'] },
    status: 'finished_successfully',
    end_turn: true,
  });
  const echoed = upsertLiveMessage(finished, {
    id: 'stream-finished',
    author: { role: 'assistant' },
    content: { parts: ['Complete answer'] },
    status: null,
    end_turn: null,
  });
  assert.equal(echoed[0].status, 'finished_successfully');
  assert.equal(echoed[0].endTurn, true);
  assert.equal(echoed[0].isThinking, false);
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

test('hasNonTextExtras recognizes non-text message payloads instead of showing thinking', () => {
  assert.equal(hasNonTextExtras({ content: { content_type: 'text', parts: ['plain'] } }), false);
  assert.equal(hasNonTextExtras({ content: { content_type: 'text', parts: [''] } }), false);
  assert.equal(hasNonTextExtras({ content: { content_type: 'text', parts: [] } }), false, 'a plain empty text message stays an empty message, not extras');
  assert.equal(hasNonTextExtras({ content: { content_type: 'multimodal_text', parts: [{ asset_pointer: 'file-service://abc', content_type: 'image_asset_pointer' }] } }), true);
  assert.equal(hasNonTextExtras({ content: { content_type: 'audio_transcript', parts: [{ transcript: 'hi' }] } }), false, 'transcript-only parts already render through partToText');
  assert.equal(hasNonTextExtras({ content: { content_type: 'real_time_user_audio_video_asset_pointer', parts: [{ asset_pointer: 'video://x' }] } }), true);
  assert.equal(hasNonTextExtras({ content: { content_type: 'system_error', name: 'system_error', text: 'boom' } }), false, 'error content carries text and is surfaced as an error, not extras');
  assert.equal(hasNonTextExtras({ content: { content_type: 'execution_output', text: '...' } }), false);
  assert.equal(hasNonTextExtras({ content: { files: [{ name: 'a.pdf' }] } }), true);
  assert.equal(hasNonTextExtras({ content: null }), false);
});

test('messageNodeToView keeps non-text live messages visible instead of a perpetual thinking spinner', () => {
  const view = messageNodeToView({
    id: 'n1',
    message: {
      id: 'm1',
      author: { role: 'assistant' },
      content: { content_type: 'multimodal_text', parts: [{ asset_pointer: 'file-service://img' }] },
      status: 'finished_successfully',
    },
  }, { n1: { id: 'n1', message: null } });
  assert.equal(view.isThinking, false, 'attachment messages must not be labeled as thinking');
  assert.ok(view.text.includes('file-service://img'), 'attachment pointer becomes a readable label');

  const emptyLive = upsertLiveMessage([], {
    id: 'm2',
    author: { role: 'assistant' },
    content: { content_type: 'text', parts: [''] },
    status: 'in_progress',
  });
  assert.equal(emptyLive[0].isThinking, true, 'genuinely empty in-progress stream still shows thinking');

  const unknownLive = upsertLiveMessage([], {
    id: 'm3',
    author: { role: 'assistant' },
    content: { content_type: 'unknown_future_type', parts: [''] },
    status: 'in_progress',
  });
  assert.equal(unknownLive[0].isThinking, false, 'unrecognized non-text content must not show a thinking spinner');
  assert.ok(unknownLive[0].text.length > 0 || unknownLive[0].unrecognized, 'unrecognized content stays visible with an explicit placeholder');
});

test('optimized conversation responses become canonical graphs with thinking effort', () => {
  const optimized = {
    conversation_id: 'optimized-1',
    title: 'Optimized',
    current_node: 'a1',
    messages: [
      {
        id: 'hidden',
        author: { role: 'system' },
        content: { content_type: 'text', parts: ['hidden setup'] },
        status: 'finished_successfully',
        metadata: { is_visually_hidden_from_conversation: true },
      },
      {
        id: 'u1',
        author: { role: 'user' },
        content: { content_type: 'text', parts: ['question'] },
        status: 'finished_successfully',
        metadata: { parent_id: 'hidden', thinking_effort: 'max' },
      },
      {
        id: 'a1',
        author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['answer'] },
        status: 'finished_successfully',
        end_turn: true,
        metadata: { parent_id: 'u1', thinking_effort: 'max' },
      },
    ],
  };

  const canonical = findConversationPayload(optimized);
  assert.equal(canonical.id, 'optimized-1');
  assert.equal(canonical.mapping.a1.parent, 'u1');
  assert.deepEqual(buildConversationView(canonical).map((message) => message.text), ['question', 'answer']);
  assert.equal(conversationThinkingLevel(canonical)?.level, 5);
});

test('conversationThinkingLevel derives the level from the conversation graph metadata', () => {
  const payload = {
    current_node: 'a1',
    mapping: {
      u1: { id: 'u1', parent: null, children: ['a1'], message: { id: 'mu', author: { role: 'user' }, content: { parts: ['q'] } } },
      a1: {
        id: 'a1',
        parent: 'u1',
        children: [],
        message: {
          id: 'ma',
          author: { role: 'assistant' },
          content: { parts: ['answer'] },
          metadata: { model_slug: 'gpt-5.6', reasoning_effort: 'xhigh' },
        },
      },
    },
  };
  assert.equal(conversationThinkingLevel(payload)?.level, 4);
  assert.equal(conversationThinkingLevel({ mapping: {} }), null);
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

test('extractThought extracts plural thoughts and reasoning_recap from real ChatGPT responses', () => {
  const pluralThoughts = extractThought({
    author: { role: 'assistant' },
    content: {
      content_type: 'thoughts',
      thoughts: [
        {
          summary: 'Designing automatic management',
          content: 'Focusing on integrating TriAttention with unified KV manager.',
          finished: true,
        },
        {
          summary: 'Protected shared context',
          content: '',
          finished: true,
        },
      ],
    },
  });
  assert.ok(pluralThoughts.includes('Designing automatic management'));
  assert.ok(pluralThoughts.includes('Focusing on integrating TriAttention'));
  assert.ok(pluralThoughts.includes('Protected shared context'));

  const recap = extractThought({
    author: { role: 'assistant' },
    content: {
      content_type: 'reasoning_recap',
      content: 'Worked for 8m 33s',
    },
  });
  assert.equal(recap, '⏱️ Worked for 8m 33s');
});

test('getToolMessageInfo extracts search result groups and reasoning titles', () => {
  const searchQuery = getToolMessageInfo({
    author: { role: 'tool', name: 'web.run' },
    content: { content_type: 'text', parts: [''] },
    metadata: {
      reasoning_title: 'Searching current date',
      search_model_queries: {
        type: 'search_model_queries',
        queries: ['current UTC date today'],
      },
    },
  });
  assert.deepEqual(searchQuery.payload, {
    type: 'search_model_queries',
    queries: ['current UTC date today'],
  });

  const searchResult = getToolMessageInfo({
    author: { role: 'tool', name: 'web.run' },
    content: {
      content_type: 'text',
      parts: [''],
    },
    metadata: {
      reasoning_title: 'Searching the web',
      search_queries: ['llama.cpp kv cache'],
      search_result_groups: [
        {
          type: 'search_result_group',
          domain: 'github.com',
          entries: [
            { title: 'llama.cpp KV cache', url: 'https://github.com/ggml-org/llama.cpp' },
          ],
        },
      ],
    },
  });
  assert.equal(searchResult.kind, 'tool-result');
  assert.equal(searchResult.name, 'web.run');
  assert.equal(searchResult.title, 'Searching the web');
  assert.deepEqual(searchResult.payload.queries, ['llama.cpp kv cache']);
  assert.equal(searchResult.payload.results.length, 1);
});

test('contentToText formats user attachments and cleans citation markers', () => {
  const userWithAttachment = messageNodeToView({
    id: 'u-attach',
    message: {
      id: 'u-attach',
      author: { role: 'user' },
      content: { content_type: 'text', parts: [''] },
      metadata: {
        attachments: [
          { name: 'config.json', size: 2048, mime_type: 'application/json' },
        ],
      },
    },
  }, { 'u-attach': { id: 'u-attach' } });

  assert.ok(userWithAttachment.text.includes('config.json'));
  assert.ok(userWithAttachment.text.includes('2.0 KB'));
  assert.equal(userWithAttachment.unrecognized, false);

  const textWithCitations = messageNodeToView({
    id: 'a-cite',
    message: {
      id: 'a-cite',
      author: { role: 'assistant' },
      content: {
        content_type: 'text',
        parts: ['According to research\uE200cite\uE202turn0search0\uE201, this holds true.'],
      },
    },
  }, { 'a-cite': { id: 'a-cite' } });

  assert.equal(textWithCitations.text, 'According to research, this holds true.');
});

test('messageNodeToView formats thinking duration and image asset pointer', () => {
  const imageMsg = messageNodeToView({
    id: 'm-img',
    message: {
      id: 'm-img',
      author: { role: 'user' },
      content: {
        content_type: 'multimodal_text',
        parts: [
          { content_type: 'image_asset_pointer', mime_type: 'image/png', width: 800, height: 600 },
        ],
      },
    },
  }, { 'm-img': { id: 'm-img' } });

  assert.ok(imageMsg.text.includes('800×600'));
  assert.equal(imageMsg.unrecognized, false);

  const durationView = messageNodeToView({
    id: 'm-duration',
    message: {
      id: 'm-duration',
      author: { role: 'assistant' },
      content: { content_type: 'thoughts', thoughts: [{ summary: 'Step 1', content: 'Details' }] },
      metadata: { finished_duration_sec: 125 },
    },
  }, { 'm-duration': { id: 'm-duration' } });

  assert.equal(durationView.thinkingDuration, '2 分 5 秒');
  assert.equal(durationView.unrecognized, false);
});

test('messageNodeToView classifies async reasoning worker messages as thinking rather than tool results', () => {
  const asyncReasoningNode = messageNodeToView({
    id: 'fab65083-1892-405f-ab6e-8473f6d4a839',
    message: {
      id: 'fab65083-1892-405f-ab6e-8473f6d4a839',
      author: { role: 'tool', name: 'a8km123' },
      content: { content_type: 'text', parts: [''] },
      status: 'in_progress',
      weight: 0,
      metadata: {
        initial_text: '正在推理',
        finished_text: '已完成推理',
        async_source: 'saserver-switzerlandwest-prod.fck9d:bon-user-vbaIGW9qbtKceRtsx4Fk2F13:EU',
        cot_version: 'v5',
      },
    },
  }, { 'fab65083-1892-405f-ab6e-8473f6d4a839': { id: 'fab65083-1892-405f-ab6e-8473f6d4a839' } });

  assert.equal(asyncReasoningNode.tool, null, 'async reasoning worker is not an external tool');
  assert.equal(asyncReasoningNode.role, 'assistant');
  assert.equal(asyncReasoningNode.isThinking, true);
  assert.equal(asyncReasoningNode.thought, '正在推理');

  const finishedAsyncTrace = messageNodeToView({
    id: '6fb2a1d5-2148-49d4-a886-94424f0ada8f',
    message: {
      id: '6fb2a1d5-2148-49d4-a886-94424f0ada8f',
      author: { role: 'tool', name: 'a8km123' },
      content: { content_type: 'text', parts: ['**查找网页资料**\n\n正在检索信息。'] },
      status: 'finished_successfully',
      weight: 0,
      metadata: {
        initial_text: '正在推理',
        finished_text: '思考了 18m 19s',
        async_source: 'saserver-switzerlandwest-prod.fck9d:bon-user-vbaIGW9qbtKceRtsx4Fk2F13:EU',
        cot_version: 'v5',
      },
    },
  }, { '6fb2a1d5-2148-49d4-a886-94424f0ada8f': { id: '6fb2a1d5-2148-49d4-a886-94424f0ada8f' } });

  assert.equal(finishedAsyncTrace.tool, null);
  assert.equal(finishedAsyncTrace.role, 'assistant');
  assert.equal(finishedAsyncTrace.isThinking, false);
  assert.ok(finishedAsyncTrace.thought.includes('查找网页资料'));
  assert.equal(finishedAsyncTrace.thinkingDuration, '18m 19s');
});
