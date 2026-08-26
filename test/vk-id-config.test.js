import assert from 'node:assert/strict';
import test from 'node:test';

import { readVkIdConfig } from '../config.js';

test('VK ID is fail-closed by default and never defines a client-secret setting', () => {
  const config = readVkIdConfig({ NODE_ENV: 'development' }, { appUrl: 'http://localhost:3000' });
  assert.equal(config.mode, 'disabled');
  assert.equal(config.enabled, false);
  assert.equal('clientSecret' in config, false);
  assert.equal(Object.keys(config).some((name) => /secret/iu.test(name)), false);
});

test('local VK ID requires NODE_ENV to be explicitly present in its environment', () => {
  assert.throws(() => readVkIdConfig({ VK_ID_MODE: 'local' }, {
    appUrl: 'http://localhost:3000',
  }), /VK_ID_MODE=local is allowed only with explicit NODE_ENV=development or test/u);
});

test('live VK ID requires a complete exact same-origin callback configuration', () => {
  assert.throws(() => readVkIdConfig({ NODE_ENV: 'production', VK_ID_MODE: 'live' }, {
    appUrl: 'https://aisy.example',
  }), /VK_ID_APP_ID and VK_ID_REDIRECT_URI/u);

  assert.throws(() => readVkIdConfig({
    NODE_ENV: 'production', VK_ID_MODE: 'live', VK_ID_APP_ID: '123456',
    VK_ID_REDIRECT_URI: 'https://another.example/api/v1/auth/vk/callback',
  }, { appUrl: 'https://aisy.example' }), /same origin as APP_URL/u);

  const config = readVkIdConfig({
    NODE_ENV: 'production', VK_ID_MODE: 'live', VK_ID_APP_ID: '123456',
    VK_ID_REDIRECT_URI: 'https://aisy.example/api/v1/auth/vk/callback',
    VK_ID_FLOW_TTL_SECONDS: '420',
  }, { appUrl: 'https://aisy.example' });
  assert.deepEqual({
    mode: config.mode, enabled: config.enabled, appId: config.appId,
    redirectUri: config.redirectUri, flowTtlSeconds: config.flowTtlSeconds,
  }, {
    mode: 'live', enabled: true, appId: '123456',
    redirectUri: 'https://aisy.example/api/v1/auth/vk/callback', flowTtlSeconds: 420,
  });
  const canonical = readVkIdConfig({
    NODE_ENV: 'production', VK_ID_MODE: 'live', VK_ID_APP_ID: '123456',
    VK_ID_REDIRECT_URI: 'https://aisy.example:443/api/v1/auth/vk/callback',
  }, { appUrl: 'https://aisy.example' });
  assert.equal(canonical.redirectUri, 'https://aisy.example/api/v1/auth/vk/callback');
  assert.throws(() => readVkIdConfig({
    NODE_ENV: 'production', VK_ID_MODE: 'live', VK_ID_APP_ID: '123456', VK_ID_SCOPE: 'email phone',
    VK_ID_REDIRECT_URI: 'https://aisy.example/api/v1/auth/vk/callback',
  }, { appUrl: 'https://aisy.example' }), /VK_ID_SCOPE must be empty/u);
});

test('local VK ID is explicit, zero-secret and restricted to development/test loopback origins', () => {
  for (const nodeEnv of ['production', 'staging', 'preview', '']) {
    assert.throws(() => readVkIdConfig({ NODE_ENV: nodeEnv, VK_ID_MODE: 'local' }, {
      appUrl: 'https://aisy.example',
    }), /VK_ID_MODE=local is allowed only with explicit NODE_ENV=development or test/u);
  }

  for (const nodeEnv of ['development', 'test']) {
    assert.throws(() => readVkIdConfig({ NODE_ENV: nodeEnv, VK_ID_MODE: 'local' }, {
      appUrl: 'https://public-preview.example',
    }), /VK_ID_MODE=local requires a loopback APP_URL/u);
  }

  const config = readVkIdConfig({
    NODE_ENV: 'test', VK_ID_MODE: 'local', VK_ID_LOCAL_SUBJECT: 'qa-learner',
    VK_ID_LOCAL_DISPLAY_NAME: 'QA ученица', PORT: '3010',
  }, { appUrl: 'http://127.0.0.1:3010' });
  assert.equal(config.enabled, true);
  assert.equal(config.applicationOrigin, 'http://127.0.0.1:3010');
  assert.equal(config.secureCookies, false);
  assert.equal(config.redirectUri, 'http://127.0.0.1:3010/api/v1/auth/vk/callback');
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.localAuthority, '127.0.0.1:3010');
  assert.equal(config.localSubject, 'qa-learner');
  assert.equal(config.localDisplayName, 'QA ученица');
  assert.equal('clientSecret' in config, false);

  assert.throws(() => readVkIdConfig({ NODE_ENV: 'development', VK_ID_MODE: 'local', PORT: '3443' }, {
    appUrl: 'https://localhost:3443',
  }), /requires an HTTP APP_URL whose port exactly matches PORT/u);
  assert.throws(() => readVkIdConfig({ NODE_ENV: 'development', VK_ID_MODE: 'local', PORT: '3010' }, {
    appUrl: 'http://localhost:3011',
  }), /requires an HTTP APP_URL whose port exactly matches PORT/u);

  const ipv6 = readVkIdConfig({ NODE_ENV: 'test', VK_ID_MODE: 'local', PORT: '3011' }, {
    appUrl: 'http://[::1]:3011',
  });
  assert.equal(ipv6.redirectUri, 'http://[::1]:3011/api/v1/auth/vk/callback');
  assert.equal(ipv6.applicationOrigin, 'http://[::1]:3011');
  assert.equal(ipv6.bindHost, '::1');
  assert.equal(ipv6.localAuthority, '[::1]:3011');

  const localhost = readVkIdConfig({ NODE_ENV: 'test', VK_ID_MODE: 'local', PORT: '3012' }, {
    appUrl: 'http://localhost:3012',
  });
  assert.equal(localhost.applicationOrigin, 'http://localhost:3012');
  assert.equal(localhost.secureCookies, false);
  assert.equal(localhost.bindHost, '127.0.0.1');
  assert.equal(localhost.localAuthority, 'localhost:3012');

  const production = readVkIdConfig({
    NODE_ENV: 'production', VK_ID_MODE: 'live', VK_ID_APP_ID: '123456',
    VK_ID_REDIRECT_URI: 'https://aisy.example/api/v1/auth/vk/callback',
  }, { appUrl: 'https://aisy.example' });
  assert.equal(production.applicationOrigin, 'https://aisy.example');
  assert.equal(production.secureCookies, true);
});
