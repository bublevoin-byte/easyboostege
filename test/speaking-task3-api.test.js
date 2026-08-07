import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createSpeakingRoutes } from '../routes/speaking.js';
import { createFileRepository } from '../storage/file-repository.js';

async function withSpeakingServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-task3-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(8_300_001, 'Speaking Three Owner');
  const other = await repository.createTelegramUser(8_300_002, 'Speaking Three Other');
  const expired = await repository.createTelegramUser(8_300_003, 'Speaking Three Expired');
  await repository.grantDays(8_300_001, 30, 'Speaking Three Owner');
  await repository.grantDays(8_300_002, 30, 'Speaking Three Other');
  await repository.setSpeakingAccentProfile(owner, { locale: 'en-GB', source: 'manual', now: new Date('2026-08-06T12:00:00.000Z') });
  await repository.setSpeakingAccentProfile(other, { locale: 'en-GB', source: 'manual', now: new Date('2026-08-06T12:00:00.000Z') });
  let now = new Date('2026-08-06T12:00:00.000Z');

  const app = express();
  app.use(express.json());
  app.use(createSpeakingRoutes({
    authentication: {
      auth(req, res, next) {
        const username = req.get('x-test-user');
        if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        req.user = username;
        return next();
      },
    },
    access: {
      async requireActiveSubscription(req, res, next) {
        if ((await repository.getSub(req.user)).active) return next();
        return res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED' } });
      },
    },
    db: repository,
    now: () => now,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = (username, pathname, { method = 'GET', body } = {}) => fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': username },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  try {
    await run({ owner, other, expired, request, advanceSeconds(seconds) {
      now = new Date(now.getTime() + seconds * 1_000);
    } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const answerMetadata = (duration = 22) => ({
  recordingDurationSeconds: duration,
  localPlayback: true,
  selfRating: 'steady',
});

test('task 3 API owns five sequential interview answers and restores exact safe progress', async () => {
  await withSpeakingServer(async ({ owner, other, expired, request, advanceSeconds }) => {
    assert.equal((await request(expired, '/api/v1/speaking/task-3/sessions', { method: 'POST', body: {} })).status, 403);
    assert.equal((await request(owner, '/api/v1/speaking/task-3/sessions', {
      method: 'POST', body: { questions: ['client must not choose'] },
    })).status, 400);

    const assignedResponse = await request(owner, '/api/v1/speaking/task-3/sessions', { method: 'POST', body: {} });
    assert.equal(assignedResponse.status, 201);
    const assigned = await assignedResponse.json();
    assert.equal(assigned.task.preparationSeconds, 0);
    assert.equal(assigned.task.questionSeconds, 40);
    assert.equal(assigned.task.maxScore, 5);
    assert.equal(assigned.task.questions.length, 5);
    assert.equal(assigned.currentQuestion, 1);
    assert.equal(assigned.status, 'assigned');
    assert.deepEqual(assigned.answers.map(({ questionNumber, status }) => ({ questionNumber, status })), [
      { questionNumber: 1, status: 'pending' },
      { questionNumber: 2, status: 'pending' },
      { questionNumber: 3, status: 'pending' },
      { questionNumber: 4, status: 'pending' },
      { questionNumber: 5, status: 'pending' },
    ]);
    assert.deepEqual(assigned.assessment, {
      available: false,
      reason: 'deferred_to_tickets_06_07',
      message: 'Автоматическая оценка появится после подключения и методической проверки в следующих этапах.',
    });
    assert.equal(Object.hasOwn(assigned.task, 'completeness'), false);
    assert.equal(Object.hasOwn(assigned.task, 'provenance'), false);
    assert.equal(Object.hasOwn(assigned.task, 'reference'), false);

    assert.equal((await request(other, `/api/v1/speaking/task-3/sessions/${assigned.id}`)).status, 404);
    assert.equal((await request(owner, `/api/v1/speaking/task-3/sessions/${assigned.id}/answers/6/complete`, {
      method: 'POST', body: answerMetadata(),
    })).status, 400);
    assert.equal((await request(owner, `/api/v1/speaking/task-3/sessions/${assigned.id}/answers/2/complete`, {
      method: 'POST', body: answerMetadata(),
    })).status, 409);
    assert.equal((await request(owner, `/api/v1/speaking/task-3/sessions/${assigned.id}/answers/1/complete`, {
      method: 'POST', body: { ...answerMetadata(), audio: 'binary', transcript: 'secret', score: 1 },
    })).status, 400);

    advanceSeconds(22);
    const firstResponse = await request(owner, `/api/v1/speaking/task-3/sessions/${assigned.id}/answers/1/complete`, {
      method: 'POST', body: answerMetadata(),
    });
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.status, 'in_progress');
    assert.equal(first.currentQuestion, 2);
    assert.deepEqual(first.answers[0], {
      questionNumber: 1,
      status: 'completed',
      recordingDurationSeconds: 22,
      localPlayback: true,
      selfRating: 'steady',
      completedAt: '2026-08-06T12:00:22.000Z',
    });
    assert.equal(/(?:audio|transcript|score)/iu.test(JSON.stringify(first.answers[0])), false);

    const recovered = await (await request(owner, `/api/v1/speaking/task-3/sessions/${assigned.id}`)).json();
    assert.equal(recovered.currentQuestion, 2);
    assert.equal(recovered.answers.filter((answer) => answer.status === 'completed').length, 1);

    for (let questionNumber = 2; questionNumber <= 5; questionNumber += 1) {
      advanceSeconds(20 + questionNumber);
      const response = await request(owner, `/api/v1/speaking/task-3/sessions/${assigned.id}/answers/${questionNumber}/complete`, {
        method: 'POST', body: answerMetadata(20 + questionNumber),
      });
      assert.equal(response.status, 200);
      const session = await response.json();
      assert.equal(session.answers.filter((answer) => answer.status === 'completed').length, questionNumber);
      assert.equal(session.currentQuestion, Math.min(5, questionNumber + 1));
      assert.equal(session.status, questionNumber === 5 ? 'completed' : 'in_progress');
    }

    const replay = await request(owner, `/api/v1/speaking/task-3/sessions/${assigned.id}/answers/5/complete`, {
      method: 'POST', body: answerMetadata(1),
    });
    assert.equal(replay.status, 200);
    const replayed = await replay.json();
    assert.equal(replayed.answers[4].recordingDurationSeconds, 25);
    assert.equal(replayed.answers.length, 5);
    assert.equal(JSON.stringify(replayed).includes('binary'), false);
    assert.equal(JSON.stringify(replayed).includes('secret'), false);
  });
});

test('task 3 assignment rotates through all 60 server-owned interview sets', async () => {
  await withSpeakingServer(async ({ owner, request }) => {
    const assignments = [];
    for (let index = 0; index < 60; index += 1) {
      const response = await request(owner, '/api/v1/speaking/task-3/sessions', { method: 'POST', body: {} });
      assert.equal(response.status, 201);
      assignments.push(await response.json());
    }
    assert.equal(new Set(assignments.map((session) => session.task.id)).size, 60);
    assert.equal(assignments.every((session) => session.selectionReason === 'unseen'), true);
  });
});

test('task 3 recovery reports an incompatible catalog instead of returning partial content', async () => {
  const sessionId = '73300000-0000-4000-8000-000000000099';
  const app = express();
  app.use(express.json());
  app.use(createSpeakingRoutes({
    authentication: { auth(req, _res, next) { req.user = 'catalog-owner'; next(); } },
    access: { requireActiveSubscription(_req, _res, next) { next(); } },
    db: {
      async getSpeakingTask3Session() {
        return {
          id: sessionId, username: 'catalog-owner', catalog_id: 'retired-speaking-catalog',
          catalog_revision: 1, task_id: 'speaking-pilot-v1.task3.free-time-routines', task_revision: 1,
        };
      },
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/speaking/task-3/sessions/${sessionId}`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'SPEAKING_TASK3_CATALOG_REVISION_MISMATCH');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the public API description publishes safe five-answer task 3 sessions', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const start = specification.indexOf('  /api/v1/speaking/task-3/sessions:');
  const end = specification.indexOf('\n  /api/v1/', start + 1);
  const operation = start < 0 ? '' : specification.slice(start, end < 0 ? undefined : end);

  assert.match(operation, /post:/u);
  assert.match(specification, /\/api\/v1\/speaking\/task-3\/sessions\/\{sessionId\}:/u);
  assert.match(specification, /\/answers\/\{questionNumber\}\/complete:/u);
  assert.match(specification, /SpeakingTask3Session:/u);
  assert.match(specification, /questionSeconds: \{ type: integer, enum: \[40\] \}/u);
  assert.match(specification, /currentQuestion:/u);
  assert.doesNotMatch(operation, /^\s+(?:audio|transcript|score):/gimu);
});

test('task 3 PostgreSQL migration stores five safe answer records and owner-cascades sessions', async () => {
  const migration = await fs.readFile(new URL('../migrations/043_speaking_task3_sessions.sql', import.meta.url), 'utf8');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS speaking_task3_sessions/u);
  assert.match(migration, /REFERENCES users\(username\) ON DELETE CASCADE/u);
  assert.match(migration, /jsonb_array_length\(answers\) = 5/u);
  assert.match(migration, /current_question BETWEEN 1 AND 5/u);
  assert.match(migration, /recordingDurationSeconds/u);
  assert.match(migration, /localPlayback/u);
  assert.match(migration, /selfRating/u);
  assert.doesNotMatch(migration, /\b(?:audio|transcript|score)\b/iu);
});
