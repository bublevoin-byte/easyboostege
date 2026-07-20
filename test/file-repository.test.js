import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFileRepository } from '../storage/file-repository.js';

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
    }, 'writing-v1');
    await repository.finishWritingAttempt(attemptId, {
      status: 'failed',
      provider: 'groq',
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

    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(stored.writing_attempts[0].status, 'failed');
    assert.equal(stored.writing_attempts[0].error_code, 'AI_UNAVAILABLE');
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
    await repository.finishSpeakingAttempt(attemptId, { status: 'completed', provider: 'test', review: { got: 1, max: 4 } });
    const exported = await repository.exportUserData(username);
    assert.equal(exported.speaking_attempts[0].transcript, 'How much does it cost?');
    assert.equal(exported.speaking_attempts[0].review.got, 1);
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(JSON.stringify(stored.speaking_attempts).includes('audio'), false);
  });
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
    }, 'writing-v1');
    await repository.finishWritingAttempt(attemptId, { status: 'failed', errorCode: 'TEST' });
    await repository.logAiRequest({ username, operation: 'writing_37', status: 'failed' });

    const exported = await repository.exportUserData(username);
    assert.equal(exported.account.username, username);
    assert.equal(exported.account.telegram_id, 5001);
    assert.deepEqual(exported.progress, { words: { learned: 7 } });
    assert.equal(exported.writing_attempts.length, 1);
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
