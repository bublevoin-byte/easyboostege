import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createVoiceTutorRoutes } from '../routes/voice-tutor.js';
import { createFileRepository } from '../storage/file-repository.js';
import {
  buildWritingSpeakingCapsule,
  persistedVoiceTutorCapsule,
  publicVoiceTutorCapsule,
} from '../voice-tutor/capsule.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const LIMITS = Object.freeze({ dailySeconds: 600, monthlySeconds: 7_200, sessionSeconds: 300 });
const WRITING_SECRET = 'My complete private essay must stay outside the public Voice Tutor session.';
const WRITING_ANSWER = `${WRITING_SECRET} ${Array.from({ length: 100 }, (_, index) => `word${index + 1}`).join(' ')}`;
const SPEAKING_SECRET = 'My complete private speaking transcript must stay outside the public Voice Tutor session.';

const writingReview = Object.freeze({
  words: 112,
  in_range: true,
  overall_got: 4,
  overall_max: 6,
  verdict: 'Нужно точнее ответить на вопросы.',
  sub: 'Структура понятна, но один аспект раскрыт частично.',
  criteria: [
    { name: 'Решение коммуникативной задачи', got: 1, max: 2 },
    { name: 'Организация текста', got: 1, max: 2 },
    { name: 'Языковое оформление', got: 2, max: 2 },
  ],
  errors: [{
    title: 'Неполный ответ',
    wrong: 'I like sport.',
    right: 'I like sport because it helps me stay healthy.',
    kind: 'err',
    note: 'Добавь причину, чтобы полностью раскрыть аспект.',
  }],
});

const speakingReview = Object.freeze({
  got: 7,
  max: 10,
  verdict: 'План раскрыт не полностью.',
  criteria: [
    { name: 'Решение коммуникативной задачи', got: 3, max: 4 },
    { name: 'Организация', got: 2, max: 3 },
    { name: 'Языковое оформление', got: 2, max: 3 },
  ],
  good: ['Есть вступление и вывод.'],
  fix: [{
    wrong: 'There are two photo.',
    right: 'There are two photos.',
    note: 'После two нужно множественное число.',
  }],
});

async function seedCompletedReviews(repository, username) {
  const writingId = await repository.createWritingAttempt(username, {
    taskType: 'writing_37',
    assignment: { from: 'Sam', stimulus: 'Write an email and answer all three questions from your friend.', questionsTopic: 'sports club' },
    answer: WRITING_ANSWER,
    evaluatedAnswer: WRITING_ANSWER,
  }, 'writing-v5');
  await repository.finishWritingAttempt(writingId, {
    status: 'completed', review: writingReview, provider: 'fake-evaluator', model: 'fake-writing-model',
  });
  const speakingId = await repository.createSpeakingAttempt(username, {
    taskType: 4,
    assignment: { topic: 'Compare two photographs', plan: ['describe', 'compare', 'advantages', 'opinion'], ph: ['photo one', 'photo two'] },
    transcript: SPEAKING_SECRET,
  }, 'speaking-eval-v2');
  await repository.finishSpeakingAttempt(speakingId, {
    status: 'completed', review: speakingReview, provider: 'fake-evaluator', model: 'fake-speaking-model',
  });
  return { writingId, speakingId };
}

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

async function withReviewApp(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-voice-review-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(7411, 'Review Owner');
  const stranger = await repository.createTelegramUser(7412, 'Review Stranger');
  for (const [telegramId, username] of [[7411, owner], [7412, stranger]]) {
    await repository.grantDays(telegramId, 30, username);
    await repository.setEntitlement(username, 'voice_tutor', { startsAt: NOW, endsAt: new Date('2026-09-02T12:00:00.000Z') });
    await repository.setPrivacyConsent(username, { text_processing: true, voice_processing: true, policy_version: 'test-v1' });
  }
  const source = await seedCompletedReviews(repository, owner);
  const credentialCalls = [];
  const sessionIds = [
    '940f8ef2-15d4-4534-b679-8c0ca8105220',
    '38fbc440-42e9-4e6d-a704-8ed0cae9d4c7',
  ];
  const nonces = [
    'review-session-nonce-0001', 'review-session-nonce-0002', 'review-session-nonce-0003',
    'review-session-nonce-0004', 'review-session-nonce-0005', 'review-session-nonce-0006',
  ];
  const app = express();
  app.use(express.json());
  app.use(createVoiceTutorRoutes({
    authentication: authentication(),
    db: repository,
    limits: LIMITS,
    now: () => NOW,
    newSessionId: () => sessionIds.shift(),
    newNonce: () => nonces.shift(),
    privacyPolicyVersion: 'test-v1',
    credentialProvider: {
      async createCredential(input) {
        credentialCalls.push(input);
        return { credential: 'ephemeral-review-credential', expires_at: 1_785_662_700, realtime_url: 'wss://fake.invalid/realtime' };
      },
    },
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
    await run({ repository, owner, stranger, source, credentialCalls, request });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('writing and speaking capsules use only completed validated server-owned reviews', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-review-capsule-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const username = await repository.createTelegramUser(7421, 'Capsule Owner');
    const { writingId, speakingId } = await seedCompletedReviews(repository, username);
    const storedWriting = await repository.getWritingAttempt(username, writingId);
    const writing = buildWritingSpeakingCapsule({ source: 'writing', attempt: storedWriting, expectedRevision: 1, criterionIndex: 0 });
    assert.equal(writing.module, 'writing');
    assert.equal(writing.source.attempt_type, 'writing');
    assert.equal(writing.learner_answer, WRITING_ANSWER);
    assert.deepEqual(
      writing.item.reference.criteria.map(({ name, lostPoints }) => ({ name, lostPoints })),
      [
        { name: 'Решение коммуникативной задачи', lostPoints: 1 },
        { name: 'Организация текста', lostPoints: 1 },
      ],
    );
    assert.match(writing.rule.explanation, /Организация текста/u);
    assert.equal(writing.checks.micro_check.answers[0], 'b');
    assert.match(writing.checks.micro_check.prompt, /полностью раскрывает причину/u);
    assert.equal(writing.checks.transfer_task.answers[0], 'because');
    assert.match(writing.checks.transfer_task.prompt, /science club/u);
    assert.doesNotMatch(writing.checks.transfer_task.prompt, /I like sport/u);
    const writingOrganization = buildWritingSpeakingCapsule({
      source: 'writing', attempt: storedWriting, expectedRevision: 1, criterionIndex: 1,
    });
    assert.equal(writingOrganization.checks.micro_check.answers[0], 'however');
    assert.equal(writingOrganization.checks.transfer_task.answers[0], 'finally');
    assert.equal(publicVoiceTutorCapsule(writing).learner_answer, undefined);
    assert.equal(persistedVoiceTutorCapsule(writing).learner_answer, undefined);

    const speaking = buildWritingSpeakingCapsule({
      source: 'speaking', attempt: await repository.getSpeakingAttempt(username, speakingId), expectedRevision: 1, criterionIndex: 0,
    });
    assert.equal(speaking.module, 'speaking');
    assert.equal(speaking.learner_answer, SPEAKING_SECRET);
    assert.equal(speaking.item.reference.criteria.length, 3);
    assert.equal(speaking.checks.transfer_task.answers[0], 'because');
    assert.match(speaking.checks.transfer_task.prompt, /second picture/u);
    assert.doesNotMatch(speaking.checks.transfer_task.prompt, /two photo/u);
    const speakingLanguage = buildWritingSpeakingCapsule({
      source: 'speaking', attempt: await repository.getSpeakingAttempt(username, speakingId), expectedRevision: 1, criterionIndex: 2,
    });
    assert.notEqual(speakingLanguage.id, speaking.id);
    assert.match(speakingLanguage.rule.title, /Языковое оформление/u);
    assert.equal(speakingLanguage.checks.transfer_task.answers[0], 'students');

    const writing38Answer = Array.from({ length: 200 }, (_, index) => `word${index + 1}`).join(' ');
    const writing38 = {
      id: 99,
      status: 'completed',
      task_type: 'writing_38',
      assignment: { topic: 'School clubs', rows: [{ label: 'Sports', percent: 50 }, { label: 'Music', percent: 30 }, { label: 'Science', percent: 20 }] },
      answer: writing38Answer,
      evaluated_answer: writing38Answer,
      review: {
        words: 200, in_range: true, overall_got: 0, overall_max: 14, verdict: 'Нужна доработка.', sub: 'Проверь каждый критерий.',
        criteria: [
          { name: 'Решение коммуникативной задачи', got: 0, max: 3 },
          { name: 'Организация текста', got: 0, max: 3 },
          { name: 'Лексика', got: 0, max: 3 },
          { name: 'Грамматика', got: 0, max: 3 },
          { name: 'Орфография и пунктуация', got: 0, max: 2 },
        ],
        errors: [{ title: 'Язык', wrong: 'do a decision', right: 'make a decision', kind: 'err', note: 'Проверь лексику и грамматику.' }],
      },
    };
    assert.equal(buildWritingSpeakingCapsule({ source: 'writing', attempt: writing38, expectedRevision: 1, criterionIndex: 2 }).checks.transfer_task.answers[0], 'plays');
    assert.equal(buildWritingSpeakingCapsule({ source: 'writing', attempt: writing38, expectedRevision: 1, criterionIndex: 3 }).checks.transfer_task.answers[0], 'had');
    assert.equal(buildWritingSpeakingCapsule({ source: 'writing', attempt: writing38, expectedRevision: 1, criterionIndex: 4 }).checks.transfer_task.answers[0], 'necessary');

    const speaking2 = {
      id: 100,
      status: 'completed',
      task_type: 2,
      assignment: { ad: 'Ask about a hotel.', points: ['price', 'location', 'breakfast', 'parking'] },
      transcript: 'How much it costs? Where hotel is? Breakfast? Parking?',
      review: {
        got: 0, max: 4, verdict: 'Исправь вопросы.',
        criteria: Array.from({ length: 4 }, (_, index) => ({ name: `Вопрос ${index + 1}`, got: 0, max: 1 })),
        good: [], fix: [{ wrong: 'How much it costs?', right: 'How much does it cost?', note: 'Нужен порядок слов прямого вопроса.' }],
      },
    };
    assert.deepEqual(
      [0, 1, 2, 3].map((index) => buildWritingSpeakingCapsule({ source: 'speaking', attempt: speaking2, expectedRevision: 1, criterionIndex: index }).checks.transfer_task.answers[0]),
      ['how much does it cost', 'where is the hotel located', 'is breakfast included', 'is there a car park'],
    );
    assert.throws(
      () => buildWritingSpeakingCapsule({ source: 'writing', attempt: { ...storedWriting, review: { forged: true } }, expectedRevision: 1, criterionIndex: 0 }),
      (error) => error.code === 'VOICE_TUTOR_REVIEW_INVALID',
    );
    assert.throws(
      () => buildWritingSpeakingCapsule({ source: 'writing', attempt: storedWriting, expectedRevision: 1, criterionIndex: 2 }),
      (error) => error.code === 'VOICE_TUTOR_CRITERION_NOT_FOUND',
    );
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('review tracer is owner-bound, rejects client context and never exposes the full response', async () => {
  await withReviewApp(async ({ repository, owner, stranger, source, credentialCalls, request }) => {
    const forged = await request(owner, '/api/v1/voice-tutor/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'review-forged-context-001' },
      body: JSON.stringify({ source: 'writing', attemptId: source.writingId, revision: 1, criterionIndex: 0, answer: 'forged' }),
    });
    assert.equal(forged.status, 400);

    const otherUser = await request(stranger, '/api/v1/voice-tutor/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'review-owner-bound-0001' },
      body: JSON.stringify({ source: 'writing', attemptId: source.writingId, revision: 1, criterionIndex: 0 }),
    });
    assert.equal(otherUser.status, 404);

    const createdResponse = await request(owner, '/api/v1/voice-tutor/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'review-writing-create-01' },
      body: JSON.stringify({ source: 'writing', attemptId: source.writingId, revision: 1, criterionIndex: 0 }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.capsule.module, 'writing');
    assert.equal(created.capsule.source.attempt_type, 'writing');
    assert.equal(created.capsule.learner_answer, undefined);
    assert.equal(JSON.stringify(created).includes(WRITING_SECRET), false);
    assert.equal(credentialCalls.length, 1);
    assert.equal(credentialCalls[0].capsule.learner_answer, WRITING_ANSWER);

    const replayResponse = await request(owner, '/api/v1/voice-tutor/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'review-writing-create-01' },
      body: JSON.stringify({ source: 'writing', attemptId: source.writingId, revision: 1, criterionIndex: 0 }),
    });
    assert.equal(replayResponse.status, 200);
    assert.equal(credentialCalls.length, 1, 'replaying a tutor session must not call any provider again');

    const stored = await repository.getVoiceTutorSession(owner, created.session.id);
    assert.equal(JSON.stringify(stored).includes(WRITING_SECRET), false);
    const exported = await repository.exportUserData(owner);
    assert.equal(JSON.stringify(exported.voice_tutor_sessions).includes(WRITING_SECRET), false);
    const before = await repository.getWritingAttempt(owner, source.writingId);
    assert.equal(before.review.overall_got, 4);

    let state = created;
    for (const event of [
      { type: 'diagnosis_complete' },
      { type: 'explanation_complete' },
      { type: 'check_answer', answer: 'b' },
      { type: 'transfer_answer', answer: 'because' },
    ]) {
      const advanced = await request(owner, `/api/v1/voice-tutor/sessions/${created.session.id}/events`, {
        method: 'POST', body: JSON.stringify({ nonce: state.nonce, event }),
      });
      assert.equal(advanced.status, 200);
      state = await advanced.json();
    }
    assert.equal(state.session.state, 'resolved');
    const after = await repository.getWritingAttempt(owner, source.writingId);
    assert.equal(after.review.overall_got, 4, 'tutor mode must not mutate the evaluation score');
  });
});

test('speaking review tracer uses the stored transcript and rejects stale or incomplete attempts', async () => {
  await withReviewApp(async ({ repository, owner, source, credentialCalls, request }) => {
    const stale = await request(owner, '/api/v1/voice-tutor/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'review-speaking-stale-01' },
      body: JSON.stringify({ source: 'speaking', attemptId: source.speakingId, revision: 2, criterionIndex: 0 }),
    });
    assert.equal(stale.status, 409);

    const pendingId = await repository.createSpeakingAttempt(owner, {
      taskType: 2,
      assignment: { ad: 'Ask about a hotel', points: ['price', 'location', 'breakfast', 'parking'] },
      transcript: 'How much does it cost?',
    }, 'speaking-eval-v2');
    const pending = await request(owner, '/api/v1/voice-tutor/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'review-speaking-pending-1' },
      body: JSON.stringify({ source: 'speaking', attemptId: pendingId, revision: 1, criterionIndex: 0 }),
    });
    assert.equal(pending.status, 422);

    const createdResponse = await request(owner, '/api/v1/voice-tutor/sessions', {
      method: 'POST', headers: { 'Idempotency-Key': 'review-speaking-create-1' },
      body: JSON.stringify({ source: 'speaking', attemptId: source.speakingId, revision: 1, criterionIndex: 0 }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.capsule.module, 'speaking');
    assert.equal(JSON.stringify(created).includes(SPEAKING_SECRET), false);
    assert.equal(credentialCalls.at(-1).capsule.learner_answer, SPEAKING_SECRET);
  });
});
