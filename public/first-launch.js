export const ONBOARDING_VERSION = 1;
export const ONBOARDING_STORAGE_KEY = 'aisy.onboarding.completion';
export const FIRST_LAUNCH_REQUEST_TIMEOUT_MS = 6_000;
export const FIRST_LAUNCH_SPLASH_HOLD_MS = 620;
export const FIRST_LAUNCH_REDUCED_SPLASH_HOLD_MS = 420;

const AUTH_ERROR_MESSAGES = Object.freeze({
  cancelled: 'Вход отменён. Можно попробовать снова.',
  expired: 'Время входа истекло. Начни ещё раз.',
  replayed: 'Эта ссылка входа уже использована. Начни ещё раз.',
  provider: 'VK ID не ответил. Попробуй ещё раз чуть позже.',
  unconfigured: 'Вход через VK ID пока недоступен.',
  invalid: 'Не удалось подтвердить вход. Начни ещё раз.',
  failed: 'Не удалось завершить вход. Попробуй ещё раз.',
  rate_limited: 'Слишком много попыток входа. Попробуй ещё раз позже.',
  start_failed: 'Не удалось открыть VK ID. Проверь сеть и попробуй ещё раз.',
});
const LOGIN_LABEL = 'Войти через VK ID';
const VK_LOGIN_START_PATH = '/api/v1/auth/vk/start?response=json';
const VK_LOCAL_CALLBACK_PATH = '/api/v1/auth/vk/callback';
const VK_AUTHORIZE_ORIGIN = 'https://id.vk.ru';
const VK_AUTHORIZE_PATH = '/authorize';
const START_FAILURE_CODES = Object.freeze({
  RATE_LIMITED: 'rate_limited',
  VK_ID_UNAVAILABLE: 'unconfigured',
  VK_ID_START_FAILED: 'start_failed',
});

function requestDeadlineError() {
  return Object.assign(new Error('FIRST_LAUNCH_REQUEST_TIMEOUT'), { code: 'REQUEST_TIMEOUT' });
}

export async function runWithAbortDeadline(operation, {
  timeoutMs = FIRST_LAUNCH_REQUEST_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  AbortControllerImpl = AbortController,
  controller = new AbortControllerImpl(),
} = {}) {
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs) : FIRST_LAUNCH_REQUEST_TIMEOUT_MS;
  let abortListener = null;
  const aborted = new Promise((_, reject) => {
    abortListener = () => reject(controller.signal.reason instanceof Error
      ? controller.signal.reason
      : Object.assign(new Error('FIRST_LAUNCH_REQUEST_ABORTED'), { code: 'REQUEST_ABORTED' }));
    if (controller.signal.aborted) Promise.resolve().then(abortListener);
    else controller.signal.addEventListener('abort', abortListener, { once: true });
  });
  const timer = setTimeoutImpl(() => controller.abort(requestDeadlineError()), boundedTimeout);
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      aborted,
    ]);
  } finally {
    clearTimeoutImpl(timer);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
  }
}

export function discoverVkProvider(fetchImpl, deadlineOptions = {}) {
  return runWithAbortDeadline(async (signal) => {
    const response = await fetchImpl('/api/v1/auth/providers', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) throw new Error('PROVIDER_DISCOVERY_FAILED');
    return response.json();
  }, deadlineOptions);
}

function validatedVkLoginTarget(value, currentHref) {
  let current;
  let target;
  try {
    current = new URL(currentHref);
    target = new URL(String(value || ''), current);
  } catch {
    throw new Error('VK_ID_START_TARGET_INVALID');
  }
  const localCallback = target.origin === current.origin && target.pathname === VK_LOCAL_CALLBACK_PATH;
  const liveAuthorize = target.origin === VK_AUTHORIZE_ORIGIN && target.pathname === VK_AUTHORIZE_PATH;
  if (target.username || target.password || target.hash || (!localCallback && !liveAuthorize)) {
    throw new Error('VK_ID_START_TARGET_INVALID');
  }
  return target.toString();
}

export function requestVkLoginStart(fetchImpl, currentHref, deadlineOptions = {}) {
  return runWithAbortDeadline(async (signal) => {
    const response = await fetchImpl(VK_LOGIN_START_PATH, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    });
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch {}
      const serverCode = typeof payload?.error?.code === 'string' && payload.error.code.length <= 64
        ? payload.error.code : '';
      const authError = START_FAILURE_CODES[serverCode]
        || (response.status === 429 ? 'rate_limited' : 'start_failed');
      throw Object.assign(new Error('VK_ID_START_FAILED'), { code: 'VK_ID_START_FAILED', authError });
    }
    const payload = await response.json();
    return validatedVkLoginTarget(payload?.authorizationUrl, currentHref);
  }, deadlineOptions);
}

export function hasCompletedOnboarding(storage) {
  try {
    const value = JSON.parse(storage.getItem(ONBOARDING_STORAGE_KEY) || 'null');
    return value?.version === ONBOARDING_VERSION && typeof value.completedAt === 'string';
  } catch {
    return false;
  }
}

export function completeOnboarding(storage, now = new Date()) {
  const completion = { version: ONBOARDING_VERSION, completedAt: new Date(now).toISOString() };
  try { storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(completion)); } catch {}
  return completion;
}

function removeLegacyLearnerAuth(storage) {
  try { storage.removeItem('eb_tg_code'); } catch {}
}

export function createFirstLaunchController({
  document,
  location,
  history,
  storage,
  fetchImpl,
  showScreen,
  matchMedia,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  AbortControllerImpl = AbortController,
  providerTimeoutMs = FIRST_LAUNCH_REQUEST_TIMEOUT_MS,
  now = () => new Date(),
} = {}) {
  let wired = false;
  let currentStep = 0;
  let gateResolve = null;
  let restartReturnScreen = '';
  let providerRequest = 0;
  let providerAbortController = null;
  let loginAbortController = null;

  const elements = () => ({
    splash: document.getElementById('scr0'),
    flow: document.getElementById('scr5'),
    views: [...document.querySelectorAll('[data-first-launch-step]')],
    dots: [...document.querySelectorAll('[data-first-launch-dot]')],
    next: document.querySelector('[data-first-launch-next]'),
    loginActions: document.querySelector('[data-first-launch-login-actions]'),
    login: document.querySelector('[data-first-launch-login]'),
    retry: document.querySelector('[data-first-launch-retry]'),
    skip: document.querySelector('[data-first-launch-skip]'),
    progress: document.querySelector('.first-launch__progress'),
    status: document.getElementById('first_launch_status'),
  });

  function activateScreen(id) {
    if (typeof showScreen === 'function') showScreen(id);
    const { splash, flow } = elements();
    for (const screen of [splash, flow]) {
      if (!screen) continue;
      const active = screen.id === id;
      screen.hidden = !active;
      screen.inert = !active;
    }
  }

  function setStatus(message, kind = '') {
    const status = elements().status;
    if (!status) return;
    status.textContent = message || '';
    status.dataset.kind = kind;
  }

  function showStep(step) {
    const ui = elements();
    currentStep = Math.max(0, Math.min(3, Number(step) || 0));
    activateScreen('scr5');
    if (ui.flow) ui.flow.scrollTop = 0;
    ui.views.forEach((view) => {
      const active = Number(view.dataset.firstLaunchStep) === currentStep;
      view.hidden = !active;
      view.inert = !active;
      view.setAttribute('aria-hidden', String(!active));
    });
    ui.dots.forEach((dot, index) => {
      if (index === currentStep) dot.setAttribute('aria-current', 'step');
      else dot.removeAttribute('aria-current');
    });
    ui.progress?.setAttribute('aria-label', `Шаг ${currentStep + 1} из 4`);
    ui.progress?.setAttribute('aria-valuenow', String(currentStep + 1));
    const loginStep = currentStep === 3;
    if (ui.next) {
      ui.next.hidden = loginStep;
      ui.next.inert = loginStep;
      const nextLabel = currentStep === 2 ? 'Начать' : 'Далее';
      ui.next.textContent = nextLabel;
      ui.next.setAttribute('aria-label', nextLabel);
      if (ui.skip) {
        ui.skip.hidden = loginStep;
        ui.skip.inert = loginStep;
      }
    }
    if (ui.loginActions) {
      ui.loginActions.hidden = !loginStep;
      ui.loginActions.inert = !loginStep;
    }
    const heading = ui.views[currentStep]?.querySelector('h1');
    queueMicrotask(() => {
      heading?.focus({ preventScroll: true });
      if (ui.flow) ui.flow.scrollTop = 0;
    });
  }

  function finishOnboarding() {
    completeOnboarding(storage, now());
    if (restartReturnScreen) {
      const target = restartReturnScreen;
      restartReturnScreen = '';
      if (typeof showScreen === 'function') showScreen(target);
      return;
    }
    if (gateResolve) {
      gateResolve();
      gateResolve = null;
      return;
    }
    showLogin();
  }

  function nextStep() {
    if (currentStep < 2) showStep(currentStep + 1);
    else finishOnboarding();
  }

  function consumeAuthError() {
    let error = '';
    try {
      const url = new URL(location.href);
      const code = url.searchParams.get('auth_error') || '';
      error = Object.hasOwn(AUTH_ERROR_MESSAGES, code)
        ? AUTH_ERROR_MESSAGES[code]
        : (code ? 'Не удалось войти. Попробуй ещё раз.' : '');
      if (code) {
        url.searchParams.delete('auth_error');
        history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {}
    return error;
  }

  async function refreshProvider() {
    const ui = elements();
    if (!ui.login || !ui.retry) return false;
    const revision = ++providerRequest;
    providerAbortController?.abort();
    const controller = new AbortControllerImpl();
    providerAbortController = controller;
    ui.login.disabled = true;
    ui.login.textContent = 'Проверяем VK ID…';
    ui.login.setAttribute('aria-label', 'Проверяем VK ID…');
    ui.login.setAttribute('aria-busy', 'true');
    ui.retry.hidden = true;
    ui.retry.inert = true;
    setStatus('Проверяем доступность VK ID…');
    try {
      const payload = await discoverVkProvider(fetchImpl, {
        timeoutMs: providerTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
        AbortControllerImpl,
        controller,
      });
      if (revision !== providerRequest) return false;
      if (payload?.vk?.enabled !== true) {
        ui.login.textContent = 'VK ID пока не подключён';
        ui.login.setAttribute('aria-label', 'VK ID пока не подключён');
        setStatus('VK ID ещё не настроен на этом сервере. Войти сейчас не получится.', 'unavailable');
        ui.retry.hidden = false;
        ui.retry.inert = false;
        return false;
      }
      ui.login.disabled = false;
      ui.login.textContent = LOGIN_LABEL;
      ui.login.setAttribute('aria-label', LOGIN_LABEL);
      setStatus('VK ID готов к безопасному входу.', 'ready');
      return true;
    } catch {
      if (revision !== providerRequest) return false;
      ui.login.textContent = LOGIN_LABEL;
      ui.login.setAttribute('aria-label', LOGIN_LABEL);
      setStatus('Не удалось проверить VK ID. Проверь сеть и повтори.', 'error');
      ui.retry.hidden = false;
      ui.retry.inert = false;
      return false;
    } finally {
      if (revision === providerRequest) {
        providerAbortController = null;
        ui.login.removeAttribute('aria-busy');
      }
    }
  }

  async function beginLogin() {
    const ui = elements();
    const button = ui.login;
    if (!button || button.disabled) return;
    loginAbortController?.abort();
    const controller = new AbortControllerImpl();
    loginAbortController = controller;
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    button.textContent = 'Открываем VK ID…';
    button.setAttribute('aria-label', 'Открываем VK ID…');
    if (ui.retry) {
      ui.retry.hidden = true;
      ui.retry.inert = true;
    }
    setStatus('Открываем VK ID…');
    try {
      const authorizationUrl = await requestVkLoginStart(fetchImpl, location.href, {
        timeoutMs: providerTimeoutMs,
        setTimeoutImpl,
        clearTimeoutImpl,
        AbortControllerImpl,
        controller,
      });
      location.assign(authorizationUrl);
    } catch (error) {
      button.disabled = false;
      button.textContent = LOGIN_LABEL;
      button.setAttribute('aria-label', LOGIN_LABEL);
      button.removeAttribute('aria-busy');
      const authError = Object.hasOwn(AUTH_ERROR_MESSAGES, error?.authError) ? error.authError : 'start_failed';
      setStatus(AUTH_ERROR_MESSAGES[authError], 'error');
      if (ui.retry) {
        ui.retry.hidden = false;
        ui.retry.inert = false;
      }
    } finally {
      if (loginAbortController === controller) loginAbortController = null;
    }
  }

  function wire() {
    if (wired) return;
    wired = true;
    const ui = elements();
    ui.next?.addEventListener('click', nextStep);
    ui.skip?.addEventListener('click', finishOnboarding);
    ui.login?.addEventListener('click', () => { void beginLogin(); });
    ui.retry?.addEventListener('click', refreshProvider);
    document.getElementById('profile_onboarding_restart')?.addEventListener('click', restart);
  }

  function showLogin({ message = '' } = {}) {
    wire();
    showStep(3);
    const authError = consumeAuthError();
    if (message || authError) setStatus(message || authError, authError ? 'error' : '');
    void refreshProvider().then((ready) => {
      if (!ready) {
        if (authError) setStatus(authError, 'error');
        return;
      }
      if (message || authError) setStatus(message || authError, authError ? 'error' : '');
    });
  }

  async function start() {
    wire();
    removeLegacyLearnerAuth(storage);
    activateScreen('scr0');
    const reduced = Boolean(matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    await new Promise((resolve) => setTimeoutImpl(resolve,
      reduced ? FIRST_LAUNCH_REDUCED_SPLASH_HOLD_MS : FIRST_LAUNCH_SPLASH_HOLD_MS));
    if (hasCompletedOnboarding(storage)) {
      return;
    }
    showStep(0);
    return new Promise((resolve) => { gateResolve = resolve; });
  }

  function restart() {
    wire();
    const active = document.querySelector('.screen.on');
    restartReturnScreen = active && !['scr0', 'scr5'].includes(active.id) ? active.id : '';
    showStep(0);
  }

  function release() {
    providerRequest += 1;
    providerAbortController?.abort();
    providerAbortController = null;
    loginAbortController?.abort();
    loginAbortController = null;
    const { splash, flow } = elements();
    for (const screen of [splash, flow]) {
      if (!screen) continue;
      screen.hidden = true;
      screen.inert = true;
    }
  }

  return Object.freeze({ start, showLogin, restart, refreshProvider, release, hasCompleted: () => hasCompletedOnboarding(storage) });
}
