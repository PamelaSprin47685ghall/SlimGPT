import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export const TARGETS = ['chrome', 'firefox', 'orion'];

export function outDirFor(target) {
  return target === 'chrome' ? 'dist-extension' : `dist-${target}`;
}

// Extension frame (index.html → Svelte UI). The page scripts
// (src/page/hook.js → main-hook.js, src/page/bridge.js → isolated-bridge.js)
// are classic scripts and are bundled separately by scripts/build.mjs with
// `pageScriptConfig`.
export default defineConfig(({ mode }) => {
  const target = TARGETS.includes(mode) ? mode : 'chrome';
  return {
    base: './',
    define: {
      __SLIMGPT_TARGET__: JSON.stringify(target),
    },
    plugins: [svelte()],
    build: {
      outDir: outDirFor(target),
      emptyOutDir: true,
      sourcemap: process.env.SLIMGPT_SOURCEMAP === '1',
      target: 'es2022',
    },
  };
});

/**
 * Vite config for one classic (IIFE, no imports at runtime) page script.
 * @param {'chrome'|'firefox'|'orion'} target
 * @param {string} entry  e.g. 'src/page/hook.js'
 * @param {string} fileName output file name at the package root
 */
export function pageScriptConfig(target, entry, fileName) {
  return {
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    define: {
      __SLIMGPT_TARGET__: JSON.stringify(target),
    },
    build: {
      outDir: outDirFor(target),
      emptyOutDir: false,
      sourcemap: process.env.SLIMGPT_SOURCEMAP === '1' ? 'inline' : false,
      target: 'es2022',
      minify: true,
      copyPublicDir: false,
      lib: {
        entry,
        formats: ['iife'],
        name: fileName.replace(/\W+/g, '_'),
        fileName: () => fileName,
      },
    },
  };
}
