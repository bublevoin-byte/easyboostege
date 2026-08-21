import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, openEgeHub, openEgeMock,
  openLatestEgeResult, stopProcess, waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const username = 'ege-mock-release-user';
const jwtSecret = 'ege-mock-release-e2e-secret-32-characters';

function exactSequence(from, to) {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

async function postRealOralStage(page, { attemptId, owner, body }) {
  const response = await page.evaluate(async ({ candidateId, candidateOwner, candidateBody }) => {
    const result = await fetch(`/api/v1/ege-mocks/attempts/${candidateId}/oral/stage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': candidateBody.idempotencyKey,
        'X-EasyBoost-Expected-Owner': candidateOwner,
      },
      body: JSON.stringify(candidateBody.payload),
    });
    return { status: result.status, body: await result.json() };
  }, {
    candidateId: attemptId,
    candidateOwner: owner,
    candidateBody: {
      idempotencyKey: crypto.randomUUID(),
      payload: body,
    },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.applied, true);
  assert.equal(response.body.replayed, false);
  return response.body.attempt;
}

let browser;
let child;
let context;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-release-'));
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const testClockFile = path.join(temporaryDirectory, 'ege-mock-now.txt');
  const setAuthorityNow = async (value) => {
    const authorityNowMs = Number(value);
    assert.equal(Number.isFinite(authorityNowMs), true);
    await fs.writeFile(testClockFile, new Date(authorityNowMs).toISOString(), 'utf8');
  };
  await setAuthorityNow(Date.now());
  await fs.writeFile(dataFile, JSON.stringify({
    users: { [username]: { created: Date.now(), sub_until: Date.now() + 86_400_000 } },
    progress: { [username]: {} },
  }), 'utf8');
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const serverEnvironment = {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port), APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file', DATA_FILE: dataFile, JWT_SECRET: jwtSecret,
      TELEGRAM_BOT_TOKEN: '', ADMIN_TELEGRAM_ID: '', XAI_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false', ADAPTIVE_LEARNING_ENABLED: 'false',
      SPEAKING_PRONUNCIATION_ENABLED: 'false',
      EGE_MOCK_TEST_NOW_FILE: testClockFile,
  };
  const startLocalServer = async () => {
    const processChild = spawn(process.execPath, [serverPath], {
      cwd: projectDirectory, env: serverEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    processChild.stdout.on('data', (chunk) => output.push(chunk.toString()));
    processChild.stderr.on('data', (chunk) => output.push(chunk.toString()));
    try {
      await waitForReady(baseUrl, processChild, output);
      return processChild;
    } catch (error) {
      await stopProcess(processChild).catch(() => {});
      throw error;
    }
  };
  child = await startLocalServer();

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const harness = await createActiveSubscriptionPage(browser, {
    baseUrl, username, jwtSecret,
    contextOptions: { viewport: { width: 320, height: 720 }, reducedMotion: 'reduce' },
  });
  context = harness.context;
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
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['release-contour-audio'], { type: this.mimeType }) });
        this.onstop?.();
      }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });
  });
  const page = harness.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.waitForFunction(async () => {
    await navigator.serviceWorker.ready;
    return Boolean(navigator.serviceWorker.controller);
  }, null, { timeout: 15_000 });

  await openEgeHub(page);
  await page.waitForFunction(() => document.querySelectorAll('#ege-hub-sections > li').length === 5);
  assert.match(await page.locator('#ege-hub-full-mock').innerText(), /Полный пробный вариант/isu);
  await openEgeMock(page);
  await page.locator('#scr16.on .ege-mock__intro').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.locator('#scr16 button:visible').evaluateAll((buttons) => buttons
    .filter((button) => {
      const box = button.getBoundingClientRect();
      return box.width < 44 || box.height < 44;
    }).map((button) => button.textContent?.trim())), []);

  await page.getByRole('button', { name: 'Проверить готовность' }).press('Enter');
  await page.getByText('Техническая проверка завершена. Таймер ещё не запущен.').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Начать письменную часть' }).press('Enter');
  await page.getByRole('heading', { name: 'Задание 1', exact: true }).waitFor();
  assert.equal(await page.locator('#ege_mock_timer').getAttribute('role'), 'timer');
  assert.equal(await page.locator('#ege_mock_timer_notice').getAttribute('aria-live'), 'polite');

  const visitedWritten = new Set();
  for (const position of exactSequence(1, 19)) {
    await page.locator(`.ege-mock__review [data-ege-position="${position}"]`).press('Enter');
    await page.getByRole('heading', { name: `Задание ${position}`, exact: true }).waitFor();
    visitedWritten.add(position);
  }
  await page.locator('[data-ege-text]').fill('went online');
  await page.waitForTimeout(900);
  await context.setOffline(true);
  await page.locator('[data-ege-text]').fill('went offline');
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr16.on [data-ege-text]').waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(await page.locator('[data-ege-text]').inputValue(), 'went offline');
  assert.match(await page.locator('#ege_mock_save').innerText(), /в очереди/u);
  await context.setOffline(false);
  await page.waitForFunction(async ({ baseUrl: url, owner }) => {
    const response = await fetch(`${url}/api/v1/ege-mocks/attempts/current`, {
      headers: { 'X-EasyBoost-Expected-Owner': owner },
    });
    return response.ok && (await response.json()).attempt?.draft?.['19'] === 'went offline';
  }, { baseUrl, owner: username }, { timeout: 10_000 });

  for (const position of exactSequence(20, 36)) {
    await page.locator(`.ege-mock__review [data-ege-position="${position}"]`).press('Enter');
    await page.getByRole('heading', { name: `Задание ${position}`, exact: true }).waitFor();
    visitedWritten.add(position);
  }
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: /Завершить задания 1–36/u }).press('Enter');
  await page.getByRole('heading', { name: 'Задания 1–36 сохранены' }).waitFor({ timeout: 15_000 });
  await page.locator('[data-ege-action="continue-writing"]').press('Enter');
  await page.getByRole('heading', { name: 'Задание 37', exact: true }).waitFor();
  visitedWritten.add(37);
  const answer37 = exactSequence(1, 110).map((position) => `letter${position}`).join(' ');
  const answer38 = exactSequence(1, 210).map((position) => `report${position}`).join(' ');
  await page.locator('[data-ege-writing]').fill(answer37);
  await page.locator('.ege-mock__review [data-ege-position="38"]').press('Enter');
  await page.getByRole('heading', { name: 'Задание 38', exact: true }).waitFor();
  visitedWritten.add(38);
  await page.locator('[data-ege-writing]').fill(answer38);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-ege-action="complete-written"]').press('Enter');
  await page.getByRole('heading', { name: 'Задания 1–38 сданы' }).waitFor({ timeout: 20_000 });
  assert.deepEqual([...visitedWritten], exactSequence(1, 38));

  await page.getByRole('button', { name: 'Перейти к устной части' }).press('Enter');
  await page.getByRole('button', { name: 'Проверить микрофон и материалы' }).press('Enter');
  await page.getByRole('button', { name: 'Начать 17 минут' }).press('Enter');
  await page.getByRole('heading', { name: /Задание 39/u }).waitFor();
  const ownerHeaders = { 'X-EasyBoost-Expected-Owner': username };
  const currentResponse = await context.request.get(
    `${baseUrl}/api/v1/ege-mocks/attempts/current`, { headers: ownerHeaders },
  );
  const startedAttempt = (await currentResponse.json()).attempt;
  assert.equal(startedAttempt.state, 'oral_in_progress');
  let authoritativeAttempt = startedAttempt;
  const visitedOral = new Set();
  while (authoritativeAttempt.oralProgress.phase !== 'ready_to_submit') {
    const progress = authoritativeAttempt.oralProgress;
    if (progress.phase === 'ready') {
      const expectedHeading = `Задание ${progress.position} · ответ ${progress.responseNumber}`;
      await page.getByRole('heading', { name: expectedHeading, exact: true }).waitFor();
      visitedOral.add(`${progress.position}:${progress.responseNumber}`);
      const mobile = visitedOral.size % 2 === 1;
      await page.setViewportSize({ width: mobile ? 320 : 1440, height: mobile ? 720 : 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(await page.locator('.ege-mock button:visible:not([disabled])').evaluateAll((buttons) => (
        buttons.filter((button) => {
          const box = button.getBoundingClientRect();
          return box.width < 44 || box.height < 44;
        }).map((button) => button.textContent?.trim())
      )), []);
    }

    const action = progress.phase === 'recording' ? 'complete' : 'advance';
    if (progress.stageDeadlineAt) await setAuthorityNow(Date.parse(progress.stageDeadlineAt));
    const body = {
      action,
      expectedRevision: authoritativeAttempt.revision,
      position: progress.position,
      responseNumber: progress.responseNumber,
    };
    if (action === 'complete') {
      body.recording = {
        recordingId: crypto.randomUUID(),
        status: 'completed',
        durationSeconds: { 39: 90, 40: 20, 41: 40, 42: 180 }[progress.position],
        sha256: crypto.randomBytes(32).toString('hex'),
      };
    }
    authoritativeAttempt = await postRealOralStage(page, {
      attemptId: startedAttempt.id, owner: username, body,
    });

    if (action === 'complete') {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 15_000 });
      await openEgeMock(page);
      const reopenOral = page.getByRole('button', { name: 'Перейти к устной части' });
      if (await reopenOral.count()) await reopenOral.press('Enter');
      await page.locator('#scr16.on').waitFor({ state: 'visible', timeout: 20_000 });
    }
  }
  assert.deepEqual([...visitedOral].sort(), [
    '39:1', '40:1', '40:2', '40:3', '40:4',
    '41:1', '41:2', '41:3', '41:4', '41:5', '42:1',
  ]);

  try {
    await page.getByRole('button', { name: 'Сдать устную часть' }).waitFor({ timeout: 20_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(async (owner) => {
      const current = (await fetch('/api/v1/ege-mocks/attempts/current', {
        headers: { 'X-EasyBoost-Expected-Owner': owner },
      }).then((response) => response.json())).attempt;
      return {
        active: document.querySelector('.screen.on')?.id,
        area: document.querySelector('#ege_mock_area')?.textContent?.slice(0, 1_000),
        current: current ? {
          id: current.id, state: current.state, revision: current.revision,
          oralProgress: current.oralProgress ? {
            position: current.oralProgress.position,
            responseNumber: current.oralProgress.responseNumber,
            phase: current.oralProgress.phase,
          } : null,
        } : null,
      };
    }, username);
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}\n${output.join('').slice(-4_000)}`);
  }
  await page.getByRole('button', { name: 'Сдать устную часть' }).press('Enter');
  await page.getByRole('heading', { name: 'Устная часть сдана' }).waitFor({ timeout: 20_000 });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 10_000 });
  await openLatestEgeResult(page);
  const resultHeading = page.getByRole('heading', { name: /^\d+–\d+ из 82$/u });
  try {
    await resultHeading.waitFor({ timeout: 20_000 });
  } catch (error) {
    const diagnostic = await page.evaluate(async ({ owner, attemptId }) => {
      const [currentPayload, resultPayload] = await Promise.all([
        fetch('/api/v1/ege-mocks/attempts/current', {
          headers: { 'X-EasyBoost-Expected-Owner': owner },
        }).then((response) => response.json()),
        fetch(`/api/v1/ege-mocks/attempts/${attemptId}/result`, {
          headers: { 'X-EasyBoost-Expected-Owner': owner },
        }).then((response) => response.json()),
      ]);
      const current = currentPayload.attempt;
      return {
        active: document.querySelector('.screen.on')?.id,
        area: document.querySelector('#ege_mock_area')?.textContent?.slice(0, 1_000),
        current: current ? { id: current.id, state: current.state, revision: current.revision } : null,
        result: {
          available: resultPayload.available,
          state: resultPayload.state,
          attemptId: resultPayload.attemptId,
          primaryTotal: resultPayload.primaryTotal,
        },
      };
    }, { owner: username, attemptId: startedAttempt.id });
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}\n${output.join('').slice(-4_000)}`);
  }
  assert.equal(await page.locator('.ege-mock__result-review details').count(), 42);
  assert.equal(await page.locator('#ege_mock_result_title').evaluate((node) => node === document.activeElement), true);
  await page.setViewportSize({ width: 320, height: 720 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  const historyResponse = await context.request.get(
    `${baseUrl}/api/v1/ege-mocks/attempts/history`, { headers: ownerHeaders },
  );
  const history = await historyResponse.json();
  assert.equal(history.attempts.length, 1);
  assert.equal(history.baselineAttemptId, startedAttempt.id);
  assert.equal(history.attempts[0].id, startedAttempt.id);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 15_000 });
  await openLatestEgeResult(page);
  await resultHeading.waitFor({ timeout: 20_000 });
  const historyAfterReloadResponse = await context.request.get(
    `${baseUrl}/api/v1/ege-mocks/attempts/history`, { headers: ownerHeaders },
  );
  assert.equal(historyAfterReloadResponse.ok(), true);
  const historyAfterReload = await historyAfterReloadResponse.json();
  assert.equal(historyAfterReload.attempts.length, 1);
  assert.equal(historyAfterReload.baselineAttemptId, startedAttempt.id);
  assert.equal(historyAfterReload.attempts[0].id, startedAttempt.id);
  assert.deepEqual(pageErrors, []);
  console.log('EGE mock release E2E passed: one home-to-result attempt covered all 42 positions, offline restore, responsive a11y and duplicate-free result reload');
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child) await stopProcess(child).catch(() => {});
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
}
