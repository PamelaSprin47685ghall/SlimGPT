import test from 'node:test';
import assert from 'node:assert/strict';
import { renderContentReferences } from '../src/lib/content-references.js';
import { contentToText, upsertLiveMessage } from '../core.js';

const marker = '\uE200cite\uE202turn0search0\uE201';
test('citations resolve only to explicit metadata URLs and keep stable source numbering', () => {
  const metadata = { content_references: [{ matched_text: marker, items: [
    { title: 'Primary source', url: 'https://example.com/source' },
    { title: 'Primary source', url: 'https://example.com/source' },
  ] }] };
  const text = renderContentReferences(`First ${marker}. Again ${marker}.`, metadata);
  assert.equal(text, 'First [来源 1](https://example.com/source). Again [来源 1](https://example.com/source).');
});

test('citation links reject scripts, credentials, and Markdown attribute injection', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>bad</script>', 'https://user:secret@example.com']) {
    assert.equal(renderContentReferences(marker, { citations: [{ matched_text: marker, url }] }), '〔来源信息未同步〕');
  }
  const text = renderContentReferences(marker, { citations: [{ matched_text: marker, url: 'https://example.com/a', title: 'x" onclick="bad' }] });
  assert.equal(text, '[来源 1](https://example.com/a)');
});

test('missing citations and unsupported cards stay visible instead of deleting content', () => {
  assert.equal(renderContentReferences(`前${marker}后`), '前〔来源信息未同步〕后');
  assert.equal(renderContentReferences('图表：\uE200finance\uE202id\uE201'), '图表：〔行情图表：暂未展开〕');
  assert.equal(renderContentReferences('\uE200entity\uE202["place","日本","country"]\uE201'), '日本');
});

test('reference markers in fenced and inline code remain literal, including unfinished fences', () => {
  for (const code of [`\`${marker}\``, `\`\`${marker}\`\``, `\`\`\`txt\n${marker}\n\`\`\``, `~~~\n${marker}\n~~~`, `\`\`\`\n${marker}`]) {
    assert.equal(renderContentReferences(code), code);
  }
  assert.equal(renderContentReferences(`\`${marker}\` then ${marker}`), `\`${marker}\` then 〔来源信息未同步〕`);
});

test('user text is literal even when explaining a citation token', () => {
  const rows = upsertLiveMessage([], { id: 'u', author: { role: 'user' }, content: { parts: [marker] } });
  assert.equal(rows[0].text, marker);
});

test('top-level audio transcripts are rendered rather than silently empty', () => {
  assert.equal(contentToText({ content_type: 'audio_transcript', transcript: '转写正文' }), '转写正文');
});

test('a nested reference id does not inherit the URLs of its siblings', () => {
  const metadata = { content_references: [{ items: [
    { ref_id: 'turn0search0', url: 'https://example.com/first' },
    { ref_id: 'turn0search1', url: 'https://example.com/second' },
  ] }] };
  assert.equal(renderContentReferences(marker, metadata), '[来源 1](https://example.com/first)');
});

test('parentheses in a source URL cannot prematurely close the Markdown link', () => {
  const metadata = { citations: [{ matched_text: marker, url: 'https://example.com/a(b)?q=[x]' }] };
  assert.equal(renderContentReferences(marker, metadata), '[来源 1](https://example.com/a%28b%29?q=%5Bx%5D)');
});
