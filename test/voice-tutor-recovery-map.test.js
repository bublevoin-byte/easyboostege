import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createVoiceTutorRoutes } from '../routes/voice-tutor.js';
import { createFileRepository } from '../storage/file-repository.js';
import { repeatTaskFor } from '../voice-tutor/recovery.js';

const LIMITS = Object.freeze({ dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 });
test('repeat bank maps every current module skill to two distinct server-owned analogs', () => {
  const recoveries = [
    ['grammar', 'ege.grammar.past_simple'],
    ['vocabulary', 'ege.vocabulary.meaning_in_context'],
    ['reading', 'ege.reading.evidence'],
    ['listening', 'ege.listening.evidence'],
    ['writing', 'ege.writing.writing_37.criterion.1'],
    ['writing', 'ege.writing.writing_38.criterion.5'],
    ['speaking', 'ege.speaking.1.criterion.1'],
    ['speaking', 'ege.speaking.2.criterion.4'],
    ['speaking', 'ege.speaking.3.criterion.5'],
    ['speaking', 'ege.speaking.4.criterion.3'],
  ].map(([module, skill_id], index) => ({
    id: `recovery-${index}`, module, skill_id,
    origin_item_id: 'source.item', origin_transfer_task_id: 'session.transfer',
    repeat_tasks: {
      day_1: { prompt: `${skill_id} day one`, answers: [`answer-${index}-one`] },
      day_7: { prompt: `${skill_id} day seven`, answers: [`answer-${index}-seven`] },
    },
  }));

  for (const recovery of recoveries) {
    const dayOne = repeatTaskFor(recovery, 'day_1');
    const daySeven = repeatTaskFor(recovery, 'day_7');
    assert.notEqual(dayOne.id, recovery.origin_item_id);
    assert.notEqual(dayOne.id, recovery.origin_transfer_task_id);
    assert.notEqual(dayOne.prompt, daySeven.prompt);
    assert.ok(dayOne.answers.length > 0);
    assert.ok(daySeven.answers.length > 0);
    assert.notEqual(dayOne.id, repeatTaskFor({ ...recovery, id: `${recovery.id}-new` }, 'day_1').id);
  }
  const vocabulary = recoveries.find((recovery) => recovery.module === 'vocabulary');
  const reading = recoveries.find((recovery) => recovery.module === 'reading');
  assert.match(repeatTaskFor(vocabulary, 'day_1').prompt, new RegExp(vocabulary.skill_id, 'u'));
  assert.match(repeatTaskFor(reading, 'day_7').prompt, new RegExp(reading.skill_id, 'u'));
});

function authentication() {
  return {
    auth(req, res, next) {
      const username = String(req.headers.authorization || '').replace(/^Bearer\s+/u, '');
      if (!username) return res.status(401).json({ error: { code: 'AUTH_REQUIRED' } });
      req.user = username;
      next();
    },
  };
}

async function withRecoveryApp(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-voice-recovery-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(7601, 'Recovery Owner');
  const stranger = await repository.createTelegramUser(7602, 'Recovery Stranger');
  let clock = new Date('2026-08-02T12:00:00.000Z');
  for (const [telegramId, username] of [[7601, owner], [7602, stranger]]) {
    await repository.grantDays(telegramId, 30, username);
    await repository.setEntitlement(username, 'voice_tutor', { startsAt: clock, endsAt: new Date('2026-09-02T12:00:00.000Z') });
    await repository.setPrivacyConsent(username, { text_processing: true, voice_processing: true, policy_version: 'test-v1' });
  }
  const sessionIds = [
    'df312364-a616-4e2b-8531-fb232ef2a41a',
    '2efba6c6-e4d8-4c42-8411-1af91b94d804',
  ];
  const nonces = Array.from({ length: 20 }, (_, index) => `recovery-nonce-${String(index + 1).padStart(4, '0')}`);
  const app = express();
  app.use(express.json());
  app.use(createVoiceTutorRoutes({
    authentication: authentication(),
    db: repository,
    limits: LIMITS,
    now: () => clock,
    newSessionId: () => sessionIds.shift(),
    newNonce: () => nonces.shift(),
    realtimeProxy: {
      proxyPath: '/api/v1/voice-tutor/realtime', ticketTtlSeconds: 30,
      claimPedagogyCall() { return true; },
      completePedagogyCall() { return true; },
      failPedagogyCall() { return true; },
    },
    realtimePolicy: { enabled: true, requireZdr: true, zdrAttested: true },
    privacyPolicyVersion: 'test-v1',
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (username, pathname, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${username}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  try {
    await run({ repository, owner, stranger, request, setClock(value) { clock = new Date(value); } });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function createResolvedGrammarSession({ repository, owner, request }, {
  attemptId = '09cf8e29-86d1-4c07-b6ae-52a442918bd1',
  idempotencyKey = 'recovery-map-session-0001',
  microAnswers = ['went'],
} = {}) {
  const recorded = await request(owner, '/api/v1/voice-tutor/errors', {
    method: 'POST', body: JSON.stringify({
      attemptId, module: 'grammar', itemId: 'grammar.past-simple.last-summer', revision: 1, learnerAnswer: 'goed',
    }),
  });
  assert.equal(recorded.status, 201);
  const started = await request(owner, '/api/v1/voice-tutor/sessions', {
    method: 'POST', headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ attemptId, revision: 1 }),
  });
  assert.equal(started.status, 201);
  const created = await started.json();
  let nonce = created.nonce;
  const events = [{ type: 'diagnosis_complete' }, { type: 'explanation_complete' }];
  microAnswers.forEach((answer, index) => {
    events.push({ type: 'check_answer', answer });
    if (index < microAnswers.length - 1) events.push({ type: 'explanation_complete' });
  });
  events.push({ type: 'transfer_answer', answer: 'bought' });
  let providerCall = 0;
  for (const event of events) {
    const response = await request(owner, `/api/v1/voice-tutor/sessions/${created.session.id}/events`, {
      method: 'POST', body: JSON.stringify({
        nonce, event, provider_call_id: `recovery-call-${++providerCall}`,
      }),
    });
    assert.equal(response.status, 200);
    nonce = (await response.json()).nonce;
  }
  const stored = await repository.getVoiceTutorSession(owner, created.session.id);
  assert.equal(stored.outcome, 'resolved');
  return { ...created, nonce };
}

test('micro-check metrics count every checked try without retaining answers', async () => {
  await withRecoveryApp(async (context) => {
    const created = await createResolvedGrammarSession(context, { microAnswers: ['wrong', 'went'] });
    const terminalReplay = await context.request(context.owner, `/api/v1/voice-tutor/sessions/${created.session.id}/events`, {
      method: 'POST', body: JSON.stringify({
        nonce: created.nonce, event: { type: 'check_answer', answer: 'wrong' }, provider_call_id: 'recovery-call-terminal',
      }),
    });
    assert.equal(terminalReplay.status, 200);
    const metrics = await context.repository.getVoiceTutorRecoveryMetrics(new Date('2026-08-02T12:00:00.000Z'));
    assert.deepEqual(metrics.micro_check, { passed: 1, observed: 2, rate: 0.5 });
    const exported = await context.repository.exportUserData(context.owner);
    assert.equal(JSON.stringify(exported.voice_tutor_sessions).includes('wrong'), false);
    assert.equal(exported.voice_tutor_sessions[0].micro_check_attempts, 2);
    assert.equal(exported.voice_tutor_sessions[0].micro_check_passes, 1);
  });
});

test('server-validated transfer creates bounded 1-day/7-day recovery repeats and rejects tampering', async () => {
  await withRecoveryApp(async (context) => {
    const { repository, owner, stranger, request, setClock } = context;
    const created = await createResolvedGrammarSession(context);
    await repository.consumeVoiceTutorProxyTicket(owner, {
      ticketHash: crypto.createHash('sha256').update(created.realtime.ticket).digest('hex'),
      now: new Date('2026-08-02T12:00:00.000Z'),
      provider: 'xai', model: 'grok-voice-think-fast-1.0', promptVersion: 'voice-tutor-error-v2',
    });
    await repository.activateVoiceTutorProxySession(owner, created.session.id, {
      now: new Date('2026-08-02T12:00:00.000Z'),
    });
    await repository.finalizeVoiceTutorProxySession(owner, created.session.id, {
      inputAudioBytes: 120 * 48_000, outputAudioBytes: 0, confirmed: true, reason: 'completed',
      limits: LIMITS, now: new Date('2026-08-02T12:02:00.000Z'),
    });
    await repository.finishVoiceTutorSession(owner, created.session.id, {
      limits: LIMITS,
      now: new Date('2026-08-02T12:02:00.000Z'),
    });

    const initialResponse = await request(owner, '/api/v1/voice-tutor/recovery-map');
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.deepEqual(initial.summary, { open: 1, recovered: 0, relapsed: 0, potential_ege_points: 1 });
    assert.deepEqual(initial.error_recovery_rate, { numerator: 0, denominator: 0, rate: 0 });
    assert.equal(initial.voice_minutes.used_monthly, 2);
    assert.equal(initial.voice_minutes.remaining_monthly, 118);
    assert.equal(initial.skills[0].skill_id, 'ege.grammar.past_simple');
    assert.equal(initial.skills[0].state, 'open');
    assert.equal(initial.skills[0].initial_micro_check_passed, true);
    assert.equal(initial.skills[0].rule_id, 'grammar.past-simple.v1');
    assert.equal(initial.skills[0].repeats[0].stage, 'day_1');
    assert.equal(initial.skills[0].repeats[0].status, 'upcoming');
    assert.notEqual(initial.skills[0].repeats[0].task_id, created.capsule.item.id);
    assert.notEqual(initial.skills[0].repeats[0].task_id, created.capsule.checks.transfer_task.id);
    assert.notEqual(initial.skills[0].repeats[0].prompt, created.capsule.item.prompt);
    assert.notEqual(initial.skills[0].repeats[0].prompt, created.capsule.checks.micro_check.prompt);
    assert.notEqual(initial.skills[0].repeats[0].prompt, created.capsule.checks.transfer_task.prompt);
    assert.notEqual(initial.skills[0].repeats[1].prompt, created.capsule.item.prompt);
    assert.notEqual(initial.skills[0].repeats[1].prompt, created.capsule.checks.micro_check.prompt);
    assert.notEqual(initial.skills[0].repeats[1].prompt, created.capsule.checks.transfer_task.prompt);
    assert.notEqual(initial.skills[0].repeats[1].prompt, initial.skills[0].repeats[0].prompt);
    assert.equal(initial.next_best_review.type, 'skill');
    assert.equal(JSON.stringify(initial).includes('goed'), false);
    assert.equal(JSON.stringify(initial).includes('bought'), false);

    await repository.setEntitlement(owner, 'voice_tutor', {
      startsAt: new Date('2026-07-01T00:00:00.000Z'),
      endsAt: new Date('2026-08-02T11:59:00.000Z'),
    });
    const inactiveMap = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    assert.equal(inactiveMap.voice_minutes.used_monthly, 2);
    assert.equal(inactiveMap.voice_minutes.remaining_monthly, 0);

    const futureRepeat = initial.skills[0].repeats[1];
    let response = await request(owner, `/api/v1/voice-tutor/repeats/${futureRepeat.id}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId: '65770643-b9e3-4835-97c2-5527ae730887', taskId: futureRepeat.task_id, answer: 'met' }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'VOICE_TUTOR_REPEAT_NOT_DUE');

    response = await request(stranger, `/api/v1/voice-tutor/repeats/${initial.skills[0].repeats[0].id}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId: '87513b47-47fd-43ac-978d-75c7e28483a7', taskId: initial.skills[0].repeats[0].task_id, answer: 'came' }),
    });
    assert.equal(response.status, 404);

    setClock('2026-08-03T12:00:00.000Z');
    const dueMap = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    const dayOne = dueMap.due_repeats[0];
    assert.equal(dayOne.stage, 'day_1');
    assert.equal(dayOne.status, 'due');
    assert.equal(dueMap.next_best_review.repeat_id, dayOne.id);

    response = await request(owner, `/api/v1/voice-tutor/repeats/${dayOne.id}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId: 'c21b4f2b-a8c2-47fb-8044-1adb86d6bf4f', taskId: created.capsule.item.id, answer: 'came' }),
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'VOICE_TUTOR_REPEAT_TASK_MISMATCH');

    response = await request(owner, `/api/v1/voice-tutor/repeats/${dayOne.id}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId: 'c21b4f2b-a8c2-47fb-8044-1adb86d6bf4f', taskId: dayOne.task_id, answer: 'came', skillId: 'tampered', potentialPoints: 99 }),
    });
    assert.equal(response.status, 400);

    const attempt = { attemptId: 'c21b4f2b-a8c2-47fb-8044-1adb86d6bf4f', taskId: dayOne.task_id, answer: 'came' };
    response = await request(owner, `/api/v1/voice-tutor/repeats/${dayOne.id}/attempts`, { method: 'POST', body: JSON.stringify(attempt) });
    assert.equal(response.status, 201);
    const passed = await response.json();
    assert.equal(passed.created, true);
    assert.equal(passed.attempt.passed, true);
    assert.equal(passed.attempt.answer, undefined);

    response = await request(owner, `/api/v1/voice-tutor/repeats/${dayOne.id}/attempts`, { method: 'POST', body: JSON.stringify(attempt) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).created, false);

    response = await request(owner, `/api/v1/voice-tutor/repeats/${dayOne.id}/attempts`, {
      method: 'POST', body: JSON.stringify({ ...attempt, attemptId: '4bec1cef-d890-4f02-9669-9a51c4106b5f' }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'VOICE_TUTOR_REPEAT_ALREADY_ATTEMPTED');

    const exported = await repository.exportUserData(owner);
    assert.equal(exported.voice_tutor_recoveries.length, 1);
    assert.equal(exported.voice_tutor_repeat_attempts.length, 1);
    assert.equal(JSON.stringify(exported.voice_tutor_repeat_attempts).includes('went'), false);
    assert.equal(JSON.stringify(exported.voice_tutor_repeat_attempts).includes('bought'), false);
  });
});

test('two distinct server-owned repeat attempts recover a skill and a newer session supersedes stale repeats', async () => {
  await withRecoveryApp(async (context) => {
    const { owner, request, setClock } = context;
    await createResolvedGrammarSession(context);

    setClock('2026-08-03T12:00:00.000Z');
    let map = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    let repeat = map.skills[0].repeats[0];
    let response = await request(owner, `/api/v1/voice-tutor/repeats/${repeat.id}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId: '13c362cf-bb81-40c9-9dd3-3194686d5090', taskId: repeat.task_id, answer: 'came' }),
    });
    assert.equal(response.status, 201);

    setClock('2026-08-09T12:00:00.000Z');
    map = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    repeat = map.skills[0].repeats[1];
    assert.equal(repeat.status, 'due');
    response = await request(owner, `/api/v1/voice-tutor/repeats/${repeat.id}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId: '2a9b390e-2504-410a-a686-fbf4c8381c51', taskId: repeat.task_id, answer: 'met' }),
    });
    assert.equal(response.status, 201);
    map = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    assert.equal(map.skills[0].state, 'recovered');
    assert.deepEqual(map.error_recovery_rate, { numerator: 1, denominator: 1, rate: 1 });
    assert.equal(map.summary.potential_ege_points, 0);

    setClock('2026-08-10T12:00:00.000Z');
    const priorRecovery = map.skills[0].recovery_id;
    const priorTaskIds = map.skills[0].repeats.map((item) => item.task_id);
    await createResolvedGrammarSession(context, {
      attemptId: '5a4d3f19-985d-49b6-aefa-68b77f461d8c',
      idempotencyKey: 'recovery-map-session-0002',
    });
    map = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    assert.equal(map.skills[0].state, 'open');
    assert.notEqual(map.skills[0].recovery_id, priorRecovery);
    assert.notDeepEqual(map.skills[0].repeats.map((item) => item.task_id), priorTaskIds);

    const exported = await context.repository.exportUserData(owner);
    const staleUnattempted = exported.voice_tutor_repeats.find((item) => item.recovery_id === priorRecovery && !exported.voice_tutor_repeat_attempts.some((attempt) => attempt.repeat_id === item.id));
    assert.equal(staleUnattempted, undefined, 'both prior repeats were observed, so completed history is retained rather than expired');

    const freshDayOne = map.skills[0].repeats[0];
    setClock('2026-08-12T12:00:00.000Z');
    response = await request(owner, `/api/v1/voice-tutor/repeats/${freshDayOne.id}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId: '8a1371de-8856-434f-8c05-6274716205ef', taskId: freshDayOne.task_id, answer: 'came' }),
    });
    assert.equal(response.status, 201, 'overdue repeat remains runnable and reopens a completable chain');
    const shifted = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    assert.equal(shifted.skills[0].repeats[1].due_at, '2026-08-18T12:00:00.000Z');
  });
});

test('a newer validated recovery expires only the stale unattempted chain and leaves a fresh runnable chain', async () => {
  await withRecoveryApp(async (context) => {
    const { owner, request, setClock } = context;
    await createResolvedGrammarSession(context);
    const first = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    const stale = first.skills[0].repeats[0];

    setClock('2026-08-03T12:00:00.000Z');
    await createResolvedGrammarSession(context, {
      attemptId: 'f629e997-f480-4bc2-a40e-0c7fcf37d872',
      idempotencyKey: 'recovery-map-session-0002',
    });
    const current = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    assert.equal(current.skills.length, 1);
    assert.equal(current.skills[0].state, 'open');
    assert.notEqual(current.skills[0].repeats[0].id, stale.id);

    const expired = await request(owner, `/api/v1/voice-tutor/repeats/${stale.id}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId: '7db05832-b1ac-4e9a-8a24-3a54a69ca76e', taskId: stale.task_id, answer: 'came' }),
    });
    assert.equal(expired.status, 409);
    assert.equal((await expired.json()).error.code, 'VOICE_TUTOR_REPEAT_EXPIRED');
  });
});

test('only observed server-checked repeat failures relapse; overdue stays open and rate excludes open', async () => {
  await withRecoveryApp(async (context) => {
    const { owner, request, setClock, repository } = context;
    await createResolvedGrammarSession(context);

    setClock('2026-08-10T12:00:00.000Z');
    let map = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    assert.equal(map.skills[0].state, 'open');
    assert.equal(map.skills[0].repeats[0].status, 'overdue');
    assert.equal(map.skills[0].repeats[1].status, 'overdue');
    assert.deepEqual(map.error_recovery_rate, { numerator: 0, denominator: 0, rate: 0 });

    const daySeven = map.skills[0].repeats[1];
    const failed = await request(owner, `/api/v1/voice-tutor/repeats/${daySeven.id}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId: '715c3386-6a23-43b0-984f-62c3a2d24c0e', taskId: daySeven.task_id, answer: 'wrong' }),
    });
    assert.equal(failed.status, 409);
    assert.equal((await failed.json()).error.code, 'VOICE_TUTOR_REPEAT_OUT_OF_ORDER');

    const dayOne = map.skills[0].repeats[0];
    const overdueAttempt = await request(owner, `/api/v1/voice-tutor/repeats/${dayOne.id}/attempts`, {
      method: 'POST', body: JSON.stringify({ attemptId: '815c3386-6a23-43b0-984f-62c3a2d24c0e', taskId: dayOne.task_id, answer: 'wrong' }),
    });
    assert.equal(overdueAttempt.status, 201);
    assert.equal((await overdueAttempt.json()).attempt.passed, false);

    map = await (await request(owner, '/api/v1/voice-tutor/recovery-map')).json();
    assert.equal(map.skills[0].state, 'relapsed');
    assert.deepEqual(map.error_recovery_rate, { numerator: 0, denominator: 1, rate: 0 });
    assert.deepEqual(await repository.getVoiceTutorRecoveryMetrics(new Date('2026-08-10T12:00:00.000Z')), {
      open: 0, recovered: 0, relapsed: 1, numerator: 0, denominator: 1, error_recovery_rate: 0,
      due_repeats: 0, overdue_repeats: 1, sessions: 1, voice_minutes: 0,
      delivery: { voice: 1, text: 0, local: 0 }, fallback_rate: 0,
      provider_errors: 0, estimated_cost_microusd: 0,
      micro_check: { passed: 1, observed: 1, rate: 1 },
      initial_transfer: { passed: 1, observed: 1, rate: 1 },
      repeat_passes: {
        day_1: { passed: 0, observed: 1, rate: 0 },
        day_7: { passed: 0, observed: 0, rate: 0 },
      },
    });

    assert.equal(await repository.deleteUserData(owner), true);
    assert.equal(await repository.exportUserData(owner), null);
    assert.deepEqual(await repository.getVoiceTutorRecoveryMetrics(new Date('2026-08-10T12:00:00.000Z')), {
      open: 0, recovered: 0, relapsed: 0, numerator: 0, denominator: 0, error_recovery_rate: 0,
      due_repeats: 0, overdue_repeats: 0, sessions: 0, voice_minutes: 0,
      delivery: { voice: 0, text: 0, local: 0 }, fallback_rate: 0,
      provider_errors: 0, estimated_cost_microusd: 0,
      micro_check: { passed: 0, observed: 0, rate: 0 },
      initial_transfer: { passed: 0, observed: 0, rate: 0 },
      repeat_passes: {
        day_1: { passed: 0, observed: 0, rate: 0 },
        day_7: { passed: 0, observed: 0, rate: 0 },
      },
    });
  });
});
