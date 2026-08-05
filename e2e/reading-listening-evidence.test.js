import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';
import { availablePort, chromeExecutable, stopProcess, waitForReady } from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-reading-listening-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const jwtSecret = 'reading-listening-e2e-secret-32-characters';
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      'evidence-user': { created: Date.now(), sub_until: Date.now() + 86_400_000 },
    },
    progress: { 'evidence-user': {} },
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
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.addCookies([{
    name: 'eb_token',
    value: jwt.sign({ u: 'evidence-user' }, jwtSecret, { expiresIn: '1h' }),
    url: baseUrl,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });

  await page.evaluate(() => window.tab('scr7'));
  await page.locator('#scr7.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.getByRole('button', { name: 'Заголовки' }).press('Enter');
  for (let index = 0; index < 4; index += 1) {
    await page.locator(`#rhl_row_${index} button`).nth(index).press('Enter');
  }
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Проверить', exact: true }).press('Enter');
  await page.waitForFunction(() => window.EasyBoostSync.pendingModuleAttempts().length === 1);
  const queued = await page.evaluate(() => window.EasyBoostSync.pendingModuleAttempts()[0]);
  assert.equal(queued.module, 'reading');
  assert.equal(queued.activity, 'reading_headings');
  assert.equal(queued.maxScore, 4);
  assert.equal(Object.keys(queued.metadata).sort().join(','), 'helpUsed,hintsUsed,mode,source');

  await context.setOffline(false);
  await page.waitForFunction(() => window.EasyBoostSync.pendingModuleAttempts().length === 0);

  await page.evaluate(() => window.tab('scr4'));
  await page.locator('#scr4.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.getByRole('button', { name: /Верно · Неверно · Не сказано/u }).press('Enter');
  for (let index = 0; index < 5; index += 1) {
    await page.locator(`#ltf_row_${index} button`).first().press('Enter');
  }
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST' && response.url().endsWith('/api/v1/module-attempts')
  ));
  await page.getByRole('button', { name: 'Проверить', exact: true }).press('Enter');
  assert.equal((await responsePromise).status(), 201);

  const attempts = await fs.readFile(dataFile, 'utf8').then((contents) => (
    JSON.parse(contents).module_attempts || []
  ));
  const learnerAttempts = attempts.filter((attempt) => attempt.username === 'evidence-user');
  assert.deepEqual(learnerAttempts.map((attempt) => attempt.activity).sort(), [
    'listening_true_false', 'reading_headings',
  ]);
  assert.equal(learnerAttempts.every((attempt) => attempt.evidence_quality === 'client_reported'), true);
  assert.deepEqual(pageErrors, []);
  await context.close();
  console.log('Reading/listening evidence Chromium E2E passed.');
} finally {
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
