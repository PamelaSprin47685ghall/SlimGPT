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
      { urlPattern: 'https://chatgpt.com/*', resourceType: 'Document', requestStage: 'Request' },
      { urlPattern: 'https://chatgpt.com/backend-api/*', requestStage: 'Request' },
      { urlPattern: 'https://chatgpt.com/unauth-mweb/conversation/updates*', requestStage: 'Request' },
    ],
  });
  top.on('Fetch.requestPaused', (event) => {
    void fulfillFixtureRequest(top, event, fixture);
  });
  await top.call('Page.navigate', { url: 'https://chatgpt.com/slimgpt-smoke' });

  // Install official composer so takeover shows
  await waitFor(async () => (await top.evaluate(`!!document.getElementById('slimgpt-takeover-frame')`)));
  await sleep(250);
  await top.evaluate(`(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'fixture-cookie-dialog';
    dialog.innerHTML = '<p>Cookie consent fixture</p><button type="button">Accept</button>';
    document.body.appendChild(dialog);
    dialog.showModal();
    return true;
  })()`);
  await top.evaluate(installComposerExpression());
  await sleep(600);
  await top.evaluate(`document.getElementById('fixture-cookie-dialog')?.close()`);
  await waitFor(async () => {
    const visible = await top.evaluate(`document.getElementById('slimgpt-takeover-frame')?.dataset?.slimgptVisible === '1'`);
    return visible === true;
  });

  // Find the extension UI iframe
  const frameTarget = await waitForTarget(
    port,
    (item) => item.type === 'iframe' && item.url.startsWith(`chrome-extension://${extensionId}/index.html`),
  );
  const ui = await connectCdp(frameTarget.webSocketDebuggerUrl);
  await ui.call('Runtime.enable');
  await waitFor(async () => (await ui.evaluate(`document.querySelector('.status-pill')?.textContent?.trim()`)) === '已接管');

  // Scenario 1: Empty state desktop
  await top.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  await captureScreenshot(top, '01-empty-state-desktop.png');

  // Trigger conversation loading
  await top.evaluate(`Promise.all([
    fetch('/backend-api/conversations?offset=0').then((r) => r.json()),
    fetch('/backend-api/conversation/smoke').then((r) => r.json())
  ])`);
  await waitFor(async () => {
    const text = await ui.evaluate(`document.querySelector('.message-stage')?.innerText || ''`);
    return text.includes('Python');
  });
  await sleep(400);

  // Click Turn 0 to display the KaTeX and Markdown rich demo turn
  await ui.evaluate(`document.querySelector('[data-overview-index="0"]')?.click()`);
  await waitFor(async () => (await ui.evaluate(`document.querySelector('.message-stage')?.innerText || ''`)).includes('KaTeX'));
  await sleep(300);

  // Scenario 2: Rich conversation in desktop three-column light mode
  await captureScreenshot(top, '02-rich-conversation-top.png');

  // Scenario 2b: Expand thinking / reasoning block
  await ui.evaluate(`document.querySelector('.thought-header')?.click()`);
  await sleep(300);
  await captureScreenshot(top, '02b-thought-block-expanded.png');

  // Scenario 2c: Thinking slider selection in composer (switch to High & Pro)
  await ui.evaluate(`(() => {
    const tickButtons = document.querySelectorAll('.thinking-tick-btn');
    if (tickButtons && tickButtons[2]) tickButtons[2].click(); // Select High (Level 3)
  })()`);
  await sleep(300);
  await captureScreenshot(top, '02c-thinking-slider-high.png');

  await ui.evaluate(`(() => {
    const tickButtons = document.querySelectorAll('.thinking-tick-btn');
    if (tickButtons && tickButtons[3]) tickButtons[3].click(); // Select Extra High (Level 4)
  })()`);
  await sleep(300);
  await captureScreenshot(top, '02d-thinking-slider-extra-high.png');

  await ui.evaluate(`(() => {
    const tickButtons = document.querySelectorAll('.thinking-tick-btn');
    if (tickButtons && tickButtons[4]) tickButtons[4].click(); // Select Pro (Level 5)
  })()`);
  await sleep(300);
  await captureScreenshot(top, '02e-thinking-slider-pro.png');

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

  // Scenario 5: Turn 1 Python code block test
  await ui.evaluate(`document.querySelector('[data-overview-index="1"]')?.click()`);
  await sleep(300);
  await captureScreenshot(top, '05-turn-switch-python.png');

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
    root: { id: 'root', parent: null, children: [] }
  };
  let parent = 'root';
  for (let index = 0; index < 4; index += 1) {
    const id = `message-${index}`;
    const role = index % 2 === 0 ? 'user' : 'assistant';
    let content = `Fixture ${role} message ${index + 1}`;
    let metadata = {};
    if (index === 0) {
      content = '请展示一段包含各种 Markdown 语法的示例，包含代码块、表格、列表和引用。';
    } else if (index === 1) {
      metadata = {
        model_slug: 'gpt-5.6',
        reasoning_effort: 'high',
        thought: '用户希望了解 SlimGPT 的 Markdown 渲染能力。我将展示标题、代码块、表格、引用、列表以及 KaTeX 数学公式渲染（包括行内公式和独立块公式）。',
      };
      content = `# Markdown & KaTeX 功能演示\n\n这是一段普通段落，包含 **加粗文本**、*斜体*、\`内联代码\` 和 [SlimGPT 项目链接](https://github.com/example/slimgpt)。\n\n## 1. KaTeX 数学公式渲染\n\n质能方程行内公式：$E = mc^2$，以及高斯正态分布积分：$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$。\n\n下面是独立的数学块公式展示：\n\n$$\n\\mathcal{L}_{\\text{total}} = \\sum_{i=1}^N \\left( y_i - \\hat{y}_i \\right)^2 + \\lambda \\sum_{j=1}^M |w_j|\n$$\n\n矩阵与极限求和：\n\n$$\n\\mathbf{A} = \\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix}, \\quad \\lim_{n \\to \\infty} \\sum_{k=1}^n \\frac{1}{k^2} = \\frac{\\pi^2}{6}\n$$\n\n## 2. 代码块演示\n\n下面是一段 JavaScript 代码：\n\n\`\`\`javascript\n// 计算斐波那契数列\nfunction fibonacci(n) {\n  if (n <= 1) return n;\n  return fibonacci(n - 1) + fibonacci(n - 2);\n}\nconst result = fibonacci(10);\nconsole.log(\`Result: \${result}\`);\n\`\`\`\n\n## 3. 表格展示\n\n| 功能 | 官方 ChatGPT | SlimGPT 接管 |\n| :--- | :--- | :--- |\n| 渲染开销 | 较重 (DOM/动画) | 轻量 (DOM 虚拟化) |\n| 数学渲染 | KaTeX | KaTeX 本地离线渲染 |\n| 凭据安全 | 本地持有 | 不读取、不持久化 Cookie |\n| 多端支持 | 浏览器 | Chrome / Firefox / Orion |\n\n## 4. 列表与引用\n\n> 这是一个引用块。\n> 支持多行引用内容。\n\n无序列表：\n- 快速响应\n- 内存占用低\n- 体验流畅\n\n有序列表：\n1. 安装扩展\n2. 打开 chatgpt.com\n3. 自动接管轻量界面`;
    } else if (index === 2) {
      content = '你能再提供一个 Python 示例吗？';
    } else if (index === 3) {
      content = '这是 Python 示例：\n\n```python\ndef greet(name: str) -> str:\n    return f"Hello, {name}!"\n\nprint(greet("World"))\n```';
    }
    mapping[parent].children.push(id);
    mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        id,
        author: { role },
        content: { parts: [content] },
        metadata,
      },
    };
    parent = id;
  }

  const conversation = {
    id: 'smoke',
    title: 'Rich Markdown & Branch Demo',
    current_node: parent,
    create_time: 1,
    update_time: 2,
    mapping,
  };

  return {
    document: '<!doctype html><html><head><meta charset="utf-8"><title>Fixture ChatGPT</title></head><body><main id="official">Official fixture</main></body></html>',
    list: {
      items: [
        { id: 'smoke', title: 'Rich Markdown & Branch Demo', update_time: 2 },
        { id: 'simple-chat', title: '日常对话记录', update_time: 1 },
      ],
    },
    conversation,
  };
}

async function fulfillFixtureRequest(client, event, fixture) {
  const url = event.request.url;
  console.log('FETCH REQUEST PAUSED:', url);
  let body = null;
  let contentType = 'text/plain; charset=utf-8';
  if (event.resourceType === 'Document') {
    body = fixture.document;
    contentType = 'text/html; charset=utf-8';
  } else if (url.includes('/backend-api/conversations')) {
    body = JSON.stringify(fixture.list);
    contentType = 'application/json; charset=utf-8';
  } else if (url.includes('/backend-api/conversation/smoke') || url.includes('/backend-api/conversation/rich-demo')) {
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
    textarea.style.cssText = 'display:block;width:400px;height:60px';
    const button = document.createElement('button');
    button.type = 'submit';
    button.setAttribute('data-composer-submit', '');
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('data-visually-disabled', '');
    button.style.cssText = 'display:block;width:100px;height:40px';
    textarea.addEventListener('input', () => {
      button.removeAttribute('aria-disabled');
      button.removeAttribute('data-visually-disabled');
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      window.__slimgptSubmitted = textarea.value;
      textarea.value = '';
    });
    form.addEventListener('submit', (event) => event.preventDefault());
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
