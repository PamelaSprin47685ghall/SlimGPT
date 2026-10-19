// Syntax-check every plain JS module and validate the three manifests.
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';

const roots = ['src/page', 'src/shared', 'src/protocol', 'src/ui', 'scripts'];
const files = ['vite.config.js'];
for (const root of roots) {
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.(?:m?js)$/.test(entry.name)) files.push(`${entry.parentPath ?? entry.path}/${entry.name}`);
  }
}
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`${file}\n${result.stderr}\n`);
  }
}
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
for (const path of ['manifest.json', 'manifest.firefox.json', 'manifest.orion.json']) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.version !== version) {
    failed += 1;
    process.stderr.write(`${path}: version ${manifest.version} != package ${version}\n`);
  }
}
console.log(`checked ${files.length} files + 3 manifests`);
process.exit(failed ? 1 : 0);
