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
const username = 'aisy-asya-paper-user';
const jwtSecret = 'aisy-asya-paper-e2e-secret-32-characters';

function maximumSeconds(value) {
  return String(value || '').split(',').reduce((maximum, item) => {
    const duration = item.trim();
    const seconds = duration.endsWith('ms')
      ? Number.parseFloat(duration) / 1_000
      : Number.parseFloat(duration);
    return Math.max(maximum, Number.isFinite(seconds) ? seconds : 0);
  }, 0);
}

async function asyaMetrics(page) {
  return page.evaluate(() => {
    const rect = (element) => element.getBoundingClientRect();
    const frame = document.getElementById('frame');
    const launcher = document.getElementById('asya-launcher');
    const assistant = document.getElementById('asya-assistant');
    const panel = assistant.querySelector('.asya-assistant__panel');
    const microphone = document.getElementById('asya-microphone');
    const affordance = getComputedStyle(microphone, '::after');
    const controls = [...assistant.querySelectorAll('button,input:not([type="checkbox"])')]
      .filter((control) => !control.disabled && control.offsetParent !== null)
      .map((control) => {
        const bounds = rect(control);
        return {
          label: control.getAttribute('aria-label') || control.textContent.trim(),
          width: bounds.width,
          height: bounds.height,
        };
      });
    const frameRect = rect(frame);
    const panelRect = rect(panel);
    const microphoneRect = rect(microphone);
    const panelStyle = getComputedStyle(panel);
    const microphoneStyle = getComputedStyle(microphone);
    const launcherStyle = getComputedStyle(launcher);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      frame: { left: frameRect.left, right: frameRect.right, width: frameRect.width },
      panel: {
        left: panelRect.left,
        right: panelRect.right,
        bottom: panelRect.bottom,
        width: panelRect.width,
        maxHeight: panelStyle.maxHeight,
        background: panelStyle.backgroundColor,
        animationDuration: panelStyle.animationDuration,
      },
      launcher: {
        parent: launcher.parentElement?.id || '',
        width: rect(launcher).width,
        height: rect(launcher).height,
        color: launcherStyle.color,
        accent: launcherStyle.getPropertyValue('--asya-semantic-accent').trim(),
        transitionDuration: launcherStyle.transitionDuration,
      },
      microphone: {
        width: microphoneRect.width,
        height: microphoneRect.height,
        radius: microphoneStyle.borderRadius,
        paddingLeft: microphoneStyle.paddingLeft,
        paddingRight: microphoneStyle.paddingRight,
        affordanceWidth: affordance.width,
        affordanceHeight: affordance.height,
      },
      consentTargetHeight: rect(assistant.querySelector('.asya-assistant__consent')).height,
      theme: {
        root: document.documentElement.dataset.theme,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        panel: panelStyle.colorScheme,
      },
      controls,
    };
  });
}

function assertAsyaMetrics(metrics, label) {
  assert.ok(metrics.document.width <= metrics.viewport.width, `${label}: document overflow`);
  assert.ok(metrics.document.height <= metrics.viewport.height, `${label}: document leaves viewport`);
  assert.ok(metrics.frame.width <= 390.5, `${label}: learner shell is not a portrait-phone canvas`);
  assert.ok(Math.abs(metrics.frame.left - (metrics.viewport.width - metrics.frame.width) / 2) <= 1,
    `${label}: learner shell is not centered`);
  assert.ok(Math.abs(metrics.panel.left - metrics.frame.left) <= 1 && Math.abs(metrics.panel.right - metrics.frame.right) <= 1,
    `${label}: Asya sheet leaves the phone canvas`);
  assert.ok(metrics.panel.bottom <= metrics.viewport.height + 1, `${label}: Asya sheet leaves the viewport`);
  assert.notEqual(metrics.panel.background, 'rgba(0, 0, 0, 0)', `${label}: Paper surface is transparent`);
  assert.equal(metrics.launcher.parent, 'frame', `${label}: Asya became a navigation item`);
  assert.ok(metrics.launcher.width >= 44 && metrics.launcher.height >= 44, `${label}: launcher target is undersized`);
  assert.ok(metrics.launcher.accent, `${label}: bounded Asya accent token is missing`);
  assert.equal(Math.round(metrics.microphone.height), 58, `${label}: canonical CTA height`);
  assert.equal(Math.round(Number.parseFloat(metrics.microphone.radius)), 28, `${label}: canonical CTA radius`);
  assert.equal(Math.round(Number.parseFloat(metrics.microphone.paddingLeft)), 26, `${label}: canonical CTA left padding`);
  assert.equal(Math.round(Number.parseFloat(metrics.microphone.paddingRight)), 10, `${label}: canonical CTA right padding`);
  assert.equal(Math.round(Number.parseFloat(metrics.microphone.affordanceWidth)), 38, `${label}: canonical CTA affordance width`);
  assert.equal(Math.round(Number.parseFloat(metrics.microphone.affordanceHeight)), 38, `${label}: canonical CTA affordance height`);
  assert.ok(metrics.consentTargetHeight >= 44, `${label}: consent target is undersized`);
  assert.deepEqual(metrics.controls.filter((control) => control.width < 44 || control.height < 44), [],
    `${label}: undersized interactive control`);
}

let browser;
let child;
let context;
let temporaryDirectory;

try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-asya-paper-'));
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const now = Date.now();
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      [username]: {
        created: now,
        sub_until: now + 86_400_000,
        privacy_consent: {
          text_processing: true,
          voice_processing: true,
          policy_version: '2026-08-26-vk-id-v1',
          updated_at: new Date(now).toISOString(),
        },
      },
    },
    progress: { [username]: {} },
    subscription_entitlements: {
      [username]: {
        voice_tutor: {
          starts_at: new Date(now - 1_000).toISOString(),
          ends_at: new Date(now + 86_400_000).toISOString(),
        },
      },
    },
    speaking_accent_profiles: {
      [username]: {
        username,
        locale: 'en-GB',
        revision: 1,
        source: 'manual',
        effective_at: new Date(now - 1_000).toISOString(),
        calibration_used: false,
      },
    },
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
      GROQ_ENABLED: 'false',
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

  const guestContext = await browser.newContext({
    viewport: { width: 320, height: 720 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await guestContext.addInitScript(() => {
    localStorage.setItem('aisy.onboarding.completion', JSON.stringify({
      version: 1,
      completedAt: '2026-08-26T00:00:00.000Z',
    }));
  });
  const guestPage = await guestContext.newPage();
  await guestPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await guestPage.locator('#scr5.on[data-access-state="no-session"]').waitFor({ state: 'visible', timeout: 8_000 });
  assert.deepEqual(await guestPage.evaluate(() => {
    const launcher = document.getElementById('asya-launcher');
    return {
      hidden: launcher.hidden,
      inert: launcher.inert,
      rendered: launcher.getClientRects().length > 0,
      assistantLoaded: Boolean(document.getElementById('asya-assistant')),
    };
  }), {
    hidden: true,
    inert: true,
    rendered: false,
    assistantLoaded: false,
  }, 'Asya must stay unavailable before verified learner access');
  await guestContext.close();

  const harness = await createActiveSubscriptionPage(browser, {
    baseUrl,
    username,
    jwtSecret,
    contextOptions: {
      viewport: { width: 320, height: 720 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    },
  });
  context = harness.context;
  const page = harness.page;
  const pageErrors = [];
  const voiceTutorNetworkCalls = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/v1/voice-tutor/')) {
      voiceTutorNetworkCalls.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 8_000 });
  const privacySheet = page.locator('#privacySheet.open');
  if (await privacySheet.count()) await privacySheet.getByRole('button', { name: /Позже|Закрыть/u }).press('Enter');

  const navigation = page.getByRole('navigation', { name: 'Основные разделы' });
  assert.equal(await navigation.locator('button').count(), 5, 'Asya must not become a sixth navigation destination');
  const launcher = page.getByRole('button', { name: 'Открыть Асю' });
  await launcher.waitFor({ state: 'visible' });
  assert.equal(await launcher.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(await launcher.getAttribute('aria-expanded'), 'false');

  await launcher.focus();
  await launcher.press('Enter');
  const assistant = page.locator('#asya-assistant');
  await assistant.waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await assistant.getAttribute('role'), 'dialog');
  assert.equal(await assistant.getAttribute('aria-modal'), 'true');
  assert.equal(await assistant.getAttribute('aria-labelledby'), 'asya-title');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'asya-close');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'asya-finish',
    'Shift+Tab from close must wrap to the last visible panel control, not the backdrop');
  await assistant.locator('#asya-close').focus();
  assert.equal(await launcher.getAttribute('aria-expanded'), 'true');
  assert.equal(await assistant.locator('#asya-state').getAttribute('role'), 'status');
  assert.equal(await assistant.locator('#asya-state').getAttribute('aria-live'), 'polite');
  assert.match(await assistant.locator('#asya-context').innerText(), /плане, навигации или технической помощи/u);

  const lightMobile = await asyaMetrics(page);
  assertAsyaMetrics(lightMobile, 'Asya · 320×720 · light/reduced');
  assert.ok(maximumSeconds(lightMobile.panel.animationDuration) <= 0.01,
    'Asya panel must respect reduced motion');
  assert.ok(maximumSeconds(lightMobile.launcher.transitionDuration) <= 0.01,
    'Asya launcher must respect reduced motion');

  const input = assistant.locator('#asya-input');
  await input.fill('Продолжим без имени');
  await input.press('Enter');
  assert.match(await assistant.locator('#asya-reply').innerText(), /начинаться с «Ася»/u);
  await input.fill('Ася, как открыть практику?');
  await input.press('Enter');
  assert.equal(await assistant.getAttribute('data-state'), 'listening');
  assert.equal(await assistant.locator('#asya-microphone').getAttribute('aria-pressed'), 'false');
  assert.match(await assistant.locator('#asya-reply').innerText(), /Сегодня, Практика, ЕГЭ, Прогресс и Профиль/u);
  assert.match(await assistant.locator('#asya-state').innerText(), /Имя повторять не нужно/u);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const lightDesktop = await asyaMetrics(page);
  assertAsyaMetrics(lightDesktop, 'Asya · 1440×900 · light/reduced');
  assert.ok(lightDesktop.panel.width <= 390.5, 'Asya desktop sheet must remain a portrait-phone surface');

  await page.evaluate(() => window.AisyTheme.set('dark'));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const darkDesktop = await asyaMetrics(page);
  assertAsyaMetrics(darkDesktop, 'Asya · 1440×900 · dark/reduced');
  assert.deepEqual(darkDesktop.theme, { root: 'dark', colorScheme: 'dark', panel: 'dark' });

  await assistant.press('Escape');
  await assistant.waitFor({ state: 'hidden' });
  assert.equal(await launcher.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'asya-launcher',
    'closing Asya must restore launcher focus');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => window.AisyTheme.set('light'));
  await openPracticeSkill(page, 'speaking');
  await page.locator('#scr9.on').waitFor({ state: 'visible', timeout: 8_000 });
  await page.getByRole('button', { name: /Чтение вслух/u }).press('Enter');
  const speakingDock = page.locator('#speaking_action_dock:not([hidden])');
  await speakingDock.waitFor({ state: 'visible', timeout: 8_000 });
  const dockBoundary = await page.evaluate(() => {
    const frame = document.getElementById('frame');
    const launcherElement = document.getElementById('asya-launcher');
    const dock = document.getElementById('speaking_action_dock');
    const launcherRect = launcherElement.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    return {
      dockActive: frame.dataset.speakingDockActive,
      launcherDisplay: getComputedStyle(launcherElement).display,
      launcherRendered: launcherElement.getClientRects().length > 0,
      launcherRect: { left: launcherRect.left, top: launcherRect.top, right: launcherRect.right, bottom: launcherRect.bottom },
      dockRect: { left: dockRect.left, top: dockRect.top, right: dockRect.right, bottom: dockRect.bottom },
      assistantOpen: !document.getElementById('asya-assistant').hidden,
    };
  });
  assert.equal(dockBoundary.dockActive, 'true');
  assert.equal(dockBoundary.launcherDisplay, 'none');
  assert.equal(dockBoundary.launcherRendered, false);
  assert.equal(dockBoundary.assistantOpen, false);
  assert.equal(
    dockBoundary.launcherRect.right > dockBoundary.dockRect.left
      && dockBoundary.launcherRect.left < dockBoundary.dockRect.right
      && dockBoundary.launcherRect.bottom > dockBoundary.dockRect.top
      && dockBoundary.launcherRect.top < dockBoundary.dockRect.bottom,
    false,
    'Asya launcher must never overlap the Speaking deep-action dock',
  );

  await page.evaluate(() => {
    const host = document.getElementById('s9_area');
    const trigger = document.createElement('button');
    trigger.id = 'asya-paper-voice-trigger';
    trigger.type = 'button';
    trigger.className = 'voiceTutorTrigger';
    trigger.dataset.source = 'speaking';
    trigger.dataset.attempt = '901';
    trigger.dataset.revision = '1';
    trigger.dataset.criterionIndex = '0';
    trigger.textContent = 'Разобрать проверенную ошибку с Асей';
    trigger.addEventListener('click', () => window.openVoiceTutorError(trigger));
    host.prepend(trigger);

    const result = {
      mode: 'text',
      nonce: 'asya-paper-nonce-001',
      session: {
        id: 'asya-paper-session-001',
        state: 'diagnose',
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
      capsule: {
        skill: { label: 'Произношение и ясность речи' },
        item: {
          prompt: 'Разберите уже проверенный фрагмент ответа.',
          context: { label: 'Фрагмент', text: 'education' },
        },
        rule: { explanation: 'Ударение помогает сохранить понятность ответа.' },
        checks: {
          micro_check: { prompt: 'Выберите ударный слог.' },
          transfer_task: { prompt: 'Произнесите слово в новом предложении.' },
        },
      },
      voice_tutor: {
        daily_remaining_seconds: 240,
        monthly_remaining_seconds: 1_200,
      },
      text_turn: { message: 'Коротко опишите, что было трудно произнести.' },
    };
    const state = {
      mode: 'recover',
      calls: [],
      release: null,
      result,
    };
    window.__asyaPaperVoice = state;
    const fakeApi = {
      async post() {
        return { voice_tutor: result.voice_tutor };
      },
      async postIdempotent(path, body, key) {
        state.calls.push({ path, body, key, mode: state.mode });
        const callsInMode = state.calls.filter((call) => call.mode === state.mode).length;
        if (state.mode === 'recover' && callsInMode === 1) {
          throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR', status: 0 });
        }
        if (state.mode === 'recover') {
          return new Promise((resolve) => { state.release = () => resolve(result); });
        }
        throw Object.assign(new Error('quota'), {
          code: 'VOICE_TUTOR_DAILY_QUOTA_EXCEEDED',
          status: 429,
        });
      },
      messageFor(error) {
        return Number(error?.status) === 429
          ? 'Лимит запросов исчерпан. Попробуйте позже.'
          : 'Нет подключения к интернету. Проверьте сеть и повторите попытку.';
      },
    };
    window.configureVoiceTutor({ api: fakeApi });
  });

  const voiceTrigger = page.locator('#asya-paper-voice-trigger');
  await voiceTrigger.focus();
  await voiceTrigger.press('Enter');
  const voiceSheet = page.locator('#voiceTutorSheet.open');
  await voiceSheet.waitFor({ state: 'visible', timeout: 5_000 });
  const voiceStatus = voiceSheet.locator('#voiceTutorStatus');
  await page.waitForFunction(() => document.getElementById('voiceTutorStatus')?.dataset.state === 'recovering');
  assert.equal(await voiceSheet.getAttribute('role'), 'dialog');
  assert.equal(await voiceSheet.getAttribute('aria-modal'), 'true');
  assert.equal(await voiceSheet.getAttribute('aria-busy'), 'true');
  assert.equal(await voiceStatus.getAttribute('aria-busy'), 'true');
  assert.match(await voiceStatus.innerText(), /Восстановление.*без повторного списания/su);
  assert.equal(await page.evaluate(() => {
    const calls = window.__asyaPaperVoice.calls.filter((call) => call.mode === 'recover');
    return calls.length === 2 && calls[0].key === calls[1].key;
  }), true, 'network recovery must reuse the original idempotency key');

  await page.evaluate(() => window.__asyaPaperVoice.release());
  await page.waitForFunction(() => document.getElementById('voiceTutorStatus')?.dataset.state === 'text-fallback');
  assert.equal(await voiceSheet.getAttribute('data-state'), 'text-fallback');
  assert.equal(await voiceSheet.getAttribute('aria-busy'), 'false');
  assert.match(await voiceStatus.innerText(), /Текстовый режим.*Коротко опишите/su);
  assert.match(await voiceSheet.locator('#voiceTutorQuota').innerText(), /4 мин сегодня.*20 мин в месяце/u);
  assert.match(await voiceSheet.locator('#voiceTutorPrivacy').innerText(), /только в этой сессии.*не сохраняются/su);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'voiceTutorClose');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'voiceTutorFinish',
    'Shift+Tab from close must wrap to the last visible Voice Tutor control, not the backdrop');
  await voiceSheet.locator('#voiceTutorClose').focus();

  const voiceTutorLayout = await page.evaluate(() => {
    const panel = document.querySelector('#voiceTutorSheet .vtPanel');
    const bounds = panel.getBoundingClientRect();
    const controls = [...panel.querySelectorAll('button,input,select')]
      .filter((control) => !control.disabled && control.offsetParent !== null)
      .map((control) => {
        const rect = control.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    return {
      left: bounds.left,
      right: bounds.right,
      bottom: bounds.bottom,
      width: bounds.width,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      animationDuration: getComputedStyle(panel).animationDuration,
      controls,
    };
  });
  assert.ok(voiceTutorLayout.width <= 390.5);
  assert.ok(Math.abs(voiceTutorLayout.left - (voiceTutorLayout.viewportWidth - voiceTutorLayout.width) / 2) <= 1);
  assert.ok(voiceTutorLayout.bottom <= voiceTutorLayout.viewportHeight + 1);
  assert.ok(maximumSeconds(voiceTutorLayout.animationDuration) <= 0.01);
  assert.deepEqual(voiceTutorLayout.controls.filter((control) => control.width < 44 || control.height < 44), []);

  await voiceSheet.press('Escape');
  await voiceSheet.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'asya-paper-voice-trigger',
    'closing Voice Tutor must restore trigger focus');

  await page.evaluate(() => { window.__asyaPaperVoice.mode = 'quota'; });
  await voiceTrigger.press('Enter');
  await voiceSheet.waitFor({ state: 'visible', timeout: 5_000 });
  await page.waitForFunction(() => document.getElementById('voiceTutorStatus')?.dataset.state === 'quota');
  assert.equal(await voiceSheet.getAttribute('data-state'), 'quota');
  assert.equal(await voiceSheet.getAttribute('aria-busy'), 'false');
  assert.match(await voiceStatus.innerText(), /Лимит исчерпан.*Попробуйте позже/su);
  assert.equal(await voiceSheet.locator('#voiceTutorRetry').isHidden(), true,
    'quota state must not present a misleading connection retry');
  await voiceSheet.getByRole('button', { name: 'Завершить и вернуться в упражнение' }).press('Enter');
  await voiceSheet.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'asya-paper-voice-trigger');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(voiceTutorNetworkCalls, [], 'the simulated Paper state matrix must not cross a paid Voice Tutor boundary');
  console.log('Aisy Paper A Asya / Voice Tutor Chromium E2E passed.');
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
