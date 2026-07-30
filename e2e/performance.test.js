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

// Thresholds straight from section 19; the first-load weight comes from the performance spec.
const BUDGET = { lcpMs: 2500, cls: 0.1, inpMs: 200, firstLoadKb: 150 };

// Раздел 4.2 спеки: код этих экранов приезжает по требованию, при первом переходе на него, и не
// имеет права участвовать в первой загрузке — на этом держится её вес.
const LAZY_SCREENS = [
  'screens/listening.js', 'screens/reading.js',
  'screens/writing.js', 'screens/speaking.js', 'screens/profile.js',
];
// А эти обязаны приехать сразу: раздел 6.1 ТЗ обещает словарные карточки, интервальное повторение,
// встроенные грамматические тесты и просмотр сохранённого прогресса без сети. Ученик может уйти в
// офлайн, ни разу их не открыв. Проверяются оба списка, чтобы ни один не съехал молча в свою сторону.
const SHELL_SCREENS = ['screens/words.js', 'screens/grammar.js', 'screens/progress.js'];

/*
 * Сервер отдаёт `dist/public`, если сборка есть, и `public/` иначе — замер должен идти по тому же
 * правилу. В сборке имя файла больше ничего не говорит: Vite переименовывает чанки в хешированные
 * имена, а три статических экрана вовсе растворяются в точке входа. Поэтому экран сопоставляется с
 * файлом по манифесту сборки, а на исходниках соответствие тождественно.
 *
 * Правило от этого не слабеет, а становится точнее: ленивый экран уезжает в отдельный чанк, и его
 * появление при старте видно; статический попадает в точку входа, и его исчезновение оттуда —
 * тоже. Оба списка проверяются, чтобы ни один не съехал молча в свою сторону.
 */
async function servedScreenFiles() {
  const screens = [...LAZY_SCREENS, ...SHELL_SCREENS];
  let modules = null;
  try {
    const manifest = await fs.readFile(new URL('../dist/public/asset-manifest.json', import.meta.url), 'utf8');
    await fs.access(new URL('../dist/public/index.html', import.meta.url));
    modules = JSON.parse(manifest).modules;
  } catch {
    // Сборки нет — сервер отдаёт исходники, и каждый экран остаётся отдельным файлом.
  }
  const files = new Map();
  for (const screen of screens) {
    const file = modules ? modules[screen] : screen;
    if (!file) throw new Error(`Манифест сборки не знает, в какой файл попал ${screen}`);
    files.set(screen, `/${file}`);
  }
  return { files, built: Boolean(modules) };
}

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

// Вес первой загрузки снимается на отдельном контексте и до любой навигации по экранам: суммировать
// ресурсы после обхода экранов нельзя — в сумму попадут чанки, которые ученик как раз и не платит
// при старте.
//
// Service worker выключен намеренно, и это не осторожность, а условие измеримости: он забирает
// себе все запросы страницы, и тогда `transferSize` равен нулю, `deliveryType` — `cache`, а
// `encodedBodySize` показывает несжатый размер. Байт по сети в таком замере нет вообще, а запрос
// чанка в нём не отличить от попадания в кэш.
async function measureFirstLoad(browser, baseUrl) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const requestedScripts = new Set();
    page.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(baseUrl)) return;
      const { pathname } = new URL(url);
      if (pathname.endsWith('.js')) requestedScripts.add(pathname);
    });
    const sessionProbe = page.waitForResponse((response) => response.url().endsWith('/api/v1/me'), { timeout: 15_000 })
      .catch(() => null);
    await page.goto(baseUrl, { waitUntil: 'load' });
    await sessionProbe;
    // Оболочка ставит подготовку главного экрана после первого кадра; ждём дольше этого, чтобы
    // запоздавший запрос чанка попал в замер, а не остался за его границей.
    await page.waitForTimeout(1_000);

    // encodedBodySize — это байты по сети, со сжатием, а не размер файла на диске. Считаются
    // только свои скрипты: у сторонних источников это поле закрыто и всегда равно нулю.
    const scripts = await page.evaluate((origin) => performance.getEntriesByType('resource')
      .filter((entry) => entry.name.startsWith(origin) && entry.name.endsWith('.js'))
      .map((entry) => ({ encoded: entry.encodedBodySize || 0, decoded: entry.decodedBodySize || 0 })), baseUrl);
    return {
      bytes: scripts.reduce((total, script) => total + script.encoded, 0),
      unpackedBytes: scripts.reduce((total, script) => total + script.decoded, 0),
      files: scripts.length,
      requestedScripts,
    };
  } finally {
    await context.close();
  }
}

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

function report(name, value, budget, unit, digits = unit === 'ms' ? 0 : 3) {
  const within = value <= budget;
  const shown = `${value.toFixed(digits)}${unit}`;
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

    // Первым делом — вес первой загрузки, на чистом контексте, пока ни один экран не открывали.
    const { files: screenFiles, built } = await servedScreenFiles();
    const firstLoad = await measureFirstLoad(browser, baseUrl);
    const screensAtStart = [...LAZY_SCREENS, ...SHELL_SCREENS]
      .filter((screen) => firstLoad.requestedScripts.has(screenFiles.get(screen)));

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
    report('JavaScript первой загрузки', firstLoad.bytes / 1024, BUDGET.firstLoadKb, ' КБ', 1);
    console.log(`performance: первая загрузка — ${firstLoad.files} файлов, ${(firstLoad.unpackedBytes / 1024).toFixed(0)} КБ без сжатия, источник: ${built ? 'сборка dist/public' : 'исходники public'}, экраны: ${screensAtStart.join(', ') || 'ни одного'}`);
    // Этот проход идёт с работающим service worker, поэтому число здесь — несжатый объём всего
    // разобранного JavaScript, а не байты по сети. Оно сравнимо с базовой линией, снятой так же.
    console.log(`performance: JavaScript разобрано к концу обхода ${(vitals.scriptBytes / 1024).toFixed(0)} КБ без сжатия, взаимодействий измерено ${vitals.interactions.length}`);

    console.log(`performance: взаимодействия по убыванию, мс: ${vitals.interactions.map((value) => value.toFixed(0)).join(', ')}`);

    // Section 19 also requires the loading state to appear within 200 ms of the action. Demo mode
    // answers locally and never shows it, so this is measured on a real session whose AI call is
    // deliberately slow — exactly the case the requirement is about.
    const loadingDelayMs = await measureAiLoadingState(browser, baseUrl, jwtSecret);
    report('индикатор проверки ИИ', loadingDelayMs, 200, 'ms');

    // A metric that was not collected is a broken measurement, not a pass.
    assert.ok(vitals.lcp > 0, 'LCP не измерен — наблюдатель не получил ни одной записи');
    assert.ok(vitals.interactions.length > 0, 'ни одного взаимодействия не измерено — проверьте сценарий');
    assert.ok(firstLoad.bytes > 0, 'первая загрузка не измерена — ни одного своего скрипта в записях');

    // Состав первой загрузки — правило, а не наблюдение. Лишний экран в ней возвращает вес,
    // пропавший — офлайн-обещание раздела 6.1.
    assert.deepEqual(
      LAZY_SCREENS.filter((screen) => screensAtStart.includes(screen)), [],
      'при первой загрузке запрошен ленивый экран: его код должен приезжать при первом переходе',
    );
    assert.deepEqual(
      SHELL_SCREENS.filter((screen) => !screensAtStart.includes(screen)), [],
      'экран раздела 6.1 не приехал при первой загрузке: без сети он должен работать сразу',
    );
    // Иначе проверка выше стала бы бессодержательной: если бы ленивый экран лежал в том же файле,
    // что оболочка, «не запрошен при старте» было бы недостижимо, а не выполнено.
    for (const screen of LAZY_SCREENS) {
      assert.ok(
        SHELL_SCREENS.every((shell) => screenFiles.get(shell) !== screenFiles.get(screen)),
        `${screen} лежит в том же файле, что экран оболочки — ленивым он быть перестал`,
      );
    }

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
