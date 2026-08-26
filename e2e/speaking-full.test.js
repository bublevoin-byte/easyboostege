import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, openPracticeSkill, stopProcess, waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const jwtSecret = 'speaking-full-e2e-secret-32-characters';
const username = 'speaking-full-e2e-user';
const viewports = [{ width: 375, height: 667 }, { width: 1440, height: 900 }];

async function openSpeaking(page) {
  await openPracticeSkill(page, 'speaking');
  await page.locator('#scr9.on').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: /Экзамен · устная часть/u }).press('Enter');
}

async function recordCurrentResponse(page) {
  const prepare = page.getByRole('button', { name: 'Начать подготовку' });
  const ready = page.getByRole('button', { name: 'Готово — к записи' });
  const record = page.getByRole('button', { name: 'Начать запись', exact: true });
  if (await prepare.count()) {
    await prepare.press('Enter');
    await ready.waitFor({ state: 'visible', timeout: 5_000 });
    await ready.press('Enter');
  } else if (await ready.count()) {
    await ready.press('Enter');
  } else {
    await record.waitFor({ state: 'visible', timeout: 5_000 });
    await record.press('Enter');
  }
  const stop = page.getByRole('button', { name: 'Стоп — закончить запись' });
  await stop.waitFor({ state: 'visible', timeout: 5_000 }).catch(async () => {
    throw new Error(`recording did not start: ${await page.locator('#s9_area').innerText()}`);
  });
  await stop.press('Enter');
  const save = page.getByRole('button', { name: 'Сохранить ответ' });
  await save.waitFor({ state: 'visible', timeout: 5_000 });
  await save.press('Enter');
  await save.waitFor({ state: 'hidden', timeout: 5_000 });
}

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-full-e2e-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      [username]: {
        created: Date.now(), sub_until: Date.now() + 86_400_000,
        privacy_consent: {
          text_processing: true, voice_processing: true,
          policy_version: '2026-08-26-vk-id-v1', updated_at: Date.now(),
        },
      },
    },
    progress: { [username]: {} },
    speaking_accent_profiles: {
      [username]: {
        username, locale: 'en-GB', revision: 1, source: 'manual',
        effective_at: '2026-08-06T00:00:00.000Z', calibration_used: false,
      },
    },
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

  for (const viewport of viewports) {
    const { context, page } = await createActiveSubscriptionPage(browser, {
      baseUrl, username, jwtSecret,
      contextOptions: { viewport, reducedMotion: 'reduce', serviceWorkers: 'block' },
    });
    const pageErrors = [];
    const fullRequests = [];
    const assessmentUploads = [];
    const evaluationRequests = [];
    const task3RequestOrder = [];
    let holdNextTts = false;
    let releaseHeldTts = null;
    let holdNextStage = false;
    let releaseHeldStage = null;
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/speaking/full-sessions')) {
        fullRequests.push({ method: request.method(), body: request.postData() || '' });
      }
      if (request.url().includes('/api/v1/tts?')) task3RequestOrder.push('tts');
      if (request.url().endsWith('/stage') && request.method() === 'POST') task3RequestOrder.push('stage');
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
          return {
            fftSize: 512,
            getByteTimeDomainData(values) { values.fill(132); },
          };
        }
        async decodeAudioData() {
          const samples = new Float32Array(16_000).fill(0.04);
          return {
            numberOfChannels: 1,
            length: samples.length,
            sampleRate: 16_000,
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
          this.state = 'recording';
          window.__fullSpeakingRecorderStarts = (window.__fullSpeakingRecorderStarts || 0) + 1;
        }
        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob(['full-e2e-local-audio'], { type: this.mimeType }) });
          this.onstop?.();
        }
      }
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });
      Object.defineProperty(window, 'Audio', {
        configurable: true, value: class {
          constructor(src) { this.src = src; }
          async play() {
            window.__fullSpeakingAudioPlays = (window.__fullSpeakingAudioPlays || 0) + 1;
            queueMicrotask(() => this.onended?.());
          }
          pause() {}
        },
      });
    });
    await page.route('**/api/v1/tts?**', async (route) => {
      if (holdNextTts) await new Promise((resolve) => { releaseHeldTts = resolve; });
      await route.fulfill({
        status: 200, contentType: 'audio/mpeg', body: 'fake-local-task3-question',
      });
    });
    await page.route('**/api/v1/speaking/full-sessions/*/stage', async (route) => {
      if (holdNextStage) await new Promise((resolve) => { releaseHeldStage = resolve; });
      await route.continue();
    });
    await page.route('**/api/v1/speaking/pronunciation-assessments/status', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provider: { available: true }, quota: { remainingSeconds: 3_600 } }),
    }));
    await page.route('**/api/v1/speaking/full-sessions/*/pronunciation-assessment', async (route) => {
      const request = route.request();
      const headers = request.headers();
      assessmentUploads.push({
        taskType: Number(headers['x-speaking-task']),
        itemNumber: headers['x-speaking-item'] ? Number(headers['x-speaking-item']) : null,
        contentType: headers['content-type'],
        bodyBytes: request.postDataBuffer()?.byteLength || 0,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          assessment: { status: 'success' },
          billing: { assessmentId: `fake-${assessmentUploads.length}` },
        }),
      });
    });
    await page.route('**/api/v1/ai/evaluate-speaking', async (route) => {
      const request = route.request();
      const body = request.postDataJSON();
      evaluationRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ attemptId: 700 + Number(body.taskType) }),
      });
    });
    await page.route('**/api/v1/speaking/full-sessions/*/evaluation', async (route) => {
      const body = route.request().postDataJSON();
      assert.deepEqual(body.attemptIds, [701, 702, 704]);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'submitted',
          earnedScore: 12,
          maximumScore: 20,
          taskResults: [
            { taskType: 1, earnedScore: 1, maximumScore: 1, recordingStatus: 'completed', recordingQuality: 'good', usedSeconds: 1 },
            { taskType: 2, earnedScore: 3, maximumScore: 4, recordingStatus: 'completed', recordingQuality: 'good', usedSeconds: 4 },
            { taskType: 3, earnedScore: 0, maximumScore: 5, recordingStatus: 'skipped', recordingQuality: 'unavailable', usedSeconds: 4 },
            { taskType: 4, earnedScore: 8, maximumScore: 10, recordingStatus: 'completed', recordingQuality: 'acceptable', usedSeconds: 1 },
          ],
          assessment: {
            available: true,
            status: 'scored',
            scoreKind: 'approximate',
            methodicallyValidated: false,
            warning: 'Автоматическая тренировочная оценка: результат примерный.',
          },
          improvementPlan: { available: true, items: ['Повтори связки и проверь грамматику.'] },
        }),
      });
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.locator('#scr1.on').waitFor({ state: 'visible' });
    await openSpeaking(page);
    await page.getByRole('button', { name: /(?:Начать|Продолжить) экзамен/u }).press('Enter');
    await page.getByRole('button', { name: 'Проверить микрофон' }).press('Enter');
    await page.getByRole('button', { name: '✓ Микрофон готов' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Начать подготовку' }).press('Enter');
    await page.waitForTimeout(900);

    // The server-owned preparation deadline and exact current response survive a real reload.
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#scr1.on').waitFor({ state: 'visible' });
    await openSpeaking(page);
    await page.getByRole('button', { name: /Продолжить экзамен/u }).press('Enter');
    await page.getByRole('button', { name: 'Проверить микрофон' }).press('Enter');
    await page.getByRole('button', { name: '✓ Микрофон готов' }).waitFor({ state: 'visible' });

    for (let response = 0; response < 11; response += 1) {
      if (response === 5) {
        task3RequestOrder.length = 0;
        assert.equal(await page.getByRole('button', { name: 'Повторить вопрос' }).count(), 0);
        await page.getByText(/Вопрос прозвучит после запуска/u).waitFor({ state: 'visible' });
        holdNextTts = true;
        holdNextStage = true;
        const recorderStarts = await page.evaluate(() => window.__fullSpeakingRecorderStarts || 0);
        const audioPlays = await page.evaluate(() => window.__fullSpeakingAudioPlays || 0);
        const ttsRequest = page.waitForRequest((request) => request.url().includes('/api/v1/tts?'));
        await page.getByRole('button', { name: 'Начать запись', exact: true }).press('Enter');
        await ttsRequest;
        const stageRequest = page.waitForRequest((request) => request.url().includes('/api/v1/speaking/full-sessions/') && request.url().endsWith('/stage'));
        const skip = page.getByRole('button', { name: 'Пропустить ответ' }).press('Enter');
        await stageRequest;
        holdNextTts = false;
        releaseHeldTts?.();
        releaseHeldTts = null;
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => window.__fullSpeakingRecorderStarts || 0), recorderStarts);
        assert.equal(await page.evaluate(() => window.__fullSpeakingAudioPlays || 0), audioPlays);
        holdNextStage = false;
        releaseHeldStage?.();
        releaseHeldStage = null;
        await skip;
        await page.getByText(/Вопрос прозвучит после запуска/u).waitFor({ state: 'visible' });
        continue;
      }
      if (response === 6) task3RequestOrder.length = 0;
      if (response === 10) {
        const photo = page.locator('#s9_area img[src^="/assets/speaking/task4-v1/"]');
        await photo.waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForFunction(() => {
          const image = document.querySelector('#s9_area img[src^="/assets/speaking/task4-v1/"]');
          return Boolean(image?.complete && image.naturalWidth > 0);
        });
        assert.match(await photo.getAttribute('alt'), /^Two photographs for the project/u);
      }
      await recordCurrentResponse(page);
      if (response === 6) {
        assert.ok(task3RequestOrder.indexOf('tts') >= 0);
        assert.ok(task3RequestOrder.indexOf('stage') > task3RequestOrder.indexOf('tts'));
      }
    }
    await page.getByRole('button', { name: 'Сдать устную часть' }).press('Enter');
    await page.getByText('Устная часть сдана').waitFor({ state: 'visible' });
    await page.getByText('Примерная автоматическая оценка запускается отдельно').waitFor({ state: 'visible' });
    assert.equal(await page.getByText(/— \/ \d+ ·/u).count(), 4);
    await page.getByText(/До отправки:/u).waitFor({ state: 'visible' });
    await page.getByText(/Azure Speech/u).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Получить примерную автоматическую оценку' }).press('Enter');
    await page.getByText('Примерный результат: 12 из 20').waitFor({ state: 'visible' });
    await page.getByText('Повтори связки и проверь грамматику.').waitFor({ state: 'visible' });
    assert.deepEqual(assessmentUploads.map((item) => item.taskType), [1, 2, 2, 2, 2, 4]);
    assert.equal(assessmentUploads.every((item) => item.contentType === 'audio/wav' && item.bodyBytes > 44), true);
    assert.deepEqual(evaluationRequests.map((item) => [item.taskType, item.sessionMode]), [
      [1, 'full_section'], [2, 'full_section'], [4, 'full_section'],
    ]);
    const audioPlaysBefore = await page.evaluate(() => window.__fullSpeakingAudioPlays || 0);
    await page.getByRole('button', { name: /Ответ 1/u }).first().press('Enter');
    await page.waitForFunction((before) => (window.__fullSpeakingAudioPlays || 0) > before, audioPlaysBefore);
    assert.equal(await page.locator('#s9_area').getByText(/\b12\s*(?:из|\/)\s*20\b/u).count(), 1);
    assert.equal(await page.locator('#s9_area').getByText(/образец ответа|расшифровк|критерии оценки/iu).count(), 0);

    const layout = await page.evaluate(() => {
      const luminance = (channels) => {
        const linear = channels.map((value) => {
          const srgb = value / 255;
          return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const rgbChannels = (value) => (value.match(/\d+(?:\.\d+)?/gu) || [])
        .slice(0, 3).map(Number);
      const contrast = (first, second) => {
        const firstLum = luminance(first);
        const secondLum = luminance(second);
        return (Math.max(firstLum, secondLum) + 0.05) / (Math.min(firstLum, secondLum) + 0.05);
      };
      const primaryContrast = [...document.querySelectorAll('#s9_area button')]
        .filter((button) => getComputedStyle(button).backgroundImage.includes('linear-gradient'))
        .flatMap((button) => {
          const style = getComputedStyle(button);
          const text = rgbChannels(style.color);
          const stops = [...style.backgroundImage.matchAll(/rgb\(([^)]+)\)/gu)]
            .map((match) => rgbChannels(match[1]));
          return stops.map((stop) => contrast(text, stop));
        });
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        undersized: [...document.querySelectorAll('#s9_area button')].filter((button) => {
          const bounds = button.getBoundingClientRect();
          return bounds.width < 44 || bounds.height < 44;
        }).length,
        primaryContrast,
      };
    });
    assert.ok(layout.documentWidth <= layout.viewportWidth);
    assert.equal(layout.undersized, 0);
    assert.ok(layout.primaryContrast.length > 0);
    assert.ok(
      layout.primaryContrast.every((ratio) => ratio >= 4.5),
      `primary button contrast ratios: ${layout.primaryContrast.join(', ')}`,
    );
    assert.deepEqual(pageErrors, []);
    assert.equal(fullRequests.length >= 28, true);
    assert.equal(fullRequests.some((request) => /full-e2e-local-audio|blob:|transcript|audioBytes/iu.test(request.body)), false);
    assert.equal(fullRequests.filter((request) => request.body.includes('responseStatus')).length, 11);
    await context.close();
    console.log(`full speaking e2e passed at ${viewport.width}px`);
  }
} finally {
  await browser?.close().catch(() => {});
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
