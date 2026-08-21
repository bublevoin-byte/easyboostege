import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, openEgeMock, stopProcess,
  waitForReady,
} from './browser-server-harness.js';
import { EGE_MOCK_FORM_1_V1_PUBLIC as egeForm } from '../public/ege-mock-form-1-v1.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const username = 'ege-mock-oral-user';
const jwtSecret = 'ege-mock-oral-e2e-secret-32-characters';

let browser;
let child;
let context;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-oral-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: { [username]: { created: Date.now(), sub_until: Date.now() + 86_400_000 } },
    progress: { [username]: {} },
  }), 'utf8');
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
  const assessmentUploads = [];
  let aiEvaluations = 0;
  let oralAttemptGets = 0;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  context.on('request', (request) => {
    if (request.method() === 'GET'
      && /\/api\/v1\/ege-mocks\/attempts\/[0-9a-f-]+$/iu.test(new URL(request.url()).pathname)) {
      oralAttemptGets += 1;
    }
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        async getUserMedia() {
          const track = { readyState: 'live', stop() {} };
          return { getAudioTracks: () => [track], getTracks: () => [track] };
        },
      },
    });
    class FakeAudioContext {
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() {
        return { fftSize: 512, getByteTimeDomainData(values) { values.fill(132); } };
      }
      async decodeAudioData() {
        const samples = new Float32Array(16_000).fill(0.04);
        return {
          numberOfChannels: 1, length: samples.length, sampleRate: 16_000,
          getChannelData() { return samples; },
        };
      }
      async close() {}
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: FakeAudioContext });
    class FakeMediaRecorder {
      static isTypeSupported(type) { return type === 'audio/webm'; }
      constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; }
      start() {
        globalThis.__egeOralRecorderStarts = (globalThis.__egeOralRecorderStarts || 0) + 1;
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['oral-e2e-audio'], { type: this.mimeType }) });
        this.onstop?.();
      }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });
  });
  await page.route('**/api/v1/speaking/full-sessions/*/pronunciation-assessment', async (route) => {
    assessmentUploads.push(route.request().headers()['idempotency-key']);
    await route.fulfill({
      status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SPEAKING_PRONUNCIATION_UNAVAILABLE' } }),
    });
  });
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/ai/evaluate-speaking')) aiEvaluations += 1;
  });

  const ownerHeaders = { 'X-EasyBoost-Expected-Owner': username, Origin: baseUrl };
  const startedResponse = await context.request.post(`${baseUrl}/api/v1/ege-mocks/attempts`, {
    headers: { ...ownerHeaders, 'Idempotency-Key': crypto.randomUUID() },
    data: {
      formId: egeForm.id, formRevision: egeForm.revision,
      catalogFingerprint: egeForm.fingerprint,
    },
  });
  const started = await startedResponse.json();
  assert.equal(startedResponse.ok(), true, JSON.stringify(started));
  const writtenResponse = await context.request.post(
    `${baseUrl}/api/v1/ege-mocks/attempts/${started.attempt.id}/written/submit`,
    {
      headers: { ...ownerHeaders, 'Idempotency-Key': crypto.randomUUID() },
      data: { expectedRevision: started.attempt.revision },
    },
  );
  assert.equal(writtenResponse.ok(), true, await writtenResponse.text());

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  }, null, { timeout: 15_000 });
  await openEgeMock(page);
  await page.getByRole('button', { name: 'Перейти к устной части' }).press('Enter');
  try {
    await page.getByRole('button', { name: 'Проверить микрофон и материалы' }).press('Enter', { timeout: 8_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(async (attemptId) => ({
      active: document.querySelector('.screen.on')?.id,
      area: document.querySelector('#ege_mock_area')?.textContent,
      storage: Object.fromEntries(Object.entries(localStorage)),
      attempt: await fetch(`/api/v1/ege-mocks/attempts/${attemptId}`, {
        headers: { 'X-EasyBoost-Expected-Owner': 'ege-mock-oral-user' },
      }).then((response) => response.json()),
    }), started.attempt.id);
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}\n${output.join('').slice(-4_000)}`);
  }
  await page.getByRole('button', { name: 'Начать 17 минут' }).press('Enter');
  await page.getByRole('heading', { name: /Задание 39/u }).waitFor();
  assert.match(await page.locator('#ege_mock_oral_timer').innerText(), /^17 мин$/u);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);

  await context.setOffline(true);
  await page.getByRole('button', { name: 'Начать этап' }).press('Enter');
  await page.waitForFunction(() => document.querySelector('#ege_mock_area')
    ?.textContent?.includes('в очереди'));
  assert.match(await page.locator('#ege_mock_area').innerText(), /в очереди/iu);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr16.on').waitFor({ state: 'visible', timeout: 20_000 });
  const reopenOral = page.getByRole('button', { name: 'Перейти к устной части' });
  if (await reopenOral.count()) await reopenOral.click();
  try {
    await page.getByRole('heading', { name: /Задание 39/u }).waitFor({ timeout: 8_000 });
  } catch (error) {
    const local = await page.evaluate(async () => {
      const names = await caches.keys();
      const cacheEntries = {};
      for (const name of names.filter((value) => value.startsWith('easyboost-ege-mock-assets-v1-'))) {
        const cache = await caches.open(name);
        cacheEntries[name] = await Promise.all((await cache.keys()).map(async ({ url }) => {
          const response = await cache.match(url);
          const bytes = await response.clone().arrayBuffer();
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          return {
            url, status: response.status, contentType: response.headers.get('content-type'),
            sha256: Array.from(new Uint8Array(digest))
              .map((value) => value.toString(16).padStart(2, '0')).join(''),
          };
        }));
      }
      return {
        storage: Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.includes('ege-mock'))),
        cacheEntries,
      };
    });
    throw new Error(`${error.message}\n${await page.locator('#ege_mock_area').innerText()}\npageErrors=${JSON.stringify(pageErrors)}\n${JSON.stringify(local)}`);
  }
  assert.match(await page.locator('#ege_mock_area').innerText(), /в очереди/iu);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await context.setOffline(false);
  await page.waitForFunction(() => /ПОДГОТОВКА/u.test(document.querySelector('#ege_mock_area')?.textContent || ''), null, { timeout: 10_000 });
  assert.equal(await page.locator('[data-ege-action="oral-advance"]').count(), 0,
    'preparation cannot be completed before the authoritative deadline');
  assert.equal(await page.locator('[data-ege-action="oral-record"]').count(), 0,
    'capture begins automatically at the authoritative deadline');
  assert.equal(await page.locator('[data-ege-action="oral-stop"]').count(), 0,
    'capture cannot be stopped before the authoritative deadline');
  assert.equal(await page.locator('[data-ege-action="oral-complete"]').count(), 0,
    'a candidate cannot manually forge a completed recording');
  await page.waitForFunction(() => /на сервере/iu.test(
    document.querySelector('#ege_mock_area')?.textContent || '',
  ), null, { timeout: 10_000 });

  await page.waitForFunction(async () => (
    (await navigator.locks.query()).held
      .some(({ name }) => name.startsWith('easyboost-ege-mock-oral-recorder:'))
  ), null, { timeout: 5_000 });
  const primaryLocks = await page.evaluate(async () => await navigator.locks.query());
  const getsBeforePeer = oralAttemptGets;
  const peer = await context.newPage();
  const peerErrors = [];
  peer.on('pageerror', (error) => peerErrors.push(error.message));
  await peer.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const peerPrivacySheet = peer.locator('#privacySheet.open');
  try {
    await peerPrivacySheet.waitFor({ state: 'visible', timeout: 2_000 });
    await peer.getByRole('button', { name: 'Сохранить выбор' }).click();
    await peerPrivacySheet.waitFor({ state: 'hidden' });
  } catch {
    // Existing consent can legitimately keep the sheet closed in a peer tab.
  }
  await openEgeMock(peer);
  try {
    await peer.locator('#scr16.on').waitFor({ state: 'visible', timeout: 5_000 });
  } catch (error) {
    const peerState = await peer.evaluate(() => ({
      active: document.querySelector('.screen.on')?.id,
      body: document.body.innerText.slice(0, 1_000),
      egeDestination: document.querySelector('[data-destination="ege"]')?.outerHTML,
    }));
    throw new Error(`${error.message}\npeer=${JSON.stringify(peerState)}`);
  }
  const peerOralTransition = peer.getByRole('button', { name: 'Перейти к устной части' });
  if (await peerOralTransition.count()) {
    await peerOralTransition.press('Enter');
  }
  await peer.getByRole('heading', { name: /Задание 39/u }).waitFor();
  const heldRecorderLocks = await peer.evaluate(async () => (
    (await navigator.locks.query()).held
      .filter(({ name }) => name.startsWith('easyboost-ege-mock-oral-recorder:')).length
  ));
  assert.equal(heldRecorderLocks, 1,
    `two tabs share exactly one held microphone-owner lease; primary=${JSON.stringify(primaryLocks)}`);
  assert.equal(await peer.evaluate(() => globalThis.__egeOralRecorderStarts || 0), 0,
    'the observing tab cannot start a competing recorder');
  await peer.waitForTimeout(2_200);
  assert.ok(oralAttemptGets - getsBeforePeer <= 2,
    'storage adoption is bounded and cannot ping-pong GET plus localRevision writes');
  assert.deepEqual(peerErrors, []);
  await peer.close();

  const currentResponse = await context.request.get(
    `${baseUrl}/api/v1/ege-mocks/attempts/${started.attempt.id}`,
    { headers: ownerHeaders },
  );
  const currentBody = await currentResponse.json();
  assert.equal(currentResponse.ok(), true, JSON.stringify(currentBody));
  let fakeAttempt = structuredClone(currentBody.attempt);
  const responseCounts = new Map([[39, 1], [40, 4], [41, 5], [42, 1]]);
  const maxima = new Map([[39, 1], [40, 4], [41, 5], [42, 10]]);
  const jsonHeaders = () => ({
    'content-type': 'application/json',
    'x-easyboost-response-owner': username,
    date: new Date().toUTCString(),
  });
  const fulfill = (route, body) => route.fulfill({
    status: 200, headers: jsonHeaders(), body: JSON.stringify(body),
  });
  const stageDeadline = () => new Date(Date.now() + 80).toISOString();
  fakeAttempt.oralProgress = {
    ...fakeAttempt.oralProgress,
    phase: 'preparing', stageStartedAt: new Date().toISOString(),
    stageDeadlineAt: stageDeadline(), recordings: fakeAttempt.oralProgress?.recordings || {},
  };

  await page.route(`**/api/v1/ege-mocks/attempts/${started.attempt.id}**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET'
      && pathname.endsWith(`/api/v1/ege-mocks/attempts/${started.attempt.id}`)) {
      await fulfill(route, { attempt: fakeAttempt });
      return;
    }
    if (request.method() === 'POST' && pathname.endsWith('/oral/stage')) {
      const body = request.postDataJSON();
      const progress = fakeAttempt.oralProgress;
      const position = Number(progress.position);
      const responseNumber = Number(progress.responseNumber);
      if (body.action === 'advance') {
        const nextPhase = progress.phase === 'preparing' ? 'recording'
          : responseNumber === 1 ? 'preparing' : 'recording';
        fakeAttempt = {
          ...fakeAttempt, revision: fakeAttempt.revision + 1,
          oralProgress: {
            ...progress, phase: nextPhase, stageStartedAt: new Date().toISOString(),
            stageDeadlineAt: stageDeadline(),
          },
        };
      } else if (body.action === 'complete') {
        const recordings = {
          ...progress.recordings,
          [`${position}:${responseNumber}`]: {
            ...body.recording, position, taskType: position - 38, responseNumber,
          },
        };
        let nextPosition = position;
        let nextResponse = responseNumber + 1;
        if (nextResponse > responseCounts.get(position)) {
          nextPosition += 1;
          nextResponse = 1;
        }
        fakeAttempt = {
          ...fakeAttempt, revision: fakeAttempt.revision + 1,
          oralProgress: nextPosition > 42 ? {
            schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
            phase: 'ready_to_submit', stageStartedAt: null, stageDeadlineAt: null, recordings,
          } : {
            schemaVersion: 'ege-mock-oral-progress-v1', position: nextPosition,
            responseNumber: nextResponse, phase: 'ready', stageStartedAt: null,
            stageDeadlineAt: null, recordings,
          },
        };
      } else {
        await route.abort();
        return;
      }
      await fulfill(route, { applied: true, replayed: false, attempt: fakeAttempt });
      return;
    }
    if (request.method() === 'POST' && pathname.endsWith('/oral/submit')) {
      fakeAttempt = {
        ...fakeAttempt, revision: fakeAttempt.revision + 1, state: 'assessment_pending',
        oralSubmittedAt: new Date().toISOString(),
      };
      await fulfill(route, { applied: true, replayed: false, attempt: fakeAttempt });
      return;
    }
    await route.fallback();
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  const restoredPrivacySheet = page.locator('#privacySheet.open');
  try {
    await restoredPrivacySheet.waitFor({ state: 'visible', timeout: 2_000 });
    await page.getByRole('button', { name: 'Сохранить выбор' }).click();
    await restoredPrivacySheet.waitFor({ state: 'hidden' });
  } catch {
    // Existing consent can legitimately keep the sheet closed after reload.
  }
  if (!await page.locator('#scr16.on').count()) {
    await openEgeMock(page);
  }
  await page.locator('#scr16.on').waitFor({ state: 'visible', timeout: 20_000 });
  const reopenAccelerated = page.getByRole('button', { name: 'Перейти к устной части' });
  if (await reopenAccelerated.count()) await reopenAccelerated.click();
  await page.getByRole('heading', { name: /Задание 39/u }).waitFor();
  const visited = new Set();
  let task42ImageWidth = 0;
  for (let step = 0; step < 40; step += 1) {
    if (await page.getByRole('button', { name: 'Сдать устную часть' }).count()) break;
    const heading = await page.locator('.ege-mock__task h2').innerText();
    const match = heading.match(/Задание (\d+) · ответ (\d+)/u);
    if (match) {
      visited.add(`${match[1]}:${match[2]}`);
      const position = Number(match[1]);
      await page.setViewportSize({
        width: position <= 40 ? 320 : 1440,
        height: position <= 40 ? 720 : 900,
      });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const undersized = await page.locator('.ege-mock button:visible:not([disabled])').evaluateAll(
        (buttons) => buttons.filter((button) => {
          const box = button.getBoundingClientRect();
          return box.width < 44 || box.height < 44;
        }).length,
      );
      assert.equal(undersized, 0, 'oral controls retain a 44px target on mobile and desktop');
      if (position === 42) {
        const task42Image = page.locator('.ege-mock__oral-photos img');
        await task42Image.waitFor({ state: 'visible', timeout: 5_000 });
        task42ImageWidth = (await task42Image.boundingBox())?.width || 0;
      }
    }
    const advance = page.locator('[data-ege-action="oral-advance"]');
    if (await advance.count()) await advance.click();
    await page.waitForTimeout(1_050);
  }
  assert.deepEqual([...visited].sort(), [
    '39:1', '40:1', '40:2', '40:3', '40:4',
    '41:1', '41:2', '41:3', '41:4', '41:5', '42:1',
  ]);
  assert.ok(task42ImageWidth >= 240,
    `the verified composite remains readable instead of one half-grid cell; width=${task42ImageWidth}`);
  await page.getByRole('button', { name: 'Сдать устную часть' }).press('Enter');
  await page.getByRole('heading', { name: 'Устная часть сдана' }).waitFor();
  assert.equal(assessmentUploads.length, 0, 'safe restore and stage GET never call a paid provider');
  assert.equal(aiEvaluations, 0, 'safe restore and reconnect never call a semantic provider');

  await page.route('**/api/v1/speaking/full-sessions/*/pronunciation-assessment', async (route) => {
    assessmentUploads.push(route.request().headers()['idempotency-key']);
    await fulfill(route, {
      assessment: { status: 'success' },
      billing: { assessmentId: crypto.randomUUID(), billableSeconds: 1 },
    });
  });
  let evaluatedAttemptId = 8_000;
  await page.route('**/api/v1/ai/evaluate-speaking', async (route) => {
    evaluatedAttemptId += 1;
    await fulfill(route, {
      attemptId: evaluatedAttemptId,
      review: { status: 'scored' },
      assessment: { mode: 'experimental', scoreKind: 'approximate', methodicallyValidated: false },
    });
  });
  await page.route(`**/api/v1/speaking/full-sessions/${started.attempt.id}/evaluation`, async (route) => {
    fakeAttempt = {
      ...fakeAttempt,
      speakingAssessment: {
        status: 'completed', mode: 'experimental', scoreKind: 'approximate', retryAllowed: false,
        items: Object.fromEntries([...maxima].map(([position, maximum]) => [position, {
          position, status: 'scored', score: maximum, maximum,
        }])),
      },
    };
    await fulfill(route, { completed: true });
  });
  await page.getByRole('button', { name: 'Получить примерную автоматическую оценку' }).press('Enter');
  await page.getByText('Ориентировочная оценка готова.').waitFor({ timeout: 15_000 });
  assert.equal(assessmentUploads.length, 11, 'all 11 exact local recordings are explicitly uploaded once');
  assert.equal(aiEvaluations, 4, 'only the explicit action evaluates tasks 39–42');
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  assert.deepEqual(pageErrors, []);
  console.log('e2e: full EGE oral runner completed 11 responses, cross-tab ownership, reload and explicit approximate assessment');
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child) await stopProcess(child).catch(() => {});
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
}
