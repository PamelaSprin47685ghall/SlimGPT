// src/protocol is a pure, self-contained module: no imports outside the
// directory, no DOM/browser/timer globals, no legacy imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../../src/protocol/', import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith('.js'));

test('protocol modules import only each other', () => {
  for (const name of files) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] || match[2];
      assert.match(specifier, /^\.\/[\w-]+\.js$/, `${name} imports ${specifier}`);
      assert.ok(files.includes(specifier.slice(2)), `${name} imports missing ${specifier}`);
    }
  }
});

test('protocol modules reference no DOM, timer or storage globals', () => {
  const forbidden = /\b(window|document|navigator|localStorage|sessionStorage|chrome|browser|setTimeout|setInterval|requestAnimationFrame|fetch|XMLHttpRequest|globalThis|Date\.now|Math\.random)\b/;
  for (const name of files) {
    const code = readFileSync(new URL(name, dir), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(code, forbidden, name);
  }
});

test('every public export has JSDoc', () => {
  const source = readFileSync(new URL('index.js', dir), 'utf8');
  for (const match of source.matchAll(/export function (\w+)/g)) {
    const before = source.slice(0, match.index).trimEnd();
    assert.ok(before.endsWith('*/'), `${match[1]} lacks JSDoc`);
  }
});
