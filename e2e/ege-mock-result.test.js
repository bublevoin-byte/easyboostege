import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, openLatestEgeResult,
  stopProcess, waitForReady,
} from './browser-server-harness.js';
import { getEgeMockForm } from '../ege-mock/catalog.js';
import { createFileRepository } from '../storage/file-repository.js';
import { completeEgeMockOralStageLedger } from '../test/support/ege-mock-attempt-contract.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const username = 'ege-mock-result-user';
const jwtSecret = 'ege-mock-result-e2e-secret-32-characters';

const mutation = (body) => ({
  ...body,
  idempotencyKey: crypto.randomUUID(),
  requestHash: crypto.randomBytes(32).toString('hex'),
});

async function waitForResultAfterReload(page) {
  const heading = page.getByRole('heading', { name: /^0–(?:20|40) из 82$/u });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await heading.isVisible().catch(() => false)) return;
    if (await page.locator('#scr1.on').count()) {
      await openLatestEgeResult(page);
    }
    await page.waitForTimeout(100);
  }
  await heading.waitFor({ timeout: 1 });
}

let browser;
let child;
let context;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-result-'));
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const createdAt = Date.now();
  await fs.writeFile(dataFile, JSON.stringify({
    users: { [username]: {
      created: createdAt, sub_until: createdAt + 86_400_000,
      privacy_consent: {
        text_processing: true, voice_processing: false,
        policy_version: '2026-08-26-vk-id-v1', updated_at: new Date(createdAt).toISOString(),
      },
    } },
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
  const seededHistory = await repository.getEgeMockHistory(username, { now: () => new Date() });
  assert.equal(seededHistory.baselineAttemptId, started.attempt.id);

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
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  }, null, { timeout: 15_000 });
  await openLatestEgeResult(page);
  try {
    await page.getByRole('heading', { name: /^0–(?:20|40) из 82$/u }).waitFor({ timeout: 15_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(async (attemptId) => ({
      active: document.querySelector('.screen.on')?.id,
      area: document.querySelector('#ege_mock_area')?.textContent,
      current: await fetch('/api/v1/ege-mocks/attempts/current', {
        headers: { 'X-EasyBoost-Expected-Owner': 'ege-mock-result-user' },
      }).then((response) => response.json()),
      result: await fetch(`/api/v1/ege-mocks/attempts/${attemptId}/result`, {
        headers: { 'X-EasyBoost-Expected-Owner': 'ege-mock-result-user' },
      }).then((response) => response.json()),
    }), started.attempt.id);
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}\n${output.join('').slice(-4_000)}`);
  }
  const resultText = await page.locator('#ege_mock_area').innerText();
  assert.match(resultText, /Оценка ещё не готова/u);
  assert.match(resultText, /Прогноз тестового балла: 0–(?:24|49)/u);
  assert.match(resultText, /не официальный результат ЕГЭ/u);
  assert.match(resultText, /История пробников/u);
  assert.match(resultText, /Исходная диагностика/u);
  assert.match(resultText, /не засчитываются как освоение/u);
  assert.equal(await page.locator('.ege-mock__result-review details').count(), 42);
  assert.equal(await page.locator('#ege_mock_result_title').evaluate((node) => node === document.activeElement), true);
  assert.deepEqual(await page.locator('.ege-mock__result button:visible').evaluateAll((buttons) => (
    buttons.filter((button) => button.getBoundingClientRect().height < 44).map((button) => button.textContent)
  )), []);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `result overflowed at ${width}px`);
  }
  await page.setViewportSize({ width: 375, height: 812 });

  await context.setOffline(true);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.egeAction = 'result-refresh';
    button.textContent = 'Test offline authoritative refresh';
    document.getElementById('ege_mock_area').appendChild(button);
  });
  await page.getByRole('button', { name: 'Test offline authoritative refresh' }).press('Enter');
  await page.getByRole('button', { name: 'Повторить загрузку' }).waitFor();
  assert.equal(await page.locator('#scr16.on').count(), 1,
    'offline recovery must remain in the explicit fail-closed EGE runner');
  const offlineText = await page.locator('#ege_mock_area').innerText();
  assert.match(offlineText, /Результат не загрузился/u);
  assert.doesNotMatch(offlineText, /войти через Telegram/iu,
    'offline EGE recovery must not pass on an unrelated authentication screen');
  assert.doesNotMatch(offlineText, /из 82/u,
    'offline recovery must not invent or reuse an unconfirmed result');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Повторить загрузку' }).press('Enter');
  await waitForResultAfterReload(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForResultAfterReload(page);

  const secondPage = await context.newPage();
  await secondPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await openLatestEgeResult(secondPage);
  await secondPage.getByRole('heading', { name: /^0–(?:20|40) из 82$/u }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Начать тренировочный повтор' }).press('Enter');
  const repeatDialog = page.getByRole('dialog', { name: 'Начать тренировочный повтор?' });
  await repeatDialog.waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'ege_mock_confirm_cancel');
  await page.locator('#ege_mock_confirm_dialog').press('Escape');
  await repeatDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.egeAction), 'result-repeat');
  assert.equal(await page.getByRole('button', { name: 'Начать тренировочный повтор' }).isEnabled(), true,
    'cancelling confirmation cannot permanently disable the only repeat control');

  await page.route('**/api/v1/ege-mocks/attempts/*/result', (route) => route.abort());
  await page.route('**/api/v1/ege-mocks/attempts/history', (route) => route.abort());
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.egeAction = 'result-refresh';
    button.textContent = 'Test authoritative refresh';
    document.getElementById('ege_mock_area').appendChild(button);
  });
  await page.getByRole('button', { name: 'Test authoritative refresh' }).press('Enter');
  await page.getByRole('button', { name: 'Повторить загрузку' }).waitFor();
  assert.doesNotMatch(await page.locator('#ege_mock_area').innerText(), /из 82/u,
    'a standalone history view must fail closed instead of showing an unconfirmed stale tuple');
  await page.unroute('**/api/v1/ege-mocks/attempts/*/result');
  await page.unroute('**/api/v1/ege-mocks/attempts/history');
  await page.getByRole('button', { name: 'Повторить загрузку' }).press('Enter');
  await page.getByRole('button', { name: 'Начать тренировочный повтор' }).waitFor({ timeout: 15_000 });

  await page.locator('[data-ege-action="result-repeat"]').press('Enter');
  const acceptedRepeatDialog = page.locator('#ege_mock_confirm_dialog[open]');
  await acceptedRepeatDialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#ege_mock_confirm_title').innerText(),
    'Начать тренировочный повтор?');
  assert.equal(await page.locator('#ege_mock_confirm_accept').innerText(),
    'Начать тренировочный повтор');
  await page.locator('#ege_mock_confirm_accept').press('Enter');
  await page.waitForFunction(() => !document.querySelector('[data-ege-action="result-repeat"]'), null,
    { timeout: 15_000 });
  const ownerHeaders = { 'X-EasyBoost-Expected-Owner': username };
  const current = await (await context.request.get(
    `${baseUrl}/api/v1/ege-mocks/attempts/current`, { headers: ownerHeaders },
  )).json();
  assert.equal(current.attempt.mode, 'training');
  assert.notEqual(current.attempt.id, started.attempt.id);
  assert.equal(current.attempt.formId, form.id);
  assert.equal(current.attempt.formRevision, form.revision);
  assert.equal(current.attempt.catalogFingerprint, form.fingerprint);
  const history = await (await context.request.get(
    `${baseUrl}/api/v1/ege-mocks/attempts/history`, { headers: ownerHeaders },
  )).json();
  assert.equal(history.baselineAttemptId, started.attempt.id);
  assert.deepEqual(history.attempts.map(({ id, isBaseline }) => ({ id, isBaseline })), [
    { id: started.attempt.id, isBaseline: true },
  ]);
  const secondTabText = await secondPage.locator('#ege_mock_area').innerText();
  assert.match(secondTabText, /Исходная диагностика|Старая попытка закрыта/u,
    'another tab must retain the immutable result or hide its invalidated local projection');
  if (/Старая попытка закрыта/u.test(secondTabText)) assert.doesNotMatch(secondTabText, /из 82/u);
  await secondPage.close();
  assert.deepEqual(pageErrors, []);
  console.log('EGE mock result E2E passed: honest total, history, a11y, responsive, offline recovery, reload, cross-tab and training-only repeat');
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
