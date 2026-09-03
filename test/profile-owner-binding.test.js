import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';

import express from 'express';
import jwt from 'jsonwebtoken';

import { createSpeakingRoutes } from '../routes/speaking.js';
import { createUserRoutes } from '../routes/users.js';

const SECRET = 'profile-owner-binding-test-secret-32-characters';

async function withOwnerBoundApp(run) {
  const calls = {
    calibrationReads: 0, calibrationWrites: 0, clearedCookies: 0, deletes: 0, exports: 0,
    paymentReads: 0, paymentWrites: 0, privacyReads: 0, privacyWrites: 0, revokedSessions: 0,
  };
  const authentication = {
    auth(req, res, next) {
      const owner = req.get('x-test-user');
      if (!owner) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      req.user = owner;
      req.role = 'student';
      return next();
    },
    requireRole: () => (req, res) => res.status(403).json({ error: { code: 'FORBIDDEN' } }),
    monitoringAuth: (req, res, next) => next(),
    issueToken: async (owner) => jwt.sign({ u: owner }, SECRET),
    readCookie: () => '',
    setAuthCookie() {},
    clearAuthCookie() { calls.clearedCookies += 1; },
  };
  const db = {
    async getUser(owner) { return { username: owner, display_name: owner }; },
    async getSub() { return { active: true, until: Date.now() + 86_400_000 }; },
    async getPrivacyConsent(owner) {
      calls.privacyReads += 1;
      return { text_processing: owner === 'owner-b', voice_processing: false, policy_version: 'test-v1' };
    },
    async setPrivacyConsent(owner, consent) {
      calls.privacyWrites += 1;
      return { ...consent, owner };
    },
    async getSpeakingCalibrationConsent(owner) {
      calls.calibrationReads += 1;
      return { granted: false, age_group: 'adult', guardian_confirmed: false, owner };
    },
    async setSpeakingCalibrationConsent(owner, consent) {
      calls.calibrationWrites += 1;
      return { ...consent, owner };
    },
    async getPaymentRequestForUser() { calls.paymentReads += 1; return null; },
    async getVoiceTutorAccess() {
      return { entitlements: { voice_tutor: false }, voice_tutor: {} };
    },
    async createPaymentRequestForUser(id, owner, product) {
      calls.paymentWrites += 1;
      return { id, username: owner, product, status: 'new' };
    },
    async exportUserData(owner) { calls.exports += 1; return { account: { username: owner } }; },
    async deleteUserData() { calls.deletes += 1; },
    async revokeSession() { calls.revokedSessions += 1; },
  };
  const app = express();
  app.use(express.json());
  app.use(createUserRoutes({
    secret: SECRET,
    telegramEnabled: () => false,
    botUsername: () => '',
    authCodeTtlMs: 60_000,
    privacyPolicyVersion: 'test-v1',
    limiters: {
      telegramStart: (req, res, next) => next(),
      telegramCheck: (req, res, next) => next(),
    },
    authentication,
    buildMonitoringSnapshot: async () => ({}),
    promoteConfiguredAdmin: async () => {},
    db,
    newPaymentRequestId: () => '7ee5be14-d2b6-4f73-b5af-339131231985',
  }));
  app.use(createSpeakingRoutes({
    authentication,
    access: { requireActiveSubscription: (req, res, next) => next() },
    db,
  }));
  app.use((error, req, res, next) => res.status(500).json({ error: { code: error.code || 'INTERNAL_ERROR' } }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, {
    authenticatedOwner = 'owner-b', expectedOwner = 'owner-a', method = 'GET', body,
    bearer = false, bearerToken = '',
  } = {}) => fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer || bearerToken
        ? { authorization: `Bearer ${bearerToken || jwt.sign({ u: authenticatedOwner, sid: 'session-b' }, SECRET)}` }
        : { 'x-test-user': authenticatedOwner }),
      ...(expectedOwner == null ? {} : { 'x-easyboost-expected-owner': expectedOwner }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try { await run({ calls, request }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('Profile owner-bound reads and mutations reject a cross-tab cookie switch before touching owner B', async () => {
  await withOwnerBoundApp(async ({ calls, request }) => {
    const operations = [
      ['/api/v1/me', {}],
      ['/api/v1/privacy/consent', {}],
      ['/api/v1/privacy/consent', { method: 'PUT', body: { text_processing: true, voice_processing: true } }],
      ['/api/v1/speaking/calibration-consent', {}],
      ['/api/v1/speaking/calibration-consent', { method: 'PUT', body: { granted: false, ageGroup: 'adult', guardianConfirmed: false } }],
      ['/api/v1/payments/requests?product=premium_voice', {}],
      ['/api/v1/payments/requests', { method: 'POST', body: { product: 'premium_voice' } }],
      ['/api/v1/account/export', {}],
      ['/api/v1/account', { method: 'DELETE', body: { confirmation: 'DELETE', owner: 'owner-b' } }],
      ['/api/v1/logout', { method: 'POST', body: {}, bearer: true }],
    ];
    for (const [pathname, options] of operations) {
      const response = await request(pathname, options);
      assert.equal(response.status, 409, `${options.method || 'GET'} ${pathname}`);
      assert.equal((await response.json()).error.code, 'OWNER_CHANGED');
    }
    assert.deepEqual(calls, {
      calibrationReads: 0, calibrationWrites: 0, clearedCookies: 0, deletes: 0, exports: 0,
      paymentReads: 0, paymentWrites: 0, privacyReads: 0, privacyWrites: 0, revokedSessions: 0,
    });
  });
});

test('Profile owner-bound success responses identify the exact authenticated owner', async () => {
  await withOwnerBoundApp(async ({ calls, request }) => {
    for (const [pathname, options] of [
      ['/api/v1/me', {}],
      ['/api/v1/privacy/consent', {}],
      ['/api/v1/privacy/consent', { method: 'PUT', body: { text_processing: true, voice_processing: false } }],
      ['/api/v1/speaking/calibration-consent', {}],
      ['/api/v1/speaking/calibration-consent', { method: 'PUT', body: { granted: false, ageGroup: 'adult', guardianConfirmed: false } }],
      ['/api/v1/payments/requests?product=premium_voice', {}],
      ['/api/v1/payments/requests', { method: 'POST', body: { product: 'premium_voice' } }],
      ['/api/v1/account/export', {}],
      ['/api/v1/account', { method: 'DELETE', body: { confirmation: 'DELETE', owner: 'owner-b' } }],
      ['/api/v1/logout', { method: 'POST', body: {}, bearer: true }],
    ]) {
      const response = await request(pathname, { ...options, expectedOwner: 'owner-b' });
      assert.ok(response.ok, `${options.method || 'GET'} ${pathname}: ${response.status}`);
      assert.equal(response.headers.get('x-easyboost-response-owner'), 'owner-b');
      if ((options.method || 'GET') === 'GET') assert.match(response.headers.get('cache-control') || '', /no-store/u);
    }
    assert.equal(calls.privacyReads, 1);
    assert.equal(calls.privacyWrites, 1);
    assert.equal(calls.calibrationReads, 1);
    assert.equal(calls.calibrationWrites, 1);
    assert.equal(calls.paymentReads, 1);
    assert.equal(calls.paymentWrites, 1);
    assert.equal(calls.exports, 1);
    assert.equal(calls.deletes, 1);
    assert.equal(calls.revokedSessions, 1);
    assert.equal(calls.clearedCookies, 2);
  });
});

test('legacy authenticated Profile contracts work without ExpectedOwner while still binding response owner', async () => {
  await withOwnerBoundApp(async ({ calls, request }) => {
    for (const [pathname, options] of [
      ['/api/v1/me', {}],
      ['/api/v1/privacy/consent', {}],
      ['/api/v1/privacy/consent', { method: 'PUT', body: { text_processing: false, voice_processing: false } }],
      ['/api/v1/speaking/calibration-consent', {}],
      ['/api/v1/speaking/calibration-consent', { method: 'PUT', body: { granted: false, ageGroup: 'adult', guardianConfirmed: false } }],
      ['/api/v1/payments/requests?product=premium_voice', {}],
      ['/api/v1/payments/requests', { method: 'POST', body: { product: 'premium_voice' } }],
      ['/api/v1/account/export', {}],
      ['/api/v1/account', { method: 'DELETE', body: { confirmation: 'DELETE', owner: 'owner-b' } }],
      ['/api/v1/logout', { method: 'POST', body: {}, bearer: true }],
    ]) {
      const response = await request(pathname, { ...options, expectedOwner: null });
      assert.ok(response.ok, `${options.method || 'GET'} ${pathname}: ${response.status}`);
      assert.equal(response.headers.get('x-easyboost-response-owner'), 'owner-b');
    }
    assert.equal(calls.privacyReads, 1);
    assert.equal(calls.privacyWrites, 1);
    assert.equal(calls.calibrationReads, 1);
    assert.equal(calls.calibrationWrites, 1);
    assert.equal(calls.paymentReads, 1);
    assert.equal(calls.paymentWrites, 1);
    assert.equal(calls.exports, 1);
    assert.equal(calls.deletes, 1);
    assert.equal(calls.revokedSessions, 1);
  });
});

test('logout safely acknowledges the captured local owner after an invalid or already-cleared cookie', async () => {
  await withOwnerBoundApp(async ({ calls, request }) => {
    const invalid = await request('/api/v1/logout', {
      method: 'POST', body: {}, bearerToken: 'expired-or-invalid', expectedOwner: 'owner-b',
    });
    assert.equal(invalid.status, 200);
    assert.equal(invalid.headers.get('x-easyboost-response-owner'), 'owner-b');
    assert.equal(calls.revokedSessions, 0);
    assert.equal(calls.clearedCookies, 1);

    const repeated = await request('/api/v1/logout', {
      method: 'POST', body: {}, expectedOwner: 'owner-b',
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.headers.get('x-easyboost-response-owner'), 'owner-b');
    assert.equal(calls.revokedSessions, 0);
    assert.equal(calls.clearedCookies, 2);
  });
});

test('OpenAPI keeps legacy owner headers optional while strict mutations remain required', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const pathContract = (pathname) => {
    const escaped = pathname.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return openapi.match(new RegExp(`^  ${escaped}:[\\s\\S]*?(?=^  \\/api\\/v1\\/|^components:)`, 'mu'))?.[0] || '';
  };
  assert.match(openapi, /OptionalExpectedOwner:[\s\S]*?required:\s*false/u);
  for (const pathname of [
    '/api/v1/me',
    '/api/v1/payments/requests',
    '/api/v1/logout',
    '/api/v1/account/export',
    '/api/v1/account',
    '/api/v1/privacy/consent',
    '/api/v1/speaking/calibration-consent',
    '/api/v1/adaptive-learning/overview',
    '/api/v1/adaptive-learning/sessions',
  ]) {
    const contract = pathContract(pathname);
    assert.match(contract, /#\/components\/parameters\/OptionalExpectedOwner/u, pathname);
    assert.doesNotMatch(contract, /#\/components\/parameters\/ExpectedOwner/u, pathname);
  }
  assert.match(pathContract('/api/v1/error-bank'), /#\/components\/parameters\/ExpectedOwner/u);
});
