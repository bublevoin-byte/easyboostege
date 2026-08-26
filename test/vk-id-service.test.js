import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLiveVkIdProvider,
  createLocalVkIdProvider,
  createPkceChallenge,
  createVkFlowCipher,
  hashVkState,
} from '../services/vk-id.js';

test('VK ID PKCE uses the RFC 7636 S256 transform and stores only hashed state', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(createPkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(
    hashVkState('state-known-to-the-browser'),
    '2c4878221f34e7285a7bdc2912de1b2ea2b7501865b99cf9e61766a8278d6120',
  );
});

test('VK ID flow verifier is authenticated-encrypted with a JWT-derived key', () => {
  const cipher = createVkFlowCipher('vk-id-test-secret-that-is-longer-than-32-characters');
  const verifier = 'a'.repeat(43);
  const sealed = cipher.seal(verifier);

  assert.doesNotMatch(sealed, /a{12}/u);
  assert.equal(cipher.open(sealed), verifier);
  assert.throws(() => cipher.open(`${sealed.slice(0, -1)}x`), { code: 'VK_ID_FLOW_INVALID' });
});

test('live VK ID provider uses current authorize, code exchange and minimal user_info contracts', async () => {
  const observed = [];
  const responses = [
    { access_token: 'provider-access-token', refresh_token: 'provider-refresh-token', state: 'browser-state' },
    { user: { user_id: 918273, first_name: 'Ася', last_name: 'Иванова', avatar: 'https://example.test/avatar' } },
  ];
  const provider = createLiveVkIdProvider({
    appId: '123456',
    redirectUri: 'https://aisy.example/api/v1/auth/vk/callback',
    scope: '',
    fetchImpl: async (url, options) => {
      observed.push({ url: String(url), options });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const authorization = new URL(provider.authorizationUrl({
    state: 'browser-state',
    codeChallenge: 'pkce-challenge',
  }));
  assert.equal(authorization.origin, 'https://id.vk.ru');
  assert.equal(authorization.pathname, '/authorize');
  assert.deepEqual(Object.fromEntries(authorization.searchParams), {
    client_id: '123456',
    redirect_uri: 'https://aisy.example/api/v1/auth/vk/callback',
    response_type: 'code',
    state: 'browser-state',
    code_challenge: 'pkce-challenge',
    code_challenge_method: 's256',
  });

  const identity = await provider.authenticate({
    code: 'one-time-code',
    state: 'browser-state',
    deviceId: 'vk-device',
    codeVerifier: 'v'.repeat(43),
  });

  assert.deepEqual(identity, { provider: 'vk', subject: '918273', displayName: 'Ася Иванова' });
  const exchange = new URL(observed[0].url);
  assert.equal(exchange.origin, 'https://id.vk.ru');
  assert.equal(exchange.pathname, '/oauth2/auth');
  assert.deepEqual(Object.fromEntries(exchange.searchParams), {
    grant_type: 'authorization_code',
    redirect_uri: 'https://aisy.example/api/v1/auth/vk/callback',
    client_id: '123456',
    code_verifier: 'v'.repeat(43),
    state: 'browser-state',
    device_id: 'vk-device',
  });
  assert.equal(observed[0].options.method, 'POST');
  assert.equal(observed[0].options.redirect, 'error');
  assert.equal(String(observed[0].options.body), 'code=one-time-code');
  assert.equal(new URL(observed[1].url).toString(), 'https://id.vk.ru/oauth2/user_info?client_id=123456');
  assert.equal(String(observed[1].options.body), 'access_token=provider-access-token');
  assert.equal(observed[1].options.redirect, 'error');

  const serializedEvidence = JSON.stringify({ observed, identity });
  assert.doesNotMatch(serializedEvidence, /provider-refresh-token/u);
  assert.doesNotMatch(serializedEvidence, /avatar/u);
});

test('live VK ID provider rejects a missing or mismatched token-response state before user_info', async () => {
  for (const responseState of [undefined, 'another-browser-state']) {
    let calls = 0;
    const provider = createLiveVkIdProvider({
      appId: '123456',
      redirectUri: 'https://aisy.example/api/v1/auth/vk/callback',
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          access_token: 'must-not-reach-user-info',
          ...(responseState ? { state: responseState } : {}),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await assert.rejects(provider.authenticate({
      code: 'one-time-code',
      state: 'browser-state',
      deviceId: 'vk-device',
      codeVerifier: 'v'.repeat(43),
    }), { code: 'VK_ID_PROVIDER_ERROR' });
    assert.equal(calls, 1, 'state mismatch must stop before the user_info request');
  }
});

test('local VK ID provider is zero-network and returns only the configured minimal identity', async () => {
  let networkCalls = 0;
  const provider = createLocalVkIdProvider({
    subject: 'local-learner',
    displayName: 'Локальная ученица',
    redirectUri: 'http://127.0.0.1:3010/api/v1/auth/vk/callback',
    fetchImpl: async () => { networkCalls += 1; },
  });

  assert.equal(provider.mode, 'local');
  assert.equal(
    provider.authorizationUrl({ state: 's'.repeat(43) }),
    `http://127.0.0.1:3010/api/v1/auth/vk/callback?code=local-code&state=${'s'.repeat(43)}&device_id=local-device&type=code_v2`,
  );
  assert.deepEqual(await provider.authenticate({ code: 'local-code' }), {
    provider: 'vk', subject: 'local-learner', displayName: 'Локальная ученица',
  });
  assert.equal(networkCalls, 0);
});

test('live VK ID provider rejects oversized responses with a sanitized error', async () => {
  let cancelled = false;
  const chunk = new Uint8Array(40_000).fill(120);
  const provider = createLiveVkIdProvider({
    appId: '123456',
    redirectUri: 'https://aisy.example/api/v1/auth/vk/callback',
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });

  await assert.rejects(
    provider.authenticate({
      code: 'sensitive-code',
      state: 'sensitive-state',
      deviceId: 'sensitive-device',
      codeVerifier: 'v'.repeat(43),
    }),
    (error) => {
      assert.equal(error.code, 'VK_ID_PROVIDER_ERROR');
      assert.equal(error.message, 'VK_ID_PROVIDER_ERROR');
      assert.doesNotMatch(String(error.stack), /sensitive-(?:code|state|device)/u);
      return true;
    },
  );
  assert.equal(cancelled, true, 'oversized provider stream must be cancelled immediately');
});

test('live VK ID provider sanitizes fetch rejections from both provider calls', async () => {
  const inputs = {
    code: 'sensitive-code',
    state: 'sensitive-state',
    deviceId: 'sensitive-device',
    codeVerifier: 'v'.repeat(43),
  };
  for (const failAt of [1, 2]) {
    let calls = 0;
    const provider = createLiveVkIdProvider({
      appId: '123456',
      redirectUri: 'https://aisy.example/api/v1/auth/vk/callback',
      fetchImpl: async (url) => {
        calls += 1;
        if (calls === failAt) throw new Error(`leak:${String(url)}:${inputs.code}:${inputs.state}`);
        return new Response(JSON.stringify({
          access_token: 'temporary-provider-token', state: inputs.state,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await assert.rejects(provider.authenticate(inputs), (error) => {
      assert.equal(error.code, 'VK_ID_PROVIDER_ERROR');
      assert.equal(error.message, 'VK_ID_PROVIDER_ERROR');
      assert.doesNotMatch(String(error.stack), /leak|sensitive-|temporary-provider-token|code_verifier/u);
      return true;
    });
  }
});

test('flow cipher rejects non-canonical base64url encodings', () => {
  const cipher = createVkFlowCipher('vk-id-test-secret-that-is-longer-than-32-characters');
  const sealed = cipher.seal('a'.repeat(43));
  const parts = sealed.split('.');
  const tag = Buffer.from(parts[2], 'base64url');
  tag[0] ^= 1;
  assert.throws(() => cipher.open(`${parts[0]}.${parts[1]}.${tag.toString('base64url')}`), {
    code: 'VK_ID_FLOW_INVALID',
  });
  const alternativeFinalCharacter = parts[2].endsWith('A') ? 'B' : 'A';
  assert.throws(() => cipher.open(`${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${alternativeFinalCharacter}`), {
    code: 'VK_ID_FLOW_INVALID',
  });
});

test('transaction retention sweeps immediately, repeats periodically and stops cleanly', async () => {
  const callbacks = [];
  const cleared = [];
  let purges = 0;
  const { createVkTransactionRetention } = await import('../services/vk-id.js');
  const retention = createVkTransactionRetention({
    purge: async () => { purges += 1; },
    intervalMs: 60_000,
    setIntervalImpl: (callback, delay) => {
      assert.equal(delay, 60_000);
      callbacks.push(callback);
      return { unref() {} };
    },
    clearIntervalImpl: (timer) => cleared.push(timer),
  });
  retention.start();
  await Promise.resolve();
  assert.equal(purges, 1);
  await callbacks[0]();
  assert.equal(purges, 2);
  retention.stop();
  assert.equal(cleared.length, 1);
});
