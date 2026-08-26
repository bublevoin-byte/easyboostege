import crypto from 'node:crypto';
import express from 'express';

import { createPkcePair, hashVkState } from '../services/vk-id.js';

const FLOW_COOKIE = 'eb_vk_flow';
const REPLAY_COOKIE = 'eb_vk_replay';
const CALLBACK_PATH = '/api/v1/auth/vk/callback';
const FLOW_COOKIE_PATH = CALLBACK_PATH;
const FLOW_COOKIE_GRACE_SECONDS = 300;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const NAVIGATION_ERROR_CODES = new Set([
  'cancelled', 'expired', 'replayed', 'provider', 'unconfigured', 'invalid', 'failed',
  'rate_limited', 'start_failed',
]);
const FORWARDED_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto',
];

function secureSuffix(req, config) {
  return config.secureCookies || req.secure === true || req.protocol === 'https' ? '; Secure' : '';
}

function setPrivateRedirectHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function boundedQuery(req, name, maximum) {
  const value = req.query[name];
  return typeof value === 'string' && value.length <= maximum ? value : '';
}

function sameOpaqueValue(left, right) {
  const first = Buffer.from(String(left || ''), 'utf8');
  const second = Buffer.from(String(right || ''), 'utf8');
  return first.length === second.length && first.length > 0 && crypto.timingSafeEqual(first, second);
}

function errorRedirect(res, code) {
  setPrivateRedirectHeaders(res);
  const publicCode = NAVIGATION_ERROR_CODES.has(code) ? code : 'failed';
  return res.redirect(303, `/?auth_error=${publicCode}`);
}

function isTopLevelNavigation(req) {
  const fetchMode = String(req.get('sec-fetch-mode') || '').trim().toLowerCase();
  const accept = String(req.get('accept') || '').toLowerCase();
  return fetchMode === 'navigate' || accept.split(',').some((value) => value.trim().startsWith('text/html'));
}

function isJsonStartHandshake(req) {
  return req.path === '/api/v1/auth/vk/start' && req.query.response === 'json';
}

function isDirectLocalRequest(req, config) {
  if (config.mode !== 'local') return true;
  if (FORWARDED_HEADERS.some((name) => String(req.get(name) || '').trim())) return false;
  let expectedAuthority;
  try { expectedAuthority = String(config.localAuthority || new URL(config.redirectUri).host).toLowerCase(); }
  catch { return false; }
  try {
    const actual = new URL(`http://${String(req.get('host') || '').trim()}`);
    return !actual.username && !actual.password && actual.host.toLowerCase() === expectedAuthority;
  } catch {
    return false;
  }
}

function startFailure(req, res, { authError, status, code, message }) {
  if (!isJsonStartHandshake(req) && isTopLevelNavigation(req)) return errorRedirect(res, authError);
  return res.status(status).json({ error: { code, message } });
}

export function createVkRateLimitHandler() {
  return function vkRateLimitHandler(req, res, _next, options = {}) {
    setPrivateRedirectHeaders(res);
    if (!isJsonStartHandshake(req) && isTopLevelNavigation(req)) return errorRedirect(res, 'rate_limited');
    const status = Number(options.statusCode) || 429;
    const message = options.message && typeof options.message === 'object'
      ? options.message
      : { error: { code: 'RATE_LIMITED', message: 'Слишком много попыток входа. Попробуйте позже.' } };
    return res.status(status).json(message);
  };
}

export function createVkAuthRoutes({
  config,
  provider,
  flowCipher,
  authentication,
  db,
  limiters = {},
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
}) {
  const router = express.Router();
  const startLimiter = limiters.start || ((req, res, next) => next());
  const callbackLimiter = limiters.callback || ((req, res, next) => next());
  const { appendCookie, issueToken, readCookie, setAuthCookie } = authentication;

  router.use((req, res, next) => {
    if (isDirectLocalRequest(req, config)) return next();
    setPrivateRedirectHeaders(res);
    return res.status(404).end();
  });

  function appendResponseCookie(res, value) {
    if (typeof appendCookie === 'function') appendCookie(res, value);
    else {
      const existing = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', existing ? [existing, value].flat() : value);
    }
  }

  function setFlowCookie(req, res, state) {
    appendResponseCookie(res, `${FLOW_COOKIE}=${encodeURIComponent(state)}; Path=${FLOW_COOKIE_PATH}; Max-Age=${config.flowTtlSeconds + FLOW_COOKIE_GRACE_SECONDS}; HttpOnly; SameSite=Lax${secureSuffix(req, config)}`);
  }

  function clearFlowCookie(req, res) {
    appendResponseCookie(res, `${FLOW_COOKIE}=; Path=${FLOW_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secureSuffix(req, config)}`);
  }

  function setReplayCookie(req, res, state) {
    appendResponseCookie(res, `${REPLAY_COOKIE}=${encodeURIComponent(state)}; Path=${FLOW_COOKIE_PATH}; Max-Age=${FLOW_COOKIE_GRACE_SECONDS}; HttpOnly; SameSite=Lax${secureSuffix(req, config)}`);
  }

  function clearReplayCookie(req, res) {
    appendResponseCookie(res, `${REPLAY_COOKIE}=; Path=${FLOW_COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secureSuffix(req, config)}`);
  }

  router.get('/api/v1/auth/providers', (req, res) => {
    setPrivateRedirectHeaders(res);
    res.json({ vk: { enabled: config.enabled === true } });
  });

  router.get('/api/v1/auth/vk/start', (req, res, next) => {
    setPrivateRedirectHeaders(res);
    next();
  }, startLimiter, async (req, res) => {
    if (config.enabled !== true || !provider) {
      return startFailure(req, res, {
        authError: 'unconfigured', status: 503,
        code: 'VK_ID_UNAVAILABLE', message: 'VK ID пока не подключён.',
      });
    }
    try {
      const instant = new Date(now());
      const { state, codeVerifier, codeChallenge } = createPkcePair(randomBytes);
      await db.createOAuthTransaction({
        provider: 'vk',
        stateHash: hashVkState(state),
        verifierSealed: flowCipher.seal(codeVerifier),
        redirectUri: config.redirectUri,
        expiresAt: new Date(instant.getTime() + config.flowTtlSeconds * 1_000),
        now: instant,
      });
      clearReplayCookie(req, res);
      setFlowCookie(req, res, state);
      const authorizationUrl = provider.authorizationUrl({ state, codeChallenge });
      if (isJsonStartHandshake(req)) return res.json({ authorizationUrl });
      return res.redirect(302, authorizationUrl);
    } catch {
      return startFailure(req, res, {
        authError: 'start_failed', status: 503,
        code: 'VK_ID_START_FAILED', message: 'Не удалось начать вход. Попробуйте ещё раз.',
      });
    }
  });

  router.get(CALLBACK_PATH, (req, res, next) => {
    setPrivateRedirectHeaders(res);
    clearFlowCookie(req, res);
    next();
  }, callbackLimiter, async (req, res) => {
    if (config.enabled !== true || !provider) return errorRedirect(res, 'unconfigured');

    const state = boundedQuery(req, 'state', 256);
    let cookieState = '';
    let replayState = '';
    try {
      cookieState = readCookie(req, FLOW_COOKIE);
      replayState = readCookie(req, REPLAY_COOKIE);
    } catch { return errorRedirect(res, 'invalid'); }
    if (!STATE_PATTERN.test(state)) return errorRedirect(res, 'invalid');
    if (!sameOpaqueValue(state, cookieState)) {
      return sameOpaqueValue(state, replayState) ? errorRedirect(res, 'replayed') : errorRedirect(res, 'invalid');
    }
    setReplayCookie(req, res, state);

    let consumed;
    try { consumed = await db.consumeOAuthTransaction(hashVkState(state), { now: new Date(now()) }); }
    catch { return errorRedirect(res, 'failed'); }
    if (consumed.status !== 'ready') {
      const result = ['expired', 'missing'].includes(consumed.status)
        ? 'expired' : consumed.status === 'replayed' ? 'replayed' : 'invalid';
      return errorRedirect(res, result);
    }
    if (consumed.transaction.provider !== 'vk' || consumed.transaction.redirectUri !== config.redirectUri) {
      return errorRedirect(res, 'invalid');
    }

    const providerError = boundedQuery(req, 'error', 64);
    if (providerError) {
      return errorRedirect(res, ['access_denied', 'user_denied', 'cancel'].includes(providerError)
        ? 'cancelled' : 'provider');
    }
    const code = boundedQuery(req, 'code', 2_048);
    const deviceId = boundedQuery(req, 'device_id', 256);
    const responseType = boundedQuery(req, 'type', 32);
    if (!code || !deviceId || responseType !== 'code_v2') return errorRedirect(res, 'invalid');

    let verifier;
    try { verifier = flowCipher.open(consumed.transaction.verifierSealed); }
    catch { return errorRedirect(res, 'invalid'); }

    let identity;
    try {
      identity = await provider.authenticate({ code, state, deviceId, codeVerifier: verifier });
    } catch {
      return errorRedirect(res, 'provider');
    }
    if (!identity || identity.provider !== 'vk') return errorRedirect(res, 'provider');

    try {
      const user = await db.findOrCreateProviderUser({ ...identity, now: new Date(now()) });
      const token = await issueToken(user.username);
      setAuthCookie(req, res, token);
      return res.redirect(303, '/');
    } catch {
      return errorRedirect(res, 'failed');
    }
  });

  return router;
}
