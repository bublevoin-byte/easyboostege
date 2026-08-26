import crypto from 'node:crypto';

const AUTHORIZE_URL = 'https://id.vk.ru/authorize';
const TOKEN_URL = 'https://id.vk.ru/oauth2/auth';
const USER_INFO_URL = 'https://id.vk.ru/oauth2/user_info';
const FLOW_KEY_LABEL = Buffer.from('vk-id-flow-v1', 'utf8');
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

export class VkIdError extends Error {
  constructor(code) {
    super(code);
    this.name = 'VkIdError';
    this.code = code;
  }
}

function providerError() {
  return new VkIdError('VK_ID_PROVIDER_ERROR');
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function createPkceChallenge(verifier) {
  const normalized = String(verifier || '');
  if (normalized.length < 43 || normalized.length > 128 || !BASE64URL.test(normalized)) {
    throw new VkIdError('VK_ID_FLOW_INVALID');
  }
  return crypto.createHash('sha256').update(normalized, 'ascii').digest('base64url');
}

export function createPkcePair(randomBytes = crypto.randomBytes) {
  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(32));
  return { state, codeVerifier, codeChallenge: createPkceChallenge(codeVerifier) };
}

export function hashVkState(state) {
  const normalized = String(state || '');
  if (!normalized || normalized.length > 256) throw new VkIdError('VK_ID_FLOW_INVALID');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function createVkFlowCipher(secret, randomBytes = crypto.randomBytes) {
  const source = String(secret || '');
  if (source.length < 16) throw new VkIdError('VK_ID_FLOW_SECRET_INVALID');
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(source, 'utf8'), Buffer.alloc(0), FLOW_KEY_LABEL, 32));

  function seal(value) {
    const plaintext = String(value || '');
    if (plaintext.length < 43 || plaintext.length > 128 || !BASE64URL.test(plaintext)) {
      throw new VkIdError('VK_ID_FLOW_INVALID');
    }
    const iv = randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(FLOW_KEY_LABEL);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${encrypted.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  function open(sealed) {
    try {
      const parts = String(sealed || '').split('.');
      if (parts.length !== 3 || parts.some((part) => !BASE64URL.test(part))) throw providerError();
      const decoded = parts.map((part) => Buffer.from(part, 'base64url'));
      if (decoded.some((value, index) => value.toString('base64url') !== parts[index])) throw providerError();
      const [iv, encrypted, tag] = decoded;
      if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) throw providerError();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(FLOW_KEY_LABEL);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      if (plaintext.length < 43 || plaintext.length > 128 || !BASE64URL.test(plaintext)) throw providerError();
      return plaintext;
    } catch (error) {
      if (error?.code === 'VK_ID_FLOW_INVALID') throw error;
      throw new VkIdError('VK_ID_FLOW_INVALID');
    }
  }

  return Object.freeze({ seal, open });
}

function boundedString(value, maximum) {
  const normalized = String(value || '').trim();
  return normalized.length <= maximum ? normalized : '';
}

function sameOpaqueValue(left, right) {
  const first = Buffer.from(String(left || ''), 'utf8');
  const second = Buffer.from(String(right || ''), 'utf8');
  return first.length === second.length && first.length > 0 && crypto.timingSafeEqual(first, second);
}

async function providerJson(response) {
  if (!response?.ok) throw providerError();
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) throw providerError();
  const reader = response.body?.getReader?.();
  if (!reader) throw providerError();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw providerError();
      }
      chunks.push(chunk);
    }
  } catch {
    throw providerError();
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks, total).toString('utf8');
  if (!text) throw providerError();
  let payload;
  try { payload = JSON.parse(text); } catch { throw providerError(); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.error) throw providerError();
  return payload;
}

function minimalIdentity(payload) {
  const user = payload?.user;
  const subject = boundedString(user?.user_id, 128);
  if (!/^\d{1,20}$/u.test(subject)) throw providerError();
  const firstName = boundedString(user?.first_name, 80);
  const lastName = boundedString(user?.last_name, 80);
  const displayName = [firstName, lastName].filter(Boolean).join(' ').slice(0, 160) || 'Ученик Aisy';
  return Object.freeze({ provider: 'vk', subject, displayName });
}

export function createLiveVkIdProvider({
  appId,
  redirectUri,
  scope = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const normalizedAppId = String(appId || '');
  const normalizedRedirect = String(redirectUri || '');
  if (!/^\d{1,20}$/u.test(normalizedAppId) || !normalizedRedirect || scope !== '' || typeof fetchImpl !== 'function') {
    throw new VkIdError('VK_ID_CONFIG_INVALID');
  }

  function authorizationUrl({ state, codeChallenge }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', normalizedAppId);
    url.searchParams.set('redirect_uri', normalizedRedirect);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', String(state));
    url.searchParams.set('code_challenge', String(codeChallenge));
    url.searchParams.set('code_challenge_method', 's256');
    return url.toString();
  }

  async function requestProviderJson(url, options) {
    try {
      const response = await fetchImpl(url, options);
      return await providerJson(response);
    } catch {
      throw providerError();
    }
  }

  async function authenticate({ code, state, deviceId, codeVerifier }) {
    const normalizedCode = boundedString(code, 2048);
    const normalizedState = boundedString(state, 256);
    const normalizedDevice = boundedString(deviceId, 256);
    createPkceChallenge(codeVerifier);
    if (!normalizedCode || !normalizedState || !normalizedDevice) throw providerError();

    const exchangeUrl = new URL(TOKEN_URL);
    exchangeUrl.searchParams.set('grant_type', 'authorization_code');
    exchangeUrl.searchParams.set('redirect_uri', normalizedRedirect);
    exchangeUrl.searchParams.set('client_id', normalizedAppId);
    exchangeUrl.searchParams.set('code_verifier', codeVerifier);
    exchangeUrl.searchParams.set('state', normalizedState);
    exchangeUrl.searchParams.set('device_id', normalizedDevice);
    const signal = AbortSignal.timeout(timeoutMs);
    const tokenPayload = await requestProviderJson(exchangeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: normalizedCode }),
      signal,
      redirect: 'error',
    });
    const accessToken = boundedString(tokenPayload.access_token, 8192);
    const responseState = boundedString(tokenPayload.state, 256);
    if (!accessToken || !sameOpaqueValue(responseState, normalizedState)) throw providerError();

    const userInfoUrl = new URL(USER_INFO_URL);
    userInfoUrl.searchParams.set('client_id', normalizedAppId);
    const userPayload = await requestProviderJson(userInfoUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: accessToken }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    return minimalIdentity(userPayload);
  }

  return Object.freeze({ mode: 'live', authorizationUrl, authenticate });
}

export function createVkTransactionRetention({
  purge,
  intervalMs = 5 * 60 * 1_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  onError = () => {},
} = {}) {
  if (typeof purge !== 'function' || !Number.isInteger(intervalMs) || intervalMs < 60_000) {
    throw new VkIdError('VK_ID_RETENTION_CONFIG_INVALID');
  }
  let timer = null;
  let started = false;

  async function sweep() {
    try { return await purge({ now: new Date() }); }
    catch { onError({ code: 'VK_ID_TRANSACTION_PURGE_FAILED' }); return 0; }
  }

  function start() {
    if (started) return;
    started = true;
    void sweep();
    timer = setIntervalImpl(() => { void sweep(); }, intervalMs);
    timer?.unref?.();
  }

  function stop() {
    if (!started) return;
    started = false;
    if (timer != null) clearIntervalImpl(timer);
    timer = null;
  }

  return Object.freeze({ start, stop, sweep });
}

export function createLocalVkIdProvider({
  subject = 'local-learner',
  displayName = 'Локальная ученица',
  redirectUri,
} = {}) {
  const normalizedSubject = boundedString(subject, 128);
  const normalizedDisplayName = boundedString(displayName, 160);
  let normalizedRedirect;
  try { normalizedRedirect = new URL(String(redirectUri || '')); } catch { throw new VkIdError('VK_ID_CONFIG_INVALID'); }
  if (!normalizedSubject || !normalizedDisplayName
    || !['http:', 'https:'].includes(normalizedRedirect.protocol)
    || normalizedRedirect.username || normalizedRedirect.password
    || normalizedRedirect.pathname !== '/api/v1/auth/vk/callback'
    || normalizedRedirect.search || normalizedRedirect.hash) {
    throw new VkIdError('VK_ID_CONFIG_INVALID');
  }
  return Object.freeze({
    mode: 'local',
    authorizationUrl({ state }) {
      const callback = new URL(normalizedRedirect);
      callback.searchParams.set('code', 'local-code');
      callback.searchParams.set('state', String(state));
      callback.searchParams.set('device_id', 'local-device');
      callback.searchParams.set('type', 'code_v2');
      return callback.toString();
    },
    async authenticate({ code }) {
      if (!boundedString(code, 2048)) throw providerError();
      return Object.freeze({ provider: 'vk', subject: normalizedSubject, displayName: normalizedDisplayName });
    },
  });
}
