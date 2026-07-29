// Section 19: measures the Core Web Vitals the specification names, on the demo flow.
// Kept apart from demo.test.js because timing is noisy: a slow machine must not fail the
// functional suite, and this run reports numbers even when it passes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

// Thresholds straight from section 19.
const BUDGET = { lcpMs: 2500, cls: 0.1, inpMs: 200 };

async function findAvailablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForReady(baseUrl, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early.\n${output.join('')}`);
    try {
      if ((await fetch(`${baseUrl}/health/ready`)).ok) return;
    } catch {
      // Connection failures are expected while the child process starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready.\n${output.join('')}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; } catch { /* try the next one */ }
  }
  return undefined;
}

// Collectors are installed before navigation so the very first paint is observed.
// Each observer is isolated: an entry type this browser build does not support must not stop the
// others from registering, and must never break the page under measurement.
const COLLECTOR = `
  window.__vitals = { lcp: 0, cls: 0, interactions: new Map(), unsupported: [] };
  function watch(type, options, handle) {
    try {
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) handle(entry); })
        .observe({ type, buffered: true, ...options });
    } catch (error) {
      window.__vitals.unsupported.push(type);
    }
  }
  watch('largest-contentful-paint', {}, (entry) => { window.__vitals.lcp = entry.startTime; });
  // Only shifts the user did not cause count against CLS.
  watch('layout-shift', {}, (entry) => { if (!entry.hadRecentInput) window.__vitals.cls += entry.value; });
  // INP is measured per interaction, not per event: one tap fires pointerdown, pointerup and
  // click, and they share an interactionId. Only the slowest event of a group counts.
  watch('event', { durationThreshold: 16 }, (entry) => {
    if (!entry.interactionId) return;
    const worst = window.__vitals.interactions.get(entry.interactionId) || 0;
    window.__vitals.interactions.set(entry.interactionId, Math.max(worst, entry.duration));
  });
`;

// Opens a real session, makes the review call take a second, and times how long the interface
// waits before telling the student that something is happening.
async function measureAiLoadingState(browser, baseUrl, jwtSecret) {
  const context = await browser.newContext();
  try {
    const token = jwt.sign({ u: 'perfuser' }, jwtSecret, { expiresIn: '1h' });
    await context.addCookies([{ name: 'eb_token', value: token, url: baseUrl }]);
    const page = await context.newPage();
    await page.route('**/api/v1/ai/evaluate-writing', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AI_UNAVAILABLE', message: 'stub' } }) });
    });
    const probe = page.waitForResponse((response) => response.url().endsWith('/api/v1/me'), { timeout: 15_000 }).catch(() => null);
    await page.goto(baseUrl, { waitUntil: 'load' });
    await probe;
    await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 15_000 });

    await page.getByRole('button', { name: 'Письмо', exact: true }).click();
    await page.locator('#scr8.on').waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByRole('textbox', { name: 'Письменный ответ' })
      .fill(Array.from({ length: 105 }, (_, index) => `word${index + 1}`).join(' '));

    const clickedAt = Date.now();
    await page.getByRole('button', { name: 'Проверить с ИИ' }).click();
    await page.locator('#scr13.on').waitFor({ state: 'visible', timeout: 3_000 });
    return Date.now() - clickedAt;
  } finally {
    await context.close();
  }
}

// Every budget is measured and printed before anything fails, so one exceeded metric never hides
// the state of the others.
const exceeded = [];

function report(name, value, budget, unit) {
  const within = value <= budget;
  const shown = `${value.toFixed(unit === 'ms' ? 0 : 3)}${unit}`;
  console.log(`performance: ${name} = ${shown} (бюджет ${budget}${unit}) — ${within ? 'ok' : 'ПРЕВЫШЕНО'}`);
  if (!within) exceeded.push(`${name}: ${shown} при бюджете ${budget}${unit}`);
}

async function run() {
  let temporaryDirectory;
  let child;
  let browser;
  try {
    const executablePath = await chromeExecutable();
    browser = await chromium.launch({ headless: true, executablePath });
    const context = await browser.newContext();
    await context.addInitScript(COLLECTOR);
    const page = await context.newPage();

    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-perf-'));
    const port = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const dataFile = path.join(temporaryDirectory, 'data.json');
    await fs.writeFile(dataFile, JSON.stringify({
      users: {
        perfuser: {
          created: Date.now(),
          sub_until: Date.now() + 86_400_000,
          privacy_consent: { text_processing: true, voice_processing: true, policy_version: '2026-07-20', updated_at: Date.now() },
        },
      },
    }), 'utf8');
    const jwtSecret = 'e2e-test-secret-with-at-least-32-characters';
    const output = [];
    child = spawn(process.execPath, [serverPath], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        APP_URL: baseUrl,
        DATABASE_PROVIDER: 'file',
        DATA_FILE: dataFile,
        JWT_SECRET: jwtSecret,
        TELEGRAM_BOT_TOKEN: '',
        ADMIN_TELEGRAM_ID: '',
        XAI_API_KEY: '',
        GROQ_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    await waitForReady(baseUrl, child, output);

    // Waiting for the session probe rather than for networkidle: the page pulls fonts from an
    // external host, and an early click would be undone when the probe returns to the login screen.
    const sessionProbe = page.waitForResponse((response) => response.url().endsWith('/api/v1/me'), { timeout: 15_000 })
      .catch(() => null);
    await page.goto(baseUrl, { waitUntil: 'load' });
    await sessionProbe;
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Попробовать демо' }).click();
    await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 15_000 });

    // Walk the screens a student opens first, so layout shifts and slow handlers show up.
    // The module tiles are cards made operable by the shared helper, hence role and label.
    for (const module of ['Слова', 'Грамматика', 'Чтение', 'Аудирование']) {
      await page.getByRole('button', { name: module, exact: true }).click();
      await page.waitForTimeout(400);
      await page.evaluate(() => window.tab('scr1'));
      await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    }
    // Give the observers a moment to flush the last entries.
    await page.waitForTimeout(500);

    const vitals = await page.evaluate(() => ({
      lcp: window.__vitals.lcp,
      cls: window.__vitals.cls,
      interactions: [...window.__vitals.interactions.values()].sort((first, second) => second - first),
      scriptBytes: performance.getEntriesByType('resource')
        .filter((entry) => entry.name.endsWith('.js'))
        .reduce((total, entry) => total + (entry.encodedBodySize || 0), 0),
    }));

    // Below fifty interactions the field definition of INP is the worst one; the 98th percentile
    // only kicks in for long sessions. This walk is short, so the worst interaction is the number.
    const inp = vitals.interactions.length ? vitals.interactions[0] : 0;
    report('LCP', vitals.lcp, BUDGET.lcpMs, 'ms');
    report('CLS', vitals.cls, BUDGET.cls, '');
    report('INP', inp, BUDGET.inpMs, 'ms');
    console.log(`performance: JavaScript по сети ${(vitals.scriptBytes / 1024).toFixed(0)} КБ, взаимодействий измерено ${vitals.interactions.length}`);

    console.log(`performance: взаимодействия по убыванию, мс: ${vitals.interactions.map((value) => value.toFixed(0)).join(', ')}`);

    // Section 19 also requires the loading state to appear within 200 ms of the action. Demo mode
    // answers locally and never shows it, so this is measured on a real session whose AI call is
    // deliberately slow — exactly the case the requirement is about.
    const loadingDelayMs = await measureAiLoadingState(browser, baseUrl, jwtSecret);
    report('индикатор проверки ИИ', loadingDelayMs, 200, 'ms');

    // A metric that was not collected is a broken measurement, not a pass.
    assert.ok(vitals.lcp > 0, 'LCP не измерен — наблюдатель не получил ни одной записи');
    assert.ok(vitals.interactions.length > 0, 'ни одного взаимодействия не измерено — проверьте сценарий');

    if (exceeded.length) {
      throw new Error(`Бюджеты раздела 19 превышены:\n  - ${exceeded.join('\n  - ')}`);
    }
    console.log('e2e: показатели производительности в пределах бюджета раздела 19');
  } finally {
    if (browser) await browser.close();
    if (child) await stopProcess(child);
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
