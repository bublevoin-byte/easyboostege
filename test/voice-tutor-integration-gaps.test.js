import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createUserRoutes } from '../routes/users.js';
import { createFileRepository } from '../storage/file-repository.js';

const NOW = new Date('2026-08-03T09:00:00.000Z');
const LIMITS = Object.freeze({ dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 });

function authenticationFor(student, admin) {
  const auth = (req, res, next) => {
    const identity = req.headers['x-test-user'];
    if (!identity) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
    req.user = identity === 'admin' ? admin : student;
    req.role = identity === 'admin' ? 'admin' : 'student';
    next();
  };
  return {
    auth,
    requireRole: (role) => (req, res, next) => req.role === role
      ? next()
      : res.status(403).json({ error: { code: 'FORBIDDEN' } }),
    monitoringAuth: auth,
    issueToken: async () => 'test-session',
    readCookie: () => '',
    setAuthCookie: () => {},
    clearAuthCookie: () => {},
  };
}

async function withCommerceApp(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-premium-commerce-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const student = await repository.createTelegramUser(7101, 'Premium Student');
  const admin = await repository.createTelegramUser(9001, 'Premium Admin');
  await repository.setUserRole(admin, 'admin');
  const ids = [
    '7ee5be14-d2b6-4f73-b5af-339131231985',
    'd8e41ec4-13b8-4fb3-907f-f4e525420daf',
  ];
  const clock = { now: NOW };
  const app = express();
  app.use(express.json());
  const authentication = authenticationFor(student, admin);
  app.use(createUserRoutes({
    secret: 'test-secret', telegramEnabled: () => false, botUsername: () => '', authCodeTtlMs: 60_000,
    privacyPolicyVersion: 'test-v1',
    limiters: { telegramStart: (req, res, next) => next(), telegramCheck: (req, res, next) => next() },
    authentication, buildMonitoringSnapshot: async () => ({}), promoteConfiguredAdmin: async () => {},
    db: repository, voiceTutorLimits: LIMITS, now: () => clock.now,
    newPaymentRequestId: () => ids.shift(), premiumSubscriptionDays: 30,
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (user, pathname, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User': user,
      'X-EasyBoost-Expected-Owner': user === 'admin' ? admin : student,
      ...(options.headers || {}),
    },
  });
  try { await run({ repository, student, admin, request, clock }); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('Premium commerce requires admin approval and atomically grants bounded base plus voice access', async () => {
  await withCommerceApp(async ({ repository, student, request }) => {
    const createdResponse = await request('student', '/api/v1/payments/requests', {
      method: 'POST', body: JSON.stringify({ product: 'premium_voice' }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.deepEqual(created.request, {
      id: '7ee5be14-d2b6-4f73-b5af-339131231985', product: 'premium_voice', status: 'new',
    });

    const before = await (await request('student', '/api/v1/me')).json();
    assert.equal(before.active, false);
    assert.equal(before.entitlements.voice_tutor, false);
    assert.equal('approve' in created, false);

    const queueResponse = await request('admin', '/api/v1/admin/payment-requests?product=premium_voice&status=new');
    assert.equal(queueResponse.status, 200);
    assert.deepEqual((await queueResponse.json()).requests, [{ ...created.request, username: student }]);
    assert.equal((await request('student', '/api/v1/admin/payment-requests?product=premium_voice&status=new')).status, 403);

    const selfApproval = await request('student', `/api/v1/admin/payment-requests/${created.request.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(selfApproval.status, 403);

    const adminRequest = await (await request('admin', '/api/v1/payments/requests', {
      method: 'POST', body: JSON.stringify({ product: 'premium_voice' }),
    })).json();
    const adminSelfApproval = await request('admin', `/api/v1/admin/payment-requests/${adminRequest.request.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(adminSelfApproval.status, 403);
    assert.equal((await adminSelfApproval.json()).error.code, 'PAYMENT_SELF_APPROVAL_FORBIDDEN');

    const approvedResponse = await request('admin', `/api/v1/admin/payment-requests/${created.request.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal(approvedResponse.status, 200);
    const approved = await approvedResponse.json();
    assert.equal(approved.applied, true);
    assert.equal(approved.request.status, 'approved');
    assert.equal(approved.request.product, 'premium_voice');
    assert.equal(approved.sub_until, NOW.getTime() + 30 * 86_400_000);

    const after = await (await request('student', '/api/v1/me')).json();
    assert.equal(after.active, true);
    assert.equal(after.sub_until, approved.sub_until);
    assert.equal(after.entitlements.voice_tutor, true);
    assert.equal(after.voice_tutor.daily_remaining_seconds, 600);

    const replay = await (await request('admin', `/api/v1/admin/payment-requests/${created.request.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ decision: 'approved' }),
    })).json();
    assert.equal(replay.applied, false);
    assert.equal((await repository.getUser(student)).sub_until, approved.sub_until);

    const exported = await repository.exportUserData(student);
    assert.equal(exported.payment_requests[0].product, 'premium_voice');
    assert.equal(exported.subscription_events[0].event_type, 'premium_payment_approved');
    assert.deepEqual(exported.subscription_events[0].metadata, { payment_request_id: created.request.id, product: 'premium_voice' });
    assert.equal(exported.subscription_entitlements[0].ends_at, new Date(approved.sub_until).toISOString());
    assert.equal(exported.audit_log[0].action, 'payment.resolve');
  });
});

test('base requests remain base-only while Premium rejection and revocation are visible and idempotent', async () => {
  await withCommerceApp(async ({ repository, student, request, clock }) => {
    const baseRequest = await repository.createPaymentRequest('a3603192-f1a9-4208-a6a1-d82f85ceca72', 7101, 'Premium Student');
    const baseApproval = await repository.resolvePaymentRequest(baseRequest.id, 'approved', 9001, 30);
    assert.equal(baseApproval.product, 'base');
    assert.equal((await repository.getVoiceTutorAccess(student, LIMITS, clock.now)).entitlements.voice_tutor, false);

    const requested = await (await request('student', '/api/v1/payments/requests', {
      method: 'POST', body: JSON.stringify({ product: 'premium_voice' }),
    })).json();
    const rejected = await (await request('admin', `/api/v1/admin/payment-requests/${requested.request.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ decision: 'rejected' }),
    })).json();
    assert.equal(rejected.request.status, 'rejected');
    assert.equal((await repository.getVoiceTutorAccess(student, LIMITS, NOW)).entitlements.voice_tutor, false);

    const second = await (await request('student', '/api/v1/payments/requests', {
      method: 'POST', body: JSON.stringify({ product: 'premium_voice' }),
    })).json();
    await request('admin', `/api/v1/admin/payment-requests/${second.request.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ decision: 'approved' }),
    });
    assert.equal((await repository.getVoiceTutorAccess(student, LIMITS, NOW)).entitlements.voice_tutor, true);
    assert.equal(await repository.revokeEntitlement(student, 'voice_tutor', 9001, { now: NOW }), false);
    clock.now = new Date(NOW.getTime() + 1);

    const revoked = await request('admin', `/api/v1/admin/users/${encodeURIComponent(student)}/entitlements/voice_tutor/revoke`, {
      method: 'POST', body: '{}',
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).revoked, true);
    assert.equal((await repository.getVoiceTutorAccess(student, LIMITS, clock.now)).entitlements.voice_tutor, false);
    const revokeReplay = await request('admin', `/api/v1/admin/users/${encodeURIComponent(student)}/entitlements/voice_tutor/revoke`, {
      method: 'POST', body: '{}',
    });
    assert.equal((await revokeReplay.json()).revoked, false);

    const status = await (await request('student', '/api/v1/payments/requests?product=premium_voice')).json();
    assert.equal(status.request.status, 'approved');
    assert.equal(status.entitlement_active, false);
  });
});

test('production starts only with an explicit pinned voice model', () => {
  const baseEnvironment = {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://unused.invalid/easyboost',
    JWT_SECRET: 'production-test-secret-with-at-least-32-characters',
    XAI_VOICE_NAME: 'ara',
  };
  const run = (model) => spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./config.js')"], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...baseEnvironment, XAI_VOICE_MODEL: model }, encoding: 'utf8',
  });

  for (const model of ['', 'latest', 'grok-voice-latest', 'grok-voice-agent', 'voice-current-v2', 'vendor-voice-v1',
    'grok-voice-alias-1.0', 'grok-voice-current-1.0', 'grok-voice-preview-1.0', 'grok-voice-alias-2026-08-01']) {
    const result = run(model);
    assert.notEqual(result.status, 0, `production accepted ${JSON.stringify(model)}`);
    assert.match(result.stderr, /XAI_VOICE_MODEL.*pinned/u);
  }
  assert.equal(run('grok-voice-agent-2026-08-01').status, 0);
  assert.equal(run('grok-voice-think-fast-1.0').status, 0);

  for (const voice of ['', 'ARA', 'bad voice', `a${'b'.repeat(64)}`]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./config.js')"], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...baseEnvironment, XAI_VOICE_MODEL: 'grok-voice-think-fast-1.0', XAI_VOICE_NAME: voice }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, `production accepted voice ${JSON.stringify(voice)}`);
    assert.match(result.stderr, /XAI_VOICE_NAME.*lowercase/u);
  }

  const development = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./config.js')"], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, NODE_ENV: 'development', XAI_VOICE_MODEL: 'fake-voice-v1' }, encoding: 'utf8',
  });
  assert.equal(development.status, 0);
});
