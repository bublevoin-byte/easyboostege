import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAdaptiveLearningProfile } from '../adaptive-learning/profile.js';
import { createFileRepository } from '../storage/file-repository.js';
import {
  assertAdaptiveProfileAppendOnlyOrdering,
  assertAdaptiveProfileRejectsStale,
  assertAdaptiveProfileRepositoryContract,
} from './support/adaptive-profile-contract.js';
import { assertAdaptiveGoalRepositoryContract } from './support/adaptive-goal-contract.js';
import { assertAdaptiveDiagnosticRepositoryContract } from './support/adaptive-diagnostic-contract.js';
import { assertAdaptivePlanRepositoryContract } from './support/adaptive-plan-contract.js';
import { assertWordProgressRepositoryContract } from './support/word-progress-contract.js';
import { assertPersonalWordsProgressRepositoryContract } from './support/personal-words-progress-contract.js';

async function withRepository(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-db-'));
  const file = path.join(directory, 'data.json');
  const repository = createFileRepository(file);
  try {
    await run(repository, file);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('file repository persists progress atomically', async () => {
  await withRepository(async (repository, file) => {
    const username = await repository.createTelegramUser(1001, 'Test User');
    await Promise.all([
      repository.saveProgress(username, { value: 1 }),
      repository.saveProgress(username, { value: 2 }),
    ]);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(parsed.progress[username].value, 2);
  });
});

test('file repository upgrade revokes legacy adaptive bearers and removes plaintext start replay', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-legacy-adaptive-'));
  const file = path.join(directory, 'data.json');
  const claimId = '10000000-0000-4000-8000-000000000001';
  const hmacClaimId = '10000000-0000-4000-8000-000000000002';
  const legacyBearer = 'legacy-plaintext-adaptive-execution-bearer';
  await fs.writeFile(file, JSON.stringify({
    users: { legacy: { created: Date.now() } },
    adaptive_learning_execution_claims: [{
      id: claimId, username: 'legacy', session_id: '20000000-0000-4000-8000-000000000001',
      block_id: 'asb_aaaaaaaaaaaaaaaa_01', consumed_at: Date.now(), revoked_at: null,
      attempt_type: 'speaking', attempt_ref: '41',
    }, {
      id: hmacClaimId, username: 'legacy', session_id: '20000000-0000-4000-8000-000000000002',
      block_id: 'asb_bbbbbbbbbbbbbbbb_01', consumed_at: null, revoked_at: null,
    }],
    adaptive_learning_session_mutations: [{
      username: 'legacy', operation: 'start', idempotency_key: 'legacy-start-key',
      response_snapshot: { executionClaim: legacyBearer },
    }, {
      username: 'legacy', operation: 'start', idempotency_key: 'hmac-start-key',
      response_snapshot: { executionClaimId: hmacClaimId },
    }, {
      username: 'legacy', operation: 'start', idempotency_key: 'recovery-start-key',
      session_id: '20000000-0000-4000-8000-000000000002', request_hash: 'b'.repeat(64),
      response_snapshot: {
        session: { id: '20000000-0000-4000-8000-000000000002' },
        execution: { revision: 1 }, block: { id: 'asb_bbbbbbbbbbbbbbbb_01' },
        launch: { kind: 'grammar_practice' }, evidenceContext: 'planned_practice',
        recoveryAttempt: { type: 'module', id: '30000000-0000-4000-8000-000000000003' },
      },
    }],
  }), 'utf8');
  const repository = createFileRepository(file);
  try {
    assert.equal((await repository.getUser('legacy')).username, 'legacy');
    const upgradedText = await fs.readFile(file, 'utf8');
    const upgraded = JSON.parse(upgradedText);
    assert.equal(upgradedText.includes(legacyBearer), false);
    assert.ok(upgraded.adaptive_learning_execution_claims[0].revoked_at);
    assert.equal(upgraded.adaptive_learning_execution_claims[0].consumed_at, null);
    assert.equal(upgraded.adaptive_learning_execution_claims[0].attempt_type, null);
    assert.equal(upgraded.adaptive_learning_execution_claims[0].attempt_ref, null);
    assert.equal(upgraded.adaptive_learning_execution_claims[1].revoked_at, null);
    assert.equal(upgraded.adaptive_learning_session_mutations.length, 2);
    assert.equal(upgraded.adaptive_learning_session_mutations[0].idempotency_key, 'hmac-start-key');
    assert.equal(upgraded.adaptive_learning_session_mutations[1].idempotency_key, 'recovery-start-key');
    assert.deepEqual(upgraded.adaptive_learning_session_mutations[1].response_snapshot.recoveryAttempt, {
      type: 'module', id: '30000000-0000-4000-8000-000000000003',
    });
    const recoveryReplay = await repository.getAdaptiveLearningSessionMutationReplay('legacy', {
      operation: 'start', sessionId: '20000000-0000-4000-8000-000000000002',
      idempotencyKey: 'recovery-start-key', requestHash: 'b'.repeat(64),
    });
    assert.deepEqual(recoveryReplay.recoveryAttempt, {
      type: 'module', id: '30000000-0000-4000-8000-000000000003',
    });
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file adaptive profile save/get expose the shared allowlisted repository DTO', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(1099, 'Adaptive DTO');
    await assertAdaptiveProfileRepositoryContract(
      assert,
      repository,
      username,
      buildAdaptiveLearningProfile(),
      new Date('2026-08-04T06:00:00.000Z'),
    );
  });
});

test('file adaptive profile watermark rejects reverse-order and same-time stale saves', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(1100, 'Adaptive Race');
    const attempt = (id, createdAt) => ({
      id, module: 'grammar', activity: 'grammar_19_24', score: 8, max_score: 10,
      evidence_quality: 'server_verified_unassisted', created_at: createdAt,
    });
    const first = attempt('10000000-0000-4000-8000-000000000001', '2026-08-04T05:00:00.000Z');
    const latest = attempt('10000000-0000-4000-8000-000000000002', '2026-08-04T06:00:00.000Z');
    const backfill = attempt('10000000-0000-4000-8000-000000000003', '2026-08-04T04:00:00.000Z');
    await assertAdaptiveProfileRejectsStale(assert, repository, username, {
      older: buildAdaptiveLearningProfile({ attempts: [first] }),
      newer: buildAdaptiveLearningProfile({ attempts: [first, latest] }),
      backfilled: buildAdaptiveLearningProfile({ attempts: [backfill, first, latest] }),
    });
  });
});

test('file adaptive profile ordering is append-only and calculation-revision aware', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(1101, 'Adaptive Ordering');
    await assertAdaptiveProfileAppendOnlyOrdering(
      assert, repository, username, buildAdaptiveLearningProfile,
    );
  });
});

test('file adaptive goal uses the shared allowlisted ISO timestamp DTO', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(1102, 'Adaptive Goal DTO');
    await assertAdaptiveGoalRepositoryContract(assert, repository, username, {
      id: '30000000-0000-4000-8000-000000000001',
      idempotencyKey: 'file-goal-contract-0001',
      requestHash: 'a'.repeat(64),
      targetExam: 'ege_english',
      targetScore: 85,
      examDate: '2027-06-01',
      weeklyMinutes: 300,
      now: new Date('2026-08-04T08:00:00.000Z'),
    });
  });
});

test('file adaptive diagnostic uses the shared owner-bound persistence and export contract', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(1103, 'Adaptive Diagnostic DTO');
    await assertAdaptiveDiagnosticRepositoryContract(assert, repository, username);
    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.exportUserData(username), null);
  });
});

test('file adaptive plan revisions use the shared owner-bound persistence and export contract', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(1104, 'Adaptive Plan DTO');
    await assertAdaptivePlanRepositoryContract(assert, repository, username);
    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.getCurrentAdaptiveLearningPlan(username), null);
  });
});

test('file repository merges progress modules without replacing siblings', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(1005, 'Merge User');
    await repository.saveProgress(username, { words: { learned: 3 }, grammar: { score: 4 } });
    const merged = await repository.mergeProgress(username, { words: { learned: 5 }, reading: { score: 2 } });
    assert.deepEqual(merged, { words: { learned: 5 }, grammar: { score: 4 }, reading: { score: 2 } });
  });
});

test('trial and subscription status are persisted', async () => {
  await withRepository(async (repository) => {
    const result = await repository.activateTrial(1002, 30, 'Student');
    assert.equal(result.applied, true);
    assert.equal((await repository.activateTrial(1002, 30, 'Student')).applied, false);
    const subscription = await repository.getSub(result.username);
    assert.equal(subscription.active, true);
    assert.equal(subscription.trial_used, true);
    assert.equal((await repository.exportUserData(result.username)).subscription_events.length, 1);
  });
});

test('payment approval is idempotent and records its actor and result', async () => {
  await withRepository(async (repository) => {
    const request = await repository.createPaymentRequest('b82c0a3f-1800-4b04-b573-4bb23bdf5b5a', 1012, 'Paying Student');
    const duplicate = await repository.createPaymentRequest('4c9c0821-6894-47eb-9f5d-a2cf1ef95073', 1012, 'Paying Student');
    assert.equal(duplicate.id, request.id);
    const approved = await repository.resolvePaymentRequest(request.id, 'approved', 9001, 30);
    assert.equal(approved.applied, true);
    const subscriptionAfterFirstClick = (await repository.getUser(request.username)).sub_until;
    const repeated = await repository.resolvePaymentRequest(request.id, 'approved', 9001, 30);
    assert.equal(repeated.applied, false);
    assert.equal((await repository.getUser(request.username)).sub_until, subscriptionAfterFirstClick);
    const exported = await repository.exportUserData(request.username);
    assert.equal(exported.payment_requests[0].status, 'approved');
    assert.equal(exported.payment_requests[0].actor_telegram_id, 9001);
    assert.equal(exported.subscription_events.length, 1);
    assert.equal(exported.audit_log.length, 1);
    assert.equal(exported.audit_log[0].action, 'payment.resolve');
  });
});

test('telegram user creation is idempotent', async () => {
  await withRepository(async (repository) => {
    const first = await repository.createTelegramUser(1003, 'Same User');
    const second = await repository.createTelegramUser(1003, 'Changed Name');
    assert.equal(second, first);
  });
});

test('telegram auth code is pending until confirmed and can be consumed once', async () => {
  await withRepository(async (repository) => {
    await repository.createTelegramAuthCode('secret-code', Date.now() + 60_000);
    assert.equal(await repository.consumeTelegramAuthCode('secret-code'), null);
    assert.equal(await repository.confirmTelegramAuthCode('secret-code', 2001, 'Student'), true);
    assert.deepEqual(await repository.consumeTelegramAuthCode('secret-code'), {
      telegram_id: 2001,
      name: 'Student',
    });
    assert.equal(await repository.consumeTelegramAuthCode('secret-code'), null);
  });
});

test('expired telegram auth code cannot be confirmed', async () => {
  await withRepository(async (repository) => {
    await repository.createTelegramAuthCode('expired-code', Date.now() - 1);
    assert.equal(await repository.confirmTelegramAuthCode('expired-code', 2002, 'Student'), false);
    assert.equal(await repository.consumeTelegramAuthCode('expired-code'), null);
  });
});

test('sessions can be validated and revoked server-side', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(2010, 'Session User');
    const sessionId = '4f24a754-d25a-49ab-8182-111c02ef225d';
    await repository.createSession(sessionId, username, Date.now() + 60_000);
    assert.equal(await repository.isSessionActive(sessionId, username), true);
    assert.equal(await repository.isSessionActive(sessionId, 'another-user'), false);
    assert.equal(await repository.revokeSession(sessionId, username), true);
    assert.equal(await repository.isSessionActive(sessionId, username), false);
    assert.equal(await repository.revokeSession(sessionId, username), false);
  });
});

test('user roles are validated and persisted', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(2020, 'Role User');
    assert.equal((await repository.getUser(username)).role, 'student');
    assert.equal(await repository.setUserRole(username, 'admin'), 'admin');
    assert.equal((await repository.getUser(username)).role, 'admin');
    await assert.rejects(repository.setUserRole(username, 'owner'), /INVALID_ROLE/u);
  });
});

test('writing attempt and AI metadata are persisted without prompt text in the AI log', async () => {
  await withRepository(async (repository, file) => {
    const username = await repository.createTelegramUser(3001, 'Writer');
    const attemptId = await repository.createWritingAttempt(username, {
      taskType: 'writing_37',
      assignment: { from: 'Ben', stimulus: 'Three questions from a friend.', questionsTopic: 'his dog' },
      answer: 'Student answer text',
      evaluatedAnswer: 'Student answer',
    }, 'writing-v1');
    await repository.finishWritingAttempt(attemptId, {
      status: 'failed',
      provider: 'groq',
      model: 'test-model',
      errorCode: 'AI_UNAVAILABLE',
    });
    await repository.logAiRequest({
      username,
      operation: 'writing_37',
      provider: 'groq',
      model: 'test-model',
      promptVersion: 'writing-v1',
      status: 'failed',
      durationMs: 123,
      errorCode: 'AI_UNAVAILABLE',
      promptTokens: 42,
      completionTokens: 17,
      estimatedCostMicrousd: 25,
    });
    assert.equal(await repository.countAiRequestsSince(new Date(Date.now() - 60_000)), 1);
    assert.equal(await repository.countAiRequestsSince(new Date(Date.now() + 60_000)), 0);
    assert.deepEqual(await repository.getAiUsageMetrics(24), {
      windowHours: 24, requests: 1, promptTokens: 42, completionTokens: 17, estimatedCostMicrousd: 25,
    });

    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(stored.writing_attempts[0].status, 'failed');
    assert.equal(stored.writing_attempts[0].provider, 'groq');
    assert.equal(stored.writing_attempts[0].model, 'test-model');
    assert.equal(stored.writing_attempts[0].prompt_version, 'writing-v1');
    assert.equal(stored.writing_attempts[0].error_code, 'AI_UNAVAILABLE');
    assert.equal(stored.writing_attempts[0].answer, 'Student answer text');
    assert.equal(stored.writing_attempts[0].evaluated_answer, 'Student answer');
    const exported = await repository.exportUserData(username);
    assert.equal(exported.writing_attempts[0].model, 'test-model');
    assert.equal(exported.writing_attempts[0].evaluated_answer, 'Student answer');
    assert.equal(stored.ai_requests[0].durationMs, 123);
    assert.equal(stored.ai_requests[0].promptTokens, 42);
    assert.equal(stored.ai_requests[0].completionTokens, 17);
    assert.equal(stored.ai_requests[0].estimatedCostMicrousd, 25);
    assert.equal(JSON.stringify(stored.ai_requests).includes('Student answer text'), false);
  });
});

test('speaking attempts persist transcript review metadata but never audio', async () => {
  await withRepository(async (repository, file) => {
    const username = await repository.createTelegramUser(3010, 'Speaker');
    const attemptId = await repository.createSpeakingAttempt(username, {
      taskType: 2,
      assignment: { ad: 'Ask about a course.', points: ['price', 'place', 'time', 'equipment'] },
      transcript: 'How much does it cost?',
    }, 'speaking-eval-v1');
    await repository.finishSpeakingAttempt(attemptId, {
      status: 'completed', provider: 'test', model: 'speaking-test-model', review: { got: 1, max: 4 },
    });
    const exported = await repository.exportUserData(username);
    assert.equal(exported.speaking_attempts[0].transcript, 'How much does it cost?');
    assert.equal(exported.speaking_attempts[0].review.got, 1);
    assert.equal(exported.speaking_attempts[0].provider, 'test');
    assert.equal(exported.speaking_attempts[0].model, 'speaking-test-model');
    assert.equal(exported.speaking_attempts[0].prompt_version, 'speaking-eval-v1');
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(JSON.stringify(stored.speaking_attempts).includes('audio'), false);
  });
});

test('attempts saved before model provenance export an explicit unknown model', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-legacy-attempts-'));
  const file = path.join(directory, 'data.json');
  await fs.writeFile(file, JSON.stringify({
    users: { legacy: { created: Date.now() } },
    writing_attempts: [{ id: 1, username: 'legacy', answer: 'Legacy full answer', prompt_version: 'writing-v3', status: 'completed' }],
    speaking_attempts: [{ id: 1, username: 'legacy', prompt_version: 'speaking-eval-v1', status: 'failed' }],
  }));
  const repository = createFileRepository(file);
  try {
    const exported = await repository.exportUserData('legacy');
    assert.equal(exported.writing_attempts[0].model, null);
    assert.equal(exported.writing_attempts[0].evaluated_answer, 'Legacy full answer');
    assert.equal(exported.speaking_attempts[0].model, null);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('generated tasks are reused by request hash and exported without internal hashes', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(3020, 'Generator');
    const entry = { operation: 'grammar_quiz', requestHash: 'a'.repeat(64), request: { operation: 'grammar_quiz' }, result: [{ q: 'One' }], provider: 'test', promptVersion: 'content-v1' };
    const firstId = await repository.saveGeneratedTask(username, entry);
    assert.equal(await repository.saveGeneratedTask(username, entry), firstId);
    const cached = await repository.getGeneratedTask(username, entry.requestHash);
    assert.deepEqual(cached.result, entry.result);
    const exported = await repository.exportUserData(username);
    assert.equal(exported.generated_tasks.length, 1);
    assert.equal('request_hash' in exported.generated_tasks[0], false);
  });
});

test('concurrent generated-task writers converge on one canonical stored result', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(3021, 'Concurrent Generator');
    const requestHash = 'b'.repeat(64);
    const base = { operation: 'vocabulary_cards', requestHash, request: { operation: 'vocabulary_cards', count: 1, exclude: [] }, promptVersion: 'content-v1' };
    const [firstId, secondId] = await Promise.all([
      repository.saveGeneratedTask(username, { ...base, result: [{ w: 'first' }], provider: 'first' }),
      repository.saveGeneratedTask(username, { ...base, result: [{ w: 'second' }], provider: 'second' }),
    ]);
    assert.equal(firstId, secondId);
    const stored = await repository.getGeneratedTask(username, requestHash);
    assert.ok(['first', 'second'].includes(stored.result[0].w));
    assert.equal(stored.provider, stored.result[0].w);
  });
});

test('module attempts are idempotent and included in user export', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(3030, 'Module Student');
    const attempt = { id: '222b90b8-0f21-481c-b606-5211b2c65754', module: 'exam', activity: 'grammar_19_24', score: 4, maxScore: 6, durationMs: 60_000, metadata: { source: 'builtin' } };
    assert.equal((await repository.recordModuleAttempt(username, attempt)).created, true);
    assert.equal((await repository.recordModuleAttempt(username, attempt)).created, false);
    assert.equal((await repository.getModuleAttempt(username, attempt.id)).evidence_quality, 'client_reported');
    const verified = { ...attempt, id: '4ec99215-2354-4c05-b68a-07910f8e898a', activity: 'grammar_25_29' };
    assert.equal((await repository.recordModuleAttempt(username, verified, {
      evidenceQuality: 'server_verified_unassisted',
    })).created, true);
    assert.equal((await repository.getModuleAttempt(username, verified.id)).evidence_quality, 'server_verified_unassisted');
    const exported = await repository.exportUserData(username);
    assert.equal(exported.module_attempts.length, 2);
    assert.equal(exported.module_attempts[0].score, 4);
    assert.equal(exported.module_attempts[0].evidence_quality, 'client_reported');
    assert.equal(exported.progress_summary.length, 1);
    assert.equal(exported.progress_summary[0].attempt_count, 2);
    assert.equal(exported.progress_summary[0].best_score, 4);
  });
});

test('word progress upserts normalized SRS state', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(3040, 'Words Student');
    await repository.upsertWordProgress(username, [{ word: 'Achievement', stage: 2, errorCount: 1, reviewCount: 3, dueAt: 1000 }]);
    await repository.upsertWordProgress(username, [{ word: 'achievement', stage: 3, errorCount: 1, reviewCount: 4, dueAt: 2000 }]);
    const exported = await repository.exportUserData(username);
    assert.equal(exported.word_progress.length, 1);
    assert.equal(exported.word_progress[0].word, 'achievement');
    assert.equal(exported.word_progress[0].stage, 3);
  });
});

test('file word mastery matches the shared persistence, export and deletion contract', async () => {
  await withRepository(async (repository) => {
    const owner = await repository.createTelegramUser(3041, 'Mastery Owner');
    const other = await repository.createTelegramUser(3042, 'Mastery Other');
    await assertWordProgressRepositoryContract(assert, repository, owner, other);
  });
});

test('file personal words match the shared persistence, export and deletion contract', async () => {
  await withRepository(async (repository) => {
    const owner = await repository.createTelegramUser(3043, 'Personal words owner');
    const other = await repository.createTelegramUser(3044, 'Personal words other');
    await assertPersonalWordsProgressRepositoryContract(assert, repository, owner, other);
  });
});

test('file storage rewrites legacy word progress once without inventing independent evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-legacy-words-'));
  const file = path.join(directory, 'data.json');
  await fs.writeFile(file, JSON.stringify({
    users: { legacy: { created: 1 } },
    word_progress: {
      legacy: {
        achievement: {
          word: 'Achievement', stage: 5, error_count: 1, review_count: 8,
          due_at: 2_000, updated_at: 1_000,
        },
      },
    },
  }), 'utf8');

  const firstRepository = createFileRepository(file);
  const first = await firstRepository.getWordProgress('legacy');
  await firstRepository.close();
  assert.equal(first[0].stage, 5);
  assert.equal(first[0].dimensions.meaning.evidence, 'preliminary');
  assert.equal(first[0].dimensions.context.independentSuccesses, 0);
  const migratedText = await fs.readFile(file, 'utf8');
  assert.equal(JSON.parse(migratedText).word_progress.legacy.achievement.mastery_version, 1);

  const secondRepository = createFileRepository(file);
  assert.deepEqual(await secondRepository.getWordProgress('legacy'), first);
  await secondRepository.close();
  assert.equal(await fs.readFile(file, 'utf8'), migratedText);
  await fs.rm(directory, { recursive: true, force: true });
});

test('error bank aggregates repeated learning errors', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(3050, 'Error Student');
    const error = { module: 'grammar', itemKey: 'grammar_19_24:go', errorType: 'incorrect_form', details: { expected: 'went' } };
    await repository.upsertErrorBank(username, [error]);
    await repository.upsertErrorBank(username, [error]);
    const exported = await repository.exportUserData(username);
    assert.equal(exported.error_bank.length, 1);
    assert.equal(exported.error_bank[0].occurrence_count, 2);
    assert.equal(exported.error_bank[0].details.expected, 'went');
  });
});

test('file repository readiness check succeeds after pending writes', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(4001, 'Health User');
    const save = repository.saveProgress(username, { ready: true });
    assert.equal(await repository.healthCheck(), true);
    await save;
  });
});

test('user data can be exported and deleted with all related records', async () => {
  await withRepository(async (repository) => {
    const username = await repository.createTelegramUser(5001, 'Privacy User');
    await repository.saveProgress(username, { words: { learned: 7 } });
    const consent = await repository.setPrivacyConsent(username, { text_processing: true, voice_processing: false, policy_version: 'test-v1' });
    assert.equal(consent.text_processing, true);
    const attemptId = await repository.createWritingAttempt(username, {
      taskType: 'writing_37',
      assignment: { from: 'Ben', stimulus: 'Questions', questionsTopic: 'school' },
      answer: 'Private answer',
      evaluatedAnswer: 'Private evaluated answer',
    }, 'writing-v1');
    await repository.finishWritingAttempt(attemptId, { status: 'failed', errorCode: 'TEST' });
    await repository.logAiRequest({ username, operation: 'writing_37', status: 'failed' });

    const exported = await repository.exportUserData(username);
    assert.equal(exported.account.username, username);
    assert.equal(exported.account.telegram_id, 5001);
    assert.deepEqual(exported.progress, { words: { learned: 7 } });
    assert.equal(exported.writing_attempts.length, 1);
    assert.equal(exported.writing_attempts[0].answer, 'Private answer');
    assert.equal(exported.writing_attempts[0].evaluated_answer, 'Private evaluated answer');
    assert.equal(exported.ai_requests.length, 1);
    assert.equal(exported.privacy_consent.policy_version, 'test-v1');
    assert.equal('hash' in exported.account, false);

    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.getUser(username), null);
    assert.deepEqual(await repository.getProgress(username), {});
    assert.equal(await repository.exportUserData(username), null);
    assert.equal(await repository.deleteUserData(username), false);
  });
});

test('account deletion anonymizes retained administrative audit', async () => {
  await withRepository(async (repository, file) => {
    const request = await repository.createPaymentRequest('77e30d65-c90e-49a2-8d17-e08b5958c310', 5002, 'Deleted Payer');
    await repository.resolvePaymentRequest(request.id, 'rejected', 9001, 30);
    await repository.deleteUserData(request.username);
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(stored.audit_log.length, 1);
    assert.equal(stored.audit_log[0].metadata.username, undefined);
    assert.equal(stored.audit_log[0].metadata.account_deleted, true);
  });
});
