import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  availablePort,
  chromeExecutable,
  createActiveSubscriptionPage,
  stopProcess,
  waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const jwtSecret = 'aisy-today-e2e-secret-at-least-32-chars';

async function browserApiRequest(page, requestPath, { method = 'GET', key = '', body = null } = {}) {
  return page.evaluate(async ({ pathName, requestMethod, idempotencyKey, payload }) => {
    const marker = window.EasyBoostStore.readCurrentOwner();
    const headers = { 'X-EasyBoost-Expected-Owner': marker.owner };
    if (payload !== null) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await fetch(pathName, {
      method: requestMethod,
      credentials: 'same-origin',
      headers,
      ...(payload === null ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.json() };
  }, {
    pathName: requestPath,
    requestMethod: method,
    idempotencyKey: key,
    payload: body,
  });
}

async function prepareAdaptivePlan(page, suffix) {
  let state = (await browserApiRequest(page, '/api/v1/adaptive-learning/diagnostics/start', {
    method: 'POST', key: `aisy-today-${suffix}-diagnostic-start`, body: { depth: 'short' },
  })).body;
  let answerIndex = 0;
  while (state.diagnostic.status === 'in_progress') {
    answerIndex += 1;
    const response = await browserApiRequest(
      page,
      `/api/v1/adaptive-learning/diagnostics/${state.diagnostic.id}/answers`,
      {
        method: 'POST',
        key: `aisy-today-${suffix}-diagnostic-answer-${answerIndex}`,
        body: { itemId: state.item.id, choiceId: state.item.choices[0].id },
      },
    );
    assert.equal(response.status, 201);
    state = response.body;
  }
  const completed = await browserApiRequest(
    page,
    `/api/v1/adaptive-learning/diagnostics/${state.diagnostic.id}/complete`,
    { method: 'POST', key: `aisy-today-${suffix}-diagnostic-complete`, body: {} },
  );
  assert.equal(completed.status, 201);
  const goal = await browserApiRequest(page, '/api/v1/adaptive-learning/goal', {
    method: 'PUT',
    key: `aisy-today-${suffix}-goal`,
    body: { targetExam: 'ege_english', targetScore: 75, examDate: '2027-06-01', weeklyMinutes: 300 },
  });
  assert.equal(goal.status, 201);
}

async function waitForToday(page, states = ['ready', 'resume', 'offline']) {
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator(states.map((state) => `#today-hero[data-state="${state}"]`).join(','))
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function heroGeometry(page) {
  return page.evaluate(() => {
    const hero = document.getElementById('today-hero');
    const slot = document.querySelector('.today-action-slot');
    const primary = document.getElementById('today-primary');
    const heroBox = hero.getBoundingClientRect();
    const slotBox = slot.getBoundingClientRect();
    const primaryBox = primary.getBoundingClientRect();
    return {
      heroLeft: heroBox.left,
      heroTop: heroBox.top,
      heroWidth: heroBox.width,
      heroHeight: heroBox.height,
      heroMinHeight: getComputedStyle(hero).minHeight,
      slotLeft: slotBox.left,
      slotTop: slotBox.top,
      slotWidth: slotBox.width,
      primaryLeft: primaryBox.left,
      primaryTop: primaryBox.top,
      primaryBottom: primaryBox.bottom,
      primaryWidth: primaryBox.width,
      primaryHeight: primaryBox.height,
      viewportHeight: window.innerHeight,
    };
  });
}

function assertStableGeometry(actual, expected, label) {
  for (const property of [
    'heroLeft', 'heroTop', 'heroWidth', 'heroHeight', 'heroMinHeight',
    'slotLeft', 'slotTop', 'slotWidth', 'primaryLeft', 'primaryTop', 'primaryBottom',
    'primaryWidth', 'primaryHeight', 'viewportHeight',
  ]) {
    assert.equal(actual[property], expected[property], `${label} changed ${property}`);
  }
}

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-today-e2e-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const now = Date.now();
  const privacyConsent = {
    text_processing: true,
    voice_processing: true,
    policy_version: '2026-08-26-vk-id-v1',
    updated_at: new Date(now).toISOString(),
  };
  const durationUsers = Object.fromEntries([15, 45, 90, 120].map((minutes) => [
    `duration${minutes}`,
    {
      created: now,
      sub_until: now + 86_400_000,
      display_name: `Ученица ${minutes}`,
      privacy_consent: privacyConsent,
    },
  ]));
  const durationProgress = Object.fromEntries([15, 45, 90, 120].map((minutes) => [
    `duration${minutes}`,
    {
      learnerPreferences: { version: 1, schoolGrade: 11, preferredSessionMinutes: minutes },
    },
  ]));
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      learner: {
        created: now,
        sub_until: now + 86_400_000,
        display_name: 'Мария Тестова',
        privacy_consent: privacyConsent,
      },
      lost: {
        created: now,
        sub_until: now + 86_400_000,
        display_name: 'Лидия Тестова',
        privacy_consent: privacyConsent,
      },
      timeout: {
        created: now,
        sub_until: now + 86_400_000,
        display_name: 'Тамара Тестова',
        privacy_consent: privacyConsent,
      },
      ...durationUsers,
    },
    progress: {
      learner: { dayMin: 12, streak: 4 },
      lost: {
        learnerPreferences: { version: 1, schoolGrade: 11, preferredSessionMinutes: 90 },
      },
      timeout: {},
      ...durationProgress,
    },
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
      ADAPTIVE_LEARNING_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);
  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });

  const learner = await createActiveSubscriptionPage(browser, {
    baseUrl,
    username: 'learner',
    jwtSecret,
    contextOptions: {
      viewport: { width: 375, height: 812 }, reducedMotion: 'reduce', serviceWorkers: 'block',
    },
  });
  const learnerErrors = [];
  const learnerAdaptiveCreates = [];
  learner.page.on('pageerror', (error) => learnerErrors.push(error.message));
  learner.page.on('request', (request) => {
    if (request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/v1/adaptive-learning/sessions') {
      learnerAdaptiveCreates.push(request.url());
    }
  });
  await learner.page.goto(baseUrl, { waitUntil: 'networkidle' });
  await waitForToday(learner.page, ['ready']);
  assert.equal(await learner.page.locator('#today-title').innerText(), 'Здравствуйте, Мария Тестова');
  assert.doesNotMatch(await learner.page.locator('#scr1').innerText(), /learner/u);
  const recommendation = learner.page.getByRole('region', { name: 'Рекомендация на сегодня' });
  await recommendation.waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await learner.page.locator('#scr1 .clayCard').count(), 0,
    'Today must not expose the old six-module dashboard');
  assert.equal(await learner.page.locator('#today-primary').count(), 1);
  assert.equal(await learner.page.locator('#today-diagnostic button').count(), 0,
    'diagnostic context is information, not a competing route CTA');
  assert.deepEqual(await learner.page.locator('#aisy-shell-nav button').allTextContents(), [
    'Сегодня', 'Практика', 'ЕГЭ', 'Прогресс', 'Профиль',
  ]);
  for (const minutes of [10, 20, 30, 40]) {
    assert.equal(await recommendation.getByRole('radio', { name: `${minutes} минут` }).count(), 1);
  }
  await recommendation.getByRole('radio', { name: '20 минут' }).focus();
  await recommendation.getByRole('radio', { name: '20 минут' }).press('ArrowRight');
  assert.equal(await recommendation.getByRole('radio', { name: '30 минут' }).getAttribute('aria-checked'), 'true');
  assert.equal(await recommendation.getByRole('radio', { name: '30 минут' })
    .evaluate((node) => document.activeElement === node), true);
  await recommendation.getByRole('radio', { name: '10 минут' }).press('Space');
  const quickPrimary = learner.page.locator('#today-primary');
  assert.equal(await quickPrimary.innerText(), 'Начать практику');
  const quickPrimaryBox = await quickPrimary.boundingBox();
  assert.ok(quickPrimaryBox.width >= 44 && quickPrimaryBox.height >= 44);
  assert.match(await learner.page.locator('#today-recommendation-outcome').innerText(), /план|ритм/iu);
  await quickPrimary.press('Enter');
  await learner.page.locator('#scr2.on').waitFor({ state: 'visible', timeout: 5_000 });
  assert.deepEqual(learnerAdaptiveCreates, [], 'ten-minute practice must not call the adaptive API');
  assert.deepEqual(learnerErrors, []);
  await learner.context.close();

  for (const minutes of [15, 45, 90, 120]) {
    const username = `duration${minutes}`;
    const harness = await createActiveSubscriptionPage(browser, {
      baseUrl,
      username,
      jwtSecret,
      contextOptions: {
        viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block',
      },
    });
    await harness.page.goto(baseUrl, { waitUntil: 'networkidle' });
    await waitForToday(harness.page, ['ready']);
    await prepareAdaptivePlan(harness.page, username);
    await harness.page.reload({ waitUntil: 'networkidle' });
    await waitForToday(harness.page, ['ready']);
    const durationChoice = harness.page.getByRole('region', { name: 'Рекомендация на сегодня' })
      .getByRole('radio', { name: `${minutes} минут` });
    assert.equal(await durationChoice.getAttribute('aria-checked'), 'true',
      `${minutes} minute preference must be displayed exactly`);
    assert.equal(await harness.page.locator('#today-estimate').innerText(), `${minutes} мин`);
    const createRequest = harness.page.waitForRequest((request) => (
      request.method() === 'POST'
        && new URL(request.url()).pathname === '/api/v1/adaptive-learning/sessions'
    ));
    await harness.page.locator('#today-primary').press('Enter');
    const request = await createRequest;
    assert.equal(request.postDataJSON().durationMinutes, minutes,
      `${minutes} minute selection must cross the create-session seam exactly`);
    assert.match(await request.headerValue('idempotency-key'), /^[A-Za-z0-9_-]{16,}$/u);
    await harness.page.waitForFunction(() => !document.getElementById('scr1')?.classList.contains('on'));
    await harness.context.close();
  }

  const lost = await createActiveSubscriptionPage(browser, {
    baseUrl,
    username: 'lost',
    jwtSecret,
    contextOptions: {
      viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block',
    },
  });
  await lost.page.goto(baseUrl, { waitUntil: 'networkidle' });
  await waitForToday(lost.page, ['ready']);
  await prepareAdaptivePlan(lost.page, 'lost');
  await lost.page.reload({ waitUntil: 'networkidle' });
  await waitForToday(lost.page, ['ready']);
  const lostPreviewRequests = [];
  const lostCreateAttempts = [];
  let committedSessionId = '';
  lost.page.on('request', (request) => {
    if (request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/v1/adaptive-learning/sessions/preview') {
      lostPreviewRequests.push(request.postDataJSON());
    }
  });
  await lost.page.route('**/api/v1/adaptive-learning/sessions', async (route) => {
    const request = route.request();
    const attempt = {
      key: await request.headerValue('idempotency-key'),
      body: request.postDataJSON(),
    };
    lostCreateAttempts.push(attempt);
    if (lostCreateAttempts.length === 1) {
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      const body = await response.json();
      committedSessionId = body.session.id;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const lostPrimary = lost.page.locator('#today-primary');
  await lostPrimary.press('Enter');
  await lost.page.waitForFunction(() => {
    const primary = document.getElementById('today-primary');
    const notice = document.getElementById('today-action-notice');
    return primary && !primary.disabled && Boolean(notice?.textContent.trim());
  }, null, { timeout: 8_000 });
  assert.equal(await lost.page.locator('#today-hero').getAttribute('data-state'), 'ready');
  await lostPrimary.press('Enter');
  await lost.page.waitForFunction(() => !document.getElementById('scr1')?.classList.contains('on'));
  assert.equal(lostPreviewRequests.length, 1,
    'retry after a lost create response must reuse the preview');
  assert.equal(lostCreateAttempts.length, 2);
  assert.equal(lostCreateAttempts[0].key, lostCreateAttempts[1].key,
    'retry after a lost response must reuse the exact idempotency key');
  assert.deepEqual(lostCreateAttempts[0].body, lostCreateAttempts[1].body);
  assert.equal(lostCreateAttempts[1].body.durationMinutes, 90);
  const currentAfterReplay = await browserApiRequest(lost.page, '/api/v1/adaptive-learning/sessions/current');
  assert.equal(currentAfterReplay.status, 200);
  assert.equal(currentAfterReplay.body.session.id, committedSessionId,
    'the current endpoint must win and identify the one server session');
  const beforeContinue = {
    previews: lostPreviewRequests.length,
    creates: lostCreateAttempts.length,
  };
  await lost.page.evaluate(() => window.tab('scr1'));
  await waitForToday(lost.page, ['resume']);
  assert.equal(await lost.page.locator('#today-estimate').innerText(), '90 мин');
  assert.equal(await lostPrimary.innerText(), 'Продолжить занятие');
  await lostPrimary.press('Enter');
  await lost.page.waitForFunction(() => !document.getElementById('scr1')?.classList.contains('on'));
  assert.deepEqual({ previews: lostPreviewRequests.length, creates: lostCreateAttempts.length }, beforeContinue,
    'continue must not preview or create another adaptive session');
  await lost.context.close();

  const timeoutHarness = await createActiveSubscriptionPage(browser, {
    baseUrl,
    username: 'timeout',
    jwtSecret,
    contextOptions: {
      viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block',
    },
  });
  let overviewAttempts = 0;
  let failOverview = false;
  await timeoutHarness.page.route('**/api/v1/adaptive-learning/overview', async (route) => {
    overviewAttempts += 1;
    if (failOverview) {
      await route.abort('failed');
      return;
    }
    if (overviewAttempts === 1) return undefined;
    if (overviewAttempts === 2) {
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    await route.continue();
  });
  await timeoutHarness.page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await timeoutHarness.page.locator('#today-hero[data-state="loading"]').waitFor({ state: 'visible' });
  const loadingGeometry = await heroGeometry(timeoutHarness.page);
  assert.ok(loadingGeometry.primaryBottom <= loadingGeometry.viewportHeight,
    'the stable primary route action begins within the portrait viewport');
  await timeoutHarness.page.locator('#today-hero[data-state="error"]').waitFor({
    state: 'visible', timeout: 11_000,
  });
  assertStableGeometry(await heroGeometry(timeoutHarness.page), loadingGeometry, 'error state');
  const retry = timeoutHarness.page.locator('#today-primary');
  assert.equal(await retry.innerText(), 'Повторить');
  await retry.press('Enter');
  assert.equal(await retry.isDisabled(), true, 'retry remains disabled while its request is in flight');
  assert.equal(await retry.getAttribute('aria-busy'), 'true');
  assertStableGeometry(await heroGeometry(timeoutHarness.page), loadingGeometry, 'busy retry');
  await waitForToday(timeoutHarness.page, ['ready']);
  assertStableGeometry(await heroGeometry(timeoutHarness.page), loadingGeometry, 'ready state');
  const todayContent = timeoutHarness.page.locator('#today-content');
  assert.equal(await todayContent.getAttribute('tabindex'), '0',
    'the fixed hero keeps its scrollable route keyboard reachable');
  await todayContent.focus();
  assert.notEqual(await todayContent.evaluate((element) => getComputedStyle(element).outlineStyle), 'none');
  assert.equal(overviewAttempts, 2, 'retry must start one fresh bounded load');
  failOverview = true;
  await timeoutHarness.page.getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('button', { name: 'Практика', exact: true }).press('Enter');
  await timeoutHarness.page.locator('#aisy-practice.on').waitFor({ state: 'visible' });
  await timeoutHarness.page.getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('button', { name: 'Сегодня', exact: true }).press('Enter');
  await waitForToday(timeoutHarness.page, ['offline']);
  assertStableGeometry(await heroGeometry(timeoutHarness.page), loadingGeometry, 'offline cached state');
  assert.equal(await timeoutHarness.page.locator('#scr1 [role="status"][aria-live="polite"]').count(), 1);
  await timeoutHarness.page.waitForFunction(() => /нет сети.*сохранённая копия/iu
    .test(document.getElementById('today-live')?.textContent || ''));
  assert.match(await timeoutHarness.page.locator('#today-live').innerText(), /нет сети.*сохранённая копия/iu,
    'the single live region announces the honest offline/cached state');
  await timeoutHarness.context.close();

  console.log('Aisy Today Chromium E2E passed: identity, duration seams, one CTA, idempotent retry and stable paper states.');
} finally {
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
