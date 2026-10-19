// Stream latency benchmark (not part of `npm test`): builds
// tests/bench/stream-bench.page.js, runs it in headless Chromium in real time
// and prints the report. `node scripts/stream-bench.mjs [intervalMs]`.
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const interval = Number(process.argv[2] || 60);
const extra = process.argv[3] ? `&${process.argv[3]}` : '';
const temporary = await mkdtemp(join(tmpdir(), 'slimgpt-bench-'));
const output = join(temporary, 'bundle');
let server;
let child;
try {
  let chrome;
  for (const candidate of [process.env.CHROME_PATH, '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean)) {
    if (await access(candidate).then(() => true, () => false)) { chrome = candidate; break; }
  }
  if (!chrome) throw new Error('Chrome or Chromium not found; set CHROME_PATH');
  await build({ configFile: false, logLevel: 'error', publicDir: false, plugins: [svelte()],
    build: { outDir: output, emptyOutDir: true, minify: !process.env.BENCH_SERVE, rollupOptions: { input: resolve('tests/bench/stream-bench.page.js'), output: { entryFileNames: 'bench.js' } } } });
  let timer;
  const report = await new Promise((accept, reject) => {
    server = createServer(async (request, response) => {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (path === '/report') {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => { response.end('ok'); accept(JSON.parse(body)); });
        return;
      }
      if (path === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/bench.js"></script>');
        return;
      }
      const file = resolve(output, `.${path}`);
      if (!file.startsWith(`${output}${sep}`)) { response.writeHead(403).end(); return; }
      try {
        response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
        response.end(await readFile(file));
      } catch { response.writeHead(404).end(); }
    });
    server.listen(Number(process.env.BENCH_SERVE || 0), '127.0.0.1', () => {
      if (process.env.BENCH_SERVE) { console.error(`serving on ${server.address().port}`); return; }
      child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--window-size=1280,900',
        `--user-data-dir=${join(temporary, 'profile')}`, `http://127.0.0.1:${server.address().port}/?interval=${interval}${extra}`], { stdio: 'ignore' });
      timer = setTimeout(() => reject(new Error('benchmark timed out')), 120_000);
    });
  });
  clearTimeout(timer);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child && child.exitCode == null && child.signalCode == null) {
    await new Promise((accept) => { child.once('close', accept); child.kill('SIGKILL'); });
  }
  if (server) server.close();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
}
