import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const extensionPath = resolve('dist-extension');
const chromePath = await findChrome();
const userDataDir = await mkdtemp(join(tmpdir(), 'slimgpt-vis-'));
const port = await reservePort();
const screenshotsDir = resolve('screenshots');
await mkdir(screenshotsDir, { recursive: true });

const chromeArgs = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${userDataDir}`,
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  'about:blank',
];
const chrome = spawn(chromePath, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });

let browserCdp = null;
try {
  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
  browserCdp = await connectCdp(version.webSocketDebuggerUrl);
  const loaded = await browserCdp.call('Extensions.loadUnpacked', { path: extensionPath });
  console.log(`Loaded extension ${loaded.id}`);

  await runVisualScenarios(browserCdp, loaded.id);
  console.log('Visual scenarios completed successfully.');
} catch (err) {
  console.error('Visual scenarios error:', err);
  process.exitCode = 1;
} finally {
  try {
    await browserCdp?.call('Browser.close');
  } catch {
    chrome.kill('SIGTERM');
  }
  await Promise.race([onceExit(chrome), sleep(4_000)]);
  if (chrome.exitCode === null) chrome.kill('SIGKILL');
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}

async function runVisualScenarios(browser, extensionId) {
  const fixture = makeRichFixture();
  const created = await browser.call('Target.createTarget', { url: 'about:blank' });
  const topTarget = await waitForTarget(port, (item) => item.id === created.targetId);
  const top = await connectCdp(topTarget.webSocketDebuggerUrl);
  await top.call('Page.enable');
  await top.call('Runtime.enable');
  await top.call('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://chatgpt.com/slimgpt-smoke*', resourceType: 'Document', requestStage: 'Request' },
      { urlPattern: 'https://chatgpt.com/backend-api/*', requestStage: 'Request' },
    ],
  });
  top.on('Fetch.requestPaused', (event) => {
    void fulfillFixtureRequest(top, event, fixture);
  });
  await top.call('Page.navigate', { url: 'https://chatgpt.com/slimgpt-smoke' });

  // Install official composer so takeover shows
  await waitFor(async () => (await top.evaluate(`!!document.getElementById('slimgpt-takeover-frame')`)));
  await top.evaluate(installComposerExpression());

  // Find the extension UI iframe
  const frameTarget = await waitForTarget(
    port,
    (item) => item.type === 'iframe' && item.url.startsWith(`chrome-extension://${extensionId}/index.html`),
  );
  const ui = await connectCdp(frameTarget.webSocketDebuggerUrl);
  await ui.call('Runtime.enable');
  await ui.call('Page.enable');
  await waitFor(async () => (await ui.evaluate(`document.querySelector('.status-pill')?.textContent?.trim()`)).includes('已'));

  // Scenario 1: Empty state desktop
  await top.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  await captureScreenshot(top, '01-empty-state-desktop.png');

  // Trigger conversation loading
  await top.evaluate(`Promise.all([
    fetch('/backend-api/conversations?offset=0').then((r) => r.json()),
    fetch('/backend-api/conversation/rich-demo').then((r) => r.json())
  ])`);
  await waitFor(async () => (await ui.evaluate(`document.querySelectorAll('.message-card').length`)) >= 2);
  await sleep(400);

  // Scenario 2: Rich conversation in desktop three-column light mode
  await captureScreenshot(top, '02-rich-conversation-top.png');

  // Scenario 3: Scroll inside the current question+answer turn only
  await ui.evaluate(`(() => {
    const vp = document.querySelector('.single-message-scroller');
    if (vp) {
      vp.scrollTop = 320;
      vp.dispatchEvent(new Event('scroll'));
    }
  })()`);
  await sleep(300);
  await captureScreenshot(top, '03-rich-conversation-table-list.png');

  // Scenario 4: Dark mode desktop
  await top.call('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(200);
  await captureScreenshot(top, '04-rich-conversation-dark.png');
  await top.call('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  // Scenario 5: Branch switching test
  await ui.evaluate(`(() => {
    const prevBranchBtn = document.querySelector('.branch-control button:not(:disabled)');
    if (prevBranchBtn) prevBranchBtn.click();
  })()`);
  await sleep(300);
  await captureScreenshot(top, '05-branch-switch.png');

  // Scenario 6: Mobile viewport (390x844)
  await top.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await top.evaluate(`(() => {
    const frame = document.getElementById('slimgpt-takeover-frame');
    if (!frame) return;
    frame.style.inset = '0 auto auto 0';
    frame.style.width = '390px';
    frame.style.height = '844px';
  })()`);
  await sleep(500);
  await captureScreenshot(top, '06-mobile-chat.png');

  // Scenario 7: Mobile sidebar open
  await ui.evaluate(`document.querySelector('.mobile-navbar .button')?.click()`);
  await sleep(500);
  await captureScreenshot(top, '07-mobile-sidebar-open.png');
  await ui.evaluate(`document.querySelector('.sidebar-scrim')?.click()`);
  await sleep(300);

  // Scenario 8: Mobile overview drawer open
  await ui.evaluate(`[...document.querySelectorAll('.mobile-navbar .button')].find((button) => button.textContent.includes('概览'))?.click()`);
  await sleep(500);
  await captureScreenshot(top, '08-mobile-overview-open.png');
  await ui.evaluate(`document.querySelector('.sidebar-scrim')?.click()`);
  await sleep(300);

  // Reset viewport to desktop
  await top.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 2, mobile: false });
  await top.evaluate(`(() => {
    const frame = document.getElementById('slimgpt-takeover-frame');
    if (!frame) return;
    frame.style.inset = '0';
    frame.style.width = '100%';
    frame.style.height = '100%';
  })()`);
  await sleep(300);

  // Scenario 9: Search in sidebar
  await ui.evaluate(`(() => {
    const input = document.querySelector('.conversation-search input');
    if (input) {
      input.value = 'Rich';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await sleep(200);
  await captureScreenshot(top, '09-sidebar-search.png');
}

async function captureScreenshot(client, filename) {
  const result = await client.call('Page.captureScreenshot', { format: 'png' });
  const buffer = Buffer.from(result.data, 'base64');
  const path = join(screenshotsDir, filename);
  await writeFile(path, buffer);
  console.log(`Saved screenshot: ${filename} (${buffer.length} bytes)`);
}

function makeRichFixture() {
  const mapping = {
    root: { id: 'root', parent: null, children: ['u1'] },
    u1: {
      id: 'u1',
      parent: 'root',
      children: ['a1'],
      message: {
        id: 'u1',
        author: { role: 'user' },
        content: { parts: ['请展示一段包含各种 Markdown 语法的示例，包含代码块、表格、列表和引用。'] },
      },
    },
    a1: {
      id: 'a1',
      parent: 'u1',
      children: ['u2'],
      message: {
        id: 'a1',
        author: { role: 'assistant' },
        content: {
          parts: [
            `# Markdown 功能演示\n\n这是一段普通段落，包含 **加粗文本**、*斜体*、\`内联代码\` 和 [SlimGPT 项目链接](https://github.com/example/slimgpt)。\n\n## 1. 代码块演示\n\n下面是一段 JavaScript 代码：\n\n\`\`\`javascript\n// 计算斐波那契数列\nfunction fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}\nconst result = fibonacci(10);\nconsole.log(\`Result: \${result}\`);\n\`\`\`\n\n## 2. 表格展示\n\n| 功能 | 官方 ChatGPT | SlimGPT 接管 |\n| :--- | :--- | :--- |\n| 渲染开销 | 较重 (DOM/动画) | 轻量 (DOM 虚拟化) |\n| 凭据安全 | 本地持有 | 不读取、不持久化 Cookie |\n| 多端支持 | 浏览器 | Chrome / Firefox / Orion |\n\n## 3. 列表与引用\n\n> 这是一个引用块。\n> 支持多行引用内容。\n\n无序列表：\n- 快速响应\n- 内存占用低\n- 体验流畅\n\n有序列表：\n1. 安装扩展\n2. 打开 chatgpt.com\n3. 自动接管轻量界面`
          ],
        },
      },
    },
    u2: {
      id: 'u2',
      parent: 'a1',
      children: ['a2_1', 'a2_2'],
      message: {
        id: 'u2',
        author: { role: 'user' },
        content: { parts: ['你能再提供一个 Python 示例吗？'] },
      },
    },
    a2_1: {
      id: 'a2_1',
      parent: 'u2',
      children: [],
      message: {
        id: 'a2_1',
        author: { role: 'assistant' },
        content: {
          parts: [
            `这是分支 1：\n\n\`\`\`python\ndef greet(name: str) -> str:\n    return f"Hello, {name}!"\n\nprint(greet("World"))\n\`\`\``
          ],
        },
      },
    },
    a2_2: {
      id: 'a2_2',
      parent: 'u2',
      children: [],
      message: {
        id: 'a2_2',
        author: { role: 'assistant' },
        content: {
          parts: [
            `这是分支 2：\n\n\`\`\`python\nimport sys\n\nfor line in sys.stdin:\n    print(line.strip().upper())\n\`\`\``
          ],
        },
      },
    },
  };

  const conversation = {
    id: 'rich-demo',
    title: 'Rich Markdown & Branch Demo',
    current_node: 'a2_2',
    create_time: 1720000000,
    update_time: 1720001000,
    mapping,
  };

  return {
    document: '<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT</title></head><body><main id="official">Official</main></body></html>',
    list: {
      items: [
        { id: 'rich-demo', title: 'Rich Markdown & Branch Demo', update_time: 1720001000 },
        { id: 'simple-chat', title: '日常对话记录', update_time: 1719900000 },
        { id: 'code-review', title: '代码审查记录', update_time: 1719800000 },
      ],
    },
    conversation,
  };
}

async function fulfillFixtureRequest(client, event, fixture) {
  const url = event.request.url;
  let body = null;
  let contentType = 'text/plain; charset=utf-8';
  if (event.resourceType === 'Document') {
    body = fixture.document;
    contentType = 'text/html; charset=utf-8';
  } else if (url.includes('/backend-api/conversations')) {
    body = JSON.stringify(fixture.list);
    contentType = 'application/json; charset=utf-8';
  } else if (url.includes('/backend-api/conversation/rich-demo')) {
    body = JSON.stringify(fixture.conversation);
    contentType = 'application/json; charset=utf-8';
  }

  if (body == null) {
    await client.call('Fetch.continueRequest', { requestId: event.requestId });
    return;
  }
  await client.call('Fetch.fulfillRequest', {
    requestId: event.requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: contentType },
      { name: 'Cache-Control', value: 'no-store' },
    ],
    body: Buffer.from(body).toString('base64'),
  });
}

function installComposerExpression() {
  return `(() => {
    const form = document.createElement('form');
    form.id = 'fixture-composer';
    form.style.cssText = 'position:fixed;left:20px;top:20px;width:500px;height:120px;display:block';
    const textarea = document.createElement('textarea');
    textarea.id = 'mobile-composer-prompt';
    textarea.setAttribute('data-mobile-composer-prompt', '');
    const button = document.createElement('button');
    button.type = 'submit';
    button.setAttribute('data-composer-submit', '');
    form.append(textarea, button);
    document.body.appendChild(form);
    return true;
  })()`;
}

async function findChrome() {
  const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await import('node:fs/promises').then((fs) => fs.access(candidate));
      return candidate;
    } catch {}
  }
  throw new Error('Chrome/Chromium binary not found');
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForJson(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch {}
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForTarget(portNumber, predicate, timeoutMs = 20_000) {
  return waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${portNumber}/json`);
    const items = await res.json();
    return items.find(predicate) || null;
  }, timeoutMs);
}

async function waitFor(check, timeoutMs = 12_000, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const val = await check();
      if (val) return val;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw lastError || new Error(`Condition not met within ${timeoutMs}ms`);
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result || {});
      return;
    }
    for (const l of listeners.get(msg.method) || []) l(msg.params || {});
  });
  return {
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) {
      const values = listeners.get(method) || [];
      values.push(listener);
      listeners.set(method, values);
    },
    async evaluate(expression) {
      const res = await this.call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'Evaluation failed');
      return res.result?.value;
    },
  };
}

function onceExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((r) => child.once('exit', r));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
