import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// Run the production UI Markdown renderer and components (src/ui) in a real,
// clean Chromium DOM. No extension profile, credentials, external requests,
// test-only globals in the app, or screenshots-as-assertions are needed.
// Build outputs are temporary. Scenario 'asset-failure' makes the lazily
// loaded highlight.js and KaTeX chunks fail with HTTP 503.
const temporary = await mkdtemp(join(tmpdir(), 'slimgpt-markdown-'));
const output = join(temporary, 'bundle');
let server;
let child;
try {
  let chrome;
  for (const candidate of [process.env.CHROME_PATH, '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    if (await access(candidate).then(() => true, () => false)) { chrome = candidate; break; }
  }
  if (!chrome) throw new Error('Chrome or Chromium not found; set CHROME_PATH');
  await build({ configFile: false, logLevel: 'error', publicDir: false,
    plugins: [svelte()],
    build: { outDir: output, emptyOutDir: true, minify: false,
      rollupOptions: { input: resolve('tests/browser/markdown.spec.js'), output: { entryFileNames: 'test.js' } },
    },
  });
  let blockLazyChunks = false;
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      response.setHeader('Cache-Control', 'no-store');
      if (blockLazyChunks && /\/(highlight|katex)-loader[^/]*\.(js|css)$/.test(path)) {
        response.writeHead(503).end('Intentional fixture-only module failure');
        return;
      }
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'");
      if (path === '/') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><meta charset="utf-8"><pre id="result">PENDING</pre><script type="module" src="/test.js"></script>');
        return;
      }
      const file = resolve(output, `.${path}`);
      if (!file.startsWith(`${output}${sep}`)) { response.writeHead(403).end(); return; }
      response.setHeader('Content-Type', file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const reports = [];
  for (const scenario of ['normal', 'asset-failure']) {
    blockLazyChunks = scenario === 'asset-failure';
    const result = await new Promise((accept, reject) => {
      child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-sync', `--user-data-dir=${join(temporary, `profile-${scenario}`)}`,
        '--dump-dom', '--virtual-time-budget=12000', `http://127.0.0.1:${server.address().port}/?scenario=${scenario}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Markdown browser tests timed out')); }, 30_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) { reject(new Error(`Chrome exited ${code}: ${stderr}`)); return; }
        const encoded = stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
        try {
          const json = String(encoded || '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&amp;', '&');
          const report = JSON.parse(json);
          if (!Array.isArray(report.results) || !report.results.length) throw new Error('Empty report');
          accept(report);
        } catch { reject(new Error(`No completed browser report: ${stdout.slice(0, 1500)}`)); }
      });
    });
    reports.push(result);
  }
  const results = reports.flatMap((report) => report.results);
  const result = { tests: results.length, passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length, results };
  console.log(JSON.stringify(result, null, 2));
  if (result.failed) process.exitCode = 1;
} finally {
  if (child && child.exitCode == null && child.signalCode == null) {
    await new Promise((accept) => { child.once('close', accept); child.kill('SIGKILL'); });
  }
  if (server) await new Promise((accept) => server.close(accept));
  await rm(temporary, { recursive: true, force: true });
}
