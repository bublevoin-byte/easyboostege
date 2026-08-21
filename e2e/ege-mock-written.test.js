import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';
import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, openEgeHub, openEgeMock,
  stopProcess, waitForReady,
} from './browser-server-harness.js';
import { EGE_MOCK_FORM_1_V1_PUBLIC as egeForm } from '../public/ege-mock-form-1-v1.js';
import { egeMockAssetPlaybackUrl } from '../public/ege-mock-written-assets.js';
import { AUTOMATIC_ASSESSMENT_WARNING } from '../public/automatic-assessment-contract.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const username = 'ege-mock-written-user';
const otherUsername = 'ege-mock-written-other';
const jwtSecret = 'ege-mock-written-e2e-secret-32-characters';

let browser;
let child;
let context;
let authorityContext;
let importFailureContext;
let currentFailureContext;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-written-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      [username]: { created: Date.now(), sub_until: Date.now() + 86_400_000 },
      [otherUsername]: { created: Date.now(), sub_until: Date.now() + 86_400_000 },
    },
    progress: { [username]: {}, [otherUsername]: {} },
  }), 'utf8');
  const output = [];
  child = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file', DATA_FILE: dataFile, JWT_SECRET: jwtSecret,
      TELEGRAM_BOT_TOKEN: '', ADMIN_TELEGRAM_ID: '', XAI_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false', ADAPTIVE_LEARNING_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const failureHarness = await createActiveSubscriptionPage(browser, {
    baseUrl, username: otherUsername, jwtSecret,
    contextOptions: { viewport: { width: 375, height: 812 }, serviceWorkers: 'block' },
  });
  importFailureContext = failureHarness.context;
  const failurePage = failureHarness.page;
  const exactFormChunk = '**/assets/ege-mock-form-1-v1-*.js';
  await failurePage.route(exactFormChunk, (route) => route.abort('failed'));
  await failurePage.goto(baseUrl, { waitUntil: 'networkidle' });
  await failurePage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  await openEgeMock(failurePage);
  await failurePage.getByRole('heading', { name: 'Вариант не загрузился' }).waitFor();
  assert.match(await failurePage.getByRole('alert').innerText(), /не удалось|ошибк|сеть/iu);
  assert.match(await failurePage.locator('#ege_mock_timer').innerText(), /^—/u,
    'a missing exact form must fail closed before the timer starts');
  await failurePage.unroute(exactFormChunk);
  await failurePage.getByRole('button', { name: 'Повторить загрузку' }).press('Enter');
  await failurePage.locator('#scr16.on .ege-mock__intro').waitFor({ state: 'visible' });
  await importFailureContext.close();
  importFailureContext = null;

  const currentFailureHarness = await createActiveSubscriptionPage(browser, {
    baseUrl, username: otherUsername, jwtSecret,
    contextOptions: { viewport: { width: 375, height: 812 }, serviceWorkers: 'block' },
  });
  currentFailureContext = currentFailureHarness.context;
  const currentFailurePage = currentFailureHarness.page;
  let failedCurrentCalls = 0;
  await currentFailurePage.goto(baseUrl, { waitUntil: 'networkidle' });
  await currentFailurePage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  await openEgeHub(currentFailurePage);
  await currentFailurePage.waitForFunction(() => (
    document.querySelectorAll('#ege-hub-sections > li').length === 5
  ));
  await currentFailurePage.route('**/api/v1/ege-mocks/attempts/current', (route) => {
    failedCurrentCalls += 1;
    return route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }),
    });
  });
  await currentFailurePage.getByRole('button', {
    name: 'Открыть подготовку к пробнику',
  }).press('Enter');
  try {
    await currentFailurePage.getByRole('heading', { name: 'Состояние попытки не подтверждено' }).waitFor({ timeout: 8_000 });
  } catch (error) {
    const diagnostic = await currentFailurePage.evaluate(() => ({
      active: document.querySelector('.screen.on')?.id,
      area: document.querySelector('#ege_mock_area')?.textContent,
      storage: Object.entries(localStorage).filter(([key]) => key.startsWith('easyboost-ege-mock-written-v1:')),
    }));
    throw new Error(`${error.message}\nfailedCurrentCalls=${failedCurrentCalls}\n${JSON.stringify(diagnostic)}`);
  }
  assert.equal(await currentFailurePage.getByRole('button', { name: /Начать письменную часть/u }).count(), 0,
    'unknown server state must never expose a start action');
  assert.match(await currentFailurePage.locator('#ege_mock_timer').innerText(), /^—/u);
  await currentFailurePage.unroute('**/api/v1/ege-mocks/attempts/current');
  await currentFailurePage.getByRole('button', { name: 'Повторить проверку' }).press('Enter');
  await currentFailurePage.getByRole('button', { name: 'Проверить готовность' }).waitFor();
  await currentFailureContext.close();
  currentFailureContext = null;

  const harness = await createActiveSubscriptionPage(browser, {
    baseUrl, username, jwtSecret,
    contextOptions: { viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' },
  });
  context = harness.context;
  const page = harness.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  }, null, { timeout: 15_000 });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });

  await openEgeMock(page);
  await page.locator('#scr16.on .ege-mock__intro').waitFor({ state: 'visible' });
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `written mock overflowed at ${width}px`);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  assert.deepEqual(await page.locator('#scr16 button, #scr16 input, #scr16 select').evaluateAll((controls) => controls
    .map((control) => ({ label: control.getAttribute('aria-label') || control.textContent?.trim(), height: control.getBoundingClientRect().height }))
    .filter((control) => control.height < 44)), []);

  await page.getByRole('button', { name: 'Назад', exact: true }).press('Enter');
  await page.locator('#aisy-ege.on').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#frame.ege-mock-expanded').count(), 0,
    'the native EGE Back action must run the route leave hook');
  await openEgeMock(page);
  await page.locator('#scr16.on .ege-mock__intro').waitFor({ state: 'visible' });

  await page.getByRole('button', { name: 'Проверить готовность' }).press('Enter');
  try {
    await page.getByText('Техническая проверка завершена. Таймер ещё не запущен.').waitFor({ timeout: 30_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(async () => ({
      active: document.querySelector('.screen.on')?.id,
      area: document.querySelector('#ege_mock_area')?.textContent,
      frameExpanded: document.querySelector('#frame')?.classList.contains('ege-mock-expanded'),
      localState: Object.entries(localStorage).find(([key]) => key.startsWith('easyboost-ege-mock-written-v1:')),
    }));
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`);
  }
  const beforeStart = await context.request.get(`${baseUrl}/api/v1/ege-mocks/attempts/current`, {
    headers: { 'X-EasyBoost-Expected-Owner': username },
  });
  assert.equal((await beforeStart.json()).attempt, null, 'preflight must not start the server timer');

  await page.getByRole('button', { name: 'Начать письменную часть' }).press('Enter');
  await page.getByRole('heading', { name: 'Задание 1', exact: true }).waitFor({ timeout: 8_000 });
  assert.match(await page.locator('#ege_mock_timer').innerText(), /^03:(?:09|10):/u);
  assert.doesNotMatch(await page.locator('#ege_mock_area').innerText(), /правильн(?:ый|ого) ответ|ваш балл|подсказк/iu);
  await page.locator('[data-ege-array-index="0"]').selectOption('1');
  await page.locator('[data-ege-array-index="1"]').selectOption('1');
  try {
    await page.waitForFunction(() => {
      const fields = [...document.querySelectorAll('[data-ege-array-index]')].slice(0, 2);
      return fields[0]?.value === '' && fields[1]?.value === '1';
    }, null, { timeout: 5_000 });
  } catch (error) {
    const diagnostic = await page.locator('[data-ege-array-index]').evaluateAll((fields) => (
      fields.slice(0, 2).map((field) => field.value)
    ));
    throw new Error(`${error.message}\nfields=${JSON.stringify(diagnostic)}\npageErrors=${JSON.stringify(pageErrors)}`);
  }
  assert.deepEqual(await page.locator('[data-ege-array-index]').evaluateAll((fields) => (
    fields.slice(0, 2).map((field) => field.value)
  )), ['', '1'], 'shared unique-selection contract must move an already used answer');
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = function playExactCachedSegment() {
      queueMicrotask(() => this.dispatchEvent(new Event('ended')));
      return Promise.resolve();
    };
  });
  await page.locator('[data-ege-audio-play="matching"]').dispatchEvent('click');
  await page.waitForFunction(() => (
    document.querySelector('[data-ege-audio-play="matching"]')?.parentElement
      ?.querySelector('strong')?.textContent?.trim() === '1'
  ));
  await page.getByRole('button', { name: 'Грамматика и лексика', exact: true }).press('Enter');
  await page.locator('[data-ege-text]').fill('went');
  await page.waitForFunction(() => (
    document.querySelector('.ege-mock__progress p:first-child strong')?.textContent?.trim() === '1 из 36'
      && document.querySelector('.ege-mock__review [data-ege-position="19"]')?.dataset.blank === 'false'
      && /в очереди/u.test(document.querySelector('#ege_mock_save')?.textContent || '')
      && /пропущено 35/u.test(document.querySelector('[data-ege-action="complete-objective"]')?.textContent || '')
  ), null, { timeout: 500 });
  await page.waitForTimeout(900);
  await page.waitForFunction(async ({ baseUrl, username }) => {
    const response = await fetch(`${baseUrl}/api/v1/ege-mocks/attempts/current`, {
      headers: { 'X-EasyBoost-Expected-Owner': username },
    });
    return response.ok && (await response.json()).attempt?.draft?.['19'] === 'went';
  }, { baseUrl, username }, { timeout: 8_000 });

  await context.setOffline(true);
  await page.locator('[data-ege-text]').fill('went offline');
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: 'domcontentloaded' });
  try {
    await page.locator('#scr16.on [data-ege-text]').waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      active: document.querySelector('.screen.on')?.id,
      gate: document.querySelector('#access_gate')?.textContent,
      online: navigator.onLine,
      current: localStorage.getItem('eb_current'),
      localKeys: Object.keys(localStorage).filter((key) => key.includes('ege-mock')),
      area: document.querySelector('#ege_mock_area')?.textContent,
    }));
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`);
  }
  assert.equal(await page.locator('[data-ege-text]').inputValue(), 'went offline');
  assert.match(await page.locator('#ege_mock_save').innerText(), /в очереди/u);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const offlineAudio = await page.evaluate(async (assetPath) => {
    const response = await fetch(assetPath, { headers: { Range: 'bytes=0-99' } });
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      bytes: (await response.arrayBuffer()).byteLength,
    };
  }, egeMockAssetPlaybackUrl(egeForm, egeForm.positions[0].assetIds[0]));
  assert.deepEqual(offlineAudio, { status: 206, contentType: 'audio/mpeg', bytes: 100 });

  await context.setOffline(false);
  await page.waitForFunction(async ({ baseUrl, username }) => {
    const response = await fetch(`${baseUrl}/api/v1/ege-mocks/attempts/current`, {
      headers: { 'X-EasyBoost-Expected-Owner': username },
    });
    return response.ok && (await response.json()).attempt?.draft?.['19'] === 'went offline';
  }, { baseUrl, username }, { timeout: 10_000 });

  await context.setOffline(true);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: /Завершить задания 1–36/u }).press('Enter');
  await page.waitForTimeout(250);
  try {
    await page.getByRole('heading', { name: 'Сохраняем задания 1–36' }).waitFor();
  } catch (error) {
    const diagnostic = await page.evaluate(async () => ({
      area: document.querySelector('#ege_mock_area')?.textContent,
      active: document.querySelector('.screen.on')?.id,
      current: localStorage.getItem('eb_current'),
      authority: localStorage.getItem('easyboost_deleted_owners_v1'),
      locks: navigator.locks?.query ? await navigator.locks.query() : null,
      state: Object.entries(localStorage).find(([key]) => key.startsWith('easyboost-ege-mock-written-v1:')),
    }));
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr16.on').waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByRole('heading', { name: 'Сохраняем задания 1–36' }).waitFor();
  await context.setOffline(false);
  try {
    await page.getByRole('heading', { name: 'Задания 1–36 сохранены' }).waitFor({ timeout: 12_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      area: document.querySelector('#ege_mock_area')?.textContent,
      online: navigator.onLine,
      state: Object.entries(localStorage).find(([key]) => key.startsWith('easyboost-ege-mock-written-v1:')),
    }));
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`);
  }

  const current = await context.request.get(`${baseUrl}/api/v1/ege-mocks/attempts/current`, {
    headers: { 'X-EasyBoost-Expected-Owner': username },
  });
  const currentPayload = await current.json();
  assert.equal(currentPayload.attempt.state, 'written_in_progress');
  assert.equal(currentPayload.attempt.draft['19'], 'went offline');
  const result = await context.request.get(`${baseUrl}/api/v1/ege-mocks/attempts/${currentPayload.attempt.id}/result`, {
    headers: { 'X-EasyBoost-Expected-Owner': username },
  });
  assert.deepEqual(await result.json(), {
    available: false, state: 'written_in_progress', keysRevealed: false,
    writingAssessment: currentPayload.attempt.writingAssessment,
  });

  const authorityHarness = await createActiveSubscriptionPage(browser, {
    baseUrl, username, jwtSecret, contextOptions: { viewport: { width: 375, height: 812 } },
  });
  authorityContext = authorityHarness.context;
  const authorityPage = authorityHarness.page;
  await authorityPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await authorityPage.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  }, null, { timeout: 15_000 });
  await openEgeMock(authorityPage);
  await authorityPage.getByRole('heading', { name: /Задание \d+/u }).waitFor({ timeout: 30_000 });
  await authorityPage.getByRole('button', { name: 'Грамматика и лексика', exact: true }).press('Enter');
  const switchedPage = await authorityContext.newPage();
  await switchedPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await switchedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  await authorityContext.addCookies([{
    name: 'eb_token', value: jwt.sign({ u: otherUsername }, jwtSecret, { expiresIn: '1h' }),
    url: baseUrl, httpOnly: true, sameSite: 'Lax',
  }]);
  await authorityPage.locator('[data-ege-text]').fill('must not remain visible');
  await authorityPage.locator('#scr5.on').waitFor({ state: 'visible', timeout: 8_000 });
  assert.equal(await authorityPage.locator('#scr16.on').count(), 0);
  assert.equal(await authorityPage.locator('#frame.ege-mock-expanded').count(), 0);
  await authorityContext.close();
  authorityContext = null;
  await page.locator('[data-ege-action="continue-writing"]').press('Enter');
  await page.getByRole('heading', { name: 'Задание 37', exact: true }).waitFor({ timeout: 20_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  await openEgeMock(page);
  try {
    await page.getByRole('heading', { name: 'Задание 37', exact: true }).waitFor({ timeout: 20_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      active: document.querySelector('.screen.on')?.id,
      area: document.querySelector('#ege_mock_area')?.textContent,
      state: Object.entries(localStorage).find(([key]) => key.startsWith('easyboost-ege-mock-written-v1:')),
    }));
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`);
  }
  const task37Text = await page.locator('#ege_mock_area').innerText();
  assert.match(task37Text, /Оцениваются:.*коммуникативной задачи/isu);
  assert.match(task37Text, /100–140 слов/u);
  assert.equal(task37Text.includes(AUTOMATIC_ASSESSMENT_WARNING), true);
  assert.doesNotMatch(task37Text, /criteriaRef|criteriaFingerprint|answerKey|correctAnswer/iu);
  const answer37 = Array.from({ length: 110 }, (_, index) => `letter${index + 1}`).join(' ');
  const rawAnswer37 = `<b> ${answer37} </b>`;
  const answer38 = Array.from({ length: 210 }, (_, index) => `report${index + 1}`).join(' ');
  await page.locator('[data-ege-writing]').fill(rawAnswer37);
  await page.waitForFunction(() => /110/u.test(document.querySelector('#ege_mock_word_count')?.textContent || ''));
  await page.locator('.ege-mock__review [data-ege-position="38"]').press('Enter');
  await page.getByRole('heading', { name: 'Задание 38', exact: true }).waitFor();
  const task38Text = await page.locator('#ege_mock_area').innerText();
  assert.match(task38Text, /200–250 слов/u);
  assert.match(task38Text, /орфография и пунктуация/iu);
  await page.locator('[data-ege-writing]').fill(answer38);
  assert.equal(await page.locator('[data-ege-writing]').evaluate((field) => field.getBoundingClientRect().height >= 44), true);
  await page.setViewportSize({ width: 320, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'writing editors must not overflow at 320px');
  await page.setViewportSize({ width: 375, height: 812 });

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr16.on [data-ege-writing]').waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await page.locator('[data-ege-writing]').inputValue(), answer38,
    'the exact task 38 draft must survive an offline reload');
  assert.match(await page.locator('#ege_mock_word_count').innerText(), /210/u);
  await context.setOffline(false);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-ege-action="complete-written"]').press('Enter');
  await page.getByRole('heading', { name: 'Задания 1–38 сданы' }).waitFor({ timeout: 15_000 });
  try {
    await page.waitForFunction(() => (
      /experimental \/ approximate\): retryable/iu.test(
        document.querySelector('#ege_mock_area')?.textContent || '',
      )
    ), null, { timeout: 15_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      area: document.querySelector('#ege_mock_area')?.textContent,
      state: Object.entries(localStorage).find(([key]) => (
        key.startsWith('easyboost-ege-mock-written-v1:')
      )),
    }));
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}\n${output.join('').slice(-4_000)}`);
  }
  const terminalText = await page.locator('#ege_mock_area').innerText();
  assert.match(terminalText,
    /Предварительная автоматическая оценка \(experimental \/ approximate\): retryable/iu);
  assert.equal(terminalText.includes(AUTOMATIC_ASSESSMENT_WARNING), true,
    'the terminal must render the exact shared experimental approximate warning');
  assert.doesNotMatch(terminalText, /ваш балл|правильный ответ|criteriaRef/iu);
  const finalCurrent = await context.request.get(`${baseUrl}/api/v1/ege-mocks/attempts/current`, {
    headers: { 'X-EasyBoost-Expected-Owner': username },
  });
  const finalAttempt = (await finalCurrent.json()).attempt;
  assert.equal(finalAttempt.state, 'oral_ready');
  assert.equal(finalAttempt.draft['37'], answer37);
  assert.equal(finalAttempt.draft['38'], answer38);
  assert.equal(finalAttempt.writingAssessment.status, 'retryable');
  assert.equal(finalAttempt.writingAssessment.mode, 'experimental');
  assert.equal(finalAttempt.writingAssessment.scoreKind, 'approximate');

  const blockedWritingAssessment = structuredClone(finalAttempt.writingAssessment);
  blockedWritingAssessment.status = 'pending';
  blockedWritingAssessment.assessmentRevision += 1;
  blockedWritingAssessment.retryAllowed = false;
  blockedWritingAssessment.runDisposition = 'subscription_required';
  delete blockedWritingAssessment.retryWarning;
  delete blockedWritingAssessment.items;
  const blockedAttempt = {
    ...finalAttempt,
    writingAssessment: blockedWritingAssessment,
  };
  const assessmentRunBodies = [];
  await page.route(`**/api/v1/ege-mocks/attempts/${finalAttempt.id}`, (route) => route.fulfill({
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-easyboost-response-owner': username,
      date: 'Thu, 13 Aug 2026 06:30:00 GMT',
    },
    body: JSON.stringify({ attempt: blockedAttempt }),
  }));
  await page.route(`**/api/v1/ege-mocks/attempts/${finalAttempt.id}/assessment/run`, (route) => {
    assessmentRunBodies.push(route.request().postDataJSON());
    const writingAssessment = {
      ...blockedWritingAssessment, status: 'in_progress',
      assessmentRevision: blockedWritingAssessment.assessmentRevision + 1,
    };
    delete writingAssessment.runDisposition;
    return route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-easyboost-response-owner': username,
        date: 'Thu, 13 Aug 2026 06:31:00 GMT',
      },
      body: JSON.stringify({
        applied: false, replayed: false,
        attempt: { ...blockedAttempt, writingAssessment },
      }),
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  await openEgeMock(page);
  await page.getByRole('button', {
    name: 'Запустить проверку после продления подписки',
  }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', {
    name: 'Запустить проверку после продления подписки',
  }).press('Enter');
  await page.waitForFunction(() => !document.querySelector(
    '[data-ege-action="run-assessment-after-renewal"]',
  ));
  assert.deepEqual(assessmentRunBodies, [{ explicitRenewal: true }],
    'the built production screen transport must preserve the explicit renewal marker');
  assert.deepEqual(pageErrors, []);
  console.log('EGE mock written E2E passed: exact preflight, 320/desktop, owner switch, offline drafts, durable checkpoint and explicit provisional 1–38 submission');
} finally {
  if (context) await context.close();
  if (authorityContext) await authorityContext.close();
  if (importFailureContext) await importFailureContext.close();
  if (currentFailureContext) await currentFailureContext.close();
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
