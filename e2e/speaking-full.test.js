import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, stopProcess, waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const jwtSecret = 'speaking-full-e2e-secret-32-characters';
const username = 'speaking-full-e2e-user';
const viewports = [{ width: 375, height: 667 }, { width: 1440, height: 900 }];

async function openSpeaking(page) {
  await page.getByRole('button', { name: 'Говорение', exact: true }).press('Enter');
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
          text_processing: true, voice_processing: false,
          policy_version: '2026-08-02-voice-v1', updated_at: Date.now(),
        },
      },
    },
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
      Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
      Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
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

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.locator('#scr1.on').waitFor({ state: 'visible' });
    await openSpeaking(page);
    await page.getByRole('button', { name: /(?:Начать|Продолжить) экзамен/u }).press('Enter');
    await page.getByRole('button', { name: 'Проверить микрофон' }).press('Enter');
    await page.getByRole('button', { name: 'Начать подготовку' }).press('Enter');
    await page.waitForTimeout(900);

    // The server-owned preparation deadline and exact current response survive a real reload.
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#scr1.on').waitFor({ state: 'visible' });
    await openSpeaking(page);
    await page.getByRole('button', { name: /Продолжить экзамен/u }).press('Enter');
    await page.getByRole('button', { name: 'Проверить микрофон' }).press('Enter');

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
    await page.getByText('Максимум: 20 баллов').waitFor({ state: 'visible' });
    await page.getByText('Оценка пока недоступна').waitFor({ state: 'visible' });
    assert.equal(await page.getByText(/\d+ сек\. · максимум/u).count(), 4);
    await page.getByText(/План улучшения пока недоступен/u).waitFor({ state: 'visible' });
    const audioPlaysBefore = await page.evaluate(() => window.__fullSpeakingAudioPlays || 0);
    await page.getByRole('button', { name: /Ответ 1/u }).first().press('Enter');
    await page.waitForFunction((before) => (window.__fullSpeakingAudioPlays || 0) > before, audioPlaysBefore);
    assert.equal(await page.locator('#s9_area').getByText(/\b\d+\s*(?:из|\/)\s*20\b/u).count(), 0);
    assert.equal(await page.locator('#s9_area').getByText(/образец ответа|расшифровк|критерии оценки/iu).count(), 0);

    const layout = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      undersized: [...document.querySelectorAll('#s9_area button')].filter((button) => {
        const bounds = button.getBoundingClientRect();
        return bounds.width < 44 || bounds.height < 44;
      }).length,
    }));
    assert.ok(layout.documentWidth <= layout.viewportWidth);
    assert.equal(layout.undersized, 0);
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
