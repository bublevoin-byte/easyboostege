import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright-core';

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

test('Chrome E2E: critical user flows are accessible and resilient', { timeout: 60_000 }, async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-e2e-'));
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
  const child = spawn(process.execPath, [serverPath], {
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

  let browser;
  try {
    await waitForReady(baseUrl, child, output);
    browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
    const context = await browser.newContext();
    const page = await context.newPage();
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

    const authenticatedContext = await browser.newContext();
    await authenticatedContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'e2euser' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const authenticatedPage = await authenticatedContext.newPage();
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
    const persisted = await authenticatedPage.evaluate(async () => (await fetch('/api/progress')).json());
    assert.equal(persisted.words.known, 1);
    console.log('e2e: progress persisted after reload');

    await authenticatedPage.getByRole('button', { name: 'Говорение', exact: true }).press('Enter');
    const speakingTask = authenticatedPage.getByRole('button', { name: /Чтение вслух/ });
    await speakingTask.waitFor({ state: 'visible', timeout: 5_000 });
    await speakingTask.press('Enter');
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

    const expiredContext = await browser.newContext();
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
      const viewportContext = await browser.newContext({ viewport });
      const viewportPage = await viewportContext.newPage();
      await viewportPage.goto(baseUrl, { waitUntil: 'networkidle' });
      await viewportPage.getByRole('button', { name: 'Попробовать демо' }).click();
      await viewportPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
      const layout = await viewportPage.evaluate(() => {
        const frame = document.querySelector('#frame').getBoundingClientRect();
        const activeScreen = document.querySelector('.screen.on').getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          frameLeft: frame.left,
          frameRight: frame.right,
          screenLeft: activeScreen.left,
          screenRight: activeScreen.right,
        };
      });
      assert.ok(layout.documentWidth <= layout.viewportWidth);
      assert.ok(layout.frameLeft >= -0.5 && layout.frameRight <= layout.viewportWidth + 0.5);
      assert.ok(layout.screenLeft >= -0.5 && layout.screenRight <= layout.viewportWidth + 0.5);
      await viewportContext.close();
    }
    console.log('e2e: responsive matrix 320–1440 px has no horizontal overflow');
  } finally {
    if (browser) await browser.close();
    await stopProcess(child);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});
