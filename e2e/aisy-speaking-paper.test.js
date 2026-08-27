import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, openPracticeSkill, stopProcess, waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const jwtSecret = 'aisy-speaking-paper-e2e-secret-32-chars';
const username = 'aisy-speaking-paper-e2e-user';

const layoutMatrix = [
  {width: 320, height: 720, label: '320×720 portrait'},
  {width: 390, height: 844, label: '390×844 portrait'},
  {width: 720, height: 320, label: '720×320 short landscape', shortLandscape: true},
  {width: 1440, height: 900, label: '1440×900 centered phone'},
];

async function speakingMetrics(page) {
  return page.evaluate(() => {
    const rect = (node) => node.getBoundingClientRect();
    const frame = document.getElementById('frame');
    const screen = document.querySelector('#scr9.on');
    const route = screen.querySelector('.speaking-route');
    const content = document.getElementById('s9_area');
    const dock = document.getElementById('speaking_action_dock');
    const primary = document.getElementById('s9_primary_action');
    const shellBack = document.getElementById('aisy-shell-back');
    const shellNav = document.getElementById('aisy-shell-nav');
    const frameRect = rect(frame);
    const screenRect = rect(screen);
    const routeRect = rect(route);
    const contentRect = rect(content);
    const dockRect = rect(dock);
    const primaryRect = rect(primary);
    const primaryStyle = getComputedStyle(primary);
    const affordanceStyle = getComputedStyle(primary, '::after');
    const visibleControls = [...screen.querySelectorAll('button'), shellBack]
      .filter((control) => control && !control.hidden && control.getClientRects().length)
      .map((control) => {
        const bounds = rect(control);
        return {
          label: control.getAttribute('aria-label') || control.textContent.trim(),
          width: bounds.width,
          height: bounds.height,
        };
      });
    const animated = [...route.querySelectorAll('*'), route].map((element) => {
      const style = getComputedStyle(element);
      return {
        animation: style.animationDuration,
        transition: style.transitionDuration,
      };
    });
    return {
      viewport: {width: innerWidth, height: innerHeight},
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      frame: {
        left: frameRect.left,
        right: frameRect.right,
        bottom: frameRect.bottom,
        width: frameRect.width,
        height: frameRect.height,
      },
      screen: {
        bottom: screenRect.bottom,
        width: screenRect.width,
        height: screenRect.height,
        scrollWidth: screen.scrollWidth,
        clientWidth: screen.clientWidth,
      },
      route: {width: routeRect.width, height: routeRect.height},
      content: {bottom: contentRect.bottom, height: contentRect.height},
      dock: {top: dockRect.top, bottom: dockRect.bottom, height: dockRect.height},
      primary: {
        text: primary.textContent.trim(),
        height: primaryRect.height,
        radius: primaryStyle.borderRadius,
        paddingLeft: primaryStyle.paddingLeft,
        paddingRight: primaryStyle.paddingRight,
        background: primaryStyle.backgroundColor,
        affordanceContent: affordanceStyle.content,
        affordanceWidth: affordanceStyle.width,
        affordanceHeight: affordanceStyle.height,
      },
      primaryCount: dock.querySelectorAll('.speaking-action--primary:not([hidden])').length,
      contentActionCount: content.querySelectorAll('.speaking-action').length,
      nav: {
        hidden: shellNav.hidden,
        inert: shellNav.inert,
        rendered: Boolean(shellNav.getClientRects().length),
      },
      back: {
        hidden: shellBack.hidden,
        rendered: Boolean(shellBack.getClientRects().length),
      },
      localNavigationCount: screen.querySelectorAll('nav, .navclay').length,
      fakeClockCount: [...screen.querySelectorAll('*')]
        .filter((node) => node.children.length === 0 && /(?:9:41|08:08)/u.test(node.textContent || '')).length,
      visibleControls,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      maximumAnimationSeconds: animated.reduce(
        (maximum, item) => Math.max(maximum, ...item.animation.split(',').map((part) => {
          const value = part.trim();
          return value.endsWith('ms') ? Number.parseFloat(value) / 1_000 : Number.parseFloat(value) || 0;
        })), 0,
      ),
      maximumTransitionSeconds: animated.reduce(
        (maximum, item) => Math.max(maximum, ...item.transition.split(',').map((part) => {
          const value = part.trim();
          return value.endsWith('ms') ? Number.parseFloat(value) / 1_000 : Number.parseFloat(value) || 0;
        })), 0,
      ),
      theme: document.documentElement.dataset.theme || null,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      eyebrowDisplay: getComputedStyle(route.querySelector('.speaking-route__eyebrow')).display,
      summaryDisplay: getComputedStyle(route.querySelector('.speaking-route__summary')).display,
    };
  });
}

function assertSpeakingLayout(metrics, viewport) {
  assert.ok(metrics.document.width <= metrics.viewport.width,
    `${viewport.label}: document has horizontal overflow ${JSON.stringify(metrics)}`);
  assert.ok(metrics.document.height <= metrics.viewport.height,
    `${viewport.label}: document exceeds the viewport ${JSON.stringify(metrics)}`);
  assert.ok(metrics.frame.width <= 390.5, `${viewport.label}: learner UI is not a portrait-phone canvas`);
  assert.ok(metrics.frame.height <= metrics.viewport.height + 1, `${viewport.label}: phone canvas exceeds viewport height`);
  assert.ok(Math.abs(metrics.frame.left - (metrics.viewport.width - metrics.frame.width) / 2) <= 1,
    `${viewport.label}: phone canvas is not centered`);
  assert.ok(metrics.frame.right <= metrics.viewport.width + 1 && metrics.frame.bottom <= metrics.viewport.height + 1,
    `${viewport.label}: phone canvas leaves the viewport`);
  assert.ok(metrics.screen.scrollWidth <= metrics.screen.clientWidth + 1,
    `${viewport.label}: Speaking screen has horizontal overflow`);
  assert.ok(metrics.route.width > 0 && metrics.route.height > 0 && metrics.content.height > 0,
    `${viewport.label}: Speaking route grid collapsed`);
  assert.ok(metrics.content.bottom <= metrics.dock.top + 1,
    `${viewport.label}: deep action dock covers the scroll area (${metrics.content.bottom} > ${metrics.dock.top})`);
  assert.ok(metrics.dock.bottom <= metrics.screen.bottom + 1,
    `${viewport.label}: deep action dock leaves the screen`);
  assert.deepEqual(metrics.nav, {hidden: true, inert: true, rendered: false},
    `${viewport.label}: deep Speaking route must not show bottom navigation`);
  assert.deepEqual(metrics.back, {hidden: false, rendered: true},
    `${viewport.label}: canonical shell Back must remain available`);
  assert.equal(metrics.localNavigationCount, 0, `${viewport.label}: duplicate local navigation`);
  assert.equal(metrics.fakeClockCount, 0, `${viewport.label}: fake device status chrome is rendered`);
  assert.equal(metrics.primaryCount, 1, `${viewport.label}: dock must expose one primary action`);
  assert.equal(metrics.contentActionCount, 0, `${viewport.label}: runtime actions escaped the deep dock`);
  assert.equal(Math.round(metrics.primary.height), 58, `${viewport.label}: CTA height`);
  assert.equal(Math.round(Number.parseFloat(metrics.primary.radius)), 28, `${viewport.label}: CTA radius`);
  assert.equal(Math.round(Number.parseFloat(metrics.primary.paddingLeft)), 26, `${viewport.label}: CTA left padding`);
  assert.equal(Math.round(Number.parseFloat(metrics.primary.paddingRight)), 10, `${viewport.label}: CTA right padding`);
  assert.equal(Math.round(Number.parseFloat(metrics.primary.affordanceWidth)), 38,
    `${viewport.label}: CTA affordance width`);
  assert.equal(Math.round(Number.parseFloat(metrics.primary.affordanceHeight)), 38,
    `${viewport.label}: CTA affordance height`);
  assert.equal(metrics.primary.background, 'rgb(185, 67, 58)',
    `${viewport.label}: CTA must use approved dark coral`);
  assert.match(metrics.primary.affordanceContent, /→/u, `${viewport.label}: CTA affordance arrow`);
  assert.deepEqual(metrics.visibleControls.filter((control) => control.width < 44 || control.height < 44), [],
    `${viewport.label}: touch target below 44px`);
  assert.equal(metrics.reducedMotion, true, `${viewport.label}: reduced-motion emulation was lost`);
  assert.ok(metrics.maximumAnimationSeconds <= 0.1,
    `${viewport.label}: reduced animation lasts ${metrics.maximumAnimationSeconds}s`);
  assert.ok(metrics.maximumTransitionSeconds <= 0.001,
    `${viewport.label}: reduced transition lasts ${metrics.maximumTransitionSeconds}s`);
  if (viewport.shortLandscape) {
    assert.equal(metrics.eyebrowDisplay, 'none', `${viewport.label}: nonessential eyebrow remains visible`);
    assert.equal(metrics.summaryDisplay, 'none', `${viewport.label}: nonessential summary remains visible`);
  }
}

let browser;
let child;
let context;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-speaking-paper-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const now = Date.now();
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      [username]: {
        created: now,
        sub_until: now + 86_400_000,
        privacy_consent: {
          text_processing: true,
          voice_processing: false,
          policy_version: '2026-08-26-vk-id-v1',
          updated_at: new Date(now).toISOString(),
        },
      },
    },
    progress: {[username]: {}},
    speaking_accent_profiles: {
      [username]: {
        username,
        locale: 'en-GB',
        revision: 1,
        source: 'manual',
        effective_at: '2026-08-26T00:00:00.000Z',
        calibration_used: false,
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
      GROQ_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false',
      ADAPTIVE_LEARNING_ENABLED: 'false',
      SPEAKING_PRONUNCIATION_ENABLED: 'false',
      AZURE_SPEECH_KEY: '',
      AZURE_SPEECH_REGION: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({headless: true, executablePath: await chromeExecutable()});
  const harness = await createActiveSubscriptionPage(browser, {
    baseUrl,
    username,
    jwtSecret,
    contextOptions: {
      viewport: {width: 320, height: 720},
      colorScheme: 'light',
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    },
  });
  context = harness.context;
  const page = harness.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await context.addInitScript(() => {
    window.__aisySpeakingMicrophoneMode = 'denied';
    const track = {readyState: 'live', stop() {}};
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        async getUserMedia() {
          if (window.__aisySpeakingMicrophoneMode === 'denied') {
            throw new DOMException('Microphone permission denied by E2E', 'NotAllowedError');
          }
          return {
            getAudioTracks: () => [track],
            getTracks: () => [track],
          };
        },
      },
    });
    class FakeAudioContext {
      createMediaStreamSource() { return {connect() {}}; }
      createAnalyser() {
        return {
          fftSize: 512,
          getByteTimeDomainData(values) { values.fill(136); },
        };
      }
      async close() {}
    }
    Object.defineProperty(window, 'AudioContext', {configurable: true, value: FakeAudioContext});
    Object.defineProperty(window, 'webkitAudioContext', {configurable: true, value: FakeAudioContext});
  });

  await page.goto(baseUrl, {waitUntil: 'networkidle'});
  await page.locator('#scr1.on').waitFor({state: 'visible', timeout: 8_000});
  await openPracticeSkill(page, 'speaking');
  await page.locator('#scr9.on #speaking_pronunciation_status').waitFor({state: 'visible', timeout: 8_000});

  const main = page.locator('#scr9.on main.speaking-route');
  assert.equal(await main.getAttribute('aria-labelledby'), 'speaking_title');
  assert.equal(await main.locator('h1#speaking_title').innerText(), 'Говорение');
  assert.equal(await main.locator('[role="progressbar"]').getAttribute('aria-valuemin'), '0');
  assert.equal(await main.locator('[role="progressbar"]').getAttribute('aria-valuemax'), '100');
  assert.match(await main.locator('[role="progressbar"]').getAttribute('aria-valuenow'), /^\d+$/u);
  assert.equal(await page.locator('#scr9 nav, #scr9 .navclay').count(), 0);
  assert.doesNotMatch(await page.locator('#scr9').innerText(), /(?:9:41|08:08)/u);

  await page.getByRole('button', {name: /Чтение вслух/u}).press('Enter');
  await page.locator('#s9_card').waitFor({state: 'visible', timeout: 8_000});
  const microphone = page.locator('[data-speaking-control="microphone"]');
  const microphoneStatus = page.locator('#speaking_mic_status');
  assert.equal(await microphone.getAttribute('aria-label'), 'Проверить микрофон');
  assert.equal(await microphone.getAttribute('aria-pressed'), 'false');
  assert.equal(await microphone.getAttribute('aria-describedby'), 'speaking_mic_status');
  assert.equal(await microphoneStatus.getAttribute('role'), 'status');
  assert.equal(await microphoneStatus.getAttribute('data-state'), 'unchecked');
  await microphone.focus();
  const focus = await microphone.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      visible: element.matches(':focus-visible'),
      outline: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
    };
  });
  assert.equal(focus.visible, true);
  assert.notEqual(focus.outline, 'none');
  assert.ok(focus.width >= 3);

  assertSpeakingLayout(await speakingMetrics(page), layoutMatrix[0]);

  await microphone.press('Enter');
  await page.locator('#speaking_mic_status[data-state="permission-denied"]').waitFor({
    state: 'visible', timeout: 5_000,
  });
  const deniedStatus = page.locator('#speaking_mic_status');
  assert.equal(await deniedStatus.getAttribute('role'), 'alert');
  assert.equal(await deniedStatus.getAttribute('aria-live'), 'polite');
  assert.equal(await deniedStatus.getAttribute('aria-atomic'), 'true');
  assert.match(await deniedStatus.innerText(), /Нет доступа к микрофону.*настройках браузера.*повтори проверку/su);
  assert.equal(await page.locator('[data-speaking-control="microphone"]').getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('#s9_primary_action').getAttribute('aria-label'), /Проверить микрофон/u);

  await page.setViewportSize({width: 390, height: 844});
  await page.evaluate(() => window.AisyTheme.set('dark'));
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#speaking_mic_status').getAttribute('data-state'), 'permission-denied',
    'permission recovery guidance must persist through a layout/theme change');

  await page.evaluate(() => { window.__aisySpeakingMicrophoneMode = 'success'; });
  await page.locator('[data-speaking-control="microphone"]').press('Enter');
  await page.locator('#speaking_mic_status[data-state="ready"]').waitFor({state: 'visible', timeout: 5_000});
  assert.match(await page.locator('#speaking_mic_status').innerText(), /Микрофон готов/u);
  assert.equal(await page.locator('[data-speaking-control="microphone"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#s9_primary_action').innerText(), 'Начать подготовку');

  for (const viewport of layoutMatrix) {
    await page.setViewportSize({width: viewport.width, height: viewport.height});
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const metrics = await speakingMetrics(page);
    assertSpeakingLayout(metrics, viewport);
    assert.equal(metrics.theme, 'dark', `${viewport.label}: explicit dark theme was lost`);
    assert.equal(metrics.colorScheme, 'dark', `${viewport.label}: controls do not inherit dark color scheme`);
  }

  assert.deepEqual(pageErrors, []);
  console.log('Aisy Speaking Paper A Chromium E2E passed: phone canvas, dock CTA, microphone recovery, dark and reduced-motion layouts.');
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, {recursive: true, force: true});
}
