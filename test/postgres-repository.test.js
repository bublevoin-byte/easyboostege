import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createPostgresRepository } from '../storage/postgres-repository.js';
import { buildGrammarLexiconCapsule, createGrammarLexiconErrorAttempt, persistedVoiceTutorCapsule } from '../voice-tutor/capsule.js';

const connectionString = process.env.TEST_DATABASE_URL;

test('PostgreSQL repository persists the production data flow', { skip: !connectionString }, async () => {
  const repository = createPostgresRepository(connectionString);
  const client = new pg.Client({ connectionString });
  const suffix = crypto.randomBytes(6).toString('hex');
  const telegramId = Number(`8${Date.now().toString().slice(-9)}`);
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
    const approvedPayment = await repository.resolvePaymentRequest(paymentRequest.id, 'approved', telegramId, 30);
    assert.equal(approvedPayment.applied, true);
    assert.equal((await repository.resolvePaymentRequest(paymentRequest.id, 'approved', telegramId, 30)).applied, false);

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
    const moduleAttemptId = crypto.randomUUID();
    assert.equal((await repository.recordModuleAttempt(username, { id: moduleAttemptId, module: 'exam', activity: 'grammar_19_24', score: 5, maxScore: 6, durationMs: 50_000, metadata: {} })).created, true);
    assert.equal((await repository.recordModuleAttempt(username, { id: moduleAttemptId, module: 'exam', activity: 'grammar_19_24', score: 5, maxScore: 6, durationMs: 50_000, metadata: {} })).created, false);
    const tracerAttemptId = crypto.randomUUID();
    const tracerAttempt = createGrammarLexiconErrorAttempt({
      id: tracerAttemptId, module: 'grammar', itemId: 'grammar.past-simple.last-summer', revision: 1, learnerAnswer: 'goed',
    });
    assert.equal((await repository.recordModuleAttempt(username, tracerAttempt)).created, true);
    const storedTracerAttempt = await repository.getModuleAttempt(username, tracerAttemptId);
    assert.equal(storedTracerAttempt.metadata.learner_answer, 'goed');
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
      nonceHash: 'a'.repeat(64), nextNonceHash: 'b'.repeat(64), event: { type: 'diagnosis_complete' }, now: voiceFinishedAt,
    })).session.state, 'explain');
    await assert.rejects(
      repository.advanceVoiceTutorSession(username, tracerSessionId, {
        nonceHash: 'a'.repeat(64), nextNonceHash: 'c'.repeat(64), event: { type: 'explanation_complete' }, now: voiceFinishedAt,
      }),
      /VOICE_TUTOR_NONCE_REPLAYED/u,
    );
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'b'.repeat(64), nextNonceHash: 'c'.repeat(64), event: { type: 'explanation_complete' }, now: voiceFinishedAt,
    })).session.state, 'micro_check');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'c'.repeat(64), nextNonceHash: 'd'.repeat(64), event: { type: 'check_answer', answer: 'wrong' }, now: voiceFinishedAt,
    })).session.state, 'explain');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'd'.repeat(64), nextNonceHash: 'e'.repeat(64), event: { type: 'explanation_complete' }, now: voiceFinishedAt,
    })).session.state, 'micro_check');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'e'.repeat(64), nextNonceHash: 'f'.repeat(64), event: { type: 'check_answer', answer: 'went' }, now: voiceFinishedAt,
    })).session.state, 'transfer_task');
    const tracerFallback = await repository.switchVoiceTutorSessionDelivery(username, tracerSessionId, {
      nonceHash: 'f'.repeat(64), nextNonceHash: 'g'.repeat(64), mode: 'text', limits: voiceLimits, now: voiceFinishedAt,
    });
    assert.equal(tracerFallback.session.status, 'completed');
    assert.equal(tracerFallback.voice_tutor.daily_remaining_seconds, 480);
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'g'.repeat(64), nextNonceHash: 'h'.repeat(64), event: { type: 'transfer_answer', answer: 'bought' }, now: voiceFinishedAt,
    })).session.state, 'resolved');
    assert.equal((await repository.advanceVoiceTutorSession(username, tracerSessionId, {
      nonceHash: 'h'.repeat(64), nextNonceHash: 'i'.repeat(64), event: { type: 'check_answer', answer: 'wrong' }, now: voiceFinishedAt,
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
    assert.equal(exported.generated_tasks.length, 1);
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
    assert.equal(exported.rule_cards.length, 2);
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
