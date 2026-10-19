import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const manifests = ['manifest.json', 'manifest.firefox.json', 'manifest.orion.json'];
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('all three manifests: storage only, chatgpt.com only, no background, same version as package', async () => {
  const pkg = await read('package.json');
  for (const path of manifests) {
    const manifest = await read(path);
    assert.equal(manifest.manifest_version, 3, path);
    assert.equal(manifest.version, pkg.version, `${path} version`);
    assert.deepEqual(manifest.permissions, ['storage'], path);
    assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*'], path);
    assert.equal(manifest.background, undefined, path);
    assert.equal(manifest.content_security_policy, undefined, path);
    for (const script of manifest.content_scripts) assert.deepEqual(script.matches, ['https://chatgpt.com/*'], path);
    const war = manifest.web_accessible_resources;
    assert.equal(war.length, 1);
    assert.deepEqual(war[0].matches, ['https://chatgpt.com/*']);
    assert.deepEqual(war[0].resources, ['index.html', 'assets/*', 'main-hook.js'], path);
    assert.ok(!JSON.stringify(manifest).includes('main-mitm.js'), `${path} must not reference the legacy hook`);
  }
});

test('Chrome and Firefox: ISOLATED bridge first, then the MAIN-world hook, both at document_start', async () => {
  for (const path of ['manifest.json', 'manifest.firefox.json']) {
    const { content_scripts: scripts } = await read(path);
    assert.deepEqual(scripts.map((s) => [s.js, s.world, s.run_at]), [
      [['isolated-bridge.js'], 'ISOLATED', 'document_start'],
      [['main-hook.js'], 'MAIN', 'document_start'],
    ], path);
  }
});

test('Orion: bridge only (injects main-hook.js as a web-accessible script)', async () => {
  const { content_scripts: scripts } = await read('manifest.orion.json');
  assert.deepEqual(scripts.map((s) => [s.js, s.world ?? null]), [[['isolated-bridge.js'], null]]);
});

test('Firefox (desktop + Android) gecko settings', async () => {
  const firefox = await read('manifest.firefox.json');
  assert.equal(firefox.browser_specific_settings.gecko.id, 'slimgpt@local.invalid');
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
  assert.deepEqual(firefox.browser_specific_settings.gecko_android, {});
  assert.ok(Number.parseInt(firefox.browser_specific_settings.gecko.strict_min_version, 10) >= 128, 'MAIN world needs Firefox 128+');
});

test('dependencies: no Framework7 / smol-toml / PWA; UI runtime deps kept', async () => {
  const pkg = await read('package.json');
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ['framework7', 'framework7-svelte', 'smol-toml', 'vite-plugin-pwa']) assert.equal(all[name], undefined, name);
  for (const name of ['svelte', 'streaming-markdown', 'highlight.js', 'katex']) assert.ok(pkg.dependencies[name], name);
  const lock = await read('package-lock.json');
  assert.equal(lock.packages['node_modules/framework7'], undefined);
  assert.equal(lock.packages[''].dependencies.framework7, undefined);
});

test('build script bundles the new page entries for every target', async () => {
  const build = await readFile('scripts/build.mjs', 'utf8');
  assert.ok(build.includes("'src/page/hook.js', 'main-hook.js'"));
  assert.ok(build.includes("'src/page/bridge.js', 'isolated-bridge.js'"));
  const config = await import('../../vite.config.js');
  assert.deepEqual(config.TARGETS, ['chrome', 'firefox', 'orion']);
  const hook = config.pageScriptConfig('firefox', 'src/page/hook.js', 'main-hook.js');
  assert.deepEqual(hook.build.lib.formats, ['iife']);
  assert.equal(hook.build.outDir, 'dist-firefox');
  assert.equal(hook.build.emptyOutDir, false);
  assert.equal(hook.define.__SLIMGPT_TARGET__, '"firefox"');
});

test('page sources: observe-only, no scraping, no legacy imports', async () => {
  const files = (await readdir('src/page')).filter((name) => name.endsWith('.js'));
  for (const name of files) {
    const source = await readFile(`src/page/${name}`, 'utf8');
    for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
      assert.ok(/^\.\/[\w-]+\.js$|^\.\.\/shared\/[\w-]+\.js$/.test(match[1]), `${name} imports ${match[1]}`);
    }
    const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of [
      'XMLHttpRequest', 'WebSocket', 'setInterval(', 'Response.prototype', 'data-message-author-role',
      'web-mobile', 'innerHTML', 'eval(', 'new Function', 'chrome.debugger', 'document.cookie',
      'new Response(', 'controller.enqueue', 'getReader().read', 'main-mitm',
    ]) {
      assert.ok(!code.includes(forbidden), `${name} must not contain ${forbidden}`);
    }
  }
});
