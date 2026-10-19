import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../src/protocol/index.js';

function bigHistory(count) {
  const mapping = { root: { id: 'root', parent: null, children: [], message: null } };
  let parent = 'root';
  for (let index = 0; index < count; index += 1) {
    const id = `m${index}`;
    const role = index % 2 ? 'assistant' : 'user';
    const text = role === 'user' ? `Question ${index}?` : `Answer ${index} with **markdown** and a citation\uE200cite\uE202turn0search${index}\uE201.\n\n\`\`\`js\nconsole.log(${index});\n\`\`\``;
    mapping[id] = { id, parent, children: [], message: { id, author: { role }, content: { content_type: 'text', parts: [text] }, status: 'finished_successfully', create_time: index, metadata: { content_references: [{ matched_text: `\uE200cite\uE202turn0search${index}\uE201`, items: [{ url: `https://e.com/${index}`, title: 't' }] }] } } };
    mapping[parent].children.push(id);
    parent = id;
  }
  return JSON.stringify({ id: 'big', title: 'Big', current_node: parent, mapping });
}

test('performance: 1200-message history parse + selectTurns < 50 ms', () => {
  const body = bigHistory(1200);
  for (let warm = 0; warm < 3; warm += 1) P.selectTurns(P.parseConversation(body));
  const samples = [];
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now();
    const turns = P.selectTurns(P.parseConversation(body));
    samples.push(performance.now() - start);
    assert.equal(turns.length, 600);
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples[2] < 50, `median ${samples[2].toFixed(1)} ms`);
});

test('performance: streaming 5000 deltas into a 1200-message conversation stays fast', () => {
  let conversation = P.parseConversation(bigHistory(1200));
  let text = 'event: delta_encoding\ndata: "v1"\n\n';
  text += `event: delta\ndata: ${JSON.stringify({ p: '', o: 'add', v: { message: { id: 'live', author: { role: 'assistant' }, content: { content_type: 'text', parts: [''] }, status: 'in_progress', metadata: { parent_id: 'm1199' } }, conversation_id: 'big' }, c: 0 })}\n\n`;
  text += `event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"x"}\n\n`;
  for (let index = 0; index < 5000; index += 1) text += 'event: delta\ndata: {"v":"y"}\n\n';
  const start = performance.now();
  const decoder = P.createStreamDecoder();
  for (let index = 0; index < text.length; index += 512) {
    for (const event of decoder.push(text.slice(index, index + 512))) if (event.type === 'message') conversation = P.applyLiveMessage(conversation, event.raw);
  }
  const elapsed = performance.now() - start;
  assert.equal(conversation.nodes.get('live').message.blocks[0].markdown.length, 5001);
  assert.ok(elapsed < 3000, `${elapsed.toFixed(0)} ms`);
});
