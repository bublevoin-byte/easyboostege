import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createApiVersionRewrite } from '../middleware/api-version.js';
import { createAuthentication } from '../middleware/authentication.js';
import { createAnonymousIpLimiter } from '../middleware/subscription.js';
import { createVkAuthRoutes, createVkRateLimitHandler } from '../routes/vk-auth.js';
import { createLocalVkIdProvider, createVkFlowCipher } from '../services/vk-id.js';
import { createFileRepository } from '../storage/file-repository.js';
import { createUserRoutes } from '../routes/users.js';

const SECRET = 'vk-id-route-tests-use-a-secret-longer-than-32-characters';
const CALLBACK_PATH = '/api/v1/auth/vk/callback';
const noLimit = (req, res, next) => next();

function cookieFrom(response, name) {
  const header = response.headers.get('set-cookie') || '';
  const match = header.match(new RegExp(`(?:^|,\\s*)${name}=([^;]*)`, 'u'));
  return match ? `${name}=${match[1]}` : '';
}

async function withVkApp(run, {
  enabled = true,
  provider: providerOverride,
  limiters = {},
  anonymousLimit = 0,
  legacyApi = false,
  mode = enabled ? 'local' : 'disabled',
  trustProxy = false,
  secureCookies = false,
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-vk-route-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const clock = { value: new Date('2026-08-26T10:00:00.000Z') };
  const authentication = createAuthentication({
    secret: SECRET,
    sessionDays: 30,
    monitoringToken: '',
    createSession: repository.createSession,
    getUser: repository.getUser,
    isSessionActive: repository.isSessionActive,
    secureCookies,
  });
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const redirectUri = `${baseUrl}${CALLBACK_PATH}`;
  const local = createLocalVkIdProvider({
    subject: 'route-local-user', displayName: 'Ася Тестова',
    redirectUri,
  });
  const provider = providerOverride || local;
  const config = {
    mode, enabled,
    redirectUri,
    localAuthority: new URL(baseUrl).host,
    flowTtlSeconds: 600,
    secureCookies,
  };
  const app = express();
  if (trustProxy) app.set('trust proxy', 1);
  if (anonymousLimit > 0) app.use('/api', createAnonymousIpLimiter(anonymousLimit));
  if (legacyApi) app.use(createApiVersionRewrite({ enabled: true, log() {} }));
  app.use(createVkAuthRoutes({
    config,
    provider: enabled ? provider : null,
    flowCipher: createVkFlowCipher(SECRET),
    authentication,
    db: repository,
    limiters: { start: limiters.start || noLimit, callback: limiters.callback || noLimit },
    now: () => new Date(clock.value),
  }));
  app.use(createUserRoutes({
    secret: SECRET,
    telegramEnabled: () => false,
    botUsername: () => '',
    authCodeTtlMs: 600_000,
    privacyPolicyVersion: 'test-v1',
    limiters: { telegramStart: noLimit, telegramCheck: noLimit },
    authentication,
    buildMonitoringSnapshot: async () => ({}),
    promoteConfiguredAdmin: async () => {},
    db: repository,
    voiceTutorLimits: {},
  }));
  server.on('request', app);
  const request = (pathname, options = {}) => fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    ...options,
    headers: { Host: '127.0.0.1', ...options.headers },
  });
  const rawRequest = (pathname, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request(new URL(pathname, baseUrl), { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          headers: { get: (name) => {
            const value = response.headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value ?? null;
          } },
          json: async () => JSON.parse(body),
        });
      });
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
  try { await run({ request, rawRequest, repository, clock, baseUrl }); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('provider discovery fails closed without exposing mode or configuration', async () => {
  await withVkApp(async ({ request }) => {
    const providers = await request('/api/v1/auth/providers');
    assert.equal(providers.status, 200);
    assert.equal(providers.headers.get('cache-control'), 'no-store');
    assert.equal(providers.headers.get('pragma'), 'no-cache');
    assert.deepEqual(await providers.json(), { vk: { enabled: false } });

    const start = await request('/api/v1/auth/vk/start');
    assert.equal(start.status, 503);
    assert.equal((await start.json()).error.code, 'VK_ID_UNAVAILABLE');
    assert.equal(start.headers.get('set-cookie'), null);

    const navigation = await request('/api/v1/auth/vk/start', { headers: { Accept: 'text/html' } });
    assert.equal(navigation.status, 303);
    assert.equal(navigation.headers.get('location'), '/?auth_error=unconfigured');
    assert.equal(navigation.headers.get('cache-control'), 'no-store');
    assert.equal(navigation.headers.get('referrer-policy'), 'no-referrer');

    const handshake = await request('/api/v1/auth/vk/start?response=json', {
      headers: { Accept: 'text/html' },
    });
    assert.equal(handshake.status, 503);
    assert.equal((await handshake.json()).error.code, 'VK_ID_UNAVAILABLE');
  }, { enabled: false });
});

test('top-level start failures return a sanitized recoverable app redirect', async () => {
  const provider = {
    authorizationUrl() { throw new Error('private provider URL and state'); },
    authenticate() { throw new Error('not reached'); },
  };
  await withVkApp(async ({ request }) => {
    const navigation = await request('/api/v1/auth/vk/start', { headers: { Accept: 'text/html' } });
    assert.equal(navigation.status, 303);
    assert.equal(navigation.headers.get('location'), '/?auth_error=start_failed');
    assert.doesNotMatch(navigation.headers.get('location'), /private|state|code|device/u);
    assert.equal(navigation.headers.get('cache-control'), 'no-store');
    assert.equal(navigation.headers.get('pragma'), 'no-cache');
    assert.equal(navigation.headers.get('referrer-policy'), 'no-referrer');

    const machine = await request('/api/v1/auth/vk/start', { headers: { Accept: 'application/json' } });
    assert.equal(machine.status, 503);
    assert.equal((await machine.json()).error.code, 'VK_ID_START_FAILED');
  }, { provider });
});

test('local VK flow traverses transaction, identity and cookie-session seams without granting access', async () => {
  await withVkApp(async ({ request }) => {
    const start = await request('/api/v1/auth/vk/start');
    assert.equal(start.status, 302);
    assert.equal(start.headers.get('cache-control'), 'no-store');
    assert.equal(start.headers.get('pragma'), 'no-cache');
    assert.equal(start.headers.get('referrer-policy'), 'no-referrer');
    assert.match(start.headers.get('set-cookie') || '', /eb_vk_flow=[^;]+; Path=\/api\/v1\/auth\/vk\/callback; Max-Age=900;/u);
    const flowCookie = cookieFrom(start, 'eb_vk_flow');
    assert.match(flowCookie, /^eb_vk_flow=[A-Za-z0-9_-]{43}$/u);
    const callbackLocation = new URL(start.headers.get('location'), 'http://local.test');
    assert.equal(callbackLocation.pathname, CALLBACK_PATH);

    const callback = await request(`${callbackLocation.pathname}${callbackLocation.search}`, {
      headers: { Cookie: flowCookie },
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/');
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    assert.doesNotMatch(callback.headers.get('location'), /code|state|device/u);
    const cookies = callback.headers.get('set-cookie') || '';
    assert.match(cookies, /eb_vk_flow=; Path=\/api\/v1\/auth\/vk\/callback;[^,]*Max-Age=0[^,]*HttpOnly[^,]*SameSite=Lax/u);
    assert.match(cookies, /eb_vk_replay=[^;]+; Path=\/api\/v1\/auth\/vk\/callback; Max-Age=300;[^,]*HttpOnly[^,]*SameSite=Lax/u);
    assert.match(cookies, /eb_token=[^;,]+;[^,]*HttpOnly[^,]*SameSite=Lax/u);

    const authCookie = cookieFrom(callback, 'eb_token');
    const me = await request('/api/v1/me', { headers: { Cookie: authCookie } });
    assert.equal(me.status, 200);
    const session = await me.json();
    assert.equal(session.authenticated, true);
    assert.equal(session.displayName, 'Ася Тестова');
    assert.equal(session.active, false);
    assert.equal('subject' in session, false);
    assert.equal('identity_subject' in session, false);

    const replay = await request(`${callbackLocation.pathname}${callbackLocation.search}`, {
      headers: { Cookie: cookieFrom(callback, 'eb_vk_replay') },
    });
    assert.equal(replay.status, 303);
    assert.equal(replay.headers.get('location'), '/?auth_error=replayed');
    assert.match(replay.headers.get('set-cookie') || '', /eb_vk_flow=;[^,]*Max-Age=0/u);
    assert.doesNotMatch(replay.headers.get('set-cookie') || '', /eb_token=/u);
  });
});

test('JSON start handshake returns the absolute authorization URL with the same private flow cookie', async () => {
  await withVkApp(async ({ request, baseUrl }) => {
    const start = await request('/api/v1/auth/vk/start?response=json', {
      headers: { Accept: 'application/json' },
    });
    assert.equal(start.status, 200);
    assert.equal(start.headers.get('cache-control'), 'no-store');
    assert.equal(start.headers.get('pragma'), 'no-cache');
    assert.equal(start.headers.get('referrer-policy'), 'no-referrer');
    assert.match(start.headers.get('set-cookie') || '', /eb_vk_flow=[^;]+; Path=\/api\/v1\/auth\/vk\/callback;/u);

    const payload = await start.json();
    assert.deepEqual(Object.keys(payload), ['authorizationUrl']);
    const authorization = new URL(payload.authorizationUrl);
    assert.equal(authorization.origin, baseUrl);
    assert.equal(authorization.pathname, CALLBACK_PATH);

    const callback = await request(`${authorization.pathname}${authorization.search}`, {
      headers: { Cookie: cookieFrom(start, 'eb_vk_flow') },
    });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/');
    assert.match(callback.headers.get('set-cookie') || '', /eb_token=[^;,]+/u);
  });
});

test('trusted HTTPS proxy chains keep every VK flow and session cookie Secure', async () => {
  await withVkApp(async ({ rawRequest }) => {
    const headers = { 'X-Forwarded-Proto': 'https, http', Accept: 'application/json' };
    const start = await rawRequest('/api/v1/auth/vk/start?response=json', { headers });
    assert.equal(start.status, 200);
    assert.match(start.headers.get('set-cookie') || '', /eb_vk_flow=[^;]+;[^,]*; Secure/u);
    const payload = await start.json();
    const callback = new URL(payload.authorizationUrl);
    const response = await rawRequest(`${callback.pathname}${callback.search}`, {
      headers: { ...headers, Cookie: cookieFrom(start, 'eb_vk_flow') },
    });
    assert.equal(response.status, 303);
    const cookies = response.headers.get('set-cookie') || '';
    for (const name of ['eb_vk_flow', 'eb_vk_replay', 'eb_token']) {
      assert.match(cookies, new RegExp(`${name}=[^,]*; Secure`, 'u'));
    }
  }, { mode: 'live', trustProxy: true });
});

test('configured HTTPS origin keeps every VK flow and session cookie Secure without forwarded headers', async () => {
  await withVkApp(async ({ rawRequest }) => {
    const start = await rawRequest('/api/v1/auth/vk/start?response=json', {
      headers: { Accept: 'application/json' },
    });
    assert.equal(start.status, 200);
    assert.match(start.headers.get('set-cookie') || '', /eb_vk_flow=[^;]+;[^,]*; Secure/u);
    const callback = new URL((await start.json()).authorizationUrl);
    const response = await rawRequest(`${callback.pathname}${callback.search}`, {
      headers: { Cookie: cookieFrom(start, 'eb_vk_flow') },
    });
    assert.equal(response.status, 303);
    const cookies = response.headers.get('set-cookie') || '';
    for (const name of ['eb_vk_flow', 'eb_vk_replay', 'eb_token']) {
      assert.match(cookies, new RegExp(`${name}=[^,]*; Secure`, 'u'));
    }
  }, { mode: 'live', secureCookies: true });
});

test('local provider routes reject public, userinfo, wrong-port or forwarded request authorities', async () => {
  await withVkApp(async ({ rawRequest, baseUrl }) => {
    const localAuthority = new URL(baseUrl).host;
    const wrongPort = Number(new URL(baseUrl).port) + 1;
    for (const headers of [
      { Host: 'public-preview.example' },
      { Host: `public-preview.example@${localAuthority}` },
      { Host: `127.0.0.1:${wrongPort}` },
      { Host: localAuthority, 'X-Forwarded-Host': 'public-preview.example' },
      { Host: localAuthority, Forwarded: 'host=public-preview.example;proto=https' },
    ]) {
      const discovery = await rawRequest('/api/v1/auth/providers', { headers });
      assert.equal(discovery.status, 404);
      const start = await rawRequest('/api/v1/auth/vk/start?response=json', {
        headers: { Accept: 'application/json', ...headers },
      });
      assert.equal(start.status, 404);
      assert.equal(start.headers.get('set-cookie'), null);
    }
  });
});

test('callback consumes cancellation, rejects expiry or purged state and sanitizes provider failures', async () => {
  let authenticateCalls = 0;
  const local = createLocalVkIdProvider({
    subject: 'failure-user', displayName: 'Failure User',
    redirectUri: 'http://127.0.0.1/api/v1/auth/vk/callback',
  });
  const provider = {
    ...local,
    async authenticate(input) {
      authenticateCalls += 1;
      if (input.code === 'provider-failure') throw new Error(`leak:${input.state}`);
      return local.authenticate(input);
    },
  };
  await withVkApp(async ({ request, repository, clock }) => {
    const cancelledStart = await request('/api/v1/auth/vk/start');
    const cancelledCookie = cookieFrom(cancelledStart, 'eb_vk_flow');
    const cancelledUrl = new URL(cancelledStart.headers.get('location'), 'http://local.test');
    const cancelled = await request(`${CALLBACK_PATH}?error=access_denied&state=${cancelledUrl.searchParams.get('state')}`, {
      headers: { Cookie: cancelledCookie },
    });
    assert.equal(cancelled.headers.get('location'), '/?auth_error=cancelled');
    assert.equal(authenticateCalls, 0);
    assert.match(cancelled.headers.get('set-cookie') || '', /eb_vk_flow=;[^,]*Max-Age=0/u);

    const expiredStart = await request('/api/v1/auth/vk/start');
    const expiredCookie = cookieFrom(expiredStart, 'eb_vk_flow');
    const expiredUrl = new URL(expiredStart.headers.get('location'), 'http://local.test');
    clock.value = new Date(clock.value.getTime() + 600_001);
    const expired = await request(`${expiredUrl.pathname}${expiredUrl.search}`, { headers: { Cookie: expiredCookie } });
    assert.equal(expired.headers.get('location'), '/?auth_error=expired');
    assert.equal(authenticateCalls, 0);

    const purgedStart = await request('/api/v1/auth/vk/start');
    const purgedCookie = cookieFrom(purgedStart, 'eb_vk_flow');
    const purgedUrl = new URL(purgedStart.headers.get('location'), 'http://local.test');
    clock.value = new Date(clock.value.getTime() + 600_001);
    await repository.purgeOAuthTransactions({ now: clock.value });
    const purged = await request(`${purgedUrl.pathname}${purgedUrl.search}`, { headers: { Cookie: purgedCookie } });
    assert.equal(purged.headers.get('location'), '/?auth_error=expired');
    assert.equal(authenticateCalls, 0);

    const failedStart = await request('/api/v1/auth/vk/start');
    const failedCookie = cookieFrom(failedStart, 'eb_vk_flow');
    const failedUrl = new URL(failedStart.headers.get('location'), 'http://local.test');
    failedUrl.searchParams.set('code', 'provider-failure');
    const failed = await request(`${failedUrl.pathname}${failedUrl.search}`, { headers: { Cookie: failedCookie } });
    assert.equal(failed.headers.get('location'), '/?auth_error=provider');
    assert.doesNotMatch(failed.headers.get('location'), /leak|state|code|device/u);
    assert.equal(authenticateCalls, 1);
  }, { provider });
});

test('malformed callback is bounded, clears the flow cookie and never echoes query data', async () => {
  await withVkApp(async ({ request }) => {
    const response = await request(`${CALLBACK_PATH}?state=${'x'.repeat(300)}&code=${'y'.repeat(3000)}`, {
      headers: { Cookie: `eb_vk_flow=${'x'.repeat(43)}` },
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/?auth_error=invalid');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('set-cookie') || '', /eb_vk_flow=;[^,]*Max-Age=0/u);
    assert.ok((response.headers.get('location') || '').length < 64);
  });
});

test('VK rate limits redirect browser navigation, retain machine JSON and clear callback state', async () => {
  const limited = createVkRateLimitHandler();
  await withVkApp(async ({ request }) => {
    const startNavigation = await request('/api/v1/auth/vk/start', { headers: { Accept: 'text/html' } });
    assert.equal(startNavigation.status, 303);
    assert.equal(startNavigation.headers.get('location'), '/?auth_error=rate_limited');
    assert.equal(startNavigation.headers.get('referrer-policy'), 'no-referrer');
    const startMachine = await request('/api/v1/auth/vk/start', { headers: { Accept: 'application/json' } });
    assert.equal(startMachine.status, 429);
    assert.equal((await startMachine.json()).error.code, 'RATE_LIMITED');
    const startHandshake = await request('/api/v1/auth/vk/start?response=json', {
      headers: { Accept: 'text/html' },
    });
    assert.equal(startHandshake.status, 429);
    assert.equal((await startHandshake.json()).error.code, 'RATE_LIMITED');

    const callbackNavigation = await request(`${CALLBACK_PATH}?response=json&state=${'x'.repeat(43)}`, {
      headers: { Accept: 'text/html', Cookie: `eb_vk_flow=${'x'.repeat(43)}` },
    });
    assert.equal(callbackNavigation.status, 303);
    assert.equal(callbackNavigation.headers.get('location'), '/?auth_error=rate_limited');

    const response = await request(`${CALLBACK_PATH}?state=${'x'.repeat(43)}&code=private`, {
      headers: { Accept: 'text/html', Cookie: `eb_vk_flow=${'x'.repeat(43)}` },
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/?auth_error=rate_limited');
    assert.doesNotMatch(response.headers.get('location'), /state|code|device|private/u);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('set-cookie') || '', /eb_vk_flow=;[^,]*Max-Age=0[^,]*HttpOnly[^,]*SameSite=Lax/u);
    const machine = await request(`${CALLBACK_PATH}?state=${'x'.repeat(43)}`, {
      headers: { Accept: 'application/json', Cookie: `eb_vk_flow=${'x'.repeat(43)}` },
    });
    assert.equal(machine.status, 429);
    assert.equal((await machine.json()).error.code, 'RATE_LIMITED');
    assert.match(machine.headers.get('set-cookie') || '', /eb_vk_flow=;[^,]*Max-Age=0/u);
  }, { limiters: { start: limited, callback: limited } });
});

test('global anonymous limit defers exact versioned and legacy VK navigation to route-specific limits', async () => {
  await withVkApp(async ({ request }) => {
    for (const pathname of ['/api/v1/auth/vk/start', '/api/auth/vk/start']) {
      assert.equal((await request(pathname)).status, 302);
      assert.equal((await request(pathname)).status, 302);
    }
    for (const pathname of ['/api/v1/auth/vk/start?response=json', '/api/auth/vk/start?response=json']) {
      assert.equal((await request(pathname)).status, 200);
    }
    for (const pathname of ['/api/v1/auth/vk/callback', '/api/auth/vk/callback']) {
      assert.equal((await request(pathname)).status, 303);
      assert.equal((await request(pathname)).status, 303);
    }

    assert.equal((await request('/api/v1/auth/providers')).status, 200);
    const globallyLimited = await request('/api/v1/auth/providers');
    assert.equal(globallyLimited.status, 429);
    assert.equal((await globallyLimited.json()).error.code, 'RATE_LIMITED');

    for (const [method, pathname] of [
      ['POST', '/api/v1/auth/vk/start'],
      ['OPTIONS', '/api/v1/auth/vk/callback'],
      ['POST', '/api/auth/vk/start'],
      ['OPTIONS', '/api/auth/vk/callback'],
    ]) {
      const response = await request(pathname, { method });
      assert.equal(response.status, 429, `${method} ${pathname} must remain under the anonymous limiter`);
    }
  }, { anonymousLimit: 1, legacyApi: true });
});

test('OpenAPI documents VK browser failure redirects and exported learner identity', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const start = specification.slice(
    specification.indexOf('/api/v1/auth/vk/start:'),
    specification.indexOf('/api/v1/auth/vk/callback:'),
  );
  assert.match(start, /'303':[\s\S]*auth_error=<allowlisted-code>/u);
  for (const header of ['Location', 'Cache-Control', 'Pragma', 'Referrer-Policy']) {
    assert.match(start, new RegExp(`'303':[\\s\\S]*${header}:`, 'u'));
  }
  assert.match(start, /pattern: '\^\/\\\?auth_error=\[a-z_\]\+\$'/u,
    'the browser redirect Location pattern matches one literal question mark');

  const callback = specification.slice(
    specification.indexOf('/api/v1/auth/vk/callback:'),
    specification.indexOf('/api/v1/tg/start:'),
  );
  for (const header of ['Location', 'Cache-Control', 'Pragma', 'Referrer-Policy']) {
    assert.match(callback, new RegExp(`'303':[\\s\\S]*${header}:`, 'u'));
  }

  const accountExport = specification.slice(
    specification.indexOf('/api/v1/account/export:'),
    specification.indexOf('/api/v1/account:'),
  );
  assert.match(accountExport, /\$ref: '#\/components\/schemas\/AccountExport'/u);
  assert.match(accountExport, /Cache-Control:[\s\S]*enum: \[no-store\]/u);
  assert.match(accountExport, /Content-Disposition:/u);
  const accountSchema = specification.slice(
    specification.indexOf('    AccountExport:'),
    specification.indexOf('    EgeMockDraftAnswer:'),
  );
  assert.match(accountSchema, /required: \[username, identity_provider, identity_subject, display_name\]/u);
  for (const field of ['identity_provider', 'identity_subject', 'display_name']) {
    assert.match(accountSchema, new RegExp(`\\s${field}:`, 'u'));
  }
  assert.match(accountSchema, /telegram_id:[\s\S]*oneOf:[\s\S]*type: integer[\s\S]*type: string/u,
    'account export reflects file numeric and PostgreSQL BIGINT string identifiers');
});
