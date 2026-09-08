import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mitmSource = readFileSync(new URL('../main-mitm.js', import.meta.url), 'utf8');
const homeSource = readFileSync(new URL('../src/pages/HomePage.svelte', import.meta.url), 'utf8');
const themeSource = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');

test('conversation index sync includes throttling cooldown and bounded pagination after bootstrap', () => {
  assert.ok(
    mitmSource.includes('INDEX_SYNC_COOLDOWN_MS'),
    'must define a cooldown constant for index sync requests',
  );
  assert.ok(
    mitmSource.includes('lastIndexSyncAttemptAt') || mitmSource.includes('lastIndexSync'),
    'must track last sync attempt time to prevent storming',
  );
  assert.ok(
    mitmSource.includes('CONVERSATION_INDEX_PAGE_SIZE'),
    'must reference page size for index queries',
  );
});

test('canonical conversation queries prevent duplicate fetches on clean navigations', () => {
  assert.ok(
    mitmSource.includes('canonicalSyncedIds'),
    'must maintain a set or map of already-synced canonical conversation IDs',
  );
  assert.ok(
    mitmSource.includes('syncedIds.has(conversationId)'),
    'must check whether conversation was already synced before re-queueing on location change',
  );
});

test('HomePage conversation preview updates are gated on complete sync and monotonic updates', () => {
  assert.ok(
    homeSource.includes('capture.canonicalComplete === true') || homeSource.includes('shouldUpdatePreview'),
    'must only update conversation preview when canonical sync is complete',
  );
  assert.ok(
    homeSource.includes('updateTime < existing.update_time'),
    'must prevent older messages from overwriting a newer preview update_time',
  );
  assert.ok(
    homeSource.includes('existing.last === targetLast') || homeSource.includes('targetLast === existing.last'),
    'must avoid redundant Map mutations when preview text and metadata have not changed',
  );
});

test('reading column and composer width are capped at comfortable reading limits', () => {
  // Reading column max width around ~800px
  assert.ok(
    themeSource.includes('min(800px') || themeSource.includes('max-width: 800px') || themeSource.includes('width: min(800px'),
    'single-message-content must be capped around 800px centered',
  );
  // Composer max width around ~820px
  assert.ok(
    themeSource.includes('max-width: 820px') || themeSource.includes('820px'),
    'composer must align with reading column width',
  );
  // User bubble styling has pleasant soft background and restrained width
  assert.ok(
    themeSource.includes('--slim-user-bubble: #eaf0fb') || themeSource.includes('#eaf0fb'),
    'light theme user bubble should use soft calm tint',
  );
});
