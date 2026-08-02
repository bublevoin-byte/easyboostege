import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { createUserRoutes } from '../routes/users.js';
import { createVoiceTutorRoutes } from '../routes/voice-tutor.js';
import { createFileRepository } from '../storage/file-repository.js';

const NOW = new Date('2026-08-02T10:00:00.000Z');
const LIMITS = Object.freeze({ dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 });

function authenticationFor(username) {
  const auth = (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
    req.user = username;
    req.role = 'student';
    next();
  };
  return {
    auth,
    requireRole: () => auth,
    monitoringAuth: auth,
    issueToken: async () => 'test-session',
    readCookie: () => '',
    setAuthCookie: () => {},
    clearAuthCookie: () => {},
  };
}

async function withCurrentUserApp(run, { limits = LIMITS } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-voice-user-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const username = await repository.createTelegramUser(6101, 'Voice Student');
  await repository.grantDays(6101, 30, 'Voice Student');
  const clock = { now: new Date(NOW) };
  const app = express();
  app.use(express.json());
  const authentication = authenticationFor(username);
  app.use(createUserRoutes({
    secret: 'test-secret',
    telegramEnabled: () => false,
    botUsername: () => '',
    authCodeTtlMs: 60_000,
    privacyPolicyVersion: 'test-v1',
    limiters: { telegramStart: (req, res, next) => next(), telegramCheck: (req, res, next) => next() },
    authentication,
    buildMonitoringSnapshot: async () => ({}),
    promoteConfiguredAdmin: async () => {},
    db: repository,
    voiceTutorLimits: limits,
    now: () => clock.now,
  }));
  app.use(createVoiceTutorRoutes({
    authentication, db: repository, limits, now: () => clock.now,
    realtimePolicy: { unboundCredentialRiskAccepted: true },
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run({
      repository,
      username,
      clock,
      anonymousRequest: (pathname, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, options),
      request: (pathname, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
        ...options,
        headers: { Authorization: 'Bearer test', ...(options.headers || {}) },
      }),
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('current user keeps a base subscription until voice_tutor is granted explicitly', async () => {
  await withCurrentUserApp(async ({ repository, username, request }) => {
    const baseResponse = await request('/api/v1/me');
    assert.equal(baseResponse.status, 200);
    const base = await baseResponse.json();
    assert.equal(base.active, true);
    assert.deepEqual(base.entitlements, { voice_tutor: false });
    assert.deepEqual(base.voice_tutor, {
      daily_remaining_seconds: 0,
      monthly_remaining_seconds: 0,
      active_session: false,
    });

    await repository.setEntitlement(username, 'voice_tutor', {
      startsAt: NOW,
      endsAt: new Date('2026-09-02T10:00:00.000Z'),
    });
    const premiumResponse = await request('/api/v1/me');
    assert.equal(premiumResponse.status, 200);
    const premium = await premiumResponse.json();
    assert.deepEqual(premium.entitlements, { voice_tutor: true });
    assert.deepEqual(premium.voice_tutor, {
      daily_remaining_seconds: 600,
      monthly_remaining_seconds: 7_200,
      active_session: false,
    });
    assert.equal('daily_limit_seconds' in premium.voice_tutor, false);
    assert.equal('session_limit_seconds' in premium.voice_tutor, false);
  });
});

test('voice session reservation enforces auth, Premium, one active session and an idempotent daily quota', async () => {
  await withCurrentUserApp(async ({ repository, username, clock, anonymousRequest, request }) => {
    const firstKey = '5c76e044-f7d7-4118-a893-9748867ad082';
    const unauthorized = await anonymousRequest('/api/v1/voice-tutor/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': firstKey },
    });
    assert.equal(unauthorized.status, 401);
    const baseResponse = await request('/api/v1/voice-tutor/sessions', {
      method: 'POST',
      headers: { 'Idempotency-Key': firstKey },
    });
    assert.equal(baseResponse.status, 403);
    assert.equal((await baseResponse.json()).error.code, 'VOICE_TUTOR_PREMIUM_REQUIRED');

    await repository.setEntitlement(username, 'voice_tutor', {
      startsAt: NOW,
      endsAt: new Date('2026-09-02T10:00:00.000Z'),
    });
    const createdResponse = await request('/api/v1/voice-tutor/sessions', {
      method: 'POST',
      headers: { 'Idempotency-Key': firstKey },
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.created, true);
    assert.equal(created.session.status, 'active');
    assert.deepEqual(created.voice_tutor, {
      daily_remaining_seconds: 300,
      monthly_remaining_seconds: 6_900,
      active_session: true,
    });

    const replayResponse = await request('/api/v1/voice-tutor/sessions', {
      method: 'POST',
      headers: { 'Idempotency-Key': firstKey },
    });
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.created, false);
    assert.equal(replay.session.id, created.session.id);
    assert.equal(replay.voice_tutor.daily_remaining_seconds, 300);

    const [blockedA, blockedB] = await Promise.all([
      request('/api/v1/voice-tutor/sessions', { method: 'POST', headers: { 'Idempotency-Key': '52b40b83-c36d-43cf-938c-a2c0bd0f1e74' } }),
      request('/api/v1/voice-tutor/sessions', { method: 'POST', headers: { 'Idempotency-Key': 'a836331f-11ff-4532-924a-eb9b67e65435' } }),
    ]);
    assert.deepEqual([blockedA.status, blockedB.status], [409, 409]);

    clock.now = new Date(NOW.getTime() + 120_000);
    const finishResponse = await request(`/api/v1/voice-tutor/sessions/${created.session.id}/finish`, { method: 'POST' });
    assert.equal(finishResponse.status, 200);
    const finished = await finishResponse.json();
    assert.equal(finished.finished, true);
    assert.equal(finished.voice_tutor.daily_remaining_seconds, 480);
    const finishReplay = await request(`/api/v1/voice-tutor/sessions/${created.session.id}/finish`, { method: 'POST' });
    assert.equal(finishReplay.status, 200);
    assert.equal((await finishReplay.json()).finished, false);

    const secondResponse = await request('/api/v1/voice-tutor/sessions', {
      method: 'POST',
      headers: { 'Idempotency-Key': '52b40b83-c36d-43cf-938c-a2c0bd0f1e74' },
    });
    assert.equal(secondResponse.status, 201);
    const second = await secondResponse.json();
    assert.equal(second.voice_tutor.daily_remaining_seconds, 180);
    clock.now = new Date(NOW.getTime() + 420_000);
    await request(`/api/v1/voice-tutor/sessions/${second.session.id}/finish`, { method: 'POST' });

    const exhausted = await request('/api/v1/voice-tutor/sessions', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'a836331f-11ff-4532-924a-eb9b67e65435' },
    });
    assert.equal(exhausted.status, 429);
    assert.equal((await exhausted.json()).error.code, 'VOICE_TUTOR_DAILY_QUOTA_EXHAUSTED');
  });
});

test('voice session reservation enforces the monthly quota independently', async () => {
  await withCurrentUserApp(async ({ repository, username, clock, request }) => {
    await repository.setEntitlement(username, 'voice_tutor', {
      startsAt: NOW,
      endsAt: new Date('2026-09-02T10:00:00.000Z'),
    });
    const first = await request('/api/v1/voice-tutor/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'd29bc2b7-d0b4-43df-a25f-68a5ef1d13bd' },
    });
    assert.equal(first.status, 201);
    const session = (await first.json()).session;
    clock.now = new Date(NOW.getTime() + 120_000);
    await request(`/api/v1/voice-tutor/sessions/${session.id}/finish`, { method: 'POST' });
    const exhausted = await request('/api/v1/voice-tutor/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': '79004331-cbf3-47f0-964a-fc69156b6ea4' },
    });
    assert.equal(exhausted.status, 429);
    assert.equal((await exhausted.json()).error.code, 'VOICE_TUTOR_MONTHLY_QUOTA_EXHAUSTED');
  }, { limits: { dailySeconds: 600, monthlySeconds: 300, sessionSeconds: 300 } });
});

test('legacy file data migrates to base access and account export/delete covers voice records', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-voice-legacy-'));
  const file = path.join(directory, 'data.json');
  await fs.writeFile(file, JSON.stringify({
    users: { legacy: { sub_until: NOW.getTime() + 86_400_000, created: NOW.getTime() } },
    progress: { legacy: {} },
  }));
  const repository = createFileRepository(file);
  try {
    assert.deepEqual(await repository.getVoiceTutorAccess('legacy', LIMITS, NOW), {
      entitlements: { voice_tutor: false },
      voice_tutor: { daily_remaining_seconds: 0, monthly_remaining_seconds: 0, active_session: false },
    });
    await repository.setEntitlement('legacy', 'voice_tutor', {
      startsAt: NOW,
      endsAt: new Date('2026-09-02T10:00:00.000Z'),
    });
    const reservation = await repository.reserveVoiceTutorSession('legacy', {
      id: '0e3c5b89-8705-416f-941a-4a372349811a',
      idempotencyKey: '827c8e94-e162-426f-8f1e-465bb18b9ef0',
      limits: LIMITS,
      now: NOW,
    });
    await repository.finishVoiceTutorSession('legacy', reservation.session.id, { limits: LIMITS, now: new Date(NOW.getTime() + 120_000) });
    const exported = await repository.exportUserData('legacy');
    assert.equal(exported.subscription_entitlements[0].entitlement, 'voice_tutor');
    assert.equal(exported.voice_tutor_sessions.length, 1);
    assert.equal(exported.voice_tutor_sessions[0].billable_seconds, 120);
    assert.equal(JSON.stringify(exported.voice_tutor_sessions).includes('transcript'), false);
    assert.equal(JSON.stringify(exported.voice_tutor_sessions).includes('audio'), false);

    assert.equal(await repository.deleteUserData('legacy'), true);
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(stored.subscription_entitlements.legacy, undefined);
    assert.equal(stored.voice_tutor_sessions.length, 0);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
