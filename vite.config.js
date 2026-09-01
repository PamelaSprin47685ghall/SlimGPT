import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => {
  const target = ['chrome', 'firefox', 'orion'].includes(mode) ? mode : 'chrome';
  const outDir = target === 'chrome' ? 'dist-extension' : `dist-${target}`;
  return {
    base: './',
    define: {
      __SLIMGPT_TARGET__: JSON.stringify(target),
    },
    plugins: [svelte()],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: process.env.SLIMGPT_SOURCEMAP === '1',
      target: 'es2022',
    },
  };
});
