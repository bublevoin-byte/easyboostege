import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, stopProcess, waitForReady,
} from './browser-server-harness.js';
import { getEgeMockForm } from '../ege-mock/catalog.js';
import { createFileRepository } from '../storage/file-repository.js';
import { completeEgeMockOralStageLedger } from '../test/support/ege-mock-attempt-contract.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const username = 'aisy-ege-hub-user';
const jwtSecret = 'aisy-ege-hub-e2e-secret-32-characters';
const mutation = (body) => ({
  ...body,
  idempotencyKey: crypto.randomUUID(),
  requestHash: crypto.randomBytes(32).toString('hex'),
});

let browser;
let child;
let context;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-ege-hub-'));
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: { [username]: { created: Date.now(), sub_until: Date.now() + 86_400_000 } },
    progress: { [username]: {} },
  }), 'utf8');
  const repository = createFileRepository(dataFile);
  const form = getEgeMockForm('ege-en-2026-form-1', 1);
  const started = await repository.startEgeMockAttempt(username, mutation({
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
  }));
  const written = await repository.submitEgeMockWritten(username, started.attempt.id, mutation({
    expectedRevision: started.attempt.revision,
  }));
  const oral = await repository.startEgeMockOral(username, started.attempt.id, mutation({
    expectedRevision: written.attempt.revision,
  }));
  const staged = await completeEgeMockOralStageLedger(repository, username, oral, mutation);
  await repository.submitEgeMockOral(username, started.attempt.id, mutation({
    expectedRevision: staged.attempt.revision,
  }));

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  child = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file', DATA_FILE: dataFile, JWT_SECRET: jwtSecret,
      TELEGRAM_BOT_TOKEN: '', ADMIN_TELEGRAM_ID: '', XAI_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false', ADAPTIVE_LEARNING_ENABLED: 'false',
      SPEAKING_PRONUNCIATION_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const harness = await createActiveSubscriptionPage(browser, {
    baseUrl, username, jwtSecret,
    contextOptions: { viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' },
  });
  context = harness.context;
  const page = harness.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });

  await page.route('**/api/v1/ege-mocks/attempts/current', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'TEMPORARILY_UNAVAILABLE' } }),
  }));
  await page.getByRole('button', { name: 'ЕГЭ', exact: true }).press('Enter');
  await page.locator('#aisy-ege.on').waitFor();
  await page.getByRole('button', { name: 'Повторить' }).waitFor();
  assert.equal(await page.getByRole('button', {
    name: 'Открыть подготовку к пробнику',
  }).isDisabled(), true, 'an unknown current attempt must fail closed before a new start');
  await page.unroute('**/api/v1/ege-mocks/attempts/current');
  await page.getByRole('button', { name: 'Повторить' }).press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#ege-hub-sections > li').length === 5);
  assert.equal(await page.locator('#scr16.on').count(), 0,
    'top-level EGE navigation must open the hub, not the timed runner');
  const hubText = await page.locator('#aisy-ege').innerText();
  assert.match(hubText, /38 письменных заданий за 190 минут/u);
  assert.match(hubText, /устная часть на 17 минут/u);
  assert.match(hubText, /экспериментальную приблизительную оценку/u);
  assert.doesNotMatch(hubText, /подсказк|правильн.*ответ|Ася/iu);
  assert.equal(await page.locator('#ege-hub-sections > li').count(), 5);
  assert.deepEqual(await page.locator('#ege-hub-sections h3').allTextContents(), [
    'Аудирование', 'Чтение', 'Грамматика и лексика', 'Письмо', 'Говорение',
  ]);
  assert.deepEqual(await page.locator('#aisy-ege button:visible').evaluateAll((buttons) => (
    buttons.filter((button) => button.getBoundingClientRect().height < 44).map((button) => button.textContent)
  )), []);

  await page.getByRole('button', { name: /Открыть результат: Диагностический/u }).first().press('Enter');
  await page.getByRole('heading', { name: /^0–(?:20|40) из 82$/u }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole('button', { name: 'Начать тренировочный повтор' }).count(), 1,
    'the exact result keeps its existing explicit training-repeat action');
  await page.getByRole('button', { name: 'Назад в раздел ЕГЭ' }).press('Enter');
  await page.locator('#aisy-ege.on').waitFor();

  await page.getByRole('button', { name: 'Открыть подготовку к пробнику' }).press('Enter');
  await page.locator('#scr16.on').waitFor();
  await page.getByRole('button', { name: 'Проверить готовность' }).press('Enter');
  try {
    await page.getByRole('button', { name: 'Начать письменную часть' }).waitFor({ timeout: 15_000 });
  } catch (error) {
    throw new Error(`${error.message}\nEGE runner: ${await page.locator('#ege_mock_area').innerText()}\nPage errors: ${pageErrors.join(' | ')}`);
  }
  await page.getByRole('button', { name: 'Начать письменную часть' }).press('Enter');
  await page.getByRole('button', { name: 'Задание 1, пропущено' }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Назад в раздел ЕГЭ' }).press('Enter');
  await page.locator('#aisy-ege.on').waitFor();
  await page.getByRole('button', { name: 'Продолжить пробник' }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole('button', { name: 'Открыть подготовку к пробнику' }).isDisabled(), true);
  await page.getByRole('button', { name: /Открыть результат: Диагностический/u }).first().press('Enter');
  await page.getByRole('heading', { name: /^0–(?:20|40) из 82$/u }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole('button', { name: 'Начать тренировочный повтор' }).count(), 0,
    'a historical result must not offer a conflicting repeat while an attempt is active');
  await page.getByRole('button', { name: 'Назад в раздел ЕГЭ' }).press('Enter');
  await page.getByRole('button', { name: 'Продолжить пробник' }).waitFor({ timeout: 15_000 });

  await context.setOffline(true);
  await page.getByText(/Нет сети.*таймер продолжает идти/u).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Продолжить пробник' }).press('Enter');
  await page.locator('#scr16.on').waitFor();
  await page.waitForFunction(() => !document.querySelector('#ege_mock_area')?.textContent
    ?.includes('Сессия обновлена'), null, { timeout: 15_000 });
  assert.match(await page.locator('#ege_mock_area').innerText(), /Задание 1|сохран|состояние/u);
  await context.setOffline(false);

  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `EGE flow overflowed at ${width}px`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('Aisy EGE hub E2E passed: hub navigation, exact result, strict start/continue and offline recovery');
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
