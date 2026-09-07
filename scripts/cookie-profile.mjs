import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

const quoteIdentifier = (name) => `"${String(name).replaceAll('"', '""')}"`;

/** Clone login data only. The source database is opened read-only; history,
 * passwords, extensions and unrelated cookies never enter the test profile.
 * The caller owns cleanup of the private temporary destination. */
export async function cloneChromeCookieProfile(destination, {
  sourceRoot = join(homedir(), '.config', 'google-chrome'),
} = {}) {
  const { DatabaseSync } = await import('node:sqlite').catch(() => {
    throw new Error('The optional read-only cookie inspection requires Node.js with node:sqlite support');
  });
  const state = JSON.parse(await readFile(join(sourceRoot, 'Local State'), 'utf8'));
  const profile = state.profile?.last_used || 'Default';
  if (typeof profile !== 'string' || basename(profile) !== profile || profile === '.' || profile === '..') {
    throw new Error('Invalid Chrome profile directory');
  }
  await mkdir(join(destination, profile), { recursive: true, mode: 0o700 });
  await writeFile(join(destination, 'Local State'), JSON.stringify({
    profile: { last_used: profile }, ...(state.os_crypt ? { os_crypt: state.os_crypt } : {}),
  }), { mode: 0o600 });

  let copied = false;
  for (const relative of ['Network/Cookies', 'Cookies']) {
    let source;
    try {
      source = new DatabaseSync(join(sourceRoot, profile, relative), { readOnly: true });
    } catch (error) {
      if (error.code === 'ERR_SQLITE_ERROR' && /unable to open database file/i.test(error.message)) continue;
      throw error;
    }
    const destinationPath = join(destination, profile, relative);
    let target;
    try {
      const schema = source.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('meta','cookies')").all();
      if (!schema.some((table) => table.name === 'cookies')) continue;
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
      target = new DatabaseSync(destinationPath);
      await chmod(destinationPath, 0o600);
      target.exec('BEGIN');
      for (const table of schema) {
        target.exec(table.sql);
        const columns = source.prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`).all().map((column) => column.name);
        const statement = source.prepare(`SELECT * FROM ${quoteIdentifier(table.name)}` +
          (table.name === 'cookies' ? " WHERE host_key IN ('chatgpt.com','.chatgpt.com','openai.com','.openai.com','auth.openai.com','chat.openai.com') OR host_key LIKE '%.chatgpt.com'" : ''));
        statement.setReadBigInts(true);
        const insert = target.prepare(`INSERT INTO ${quoteIdentifier(table.name)} (${columns.map(quoteIdentifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of statement.iterate()) insert.run(...columns.map((column) => row[column]));
      }
      for (const index of source.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='cookies' AND sql IS NOT NULL").all()) target.exec(index.sql);
      target.exec('COMMIT');
      copied = true;
    } finally {
      target?.close();
      source.close();
    }
  }
  if (!copied) throw new Error('No readable Chrome cookie database found');
  return profile;
}
