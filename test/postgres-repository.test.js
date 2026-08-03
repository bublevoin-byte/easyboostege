import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createPostgresRepository } from '../storage/postgres-repository.js';
import { buildGrammarLexiconCapsule, createGrammarLexiconErrorAttempt, persistedVoiceTutorCapsule } from '../voice-tutor/capsule.js';
import { buildAdaptiveLearningProfile } from '../adaptive-learning/profile.js';
import {
  assertAdaptiveProfileAppendOnlyOrdering,
  assertAdaptiveProfileRejectsStale,
  assertAdaptiveProfileRepositoryContract,
} from './support/adaptive-profile-contract.js';
import { assertAdaptiveGoalRepositoryContract } from './support/adaptive-goal-contract.js';
import { assertAdaptiveDiagnosticRepositoryContract } from './support/adaptive-diagnostic-contract.js';

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL adaptive diagnostic matches the shared persistence and export contract', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const stamp = Date.now() + 3;
  const username = await repository.createTelegramUser(Number(`5${String(stamp).slice(-9)}`), `Diagnostic ${stamp}`);
  try {
    await assertAdaptiveDiagnosticRepositoryContract(assert, repository, username);
    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.exportUserData(username), null);
    assert.equal(await repository.getCurrentAdaptiveDiagnostic(username), null);
  } finally {
    await repository.deleteUserData(username).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL adaptive profile save does not exhaust the primary pool before reading its result', { skip: !connectionString }, () => {
  const script = `
    const { createPostgresRepository } = await import('./storage/postgres-repository.js');
    const { buildAdaptiveLearningProfile } = await import('./adaptive-learning/profile.js');
    const repository = createPostgresRepository(process.env.TEST_DATABASE_URL);
    const stamp = Date.now();
    const users = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      repository.createTelegramUser(Number('7' + String(stamp + index).slice(-9)), 'Pool ' + stamp + ' ' + index)));
    const profile = buildAdaptiveLearningProfile();
    await Promise.all(users.map((username) => repository.saveAdaptiveLearningProfile(username, profile)));
    await repository.close();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_DATABASE_URL: connectionString },
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.error?.code || null, null, result.error?.message || result.stderr);
  assert.equal(result.status, 0, result.stderr);
});

test('PostgreSQL adaptive save returns one transaction snapshot and blocks a newer writer until capture', { skip: !connectionString }, async () => {
  let releaseSnapshot;
  let reportSnapshotReached;
  let paused = false;
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotReached = new Promise((resolve) => { reportSnapshotReached = resolve; });
  const repository = createPostgresRepository(connectionString, {
    onAdaptiveProfileSnapshot: async ({ profile }) => {
      if (!paused && Number(profile.evidence_source_count) === 1) {
        paused = true;
        reportSnapshotReached();
        await snapshotRelease;
      }
    },
  });
  const stamp = Date.now();
  const username = await repository.createTelegramUser(Number(`6${String(stamp).slice(-9)}`), `Atomic ${stamp}`);
  const attempt = (id, createdAt, score) => ({
    id, module: 'grammar', activity: 'grammar_19_24', score, max_score: 10,
    evidence_quality: 'server_verified_unassisted', created_at: createdAt,
  });
  const first = attempt(crypto.randomUUID(), '2026-08-04T05:00:00.000Z', 2);
  const second = attempt(crypto.randomUUID(), '2026-08-04T06:00:00.000Z', 10);

  try {
    const olderSave = repository.saveAdaptiveLearningProfile(
      username,
      buildAdaptiveLearningProfile({ attempts: [first] }),
      { now: new Date('2026-08-04T07:00:00.000Z') },
    );
    await Promise.race([
      snapshotReached,
      new Promise((_, reject) => setTimeout(() => reject(new Error('ATOMIC_SNAPSHOT_HOOK_NOT_REACHED')), 1_000)),
    ]);
    let newerFinished = false;
    const newerSave = repository.saveAdaptiveLearningProfile(
      username,
      buildAdaptiveLearningProfile({ attempts: [first, second] }),
      { now: new Date('2026-08-04T07:01:00.000Z') },
    ).then((result) => { newerFinished = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(newerFinished, false, 'newer writer waits while the older transaction captures its DTO');
    releaseSnapshot();
    const [olderResult, newerResult] = await Promise.all([olderSave, newerSave]);
    assert.equal(olderResult.evidence_source_count, 1);
    assert.equal(newerResult.evidence_source_count, 2);
    for (const result of [olderResult, newerResult]) {
      assert.ok(result.estimates.every((estimate) => estimate.updated_at === result.updated_at));
    }
  } finally {
    releaseSnapshot?.();
    await repository.close();
  }
});

test('PostgreSQL adaptive get returns profile and estimates from one MVCC snapshot', { skip: !connectionString }, async () => {
  let releaseSnapshot;
  let reportSnapshotReached;
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotReached = new Promise((resolve) => { reportSnapshotReached = resolve; });
  const writer = createPostgresRepository(connectionString);
  const reader = createPostgresRepository(connectionString, {
    onAdaptiveProfileSnapshot: async () => {
      reportSnapshotReached();
      await snapshotRelease;
    },
  });
  const stamp = Date.now();
  const username = await writer.createTelegramUser(Number(`5${String(stamp).slice(-9)}`), `Profile read ${stamp}`);
  const attempt = (createdAt) => ({
    id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24', score: 8, max_score: 10,
    evidence_quality: 'server_verified_unassisted', created_at: createdAt,
  });
  const first = attempt('2026-08-04T05:00:00.000Z');
  const second = attempt('2026-08-04T06:00:00.000Z');

  try {
    await writer.saveAdaptiveLearningProfile(username, buildAdaptiveLearningProfile({ attempts: [first] }), {
      now: new Date('2026-08-04T07:00:00.000Z'),
    });
    const reading = reader.getAdaptiveLearningProfile(username);
    await Promise.race([
      snapshotReached,
      new Promise((_, reject) => setTimeout(() => reject(new Error('PROFILE_READ_SNAPSHOT_HOOK_NOT_REACHED')), 1_000)),
    ]);
    await writer.saveAdaptiveLearningProfile(username, buildAdaptiveLearningProfile({ attempts: [first, second] }), {
      now: new Date('2026-08-04T07:01:00.000Z'),
    });
    releaseSnapshot();
    const result = await reading;
    assert.equal(result.evidence_source_count, 1);
    assert.ok(result.estimates.every((estimate) => estimate.updated_at === result.updated_at));
  } finally {
    releaseSnapshot?.();
    await Promise.all([reader.close(), writer.close()]);
  }
});

test('PostgreSQL adaptive export captures profile and estimates atomically', { skip: !connectionString }, async () => {
  let releaseSnapshot;
  let reportSnapshotReached;
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotReached = new Promise((resolve) => { reportSnapshotReached = resolve; });
  const writer = createPostgresRepository(connectionString);
  const reader = createPostgresRepository(connectionString, {
    onAdaptiveProfileSnapshot: async () => {
      reportSnapshotReached();
      await snapshotRelease;
    },
  });
  const stamp = Date.now() + 1;
  const username = await writer.createTelegramUser(Number(`5${String(stamp).slice(-9)}`), `Profile export ${stamp}`);
  const attempt = (createdAt) => ({
    id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24', score: 8, max_score: 10,
    evidence_quality: 'server_verified_unassisted', created_at: createdAt,
  });
  const first = attempt('2026-08-04T05:00:00.000Z');
  const second = attempt('2026-08-04T06:00:00.000Z');

  try {
    await writer.saveAdaptiveLearningProfile(username, buildAdaptiveLearningProfile({ attempts: [first] }), {
      now: new Date('2026-08-04T07:00:00.000Z'),
    });
    const exporting = reader.exportUserData(username);
    await Promise.race([
      snapshotReached,
      new Promise((_, reject) => setTimeout(() => reject(new Error('PROFILE_EXPORT_SNAPSHOT_HOOK_NOT_REACHED')), 1_000)),
    ]);
    await writer.saveAdaptiveLearningProfile(username, buildAdaptiveLearningProfile({ attempts: [first, second] }), {
      now: new Date('2026-08-04T07:01:00.000Z'),
    });
    releaseSnapshot();
    const result = await exporting;
    assert.equal(result.adaptive_learning_profile.evidence_source_count, 1);
    assert.ok(result.adaptive_learning_skill_estimates.every((estimate) => (
      estimate.updated_at === result.adaptive_learning_profile.updated_at
    )));
  } finally {
    releaseSnapshot?.();
    await Promise.all([reader.close(), writer.close()]);
  }
});

test('PostgreSQL adaptive evidence sources come from one MVCC snapshot without orphan repeats', { skip: !connectionString }, async () => {
  let releaseSnapshot;
  let reportSnapshotReached;
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const snapshotReached = new Promise((resolve) => { reportSnapshotReached = resolve; });
  const repository = createPostgresRepository(connectionString, {
    onAdaptiveEvidenceSnapshot: async () => {
      reportSnapshotReached();
      await snapshotRelease;
    },
  });
  const client = new pg.Client({ connectionString });
  const stamp = Date.now() + 2;
  const username = await repository.createTelegramUser(Number(`5${String(stamp).slice(-9)}`), `Evidence read ${stamp}`);
  const sessionId = crypto.randomUUID();
  const recoveryId = crypto.randomUUID();
  const repeatId = crypto.randomUUID();
  const repeatAttemptId = crypto.randomUUID();
  await client.connect();

  try {
    const reading = repository.getAdaptiveLearningEvidenceSources(username);
    await Promise.race([
      snapshotReached,
      new Promise((_, reject) => setTimeout(() => reject(new Error('EVIDENCE_SNAPSHOT_HOOK_NOT_REACHED')), 1_000)),
    ]);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO voice_tutor_sessions
       (id, username, idempotency_key, status, reserved_seconds, billable_seconds, started_at, expires_at, ended_at)
       VALUES ($1, $2, $3, 'completed', 1, 0, $4, $5, $5)`,
      [sessionId, username, crypto.randomUUID(), new Date('2026-08-04T08:00:00.000Z'), new Date('2026-08-04T08:05:00.000Z')],
    );
    await client.query(
      `INSERT INTO voice_tutor_recoveries
       (id, username, session_id, skill_id, skill_label, module, rule_id, origin_item_id,
        origin_transfer_task_id, initial_micro_check_passed, initial_transfer_passed,
        terminal_outcome, potential_ege_points, observed_at)
       VALUES ($1, $2, $3, 'ege.grammar.forms', 'Forms', 'grammar', 'rule', 'item',
               'transfer', TRUE, TRUE, 'resolved', 1, $4)`,
      [recoveryId, username, sessionId, new Date('2026-08-04T08:04:00.000Z')],
    );
    await client.query(
      `INSERT INTO voice_tutor_repeats
       (id, recovery_id, stage, task_id, due_at, window_ends_at)
       VALUES ($1, $2, 'day_1', 'task', $3, $4)`,
      [repeatId, recoveryId, new Date('2026-08-05T08:00:00.000Z'), new Date('2026-08-06T08:00:00.000Z')],
    );
    await client.query(
      `INSERT INTO voice_tutor_repeat_attempts (id, repeat_id, task_id, passed, fingerprint, observed_at)
       VALUES ($1, $2, 'task', TRUE, $3, $4)`,
      [repeatAttemptId, repeatId, 'b'.repeat(64), new Date('2026-08-05T09:00:00.000Z')],
    );
    await client.query('COMMIT');
    releaseSnapshot();
    const result = await reading;
    assert.deepEqual(result.recoveries, []);
    assert.deepEqual(result.repeatAttempts, []);
  } finally {
    releaseSnapshot?.();
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
    await repository.deleteUserData(username).catch(() => {});
    await repository.close();
  }
});

test('PostgreSQL repository persists the production data flow', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const client = new pg.Client({ connectionString });
  const suffix = crypto.randomBytes(6).toString('hex');
  const telegramId = Number(`8${Date.now().toString().slice(-9)}`);
  const independentActorTelegramId = telegramId + 1;
  await client.connect();

  try {
    const migrations = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(migrations.rows.map((row) => row.version), [
      '001_initial.sql', '002_telegram_auth_codes.sql', '003_writing_attempt_error_code.sql',
      '004_privacy_consents.sql', '005_ai_token_usage.sql', '006_ai_estimated_cost.sql', '007_sessions.sql',
      '008_user_roles.sql',
      '009_subscriptions_and_payments.sql',
      '010_speaking_attempts.sql',
      '011_generated_tasks.sql',
      '012_module_attempts.sql',
      '013_word_progress.sql',
      '014_error_bank.sql',
      '015_audit_log.sql',
      '016_progress_summary.sql',
      '017_ai_fallback_reason.sql',
      '018_task_bank.sql',
      '019_attempt_models.sql',
      '020_writing_evaluated_answer.sql',
      '021_voice_tutor_entitlements_and_quotas.sql',
      '022_voice_tutor_tracer.sql',
      '023_trusted_rule_cards.sql',
      '024_voice_tutor_recovery_map.sql',
      '025_voice_tutor_hardening.sql',
      '026_premium_voice_commerce.sql',
      '027_voice_tutor_pedagogical_loop.sql',
      '028_voice_tutor_discovery_claims.sql',
      '029_voice_tutor_realtime_proxy.sql',
      '030_voice_tutor_fallback_and_recovery_tasks.sql',
      '031_adaptive_learning_goal_profile.sql',
      '032_adaptive_short_diagnostic.sql',
    ]);

    const username = await repository.createTelegramUser(telegramId, `Integration ${suffix}`);
    assert.equal((await repository.getUser(username)).telegram_id, telegramId);
    assert.equal(await repository.setUserRole(username, 'admin'), 'admin');
    assert.equal((await repository.getUser(username)).role, 'admin');
    const ruleCardId = crypto.randomUUID();
    await repository.createRuleCard({
      id: ruleCardId, createdForUsername: username, status: 'pending_review',
      skill: { id: `ege.grammar.integration.${suffix}`, title: 'Integration rule' }, examYear: 2026,
      rule: { title: 'Integration rule', explanation: 'A bounded explanation.', examples: ['It works.'] },
      agreementHash: 'a'.repeat(64),
      sources: [
        { authority: 'one', url: 'https://one.example/rule', retrieved_at: new Date().toISOString(), content_hash: 'b'.repeat(64) },
        { authority: 'two', url: 'https://two.example/rule', retrieved_at: new Date().toISOString(), content_hash: 'c'.repeat(64) },
      ],
      discrepancies: [], createdAt: new Date(),
    });
    assert.equal((await repository.getApprovedRuleCard(`ege.grammar.integration.${suffix}`, 2026)), null);
    assert.equal((await repository.reviewRuleCard(ruleCardId, { decision: 'approved', reviewer: username, reviewedAt: new Date() })).applied, true);
    assert.equal((await repository.reviewRuleCard(ruleCardId, { decision: 'approved', reviewer: username, reviewedAt: new Date() })).applied, false);
    assert.equal((await repository.getApprovedRuleCard(`ege.grammar.integration.${suffix}`, 2026)).status, 'approved');
    const ruleReportId = crypto.randomUUID();
    await repository.createRuleCard({
      id: ruleReportId, createdForUsername: username, status: 'pending_review',
      skill: { id: `ege.grammar.report.${suffix}`, title: 'Integration report' }, examYear: 2026,
      rule: { title: 'Integration report', explanation: 'Pending bounded evidence.', examples: ['It may work.'] },
      agreementHash: 'd'.repeat(64),
      sources: [
        { authority: 'one', url: 'https://one.example/report', retrieved_at: new Date().toISOString(), content_hash: 'e'.repeat(64) },
        { authority: 'two', url: 'https://two.example/report', retrieved_at: new Date().toISOString(), content_hash: 'f'.repeat(64) },
      ],
      discrepancies: [], createdAt: new Date(),
    });

    const trial = await repository.activateTrial(telegramId, 30, 'Integration User');
    assert.equal(trial.applied, true);
    assert.equal((await repository.activateTrial(telegramId, 30, 'Integration User')).applied, false);

    const paymentRequest = await repository.createPaymentRequest(crypto.randomUUID(), telegramId, 'Integration User');
    const approvedPayment = await repository.resolvePaymentRequest(paymentRequest.id, 'approved', independentActorTelegramId, 30);
    assert.equal(approvedPayment.applied, true);
    assert.equal(approvedPayment.product, 'base');
    assert.equal((await repository.resolvePaymentRequest(paymentRequest.id, 'approved', independentActorTelegramId, 30)).applied, false);

    const premiumRequest = await repository.createPaymentRequestForUser(crypto.randomUUID(), username, 'premium_voice');
    assert.equal((await repository.listPaymentRequests({ product: 'premium_voice', status: 'new' })).some((request) => request.id === premiumRequest.id), true);
    await assert.rejects(
      repository.resolvePaymentRequest(premiumRequest.id, 'approved', telegramId, 30),
      /PAYMENT_SELF_APPROVAL_FORBIDDEN/u,
    );
    const premiumNow = new Date();
    const premiumApproval = await repository.resolvePaymentRequest(premiumRequest.id, 'approved', independentActorTelegramId, 30, { now: premiumNow });
    assert.equal(premiumApproval.product, 'premium_voice');
    assert.equal((await repository.getVoiceTutorAccess(username, { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 }, premiumNow)).entitlements.voice_tutor, true);
    assert.equal(await repository.revokeEntitlement(username, 'voice_tutor', independentActorTelegramId, { now: premiumNow }), false);
    assert.equal(await repository.revokeEntitlement(username, 'voice_tutor', independentActorTelegramId, { now: new Date(premiumNow.getTime() + 1) }), true);
    assert.equal(await repository.revokeEntitlement(username, 'voice_tutor', independentActorTelegramId, { now: new Date(premiumNow.getTime() + 1) }), false);

    const sessionId = crypto.randomUUID();
    await repository.createSession(sessionId, username, Date.now() + 60_000);
    assert.equal(await repository.isSessionActive(sessionId, username), true);
    assert.equal(await repository.revokeSession(sessionId, username), true);
    assert.equal(await repository.isSessionActive(sessionId, username), false);

    const voiceNow = new Date();
    const voiceLimits = { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 };
    assert.equal((await repository.getVoiceTutorAccess(username, voiceLimits, voiceNow)).entitlements.voice_tutor, false);
    await repository.setEntitlement(username, 'voice_tutor', {
      startsAt: voiceNow,
      endsAt: new Date(voiceNow.getTime() + 30 * 86_400_000),
    });
    const voiceKey = crypto.randomUUID();
    const [firstVoiceReservation, repeatedVoiceReservation] = await Promise.all([
      repository.reserveVoiceTutorSession(username, { id: crypto.randomUUID(), idempotencyKey: voiceKey, limits: voiceLimits, now: voiceNow }),
      repository.reserveVoiceTutorSession(username, { id: crypto.randomUUID(), idempotencyKey: voiceKey, limits: voiceLimits, now: voiceNow }),
    ]);
    assert.deepEqual([firstVoiceReservation.created, repeatedVoiceReservation.created].sort(), [false, true]);
    assert.equal(firstVoiceReservation.session.id, repeatedVoiceReservation.session.id);
    await assert.rejects(
      repository.reserveVoiceTutorSession(username, { id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), limits: voiceLimits, now: voiceNow }),
      /VOICE_TUTOR_SESSION_ACTIVE/u,
    );
    const voiceFinishedAt = new Date(voiceNow.getTime() + 120_000);
    assert.equal((await repository.finishVoiceTutorSession(username, firstVoiceReservation.session.id, { limits: voiceLimits, now: voiceFinishedAt })).finished, true);
    assert.equal((await repository.finishVoiceTutorSession(username, firstVoiceReservation.session.id, { limits: voiceLimits, now: voiceFinishedAt })).finished, false);

    const unactivatedFinishId = crypto.randomUUID();
    await repository.reserveVoiceTutorSession(username, {
      id: unactivatedFinishId, idempotencyKey: crypto.randomUUID(), limits: voiceLimits, now: voiceFinishedAt,
      context: { capsule: { id: 'integration.unactivated.finish' }, nonceHash: '7'.repeat(64) },
    });
    await repository.finishVoiceTutorSession(username, unactivatedFinishId, {
      limits: voiceLimits, now: new Date(voiceFinishedAt.getTime() + 10_000),
    });
    assert.equal((await repository.getVoiceTutorSession(username, unactivatedFinishId)).billable_seconds, 0);
    await client.query('DELETE FROM voice_tutor_sessions WHERE id = $1', [unactivatedFinishId]);

    const unactivatedExpiryId = crypto.randomUUID();
    const unactivatedExpiryStart = new Date(voiceFinishedAt.getTime() + 20_000);
    await repository.reserveVoiceTutorSession(username, {
      id: unactivatedExpiryId, idempotencyKey: crypto.randomUUID(), limits: voiceLimits, now: unactivatedExpiryStart,
      context: { capsule: { id: 'integration.unactivated.expiry' }, nonceHash: '8'.repeat(64) },
    });
    const expired = await repository.finishVoiceTutorSession(username, unactivatedExpiryId, {
      limits: voiceLimits, now: new Date(unactivatedExpiryStart.getTime() + 310_000),
    });
    assert.equal(expired.finished, false);
    const expiredStored = await repository.getVoiceTutorSession(username, unactivatedExpiryId);
    assert.equal(expiredStored.status, 'expired');
    assert.equal(expiredStored.billable_seconds, 0);
    await client.query('DELETE FROM voice_tutor_sessions WHERE id = $1', [unactivatedExpiryId]);

    const progress = { learned: 12, prog: { words: 33 }, marker: suffix };
    await repository.saveProgress(username, progress);
    assert.deepEqual(await repository.getProgress(username), progress);
    await repository.mergeProgress(username, { prog: { words: 44 }, extra: true });
    assert.deepEqual(await repository.getProgress(username), { learned: 12, prog: { words: 44 }, marker: suffix, extra: true });

    const code = crypto.randomBytes(24).toString('base64url');
    await repository.createTelegramAuthCode(code, Date.now() + 60_000);
    assert.equal(await repository.confirmTelegramAuthCode(code, telegramId, 'Integration User'), true);
    assert.equal((await repository.consumeTelegramAuthCode(code)).telegram_id, telegramId);
    assert.equal(await repository.consumeTelegramAuthCode(code), null);

    const attemptId = await repository.createWritingAttempt(username, {
      taskType: 'writing_37', assignment: { prompt: 'Integration' }, answer: 'Test full answer',
      evaluatedAnswer: 'Test evaluated answer',
    }, 'integration-v1');
    await repository.finishWritingAttempt(attemptId, {
      status: 'failed', provider: 'test', model: 'integration-writing-model', errorCode: 'EXPECTED_TEST_ERROR',
    });
    const speakingAttemptId = await repository.createSpeakingAttempt(username, {
      taskType: 2, assignment: { ad: 'Integration', points: ['a', 'b', 'c', 'd'] }, transcript: 'Four questions.',
    }, 'integration-speaking-v1');
    await repository.finishSpeakingAttempt(speakingAttemptId, {
      status: 'failed', provider: 'test', model: 'integration-speaking-model', errorCode: 'EXPECTED_TEST_ERROR',
    });
    const taskHash = crypto.createHash('sha256').update(suffix).digest('hex');
    await repository.saveGeneratedTask(username, { operation: 'grammar_quiz', requestHash: taskHash, request: { operation: 'grammar_quiz' }, result: [{ q: suffix }], provider: 'test', promptVersion: 'content-v1' });
    assert.equal((await repository.getGeneratedTask(username, taskHash)).result[0].q, suffix);
    const concurrentHash = crypto.createHash('sha256').update(`${suffix}:concurrent`).digest('hex');
    const generatedBase = { operation: 'vocabulary_cards', requestHash: concurrentHash, request: { operation: 'vocabulary_cards', count: 1, exclude: [] }, promptVersion: 'content-v1' };
    const [generatedFirstId, generatedSecondId] = await Promise.all([
      repository.saveGeneratedTask(username, { ...generatedBase, result: [{ w: 'first' }], provider: 'first' }),
      repository.saveGeneratedTask(username, { ...generatedBase, result: [{ w: 'second' }], provider: 'second' }),
    ]);
    assert.equal(generatedFirstId, generatedSecondId);
    const concurrentStored = await repository.getGeneratedTask(username, concurrentHash);
    assert.ok(['first', 'second'].includes(concurrentStored.result[0].w));
    assert.equal(concurrentStored.provider, concurrentStored.result[0].w);
    const moduleAttemptId = crypto.randomUUID();
    assert.equal((await repository.recordModuleAttempt(username, { id: moduleAttemptId, module: 'exam', activity: 'grammar_19_24', score: 5, maxScore: 6, durationMs: 50_000, metadata: {} })).created, true);
    assert.equal((await repository.recordModuleAttempt(username, { id: moduleAttemptId, module: 'exam', activity: 'grammar_19_24', score: 5, maxScore: 6, durationMs: 50_000, metadata: {} })).created, false);
    assert.equal((await repository.getModuleAttempt(username, moduleAttemptId)).evidence_quality, 'client_reported');
    const tracerAttemptId = crypto.randomUUID();
    const tracerAttempt = createGrammarLexiconErrorAttempt({
      id: tracerAttemptId, module: 'grammar', itemId: 'grammar.past-simple.last-summer', revision: 1, learnerAnswer: 'goed',
    });
    assert.equal((await repository.recordModuleAttempt(username, tracerAttempt, {
      evidenceQuality: 'server_verified_assisted',
    })).created, true);
    const storedTracerAttempt = await repository.getModuleAttempt(username, tracerAttemptId);
    assert.equal(storedTracerAttempt.metadata.learner_answer, 'goed');
    assert.equal(storedTracerAttempt.evidence_quality, 'server_verified_assisted');
    const tracerCapsule = buildGrammarLexiconCapsule({ attempt: storedTracerAttempt, expectedRevision: 1 });
    const tracerSessionId = crypto.randomUUID();
    const tracerReservation = await repository.reserveVoiceTutorSession(username, {
      id: tracerSessionId,
      idempotencyKey: crypto.randomUUID(),
      limits: voiceLimits,
      now: voiceFinishedAt,
      context: { capsule: persistedVoiceTutorCapsule(tracerCapsule), nonceHash: 'a'.repeat(64) },
    });
    assert.equal(tracerReservation.created, true);
    assert.equal(tracerReservation.session.state, 'diagnose');
    await assert.rejects(
      repository.activateVoiceTutorSession(username, tracerSessionId, {
        nonceHash: '9'.repeat(64), now: voiceFinishedAt,
      }),
      /VOICE_TUTOR_NONCE_REPLAYED/u,
    );
    const firstActivation = await repository.activateVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'a'.repeat(64), now: voiceFinishedAt,
    });
    const replayedActivation = await repository.activateVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'a'.repeat(64), now: new Date(voiceFinishedAt.getTime() + 1_000),
    });
    assert.equal(firstActivation.session.id, tracerSessionId);
    assert.equal(replayedActivation.session.id, tracerSessionId);
    await repository.setVoiceTutorSessionDelivery(username, tracerSessionId, {
      mode: 'voice', provider: 'xai', model: 'grok-voice-integration-v1', promptVersion: 'voice-tutor-error-v2',
    });
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'a'.repeat(64), nextNonceHash: 'b'.repeat(64), event: { type: 'diagnosis_complete' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'explain');
    await assert.rejects(
      repository.advanceVoiceTutorSession(username, tracerSessionId, {
        nonceHash: 'a'.repeat(64), nextNonceHash: 'c'.repeat(64), event: { type: 'explanation_complete' }, capsule: tracerCapsule, now: voiceFinishedAt,
      }),
      /VOICE_TUTOR_NONCE_REPLAYED/u,
    );
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'b'.repeat(64), nextNonceHash: 'c'.repeat(64), event: { type: 'explanation_complete' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'micro_check');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'c'.repeat(64), nextNonceHash: 'd'.repeat(64), event: { type: 'check_answer', answer: 'wrong' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'explain');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'd'.repeat(64), nextNonceHash: 'e'.repeat(64), event: { type: 'explanation_complete' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'micro_check');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'e'.repeat(64), nextNonceHash: 'f'.repeat(64), event: { type: 'check_answer', answer: 'went' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'transfer_task');
    const tracerFallback = await repository.switchVoiceTutorSessionDelivery(username, tracerSessionId, {
      nonceHash: 'f'.repeat(64), nextNonceHash: 'g'.repeat(64), mode: 'text', limits: voiceLimits, now: voiceFinishedAt,
    });
    assert.equal(tracerFallback.session.status, 'completed');
    assert.equal(tracerFallback.voice_tutor.daily_remaining_seconds, 480);
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'g'.repeat(64), nextNonceHash: 'h'.repeat(64), event: { type: 'transfer_answer', answer: 'bought' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'resolved');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'h'.repeat(64), nextNonceHash: 'i'.repeat(64), event: { type: 'check_answer', answer: 'wrong' }, capsule: tracerCapsule, now: voiceFinishedAt,
    })).session.state, 'resolved');
    const storedTracerSession = await repository.getVoiceTutorSession(username, tracerSessionId);
    assert.equal(storedTracerSession.micro_check_attempts, 2);
    assert.equal(storedTracerSession.micro_check_passes, 1);
    let recoveryMap = await repository.getVoiceTutorRecoveryMap(username, { limits: voiceLimits, now: voiceFinishedAt });
    assert.equal(recoveryMap.skills[0].state, 'open');
    const dayOneRepeat = recoveryMap.skills[0].repeats[0];
    assert.equal((await repository.submitVoiceTutorRepeat(username, dayOneRepeat.id, {
      attemptId: crypto.randomUUID(), taskId: dayOneRepeat.task_id, answer: 'came', now: new Date(voiceFinishedAt.getTime() + 86_400_000),
    })).attempt.passed, true);
    recoveryMap = await repository.getVoiceTutorRecoveryMap(username, { limits: voiceLimits, now: new Date(voiceFinishedAt.getTime() + 7 * 86_400_000) });
    const daySevenRepeat = recoveryMap.skills[0].repeats[1];
    assert.equal((await repository.submitVoiceTutorRepeat(username, daySevenRepeat.id, {
      attemptId: crypto.randomUUID(), taskId: daySevenRepeat.task_id, answer: 'met', now: new Date(voiceFinishedAt.getTime() + 7 * 86_400_000),
    })).attempt.passed, true);
    const recoveredAt = new Date(voiceFinishedAt.getTime() + 7 * 86_400_000);
    assert.equal((await repository.getVoiceTutorRecoveryMap(username, { limits: voiceLimits, now: recoveredAt })).skills[0].state, 'recovered');
    await repository.setEntitlement(username, 'voice_tutor', {
      startsAt: voiceNow,
      endsAt: new Date(voiceFinishedAt.getTime() + 86_400_000),
    });
    const inactiveRecoveryMap = await repository.getVoiceTutorRecoveryMap(username, { limits: voiceLimits, now: recoveredAt });
    assert.equal(inactiveRecoveryMap.voice_minutes.used_monthly, 2);
    assert.equal(inactiveRecoveryMap.voice_minutes.remaining_monthly, 0);
    assert.deepEqual(await repository.getVoiceTutorRecoveryMetrics(recoveredAt, { costMicrousdPerMinute: 50_000 }), {
      open: 0, recovered: 1, relapsed: 0, numerator: 1, denominator: 1, error_recovery_rate: 1,
      due_repeats: 0, overdue_repeats: 0, sessions: 2, voice_minutes: 0,
      micro_check: { passed: 1, observed: 2, rate: 0.5 },
      initial_transfer: { passed: 1, observed: 1, rate: 1 },
      repeat_passes: {
        day_1: { passed: 1, observed: 1, rate: 1 },
        day_7: { passed: 1, observed: 1, rate: 1 },
      },
      delivery: { voice: 0, text: 1, local: 0 },
      fallback_rate: 1,
      provider_errors: 0,
      estimated_cost_microusd: 0,
    });
    await repository.upsertWordProgress(username, [{ word: 'Achievement', stage: 2, errorCount: 1, reviewCount: 3, dueAt: Date.now() + 60_000 }]);
    const learningError = { module: 'grammar', itemKey: `grammar_19_24:${suffix}`, errorType: 'incorrect_form', details: { expected: 'went' } };
    await repository.upsertErrorBank(username, [learningError]);
    await repository.upsertErrorBank(username, [learningError]);
    await repository.logAiRequest({
      username, operation: 'integration', provider: 'test', model: 'test',
      promptVersion: 'integration-v1', status: 'completed', durationMs: 1,
    });
    await repository.healthCheck();

    const attempt = await client.query('SELECT answer, evaluated_answer, status, provider, model, prompt_version, error_code FROM writing_attempts WHERE id = $1', [attemptId]);
    assert.deepEqual(attempt.rows[0], {
      answer: 'Test full answer',
      evaluated_answer: 'Test evaluated answer',
      status: 'failed',
      provider: 'test',
      model: 'integration-writing-model',
      prompt_version: 'integration-v1',
      error_code: 'EXPECTED_TEST_ERROR',
    });
    const aiLog = await client.query('SELECT operation, status FROM ai_requests WHERE username = $1', [username]);
    assert.deepEqual(aiLog.rows[0], { operation: 'integration', status: 'completed' });
    const aiUsage = await repository.getAiUsageMetrics(24);
    assert.ok(aiUsage.requests >= 1);
    assert.equal(typeof aiUsage.estimatedCostMicrousd, 'number');

    const reportId = crypto.randomUUID();
    const report = await repository.createVoiceTutorReport(username, {
      id: reportId, sessionId: tracerSessionId, reason: 'technical_issue', createdAt: voiceFinishedAt,
    });
    assert.equal(report.created, true);
    assert.equal((await repository.listVoiceTutorReports({ status: 'pending' })).some((entry) => entry.id === reportId), true);
    assert.equal((await repository.reviewVoiceTutorReport(reportId, {
      decision: 'confirmed', reviewer: username, reviewedAt: voiceFinishedAt,
    })).applied, true);

    const adaptiveGoalKey = crypto.randomUUID();
    const adaptiveGoalHash = crypto.createHash('sha256').update(`${suffix}:adaptive-goal`).digest('hex');
    const adaptiveGoal = {
      id: crypto.randomUUID(), idempotencyKey: adaptiveGoalKey, requestHash: adaptiveGoalHash,
      targetExam: 'ege_english', targetScore: 85, examDate: '2027-06-01', weeklyMinutes: 300,
      now: voiceFinishedAt,
    };
    await assertAdaptiveGoalRepositoryContract(assert, repository, username, adaptiveGoal);
    await assert.rejects(
      repository.saveAdaptiveLearningGoal(username, { ...adaptiveGoal, requestHash: '0'.repeat(64) }),
      /ADAPTIVE_GOAL_IDEMPOTENCY_CONFLICT/u,
    );
    assert.equal((await repository.getAdaptiveLearningGoal(username)).revision, 1);
    const adaptiveSources = await repository.getAdaptiveLearningEvidenceSources(username);
    assert.equal(adaptiveSources.attempts.some((entry) => entry.id === tracerAttemptId), true);
    const adaptiveProfile = buildAdaptiveLearningProfile(adaptiveSources);
    await assertAdaptiveProfileRepositoryContract(
      assert, repository, username, adaptiveProfile, voiceFinishedAt,
    );
    const raceAttempt = (createdAt) => ({
      id: crypto.randomUUID(), module: 'grammar', activity: 'grammar_19_24', score: 8, max_score: 10,
      evidence_quality: 'server_verified_unassisted', created_at: createdAt,
    });
    const raceFirst = raceAttempt('2026-08-04T05:00:00.000Z');
    const raceLatest = raceAttempt('2026-08-04T06:00:00.000Z');
    const raceBackfill = raceAttempt('2026-08-04T04:00:00.000Z');
    const raceUsername = await repository.createTelegramUser(telegramId + 2, `Adaptive race ${suffix}`);
    await assertAdaptiveProfileRejectsStale(assert, repository, raceUsername, {
      older: buildAdaptiveLearningProfile({ attempts: [raceFirst] }),
      newer: buildAdaptiveLearningProfile({ attempts: [raceFirst, raceLatest] }),
      backfilled: buildAdaptiveLearningProfile({ attempts: [raceBackfill, raceFirst, raceLatest] }),
    });
    const orderingUsername = await repository.createTelegramUser(telegramId + 3, `Adaptive ordering ${suffix}`);
    await assertAdaptiveProfileAppendOnlyOrdering(
      assert, repository, orderingUsername, buildAdaptiveLearningProfile,
    );

    const exported = await repository.exportUserData(username);
    assert.equal(exported.account.username, username);
    assert.deepEqual(exported.progress, { learned: 12, prog: { words: 44 }, marker: suffix, extra: true });
    assert.equal(exported.writing_attempts.length, 1);
    assert.equal(exported.speaking_attempts.length, 1);
    assert.equal(exported.writing_attempts[0].model, 'integration-writing-model');
    assert.equal(exported.writing_attempts[0].error_code, 'EXPECTED_TEST_ERROR');
    assert.equal(exported.writing_attempts[0].answer, 'Test full answer');
    assert.equal(exported.writing_attempts[0].evaluated_answer, 'Test evaluated answer');
    assert.equal(exported.speaking_attempts[0].model, 'integration-speaking-model');
    assert.equal(exported.generated_tasks.length, 2);
    assert.equal(exported.module_attempts.length, 2);
    assert.equal(exported.voice_tutor_sessions.find((session) => session.id === tracerSessionId).delivery_mode, 'text');
    assert.equal(JSON.stringify(exported.voice_tutor_sessions).includes('nonce_hash'), false);
    assert.equal(exported.progress_summary[0].attempt_count, 1);
    assert.equal(exported.progress_summary[0].best_score, 5);
    assert.equal(exported.word_progress[0].word, 'achievement');
    assert.equal(exported.error_bank.length, 1);
    assert.equal(exported.error_bank[0].occurrence_count, 2);
    assert.equal(exported.audit_log[0].action, 'payment.resolve');
    assert.equal(exported.ai_requests.length, 1);
    assert.equal(exported.subscription_entitlements[0].entitlement, 'voice_tutor');
    assert.equal(exported.voice_tutor_sessions.length, 2);
    assert.equal(exported.voice_tutor_recoveries.length, 1);
    assert.equal(exported.voice_tutor_repeats.length, 2);
    assert.equal(exported.voice_tutor_repeat_attempts.length, 2);
    assert.equal(exported.voice_tutor_reports[0].reason, 'technical_issue');
    assert.equal(exported.rule_cards.length, 2);
    assert.equal(exported.adaptive_learning_goals[0].target_score, 85);
    assert.equal(exported.adaptive_learning_profile.taxonomy_version, 'ege-en-v1');
    assert.equal(Number(exported.adaptive_learning_profile.independent_evidence_count), adaptiveProfile.independentEvidenceCount);
    assert.equal(exported.adaptive_learning_skill_estimates.length, 12);
    const originalVoiceSession = exported.voice_tutor_sessions.find((session) => session.id === firstVoiceReservation.session.id);
    assert.equal(originalVoiceSession.billable_seconds, 120);
    const exportedTracerSession = exported.voice_tutor_sessions.find((session) => session.id === tracerSessionId);
    assert.equal(exportedTracerSession.delivery_mode, 'text');
    assert.equal(exportedTracerSession.billable_seconds, 0);
    assert.equal(exportedTracerSession.micro_check_attempts, 2);
    assert.equal(exportedTracerSession.micro_check_passes, 1);
    assert.equal(exportedTracerSession.provider, 'xai');
    assert.equal(exportedTracerSession.model, 'grok-voice-integration-v1');
    assert.equal(exportedTracerSession.prompt_version, 'voice-tutor-error-v2');
    assert.equal(new Date(exportedTracerSession.voice_activated_at).getTime(), voiceFinishedAt.getTime());

    for (let index = 0; index < 8; index += 1) {
      const raceUsername = await repository.createTelegramUser(telegramId + index + 1, `Delete race ${suffix} ${index}`);
      const raceCardId = crypto.randomUUID();
      const [deleted, created] = await Promise.allSettled([
        repository.deleteUserData(raceUsername),
        repository.createRuleCard({
          id: raceCardId, createdForUsername: raceUsername, status: 'pending_review',
          skill: { id: `ege.grammar.delete_race.${suffix}.${index}`, title: 'Delete race' }, examYear: 2026,
          rule: { title: 'Delete race', explanation: 'Concurrent owner deletion must not leave this card.', examples: ['Safe.'] },
          agreementHash: '1'.repeat(64),
          sources: [
            { authority: 'one', url: 'https://one.example/delete-race', retrieved_at: new Date().toISOString(), content_hash: '2'.repeat(64) },
            { authority: 'two', url: 'https://two.example/delete-race', retrieved_at: new Date().toISOString(), content_hash: '3'.repeat(64) },
          ],
          discrepancies: [], createdAt: new Date(),
        }),
      ]);
      assert.equal(deleted.status, 'fulfilled');
      assert.equal(deleted.value, true);
      if (created.status === 'rejected') assert.match(String(created.reason?.message), /USER_NOT_FOUND/u);
      assert.equal(await repository.getUser(raceUsername), null);
      assert.equal((await client.query('SELECT 1 FROM trusted_rule_cards WHERE id = $1', [raceCardId])).rowCount, 0);
      assert.equal((await client.query(
        "SELECT 1 FROM trusted_rule_cards WHERE created_for_username = $1 AND status <> 'approved'",
        [raceUsername],
      )).rowCount, 0);
    }

    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.getUser(username), null);
    assert.equal((await client.query('SELECT 1 FROM writing_attempts WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM speaking_attempts WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM ai_requests WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM subscription_entitlements WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM voice_tutor_sessions WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM voice_tutor_recoveries WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM adaptive_learning_goals WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM adaptive_learning_profiles WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM adaptive_learning_skill_estimates WHERE username = $1', [username])).rowCount, 0);
    const retainedRuleCard = await client.query('SELECT created_for_username, review_audit FROM trusted_rule_cards WHERE id = $1', [ruleCardId]);
    assert.equal(retainedRuleCard.rows[0].created_for_username, null);
    assert.equal(retainedRuleCard.rows[0].review_audit[0].reviewer, null);
    assert.equal(retainedRuleCard.rows[0].review_audit[0].account_deleted, true);
    assert.equal((await client.query('SELECT 1 FROM trusted_rule_cards WHERE id = $1', [ruleReportId])).rowCount, 0);
    const retainedAudit = await client.query('SELECT metadata FROM audit_log WHERE target_id = $1', [paymentRequest.id]);
    assert.equal(retainedAudit.rows[0].metadata.username, undefined);
    assert.equal(retainedAudit.rows[0].metadata.account_deleted, true);
  } finally {
    await repository.close();
    await client.end();
  }
});

test('PostgreSQL discovery and paid-operation claims are atomic across finish/delete races', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const client = new pg.Client({ connectionString });
  const suffix = crypto.randomBytes(6).toString('hex');
  const baseTelegramId = Number(`7${Date.now().toString().slice(-9)}`);
  const limits = { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 };
  const now = new Date();

  function pointer(id, skillId) {
    return {
      schema: 'voice-tutor-reference-v1', id, version: 'grammar-lexicon-v1',
      source: { attempt_id: crypto.randomUUID(), item_revision: 1 }, module: 'grammar', skill_id: skillId,
    };
  }

  function card(id, skillId) {
    return {
      id, skill: { id: skillId, title: 'Race-safe rule' }, examYear: 2026,
      rule: { title: 'Rule', explanation: 'A bounded race-safe explanation.', examples: ['It works.'] },
      agreementHash: 'a'.repeat(64), sources: [], discrepancies: [], createdAt: now,
    };
  }

  await client.connect();
  try {
    const finishUser = await repository.createTelegramUser(baseTelegramId, `Discovery finish ${suffix}`);
    await repository.grantDays(baseTelegramId, 30, `Discovery finish ${suffix}`);
    await repository.setEntitlement(finishUser, 'voice_tutor', { startsAt: now, endsAt: new Date(now.getTime() + 86_400_000) });
    const finishSessionId = crypto.randomUUID();
    const finishCapsule = pointer(`voice-capsule:finish:${suffix}`, `ege.grammar.finish.${suffix}`);
    await repository.reserveVoiceTutorSession(finishUser, {
      id: finishSessionId, idempotencyKey: crypto.randomUUID(), limits, now,
      context: { capsule: finishCapsule, nonceHash: '1'.repeat(64) },
    });
    const finishClaimId = crypto.randomUUID();
    await repository.claimVoiceTutorRuleDiscovery(finishUser, finishSessionId, {
      claimId: finishClaimId, nonceHash: '1'.repeat(64), now,
    });
    await repository.finishVoiceTutorSession(finishUser, finishSessionId, { limits, now });
    const finishCardId = crypto.randomUUID();
    await assert.rejects(
      repository.createRuleCardForVoiceTutorSession(
        finishUser, finishSessionId, finishCapsule.id, card(finishCardId, finishCapsule.skill_id),
        { claimId: finishClaimId, expectedNonceHash: '1'.repeat(64), nextNonceHash: '2'.repeat(64) },
      ),
      /TRUSTED_RULE_DISCOVERY_NOT_REQUIRED/u,
    );
    assert.equal((await client.query('SELECT 1 FROM trusted_rule_cards WHERE id = $1', [finishCardId])).rowCount, 0);
    await repository.deleteUserData(finishUser);

    const deleteUser = await repository.createTelegramUser(baseTelegramId + 1, `Discovery delete ${suffix}`);
    await repository.grantDays(baseTelegramId + 1, 30, `Discovery delete ${suffix}`);
    await repository.setEntitlement(deleteUser, 'voice_tutor', { startsAt: now, endsAt: new Date(now.getTime() + 86_400_000) });
    const deleteSessionId = crypto.randomUUID();
    const deleteCapsule = pointer(`voice-capsule:delete:${suffix}`, `ege.grammar.delete.${suffix}`);
    await repository.reserveVoiceTutorSession(deleteUser, {
      id: deleteSessionId, idempotencyKey: crypto.randomUUID(), limits, now,
      context: { capsule: deleteCapsule, nonceHash: '3'.repeat(64) },
    });
    const deleteClaimId = crypto.randomUUID();
    await repository.claimVoiceTutorRuleDiscovery(deleteUser, deleteSessionId, {
      claimId: deleteClaimId, nonceHash: '3'.repeat(64), now,
    });
    const deleteCardId = crypto.randomUUID();
    const raced = await Promise.allSettled([
      repository.deleteUserData(deleteUser),
      repository.createRuleCardForVoiceTutorSession(
        deleteUser, deleteSessionId, deleteCapsule.id, card(deleteCardId, deleteCapsule.skill_id),
        { claimId: deleteClaimId, expectedNonceHash: '3'.repeat(64), nextNonceHash: '4'.repeat(64) },
      ),
    ]);
    assert.equal(raced[0].status, 'fulfilled');
    assert.equal(await repository.getUser(deleteUser), null);
    assert.equal((await client.query('SELECT 1 FROM trusted_rule_cards WHERE id = $1', [deleteCardId])).rowCount, 0);

    const slotUser = await repository.createTelegramUser(baseTelegramId + 2, `AI slot ${suffix}`);
    const slotClaims = await Promise.allSettled([
      repository.claimAiOperationSlot(slotUser, {
        claimId: crypto.randomUUID(), operation: 'voice_tutor_rule_search', promptVersion: 'voice-tutor-rule-search-v1',
        requestsPerHour: 1, dailyLimit: 1_000_000, now,
      }),
      repository.claimAiOperationSlot(slotUser, {
        claimId: crypto.randomUUID(), operation: 'voice_tutor_rule_search', promptVersion: 'voice-tutor-rule-search-v1',
        requestsPerHour: 1, dailyLimit: 1_000_000, now,
      }),
    ]);
    assert.equal(slotClaims.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(slotClaims.filter((result) => result.status === 'rejected').length, 1);
    const slot = slotClaims.find((result) => result.status === 'fulfilled').value;
    assert.equal((await repository.settleAiOperationSlot(slotUser, slot.claim_id, {
      status: 'failed', provider: 'xai', model: 'fixture-v1', errorCode: 'TRUSTED_RULE_SEARCH_FAILED', now,
    })).applied, true);
    assert.equal((await repository.settleAiOperationSlot(slotUser, slot.claim_id, {
      status: 'failed', errorCode: 'TRUSTED_RULE_SEARCH_FAILED', now,
    })).applied, false);
    const storedSlot = await client.query('SELECT status, error_code, settled_at FROM ai_requests WHERE claim_key = $1', [slot.claim_id]);
    assert.equal(storedSlot.rows[0].status, 'failed');
    assert.equal(storedSlot.rows[0].error_code, 'TRUSTED_RULE_SEARCH_FAILED');
    assert.ok(storedSlot.rows[0].settled_at);
    await repository.deleteUserData(slotUser);

    const fallbackTelegramId = baseTelegramId + 3;
    const fallbackUser = await repository.createTelegramUser(fallbackTelegramId, `Quota fallback ${suffix}`);
    await repository.grantDays(fallbackTelegramId, 30, `Quota fallback ${suffix}`);
    await repository.setEntitlement(fallbackUser, 'voice_tutor', {
      startsAt: now, endsAt: new Date(now.getTime() + 86_400_000),
    });
    for (let index = 0; index < 2; index += 1) {
      const spentSessionId = crypto.randomUUID();
      await repository.reserveVoiceTutorSession(fallbackUser, {
        id: spentSessionId, idempotencyKey: crypto.randomUUID(), limits, now,
      });
      await repository.finishVoiceTutorSession(fallbackUser, spentSessionId, {
        limits, now: new Date(now.getTime() + 300_000), confirmedBillableSeconds: 300,
      });
    }
    const fallbackSessionId = crypto.randomUUID();
    const fallbackReservation = await repository.reserveVoiceTutorSession(fallbackUser, {
      id: fallbackSessionId, idempotencyKey: crypto.randomUUID(), limits, now,
      context: { capsule: pointer(`voice-capsule:fallback:${suffix}`, `ege.grammar.fallback.${suffix}`), nonceHash: '5'.repeat(64) },
      allowFallbackOnly: true,
    });
    assert.equal(fallbackReservation.fallback_only, true);
    const fallbackStored = await repository.getVoiceTutorSession(fallbackUser, fallbackSessionId);
    assert.equal(fallbackStored.reserved_seconds, 0);
    assert.equal(fallbackStored.delivery_mode, 'local');
    assert.equal((await repository.getVoiceTutorAccess(fallbackUser, limits, now)).voice_tutor.daily_remaining_seconds, 0);
    await repository.finishVoiceTutorSession(fallbackUser, fallbackSessionId, {
      limits, now, confirmedBillableSeconds: 0,
    });
    await repository.deleteUserData(fallbackUser);
  } finally {
    await repository.close();
    await client.end();
  }
});

test('PostgreSQL proxy tickets, usage settlement and canonical review are atomic', { skip: !connectionString }, async () => {
  const operationalErrors = [];
  const repository = createPostgresRepository(connectionString, {
    onOperationalError: (event) => operationalErrors.push(event),
  });
  const client = new pg.Client({ connectionString });
  const suffix = crypto.randomBytes(6).toString('hex');
  const telegramId = Number(`6${Date.now().toString().slice(-9)}`);
  const now = new Date('2026-08-03T10:00:00.000Z');
  const limits = { dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 };
  await client.connect();

  async function prepareSession(idOffset) {
    const id = telegramId + idOffset;
    const username = await repository.createTelegramUser(id, `Proxy ${suffix} ${idOffset}`);
    await repository.grantDays(id, 30, `Proxy ${suffix} ${idOffset}`);
    await repository.setEntitlement(username, 'voice_tutor', {
      startsAt: now, endsAt: new Date(now.getTime() + 86_400_000),
    });
    const sessionId = crypto.randomUUID();
    const idempotencyKey = crypto.randomUUID();
    await repository.reserveVoiceTutorSession(username, {
      id: sessionId, idempotencyKey, limits, now,
      context: {
        capsule: {
          schema: 'voice-tutor-reference-v1', id: `voice-capsule:${sessionId}`, version: 'grammar-lexicon-v1',
          source: { attempt_id: crypto.randomUUID(), item_revision: 1 }, module: 'grammar', skill_id: `ege.grammar.proxy.${suffix}`,
        },
        nonceHash: '1'.repeat(64),
      },
    });
    return { username, sessionId, idempotencyKey };
  }

  function card(username, skillId) {
    return {
      id: crypto.randomUUID(), createdForUsername: username,
      skill: { id: skillId, title: 'Atomic canonical' }, examYear: 2026,
      rule: { title: 'Atomic canonical', explanation: 'Only one approved rule may exist.', examples: ['It works.'] },
      agreementHash: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
      sources: [], discrepancies: [], createdAt: now,
    };
  }

  try {
    const exact = await prepareSession(0);
    const ticketExpiresAt = new Date(now.getTime() + 60_000);
    const firstHash = 'a'.repeat(64);
    const replacementHash = 'b'.repeat(64);
    assert.equal((await repository.issueVoiceTutorProxyTicket(exact.username, exact.sessionId, {
      ticketHash: firstHash, idempotencyKey: exact.idempotencyKey, expiresAt: ticketExpiresAt, now,
    })).issued, true);
    assert.equal((await repository.issueVoiceTutorProxyTicket(exact.username, exact.sessionId, {
      ticketHash: firstHash, idempotencyKey: exact.idempotencyKey, expiresAt: ticketExpiresAt, now,
    })).issued, false);
    assert.equal((await repository.issueVoiceTutorProxyTicket(exact.username, exact.sessionId, {
      ticketHash: replacementHash, idempotencyKey: exact.idempotencyKey, expiresAt: ticketExpiresAt, now,
      reissue: true, nextNonceHash: '2'.repeat(64),
    })).reissued, true);
    await assert.rejects(
      repository.issueVoiceTutorProxyTicket(exact.username, exact.sessionId, {
        ticketHash: '9'.repeat(64), idempotencyKey: exact.idempotencyKey, expiresAt: ticketExpiresAt, now,
        reissue: true, nextNonceHash: '3'.repeat(64),
      }),
      (error) => error.code === 'VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT',
    );
    assert.equal((await repository.getVoiceTutorSession(exact.username, exact.sessionId)).proxy_ticket_reissue_count, 1);
    const consumed = await Promise.allSettled([
      repository.consumeVoiceTutorProxyTicket(exact.username, { ticketHash: replacementHash }, {
        now, provider: 'xai', model: 'grok-voice-v1', promptVersion: 'voice-tutor-error-v4',
      }),
      repository.consumeVoiceTutorProxyTicket(exact.username, { ticketHash: replacementHash }, {
        now, provider: 'xai', model: 'grok-voice-v1', promptVersion: 'voice-tutor-error-v4',
      }),
    ]);
    assert.equal(consumed.filter((result) => result.status === 'fulfilled').length, 1);
    assert.match(consumed.find((result) => result.status === 'rejected').reason.message, /VOICE_TUTOR_PROXY_TICKET_REPLAYED/u);
    assert.equal((await repository.activateVoiceTutorProxySession(exact.username, exact.sessionId, { now })).activated, true);
    assert.equal((await repository.activateVoiceTutorProxySession(exact.username, exact.sessionId, { now })).activated, false);
    const exactFinalization = await repository.finalizeVoiceTutorProxySession(exact.username, exact.sessionId, {
      inputAudioBytes: 48_000, outputAudioBytes: 1, confirmed: true, reason: 'completed',
      now: new Date(now.getTime() + 20_000), limits,
    });
    assert.equal(exactFinalization.usage.billable_seconds, 2);
    assert.equal(exactFinalization.usage.exact, true);
    const idempotentFinalization = await repository.finalizeVoiceTutorProxySession(exact.username, exact.sessionId, {
      inputAudioBytes: 999_999, outputAudioBytes: 999_999, confirmed: false, reason: 'provider_error',
      now: new Date(now.getTime() + 30_000), limits,
    });
    assert.equal(idempotentFinalization.finalized, false);
    assert.deepEqual(idempotentFinalization.usage, exactFinalization.usage);
    const storedExact = await client.query(
      `SELECT billable_seconds, proxy_input_audio_bytes, proxy_output_audio_bytes,
              proxy_usage_confirmed, proxy_finalization_reason
       FROM voice_tutor_sessions WHERE id = $1`,
      [exact.sessionId],
    );
    assert.deepEqual(storedExact.rows[0], {
      billable_seconds: 2,
      proxy_input_audio_bytes: '48000',
      proxy_output_audio_bytes: '1',
      proxy_usage_confirmed: true,
      proxy_finalization_reason: 'completed',
    });

    const bounded = await prepareSession(10);
    await repository.issueVoiceTutorProxyTicket(bounded.username, bounded.sessionId, {
      ticketHash: '6'.repeat(64), idempotencyKey: bounded.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.consumeVoiceTutorProxyTicket(bounded.username, { ticketHash: '6'.repeat(64) }, { now });
    await client.query('BEGIN');
    await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [bounded.username]);
    const timeoutStartedAt = Date.now();
    await assert.rejects(
      repository.finalizeVoiceTutorProxySession(bounded.username, bounded.sessionId, {
        inputAudioBytes: 1, outputAudioBytes: 1, confirmed: true, reason: 'completed',
        now: new Date(now.getTime() + 10_000), limits, attemptTimeoutMs: 50,
      }),
      /finalization attempt timeout/iu,
    );
    assert.ok(Date.now() - timeoutStartedAt < 500);
    await client.query('ROLLBACK');
    assert.equal((await repository.finalizeVoiceTutorProxySession(bounded.username, bounded.sessionId, {
      inputAudioBytes: 1, outputAudioBytes: 1, confirmed: true, reason: 'completed',
      now: new Date(now.getTime() + 10_000), limits, attemptTimeoutMs: 500,
    })).finalized, true);

    const partialTicket = await prepareSession(11);
    assert.equal((await repository.issueVoiceTutorProxyTicket(partialTicket.username, partialTicket.sessionId, {
      ticketHash: '5'.repeat(64), idempotencyKey: partialTicket.idempotencyKey,
      expiresAt: ticketExpiresAt, now, nextNonceHash: '4'.repeat(64),
    })).issued, true);
    const partialTicketStored = await repository.getVoiceTutorSession(partialTicket.username, partialTicket.sessionId);
    assert.equal(partialTicketStored.nonce_hash, '4'.repeat(64));
    assert.equal(partialTicketStored.proxy_ticket_reissue_count, 1);

    const partialLocal = await prepareSession(12);
    const partialLocalRecovered = await repository.reissueVoiceTutorFallbackNonce(
      partialLocal.username,
      partialLocal.sessionId,
      { idempotencyKey: partialLocal.idempotencyKey, nextNonceHash: '3'.repeat(64), now },
    );
    assert.equal(partialLocalRecovered.session.status, 'completed');
    const partialLocalStored = await repository.getVoiceTutorSession(partialLocal.username, partialLocal.sessionId);
    assert.equal(partialLocalStored.delivery_mode, 'local');
    assert.equal(partialLocalStored.billable_seconds, 0);

    const lostRealtime = await prepareSession(13);
    await repository.setVoiceTutorSessionDelivery(lostRealtime.username, lostRealtime.sessionId, { mode: 'voice' });
    await repository.issueVoiceTutorProxyTicket(lostRealtime.username, lostRealtime.sessionId, {
      ticketHash: '0'.repeat(64), idempotencyKey: lostRealtime.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.issueVoiceTutorProxyTicket(lostRealtime.username, lostRealtime.sessionId, {
      ticketHash: '1'.repeat(64), idempotencyKey: lostRealtime.idempotencyKey, expiresAt: ticketExpiresAt, now,
      reissue: true, nextNonceHash: '5'.repeat(64),
    });
    await repository.reissueVoiceTutorFallbackNonce(lostRealtime.username, lostRealtime.sessionId, {
      idempotencyKey: lostRealtime.idempotencyKey, nextNonceHash: '6'.repeat(64), now,
      recoverLostRealtime: true,
    });
    const lostRealtimeStored = await repository.getVoiceTutorSession(lostRealtime.username, lostRealtime.sessionId);
    assert.equal(lostRealtimeStored.delivery_mode, 'local');
    assert.equal(lostRealtimeStored.status, 'completed');
    assert.equal(lostRealtimeStored.billable_seconds, 0);
    assert.equal(lostRealtimeStored.proxy_ticket_hash, null);
    assert.equal(lostRealtimeStored.proxy_ticket_issued_at, null);
    assert.equal(lostRealtimeStored.proxy_ticket_expires_at, null);
    assert.equal(lostRealtimeStored.proxy_ticket_consumed_at, null);
    const exported = await repository.exportUserData(exact.username);
    assert.equal(JSON.stringify(exported).includes(replacementHash), false);
    assert.equal(Number(exported.voice_tutor_sessions[0].proxy_input_audio_bytes), 48_000);

    const conservative = await prepareSession(1);
    await repository.issueVoiceTutorProxyTicket(conservative.username, conservative.sessionId, {
      ticketHash: 'c'.repeat(64), idempotencyKey: conservative.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.consumeVoiceTutorProxyTicket(conservative.username, { ticketHash: 'c'.repeat(64) }, { now });
    const conservativeFinalization = await repository.finalizeVoiceTutorProxySession(conservative.username, conservative.sessionId, {
      inputAudioBytes: 0, outputAudioBytes: 0, confirmed: false, reason: 'provider_error',
      now: new Date(now.getTime() + 1_000), limits,
    });
    assert.equal(conservativeFinalization.usage.exact, false);
    assert.equal(conservativeFinalization.usage.billable_seconds, 300);

    const lostFallback = await prepareSession(8);
    await client.query('UPDATE voice_tutor_sessions SET delivery_mode = NULL WHERE id = $1', [lostFallback.sessionId]);
    const recoveredNonces = await Promise.allSettled([
      repository.reissueVoiceTutorFallbackNonce(lostFallback.username, lostFallback.sessionId, {
        idempotencyKey: lostFallback.idempotencyKey, nextNonceHash: '8'.repeat(64), now,
      }),
      repository.reissueVoiceTutorFallbackNonce(lostFallback.username, lostFallback.sessionId, {
        idempotencyKey: lostFallback.idempotencyKey, nextNonceHash: '9'.repeat(64), now,
      }),
    ]);
    assert.equal(recoveredNonces.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(recoveredNonces.find((result) => result.status === 'rejected').reason.code,
      'VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT');
    const recoveredFallback = await repository.getVoiceTutorSession(lostFallback.username, lostFallback.sessionId);
    assert.equal(recoveredFallback.proxy_ticket_reissue_count, 1);
    assert.equal(recoveredFallback.delivery_mode, 'local');
    assert.equal(recoveredFallback.status, 'completed');
    assert.equal(recoveredFallback.billable_seconds, 0);

    const legacyFinish = await prepareSession(4);
    await repository.issueVoiceTutorProxyTicket(legacyFinish.username, legacyFinish.sessionId, {
      ticketHash: 'd'.repeat(64), idempotencyKey: legacyFinish.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.consumeVoiceTutorProxyTicket(legacyFinish.username, { ticketHash: 'd'.repeat(64), now });
    await repository.activateVoiceTutorProxySession(legacyFinish.username, legacyFinish.sessionId, { now });
    await repository.finishVoiceTutorSession(legacyFinish.username, legacyFinish.sessionId, {
      confirmedBillableSeconds: 0, now: new Date(now.getTime() + 1_000), limits,
    });
    const legacyStored = await repository.getVoiceTutorSession(legacyFinish.username, legacyFinish.sessionId);
    assert.equal(legacyStored.billable_seconds, 300);
    assert.equal(legacyStored.proxy_usage_confirmed, false);
    assert.equal(legacyStored.proxy_finalization_reason, 'server_finish');

    const fallback = await prepareSession(7);
    await repository.issueVoiceTutorProxyTicket(fallback.username, fallback.sessionId, {
      ticketHash: '7'.repeat(64), idempotencyKey: fallback.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.consumeVoiceTutorProxyTicket(fallback.username, { ticketHash: '7'.repeat(64), now });
    await repository.switchVoiceTutorSessionDelivery(fallback.username, fallback.sessionId, {
      nonceHash: '1'.repeat(64), nextNonceHash: '2'.repeat(64), mode: 'local',
      errorCode: 'VOICE_TUTOR_PROVIDER_UNAVAILABLE', limits, now: new Date(now.getTime() + 1_000),
    });
    const fallbackStored = await repository.getVoiceTutorSession(fallback.username, fallback.sessionId);
    assert.equal(fallbackStored.billable_seconds, 300);
    assert.equal(fallbackStored.proxy_usage_confirmed, false);
    assert.equal(fallbackStored.proxy_finalization_reason, 'runtime_fallback');
    assert.equal((await repository.finalizeVoiceTutorProxySession(fallback.username, fallback.sessionId, {
      inputAudioBytes: 48_000, outputAudioBytes: 48_000, confirmed: true, reason: 'completed',
      now: new Date(now.getTime() + 2_000), limits,
    })).finalized, false);

    const timeout = await prepareSession(5);
    await repository.issueVoiceTutorProxyTicket(timeout.username, timeout.sessionId, {
      ticketHash: 'e'.repeat(64), idempotencyKey: timeout.idempotencyKey, expiresAt: ticketExpiresAt, now,
    });
    await repository.consumeVoiceTutorProxyTicket(timeout.username, { ticketHash: 'e'.repeat(64), now });
    await repository.activateVoiceTutorProxySession(timeout.username, timeout.sessionId, { now });
    await repository.finishVoiceTutorSession(timeout.username, timeout.sessionId, {
      now: new Date(now.getTime() + 301_000), limits,
    });
    const timeoutStored = await repository.getVoiceTutorSession(timeout.username, timeout.sessionId);
    assert.equal(timeoutStored.status, 'expired');
    assert.equal(timeoutStored.billable_seconds, 300);
    assert.equal(timeoutStored.proxy_finalization_reason, 'timeout');

    const finalizationBackends = await client.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name = 'easyboost_voice_finalization' AND state = 'idle'",
    );
    assert.ok(finalizationBackends.rowCount >= 1);
    await client.query('SELECT pg_terminate_backend($1)', [finalizationBackends.rows[0].pid]);
    for (let attempt = 0; attempt < 50 && operationalErrors.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(operationalErrors, [{ code: 'POSTGRES_IDLE_CLIENT_ERROR', pool: 'voice_finalization' }]);

    const canonicalSkill = `ege.grammar.canonical.${suffix}`;
    const firstCard = card(exact.username, canonicalSkill);
    const secondCard = card(exact.username, canonicalSkill);
    await repository.createRuleCard(firstCard);
    await repository.createRuleCard(secondCard);
    const canonicalRace = await Promise.allSettled([
      repository.reviewRuleCard(firstCard.id, { decision: 'approved', reviewer: exact.username, reviewedAt: now }),
      repository.reviewRuleCard(secondCard.id, { decision: 'approved', reviewer: exact.username, reviewedAt: now }),
    ]);
    assert.equal(canonicalRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(canonicalRace.find((result) => result.status === 'rejected').reason.code, 'RULE_CARD_CANONICAL_EXISTS');
    assert.equal((await client.query(
      "SELECT id FROM trusted_rule_cards WHERE skill_id = $1 AND exam_year = 2026 AND status = 'approved'",
      [canonicalSkill],
    )).rowCount, 1);

    const owner = await repository.createTelegramUser(telegramId + 2, `Review owner ${suffix}`);
    const reviewer = await repository.createTelegramUser(telegramId + 3, `Review actor ${suffix}`);
    const racedCard = card(owner, `ege.grammar.review_delete.${suffix}`);
    await repository.createRuleCard(racedCard);
    const reviewDeleteRace = await Promise.allSettled([
      repository.deleteUserData(reviewer),
      repository.reviewRuleCard(racedCard.id, { decision: 'approved', reviewer, reviewedAt: now }),
    ]);
    assert.equal(reviewDeleteRace[0].status, 'fulfilled');
    assert.equal(await repository.getUser(reviewer), null);
    if (reviewDeleteRace[1].status === 'fulfilled') {
      assert.equal((await repository.getRuleCard(racedCard.id)).review_audit[0].reviewer, null);
    } else {
      assert.match(reviewDeleteRace[1].reason.message, /USER_NOT_FOUND/u);
    }

    const privacyUser = await repository.createTelegramUser(telegramId + 6, `Privacy race ${suffix}`);
    const privacyDeleteRace = await Promise.allSettled([
      repository.deleteUserData(privacyUser),
      repository.setPrivacyConsent(privacyUser, {
        text_processing: true, voice_processing: true, policy_version: 'ticket-10-v1',
      }),
    ]);
    assert.equal(privacyDeleteRace[0].status, 'fulfilled');
    assert.equal(await repository.getUser(privacyUser), null);
    if (privacyDeleteRace[1].status === 'rejected') assert.match(privacyDeleteRace[1].reason.message, /USER_NOT_FOUND/u);
  } finally {
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId))?.username).catch(() => {});
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId + 1))?.username).catch(() => {});
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId + 2))?.username).catch(() => {});
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId + 4))?.username).catch(() => {});
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId + 5))?.username).catch(() => {});
    await repository.deleteUserData((await repository.getUserByTelegram(telegramId + 7))?.username).catch(() => {});
    await repository.close();
    await client.end();
  }
});
