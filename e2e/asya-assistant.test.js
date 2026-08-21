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
const username = 'asya-assistant-user';
const jwtSecret = 'asya-assistant-e2e-secret-32-characters';

let browser;
let child;
let context;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'asya-assistant-'));
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: { [username]: { created: Date.now(), sub_until: Date.now() + 86_400_000 } },
    progress: { [username]: {} },
  }), 'utf8');
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
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
    contextOptions: {
      viewport: { width: 320, height: 720 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    },
  });
  context = harness.context;
  const page = harness.page;
  const pageErrors = [];
  const paidBoundaryCalls = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (/\/api\/v1\/voice-tutor\/|x\.ai|api\.x\.ai/iu.test(request.url())) {
      paidBoundaryCalls.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('websocket', (socket) => paidBoundaryCalls.push(`WS ${socket.url()}`));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
  const privacySheet = page.locator('#privacySheet.open');
  if (await privacySheet.count()) await privacySheet.locator('#privacyClose').press('Enter');

  const launcher = page.getByRole('button', { name: 'Открыть Асю' });
  await launcher.press('Enter');
  const assistant = page.locator('#asya-assistant');
  await assistant.waitFor({ state: 'visible' });
  assert.equal(await assistant.getAttribute('role'), 'dialog');
  assert.equal(await assistant.locator('#asya-state').getAttribute('data-state'), 'off');
  const disclosure = await assistant.innerText();
  assert.match(disclosure, /только в открытом приложении.*не слушает устройство в фоне/su);
  assert.match(disclosure, /аудио никуда не передаётся.*голос передаётся внешнему AI-провайдеру/su);
  assert.match(disclosure, /полный transcript не сохраняются/u);
  assert.equal(await assistant.locator('#asya-microphone').isDisabled(), true);

  await assistant.locator('#asya-disclosure').check();
  await assistant.locator('#asya-microphone').press('Enter');
  await assistant.locator('#asya-state[data-state="error"]').waitFor();
  assert.match(await assistant.locator('#asya-state').innerText(), /после проверенной ошибки/u);
  assert.deepEqual(paidBoundaryCalls, []);

  const input = assistant.locator('#asya-input');
  await input.fill('Алиса, помоги');
  await input.press('Enter');
  assert.match(await assistant.locator('#asya-reply').innerText(), /должно начинаться с «Ася»/u);
  await input.fill('Ася, как открыть практику?');
  await input.press('Enter');
  await assistant.locator('#asya-state[data-state="listening"]').waitFor();
  assert.match(await assistant.locator('#asya-state').innerText(), /имя повторять не нужно/iu);
  assert.match(await assistant.locator('#asya-reply').innerText(), /Сегодня, Практика, ЕГЭ, Прогресс и Профиль/u);
  await input.fill('Как вернуться?');
  await input.press('Enter');
  assert.match(await assistant.locator('#asya-reply').innerText(), /кнопка возврата/u);

  await assistant.getByRole('button', { name: 'Завершить разговор', exact: true }).press('Enter');
  await assistant.waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    window.__asyaBridgeStarts = 0;
    const screen = document.getElementById('scr9');
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'voiceTutorTrigger';
    trigger.dataset.asyaE2eTrigger = 'true';
    trigger.textContent = 'Разобрать проверенную ошибку';
    trigger.addEventListener('click', () => {
      window.__asyaBridgeStarts += 1;
      let sheet = document.getElementById('voiceTutorSheet');
      if (!sheet) {
        sheet = document.createElement('div');
        sheet.id = 'voiceTutorSheet';
        sheet.setAttribute('role', 'dialog');
        sheet.innerHTML = '<button id="voiceTutorClose" type="button">Закрыть голосовой разбор</button>';
        document.body.append(sheet);
      }
      sheet.classList.add('open');
      sheet.style.display = 'block';
      sheet.querySelector('#voiceTutorClose').focus();
    });
    screen.append(trigger);
    window.tab('scr9');
  });
  await page.locator('#scr9.on').waitFor({ state: 'visible' });
  await launcher.press('Enter');
  await assistant.waitFor({ state: 'visible' });
  if (!await assistant.locator('#asya-disclosure').isChecked()) await assistant.locator('#asya-disclosure').check();
  await assistant.locator('#asya-microphone').press('Enter');
  await assistant.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__asyaBridgeStarts), 1);
  assert.equal(await page.locator('#voiceTutorSheet').getAttribute('class'), 'open');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'voiceTutorClose');
  assert.deepEqual(paidBoundaryCalls, []);

  await page.evaluate(() => {
    const sheet = document.getElementById('voiceTutorSheet');
    sheet.classList.remove('open');
    sheet.style.removeProperty('display');
    document.getElementById('scr16').append(document.querySelector('[data-asya-e2e-trigger]'));
  });
  await page.evaluate(() => window.tab('scr16'));
  await page.locator('#scr16.on').waitFor({ state: 'visible' });
  await launcher.press('Enter');
  await assistant.waitFor({ state: 'visible' });
  assert.match(await assistant.locator('#asya-context').innerText(), /Строгий режим.*Подсказок к ответам нет/su);
  await assistant.locator('#asya-microphone').press('Enter');
  await assistant.locator('#asya-state[data-state="error"]').waitFor();
  assert.equal(await page.evaluate(() => window.__asyaBridgeStarts), 1);
  await assistant.locator('#asya-input').fill('Ася, какой здесь правильный ответ?');
  await assistant.locator('#asya-input').press('Enter');
  assert.match(await assistant.locator('#asya-reply').innerText(), /не подсказывает ответы.*таймером, навигацией/su);
  assert.deepEqual(paidBoundaryCalls, []);

  await page.evaluate(() => window.tab('scr1'));
  await assistant.waitFor({ state: 'hidden' });
  await launcher.press('Enter');
  await assistant.locator('#asya-input').fill('Продолжим без имени');
  await assistant.locator('#asya-input').press('Enter');
  assert.match(await assistant.locator('#asya-reply').innerText(), /начинаться с «Ася»/u);

  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 720 : 900 });
    const contour = await page.evaluate(() => ({
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      frameOverflow: document.getElementById('frame').scrollWidth > document.getElementById('frame').clientWidth,
      shortControls: [...document.querySelectorAll('#asya-assistant button:not([disabled]), #asya-assistant input:not([type="checkbox"])')]
        .filter((control) => control.offsetParent !== null && control.getBoundingClientRect().height < 44)
        .map((control) => control.id || control.textContent.trim()),
      checkboxTarget: document.querySelector('.asya-assistant__consent')?.getBoundingClientRect().height >= 44,
    }));
    assert.deepEqual(contour, {
      documentOverflow: false, frameOverflow: false, shortControls: [], checkboxTarget: true,
    });
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(paidBoundaryCalls, []);
  console.log('Aisy Asya Chromium E2E passed: bounded wake, strict help refusal, keyboard fallback and zero paid calls');
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
