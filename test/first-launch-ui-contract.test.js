import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  ONBOARDING_STORAGE_KEY,
  ONBOARDING_VERSION,
  FIRST_LAUNCH_REDUCED_SPLASH_HOLD_MS,
  FIRST_LAUNCH_SPLASH_HOLD_MS,
  completeOnboarding,
  discoverVkProvider,
  hasCompletedOnboarding,
  requestVkLoginStart,
  runWithAbortDeadline,
} from '../public/first-launch.js';

test('reduced motion preserves a readable static logo hold while shortening it', () => {
  assert.equal(FIRST_LAUNCH_SPLASH_HOLD_MS, 620);
  assert.equal(FIRST_LAUNCH_REDUCED_SPLASH_HOLD_MS, 420);
  assert.ok(FIRST_LAUNCH_REDUCED_SPLASH_HOLD_MS >= 350);
  assert.ok(FIRST_LAUNCH_REDUCED_SPLASH_HOLD_MS < FIRST_LAUNCH_SPLASH_HOLD_MS);
});

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('onboarding completion is explicit and versioned', () => {
  assert.equal(ONBOARDING_VERSION, 1);
  const storage = memoryStorage();
  assert.equal(hasCompletedOnboarding(storage), false);
  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ version: 0, completedAt: '2026-01-01T00:00:00.000Z' }));
  assert.equal(hasCompletedOnboarding(storage), false);
  completeOnboarding(storage, new Date('2026-08-26T10:00:00.000Z'));
  assert.equal(hasCompletedOnboarding(storage), true);
  assert.deepEqual(JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY)), {
    version: 1,
    completedAt: '2026-08-26T10:00:00.000Z',
  });
});

test('first-launch request deadlines abort hung work and clean their timer', async () => {
  let fireTimeout = null;
  let clearedTimer = null;
  let observedSignal = null;
  const pending = runWithAbortDeadline((signal) => {
    observedSignal = signal;
    return new Promise(() => {});
  }, {
    timeoutMs: 25,
    setTimeoutImpl(callback, delay) {
      assert.equal(delay, 25);
      fireTimeout = callback;
      return 73;
    },
    clearTimeoutImpl(timer) { clearedTimer = timer; },
  });
  await Promise.resolve();
  assert.equal(typeof fireTimeout, 'function');
  fireTimeout();
  await assert.rejects(pending, (error) => error?.code === 'REQUEST_TIMEOUT');
  assert.equal(observedSignal.aborted, true);
  assert.equal(clearedTimer, 73);
});

test('first-launch request deadlines clear without aborting completed work', async () => {
  let clearedTimer = null;
  let observedSignal = null;
  const result = await runWithAbortDeadline((signal) => {
    observedSignal = signal;
    return 'ready';
  }, {
    timeoutMs: 25,
    setTimeoutImpl() { return 91; },
    clearTimeoutImpl(timer) { clearedTimer = timer; },
  });
  assert.equal(result, 'ready');
  assert.equal(observedSignal.aborted, false);
  assert.equal(clearedTimer, 91);
});

test('provider discovery deadline covers a response body that never finishes', async () => {
  let fireTimeout = null;
  let observedSignal = null;
  const pending = discoverVkProvider(async (_url, options) => {
    observedSignal = options.signal;
    return {
      ok: true,
      json: () => new Promise(() => {}),
    };
  }, {
    timeoutMs: 25,
    setTimeoutImpl(callback, delay) {
      assert.equal(delay, 25);
      fireTimeout = callback;
      return 117;
    },
    clearTimeoutImpl() {},
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof fireTimeout, 'function');
  fireTimeout();
  await assert.rejects(pending, (error) => error?.code === 'REQUEST_TIMEOUT');
  assert.equal(observedSignal.aborted, true);
});

test('VK login start uses the JSON handshake and accepts the exact local callback', async () => {
  let observed = null;
  const authorizationUrl = await requestVkLoginStart(async (url, options) => {
    observed = { url, options };
    return {
      ok: true,
      json: async () => ({
        authorizationUrl: '/api/v1/auth/vk/callback?code=local-code&state=opaque&type=code_v2&device_id=local-device',
      }),
    };
  }, 'http://127.0.0.1:4319/');

  assert.equal(observed.url, '/api/v1/auth/vk/start?response=json');
  assert.equal(observed.options.credentials, 'same-origin');
  assert.equal(observed.options.cache, 'no-store');
  assert.equal(observed.options.headers.accept, 'application/json');
  assert.equal(observed.options.signal.aborted, false);
  assert.equal(authorizationUrl,
    'http://127.0.0.1:4319/api/v1/auth/vk/callback?code=local-code&state=opaque&type=code_v2&device_id=local-device');
});

test('VK login start deadline also covers a stalled JSON response body', async () => {
  let fireTimeout = null;
  let observedSignal = null;
  const pending = requestVkLoginStart(async (_url, options) => {
    observedSignal = options.signal;
    return {
      ok: true,
      json: () => new Promise(() => {}),
    };
  }, 'http://127.0.0.1:4319/', {
    timeoutMs: 25,
    setTimeoutImpl(callback, delay) {
      assert.equal(delay, 25);
      fireTimeout = callback;
      return 131;
    },
    clearTimeoutImpl() {},
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof fireTimeout, 'function');
  fireTimeout();
  await assert.rejects(pending, (error) => error?.code === 'REQUEST_TIMEOUT');
  assert.equal(observedSignal.aborted, true);
});

test('VK login start maps bounded server rate-limit and unavailable errors without copying server text', async () => {
  for (const [status, serverCode, authError] of [
    [429, 'RATE_LIMITED', 'rate_limited'],
    [503, 'VK_ID_UNAVAILABLE', 'unconfigured'],
    [503, 'PRIVATE_INTERNAL_DETAIL', 'start_failed'],
  ]) {
    await assert.rejects(requestVkLoginStart(async () => ({
      ok: false,
      status,
      json: async () => ({ error: { code: serverCode, message: 'private provider state and verifier' } }),
    }), 'https://aisy.example/'), (error) => {
      assert.equal(error.code, 'VK_ID_START_FAILED');
      assert.equal(error.authError, authError);
      assert.doesNotMatch(String(error.stack), /private provider state|verifier/u);
      return true;
    });
  }
});

test('VK login start accepts only the exact VK authorize endpoint or local callback', async () => {
  const handshake = (authorizationUrl) => async () => ({
    ok: true,
    json: async () => ({ authorizationUrl }),
  });
  const live = 'https://id.vk.ru/authorize?client_id=123456&state=opaque&code_challenge=challenge';
  assert.equal(await requestVkLoginStart(handshake(live), 'https://aisy.example/'), live);

  for (const unsafe of [
    'https://id.vk.ru.evil.example/authorize?state=opaque',
    'https://id.vk.ru/oauth2/auth?state=opaque',
    'https://user@id.vk.ru/authorize?state=opaque',
    'https://id.vk.ru/authorize?state=opaque#fragment',
    '/api/v1/auth/vk/start?state=opaque',
  ]) {
    await assert.rejects(
      requestVkLoginStart(handshake(unsafe), 'https://aisy.example/'),
      /VK_ID_START_TARGET_INVALID/u,
    );
  }
});

test('production first launch uses approved paper copy, four-step progress and VK-only learner login', async () => {
  const [html, css, theme, source, app, asya, shell] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/first-launch.css', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/aisy-theme.css', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/first-launch.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/asya-launcher.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/aisy-shell.js', import.meta.url), 'utf8'),
  ]);

  for (const copy of [
    'Личный маршрут', 'Каждый день — понятный шаг',
    'Практика ЕГЭ', 'Тренируй формат, а не догадки',
    'Честная статистика', 'Видишь, как растёт балл',
    'Войди — и продолжим с твоего шага',
  ]) assert.match(html, new RegExp(copy, 'u'));
  assert.equal((html.match(/data-first-launch-dot/gu) || []).length, 4);
  assert.match(html, /class="first-launch__progress"[^>]*role="progressbar"/u);
  for (const attribute of ['aria-valuemin="1"', 'aria-valuemax="4"', 'aria-valuenow="1"']) {
    assert.match(html, new RegExp(`class="first-launch__progress"[^>]*${attribute}`, 'u'));
  }
  assert.match(source, /ui\.progress\?\.setAttribute\('aria-valuenow', String\(currentStep \+ 1\)\)/u);
  assert.match(html, /class="[^"]*aisy-button[^"]*first-launch__vk-button/u);
  assert.match(source, /VK ID пока не подключён/u);
  assert.match(source, /Открываем VK ID…/u);
  assert.match(source, /rate_limited:\s*'Слишком много попыток входа/u);
  assert.match(source, /start_failed:\s*'Не удалось открыть VK ID/u);
  assert.match(source, /RATE_LIMITED:\s*'rate_limited'/u);
  assert.match(source, /VK_ID_UNAVAILABLE:\s*'unconfigured'/u);
  assert.match(source, /Object\.hasOwn\(AUTH_ERROR_MESSAGES, code\)/u,
    'navigation errors must not resolve inherited object properties as public copy');
  assert.match(source, /providerAbortController\?\.abort\(\)/u,
    'a retry or release must cancel the prior provider-discovery request');
  assert.match(html, /href="\/privacy\.html"/u);
  assert.doesNotMatch(html, /Telegram|tgbtn|tgClick/u);
  assert.match(css, /\.first-launch__view\[hidden\]/u);
  assert.match(css, /\.first-launch__copy h1\[tabindex="-1"\]:focus\s*\{\s*outline:\s*none/u);
  assert.match(css, /\.first-launch__copy p\s*\{[^}]*font:\s*700 16px\/1\.5/su,
    'approved onboarding body copy keeps the 16px readable floor');
  assert.match(css, /\.first-launch__status\s*\{[^}]*font:\s*700 16px\/1\.5/su,
    'provider and recovery status copy is body-sized, not a decorative label');
  assert.match(theme, /\.aisy-access-gate__copy\s*\{[^}]*font:\s*600 var\(--aisy-font-size-body\)\/1\.55/su,
    'subscription and network recovery copy consumes the 16px body token');
  assert.match(css, /\.first-launch__vk-button::after\s*\{[^}]*color:\s*var\(--aisy-button-affordance-foreground\)/su);
  assert.match(html, /first-launch__progress[\s\S]*data-first-launch-login-actions/u,
    'login progress precedes the provider action and legal/status footer');
  assert.match(source, /\.inert\s*=/u);
  assert.match(source, /ui\.flow\.scrollTop\s*=\s*0/u,
    'each compact-phone slide starts at its own top before focus moves');
  assert.doesNotMatch(source, /eb_tg_code[^\n]*(?:setInterval|setTimeout)|tgPoll|startTelegramLogin/u);
  assert.match(app, /showScreen:tab/u,
    'first-launch transitions must run route hooks so the learner shell stays hidden');
  assert.match(asya, /matches\('\[data-first-launch-screen\]'\)/u);
  assert.match(asya, /launcher\.inert=!enabled/u);
  assert.match(shell, /navigation\.inert=!currentProjection\.topLevel/u);
  assert.match(shell, /backControl\.inert=!currentProjection\.backTarget/u);
  assert.doesNotMatch(app, /showLogin\(\{message:'Войди, чтобы продолжить с сохранённого шага/u);
  assert.match(app, /runWithAbortDeadline\([\s\S]*checkLearningAccess\(null,\{deferPresentation:true,signal\}\)[\s\S]*FIRST_LAUNCH_SESSION_TIMEOUT_MS/u,
    'the canonical startup /me request must have a bounded abort deadline');
  assert.match(app, /access_gate_status[\s\S]*setAttribute\('role','status'\)[\s\S]*aria-live','polite'/u,
    'access retry transitions must have one dedicated polite status');
  assert.match(app, /if\(previousState\)[\s\S]*status\.textContent=''[\s\S]*requestAnimationFrame/u,
    'the live status announces every retry completion, including a same-state result');
  assert.match(html, /<h1 id="today-title" tabindex="-1">/u);
  assert.match(app, /firstLaunch\.release\(\);focusTodayHeading\(\)/u,
    'successful access bootstrap must move focus into Today after removing the dialog');
  assert.match(html, /id="profile_onboarding_restart" class="cardbtn aisy-surface profile-onboarding-restart">/u);
  assert.doesNotMatch(html, /id="profile_onboarding_restart"[^>]*style=/u,
    'profile onboarding replay has no inline presentation that can break dark theme');
});
