import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, stopProcess, waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const jwtSecret = 'aisy-progress-profile-e2e-secret-32';

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-progress-profile-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const now = Date.now();
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      learner: { created: now, sub_until: now + 7 * 86_400_000 },
    },
    progress: { learner: {} },
  }), 'utf8');

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
      XAI_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false',
      ADAPTIVE_LEARNING_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const { context, page } = await createActiveSubscriptionPage(browser, {
    baseUrl, username: 'learner', jwtSecret,
    contextOptions: {
      viewport: { width: 320, height: 720 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    },
  });
  const pageErrors = [];
  const consoleErrors = [];
  const adaptiveRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', (request) => { if (request.url().includes('/adaptive-learning/overview')) adaptiveRequests.push(`request:${request.method()}`); });
  page.on('response', (response) => { if (response.url().includes('/adaptive-learning/overview')) adaptiveRequests.push(`response:${response.status()}`); });
  page.on('requestfailed', (request) => { if (request.url().includes('/adaptive-learning/overview')) adaptiveRequests.push(`failed:${request.failure()?.errorText}`); });
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#aisy-shell-nav [data-destination="progress"]').press('Enter');
  const progress = page.locator('#scr10.on');
  await progress.waitFor({ state: 'visible' });
  try {
    await progress.locator('#progress_guidance[aria-busy="false"]').waitFor({ state: 'visible', timeout: 5_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      currentUser: window.currentUser,
      generation: window.EasyBoostSync?.ownerBoundGeneration?.('learner'),
      subscription: window.__sub,
      busy: document.getElementById('progress_guidance')?.getAttribute('aria-busy'),
      source: document.getElementById('progress_guidance')?.dataset.source,
    }));
    throw new Error(`Progress narrative did not settle: ${error.message}\nstate=${JSON.stringify(state)}\nadaptive=${adaptiveRequests.join(' | ')}\npage=${pageErrors.join(' | ')}\nconsole=${consoleErrors.join(' | ')}`);
  }
  assert.equal(await progress.getByRole('heading', { name: 'Прогресс', exact: true }).count(), 1);
  assert.equal(await progress.locator('#progress_evidence_legend > li').count(), 3);
  const progressText = await progress.innerText();
  assert.match(progressText, /Следующий шаг.*Что улучшилось.*Что требует внимания/isu);
  assert.match(progressText, /Самостоятельно.*С помощью.*Ориентировочно/su);
  assert.doesNotMatch(progressText, /Base|IELTS/u);
  assert.equal(await progress.locator('#progress_next_action').evaluate((button) => button.getBoundingClientRect().height >= 44), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

  await progress.locator('#progress_next_action').press('Enter');
  await page.locator('#aisy-practice.on').waitFor({ state: 'visible' });
  await page.locator('#aisy-shell-nav [data-destination="profile"]').press('Enter');
  const profile = page.locator('#scr11.on');
  await profile.waitFor({ state: 'visible' });
  await profile.locator('#privacyProfileButton').waitFor({ state: 'visible' });
  assert.equal(await profile.locator('[data-profile-group]').count(), 4);
  assert.equal(await profile.locator('#pf_plan_name').innerText(), 'Premium');
  assert.match(await profile.locator('#pf_plan_summary').innerText(), /учебный доступ активен/u);
  const profileText = await profile.innerText();
  assert.match(profileText, /Учёба.*Ася и приватность.*Подписка.*Аккаунт и данные/sui);
  assert.match(profileText, /микрофон.*внешнему AI-провайдеру/su);
  assert.match(profileText, /Скачать мои данные.*Удалить аккаунт/su);
  assert.doesNotMatch(profileText, /Base|родител|преподавател|учител/iu);

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 760 : 900 });
    await page.locator('#aisy-shell-nav [data-destination="progress"]').press('Enter');
    await page.locator('#scr10.on #progress_guidance[aria-busy="false"]').waitFor({ state: 'visible' });
    const progressContour = await page.evaluate(() => ({
      viewportWidth: innerWidth,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      frameBounded: (document.getElementById('frame')?.getBoundingClientRect().width || Infinity) <= 720,
      screenOverflow: document.getElementById('scr10')?.scrollWidth > document.getElementById('scr10')?.clientWidth,
    }));
    assert.deepEqual(progressContour, {
      viewportWidth: width, documentOverflow: false, frameBounded: true, screenOverflow: false,
    });
    await page.locator('#aisy-shell-nav [data-destination="profile"]').press('Enter');
    await page.locator('#scr11.on [data-profile-group="account-data"]').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
        && document.getElementById('scr11').scrollWidth <= document.getElementById('scr11').clientWidth
    )), true);
  }
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log('Aisy Progress/Profile Chromium E2E passed.');
} finally {
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
