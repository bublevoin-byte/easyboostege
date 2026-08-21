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
import {
  createReleaseServerEnvironment, prepareReleaseBrowserBoundary,
} from './aisy-learner-release-safety.js';
import { getEgeMockForm } from '../ege-mock/catalog.js';
import { createFileRepository } from '../storage/file-repository.js';
import { completeEgeMockOralStageLedger } from '../test/support/ege-mock-attempt-contract.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const username = 'aisy-learner-release-user';
const jwtSecret = 'aisy-learner-release-e2e-secret-32-characters';
const mutation = (body) => ({
  ...body,
  idempotencyKey: crypto.randomUUID(),
  requestHash: crypto.randomBytes(32).toString('hex'),
});

function scoreLabel(score) {
  const total = score.primaryTotal == null
    ? `${score.range.minimum}–${score.range.maximum}`
    : String(score.primaryTotal);
  return `${total} из ${score.maximum}`;
}

async function browserGet(page, requestPath) {
  return page.evaluate(async (pathName) => {
    const marker = window.EasyBoostStore.readCurrentOwner();
    const response = await fetch(pathName, {
      credentials: 'same-origin',
      headers: { 'X-EasyBoost-Expected-Owner': marker.owner },
    });
    return { status: response.status, body: await response.json() };
  }, requestPath);
}

async function startReleaseServer({ baseUrl, dataFile, port }) {
  const output = [];
  const server = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: createReleaseServerEnvironment({
      NODE_ENV: 'test',
      PORT: String(port),
      APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file',
      DATA_FILE: dataFile,
      JWT_SECRET: jwtSecret,
      ADAPTIVE_LEARNING_ENABLED: 'true',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => output.push(chunk.toString()));
  server.stderr.on('data', (chunk) => output.push(chunk.toString()));
  try {
    await waitForReady(baseUrl, server, output);
  } catch (error) {
    await stopProcess(server).catch(() => {});
    throw error;
  }
  return server;
}

const destinations = [
  { name: 'Сегодня', screen: '#scr1.on', ready: '#today-ready:not([hidden])' },
  { name: 'Практика', screen: '#aisy-practice.on', ready: '#practice-skills .practice-row' },
  { name: 'ЕГЭ', screen: '#aisy-ege.on', ready: '#ege-hub-sections > li' },
  { name: 'Прогресс', screen: '#scr10.on', ready: '#progress_guidance[aria-busy="false"]' },
  { name: 'Профиль', screen: '#scr11.on', ready: '[data-profile-group="account-data"]' },
];

async function openDestination(page, destination) {
  await page.getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('button', { name: destination.name, exact: true }).press('Enter');
  await page.locator(destination.screen).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator(`${destination.screen} ${destination.ready}`).first()
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function assertTopLevelAccessibility(page, destination, viewport) {
  await page.setViewportSize(viewport);
  await openDestination(page, destination);
  const state = await page.evaluate((screenSelector) => {
    const active = document.querySelector(screenSelector);
    const main = active.matches('main[aria-labelledby],[role="main"][aria-labelledby]')
      ? active
      : active.querySelector('main[aria-labelledby],[role="main"][aria-labelledby]');
    const heading = main?.querySelector('h1');
    const frame = document.getElementById('frame').getBoundingClientRect();
    const controls = [
      ...active.querySelectorAll('button,input,select,textarea,a[href]'),
      ...document.querySelectorAll('#aisy-shell-nav button,#asya-launcher'),
    ].filter((control) => control.getClientRects().length && !control.disabled).map((control) => {
      const touchTarget = control.matches('input[type="radio"],input[type="checkbox"]')
        ? control.closest('label') || control
        : control;
      const rectangle = touchTarget.getBoundingClientRect();
      return {
        label: control.getAttribute('aria-label') || control.textContent?.trim() || control.id,
        width: rectangle.width,
        height: rectangle.height,
      };
    });
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      frameWidth: frame.width,
      frameLeft: frame.left,
      frameRight: frame.right,
      mainLabel: main?.getAttribute('aria-labelledby') || '',
      headingId: heading?.id || '',
      headingText: heading?.textContent?.trim() || '',
      currentNavigation: document.querySelectorAll('#aisy-shell-nav [aria-current="page"]').length,
      liveStates: active.querySelectorAll('[role="status"][aria-live]').length,
      undersized: controls.filter((control) => control.width < 44 || control.height < 44),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  }, destination.screen);
  assert.ok(state.documentWidth <= state.viewportWidth,
    `${destination.name} has horizontal overflow at ${viewport.width}px`);
  assert.ok(state.frameLeft >= -0.5 && state.frameRight <= state.viewportWidth + 0.5);
  assert.ok(state.frameWidth <= 720.5, `${destination.name} must use the bounded learner canvas`);
  assert.equal(state.mainLabel, state.headingId, `${destination.name} main must reference its h1`);
  assert.ok(state.headingText, `${destination.name} must expose a named h1`);
  assert.equal(state.currentNavigation, 1);
  assert.ok(state.liveStates >= 1, `${destination.name} must expose an assistive live state`);
  assert.deepEqual(state.undersized, [], `${destination.name} has a control below 44px`);
  assert.equal(state.reducedMotion, true);
}

let browser;
let child;
let context;
let crossTab;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-learner-release-'));
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const now = Date.now();
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      [username]: {
        created: now,
        sub_until: now + 7 * 86_400_000,
        privacy_consent: {
          text_processing: true,
          voice_processing: true,
          policy_version: '2026-08-02-voice-v1',
          updated_at: new Date(now).toISOString(),
        },
      },
    },
    progress: { [username]: {} },
  }), 'utf8');

  let started;
  let expectedScore;

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = await startReleaseServer({ baseUrl, dataFile, port });

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const harness = await createActiveSubscriptionPage(browser, {
    baseUrl,
    username,
    jwtSecret,
    contextOptions: { viewport: { width: 320, height: 720 }, reducedMotion: 'reduce' },
  });
  context = harness.context;
  const page = harness.page;
  const {
    browserFailures, networkGuard, observedApiRoutes, paidBoundaryCalls,
  } = await prepareReleaseBrowserBoundary(context, {
    applicationOrigin: baseUrl,
    allowedHttpResponses: [
      { method: 'GET', path: '/api/v1/adaptive-learning/sessions/current', status: 404 },
    ],
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on #today-ready:not([hidden])').waitFor({ state: 'visible', timeout: 10_000 });
  assert.match(await page.locator('#today-title').innerText(), new RegExp(`Здравствуйте, ${username}`, 'u'));
  assert.match(await page.locator('#scr1').innerText(), /план пока предварительный.*ЕГЭ · английский/isu);
  assert.equal(await page.locator('#scr1 .clayCard').count(), 0);
  const cleanFirstStartOverview = await browserGet(page, '/api/v1/adaptive-learning/overview');
  assert.equal(cleanFirstStartOverview.status, 200);
  assert.equal(Boolean(cleanFirstStartOverview.body.egeMock.baselineAttemptId), false,
    'first-start must be clean before the release test creates any EGE evidence');
  assert.deepEqual(await page.locator('#aisy-shell-nav button').allTextContents(), [
    'Сегодня', 'Практика', 'ЕГЭ', 'Прогресс', 'Профиль',
  ]);

  const recommendation = page.getByRole('region', { name: 'Рекомендация на сегодня' });
  const diagnostic = page.locator('#today-diagnostic[data-state="recommended"]');
  await diagnostic.waitFor({ state: 'visible', timeout: 10_000 });
  await diagnostic.getByRole('button', { name: 'Отложить на сейчас' }).press('Enter');
  await page.locator('#today-diagnostic[data-state="deferred"]').waitFor({ state: 'visible' });
  assert.match(await page.locator('#today-diagnostic-copy').innerText(), /это не оценка/u);

  const firstPreferenceSaved = page.waitForResponse((response) => (
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/progress/modules'
  ));
  await recommendation.getByRole('radio', { name: '30 минут' }).press('Space');
  assert.equal((await firstPreferenceSaved).status(), 200);

  crossTab = await context.newPage();
  await crossTab.goto(baseUrl, { waitUntil: 'networkidle' });
  await crossTab.locator('#scr1.on #today-ready:not([hidden])').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(
    await crossTab.getByRole('region', { name: 'Рекомендация на сегодня' })
      .getByRole('radio', { name: '30 минут' }).getAttribute('aria-checked'),
    'true',
  );
  const secondPreferenceSaved = crossTab.waitForResponse((response) => (
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/progress/modules'
  ));
  await crossTab.getByRole('region', { name: 'Рекомендация на сегодня' })
    .getByRole('radio', { name: '40 минут' }).press('Space');
  assert.equal((await secondPreferenceSaved).status(), 200);
  await crossTab.close();
  crossTab = null;

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#scr1.on #today-ready:not([hidden])').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(
    await page.getByRole('region', { name: 'Рекомендация на сегодня' })
      .getByRole('radio', { name: '40 минут' }).getAttribute('aria-checked'),
    'true',
    'a second tab must persist the exact owner-bound preference',
  );
  await page.locator('#today-diagnostic[data-state="deferred"]').waitFor({ state: 'visible' });

  await openDestination(page, destinations[1]);
  assert.deepEqual(await page.locator('#practice-skills h2').allTextContents(), [
    'Слова', 'Грамматика', 'Чтение', 'Аудирование', 'Письмо', 'Говорение',
  ]);
  await page.locator('.practice-row[data-skill="vocabulary"] button').press('Enter');
  await page.locator('#scr2.on').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Назад в раздел Практика', exact: true }).press('Enter');
  await page.locator('#aisy-practice.on').waitFor({ state: 'visible' });

  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#scr1.on #today-ready:not([hidden])').waitFor({ state: 'visible', timeout: 10_000 });
  }
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });
  networkGuard.setOffline(true);
  await context.setOffline(true);
  await openDestination(page, destinations[1]);
  await page.locator('#practice-network-state:not([hidden])').waitFor({ state: 'visible' });
  assert.match(await page.locator('#practice-network-state').innerText(), /нет сети/u);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#access_gate[data-state="network-unknown"]').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await page.locator('#scr1.on').count(), 0,
    'offline reload must not present stale subscription authority as current access');
  assert.match(await page.locator('#access_gate_copy').innerText(), /нет связи с сервером|Проверьте сеть/u);
  await context.setOffline(false);
  networkGuard.setOffline(false);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#scr1.on #today-ready:not([hidden])').waitFor({ state: 'visible', timeout: 10_000 });

  await stopProcess(child);
  child = null;
  const repository = createFileRepository(dataFile);
  const form = getEgeMockForm('ege-en-2026-form-1', 1);
  started = await repository.startEgeMockAttempt(username, mutation({
    formId: form.id,
    formRevision: form.revision,
    catalogFingerprint: form.fingerprint,
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
  const seededResult = await repository.getEgeMockResult(username, started.attempt.id);
  assert.equal(seededResult.available, true);
  expectedScore = scoreLabel(seededResult.result.canonical.score);
  child = await startReleaseServer({ baseUrl, dataFile, port });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#scr1.on #today-ready:not([hidden])').waitFor({ state: 'visible', timeout: 10_000 });

  await openDestination(page, destinations[2]);
  assert.equal(await page.locator('#ege-hub-sections > li').count(), 5);
  assert.equal(await page.locator('#scr16.on').count(), 0);
  const resultResponse = await browserGet(
    page,
    `/api/v1/ege-mocks/attempts/${started.attempt.id}/result`,
  );
  assert.equal(resultResponse.status, 200);
  assert.equal(resultResponse.body.available, true);
  assert.equal(scoreLabel(resultResponse.body.result.canonical.score), expectedScore);
  await page.getByRole('button', { name: /^Открыть результат:/u }).first().press('Enter');
  await page.getByRole('heading', { name: expectedScore, exact: true }).waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('.ege-mock__result-review details').count(), 42);
  assert.equal(await page.locator('#ege_mock_result_title').evaluate((node) => node === document.activeElement), true);
  await page.getByRole('button', { name: 'Назад в раздел ЕГЭ', exact: true }).press('Enter');
  await page.locator('#aisy-ege.on').waitFor({ state: 'visible' });

  await openDestination(page, destinations[3]);
  await page.locator('#ege_mock_dashboard:not([hidden])').waitFor({ state: 'visible', timeout: 10_000 });
  const overview = await browserGet(page, '/api/v1/adaptive-learning/overview');
  assert.equal(overview.status, 200);
  assert.ok(overview.body.egeMock.baselineAttemptId === started.attempt.id,
    'Progress must reference the exact seeded EGE attempt');
  const baselineScore = overview.body.egeMock.baseline.primaryTotal == null
    ? `${overview.body.egeMock.baseline.range.minimum}–${overview.body.egeMock.baseline.range.maximum}`
    : String(overview.body.egeMock.baseline.primaryTotal);
  assert.equal(`${baselineScore} из ${overview.body.egeMock.baseline.maximum}`, expectedScore);
  assert.match(await page.locator('#ege_mock_dashboard_summary').innerText(),
    new RegExp(`Исходная диагностика: ${expectedScore.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
  assert.match(await page.locator('#progress_guidance').innerText(),
    /Следующий шаг.*Что улучшилось.*Что требует внимания/isu);

  await openDestination(page, destinations[4]);
  assert.equal(await page.locator('#scr11 [data-profile-group]').count(), 4);
  assert.equal(await page.locator('#pf_plan_name').innerText(), 'Premium');
  assert.doesNotMatch(await page.locator('#scr11').innerText(), /Base|родител|преподавател|учител/iu);
  const launcher = page.getByRole('button', { name: 'Открыть Асю' });
  await launcher.press('Enter');
  const assistant = page.locator('#asya-assistant');
  await assistant.waitFor({ state: 'visible' });
  assert.match(await assistant.innerText(), /только в открытом приложении.*не слушает устройство в фоне/su);
  await assistant.locator('#asya-disclosure').check();
  await assistant.locator('#asya-input').fill('Ася, как открыть практику?');
  await assistant.locator('#asya-input').press('Enter');
  await assistant.locator('#asya-state[data-state="listening"]').waitFor();
  assert.match(await assistant.locator('#asya-state').innerText(), /имя повторять не нужно/iu);
  await assistant.locator('#asya-input').fill('Как вернуться?');
  await assistant.locator('#asya-input').press('Enter');
  assert.match(await assistant.locator('#asya-reply').innerText(), /кнопка возврата/u);
  await assistant.getByRole('button', { name: 'Завершить разговор', exact: true }).press('Enter');
  await assistant.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'asya-launcher');
  assert.deepEqual(paidBoundaryCalls, []);

  const viewportMatrix = [{ width: 320, height: 720 }, { width: 1440, height: 900 }];
  for (const viewport of viewportMatrix) {
    for (const destination of destinations) {
      await assertTopLevelAccessibility(page, destination, viewport);
    }
  }

  assert.ok([...observedApiRoutes].some((route) => (
    route === '/api/v1/ege-mocks/attempts/:id/result'
  )), 'the exact EGE result must cross the browser/API seam');
  assert.ok(observedApiRoutes.has('/api/v1/adaptive-learning/overview'),
    'Progress must cross the browser/API seam');
  assert.deepEqual(browserFailures, []);
  assert.deepEqual(networkGuard.failures, []);
  assert.deepEqual(paidBoundaryCalls, []);
  console.log('Aisy learner release Chromium E2E passed: Today → Practice → EGE result → Progress → Profile/Asya, cross-tab, offline reload and 320/1440 a11y');
} finally {
  if (crossTab) await crossTab.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child) await stopProcess(child).catch(() => {});
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
}
