import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneChromeCookieProfile } from '../scripts/cookie-profile.mjs';

const sqlite = await import('node:sqlite').catch(() => null);

test('test profiles select only related encrypted cookies and leave the source unchanged', {
  skip: !sqlite && 'node:sqlite is needed only for the optional real-profile diagnostic',
}, async () => {
  const { DatabaseSync } = sqlite;
  const root = await mkdtemp(join(tmpdir(), 'slimgpt-cookie-test-'));
  const sourceRoot = join(root, 'source');
  const destination = join(root, 'clone');
  try {
    await mkdir(join(sourceRoot, 'Profile 1', 'Network'), { recursive: true });
    await writeFile(join(sourceRoot, 'Local State'), JSON.stringify({
      profile: { last_used: 'Profile 1', info_cache: { email: 'do-not-copy@example.invalid' } },
      os_crypt: { encrypted_key: 'test-key' }, unrelated: 'do-not-copy',
    }));
    await writeFile(join(sourceRoot, 'Profile 1', 'Login Data'), 'DO NOT COPY');
    const path = join(sourceRoot, 'Profile 1', 'Network', 'Cookies');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value INTEGER); INSERT INTO meta VALUES (\'version\',24); CREATE TABLE cookies(host_key TEXT, creation_utc INTEGER, encrypted_value BLOB); CREATE INDEX host ON cookies(host_key);');
    const insert = db.prepare('INSERT INTO cookies VALUES (?,?,?)');
    for (const host of ['.chatgpt.com', 'auth.openai.com', '.unrelated.example', 'fakechatgpt.com']) insert.run(host, 13300000000000000n, new Uint8Array([0, 255, 1]));
    db.close();
    const original = await readFile(path);
    assert.equal(await cloneChromeCookieProfile(destination, { sourceRoot }), 'Profile 1');
    assert.deepEqual(await readFile(path), original);
    assert.deepEqual(await readdir(join(destination, 'Profile 1')), ['Network']);
    assert.deepEqual(JSON.parse(await readFile(join(destination, 'Local State'), 'utf8')), {
      profile: { last_used: 'Profile 1' }, os_crypt: { encrypted_key: 'test-key' },
    });
    const cookiePath = join(destination, 'Profile 1', 'Network', 'Cookies');
    const copied = new DatabaseSync(cookiePath, { readOnly: true });
    assert.deepEqual(copied.prepare('SELECT host_key FROM cookies ORDER BY host_key').all().map((row) => row.host_key), ['.chatgpt.com', 'auth.openai.com']);
    copied.close();
    assert.equal((await stat(cookiePath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
