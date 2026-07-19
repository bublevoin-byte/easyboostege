import assert from 'node:assert/strict';
import test from 'node:test';
import { isTrustedCookieRequest, normalizeOrigin } from '../security/request-origin.js';

const allowedOrigin = 'https://easy-boost.example';
const request = (method, headers = {}) => ({ method, headers });

test('origin normalization accepts an absolute application URL', () => {
  assert.equal(normalizeOrigin('https://easy-boost.example/path'), allowedOrigin);
  assert.equal(normalizeOrigin('not-a-url'), '');
  assert.equal(normalizeOrigin('ftp://easy-boost.example'), '');
});

test('same-origin mutation with a session cookie is accepted', () => {
  assert.equal(isTrustedCookieRequest(request('POST', {
    cookie: 'theme=dark; eb_token=session', origin: allowedOrigin, 'sec-fetch-site': 'same-origin',
  }), allowedOrigin), true);
});

test('cross-site mutation with a session cookie is rejected', () => {
  assert.equal(isTrustedCookieRequest(request('POST', {
    cookie: 'eb_token=session', origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site',
  }), allowedOrigin), false);
});

test('mutation with a session cookie and no Origin is rejected', () => {
  assert.equal(isTrustedCookieRequest(request('POST', {
    cookie: 'eb_token=session',
  }), allowedOrigin), false);
});

test('non-browser clients without a session cookie remain supported', () => {
  assert.equal(isTrustedCookieRequest(request('POST', {
    authorization: 'Bearer token', origin: 'https://api-client.example',
  }), allowedOrigin), true);
});

test('safe cookie-authenticated requests do not require an Origin header', () => {
  assert.equal(isTrustedCookieRequest(request('GET', {
    cookie: 'eb_token=session', 'sec-fetch-site': 'cross-site',
  }), allowedOrigin), true);
});
