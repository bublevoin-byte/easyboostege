import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createPostgresRepository } from '../storage/postgres-repository.js';

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
    ]);

    const username = await repository.createTelegramUser(telegramId, `Integration ${suffix}`);
    assert.equal((await repository.getUser(username)).telegram_id, telegramId);
    assert.equal(await repository.setUserRole(username, 'admin'), 'admin');
    assert.equal((await repository.getUser(username)).role, 'admin');

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
    assert.equal(exported.module_attempts.length, 1);
    assert.equal(exported.progress_summary[0].attempt_count, 1);
    assert.equal(exported.progress_summary[0].best_score, 5);
    assert.equal(exported.word_progress[0].word, 'achievement');
    assert.equal(exported.error_bank.length, 1);
    assert.equal(exported.error_bank[0].occurrence_count, 2);
    assert.equal(exported.audit_log[0].action, 'payment.resolve');
    assert.equal(exported.ai_requests.length, 1);

    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.getUser(username), null);
    assert.equal((await client.query('SELECT 1 FROM writing_attempts WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM speaking_attempts WHERE username = $1', [username])).rowCount, 0);
    assert.equal((await client.query('SELECT 1 FROM ai_requests WHERE username = $1', [username])).rowCount, 0);
    const retainedAudit = await client.query('SELECT metadata FROM audit_log WHERE target_id = $1', [paymentRequest.id]);
    assert.equal(retainedAudit.rows[0].metadata.username, undefined);
    assert.equal(retainedAudit.rows[0].metadata.account_deleted, true);
  } finally {
    await repository.close();
    await client.end();
  }
});
