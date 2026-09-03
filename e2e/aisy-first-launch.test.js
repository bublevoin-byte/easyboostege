import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  availablePort, chromeExecutable, stopProcess, waitForReady,
} from './browser-server-harness.js';
import { createReleaseServerEnvironment } from './aisy-learner-release-safety.js';
import {
  EGE_MOCK_PUBLIC_FORM_FINGERPRINT,
  EGE_MOCK_PUBLIC_FORM_ID,
  EGE_MOCK_PUBLIC_FORM_REVISION,
} from '../public/ege-mock-catalog-contract.js';
import {
  ATTEMPT_POLICY_ID, WRITTEN_DURATION_MS,
} from '../public/ege-mock-written-continuation.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const jwtSecret = 'aisy-first-launch-local-vk-e2e-secret-over-32-characters';
const onboardingKey = 'aisy.onboarding.completion';

async function startServer({
  baseUrl,
  dataFile,
  mode,
  port,
  localSubject = 'ticket-02-browser-learner',
  localDisplayName = 'Мария Тестова',
}) {
  const output = [];
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: createReleaseServerEnvironment({
      NODE_ENV: 'test',
      PORT: String(port),
      APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file',
      DATA_FILE: dataFile,
      JWT_SECRET: jwtSecret,
      VK_ID_MODE: mode,
      VK_ID_APP_ID: '',
      VK_ID_REDIRECT_URI: '',
      VK_ID_SCOPE: '',
      VK_ID_LOCAL_SUBJECT: localSubject,
      VK_ID_LOCAL_DISPLAY_NAME: localDisplayName,
      ADAPTIVE_LEARNING_ENABLED: 'false',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  try {
    await waitForReady(baseUrl, child, output);
  } catch (error) {
    await stopProcess(child).catch(() => {});
    throw error;
  }
  return { child, output };
}

async function seedCompletedOnboarding(browserContext) {
  await browserContext.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      version: 1,
      completedAt: '2026-08-26T00:00:00.000Z',
    }));
  }, { key: onboardingKey });
}

async function seedOwnerBoundMockContinuation(page) {
  return page.evaluate(({ formIdentity, fingerprint, policyId, durationMs }) => {
    const owner = window.EasyBoostStore.readCurrentOwner();
    const startedAt = new Date(Date.now() - 60_000);
    const deadlineAt = new Date(startedAt.getTime() + durationMs);
    localStorage.setItem(
      `easyboost-ege-mock-written-v1:${owner.owner}:${owner.ownerGeneration}`,
      JSON.stringify({
        version: 1,
        owner: { username: owner.owner, generation: owner.ownerGeneration },
        formIdentity,
        catalogFingerprint: fingerprint,
        invalidationWatermark: 0,
        phase: 'running',
        attemptId: '00000000-0000-4000-8000-000000000003',
        attemptOwnerGeneration: 'ticket-03-seeded-owner-generation',
        policyId,
        writtenStartedAt: startedAt.toISOString(),
        writtenDeadlineAt: deadlineAt.toISOString(),
        queue: [],
        answers: {},
      }),
    );
    return owner;
  }, {
    formIdentity: `${EGE_MOCK_PUBLIC_FORM_ID}@${EGE_MOCK_PUBLIC_FORM_REVISION}`,
    fingerprint: EGE_MOCK_PUBLIC_FORM_FINGERPRINT,
    policyId: ATTEMPT_POLICY_ID,
    durationMs: WRITTEN_DURATION_MS,
  });
}

async function openingLayout(page) {
  return page.evaluate(() => {
    const frame = document.getElementById('frame').getBoundingClientRect();
    const visibleView = document.querySelector('[data-first-launch-step]:not([hidden])');
    const controls = [...document.querySelectorAll('#scr5 button:not([hidden]),#scr5 a[href]:not([hidden])')]
      .filter((element) => element.getClientRects().length && !element.disabled)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { label: element.textContent.trim(), width: box.width, height: box.height };
      });
    return {
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      frameWidth: frame.width,
      frameHeight: frame.height,
      frameLeft: frame.left,
      frameRight: frame.right,
      frameTop: frame.top,
      frameBottom: frame.bottom,
      screenClientHeight: document.getElementById('scr5')?.clientHeight || 0,
      screenScrollHeight: document.getElementById('scr5')?.scrollHeight || 0,
      visibleStep: visibleView?.dataset.firstLaunchStep || '',
      activeDots: document.querySelectorAll('[data-first-launch-dot][aria-current="step"]').length,
      hiddenViews: [...document.querySelectorAll('[data-first-launch-step][hidden]')]
        .every((view) => view.inert && view.getAttribute('aria-hidden') === 'true'),
      bodyFontSize: Number.parseFloat(getComputedStyle(
        visibleView?.querySelector('.first-launch__copy h1 + p'),
      ).fontSize),
      undersized: controls.filter((control) => control.width < 44 || control.height < 44),
    };
  });
}

async function assertOpeningShellPrivate(page, label) {
  await page.waitForFunction(() => (
    document.getElementById('aisy-shell-nav') && document.getElementById('aisy-shell-back')
      && document.getElementById('asya-launcher')
  ));
  const state = await page.evaluate(() => ['aisy-shell-nav', 'aisy-shell-back', 'asya-launcher'].map((id) => {
    const element = document.getElementById(id);
    return { id, hidden: element.hidden, inert: element.inert, rectangles: element.getClientRects().length };
  }));
  assert.deepEqual(state, [
    { id: 'aisy-shell-nav', hidden: true, inert: true, rectangles: 0 },
    { id: 'aisy-shell-back', hidden: true, inert: true, rectangles: 0 },
    { id: 'asya-launcher', hidden: true, inert: true, rectangles: 0 },
  ], `${label} must keep every learner-shell control private`);
}

async function assertDarkAccessGate(page, label) {
  const snapshot = await page.evaluate(() => {
    const resolveColor = (token) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const gate = document.getElementById('access_gate');
    const card = gate.querySelector('.aisy-access-gate__card');
    const title = document.getElementById('access_gate_title');
    const copy = document.getElementById('access_gate_copy');
    return {
      theme: document.documentElement.dataset.theme || '',
      actual: {
        gateText: getComputedStyle(gate).color,
        cardSurface: getComputedStyle(card).backgroundColor,
        titleText: getComputedStyle(title).color,
        copyText: getComputedStyle(copy).color,
      },
      expected: {
        gateText: resolveColor('--aisy-color-text'),
        cardSurface: resolveColor('--aisy-color-surface-raised'),
        titleText: resolveColor('--aisy-color-text-strong'),
        copyText: resolveColor('--aisy-color-text-muted'),
      },
    };
  });
  assert.equal(snapshot.theme, 'dark', `${label} must retain the forced dark theme`);
  assert.deepEqual(snapshot.actual, snapshot.expected,
    `${label} surface and text must resolve through dark semantic tokens`);
  assert.notEqual(snapshot.actual.cardSurface, 'rgb(255, 255, 255)',
    `${label} must not regress to the legacy white card literal`);
  assert.notEqual(snapshot.actual.titleText, 'rgb(43, 43, 43)',
    `${label} must not regress to the legacy light title literal`);
  assert.notEqual(snapshot.actual.copyText, 'rgb(93, 97, 104)',
    `${label} must not regress to the legacy light copy literal`);
  return snapshot.actual;
}

let browser;
let context;
let server;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-first-launch-'));
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  ({ child: server } = await startServer({ baseUrl, dataFile, mode: 'local', port }));

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });

  const firstPaintContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    serviceWorkers: 'block',
  });
  await firstPaintContext.addInitScript(() => {
    try { localStorage.setItem('aisy.theme.preference.v1', 'dark'); } catch {}
    window.__aisyThemeFirstPaint = { dom: null, frame: null };
    const snapshot = () => ({
      theme: document.documentElement.dataset.theme || '',
      preference: document.documentElement.dataset.themePreference || '',
      themeColor: document.querySelector('meta[name="theme-color"]')?.content || '',
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    });
    const observer = new MutationObserver(() => {
      if (!document.body || window.__aisyThemeFirstPaint.dom) return;
      window.__aisyThemeFirstPaint.dom = snapshot();
      requestAnimationFrame(() => {
        window.__aisyThemeFirstPaint.frame = snapshot();
      });
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  let blockedMainRoute = null;
  await firstPaintContext.route('**/*', (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.resourceType() === 'script' && pathname !== '/theme-prepaint.js') {
      blockedMainRoute = route;
      return undefined;
    }
    return route.continue();
  });
  const firstPaintPage = await firstPaintContext.newPage();
  await firstPaintPage.goto(baseUrl, { waitUntil: 'commit' });
  await firstPaintPage.waitForFunction(() => window.__aisyThemeFirstPaint?.frame, null, { timeout: 5_000 });
  await firstPaintPage.waitForFunction(() => [...document.scripts]
    .some((script) => script.type === 'module'), null, { timeout: 5_000 });
  for (let attempt = 0; attempt < 100 && !blockedMainRoute; attempt += 1) {
    await firstPaintPage.waitForTimeout(25);
  }
  assert.ok(blockedMainRoute, 'the application module must remain blocked during the first-paint assertion');
  const firstPaint = await firstPaintPage.evaluate(() => window.__aisyThemeFirstPaint);
  for (const [phase, snapshot] of Object.entries(firstPaint)) {
    assert.equal(snapshot.theme, 'dark', `${phase} paint must already use the forced dark theme`);
    assert.equal(snapshot.preference, 'dark', `${phase} paint must retain the forced theme preference`);
    assert.equal(snapshot.themeColor, '#171219', `${phase} paint must expose the dark browser theme color`);
  }
  assert.equal(firstPaint.frame.colorScheme, 'dark', 'the first CSS frame must resolve the dark color scheme');
  await firstPaintContext.close();

  const reducedSplashContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await reducedSplashContext.addInitScript(() => {
    window.__aisyReducedSplashTiming = { visibleSince: null, intervals: [], events: [] };
    const inspect = () => {
      const splash = document.getElementById('scr0');
      if (!splash) return;
      const visible = !splash.hidden && splash.classList.contains('on');
      if (visible && window.__aisyReducedSplashTiming.visibleSince == null) {
        window.__aisyReducedSplashTiming.events.push({
          at: performance.now(), visible, active: document.querySelector('.screen.on')?.id || '',
        });
        window.__aisyReducedSplashTiming.visibleSince = performance.now();
      } else if (!visible && window.__aisyReducedSplashTiming.visibleSince != null) {
        window.__aisyReducedSplashTiming.events.push({
          at: performance.now(), visible, active: document.querySelector('.screen.on')?.id || '',
        });
        window.__aisyReducedSplashTiming.intervals.push({
          shownAt: window.__aisyReducedSplashTiming.visibleSince,
          hiddenAt: performance.now(),
        });
        window.__aisyReducedSplashTiming.visibleSince = null;
      }
    };
    new MutationObserver(inspect).observe(document, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden'],
    });
    document.addEventListener('DOMContentLoaded', inspect, { once: true });
  });
  const reducedSplashPage = await reducedSplashContext.newPage();
  await reducedSplashPage.goto(baseUrl, { waitUntil: 'commit' });
  await reducedSplashPage.locator('#scr0').waitFor({ state: 'visible', timeout: 5_000 });
  const reducedSplashMotion = await reducedSplashPage.evaluate(() => {
    const splash = document.querySelector('.first-launch__splash');
    const animations = splash.getAnimations({ subtree: true }).map((animation) => ({
      pseudoElement: animation.effect?.pseudoElement || '',
      keyframes: animation.effect?.getKeyframes?.() || [],
    }));
    return {
      splashTransform: getComputedStyle(splash).transform,
      auraTransform: getComputedStyle(document.querySelector('.first-launch__splash-mark'), '::before').transform,
      signatureTransform: getComputedStyle(document.querySelector('.first-launch__signature path')).transform,
      spatialFrames: animations.flatMap(({ pseudoElement, keyframes }) => keyframes
        .filter((frame) => frame.transform && frame.transform !== 'none')
        .map((frame) => ({ pseudoElement, transform: frame.transform }))),
    };
  });
  assert.deepEqual(reducedSplashMotion, {
    splashTransform: 'none',
    auraTransform: 'none',
    signatureTransform: 'none',
    spatialFrames: [],
  }, 'reduced-motion splash uses opacity only and carries no spatial keyframes');
  await reducedSplashPage.getByRole('heading', { name: 'Каждый день — понятный шаг', exact: true })
    .waitFor({ state: 'visible', timeout: 5_000 });
  const reducedSplashTiming = await reducedSplashPage.evaluate(() => window.__aisyReducedSplashTiming);
  const reducedSplashVisibleMs = Math.max(...reducedSplashTiming.intervals
    .map(({ shownAt, hiddenAt }) => hiddenAt - shownAt));
  assert.ok(reducedSplashVisibleMs >= 350,
    `a fresh reduced-motion splash remains visible for at least 350ms (observed ${reducedSplashVisibleMs}ms; ${JSON.stringify(reducedSplashTiming.events)})`);
  await reducedSplashContext.close();

  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'light',
    serviceWorkers: 'block',
  });
  const externalRequests = [];
  const pageErrors = [];
  let failNextProviderDiscovery = false;
  let failNextLoginStart = false;
  let nextLoginStartResponse = null;
  let hangNextProviderDiscovery = false;
  let hangNextSessionCheck = false;
  let hangNextTaskBank = false;
  let hangNextProgress = false;
  let observedJsonHandshakes = 0;
  const stalledRoutes = [];
  await context.route('**/*', (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== baseUrl) {
      externalRequests.push(`${route.request().method()} ${requestUrl.origin}`);
      return route.abort('blockedbyclient');
    }
    if (requestUrl.pathname === '/api/v1/auth/providers' && failNextProviderDiscovery) {
      failNextProviderDiscovery = false;
      return route.abort('failed');
    }
    if (requestUrl.pathname === '/api/v1/auth/vk/start'
      && requestUrl.searchParams.get('response') === 'json') {
      observedJsonHandshakes += 1;
      if (nextLoginStartResponse) {
        const response = nextLoginStartResponse;
        nextLoginStartResponse = null;
        return route.fulfill({
          status: response.status,
          contentType: 'application/json',
          body: JSON.stringify(response.body),
        });
      }
      if (failNextLoginStart) {
        failNextLoginStart = false;
        return route.abort('failed');
      }
    }
    if (requestUrl.pathname === '/api/v1/auth/providers' && hangNextProviderDiscovery) {
      hangNextProviderDiscovery = false;
      stalledRoutes.push(route);
      return undefined;
    }
    if (requestUrl.pathname === '/api/v1/me' && hangNextSessionCheck) {
      hangNextSessionCheck = false;
      stalledRoutes.push(route);
      return undefined;
    }
    if (requestUrl.pathname === '/task-bank.json' && hangNextTaskBank) {
      hangNextTaskBank = false;
      stalledRoutes.push(route);
      return undefined;
    }
    if (requestUrl.pathname === '/api/v1/progress' && hangNextProgress) {
      hangNextProgress = false;
      stalledRoutes.push(route);
      return undefined;
    }
    return route.continue();
  });
  context.on('page', (opened) => opened.on('pageerror', (error) => pageErrors.push(error.message)));
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('#scr0').isVisible(), true, 'fresh launch starts on the private splash');
  await assertOpeningShellPrivate(page, 'splash');
  await page.getByRole('heading', { name: 'Каждый день — понятный шаг', exact: true })
    .waitFor({ state: 'visible', timeout: 5_000 });
  assert.equal(await page.locator('.first-launch__progress').getAttribute('aria-label'), 'Шаг 1 из 4');
  await assertOpeningShellPrivate(page, 'onboarding step 1');

  const openingViewports = [
    { width: 320, height: 720 },
    { width: 720, height: 320 },
    { width: 360, height: 720 },
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 812, height: 375 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
    { width: 900, height: 1440 },
  ];
  for (const viewport of openingViewports) {
    await page.setViewportSize(viewport);
    const layout = await openingLayout(page);
    assert.ok(layout.documentWidth <= layout.viewportWidth, `opening overflows at ${viewport.width}×${viewport.height}`);
    assert.ok(layout.frameWidth <= 390.5, `opening exceeds phone width at ${viewport.width}×${viewport.height}`);
    assert.ok(layout.frameLeft >= -0.5 && layout.frameRight <= layout.viewportWidth + 0.5);
    assert.ok(Math.abs(layout.frameLeft - ((layout.viewportWidth - layout.frameWidth) / 2)) <= 1,
      `phone canvas is not centered at ${viewport.width}×${viewport.height}`);
    assert.equal(layout.visibleStep, '0');
    assert.equal(layout.activeDots, 1);
    assert.equal(layout.hiddenViews, true);
    assert.ok(layout.bodyFontSize >= 16,
      `opening body copy is below 16px at ${viewport.width}×${viewport.height}`);
    assert.deepEqual(layout.undersized, [], `opening has a touch target below 44px at ${viewport.width}×${viewport.height}`);
    if (viewport.height <= 600) {
      assert.ok(layout.frameHeight <= layout.viewportHeight + 0.5,
        `landscape frame is taller than the viewport at ${viewport.width}×${viewport.height}`);
      assert.ok(layout.frameTop >= -0.5 && layout.frameBottom <= layout.viewportHeight + 0.5,
        `landscape frame is clipped at ${viewport.width}×${viewport.height}`);
      await page.locator('[data-first-launch-next]').scrollIntoViewIfNeeded();
      const action = await page.locator('[data-first-launch-next]').evaluate((button) => {
        const box = button.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, viewportHeight: document.documentElement.clientHeight };
      });
      assert.ok(action.top >= -0.5 && action.bottom <= action.viewportHeight + 0.5,
        `primary action cannot be scrolled into view at ${viewport.width}×${viewport.height}`);
    }
    await page.locator('#scr5').evaluate((screen) => { screen.scrollTop = 0; });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.AisyTheme.set('system'));
  const systemAppearances = {};
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' });
    await page.waitForTimeout(30);
    systemAppearances[colorScheme] = await page.evaluate(() => {
      const screen = document.getElementById('scr5');
      const style = getComputedStyle(screen);
      return {
        effective: window.AisyTheme.effective,
        background: style.backgroundImage,
        color: style.color,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
      };
    });
    assert.equal(systemAppearances[colorScheme].effective, colorScheme);
    assert.ok(systemAppearances[colorScheme].documentWidth <= systemAppearances[colorScheme].viewportWidth,
      `${colorScheme} first-launch theme overflows horizontally`);
  }
  assert.notEqual(systemAppearances.light.background, systemAppearances.dark.background,
    'system light and dark opening themes must resolve to different paper surfaces');
  assert.notEqual(systemAppearances.light.color, systemAppearances.dark.color,
    'system light and dark opening themes must resolve to different text colors');

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const reducedMotion = await page.evaluate(() => {
    const durationMs = (value) => Math.max(...value.split(',').map((part) => {
      const token = part.trim();
      return token.endsWith('ms') ? Number.parseFloat(token) : Number.parseFloat(token) * 1_000;
    }));
    const view = getComputedStyle(document.querySelector('[data-first-launch-step]:not([hidden])'));
    const dot = getComputedStyle(document.querySelector('[data-first-launch-dot][aria-current="step"]'));
    return {
      animationMs: durationMs(view.animationDuration),
      transitionMs: durationMs(dot.transitionDuration),
      transform: view.transform,
    };
  });
  assert.ok(reducedMotion.animationMs <= 100, 'reduced-motion page animation must stay within 100ms');
  assert.ok(reducedMotion.transitionMs <= 100, 'reduced-motion progress transition must stay within 100ms');
  assert.equal(reducedMotion.transform, 'none', 'reduced-motion page change must not move the canvas');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

  const primaryButtonGeometry = await page.locator('[data-first-launch-next]').evaluate((button) => {
    const style = getComputedStyle(button);
    const affordance = getComputedStyle(button, '::after');
    return {
      height: button.getBoundingClientRect().height,
      radius: Number.parseFloat(style.borderRadius),
      affordanceWidth: Number.parseFloat(affordance.width),
      affordanceHeight: Number.parseFloat(affordance.height),
    };
  });
  assert.ok(primaryButtonGeometry.height >= 58);
  assert.equal(primaryButtonGeometry.radius, 28);
  assert.deepEqual(
    [primaryButtonGeometry.affordanceWidth, primaryButtonGeometry.affordanceHeight],
    [38, 38],
  );

  await page.setViewportSize({ width: 568, height: 320 });
  await page.locator('#scr5').evaluate((screen) => { screen.scrollTop = screen.scrollHeight; });
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('heading', { name: 'Тренируй формат, а не догадки', exact: true }).waitFor();
  assert.equal(await page.locator('#scr5').evaluate((screen) => screen.scrollTop), 0,
    'compact landscape navigation resets the new slide to its top');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.first-launch__progress').getAttribute('aria-label'), 'Шаг 2 из 4');
  await assertOpeningShellPrivate(page, 'onboarding step 2');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'first_launch_title_1');
  assert.equal(await page.locator('#first_launch_title_1').evaluate((heading) => getComputedStyle(heading).outlineStyle), 'none');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('heading', { name: 'Видишь, как растёт балл', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Начать', exact: true }).count(), 1);
  assert.equal(await page.locator('.first-launch__progress').getAttribute('aria-label'), 'Шаг 3 из 4');
  await assertOpeningShellPrivate(page, 'onboarding step 3');
  await page.getByRole('button', { name: 'Начать', exact: true }).click();

  const login = page.locator('[data-first-launch-login]');
  await login.waitFor({ state: 'visible', timeout: 5_000 });
  await page.waitForFunction(() => !document.querySelector('[data-first-launch-login]')?.disabled);
  assert.equal((await login.ariaSnapshot()).trim(), '- button "Войти через VK ID"',
    'the VK provider mark must not change the exact accessible button name');
  assert.equal(await page.locator('.first-launch__progress').getAttribute('aria-label'), 'Шаг 4 из 4');
  await assertOpeningShellPrivate(page, 'login');
  assert.equal(await page.locator('[data-first-launch-skip]').isVisible(), false);
  assert.match(await page.locator('#first_launch_status').innerText(), /готов/u);
  await page.setViewportSize({ width: 320, height: 720 });
  assert.ok(await page.locator('#first_launch_status').evaluate((status) => (
    Number.parseFloat(getComputedStyle(status).fontSize) >= 16
  )), 'compact-phone VK recovery/status copy keeps the 16px readable floor');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => window.AisyTheme.set('dark'));
  const loginComposition = await page.evaluate(() => {
    const progress = document.querySelector('.first-launch__progress').getBoundingClientRect();
    const button = document.querySelector('[data-first-launch-login]').getBoundingClientRect();
    const affordance = getComputedStyle(document.querySelector('.first-launch__vk-mark'));
    return {
      progressBottom: progress.bottom,
      buttonTop: button.top,
      affordanceColor: affordance.color,
      affordanceBackground: affordance.backgroundColor,
      theme: document.documentElement.dataset.theme,
    };
  });
  assert.ok(loginComposition.progressBottom <= loginComposition.buttonTop,
    'the fourth progress dot must appear before the VK action');
  assert.notEqual(loginComposition.affordanceColor, loginComposition.affordanceBackground,
    'the VK glyph must remain visible against its cream affordance');
  assert.equal(loginComposition.theme, 'dark');
  assert.equal(new URL(await page.locator('.first-launch__privacy').getAttribute('href'), baseUrl).pathname, '/privacy.html');

  await page.goto(`${baseUrl}/?auth_error=constructor`, { waitUntil: 'domcontentloaded' });
  await page.locator('#first_launch_status[data-kind="error"]').waitFor({ state: 'visible', timeout: 8_000 });
  assert.equal(await page.locator('#first_launch_status').innerText(), 'Не удалось войти. Попробуй ещё раз.',
    'an inherited object key maps to bounded generic auth copy');
  assert.equal(new URL(page.url()).search, '', 'a crafted auth_error is consumed from the PWA URL');
  await page.waitForFunction(() => document.querySelector('[data-first-launch-login]')?.disabled === false);

  nextLoginStartResponse = {
    status: 429,
    body: { error: { code: 'RATE_LIMITED' } },
  };
  await login.click();
  await page.locator('#first_launch_status[data-kind="error"]').waitFor({ state: 'visible', timeout: 8_000 });
  assert.equal(
    await page.locator('#first_launch_status').innerText(),
    'Слишком много попыток входа. Попробуй ещё раз позже.',
    'a JSON RATE_LIMITED handshake keeps its specific recoverable copy',
  );
  assert.equal(await login.isDisabled(), false, 'rate-limited login remains retryable');
  assert.equal(await page.getByRole('button', { name: 'Повторить', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-first-launch-login]')?.disabled === false);

  nextLoginStartResponse = {
    status: 503,
    body: { error: { code: 'VK_ID_UNAVAILABLE' } },
  };
  await login.click();
  await page.locator('#first_launch_status[data-kind="error"]').waitFor({ state: 'visible', timeout: 8_000 });
  assert.equal(
    await page.locator('#first_launch_status').innerText(),
    'Вход через VK ID пока недоступен.',
    'a JSON VK_ID_UNAVAILABLE handshake is not misreported as a network failure',
  );
  assert.doesNotMatch(await page.locator('#first_launch_status').innerText(), /Проверь сеть/u);
  assert.equal(await login.isDisabled(), false, 'an unavailable-provider response leaves a recovery action');
  assert.equal(await page.getByRole('button', { name: 'Повторить', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-first-launch-login]')?.disabled === false);

  failNextLoginStart = true;
  await login.click();
  await page.locator('#first_launch_status[data-kind="error"]').waitFor({ state: 'visible', timeout: 8_000 });
  assert.equal(new URL(page.url()).pathname, '/', 'a failed start handshake stays inside the PWA');
  assert.match(await page.locator('#first_launch_status').innerText(), /Проверь сеть/u);
  assert.equal(await login.isDisabled(), false, 'the VK action becomes retryable after a failed handshake');
  assert.equal(await page.getByRole('button', { name: 'Повторить', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-first-launch-login]')?.disabled === false);
  const successfulHandshake = page.waitForRequest((request) => {
    const requestUrl = new URL(request.url());
    return requestUrl.pathname === '/api/v1/auth/vk/start'
      && requestUrl.searchParams.get('response') === 'json';
  });
  await login.click();
  await successfulHandshake;
  assert.equal(observedJsonHandshakes, 4, 'VK login must use the bounded JSON start handshake');

  await page.locator('#access_gate[data-state="inactive"]').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(new URL(page.url()).search, '', 'provider callback parameters never remain in the app URL');
  await page.setViewportSize({ width: 320, height: 720 });
  assert.ok(await page.locator('#access_gate_copy').evaluate((copy) => (
    Number.parseFloat(getComputedStyle(copy).fontSize) >= 16
  )), 'compact-phone access recovery copy keeps the 16px readable floor');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    'compact-phone access gate does not overflow after readable copy sizing');
  await page.setViewportSize({ width: 390, height: 844 });
  const darkGateBeforeReload = await assertDarkAccessGate(page, 'initial inactive access gate');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#access_gate[data-state="inactive"]').waitFor({ state: 'visible', timeout: 10_000 });
  const darkGateAfterReload = await assertDarkAccessGate(page, 'reloaded inactive access gate');
  assert.deepEqual(darkGateAfterReload, darkGateBeforeReload,
    'forced-dark access-gate styles remain stable across reload');

  const lateSessionOwner = await page.evaluate(() => window.EasyBoostStore.readCurrentOwner());
  hangNextSessionCheck = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#access_gate[data-state="network-unknown"]')
    .waitFor({ state: 'visible', timeout: 9_000 });
  assert.equal(await page.locator('#access_gate_status').innerText(), '',
    'the initial dialog description is not duplicated into the live status');
  const lateSessionRoutes = stalledRoutes.splice(0);
  assert.equal(lateSessionRoutes.length, 1);
  await lateSessionRoutes[0].fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      authenticated: true,
      username: lateSessionOwner.owner,
      displayName: 'Мария Тестова',
      active: true,
      sub_until: Date.now() + 86_400_000,
      features: { adaptive_learning: false },
    }),
  }).catch(() => {});
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#scr1.on,#scr16.on').count(), 0,
    'a late active /me response cannot reopen a private route after the deadline');
  const inactiveRetryRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/me');
  await page.locator('#access_gate_retry').click();
  await inactiveRetryRequest;
  await page.locator('#access_gate[data-state="inactive"]').waitFor({ state: 'visible', timeout: 8_000 });
  await page.waitForFunction(() => /Нужен активный доступ/u.test(
    document.getElementById('access_gate_status')?.textContent || '',
  ));
  assert.match(await page.locator('#access_gate_status').innerText(), /подписка неактивна/u,
    'network-unknown to inactive is announced by the polite status');

  const privacyTrigger = page.locator('#access_gate_privacy');
  await privacyTrigger.focus();
  await privacyTrigger.click();
  const accessPrivacyDialog = page.locator('#privacySheet.open');
  await accessPrivacyDialog.waitFor({ state: 'visible', timeout: 8_000 });
  assert.equal(await accessPrivacyDialog.getAttribute('role'), 'dialog');
  assert.equal(await accessPrivacyDialog.getAttribute('aria-modal'), 'true');
  assert.equal(await page.locator('#access_gate').evaluate((gate) => gate.inert), true,
    'the nested privacy modal makes the underlying access modal inert');
  assert.equal(await page.locator('#access_gate').getAttribute('aria-hidden'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'privacyText',
    'the top privacy modal receives focus when opened from the access gate');
  await page.evaluate(() => {
    const sheet = document.getElementById('privacySheet');
    const controls = [...sheet.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')]
      .filter((control) => !control.hidden && control.offsetParent !== null);
    controls.at(-1).focus();
  });
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'privacyText',
    'Tab wraps from the final privacy control to the first');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'privacySave',
    'Shift+Tab wraps from the first privacy control to the final control');
  await page.keyboard.press('Escape');
  await accessPrivacyDialog.waitFor({ state: 'hidden', timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.id === 'access_gate_privacy');
  assert.equal(await page.locator('#access_gate').evaluate((gate) => gate.inert), false,
    'closing privacy restores the access modal interaction state');
  assert.equal(await page.locator('#access_gate').getAttribute('aria-hidden'), null);
  assert.equal(await page.locator('#access_gate[data-state="inactive"]').isVisible(), true,
    'closing the nested privacy modal leaves the inactive access gate in place');
  await privacyTrigger.click();
  await accessPrivacyDialog.waitFor({ state: 'visible', timeout: 8_000 });
  await accessPrivacyDialog.getByRole('button', { name: 'Позже', exact: true }).click();
  await accessPrivacyDialog.waitFor({ state: 'hidden', timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.id === 'access_gate_privacy');
  assert.equal(await page.locator('#access_gate').evaluate((gate) => gate.inert), false,
    'the explicit Later action also restores the underlying access modal');

  const sessionResponse = await context.request.get(`${baseUrl}/api/v1/me`);
  assert.equal(sessionResponse.status(), 200);
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, true);
  assert.equal(session.active, false, 'local login does not grant a subscription');
  assert.equal(session.displayName, 'Мария Тестова');
  assert.match(session.username, /^learner_[A-Za-z0-9_-]{16}$/u);
  assert.notEqual(session.username, 'ticket-02-browser-learner');
  assert.equal(Object.hasOwn(session, 'subject'), false);
  assert.equal(Object.hasOwn(session, 'telegram_id'), false);
  const completion = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), onboardingKey);
  assert.equal(completion.version, 1);
  assert.ok(Number.isFinite(Date.parse(completion.completedAt)));
  const cookies = await context.cookies(baseUrl);
  const authCookie = cookies.find((cookie) => cookie.name === 'eb_token');
  assert.equal(authCookie?.httpOnly, true);
  assert.equal(authCookie?.sameSite, 'Lax');
  assert.equal(cookies.some((cookie) => cookie.name === 'eb_vk_flow'), false);
  assert.doesNotMatch(await page.evaluate(() => document.cookie), /eb_(?:token|vk_flow)/u);

  const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(stored.learner_identities.length, 1);
  assert.deepEqual(
    Object.keys(stored.learner_identities[0]).filter((key) => ['provider', 'subject', 'username'].includes(key))
      .reduce((view, key) => ({ ...view, [key]: stored.learner_identities[0][key] }), {}),
    { provider: 'vk', subject: 'ticket-02-browser-learner', username: session.username },
  );
  assert.equal(stored.users[session.username].identity_managed, true);
  assert.equal(Object.hasOwn(stored.users[session.username], 'telegram_id'), false);
  assert.equal(Object.hasOwn(stored.users[session.username], 'hash'), false);
  assert.ok(Object.values(stored.oauth_auth_transactions).every((transaction) => (
    transaction.consumed_at && transaction.verifier_sealed === null
  )));
  assert.doesNotMatch(JSON.stringify(stored), /local-code|access_token|refresh_token/u);

  const replayContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
  });
  await seedCompletedOnboarding(replayContext);
  const replayPage = await replayContext.newPage();
  let replayCallbackUrl = '';
  replayPage.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.pathname === '/api/v1/auth/vk/callback') replayCallbackUrl = request.url();
  });
  await replayPage.goto(`${baseUrl}/api/v1/auth/vk/start`, { waitUntil: 'domcontentloaded' });
  await replayPage.locator('#access_gate[data-state="inactive"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  assert.match(replayCallbackUrl, /\/api\/v1\/auth\/vk\/callback\?/u);
  const replayCookies = await replayContext.cookies(replayCallbackUrl);
  assert.equal(replayCookies.some((cookie) => cookie.name === 'eb_vk_flow'), false,
    'the successful callback clears the one-time flow cookie');
  assert.equal(replayCookies.some((cookie) => cookie.name === 'eb_vk_replay'), true,
    'the successful callback leaves only the short replay classifier cookie');
  const replayLogoutStatus = await replayPage.evaluate(async () => (await fetch('/api/v1/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'X-EasyBoost-Expected-Owner': window.currentUser,
    },
    body: '{}',
  })).status);
  assert.equal(replayLogoutStatus, 200);
  await replayPage.goto(replayCallbackUrl, { waitUntil: 'domcontentloaded' });
  await replayPage.locator('#first_launch_status[data-kind="error"]')
    .waitFor({ state: 'visible', timeout: 8_000 });
  assert.match(await replayPage.locator('#first_launch_status').innerText(), /уже использована/u,
    'callback replay is reported distinctly without restoring the cleared flow cookie');
  assert.doesNotMatch(await replayPage.locator('#first_launch_status').innerText(), /истекло/u);
  assert.equal(new URL(replayPage.url()).search, '', 'replayed callback parameters are removed from the PWA URL');
  await replayContext.close();

  const expiredContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
  });
  await seedCompletedOnboarding(expiredContext);
  const expiredPage = await expiredContext.newPage();
  await expiredPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await expiredPage.locator('[data-first-launch-login]')
    .waitFor({ state: 'visible', timeout: 8_000 });
  const expiredStart = await expiredPage.evaluate(async () => {
    const response = await fetch('/api/v1/auth/vk/start?response=json', {
      credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
    });
    return { status: response.status, body: await response.json() };
  });
  assert.equal(expiredStart.status, 200);
  const expiredCallbackUrl = new URL(expiredStart.body.authorizationUrl, baseUrl);
  assert.equal(expiredCallbackUrl.pathname, '/api/v1/auth/vk/callback');
  const liveGraceCookies = await expiredContext.cookies(expiredCallbackUrl.toString());
  assert.equal(liveGraceCookies.some((cookie) => cookie.name === 'eb_vk_flow'), true,
    'the flow cookie remains live during the server-side transaction grace window');

  await stopProcess(server);
  server = null;
  const expiredState = expiredCallbackUrl.searchParams.get('state');
  const expiredStateHash = createHash('sha256').update(expiredState, 'utf8').digest('hex');
  const purgedStore = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(purgedStore.oauth_auth_transactions[expiredStateHash]?.consumed_at, null);
  delete purgedStore.oauth_auth_transactions[expiredStateHash];
  await fs.writeFile(dataFile, JSON.stringify(purgedStore), 'utf8');
  ({ child: server } = await startServer({ baseUrl, dataFile, mode: 'local', port }));

  await expiredPage.goto(expiredCallbackUrl.toString(), { waitUntil: 'domcontentloaded' });
  await expiredPage.locator('#first_launch_status[data-kind="error"]')
    .waitFor({ state: 'visible', timeout: 8_000 });
  assert.match(await expiredPage.locator('#first_launch_status').innerText(), /истекло/u,
    'a purged transaction with its grace cookie is reported as expired');
  assert.doesNotMatch(await expiredPage.locator('#first_launch_status').innerText(), /уже использована/u);
  assert.equal(new URL(expiredPage.url()).search, '', 'expired callback parameters are removed from the PWA URL');
  assert.equal((await expiredContext.cookies(expiredCallbackUrl.toString()))
    .some((cookie) => cookie.name === 'eb_vk_flow'), false, 'expired callback also clears the flow cookie');
  await expiredContext.close();

  await stopProcess(server);
  server = null;
  const activatedStore = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  activatedStore.users[session.username].sub_until = Date.now() + 86_400_000;
  await fs.writeFile(dataFile, JSON.stringify(activatedStore), 'utf8');
  ({ child: server } = await startServer({ baseUrl, dataFile, mode: 'local', port }));

  await page.evaluate(() => sessionStorage.removeItem('first-launch-login-seen'));
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const loginScreen = document.getElementById('scr5');
      const record = () => {
        if (loginScreen && !loginScreen.hidden && loginScreen.classList.contains('on')) {
          sessionStorage.setItem('first-launch-login-seen', '1');
        }
      };
      if (loginScreen) new MutationObserver(record).observe(loginScreen, {
        attributes: true, attributeFilter: ['class', 'hidden'],
      });
      record();
    }, { once: true });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on #today-hero[data-state="ready"]').waitFor({ state: 'visible', timeout: 12_000 });
  assert.equal(await page.locator('#today-title').innerText(), 'Здравствуйте, Мария Тестова');
  assert.doesNotMatch(await page.locator('#scr1').innerText(), new RegExp(session.username, 'u'),
    'Today must never render the opaque internal owner key');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('first-launch-login-seen')), null,
    'a returning active learner never sees the login screen');
  const privacyDialog = page.locator('#privacySheet.open');
  async function dismissPrivacyOffer({ persist = false } = {}) {
    await privacyDialog.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
    if (!await privacyDialog.isVisible()) return;
    await privacyDialog.getByRole('button', {
      name: persist ? 'Сохранить выбор' : 'Позже', exact: true,
    }).click();
    await privacyDialog.waitFor({ state: 'hidden', timeout: 3_000 });
  }
  await dismissPrivacyOffer({ persist: true });

  async function assertFailClosedActiveSession(status) {
    const failureContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block',
    });
    try {
      await seedCompletedOnboarding(failureContext);
      await failureContext.addCookies([authCookie]);
      const failurePage = await failureContext.newPage();
      await failurePage.goto(baseUrl, { waitUntil: 'networkidle' });
      await failurePage.locator('#scr1.on #today-hero[data-state="ready"]')
        .waitFor({ state: 'visible', timeout: 12_000 });
      const seededOwner = await seedOwnerBoundMockContinuation(failurePage);
      assert.equal(seededOwner.owner, session.username);
      await failurePage.route('**/api/v1/me', (route) => route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: status === 401 ? 'SESSION_REVOKED' : 'SERVICE_UNAVAILABLE' },
        }),
      }));
      await failurePage.evaluate(() => window.checkSub());
      if (status === 503) {
        await failurePage.locator('#access_gate[data-state="network-unknown"]')
          .waitFor({ state: 'visible', timeout: 8_000 });
      } else {
        await failurePage.locator('[data-first-launch-login]')
          .waitFor({ state: 'visible', timeout: 8_000 });
        assert.equal(await failurePage.locator('#access_gate').count(), 0);
      }
      assert.equal(await failurePage.locator('.screen.on:not(#scr5)').count(), 0,
        `${status} must leave only the login/recovery surface active`);
      assert.equal(await failurePage.locator('#scr16.on').count(), 0,
        `${status} must not revive the seeded EGE mock`);
      assert.equal(await failurePage.locator('#today-content').isVisible(), false,
        `${status} must not expose private Today copy`);
      const controls = await failurePage.evaluate(() => (
        ['aisy-shell-nav', 'aisy-shell-back', 'asya-launcher'].map((id) => {
          const element = document.getElementById(id);
          return { id, hidden: element.hidden, inert: element.inert, rendered: element.getClientRects().length };
        })
      ));
      assert.deepEqual(controls, [
        { id: 'aisy-shell-nav', hidden: true, inert: true, rendered: 0 },
        { id: 'aisy-shell-back', hidden: true, inert: true, rendered: 0 },
        { id: 'asya-launcher', hidden: true, inert: true, rendered: 0 },
      ]);
      await failurePage.waitForTimeout(250);
      assert.equal(await failurePage.locator('#scr1.on,#scr16.on').count(), 0,
        `${status} must remain fail-closed after queued UI work settles`);
    } finally {
      await failureContext.close();
    }
  }

  await assertFailClosedActiveSession(503);
  await assertFailClosedActiveSession(401);

  const taskBankBody = await fs.readFile(path.join(projectDirectory, 'public', 'task-bank.json'), 'utf8');
  const progressFixtureResponse = await context.request.get(`${baseUrl}/api/v1/progress`, {
    headers: { 'X-EasyBoost-Expected-Owner': session.username },
  });
  assert.equal(progressFixtureResponse.status(), 200);
  const progressBody = await progressFixtureResponse.text();

  async function assertHungLearningBootstrap({ pathname, label, arm, fulfill }) {
    arm();
    const requestSeen = page.waitForRequest((request) => new URL(request.url()).pathname === pathname);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await requestSeen;
    const gate = page.locator('#access_gate[data-state="network-unknown"]');
    await gate.waitFor({ state: 'visible', timeout: 12_000 });
    assert.equal(await page.locator('#scr1.on').count(), 0,
      `${label} timeout must not reveal Today`);
    const routeIndex = stalledRoutes.findIndex((route) => new URL(route.request().url()).pathname === pathname);
    assert.notEqual(routeIndex, -1, `${label} request must still have a controllable late response`);
    const [lateRoute] = stalledRoutes.splice(routeIndex, 1);
    await lateRoute.fulfill(fulfill);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#scr1.on').count(), 0,
      `${label} late response must not open Today after the deadline`);
    assert.equal(await gate.isVisible(), true,
      `${label} late response must leave the recoverable access state visible`);

    arm();
    const retrySession = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/me');
    const retryBootstrap = page.waitForRequest((request) => new URL(request.url()).pathname === pathname);
    await page.locator('#access_gate_retry').click();
    await retrySession;
    await retryBootstrap;
    assert.equal(await gate.isVisible(), true,
      `${label} retry must keep the access gate visible until learning bootstrap commits`);
    assert.equal(await page.locator('#scr5').evaluate((screen) => screen.inert), true,
      `${label} retry must keep the underlying login screen inert`);
    const retryRouteIndex = stalledRoutes.findIndex((route) => new URL(route.request().url()).pathname === pathname);
    assert.notEqual(retryRouteIndex, -1, `${label} retry bootstrap must remain controllable`);
    const [retryRoute] = stalledRoutes.splice(retryRouteIndex, 1);
    await retryRoute.fulfill(fulfill);
    await gate.waitFor({ state: 'detached', timeout: 10_000 });
    await page.locator('#scr1.on #today-hero[data-state="ready"]')
      .waitFor({ state: 'visible', timeout: 12_000 });
    await page.waitForFunction(() => document.activeElement?.id === 'today-title');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'today-title',
      `${label} successful retry moves focus from the removed dialog to Today`);
  }

  await assertHungLearningBootstrap({
    pathname: '/task-bank.json',
    label: 'task-bank bootstrap',
    arm: () => { hangNextTaskBank = true; },
    fulfill: { status: 200, contentType: 'application/json', body: taskBankBody },
  });
  await assertHungLearningBootstrap({
    pathname: '/api/v1/progress',
    label: 'progress bootstrap',
    arm: () => { hangNextProgress = true; },
    fulfill: {
      status: 200,
      contentType: 'application/json',
      headers: { 'x-easyboost-response-owner': session.username },
      body: progressBody,
    },
  });
  await dismissPrivacyOffer();

  await page.getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('button', { name: 'Профиль', exact: true }).click();
  await page.locator('#scr11.on').waitFor({ state: 'visible' });
  const replayContrast = await page.locator('#profile_onboarding_restart').evaluate((control) => {
    const parseRgb = (value) => (value.match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
    const luminance = (value) => {
      const channels = parseRgb(value).map((channel) => {
        const normalized = channel / 255;
        return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
      });
      return (.2126 * channels[0]) + (.7152 * channels[1]) + (.0722 * channels[2]);
    };
    const resolveColor = (token) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const style = getComputedStyle(control);
    const lighter = Math.max(luminance(style.color), luminance(style.backgroundColor));
    const darker = Math.min(luminance(style.color), luminance(style.backgroundColor));
    return {
      theme: document.documentElement.dataset.theme,
      color: style.color,
      expectedColor: resolveColor('--aisy-color-text'),
      ratio: (lighter + .05) / (darker + .05),
    };
  });
  assert.equal(replayContrast.theme, 'dark');
  assert.equal(replayContrast.color, replayContrast.expectedColor,
    'profile replay action consumes the semantic dark-theme text token');
  assert.ok(replayContrast.ratio >= 4.5,
    `profile replay action dark contrast is ${replayContrast.ratio.toFixed(2)}:1`);
  await page.locator('#profile_onboarding_restart').click();
  await page.getByRole('heading', { name: 'Каждый день — понятный шаг', exact: true }).waitFor();
  assert.equal((await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), onboardingKey)).version, 1,
    'starting a profile replay keeps the durable completion marker');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on #today-hero[data-state="ready"]').waitFor({ state: 'visible', timeout: 12_000 });
  assert.equal(await page.locator('#scr5.on').count(), 0,
    'reloading mid-replay returns an authenticated learner to Today instead of first-time onboarding');
  await dismissPrivacyOffer();
  await page.getByRole('navigation', { name: 'Основные разделы' })
    .getByRole('button', { name: 'Профиль', exact: true }).click();
  await page.locator('#scr11.on').waitFor({ state: 'visible' });
  await page.locator('#profile_onboarding_restart').click();
  await page.getByRole('heading', { name: 'Каждый день — понятный шаг', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Начать', exact: true }).click();
  await page.locator('#scr11.on').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#scr5.on').count(), 0, 'profile replay returns without forcing re-authentication');

  const logoutStatus = await page.evaluate(async () => (await fetch('/api/v1/logout', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      'X-EasyBoost-Expected-Owner': window.currentUser,
    },
    body: '{}',
  })).status);
  assert.equal(logoutStatus, 200);
  assert.equal((await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), onboardingKey)).version, 1,
    'logout preserves the versioned onboarding marker');

  hangNextSessionCheck = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#access_gate[data-state="network-unknown"]').waitFor({ state: 'visible', timeout: 9_000 });
  assert.match(await page.locator('#access_gate_copy').innerText(), /не можем подтвердить подписку/u,
    'a hung bootstrap session request becomes a deterministic retry state');
  await Promise.all(stalledRoutes.splice(0).map((route) => route.abort('failed').catch(() => {})));

  hangNextSessionCheck = true;
  const hungRetryRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/me');
  await page.locator('#access_gate_retry').click();
  await hungRetryRequest;
  assert.equal(await page.locator('#access_gate_retry').getAttribute('aria-busy'), 'true');
  await page.waitForFunction(() => {
    const retry = document.getElementById('access_gate_retry');
    return retry && retry.disabled === false && retry.getAttribute('aria-busy') !== 'true';
  }, null, { timeout: 9_000 });
  assert.equal(await page.locator('#access_gate').getAttribute('data-state'), 'network-unknown',
    'a hung access retry returns to the recoverable gate instead of blocking the auth queue');
  await page.waitForFunction(() => /Не удалось проверить доступ/u.test(
    document.getElementById('access_gate_status')?.textContent || '',
  ));
  assert.match(await page.locator('#access_gate_status').innerText(), /Проверьте сеть/u,
    'a same-state retry completion is announced by the polite status');

  const recoveredRetryRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/v1/me');
  await page.locator('#access_gate_retry').click();
  await recoveredRetryRequest;
  await page.locator('#access_gate').waitFor({ state: 'detached', timeout: 5_000 });
  await page.locator('[data-first-launch-login]').waitFor({ state: 'visible' });
  await Promise.all(stalledRoutes.splice(0).map((route) => route.abort('failed').catch(() => {})));

  hangNextProviderDiscovery = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#first_launch_status[data-kind="error"]').waitFor({ state: 'visible', timeout: 9_000 });
  assert.match(await page.locator('#first_launch_status').innerText(), /Проверь сеть/u,
    'a hung provider-discovery request becomes the same recoverable retry state as a failed request');
  await Promise.all(stalledRoutes.splice(0).map((route) => route.abort('failed').catch(() => {})));
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.waitForFunction(() => (
    document.querySelector('[data-first-launch-login]')?.disabled === false
      && document.querySelector('[data-first-launch-login]')?.getAttribute('aria-label') === 'Войти через VK ID'
  ));

  failNextProviderDiscovery = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#first_launch_status[data-kind="error"]').waitFor({ state: 'visible', timeout: 8_000 });
  assert.match(await page.locator('#first_launch_status').innerText(), /Проверь сеть/u);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.waitForFunction(() => (
    document.querySelector('[data-first-launch-login]')?.disabled === false
      && document.querySelector('[data-first-launch-login]')?.getAttribute('aria-label') === 'Войти через VK ID'
  ));

  await stopProcess(server);
  server = null;
  const localSubjectB = 'ticket-02-browser-learner-b';
  const localDisplayNameB = 'Борис Тестов';
  ({ child: server } = await startServer({
    baseUrl,
    dataFile,
    mode: 'local',
    port,
    localSubject: localSubjectB,
    localDisplayName: localDisplayNameB,
  }));

  const ownerBContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
  });
  await seedCompletedOnboarding(ownerBContext);
  await ownerBContext.addInitScript(({ owner }) => {
    try {
      if (sessionStorage.getItem('aisy.e2e.stale-owner-seeded') === '1') return;
      sessionStorage.setItem('aisy.e2e.stale-owner-seeded', '1');
      localStorage.setItem('eb_current', JSON.stringify({ version: 1, owner, ownerGeneration: 0 }));
      localStorage.setItem(`eb_data_${owner}_g0`, JSON.stringify({
        version: 2,
        ownerGeneration: 0,
        state: {
          learned: 987,
          streak: 987,
          dayMin: 987,
          prog: { words: 987, gram: 987, read: 987, listen: 987, write: 987, speak: 987 },
        },
      }));
    } catch {}
  }, { owner: session.username });
  const ownerBPage = await ownerBContext.newPage();
  await ownerBPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const ownerBLogin = ownerBPage.locator('[data-first-launch-login]');
  await ownerBLogin.waitFor({ state: 'visible', timeout: 8_000 });
  await ownerBPage.waitForFunction(() => document.querySelector('[data-first-launch-login]')?.disabled === false);
  assert.equal(await ownerBPage.evaluate(() => localStorage.getItem('eb_current')), null,
    'authoritative no-session clears the stale owner A marker before another login');
  assert.equal(await ownerBPage.locator('#scr1.on').count(), 0,
    'stale owner A data cannot open the learner shell without a server session');
  assert.match(await ownerBPage.evaluate((owner) => localStorage.getItem(`eb_data_${owner}_g0`), session.username), /987/u,
    'clearing authority does not need to project or overwrite the isolated A partition');

  await ownerBLogin.click();
  await ownerBPage.locator('#access_gate[data-state="inactive"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  const ownerBSessionResponse = await ownerBContext.request.get(`${baseUrl}/api/v1/me`);
  assert.equal(ownerBSessionResponse.status(), 200);
  const ownerBSession = await ownerBSessionResponse.json();
  assert.equal(ownerBSession.displayName, localDisplayNameB);
  assert.notEqual(ownerBSession.username, session.username);
  assert.match(ownerBSession.username, /^learner_[A-Za-z0-9_-]{16}$/u);
  assert.equal(ownerBSession.active, false, 'local subject B does not receive subscription access implicitly');
  assert.deepEqual(await ownerBPage.evaluate(() => JSON.parse(localStorage.getItem('eb_current'))), {
    version: 1,
    owner: ownerBSession.username,
    ownerGeneration: 0,
  }, 'subject B adopts only its fresh internal owner marker');
  const ownerBPrivacyStatus = await ownerBPage.evaluate(async () => (await fetch('/api/v1/privacy/consent', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text_processing: false, voice_processing: false }),
  })).status);
  assert.equal(ownerBPrivacyStatus, 200,
    'owner B fixture records the current privacy policy before testing the unobscured shell');

  await stopProcess(server);
  server = null;
  const ownerBStore = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  ownerBStore.users[ownerBSession.username].sub_until = Date.now() + 86_400_000;
  await fs.writeFile(dataFile, JSON.stringify(ownerBStore), 'utf8');
  ({ child: server } = await startServer({
    baseUrl,
    dataFile,
    mode: 'local',
    port,
    localSubject: localSubjectB,
    localDisplayName: localDisplayNameB,
  }));
  await ownerBPage.reload({ waitUntil: 'domcontentloaded' });
  await ownerBPage.locator('#scr1.on #today-hero[data-state="ready"]')
    .waitFor({ state: 'visible', timeout: 12_000 });
  assert.equal(await ownerBPage.locator('#today-title').innerText(),
    `Здравствуйте, ${localDisplayNameB}`);
  assert.doesNotMatch(await ownerBPage.locator('#scr1').innerText(), new RegExp(ownerBSession.username, 'u'),
    'owner switch must replace the prior display identity without exposing the internal key');
  assert.equal(await ownerBPage.getByRole('navigation', { name: 'Основные разделы' }).isVisible(), true);
  assert.deepEqual(await ownerBPage.evaluate(() => JSON.parse(localStorage.getItem('eb_current'))), {
    version: 1,
    owner: ownerBSession.username,
    ownerGeneration: 0,
  });
  assert.doesNotMatch(await ownerBPage.locator('#scr1').innerText(), /987/u,
    'active subject B never projects owner A local progress into Today');
  assert.equal(await ownerBPage.locator('#today-rhythm').innerText(), 'Начало ритма');
  assert.match(await ownerBPage.locator('#today-rhythm-detail').innerText(), /^0 мин сегодня/u);
  assert.doesNotMatch(await ownerBPage.locator('#today-title').innerText(), new RegExp(session.username, 'u'));
  await ownerBContext.close();

  await stopProcess(server);
  server = null;
  ({ child: server } = await startServer({ baseUrl, dataFile, mode: 'disabled', port }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  const unavailable = page.getByRole('button', { name: 'VK ID пока не подключён', exact: true });
  await unavailable.waitFor({ state: 'visible', timeout: 8_000 });
  assert.equal(await unavailable.isDisabled(), true);
  assert.match(await page.locator('#first_launch_status').innerText(), /не настроен/u);

  await page.goto(`${baseUrl}/api/v1/auth/vk/start`, { waitUntil: 'domcontentloaded' });
  await page.locator('#first_launch_status[data-kind="error"]').waitFor({ state: 'visible', timeout: 8_000 });
  assert.match(await page.locator('#first_launch_status').innerText(), /пока недоступен/u,
    'a top-level VK start failure returns to a recoverable PWA login state');
  assert.equal(new URL(page.url()).pathname, '/');
  assert.equal(new URL(page.url()).search, '', 'navigation auth_error is consumed without provider query leakage');

  assert.deepEqual(externalRequests, [], 'local VK mode must never leave the application origin');
  assert.deepEqual(pageErrors, []);
  console.log('Aisy first-launch + local VK ID Chromium E2E passed.');
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) await stopProcess(server).catch(() => {});
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
}
