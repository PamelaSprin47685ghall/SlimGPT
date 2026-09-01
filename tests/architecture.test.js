import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifests = ['manifest.json', 'manifest.firefox.json', 'manifest.orion.json'];

test('all browser packages use the same permission-light takeover architecture', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(manifest.version, packageJson.version, `${path} version must match package.json`);
    assert.equal(manifest.background, undefined, `${path} must not have a background transport`);
    assert.equal(manifest.permissions, undefined, `${path} must not request extension permissions`);
    assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/*']);
    assert.ok(
      manifest.content_scripts.some((script) => script.js?.includes('isolated-bridge.js')),
      `${path} must install the takeover bridge`,
    );
    assert.ok(
      manifest.web_accessible_resources?.some((entry) => entry.resources?.includes('main-mitm.js')),
      `${path} must expose the shared page hook`,
    );
  }

  const firefox = JSON.parse(await readFile('manifest.firefox.json', 'utf8'));
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, {
    required: ['none'],
  });
  assert.deepEqual(firefox.browser_specific_settings.gecko_android, {});
});

test('the isolated bridge is ready before the page hook on browsers with MAIN-world scripts', async () => {
  for (const path of ['manifest.json', 'manifest.firefox.json']) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(manifest.content_scripts[0].js, ['isolated-bridge.js']);
    assert.equal(manifest.content_scripts[0].world, 'ISOLATED');
    assert.deepEqual(manifest.content_scripts[1].js, ['main-mitm.js']);
    assert.equal(manifest.content_scripts[1].world, 'MAIN');
  }

  const bridge = await readFile('isolated-bridge.js', 'utf8');
  assert.equal(bridge.includes('event.source === window'), false);
});

test('the project has no PWA or debugger runtime', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const allDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.equal(allDependencies['vite-plugin-pwa'], undefined);
  assert.equal(packageJson.scripts['build:pwa'], undefined);

  const files = await Promise.all([
    readFile('main-mitm.js', 'utf8'),
    readFile('isolated-bridge.js', 'utf8'),
  ]);
  const source = files.join('\n');
  assert.equal(source.includes('chrome.debugger'), false);
  assert.equal(source.includes('content-visibility: hidden'), true);
  assert.equal(source.includes('#mobile-composer-prompt'), true);
  assert.equal(source.includes('[data-composer-submit]'), true);
  assert.equal(source.includes('waitForComposerElement(INITIAL_SHELL_READY_TIMEOUT)'), true);

  const bridge = files[1];
  const captureBlock = bridge.slice(bridge.indexOf("if (payload.type === 'page-capture')"));
  assert.ok(captureBlock.indexOf('...payload') < captureBlock.indexOf("type: 'canonical-capture'"));
});

test('page synchronization is event-driven instead of interval-polled', async () => {
  const source = await readFile('main-mitm.js', 'utf8');
  assert.equal(source.includes('setInterval('), false);
  assert.equal(source.includes('new MutationObserver'), true);
  assert.equal(source.includes('socket.addEventListener("message"'), true);
  assert.equal(source.includes('xhr.addEventListener("progress"'), true);
  assert.equal(source.includes('transport: "dom"'), true);
});
