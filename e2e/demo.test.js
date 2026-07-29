import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { chromium, devices, firefox, webkit } from 'playwright';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

async function findAvailablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
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
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next standard browser location.
    }
  }
  throw new Error('Chrome/Chromium executable was not found. Set CHROME_PATH.');
}

const browserEngine = process.env.E2E_BROWSER || 'chromium';
const browserProfile = process.env.E2E_PROFILE || 'desktop';
if (!['chromium', 'firefox', 'webkit'].includes(browserEngine)) {
  throw new Error('E2E_BROWSER must be chromium, firefox or webkit');
}
if (!['desktop', 'android', 'iphone'].includes(browserProfile)) {
  throw new Error('E2E_PROFILE must be desktop, android or iphone');
}
if (browserProfile === 'android' && browserEngine !== 'chromium') {
  throw new Error('The android profile requires E2E_BROWSER=chromium');
}
if (browserProfile === 'iphone' && browserEngine !== 'webkit') {
  throw new Error('The iphone profile requires E2E_BROWSER=webkit');
}

async function launchBrowser() {
  if (browserEngine === 'webkit') return webkit.launch({ headless: true });
  if (browserEngine === 'firefox') {
    return firefox.launch({
      headless: true,
      env: process.platform === 'win32'
        ? { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: '1' }
        : process.env,
    });
  }
  return chromium.launch({ headless: true, executablePath: await chromeExecutable() });
}

function contextOptions(overrides = {}) {
  const profile = browserProfile === 'android'
    ? devices['Pixel 7']
    : browserProfile === 'iphone'
      ? devices['iPhone 15']
      : {};
  return { ...profile, ...overrides };
}

async function runE2E() {
  let temporaryDirectory;
  let child;
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext(contextOptions());
    const page = await context.newPage();
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-e2e-'));
    const port = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const dataFile = path.join(temporaryDirectory, 'data.json');
    const jwtSecret = 'e2e-test-secret-with-at-least-32-characters';
    await fs.writeFile(dataFile, JSON.stringify({
      users: {
        e2euser: {
          created: Date.now(),
          sub_until: Date.now() + 86_400_000,
          privacy_consent: {
            text_processing: true,
            voice_processing: true,
            policy_version: '2026-07-20',
            updated_at: Date.now(),
          },
        },
        expireduser: { created: Date.now(), sub_until: Date.now() - 60_000 },
      },
      progress: {
        e2euser: { words: { known: 0 } },
        expireduser: {},
      },
    }));
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
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    console.log('e2e: login screen loaded');

    await assert.doesNotReject(() => page.getByRole('button', { name: 'Попробовать демо' }).click());
    const wordsCard = page.getByRole('button', { name: 'Слова', exact: true });
    await wordsCard.waitFor({ state: 'visible' });
    assert.equal(await wordsCard.getAttribute('tabindex'), '0');
    await wordsCard.press('Enter');
    console.log('e2e: words module opened by keyboard');

    await page.locator('#scr2.on').waitFor({ state: 'visible', timeout: 5_000 });
    const options = page.locator('#w_opts button');
    const optionCount = await options.count();
    console.log(`e2e: ${optionCount} answer options found`);
    assert.ok(optionCount >= 4);
    const promptBefore = await page.locator('#w_card').innerText();
    console.log('e2e: prompt captured');
    await options.nth(0).click({ timeout: 5_000 });
    await page.waitForFunction((previous) => document.querySelector('#w_card')?.innerText !== previous, promptBefore, { timeout: 5_000 });
    console.log('e2e: word task advanced');

    const pwa = await page.evaluate(async (origin) => {
      const manifest = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
      const registration = await navigator.serviceWorker.getRegistration();
      return { manifest, scope: registration?.scope || null, expectedScope: `${origin}/` };
    }, baseUrl);
    assert.equal(pwa.manifest, '/manifest.json');
    assert.equal(pwa.scope, pwa.expectedScope);

    await context.close();

    const authenticatedContext = await browser.newContext(contextOptions({ serviceWorkers: 'block' }));
    await authenticatedContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'e2euser' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const authenticatedPage = await authenticatedContext.newPage();
    const evaluatedWritingTasks = [];
    await authenticatedPage.route('**/api/v1/ai/evaluate-writing', async (route) => {
      const request = route.request();
      const input = request.postDataJSON();
      const task37 = input.taskType === 'writing_37';
      const criteria = task37
        ? [
            { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
            { name: 'Организация текста', got: 2, max: 2 },
            { name: 'Языковое оформление', got: 2, max: 2 },
          ]
        : [
            { name: 'Решение коммуникативной задачи', got: 3, max: 3 },
            { name: 'Организация текста', got: 3, max: 3 },
            { name: 'Лексика', got: 3, max: 3 },
            { name: 'Грамматика', got: 3, max: 3 },
            { name: 'Орфография и пунктуация', got: 2, max: 2 },
          ];
      evaluatedWritingTasks.push(input.taskType);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          review: {
            words: input.answer.trim().split(/\s+/u).length,
            in_range: true,
            overall_got: criteria.reduce((total, criterion) => total + criterion.got, 0),
            overall_max: task37 ? 6 : 14,
            verdict: task37 ? 'Задание 37 проверено' : 'Задание 38 проверено',
            sub: 'Изолированный E2E-разбор',
            criteria,
            errors: [],
          },
          provider: 'e2e',
          attemptId: task37 ? 'writing-37-e2e' : 'writing-38-e2e',
        }),
      });
    });
    await authenticatedPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    console.log('e2e: authenticated session restored');

    await authenticatedPage.evaluate(() => window.EasyBoostSync.setBaseline({ words: { known: 0 } }));
    await authenticatedContext.setOffline(true);
    const savedOffline = await authenticatedPage.evaluate(() => window.EasyBoostSync.saveProgress({ words: { known: 1 } }));
    assert.equal(savedOffline, false);
    assert.equal(await authenticatedPage.evaluate(() => window.EasyBoostSync.hasPending()), true);
    console.log('e2e: offline progress queued');

    await authenticatedContext.setOffline(false);
    assert.equal(await authenticatedPage.evaluate(() => window.EasyBoostSync.flush()), true);
    assert.equal(await authenticatedPage.evaluate(() => window.EasyBoostSync.hasPending()), false);
    console.log('e2e: queued progress synchronized');
    await authenticatedPage.reload({ waitUntil: 'networkidle' });
    const persisted = await authenticatedPage.evaluate(async () => (await fetch('/api/v1/progress')).json());
    assert.equal(persisted.words.known, 1);
    console.log('e2e: progress persisted after reload');

    // Section 6.1: built-in tasks and saved progress must survive a start without network.
    const snapshot = await authenticatedPage.evaluate(() => {
      const user = localStorage.getItem('eb_current');
      const state = window.EasyBoostStore.loadLocal(user);
      state.learned = 42;
      state.prog.words = 63;
      state.prog.read = 55;
      state.streak = 7;
      window.EasyBoostStore.saveLocal(user, state);
      return window.EasyBoostStore.loadLocal(user).learned;
    });
    assert.equal(snapshot, 42, 'the running app keeps a local snapshot for offline starts');
    await authenticatedContext.setOffline(true);
    await authenticatedPage.evaluate(() => window.startApp());
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await authenticatedPage.locator('#m_words').textContent(), '63');
    assert.equal(await authenticatedPage.locator('#m_read').textContent(), '55');
    assert.match(await authenticatedPage.locator('#h_streak').textContent(), /7 дней подряд/u);
    console.log('e2e: saved progress readable without network');

    await authenticatedPage.getByRole('button', { name: 'Слова', exact: true }).press('Enter');
    await authenticatedPage.locator('#scr2.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.ok(await authenticatedPage.locator('#w_opts button').count() >= 2);
    await authenticatedPage.evaluate(() => window.tab('scr1'));
    await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: 'Грамматика', exact: true }).press('Enter');
    await authenticatedPage.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.ok(await authenticatedPage.locator('#g_area button').count() >= 1);
    console.log('e2e: built-in word and grammar tasks work offline');
    await authenticatedContext.setOffline(false);
    await authenticatedPage.evaluate(() => window.tab('scr1'));

    await authenticatedPage.getByRole('button', { name: 'Письмо', exact: true }).press('Enter');
    await authenticatedPage.locator('#scr8.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: '37 · Письмо другу' }).click();
    await authenticatedPage.getByRole('textbox', { name: 'Письменный ответ' }).fill(
      Array.from({ length: 105 }, (_, index) => `word${index + 1}`).join(' '),
    );
    await authenticatedPage.getByRole('button', { name: 'Проверить с ИИ' }).click();
    await authenticatedPage.locator('#scr12.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.waitForFunction(
      () => document.querySelector('#rv_score')?.textContent === '6',
      null,
      { timeout: 5_000 },
    );
    assert.equal(await authenticatedPage.locator('#rv_score').textContent(), '6');
    assert.equal(await authenticatedPage.locator('#rv_verdict').innerText(), 'Задание 37 проверено');

    await authenticatedPage.getByRole('button', { name: 'Исправить' }).click();
    await authenticatedPage.getByRole('button', { name: '38 · Проект' }).click();
    await authenticatedPage.getByRole('textbox', { name: 'Письменный ответ' }).fill(
      Array.from({ length: 205 }, (_, index) => `project${index + 1}`).join(' '),
    );
    await authenticatedPage.getByRole('button', { name: 'Проверить с ИИ' }).click();
    await authenticatedPage.locator('#scr12.on').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.waitForFunction(
      () => document.querySelector('#rv_score')?.textContent === '14',
      null,
      { timeout: 5_000 },
    );
    assert.equal(await authenticatedPage.locator('#rv_score').textContent(), '14');
    assert.equal(await authenticatedPage.locator('#rv_verdict').innerText(), 'Задание 38 проверено');
    assert.deepEqual(evaluatedWritingTasks, ['writing_37', 'writing_38']);
    console.log('e2e: writing tasks 37 and 38 received structured reviews');

    await authenticatedPage.getByRole('button', { name: 'Исправить' }).click();
    await authenticatedPage.getByRole('button', { name: 'Главная' }).click();
    await authenticatedPage.evaluate(() => {
      window.__e2eMicrophoneMode = 'success';
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (window.__e2eMicrophoneMode === 'denied') {
              throw new DOMException('Permission denied', 'NotAllowedError');
            }
            return { getTracks: () => [{ stop() {} }] };
          },
        },
      });
      class E2EMediaRecorder {
        static isTypeSupported(type) {
          return type === 'audio/webm';
        }

        constructor() {
          this.mimeType = 'audio/webm';
          this.state = 'inactive';
          this.ondataavailable = null;
          this.onstop = null;
        }

        start() {
          this.state = 'recording';
        }

        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob(['e2e-audio'], { type: this.mimeType }) });
          this.onstop?.();
        }
      }
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: E2EMediaRecorder });
      URL.createObjectURL = () => 'blob:e2e-recording';
      URL.revokeObjectURL = () => {};
    });

    await authenticatedPage.getByRole('button', { name: 'Говорение', exact: true }).press('Enter');
    const speakingTask = authenticatedPage.getByRole('button', { name: /Чтение вслух/ });
    await speakingTask.waitFor({ state: 'visible', timeout: 5_000 });
    await speakingTask.press('Enter');
    await authenticatedPage.getByRole('button', { name: 'Начать подготовку' }).click();
    await authenticatedPage.getByRole('button', { name: 'Готово — к записи' }).click();
    await authenticatedPage.getByRole('button', { name: 'Стоп — закончить запись' }).click();
    await authenticatedPage.getByText('Запись готова!').waitFor({ state: 'visible', timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: 'Удалить запись' }).waitFor({ state: 'visible' });
    console.log('e2e: successful speaking recording completed');

    await authenticatedPage.getByRole('button', { name: 'К заданиям', exact: true }).click({ force: true });
    await authenticatedPage.evaluate(() => { window.__e2eMicrophoneMode = 'denied'; });
    await authenticatedPage.getByRole('button', { name: /Чтение вслух/ }).press('Enter');
    await authenticatedPage.getByRole('button', { name: 'Начать подготовку' }).click();
    await authenticatedPage.getByRole('button', { name: 'Готово — к записи' }).click();
    const microphoneToast = authenticatedPage.locator('#toast');
    await microphoneToast.waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await microphoneToast.innerText(), /Нет доступа к микрофону/);
    await authenticatedPage.getByRole('button', { name: 'Начать подготовку' }).waitFor({ state: 'visible' });
    console.log('e2e: microphone denial handled without losing the task');

    await authenticatedPage.getByRole('button', { name: '← К заданиям' }).click();
    await authenticatedPage.getByRole('button', { name: 'Главная' }).click();
    const profileButton = authenticatedPage.locator('#scr1.on [role="button"][aria-label="Профиль"]');
    assert.equal(await profileButton.count(), 1);
    await profileButton.press('Enter');
    console.log('e2e: profile opened by keyboard');
    const privacySheet = authenticatedPage.locator('#privacySheet.open');
    if (await privacySheet.count()) {
      await authenticatedPage.getByRole('button', { name: 'Сохранить выбор' }).click();
      await privacySheet.waitFor({ state: 'hidden', timeout: 5_000 });
    }
    const logoutButton = authenticatedPage.locator('#scr11.on').getByRole('button', { name: 'Выйти', exact: true });
    await logoutButton.waitFor({ state: 'visible', timeout: 5_000 });
    await logoutButton.click({ timeout: 5_000 });
    await authenticatedPage.getByRole('button', { name: 'Попробовать демо' }).waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal((await authenticatedContext.cookies()).some((cookie) => cookie.name === 'eb_token'), false);
    await authenticatedContext.close();

    const expiredContext = await browser.newContext(contextOptions());
    await expiredContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'expireduser' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const expiredPage = await expiredContext.newPage();
    await expiredPage.goto(baseUrl, { waitUntil: 'networkidle' });
    const paywall = expiredPage.locator('#pw_ov');
    await paywall.waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await paywall.innerText(), /Чтобы заниматься, оформи доступ/);
    const botLink = paywall.getByRole('link', { name: 'Открыть Telegram-бот' });
    assert.match(await botLink.getAttribute('href'), /^https:\/\/t\.me\//);
    console.log('e2e: expired subscription shows recovery path');
    await expiredContext.close();

    const viewportMatrix = [
      { width: 320, height: 568 },
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
      { width: 1440, height: 900 },
    ];
    for (const viewport of viewportMatrix) {
      const viewportContext = await browser.newContext(contextOptions({ viewport }));
      const viewportPage = await viewportContext.newPage();
      await viewportPage.goto(baseUrl, { waitUntil: 'networkidle' });
      await viewportPage.getByRole('button', { name: 'Попробовать демо' }).click();
      await viewportPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
      const layout = await viewportPage.evaluate(() => {
        const frame = document.querySelector('#frame').getBoundingClientRect();
        const activeScreen = document.querySelector('.screen.on').getBoundingClientRect();
        const interactive = [...document.querySelectorAll('.screen.on button, .screen.on a, .screen.on input, .screen.on textarea, .screen.on [role="button"]')]
          .filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40) || element.id,
              width: rect.width,
              height: rect.height,
            };
          });
        const homeScroll = document.querySelector('#scr1 .homeScroll');
        const homeNav = document.querySelector('#scr1 .navclay');
        homeScroll.scrollTop = homeScroll.scrollHeight;
        const lastContent = homeScroll.lastElementChild.getBoundingClientRect();
        const navigation = homeNav.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          frameWidth: frame.width,
          frameLeft: frame.left,
          frameRight: frame.right,
          screenLeft: activeScreen.left,
          screenRight: activeScreen.right,
          undersized: interactive.filter((item) => item.width < 44 || item.height < 44),
          lastContentBottom: lastContent.bottom,
          navigationTop: navigation.top,
        };
      });
      assert.ok(layout.documentWidth <= layout.viewportWidth);
      assert.ok(layout.frameLeft >= -0.5 && layout.frameRight <= layout.viewportWidth + 0.5);
      assert.ok(layout.screenLeft >= -0.5 && layout.screenRight <= layout.viewportWidth + 0.5);
      assert.ok(layout.frameWidth <= 720, `content line length is too wide at ${viewport.width}px`);
      assert.deepEqual(layout.undersized, [], `undersized controls at ${viewport.width}px`);
      assert.ok(layout.lastContentBottom <= layout.navigationTop, `content overlaps navigation at ${viewport.width}px`);
      await viewportContext.close();
    }
    console.log('e2e: responsive matrix 320–1440 px has no horizontal overflow');
  } finally {
    if (browser) await browser.close();
    if (child) await stopProcess(child);
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

runE2E()
  .then(() => console.log(`e2e: ${browserEngine}/${browserProfile} critical user flows passed`))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
