import test from 'node:test';
import assert from 'node:assert/strict';

import { compactObservationLedger, extensionStorageArea } from '../src/lib/storage.js';
import {
  buildConversationRecordView,
  hydrateConversationObservations,
  ingestConversationMessage,
  ingestConversationPayload,
} from '../core.js';

test('observation ledger preserves normalized reasoning/tool data but strips credential-shaped fields', () => {
  const ledger = compactObservationLedger([
    {
      id: 'conversation-a',
      observations: [
        {
          id: 'reasoning-1',
          role: 'assistant',
          thought: 'first half and second half',
          _rawMessage: {
            id: 'reasoning-1',
            author: { role: 'assistant' },
            content: { content_type: 'thought', parts: ['first half and second half'] },
            metadata: {
              reasoning_content: 'first half and second half',
              model_slug: 'gpt-5.6',
              access_token: 'MUST_NOT_PERSIST',
              resume_token: 'MUST_NOT_PERSIST',
            },
          },
        },
        {
          id: 'tool-1',
          role: 'assistant',
          tool: {
            kind: 'tool-call',
            name: 'web.run',
            payload: { function: { name: 'search', arguments: '{"query":"SlimGPT"}' } },
          },
          _rawMessage: {
            id: 'tool-1',
            author: { role: 'assistant' },
            recipient: 'web.run',
            tool_calls: [{ function: { name: 'search', arguments: '{"query":"SlimGPT"}' } }],
            metadata: { reasoning_title: 'Search' },
          },
        },
      ],
    },
  ]);

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].observations.length, 2);
  const serialized = JSON.stringify(ledger);
  assert.ok(serialized.includes('first half and second half'));
  assert.ok(serialized.includes('SlimGPT'));
  assert.equal(serialized.includes('MUST_NOT_PERSIST'), false);
  assert.equal(serialized.includes('access_token'), false);
  assert.equal(serialized.includes('resume_token'), false);
  assert.equal(serialized.includes('_rawMessage'), false);
});

test('observation ledger never creates a sliding message window inside a conversation', () => {
  const observations = Array.from({ length: 300 }, (_, index) => ({
    id: `message-${index}`,
    role: 'assistant',
    text: `message ${index}`,
    lastSeenAt: index + 1,
  }));
  const ledger = compactObservationLedger([{ id: 'conversation-a', observations }]);
  assert.equal(ledger[0].observations.length, 300);
  assert.equal(ledger[0].observations[0].id, 'message-0');
  assert.equal(ledger[0].observations.at(-1).id, 'message-299');
});

test('observation ledger evicts whole older conversations instead of trimming messages from newer ones', () => {
  const source = Array.from({ length: 26 }, (_, conversationIndex) => ({
    id: `conversation-${conversationIndex}`,
    observations: Array.from({ length: 3 }, (_, messageIndex) => ({
      id: `c${conversationIndex}-m${messageIndex}`,
      role: 'assistant',
      text: `conversation ${conversationIndex} message ${messageIndex}`,
      lastSeenAt: conversationIndex * 100 + messageIndex,
    })),
  }));
  const ledger = compactObservationLedger(source);
  assert.equal(ledger.length, 24);
  assert.deepEqual(ledger[0].observations.map((item) => item.id), ['c25-m0', 'c25-m1', 'c25-m2']);
  assert.equal(ledger.some((entry) => entry.id === 'conversation-0'), false);
  assert.equal(ledger.some((entry) => entry.id === 'conversation-1'), false);
  assert.ok(ledger.every((entry) => entry.observations.length === 3));
});

test('extension storage backend works for Chrome and Firefox extension origins without relying on iframe localStorage', () => {
  const chromeStorage = { get() {}, set() {} };
  const browserStorage = { get() {}, set() {} };
  assert.equal(
    extensionStorageArea('chrome-extension:', { storage: { local: chromeStorage } }, undefined),
    chromeStorage,
  );
  assert.equal(
    extensionStorageArea('moz-extension:', undefined, { storage: { local: browserStorage } }),
    browserStorage,
  );
  assert.equal(
    extensionStorageArea('https:', { storage: { local: chromeStorage } }, { storage: { local: browserStorage } }),
    null,
  );
});

test('persisted observation ledger round-trips full reasoning/tools across a short canonical reload', () => {
  let liveRecord = ingestConversationMessage(null, {
    id: 'reasoning-live',
    parent_id: 'old-answer',
    author: { role: 'assistant' },
    content: { content_type: 'thought', text: '先保留完整' },
    status: 'in_progress',
    create_time: 10,
  });
  liveRecord = ingestConversationMessage(liveRecord, {
    id: 'reasoning-live',
    parent_id: 'old-answer',
    author: { role: 'assistant' },
    content: { content_type: 'thought', text: '思考，不做滑窗。' },
    status: 'in_progress',
    create_time: 10,
  });
  liveRecord = ingestConversationMessage(liveRecord, {
    id: 'tool-call-live',
    parent_id: 'reasoning-live',
    author: { role: 'assistant' },
    recipient: 'web.run',
    content: { content_type: 'code', text: '{"query":"persist me"}' },
    create_time: 11,
  });
  liveRecord = ingestConversationMessage(liveRecord, {
    id: 'tool-result-live',
    parent_id: 'tool-call-live',
    author: { role: 'tool', name: 'web.run' },
    content: { parts: ['{"ok":true}'] },
    create_time: 12,
  });

  const persisted = compactObservationLedger([
    { id: 'conversation-a', observations: liveRecord.observations },
  ]);
  let restored = hydrateConversationObservations(null, persisted[0].observations);
  restored = ingestConversationPayload(restored, {
    id: 'conversation-a',
    current_node: 'latest-answer',
    metadata: { source: 'optimized-conversation' },
    mapping: {
      'latest-answer': {
        id: 'latest-answer',
        parent: null,
        children: [],
        message: {
          id: 'latest-answer',
          author: { role: 'assistant' },
          content: { parts: ['latest short-window answer'] },
          create_time: 13,
          status: 'finished_successfully',
          end_turn: true,
        },
      },
    },
  });

  const rows = buildConversationRecordView(restored);
  assert.ok(rows.some((row) => row.thought?.includes('先保留完整思考，不做滑窗。')));
  assert.ok(rows.some((row) => row.tool?.kind === 'tool-call' && JSON.stringify(row.tool.payload).includes('persist me')));
  assert.ok(rows.some((row) => row.tool?.kind === 'tool-result'));
  assert.ok(rows.some((row) => row.text === 'latest short-window answer'));
});
