import test from 'node:test';
import assert from 'node:assert/strict';
import { messageNodeToView, upsertLiveMessage, contentToText, getToolMessageInfo, messageProtocolIdentity } from '../core.js';
const raw = (extra = {}) => ({ id: 'm', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['正文'] }, ...extra });
const views = (message) => [messageNodeToView({ id: 'm', message }, {}), upsertLiveMessage([], message, { textMode: 'snapshot' })[0]];
const progress = { initial_text: 'Thinking', finished_text: 'Finished' };

test('turn-wide progress labels must not erase user, commentary or final text', () => {
  for (const extra of [
    { author: { role: 'user' } },
    { channel: 'final', end_turn: true },
    { channel: 'commentary' },
    {},
  ]) for (const view of views(raw({ ...extra, metadata: progress }))) {
    assert.equal(view.role, extra.author?.role || 'assistant');
    assert.equal(view.text, '正文');
    assert.equal(view.thought, null);
  }
  assert.equal(contentToText({ parts: ['普通正文'] }, progress), '普通正文');
});

test('explicit analysis text is a reasoning item, while an analysis-channel tool call remains a tool', () => {
  for (const view of views(raw({ channel: 'analysis' }))) {
    assert.equal(view.thought, '正文');
    assert.equal(view.text, '');
    assert.equal(view.tool, null);
  }
  const call = raw({ channel: 'analysis', recipient: 'web.run', call_id: 'call', metadata: progress });
  for (const view of views(call)) {
    assert.equal(view.tool.kind, 'tool-call');
    assert.equal(view.thought, null);
  }
});

test('tool-result identity beats generic async/progress metadata', () => {
  const result = raw({ author: { role: 'tool' }, tool_call_id: 'call', metadata: { ...progress, async_source: 'worker', cot_version: 'v5' } });
  for (const view of views(result)) {
    assert.equal(view.role, 'tool');
    assert.equal(view.tool.kind, 'tool-result');
    assert.equal(view.tool.payload, '正文');
  }
});

test('malformed display metadata cannot abort message ingestion', () => {
  const message = raw({ author: { role: 'tool' }, metadata: { reasoning_title: { unexpected: true } } });
  assert.equal(getToolMessageInfo(message).title, null);
  assert.equal(views(message)[0].text, '正文');
});

test('booleans, arrays and whitespace are not protocol sequence numbers or output indices', () => {
  for (const value of [true, false, [], [7], '  ', {}, Infinity]) {
    const identity = messageProtocolIdentity(raw({ sequence_number: value, output_index: value, content_index: value }));
    assert.equal(identity.sequenceNumber, null);
    assert.equal(identity.outputIndex, null);
    assert.equal(identity.contentIndex, null);
  }
  assert.equal(messageProtocolIdentity(raw({ sequence_number: '12' })).sequenceNumber, 12);
});
