import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { chromium } from 'playwright';
import { getDiagnosticItem } from '../adaptive-learning/diagnostic-catalog.js';
import { EGE_SKILL_TAXONOMY } from '../adaptive-learning/profile.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

function writerBaselineAttempts() {
  return EGE_SKILL_TAXONOMY.skills
    .filter((skill) => skill.id !== 'ege.writing.email')
    .map((skill, index) => ({
      id: `71000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      username: 'adaptivewriter',
      module: skill.module,
      activity: skill.id,
      score: 10,
      max_score: 10,
      duration_ms: 60_000,
      metadata: {},
      evidence_quality: 'server_verified_unassisted',
      created_at: Date.parse(`2026-08-04T08:${String(index).padStart(2, '0')}:00.000Z`),
    }));
}

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

async function returningLearnerContext(browser, options = {}) {
  const context = await browser.newContext(options);
  await context.addInitScript(() => {
    try {
      if (!localStorage.getItem('aisy.onboarding.completion')) {
        localStorage.setItem('aisy.onboarding.completion', JSON.stringify({
          version: 1, completedAt: '2026-08-26T00:00:00.000Z',
        }));
      }
    } catch {}
  });
  return context;
}

async function openProgress(page) {
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('button', { name: 'Прогресс', exact: true }).press('Enter');
  await page.locator('#scr10.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('#adaptive_plan:not([hidden])').waitFor({ state: 'visible', timeout: 5_000 });
}

async function adaptiveRuntimeDiagnostic(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => candidate.includes('adaptive.execution'));
    const envelope = key ? JSON.parse(localStorage.getItem(key) || 'null') : null;
    return {
      revision: envelope?.revision ?? null,
      module: envelope?.active?.module ?? null,
      activityId: envelope?.active?.activityId ?? null,
      pendingPhase: envelope?.active?.pending?.phase ?? null,
    };
  });
}

async function replayPublicRequest(page, pathName, key, body) {
  return page.evaluate(async ({ requestPath, idempotencyKey, payload }) => {
    const marker = window.EasyBoostStore.readCurrentOwner();
    const response = await fetch(requestPath, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'X-EasyBoost-Expected-Owner': marker.owner,
      },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }, { requestPath: pathName, idempotencyKey: key, payload: body });
}

async function browserApiRequest(page, pathName, { method = 'GET', key = null, body = null } = {}) {
  return page.evaluate(async ({ requestPath, requestMethod, idempotencyKey, payload }) => {
    const marker = window.EasyBoostStore.readCurrentOwner();
    const headers = { 'X-EasyBoost-Expected-Owner': marker.owner };
    if (payload !== null) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const requestPayload = requestPath === '/api/v1/module-attempts' && payload !== null
      ? { ...payload, owner: marker.owner }
      : payload;
    const response = await fetch(requestPath, {
      method: requestMethod,
      credentials: 'same-origin',
      headers,
      ...(requestPayload === null ? {} : { body: JSON.stringify(requestPayload) }),
    });
    return { status: response.status, body: await response.json() };
  }, {
    requestPath: pathName, requestMethod: method, idempotencyKey: key, payload: body,
  });
}

async function completePublicShortDiagnostic(page, suffix, { incorrectModules = [] } = {}) {
  let state = (await browserApiRequest(page, '/api/v1/adaptive-learning/diagnostics/start', {
    method: 'POST', key: `adaptive-e2e-${suffix}-diagnostic-start`, body: { depth: 'short' },
  })).body;
  let answerIndex = 0;
  while (state.diagnostic.status === 'in_progress') {
    answerIndex += 1;
    const item = getDiagnosticItem(state.diagnostic.catalogVersion, state.item.id);
    const chooseIncorrect = incorrectModules.includes(item.module);
    const choice = chooseIncorrect
      ? item.choices.find((candidate) => candidate.id !== item.correctChoiceId)
      : item.choices.find((candidate) => candidate.id === item.correctChoiceId);
    const response = await browserApiRequest(
      page,
      `/api/v1/adaptive-learning/diagnostics/${state.diagnostic.id}/answers`,
      {
        method: 'POST', key: `adaptive-e2e-${suffix}-diagnostic-answer-${answerIndex}`,
        body: { itemId: state.item.id, choiceId: choice.id },
      },
    );
    assert.equal(response.status, 201);
    state = response.body;
  }
  const completed = await browserApiRequest(
    page,
    `/api/v1/adaptive-learning/diagnostics/${state.diagnostic.id}/complete`,
    {
      method: 'POST', key: `adaptive-e2e-${suffix}-diagnostic-complete`, body: {},
    },
  );
  assert.equal(completed.status, 201);
  return completed.body;
}

function rgbContrast(foreground, background) {
  const luminance = (rgb) => {
    const channels = rgb.match(/\d+(?:\.\d+)?/gu).slice(0, 3).map((part) => Number(part) / 255)
      .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

async function runAdaptiveDiagnosticE2E() {
  let browser;
  let child;
  let context;
  let examContext;
  let writerContext;
  let commercialContext;
  let adjustmentContext;
  let providerServer;
  let temporaryDirectory;
  try {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-adaptive-e2e-'));
    const port = await findAvailablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const dataFile = path.join(temporaryDirectory, 'data.json');
    const jwtSecret = 'adaptive-e2e-secret-with-at-least-32-characters';
    const providerPort = await findAvailablePort();
    const providerCalls = [];
    providerServer = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        providerCalls.push(request.url);
        const review = {
          words: 110, in_range: true, overall_got: 4, overall_max: 6,
          verdict: 'Изолированный браузерный разбор готов', sub: 'Проверь связность абзацев',
          criteria: [
            { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
            { name: 'Организация текста', got: 1, max: 2 },
            { name: 'Языковое оформление', got: 1, max: 2 },
          ],
          errors: [],
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(review) } }],
          usage: { prompt_tokens: 90, completion_tokens: 40 },
        }));
      });
    });
    await new Promise((resolve, reject) => {
      providerServer.once('error', reject);
      providerServer.listen(providerPort, '127.0.0.1', resolve);
    });
    await fs.writeFile(dataFile, JSON.stringify({
      users: {
        adaptivefree: {
          created: Date.now(), sub_until: Date.now() + 86_400_000,
          privacy_consent: {
            text_processing: true, voice_processing: false,
            policy_version: '2026-08-26-vk-id-v1', updated_at: new Date().toISOString(),
          },
        },
        adaptivee2e: {
          created: Date.now(), sub_until: Date.now() + 86_400_000,
          privacy_consent: {
            text_processing: true, voice_processing: true,
            policy_version: '2026-08-26-vk-id-v1', updated_at: new Date().toISOString(),
          },
        },
        adaptiveadjust: {
          created: Date.now(), sub_until: Date.now() + 86_400_000,
          privacy_consent: {
            text_processing: true, voice_processing: false,
            policy_version: '2026-08-26-vk-id-v1', updated_at: new Date().toISOString(),
          },
        },
        adaptiveexam: {
          created: Date.now(), sub_until: Date.now() + 86_400_000,
          privacy_consent: {
            text_processing: true, voice_processing: true,
            policy_version: '2026-08-26-vk-id-v1', updated_at: new Date().toISOString(),
          },
        },
        adaptivewriter: {
          created: Date.now(), sub_until: Date.now() + 86_400_000,
          privacy_consent: {
            text_processing: true, voice_processing: true,
            policy_version: '2026-08-26-vk-id-v1', updated_at: new Date().toISOString(),
          },
        },
      },
      progress: {
        adaptivefree: {}, adaptivee2e: {}, adaptiveadjust: {}, adaptiveexam: {}, adaptivewriter: {},
      },
      module_attempts: writerBaselineAttempts(),
      subscription_entitlements: {
        adaptivewriter: {
          voice_tutor: {
            starts_at: new Date(Date.now() - 60_000).toISOString(),
            ends_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
        },
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
        ADAPTIVE_LEARNING_ENABLED: 'true',
        XAI_ENABLED: 'true',
        XAI_API_KEY: 'adaptive-local-e2e-key',
        XAI_API_URL: `http://127.0.0.1:${providerPort}/xai`,
        GROQ_API_KEY: '',
        GROQ_ENABLED: 'false',
        VOICE_TUTOR_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    await waitForReady(baseUrl, child, output);

    browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
    context = await returningLearnerContext(browser, { serviceWorkers: 'block' });
    const blockedExternalUrls = [];
    await context.route('https://**', async (route) => {
      blockedExternalUrls.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await context.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'adaptivee2e' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    await context.addInitScript(() => {
      window.__adaptiveSpeechCalls = [];
      class FakeSpeechSynthesisUtterance {
        constructor(text) {
          this.text = text;
          this.lang = '';
        }
      }
      Object.defineProperty(window, 'SpeechSynthesisUtterance', {
        configurable: true,
        value: FakeSpeechSynthesisUtterance,
      });
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          cancel() {},
          speak(utterance) {
            window.__adaptiveSpeechCalls.push({ text: utterance.text, lang: utterance.lang });
          },
        },
      });
    });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const progressEntry = page.getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('button', { name: 'Прогресс', exact: true });
    await progressEntry.waitFor({ state: 'visible', timeout: 5_000 });
    assert.ok((await progressEntry.boundingBox()).height >= 44);
    await progressEntry.focus();
    await progressEntry.press('Enter');
    await page.locator('#scr10.on').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#adaptive_plan:not([hidden])').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#adaptive_access[data-tier="active"]').waitFor({ state: 'visible', timeout: 5_000 });
    await page.evaluate(() => window.tab('scr11'));
    const profileEntry = page.locator('#profile_adaptive_plan');
    await profileEntry.waitFor({ state: 'visible', timeout: 5_000 });
    await profileEntry.focus();
    await profileEntry.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'adaptive_plan_title');

    commercialContext = await returningLearnerContext(browser, {
      serviceWorkers: 'block', viewport: { width: 375, height: 812 }, reducedMotion: 'reduce',
    });
    await commercialContext.route('https://**', (route) => route.abort('blockedbyclient'));
    await commercialContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'adaptivefree' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const commercialPage = await commercialContext.newPage();
    await commercialPage.goto(baseUrl, { waitUntil: 'networkidle' });
    const commercialProgressEntry = commercialPage.getByRole('navigation', { name: 'Основные разделы' })
      .getByRole('button', { name: 'Прогресс', exact: true });
    await commercialProgressEntry.focus();
    assert.notEqual(await commercialProgressEntry.evaluate((element) => getComputedStyle(element).outlineStyle), 'none');
    await commercialProgressEntry.press('Enter');
    await commercialPage.locator('#adaptive_plan:not([hidden])').waitFor({ state: 'visible', timeout: 5_000 });
    await commercialPage.locator('#adaptive_access[data-tier="active"]').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await commercialPage.getByRole('heading', { name: 'Мой план подготовки' }).count(), 1);
    assert.match(await commercialPage.locator('#adaptive_access').innerText(), /Активный доступ/u);
    assert.doesNotMatch(await commercialPage.locator('#adaptive_access').innerText(), /Free|demo|Premium|checkout/iu);
    assert.equal(await commercialPage.locator('input[name="adaptive_session_duration"][value="15"]').isEnabled(), true);
    assert.equal(await commercialPage.locator('input[name="adaptive_session_duration"][value="30"]').isEnabled(), true);
    assert.equal(await commercialPage.locator('#adaptive_session_custom').isEnabled(), true);
    const responsiveState = await commercialPage.evaluate(() => ({
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      screenWidth: document.getElementById('scr10').scrollWidth,
      screenClientWidth: document.getElementById('scr10').clientWidth,
      animationDuration: getComputedStyle(document.getElementById('asya-launcher')).transitionDuration,
    }));
    assert.deepEqual({
      viewport: responsiveState.viewport,
      documentWidth: responsiveState.documentWidth,
      screenWidth: responsiveState.screenWidth,
      screenClientWidth: responsiveState.screenClientWidth,
    }, { viewport: 375, documentWidth: 375, screenWidth: 375, screenClientWidth: 375 });
    assert.ok(
      ['0s', '0.01ms', '0.00001s', '1e-05s'].includes(responsiveState.animationDuration),
      `reduced motion must remove or minimize animation, got ${responsiveState.animationDuration}`,
    );
    const contrastSamples = await commercialPage.evaluate(() => {
      function effectiveBackground(element) {
        for (let current = element; current; current = current.parentElement) {
          const color = getComputedStyle(current).backgroundColor;
          if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
        }
        return 'rgb(255, 255, 255)';
      }
      return ['adaptive_forecast_disclaimer', 'adaptive_session_duration_help'].map((id) => {
        const element = document.getElementById(id);
        return {
          id,
          color: getComputedStyle(element).color,
          background: effectiveBackground(element),
        };
      });
    });
    for (const sample of contrastSamples) {
      assert.ok(
        rgbContrast(sample.color, sample.background) >= 4.5,
        `${sample.id} contrast is below 4.5:1 (${sample.color} on ${sample.background})`,
      );
    }
    const lockedReportPromise = commercialPage.waitForResponse((response) => (
      response.url().endsWith('/api/v1/adaptive-learning/reports/detailed')
    ));
    await commercialPage.locator('#adaptive_detailed_report').press('Enter');
    assert.equal((await lockedReportPromise).status(), 403);
    await commercialPage.locator('#adaptive_paywall:not([hidden])').waitFor({ state: 'visible' });
    assert.match(await commercialPage.locator('#adaptive_report_notice').innerText(), /не входит в выданный доступ/iu);

    await commercialPage.locator('#adaptive_target_score').fill('75');
    await commercialPage.locator('#adaptive_exam_date').fill('2027-06-01');
    await commercialPage.locator('#adaptive_weekly_minutes').fill('180');
    const freeGoalPromise = commercialPage.waitForResponse((response) => (
      response.request().method() === 'PUT'
        && response.url().endsWith('/api/v1/adaptive-learning/goal')
    ));
    await commercialPage.locator('#adaptive_goal_form button[type="submit"]').press('Enter');
    assert.equal((await freeGoalPromise).status(), 201);
    const freePreview = await browserApiRequest(
      commercialPage,
      '/api/v1/adaptive-learning/sessions/preview',
      { method: 'POST', body: { durationMinutes: 15 } },
    );
    assert.equal(freePreview.status, 409);
    assert.equal(freePreview.body.error.code, 'ADAPTIVE_INITIAL_DIAGNOSTIC_REQUIRED');
    await completePublicShortDiagnostic(commercialPage, 'free-demo');
    const diagnosedFreePreview = await browserApiRequest(
      commercialPage,
      '/api/v1/adaptive-learning/sessions/preview',
      { method: 'POST', body: { durationMinutes: 15 } },
    );
    assert.equal(diagnosedFreePreview.status, 200);
    assert.equal(diagnosedFreePreview.body.preview.durationMinutes, 15);
    assert.equal(diagnosedFreePreview.body.preview.blocks.length, 1);
    const freeCreateBody = {
      durationMinutes: 15,
      previewFingerprint: diagnosedFreePreview.body.preview.previewFingerprint,
    };
    const freeCreateKey = 'adaptive-free-demo-create-0001';
    const freeCreated = await browserApiRequest(
      commercialPage,
      '/api/v1/adaptive-learning/sessions',
      { method: 'POST', key: freeCreateKey, body: freeCreateBody },
    );
    assert.equal(freeCreated.status, 201);
    const freeCreateReplay = await browserApiRequest(
      commercialPage,
      '/api/v1/adaptive-learning/sessions',
      { method: 'POST', key: freeCreateKey, body: freeCreateBody },
    );
    assert.equal(freeCreateReplay.status, 200);
    assert.equal(freeCreateReplay.body.session.id, freeCreated.body.session.id);
    const freeCurrent = await browserApiRequest(
      commercialPage,
      '/api/v1/adaptive-learning/sessions/current',
    );
    assert.equal(freeCurrent.status, 200);
    assert.equal(freeCurrent.body.session.id, freeCreated.body.session.id);
    const freeBlock = freeCreated.body.session.blocks[0];
    const freeStartBody = { blockId: freeBlock.id, expectedRevision: 0 };
    const freeStartKey = 'adaptive-free-demo-start-0001';
    const freeStarted = await browserApiRequest(
      commercialPage,
      `/api/v1/adaptive-learning/sessions/${freeCreated.body.session.id}/start`,
      { method: 'POST', key: freeStartKey, body: freeStartBody },
    );
    assert.equal(freeStarted.status, 201);
    const freeStartReplay = await browserApiRequest(
      commercialPage,
      `/api/v1/adaptive-learning/sessions/${freeCreated.body.session.id}/start`,
      { method: 'POST', key: freeStartKey, body: freeStartBody },
    );
    assert.equal(freeStartReplay.status, 200);
    assert.equal(freeStartReplay.body.executionClaim, freeStarted.body.executionClaim);
    const freeAttemptId = '50000000-0000-4000-8000-000000000001';
    const freeAttempt = await browserApiRequest(commercialPage, '/api/v1/module-attempts', {
      method: 'POST',
      body: {
        id: freeAttemptId,
        module: freeBlock.module,
        activity: freeBlock.activityId,
        score: 1,
        maxScore: 1,
        durationMs: 1,
        adaptiveExecutionClaim: freeStarted.body.executionClaim,
      },
    });
    assert.equal(freeAttempt.status, 201);
    const freeAdvanced = await browserApiRequest(
      commercialPage,
      `/api/v1/adaptive-learning/sessions/${freeCreated.body.session.id}/advance`,
      {
        method: 'POST', key: 'adaptive-free-demo-advance-001',
        body: {
          blockId: freeBlock.id,
          expectedRevision: freeStarted.body.execution.revision,
          attempt: { type: 'module', id: freeAttemptId },
        },
      },
    );
    assert.equal(freeAdvanced.status, 200);
    assert.equal(freeAdvanced.body.execution.readyToFinish, true);
    const freeFinished = await browserApiRequest(
      commercialPage,
      `/api/v1/adaptive-learning/sessions/${freeCreated.body.session.id}/finish`,
      {
        method: 'POST', key: 'adaptive-free-demo-finish-0001',
        body: { expectedRevision: freeAdvanced.body.execution.revision },
      },
    );
    assert.equal(freeFinished.status, 200);
    assert.equal(freeFinished.body.session.status, 'completed');
    const secondFreePreview = await browserApiRequest(
      commercialPage,
      '/api/v1/adaptive-learning/sessions/preview',
      { method: 'POST', body: { durationMinutes: 15 } },
    );
    assert.equal(secondFreePreview.status, 200);
    assert.equal(secondFreePreview.body.preview.durationMinutes, 15);

    adjustmentContext = await returningLearnerContext(browser, { serviceWorkers: 'block' });
    await adjustmentContext.route('https://**', async (route) => {
      blockedExternalUrls.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await adjustmentContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'adaptiveadjust' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const adjustmentPage = await adjustmentContext.newPage();
    await adjustmentPage.goto(baseUrl, { waitUntil: 'networkidle' });
    assert.equal((await browserApiRequest(
      adjustmentPage,
      '/api/v1/adaptive-learning/goal',
      {
        method: 'PUT', key: 'adaptive-adjust-goal-0001',
        body: {
          targetExam: 'ege_english', targetScore: 85,
          examDate: '2027-06-01', weeklyMinutes: 300,
        },
      },
    )).status, 201);
    await completePublicShortDiagnostic(adjustmentPage, 'adjustment');
    const adjustmentPreview = await browserApiRequest(
      adjustmentPage,
      '/api/v1/adaptive-learning/sessions/preview',
      { method: 'POST', body: { durationMinutes: 15 } },
    );
    assert.equal(adjustmentPreview.status, 200);
    const adjustmentCreate = await browserApiRequest(
      adjustmentPage,
      '/api/v1/adaptive-learning/sessions',
      {
        method: 'POST', key: 'adaptive-adjust-create-0001',
        body: {
          durationMinutes: 15,
          previewFingerprint: adjustmentPreview.body.preview.previewFingerprint,
        },
      },
    );
    assert.equal(adjustmentCreate.status, 201);
    await openProgress(adjustmentPage);
    await adjustmentPage.locator('#adaptive_session_start').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await adjustmentPage.getByText('Почему изменить блок?', { exact: true }).count(), 1);
    const replacementSelect = adjustmentPage.getByLabel('Почему изменить блок?', { exact: true });
    await replacementSelect.selectOption('not_relevant');
    const replacementResponsePromise = adjustmentPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith(`/api/v1/adaptive-learning/sessions/${adjustmentCreate.body.session.id}/replace`)
        && response.request().postDataJSON().reason === 'not_relevant'
    ));
    await adjustmentPage.getByRole('button', { name: 'Заменить', exact: true }).press('Enter');
    const replacementResponse = await replacementResponsePromise;
    assert.equal(replacementResponse.status(), 200);
    assert.equal((await replacementResponse.json()).session.replacement.reason, 'not_relevant');
    await adjustmentPage.waitForFunction(() => document.activeElement?.id === 'adaptive_session_start');
    assert.equal(await adjustmentPage.getByText('Почему изменить блок?', { exact: true }).count(), 0);

    await page.locator('#adaptive_target_score').fill('85');
    await page.locator('#adaptive_exam_date').fill('2027-06-01');
    await page.locator('#adaptive_weekly_minutes').fill('300');
    const goalResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'PUT'
        && response.url().endsWith('/api/v1/adaptive-learning/goal')
    ));
    await page.locator('#adaptive_goal_form button[type="submit"]').press('Enter');
    const goalResponse = await goalResponsePromise;
    assert.equal(goalResponse.status(), 201);
    const goalResult = await goalResponse.json();
    assert.equal(goalResult.plan.revision, 1);
    await page.locator('#adaptive_forecast:not([hidden])').waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await page.locator('#adaptive_forecast_range').innerText(), /Ориентир: \d+–\d+ баллов/u);
    assert.match(await page.locator('#adaptive_forecast_confidence').innerText(), /не обещание результата/u);
    assert.equal(await page.locator('#adaptive_weekly_allocation > div').count(), 6);

    await context.setOffline(true);
    await page.evaluate(() => { window.tab('scr1'); window.tab('scr10'); });
    await page.locator('#adaptive_plan[data-mode="offline_read_only"]').waitFor({
      state: 'visible', timeout: 5_000,
    });
    assert.match(await page.locator('#adaptive_goal_notice').innerText(), /только для просмотра/u);
    assert.equal(await page.locator('#adaptive_goal_form input:enabled').count(), 0);
    assert.equal(await page.locator('#adaptive_plan button:enabled').count(), 0);
    assert.equal(await page.locator('#adaptive_forecast').isVisible(), true);
    await context.setOffline(false);
    await page.evaluate(() => { window.tab('scr1'); window.tab('scr10'); });
    await page.locator('#adaptive_plan[data-mode="online"]').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await page.locator('#adaptive_target_score').isEnabled(), true);

    const startButton = page.locator('#adaptive_diagnostic_start');
    await startButton.waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await page.locator('#adaptive_plan').innerText(), /Точное время и предел заданий появятся после старта/u);
    await startButton.focus();
    const startResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/diagnostics/start')
    ));
    await startButton.press('Enter');
    const startResponse = await startResponsePromise;
    assert.equal(startResponse.status(), 201);
    const started = await startResponse.json();
    const startKey = startResponse.request().headers()['idempotency-key'];
    assert.ok(startKey);
    await page.locator('#adaptive_diagnostic_form').waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForFunction(() => (
      document.activeElement?.matches('input[name="adaptive_diagnostic_choice"]')
    ));
    assert.match(await page.locator('#adaptive_diagnostic_timing').innerText(), /20 минут после старта/u);
    assert.equal(await page.locator('#adaptive_diagnostic_progress').getAttribute('max'), '12');
    assert.equal(await page.locator('#adaptive_diagnostic_progress_label').innerText(), '0 из 12');
    const diagnosticId = started.diagnostic.id;
    const initialItemId = started.item.id;

    const replayedStart = await replayPublicRequest(
      page,
      '/api/v1/adaptive-learning/diagnostics/start',
      startKey,
      {},
    );
    assert.equal(replayedStart.status, 200);
    assert.equal(replayedStart.body.diagnostic.id, diagnosticId);
    assert.equal(replayedStart.body.diagnostic.status, 'in_progress');
    assert.equal(replayedStart.body.diagnostic.answeredItems, 0);
    assert.equal(replayedStart.body.item.id, initialItemId);

    await page.reload({ waitUntil: 'networkidle' });
    await openProgress(page);
    await page.waitForFunction(({ expectedDiagnosticId, expectedItemId }) => {
      const section = document.querySelector('#adaptive_diagnostic');
      return section?.dataset.diagnosticId === expectedDiagnosticId
        && section?.dataset.itemId === expectedItemId;
    }, { expectedDiagnosticId: diagnosticId, expectedItemId: initialItemId }, { timeout: 5_000 });
    assert.equal(await page.locator('#adaptive_diagnostic_progress').getAttribute('value'), '0');
    assert.match(await page.locator('#adaptive_diagnostic').innerText(), /20 минут/u);

    let audioWasPlayed = false;
    let firstAnswerReplay;
    for (let answered = 0; answered < 10; answered += 1) {
      const section = page.locator('#adaptive_diagnostic');
      const priorItemId = await section.getAttribute('data-item-id');
      const audioButton = page.locator('#adaptive_diagnostic_audio');
      if (await audioButton.isVisible()) {
        const before = await page.evaluate(() => window.__adaptiveSpeechCalls.length);
        assert.match(await page.locator('#adaptive_diagnostic_notice').innerText(), /ориентировочная проверка аудирования/u);
        await audioButton.focus();
        await audioButton.press('Enter');
        await page.waitForFunction((count) => window.__adaptiveSpeechCalls.length === count + 1, before);
        audioWasPlayed = true;
      }

      const firstChoice = page.locator('input[name="adaptive_diagnostic_choice"]').first();
      await firstChoice.focus();
      await firstChoice.press('Space');
      const answerPath = `/api/v1/adaptive-learning/diagnostics/${diagnosticId}/answers`;
      const answerResponsePromise = page.waitForResponse((response) => (
        response.request().method() === 'POST' && response.url().endsWith(answerPath)
      ));
      const submitButton = page.locator('#adaptive_diagnostic_form button[type="submit"]');
      await submitButton.focus();
      await submitButton.press('Enter');
      const answerResponse = await answerResponsePromise;
      assert.equal(answerResponse.status(), 201);
      const answerResult = await answerResponse.json();

      if (answered === 0) {
        const answerRequest = answerResponse.request();
        const answerKey = answerRequest.headers()['idempotency-key'];
        const answerBody = answerRequest.postDataJSON();
        const replayedAnswer = await replayPublicRequest(page, answerPath, answerKey, answerBody);
        assert.equal(replayedAnswer.status, 200);
        assert.equal(replayedAnswer.body.diagnostic.id, diagnosticId);
        assert.equal(replayedAnswer.body.diagnostic.answeredItems, 1);
        firstAnswerReplay = {
          path: answerPath,
          key: answerKey,
          body: answerBody,
          expected: replayedAnswer.body,
        };
      }
      if (answered === 1) {
        const replayedAfterLaterAnswer = await replayPublicRequest(
          page,
          firstAnswerReplay.path,
          firstAnswerReplay.key,
          firstAnswerReplay.body,
        );
        assert.equal(replayedAfterLaterAnswer.status, 200);
        assert.deepEqual(replayedAfterLaterAnswer.body, firstAnswerReplay.expected);
      }

      assert.equal(answerResult.diagnostic.answeredItems, answered + 1);
      await page.waitForFunction(({ itemId, expectedAnswered }) => {
        const diagnostic = document.querySelector('#adaptive_diagnostic');
        const progress = document.querySelector('#adaptive_diagnostic_progress');
        return Number(progress?.value) === expectedAnswered
          && (diagnostic?.dataset.itemId !== itemId || expectedAnswered === 10);
      }, { itemId: priorItemId, expectedAnswered: answered + 1 }, { timeout: 5_000 });
      await page.waitForFunction((lastAnswer) => (
        lastAnswer
          ? document.activeElement?.id === 'adaptive_diagnostic_complete'
          : document.activeElement?.matches('input[name="adaptive_diagnostic_choice"]')
      ), answered === 9);
    }

    assert.equal(audioWasPlayed, true);
    const speechCalls = await page.evaluate(() => window.__adaptiveSpeechCalls);
    assert.ok(speechCalls.length >= 1);
    assert.ok(speechCalls.every((call) => call.lang === 'en-US'));
    const completeButton = page.locator('#adaptive_diagnostic_complete');
    await completeButton.waitFor({ state: 'visible', timeout: 5_000 });
    await completeButton.focus();
    const completeResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith(`/api/v1/adaptive-learning/diagnostics/${diagnosticId}/complete`)
    ));
    await completeButton.press('Enter');
    const completeResponse = await completeResponsePromise;
    assert.equal(
      completeResponse.status(),
      201,
      `Unexpected completion response: ${await completeResponse.text()}\n${output.join('')}`,
    );
    const replayedAfterCompletion = await replayPublicRequest(
      page,
      firstAnswerReplay.path,
      firstAnswerReplay.key,
      firstAnswerReplay.body,
    );
    assert.equal(replayedAfterCompletion.status, 200);
    assert.deepEqual(replayedAfterCompletion.body, firstAnswerReplay.expected);
    await page.getByText(/Диагностика завершена/u).waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForFunction(() => document.activeElement?.id === 'adaptive_diagnostic_title');
    assert.equal(await page.locator('#adaptive_diagnostic_form').isHidden(), true);
    assert.equal(await startButton.isHidden(), true);

    const current = await browserApiRequest(page, '/api/v1/adaptive-learning/diagnostics/current');
    assert.equal(current.status, 200);
    assert.deepEqual(current.body, { diagnostic: null, item: null });
    const currentPlan = await browserApiRequest(page, '/api/v1/adaptive-learning/plan');
    assert.equal(currentPlan.status, 200);
    assert.equal(currentPlan.body.plan.revision, 2);
    assert.ok(currentPlan.body.plan.profileEvidenceSourceCount >= 10);
    assert.equal(await page.locator('#adaptive_forecast').isVisible(), true);
    const lowBudgetGoal = await browserApiRequest(page, '/api/v1/adaptive-learning/goal', {
      method: 'PUT',
      key: 'adaptive-e2e-low-budget-goal-01',
      body: {
        targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 30,
      },
    });
    assert.equal(lowBudgetGoal.status, 201);
    assert.equal(lowBudgetGoal.body.goal.weeklyMinutes, 30);
    assert.equal(lowBudgetGoal.body.plan.revision, 3);
    assert.equal(lowBudgetGoal.body.plan.forecast.feasibility, 'unlikely_with_current_time');
    assert.equal(lowBudgetGoal.body.plan.forecast.choices.some((choice) => (
      choice.type === 'increase_weekly_time'
    )), true);
    assert.equal(lowBudgetGoal.body.plan.forecast.choices.some((choice) => (
      choice.type === 'adjust_target_score'
    )), true);
    const vocabularyGap = await page.evaluate(async () => {
      const marker = window.EasyBoostStore.readCurrentOwner();
      const responses = [];
      const activities = [
        ['vocabulary', 'vocabulary_lexical_choice_topic_1', 0],
        ['grammar', 'grammar_forms_topic_3', 1],
        ['grammar', 'grammar_transformations_topic_18', 1],
        ['reading', 'reading_headings', 1], ['reading', 'reading_detail', 1],
        ['listening', 'listening_matching', 1], ['listening', 'listening_interview', 1],
      ];
      for (const [module, activity, score] of activities) for (let index = 0; index < 3; index += 1) {
        const response = await fetch('/api/v1/module-attempts', {
          method: 'POST', credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'X-EasyBoost-Expected-Owner': marker.owner,
          },
          body: JSON.stringify({
            id: crypto.randomUUID(), owner: marker.owner, module, activity, score, maxScore: 1,
          }),
        });
        responses.push(response.status);
      }
      const plan = await fetch('/api/v1/adaptive-learning/plan', {
        credentials: 'same-origin', headers: { 'X-EasyBoost-Expected-Owner': marker.owner },
      });
      return { responses, status: plan.status, body: await plan.json() };
    });
    assert.equal(vocabularyGap.responses.length, 21);
    assert.equal(vocabularyGap.responses.every((status) => status === 201), true);
    assert.equal(vocabularyGap.status, 200);
    assert.equal(vocabularyGap.body.plan.revision, 4);
    const resetAllocation = await browserApiRequest(page, '/api/v1/adaptive-learning/goal', {
      method: 'PUT',
      key: 'adaptive-e2e-evidence-reset-goal-01',
      body: {
        targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 35,
      },
    });
    assert.equal(resetAllocation.status, 201);
    assert.equal(resetAllocation.body.plan.revision, 5);

    const duration90 = page.locator('input[name="adaptive_session_duration"][value="90"]');
    await duration90.focus();
    await duration90.press('Space');
    const previewResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions/preview')
    ));
    const previewButton = page.locator('#adaptive_session_preview');
    await previewButton.focus();
    await previewButton.press('Enter');
    const previewResponse = await previewResponsePromise;
    assert.equal(previewResponse.status(), 200);
    const previewResult = await previewResponse.json();
    assert.equal(previewResult.preview.durationMinutes, 90);
    assert.equal(previewResult.preview.weeklyBudgetSnapshot.weeklyAvailableMinutes, 35);
    assert.ok(previewResult.preview.weeklyBudgetSnapshot.coverageGaps
      .includes('ege.vocabulary.word_formation'));
    assert.equal(previewResult.preview.blocks.some((block) => block.kind === 'break'), true);
    await page.getByText(/Перерыв · 10 мин/u).waitFor({ state: 'visible', timeout: 5_000 });

    const duration15 = page.locator('input[name="adaptive_session_duration"][value="15"]');
    await duration15.focus();
    await duration15.press('Space');
    const executablePreviewPromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions/preview')
    ));
    await previewButton.focus();
    await previewButton.press('Enter');
    const executablePreviewResponse = await executablePreviewPromise;
    assert.equal(executablePreviewResponse.status(), 200);
    const executablePreview = (await executablePreviewResponse.json()).preview;
    assert.equal(executablePreview.durationMinutes, 15);
    assert.equal(executablePreview.blocks.length, 1);
    assert.ok(['vocabulary', 'listening'].includes(executablePreview.blocks[0].module));

    const createSessionResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions')
    ));
    const createSessionButton = page.locator('#adaptive_session_create');
    await createSessionButton.focus();
    await createSessionButton.press('Enter');
    const createSessionResponse = await createSessionResponsePromise;
    assert.equal(createSessionResponse.status(), 201);
    const createSessionResult = await createSessionResponse.json();
    assert.equal(createSessionResult.session.status, 'created');
    await page.locator('#adaptive_session_start').waitFor({ state: 'visible', timeout: 5_000 });

    const firstActivity = createSessionResult.session.blocks.find((block) => block.kind === 'learning');
    assert.ok(['vocabulary', 'listening'].includes(firstActivity.module));
    assert.match(await page.locator('#adaptive_session_blocks').innerText(), new RegExp(
      `${firstActivity.skillLabel} — ${firstActivity.activityLabel}`.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
      'u',
    ));
    const startSessionButton = page.locator('#adaptive_session_start');
    const startBlockResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/start')
    ));
    await startSessionButton.focus();
    await startSessionButton.press('Enter');
    const startBlockResponse = await startBlockResponsePromise;
    assert.equal(startBlockResponse.status(), 201);
    await page.locator(`#${firstActivity.launch.screenId}.on`).waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForFunction(({ screenId, kind, contentRef }) => {
      const screen = document.getElementById(screenId);
      return screen?.dataset.adaptiveLaunchKind === kind
        && screen?.dataset.adaptiveLaunchContentRef === contentRef;
    }, {
      screenId: firstActivity.launch.screenId,
      kind: firstActivity.launch.kind,
      contentRef: firstActivity.contentRef,
    }, { timeout: 5_000 });
    const activeHandoff = await page.evaluate(() => { const marker=window.EasyBoostStore.readCurrentOwner();
      return JSON.parse(localStorage.getItem('easyboost.adaptive.execution.v1:'+encodeURIComponent(marker.owner)+':g'+marker.ownerGeneration)).active });
    assert.equal(activeHandoff.module, firstActivity.module);
    assert.equal(activeHandoff.activityId, firstActivity.activityId);
    assert.equal(activeHandoff.pending, null);
    const privacyLater = page.getByRole('button', { name: 'Позже', exact: true });
    if (await privacyLater.isVisible()) await privacyLater.click();
    const attemptResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/module-attempts')
        && Boolean(response.request().postDataJSON().adaptiveExecutionClaim)
    ), { timeout: 5_000 }).catch(() => null);
    const advanceResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/advance')
    ), { timeout: 5_000 }).catch(() => null);
    if (firstActivity.launch.kind === 'vocabulary_practice') {
      const practice = await page.evaluate(() => {
        const task = window.WQ.find((candidate) => candidate.mode !== 'introduction');
        window.WQ.splice(0, window.WQ.length, task);
        window.wRender();
        const item = window.EGE_WORDS.find((candidate) => (
          String(candidate.w || '').replace(/\*/gu, '').trim().toLowerCase() === task.word
        ));
        return {
          answer: String(item.w).replace(/\*/gu, '').trim(),
          mode: task.mode,
          translation: item.tr,
        };
      });
      const expectedMode = firstActivity.launch.mode === 'lexical_choice'
        ? 'receptive_meaning'
        : firstActivity.launch.mode;
      assert.equal(practice.mode, expectedMode);
      if (practice.mode === 'receptive_meaning') {
        await page.locator('#w_opts button').filter({ hasText: practice.translation }).click();
      } else {
        await page.locator('#w_session_input').fill(practice.answer);
        await page.getByRole('button', { name: /Проверить/u }).click();
      }
      await page.getByRole('button', { name: /Дальше/u }).click();
    } else if (firstActivity.launch.mode === 'matching') {
      for (let row = 0; row < 6; row += 1) {
        await page.locator(`#lmt_row_${row} button`).nth(row).click();
      }
      await page.getByRole('button', { name: 'Проверить ответы', exact: true }).click();
    } else {
      const questionCount = await page.locator('[id^="liq_row_"]').count();
      for (let row = 0; row < questionCount; row += 1) {
        await page.locator(`#liq_row_${row} button`).first().click();
      }
      await page.getByRole('button', { name: 'Проверить ответы', exact: true }).click();
    }
    const attemptResponse = await attemptResponsePromise;
    if (!attemptResponse) {
      const probe = await page.evaluate(async () => {
        const marker=window.EasyBoostStore.readCurrentOwner();const raw=localStorage.getItem('easyboost.adaptive.execution.v1:'+encodeURIComponent(marker.owner)+':g'+marker.ownerGeneration);
        const current = await fetch('/api/v1/adaptive-learning/sessions/current',{headers:{'X-EasyBoost-Expected-Owner':marker.owner}});
        return { raw, currentStatus: current.status, current: await current.json() };
      });
      assert.fail(`adaptive attempt was not sent: ${JSON.stringify({ firstActivity, probe })}`);
    }
    assert.equal(attemptResponse.status(), 201);
    const advanceResponse = await advanceResponsePromise;
    assert.ok(advanceResponse, 'adaptive advance response was not observed');
    assert.equal(advanceResponse.status(), 200);
    const advanceResult = await advanceResponse.json();
    assert.equal(advanceResult.execution.readyToFinish, true);
    assert.equal(advanceResult.completedBlock.evidenceQuality, 'client_reported');
    assert.equal(
      advanceResult.profileChange.evidenceSourceCountAfter,
      advanceResult.profileChange.evidenceSourceCountBefore + 1,
    );
    assert.ok(advanceResult.planChange.planRevisionAfter > advanceResult.planChange.planRevisionBefore);
    await page.locator('#scr10.on').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#adaptive_session_blocks li[data-state="completed"]').waitFor({
      state: 'visible', timeout: 5_000,
    });
    assert.match(await page.locator('#adaptive_session_notice').innerText(), /новых доказательств: 1/u);
    assert.equal(await page.evaluate(() => { const marker=window.EasyBoostStore.readCurrentOwner();
      return JSON.parse(localStorage.getItem('easyboost.adaptive.execution.v1:'+encodeURIComponent(marker.owner)+':g'+marker.ownerGeneration)).active }), null);

    const finishResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/finish')
    ));
    await page.locator('#adaptive_session_start').press('Enter');
    const finishResponse = await finishResponsePromise;
    assert.equal(finishResponse.status(), 200);
    const finishResult = await finishResponse.json();
    assert.equal(finishResult.session.status, 'completed');
    assert.equal(finishResult.summary.completedLearningBlocks, 1);
    assert.equal(finishResult.summary.completedWork.length, 1);
    assert.equal(finishResult.summary.completedWork[0].activityId, firstActivity.activityId);
    assert.equal(finishResult.summary.completedWork[0].evidenceQuality, 'client_reported');
    assert.ok(['planned_practice', 'scheduled_review'].includes(
      finishResult.summary.completedWork[0].evidenceContext,
    ));
    await page.getByText(/Занятие завершено: 1 учебных блоков/u).waitFor({
      state: 'visible', timeout: 5_000,
    });
    assert.match(await page.locator('#adaptive_session_blocks').innerText(), new RegExp(
      firstActivity.activityLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u',
    ));
    const updatedOverview = await browserApiRequest(page, '/api/v1/adaptive-learning/overview');
    assert.equal(updatedOverview.status, 200);
    assert.equal(updatedOverview.body.plan.revision, advanceResult.planAfter.revision);
    assert.equal(
      updatedOverview.body.profile.evidenceSourceCount,
      advanceResult.profileChange.evidenceSourceCountAfter,
    );
    const currentSessionAfterFinish = await browserApiRequest(
      page,
      '/api/v1/adaptive-learning/sessions/current',
    );
    assert.equal(currentSessionAfterFinish.status, 404);

    await duration15.focus();
    await duration15.press('Space');
    const exclusionPreviewPromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions/preview')
    ));
    await previewButton.press('Enter');
    assert.equal((await exclusionPreviewPromise).status(), 200);
    const exclusionCreatePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions')
    ));
    await createSessionButton.press('Enter');
    const exclusionCreateResponse = await exclusionCreatePromise;
    assert.equal(exclusionCreateResponse.status(), 201);
    const exclusionSession = (await exclusionCreateResponse.json()).session;
    await page.getByText('Почему изменить блок?', { exact: true }).waitFor({
      state: 'visible', timeout: 5_000,
    });
    assert.equal(await page.getByText('Почему изменить блок?', { exact: true }).count(), 1);
    const exclusionResponsePromise = page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith(`/api/v1/adaptive-learning/sessions/${exclusionSession.id}/replace`)
        && response.request().postDataJSON().reason === 'excluded'
    ));
    await page.getByRole('button', { name: 'Исключить этот блок', exact: true }).press('Enter');
    const exclusionResponse = await exclusionResponsePromise;
    assert.equal(exclusionResponse.status(), 200);
    assert.equal((await exclusionResponse.json()).session.replacement.reason, 'excluded');
    await page.waitForFunction(() => document.activeElement?.id === 'adaptive_session_start');

    const examLaunch = await page.evaluate(() => new Promise((resolve) => {
      window.nav('scr3', () => resolve(
        window.launchGrammarExam('builtin:exam:grammar:19-24:v1'),
      ));
    }));
    assert.equal(examLaunch, true);
    await page.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.match(await page.locator('#g_card').innerText(), /ЗАДАНИЯ 19–24/u);
    assert.equal(await page.locator('[id^="g_ex_"]').count(), 6);

    examContext = await returningLearnerContext(browser, { serviceWorkers: 'block' });
    await examContext.route('https://**', async (route) => {
      blockedExternalUrls.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await examContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'adaptiveexam' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const examPage = await examContext.newPage();
    const examConsole = [];
    examPage.on('console', (message) => examConsole.push(`${message.type()}: ${message.text()}`));
    await examPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await completePublicShortDiagnostic(examPage, 'existing-exam', { incorrectModules: ['grammar'] });
    await examPage.reload({ waitUntil: 'networkidle' });
    await openProgress(examPage);
    await examPage.locator('#adaptive_access[data-tier="active"]').waitFor({ state: 'visible', timeout: 5_000 });
    const existingOverview = await browserApiRequest(examPage, '/api/v1/adaptive-learning/overview');
    assert.equal(existingOverview.status, 200);
    assert.equal(existingOverview.body.profile.needsDiagnostic, false);
    assert.equal(existingOverview.body.profile.status, 'preliminary');
    assert.ok(existingOverview.body.profile.explanationCodes.includes('short_diagnostic_complete'));
    assert.equal(await examPage.locator('#adaptive_diagnostic_start').isHidden(), true);
    await examPage.locator('#adaptive_target_score').fill('85');
    await examPage.locator('#adaptive_exam_date').fill('2027-06-01');
    await examPage.locator('#adaptive_weekly_minutes').fill('300');
    const examGoalPromise = examPage.waitForResponse((response) => (
      response.request().method() === 'PUT'
        && response.url().endsWith('/api/v1/adaptive-learning/goal')
    ));
    await examPage.locator('#adaptive_goal_form button[type="submit"]').press('Enter');
    assert.equal((await examGoalPromise).status(), 201);
    await examPage.locator('#adaptive_session_custom').fill('20');
    const examPreviewPromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions/preview')
    ));
    await examPage.locator('#adaptive_session_preview').press('Enter');
    const examPreviewResponse = await examPreviewPromise;
    assert.equal(examPreviewResponse.status(), 200);
    const examPreview = (await examPreviewResponse.json()).preview;
    assert.equal(examPreview.blocks[0].activityId, 'grammar_forms_exam_19_24');
    const examCreatePromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions')
    ));
    await examPage.locator('#adaptive_session_create').press('Enter');
    const examCreateResponse = await examCreatePromise;
    assert.equal(examCreateResponse.status(), 201);
    const examSession = (await examCreateResponse.json()).session;
    const examBlock = examSession.blocks[0];
    await examPage.locator('#adaptive_session_start').waitFor({ state: 'visible', timeout: 5_000 });
    const examStartPromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/start')
    ));
    await examPage.locator('#adaptive_session_start').press('Enter');
    assert.equal((await examStartPromise).status(), 201);
    await examPage.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await examPage.locator('[id^="g_ex_"]').count(), 6);
    for (let index = 0; index < 6; index += 1) await examPage.locator(`#g_ex_${index}`).fill('wrong');
    const examAttemptPromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/module-attempts')
        && response.request().postDataJSON().adaptiveExecutionClaim
    )).catch((error) => error);
    const examAdvancePromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/advance')
    )).catch((error) => error);
    await examPage.getByRole('button', { name: 'Проверить', exact: true }).press('Enter');
    const examAttemptResponse = await examAttemptPromise;
    if (examAttemptResponse instanceof Error) {
      const runtimeState = await adaptiveRuntimeDiagnostic(examPage);
      throw new Error(`${examAttemptResponse.message}\nAdaptive runtime state: ${JSON.stringify(runtimeState)}\nConsole: ${examConsole.join(' | ')}`);
    }
    assert.equal(examAttemptResponse.status(), 201);
    const examAdvanceResponse = await examAdvancePromise;
    if (examAdvanceResponse instanceof Error) {
      const runtimeState = await adaptiveRuntimeDiagnostic(examPage);
      throw new Error(`${examAdvanceResponse.message}\nAdaptive runtime state: ${JSON.stringify(runtimeState)}`);
    }
    assert.equal(examAdvanceResponse.status(), 200);
    const examAdvance = await examAdvanceResponse.json();
    assert.equal(examAdvance.completedBlock.activityId, examBlock.activityId);
    assert.equal(examAdvance.completedBlock.evidenceQuality, 'client_reported');
    assert.equal(examAdvance.completedBlock.evidenceContext, 'exam_practice');
    await examPage.locator('#scr10.on').waitFor({ state: 'visible', timeout: 5_000 });
    await examPage.waitForFunction(() => {
      const button = document.getElementById('adaptive_session_start');
      return button && !button.hidden && !button.disabled
        && button.textContent === 'Завершить занятие';
    });
    const examFinishPromise = examPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/finish')
    ));
    await examPage.locator('#adaptive_session_start').press('Enter');
    const examFinishResponse = await examFinishPromise;
    assert.equal(examFinishResponse.status(), 200);
    const examFinish = await examFinishResponse.json();
    assert.equal(examFinish.summary.completedWork[0].evidenceContext, 'exam_practice');

    await page.waitForLoadState('networkidle');
    const providerCallsBeforeAdaptiveWriter = providerCalls.length;
    writerContext = await returningLearnerContext(browser, { serviceWorkers: 'block' });
    await writerContext.route('https://**', async (route) => {
      blockedExternalUrls.push(route.request().url());
      await route.abort('blockedbyclient');
    });
    await writerContext.addCookies([{
      name: 'eb_token',
      value: jwt.sign({ u: 'adaptivewriter' }, jwtSecret, { expiresIn: '1h' }),
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
    const writerPage = await writerContext.newPage();
    await writerPage.goto(baseUrl, { waitUntil: 'networkidle' });
    await completePublicShortDiagnostic(writerPage, 'existing-writer', { incorrectModules: ['writing'] });
    await writerPage.reload({ waitUntil: 'networkidle' });
    await openProgress(writerPage);
    await writerPage.locator('#adaptive_access[data-tier="active"]').waitFor({ state: 'visible', timeout: 5_000 });
    await writerPage.locator('#adaptive_target_score').fill('85');
    await writerPage.locator('#adaptive_exam_date').fill('2027-06-01');
    await writerPage.locator('#adaptive_weekly_minutes').fill('300');
    const writerGoalPromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'PUT'
        && response.url().endsWith('/api/v1/adaptive-learning/goal')
    ));
    await writerPage.locator('#adaptive_goal_form button[type="submit"]').press('Enter');
    assert.equal((await writerGoalPromise).status(), 201);
    assert.equal(providerCalls.length, providerCallsBeforeAdaptiveWriter,
      `opening an adaptive plan and saving its goal must not call AI: ${JSON.stringify(providerCalls.slice(providerCallsBeforeAdaptiveWriter))}`);

    await writerPage.locator('#adaptive_session_custom').fill('25');
    const writerPreviewPromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions/preview')
    ));
    await writerPage.locator('#adaptive_session_preview').press('Enter');
    const writerPreviewResponse = await writerPreviewPromise;
    assert.equal(writerPreviewResponse.status(), 200);
    const writerPreview = (await writerPreviewResponse.json()).preview;
    assert.equal(writerPreview.blocks.length, 1);
    assert.equal(writerPreview.blocks[0].activityId, 'writing_37');
    assert.equal(providerCalls.length, providerCallsBeforeAdaptiveWriter,
      'previewing an adaptive plan must not call AI');

    const writerCreatePromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/sessions')
    ));
    await writerPage.locator('#adaptive_session_create').press('Enter');
    const writerCreateResponse = await writerCreatePromise;
    assert.equal(writerCreateResponse.status(), 201);
    const writerSession = (await writerCreateResponse.json()).session;
    const writingBlock = writerSession.blocks[0];
    assert.equal(writingBlock.contentRef, 'builtin:writing_37:emily-new-flat');

    await writerPage.locator('#adaptive_session_start').waitFor({ state: 'visible', timeout: 5_000 });
    const writerStartPromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/start')
    ));
    await writerPage.locator('#adaptive_session_start').press('Enter');
    assert.equal((await writerStartPromise).status(), 201);
    await writerPage.locator('#scr8.on').waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await writerPage.getByRole('button', { name: 'Новая тема' }).count(), 0);
    assert.equal(await writerPage.locator('#w_seg37').isDisabled(), true);
    const lockedWritingTask = await writerPage.evaluate(() => ({
      changed: window.wrNext(),
      contentRef: document.getElementById('scr8').dataset.adaptiveLaunchContentRef,
    }));
    assert.equal(lockedWritingTask.changed, false);
    assert.equal(lockedWritingTask.contentRef, writingBlock.contentRef);

    const writingAnswer = Array.from({ length: 110 }, (_, index) => `word${index}`).join(' ');
    await writerPage.locator('#w_editor').fill(writingAnswer);
    const writingEvaluationPromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/ai/evaluate-writing')
    ));
    const writingAdvancePromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/advance')
    ));
    await writerPage.getByRole('button', { name: 'Проверить с ИИ' }).press('Enter');
    assert.equal((await writingEvaluationPromise).status(), 200);
    const writingAdvance = await writingAdvancePromise;
    assert.equal(writingAdvance.status(), 200);
    const writingAdvanceResult = await writingAdvance.json();
    assert.equal(writingAdvanceResult.completedBlock.evidenceQuality, 'server_verified_assisted');
    assert.equal(writingAdvanceResult.completedBlock.evidenceContext, 'ai_assisted_review');
    await writerPage.locator('#scr12.on').waitFor({ state: 'visible', timeout: 5_000 });
    await writerPage.getByText('Изолированный браузерный разбор готов').waitFor({ state: 'visible' });
    const returnFromWriting = writerPage.locator('#adaptive_writing_return');
    await returnFromWriting.waitFor({ state: 'visible', timeout: 5_000 });
    assert.equal(await writerPage.locator('#scr10.on').count(), 0);
    await returnFromWriting.press('Enter');
    await writerPage.locator('#scr10.on').waitFor({ state: 'visible', timeout: 5_000 });
    await writerPage.waitForFunction(() => {
      const button = document.getElementById('adaptive_session_start');
      return button && !button.hidden && !button.disabled
        && button.textContent === 'Завершить занятие';
    });

    const writerFinishPromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/finish')
    ));
    await writerPage.locator('#adaptive_session_start').press('Enter');
    const writerFinishResponse = await writerFinishPromise;
    assert.equal(writerFinishResponse.status(), 200);
    const writerFinish = await writerFinishResponse.json();
    assert.equal(writerFinish.summary.completedWork[0].evidenceQuality, 'server_verified_assisted');
    assert.equal(writerFinish.summary.completedWork[0].evidenceContext, 'ai_assisted_review');
    await writerPage.locator('#adaptive_deep_diagnostic_start').waitFor({ state: 'visible' });
    await writerPage.evaluate(() => {
      const section = document.getElementById('adaptive_diagnostic');
      const title = document.getElementById('adaptive_diagnostic_title');
      const restart = document.getElementById('adaptive_diagnostic_start');
      section.hidden = false;
      title.textContent = 'Глубокая диагностика';
      restart.hidden = false;
      restart.dataset.diagnosticDepth = 'deep';
    });
    assert.match(await writerPage.locator('#adaptive_diagnostic_title').innerText(), /Глубокая/u);
    const deepRestartResponsePromise = writerPage.waitForResponse((response) => (
      response.request().method() === 'POST'
        && response.url().endsWith('/api/v1/adaptive-learning/diagnostics/start')
    ));
    await writerPage.evaluate(() => {
      const restart = document.getElementById('adaptive_diagnostic_start');
      restart.dataset.diagnosticDepth = 'deep';
      restart.focus();
      restart.click();
    });
    const deepRestartResponse = await deepRestartResponsePromise;
    assert.equal(deepRestartResponse.request().postDataJSON().depth, 'deep');
    assert.equal(deepRestartResponse.status(), 201);
    assert.equal((await deepRestartResponse.json()).diagnostic.depth, 'deep');
    await writerPage.waitForFunction(() => (
      document.activeElement?.matches('input[name="adaptive_diagnostic_choice"]')
    ));
    const reportResponsePromise = writerPage.waitForResponse((response) => (
      response.url().endsWith('/api/v1/adaptive-learning/reports/detailed')
    ));
    await writerPage.locator('#adaptive_detailed_report').press('Enter');
    const reportResponse = await reportResponsePromise;
    assert.equal(
      reportResponse.status(),
      200,
      `detailed report failed: ${await reportResponse.text()}\n${output.join('')}`,
    );
    await writerPage.locator('#adaptive_report:not([hidden])').waitFor({ state: 'visible' });
    assert.ok(await writerPage.locator('#adaptive_report_rows tr').count() >= 1);
    assert.match(await writerPage.locator('#adaptive_orientation').innerText(), /Примерный языковой ориентир/u);
    assert.match(await writerPage.locator('#adaptive_report_disclaimer').innerText(), /неофициальный.*не сертификат.*не официальный результат/u);
    assert.ok(providerCalls.length >= 1);
    assert.equal(blockedExternalUrls.some((url) => /x\.ai|groq|openai/u.test(url)), false);
    console.log('adaptive e2e: diagnostic plus client module, exam launch and exact writing execution passed');
  } finally {
    if (adjustmentContext) await adjustmentContext.close();
    if (commercialContext) await commercialContext.close();
    if (writerContext) await writerContext.close();
    if (examContext) await examContext.close();
    if (context) await context.close();
    if (browser) await browser.close();
    if (child) await stopProcess(child);
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

runAdaptiveDiagnosticE2E().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
