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
const jwtSecret = 'speaking-task4-e2e-secret-32-characters';
const username = 'speaking-task4-e2e-user';
const viewportMatrix = [
  { width: 375, height: 667 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

function maximumSeconds(value) {
  return String(value || '').split(',').reduce((maximum, item) => {
    const duration = item.trim();
    const seconds = duration.endsWith('ms')
      ? Number.parseFloat(duration) / 1_000
      : Number.parseFloat(duration);
    return Math.max(maximum, Number.isFinite(seconds) ? seconds : 0);
  }, 0);
}

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-task4-e2e-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      [username]: {
        created: Date.now(),
        sub_until: Date.now() + 86_400_000,
        privacy_consent: {
          text_processing: true,
          voice_processing: false,
          policy_version: '2026-08-02-voice-v1',
          updated_at: Date.now(),
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
      ADAPTIVE_LEARNING_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  for (const viewport of viewportMatrix) {
    const harness = await createActiveSubscriptionPage(browser, {
      baseUrl,
      username,
      jwtSecret,
      contextOptions: { viewport, reducedMotion: 'reduce', serviceWorkers: 'block' },
    });
    const { context, page } = harness;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await context.addInitScript(() => {
      window.__e2eMicrophoneMode = 'success';
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
      class E2EMediaRecorder {
        static isTypeSupported(type) { return type === 'audio/webm'; }
        constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; }
        start() { this.state = 'recording'; }
        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob(['task4-e2e-audio'], { type: this.mimeType }) });
          this.onstop?.();
        }
      }
      Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: E2EMediaRecorder });
      Object.defineProperty(window, 'Audio', {
        configurable: true,
        value: class { async play() {} pause() {} },
      });
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    await openPracticeSkill(page, 'speaking');
    await page.locator('#scr9.on').waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByRole('button', { name: /Монолог по фото/ }).press('Enter');

    const photo = page.locator('#s9_area img[src^="/assets/speaking/task4-v1/"]');
    await photo.waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(() => {
      const image = document.querySelector('#s9_area img[src^="/assets/speaking/task4-v1/"]');
      return Boolean(image?.complete && image.naturalWidth > 0);
    });
    assert.match(await photo.getAttribute('alt'), /^Two photographs for the project/u);
    assert.doesNotMatch(await photo.getAttribute('alt'), /\b(?:answer|better|best|prefer|advantage)\b/iu);
    assert.equal(await page.getByRole('button', { name: 'Другой вариант' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /Шпаргалка/ }).count(), 0);
    assert.equal(await page.locator('#s9_area').getByText(/Образец ответа|транскрипт/iu).count(), 0);
    assert.equal(await page.locator('#s9_area').getByText(/I have found two photos|That is all I wanted to say/iu).count(), 0);

    const microphone = page.getByRole('button', { name: 'Проверить микрофон' });
    await microphone.focus();
    const focusStyle = await microphone.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        focusVisible: element.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    assert.equal(focusStyle.focusVisible, true);
    assert.notEqual(focusStyle.outlineStyle, 'none');
    assert.ok(focusStyle.outlineWidth >= 3);
    await microphone.press('Enter');
    await page.getByText(/Микрофон готов/).waitFor({ state: 'visible', timeout: 5_000 });
    const preparation = page.getByRole('button', { name: 'Начать подготовку' });
    await preparation.focus();
    await preparation.press('Enter');
    await page.getByRole('button', { name: 'Готово — к записи' }).waitFor({ state: 'visible' });

    const layout = await page.evaluate(() => {
      const image = document.querySelector('#s9_area img');
      const imageRect = image.getBoundingClientRect();
      const controls = [...document.querySelectorAll('#s9_area button')].map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
      const animated = [...document.querySelectorAll('#s9_area *')].map((element) => {
        const style = getComputedStyle(element);
        return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration };
      });
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        imageLeft: imageRect.left,
        imageRight: imageRect.right,
        controls,
        animated,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      };
    });
    assert.ok(layout.documentWidth <= layout.viewportWidth);
    assert.ok(layout.imageLeft >= -0.5 && layout.imageRight <= layout.viewportWidth + 0.5);
    assert.equal(layout.reducedMotion, true);
    assert.deepEqual(layout.controls.filter((item) => item.width < 44 || item.height < 44), []);
    assert.equal(layout.animated.every((item) => (
      maximumSeconds(item.animationDuration) <= 0.001
        && maximumSeconds(item.transitionDuration) <= 0.001
    )), true);

    await page.getByRole('button', { name: 'Готово — к записи' }).press('Enter');
    await page.getByRole('button', { name: 'Стоп — закончить запись' }).press('Enter');
    await page.getByText('Монолог записан').waitFor({ state: 'visible', timeout: 5_000 });
    await page.getByRole('button', { name: '▶ Послушать монолог' }).press('Enter');
    await page.getByRole('button', { name: 'Нормально' }).press('Enter');
    await page.getByText('Тренировка задания 4 завершена').waitFor({ state: 'visible', timeout: 5_000 });
    const assessmentContrast = await page.getByRole('button', {
      name: '✨ Оценить по критериям ЕГЭ',
    }).evaluate((button) => {
      const channels = (value) => (value.match(/\d+(?:\.\d+)?/gu) || []).slice(0, 3).map(Number);
      const luminance = (rgb) => {
        const linear = rgb.map((value) => {
          const srgb = value / 255;
          return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const style = getComputedStyle(button);
      const foreground = luminance(channels(style.color));
      return [...style.backgroundImage.matchAll(/rgb\(([^)]+)\)/gu)].map((match) => {
        const background = luminance(channels(match[1]));
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      });
    });
    assert.equal(assessmentContrast.length, 2);
    assert.ok(
      assessmentContrast.every((ratio) => ratio >= 4.5),
      `individual assessment contrast ratios: ${assessmentContrast.join(', ')}`,
    );
    assert.deepEqual(pageErrors, []);
    await context.close();
    console.log(`speaking task 4 e2e passed at ${viewport.width}px with reduced motion`);
  }
} finally {
  await browser?.close().catch(() => {});
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
