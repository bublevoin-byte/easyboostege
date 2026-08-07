import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createSpeakingRoutes } from '../routes/speaking.js';
import { createFileRepository } from '../storage/file-repository.js';

async function withSpeakingServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-task2-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(8_200_001, 'Speaking Two Owner');
  const other = await repository.createTelegramUser(8_200_002, 'Speaking Two Other');
  const expired = await repository.createTelegramUser(8_200_003, 'Speaking Two Expired');
  await repository.grantDays(8_200_001, 30, 'Speaking Two Owner');
  await repository.grantDays(8_200_002, 30, 'Speaking Two Other');
  await repository.setSpeakingAccentProfile(owner, { locale: 'en-GB', source: 'manual', now: new Date('2026-08-06T10:00:00.000Z') });
  await repository.setSpeakingAccentProfile(other, { locale: 'en-GB', source: 'manual', now: new Date('2026-08-06T10:00:00.000Z') });
  let now = new Date('2026-08-06T10:00:00.000Z');

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

const questionMetadata = (duration = 12) => ({
  recordingDurationSeconds: duration,
  localPlayback: true,
  selfRating: 'steady',
});

test('task 2 API owns four sequential question records and restores the current question safely', async () => {
  await withSpeakingServer(async ({ owner, other, expired, request, advanceSeconds }) => {
    assert.equal((await request(expired, '/api/v1/speaking/task-2/sessions', { method: 'POST', body: {} })).status, 403);
    assert.equal((await request(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: { supports: ['client', 'must', 'not', 'choose'] },
    })).status, 400);

    const assignedResponse = await request(owner, '/api/v1/speaking/task-2/sessions', { method: 'POST', body: {} });
    assert.equal(assignedResponse.status, 201);
    const assigned = await assignedResponse.json();
    assert.equal(assigned.task.preparationSeconds, 60);
    assert.equal(assigned.task.questionSeconds, 20);
    assert.equal(assigned.task.maxScore, 4);
    assert.equal(assigned.task.supports.length, 4);
    assert.equal(assigned.currentQuestion, 1);
    assert.equal(assigned.status, 'assigned');
    assert.deepEqual(assigned.questions.map(({ questionNumber, status }) => ({ questionNumber, status })), [
      { questionNumber: 1, status: 'pending' },
      { questionNumber: 2, status: 'pending' },
      { questionNumber: 3, status: 'pending' },
      { questionNumber: 4, status: 'pending' },
    ]);
    assert.deepEqual(assigned.assessment, {
      available: false,
      reason: 'deferred_to_tickets_06_07',
      message: 'Автоматическая оценка появится после подключения и методической проверки в следующих этапах.',
    });
    assert.equal(Object.hasOwn(assigned.task, 'rubric'), false);
    assert.equal(Object.hasOwn(assigned.task, 'reference'), false);

    const foreign = await request(other, `/api/v1/speaking/task-2/sessions/${assigned.id}`);
    assert.equal(foreign.status, 404);
    assert.equal((await request(owner, `/api/v1/speaking/task-2/sessions/${assigned.id}/questions/5/complete`, {
      method: 'POST', body: questionMetadata(),
    })).status, 400);
    assert.equal((await request(owner, `/api/v1/speaking/task-2/sessions/${assigned.id}/questions/2/complete`, {
      method: 'POST', body: questionMetadata(),
    })).status, 409);
    assert.equal((await request(owner, `/api/v1/speaking/task-2/sessions/${assigned.id}/questions/1/complete`, {
      method: 'POST', body: { ...questionMetadata(), audio: 'binary', transcript: 'secret', score: 1 },
    })).status, 400);

    advanceSeconds(12);
    const firstResponse = await request(owner, `/api/v1/speaking/task-2/sessions/${assigned.id}/questions/1/complete`, {
      method: 'POST', body: questionMetadata(),
    });
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.status, 'in_progress');
    assert.equal(first.currentQuestion, 2);
    assert.deepEqual(first.questions[0], {
      questionNumber: 1,
      status: 'completed',
      recordingDurationSeconds: 12,
      localPlayback: true,
      selfRating: 'steady',
      completedAt: '2026-08-06T10:00:12.000Z',
    });
    assert.equal(Object.hasOwn(first.questions[0], 'audio'), false);
    assert.equal(Object.hasOwn(first.questions[0], 'transcript'), false);
    assert.equal(Object.hasOwn(first.questions[0], 'score'), false);

    const recovered = await (await request(owner, `/api/v1/speaking/task-2/sessions/${assigned.id}`)).json();
    assert.equal(recovered.currentQuestion, 2);
    assert.equal(recovered.questions.filter((question) => question.status === 'completed').length, 1);

    for (let questionNumber = 2; questionNumber <= 4; questionNumber += 1) {
      advanceSeconds(questionNumber + 10);
      const response = await request(owner, `/api/v1/speaking/task-2/sessions/${assigned.id}/questions/${questionNumber}/complete`, {
        method: 'POST', body: questionMetadata(questionNumber + 10),
      });
      assert.equal(response.status, 200);
      const session = await response.json();
      assert.equal(session.questions.filter((question) => question.status === 'completed').length, questionNumber);
      assert.equal(session.currentQuestion, Math.min(4, questionNumber + 1));
      assert.equal(session.status, questionNumber === 4 ? 'completed' : 'in_progress');
    }

    const replay = await request(owner, `/api/v1/speaking/task-2/sessions/${assigned.id}/questions/4/complete`, {
      method: 'POST', body: questionMetadata(1),
    });
    assert.equal(replay.status, 200);
    const replayed = await replay.json();
    assert.equal(replayed.questions[3].recordingDurationSeconds, 14);
    assert.equal(replayed.questions.length, 4);
    assert.equal(JSON.stringify(replayed).includes('binary'), false);
    assert.equal(JSON.stringify(replayed).includes('secret'), false);
  });
});

test('task 2 assignment rotates through all 60 server catalog items without client content', async () => {
  await withSpeakingServer(async ({ owner, request }) => {
    const assignments = [];
    for (let index = 0; index < 60; index += 1) {
      const response = await request(owner, '/api/v1/speaking/task-2/sessions', { method: 'POST', body: {} });
      assert.equal(response.status, 201);
      assignments.push(await response.json());
    }
    assert.equal(new Set(assignments.map((session) => session.task.id)).size, 60);
    assert.equal(assignments.every((session) => session.selectionReason === 'unseen'), true);
  });
});

test('task 2 recovery reports an incompatible catalog instead of exposing a broken session', async () => {
  const sessionId = '72200000-0000-4000-8000-000000000099';
  const app = express();
  app.use(express.json());
  app.use(createSpeakingRoutes({
    authentication: { auth(req, _res, next) { req.user = 'catalog-owner'; next(); } },
    access: { requireActiveSubscription(_req, _res, next) { next(); } },
    db: {
      async getSpeakingTask2Session() {
        return {
          id: sessionId, username: 'catalog-owner', catalog_id: 'retired-speaking-catalog',
          catalog_revision: 1, task_id: 'speaking-pilot-v1.task2.weekend-pottery', task_revision: 1,
        };
      },
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/speaking/task-2/sessions/${sessionId}`);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'SPEAKING_TASK2_CATALOG_REVISION_MISMATCH');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the public API description publishes four-question task 2 sessions without audio, transcript or score fields', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const start = specification.indexOf('  /api/v1/speaking/task-2/sessions:');
  const end = specification.indexOf('\n  /api/v1/', start + 1);
  const operation = start < 0 ? '' : specification.slice(start, end < 0 ? undefined : end);

  assert.match(operation, /post:/u);
  assert.match(specification, /\/api\/v1\/speaking\/task-2\/sessions\/\{sessionId\}:/u);
  assert.match(specification, /\/questions\/\{questionNumber\}\/complete:/u);
  assert.match(specification, /SpeakingTask2Session:/u);
  assert.match(specification, /questionSeconds: \{ type: integer, enum: \[20\] \}/u);
  assert.match(specification, /currentQuestion:/u);
  assert.doesNotMatch(operation, /^\s+(?:audio|transcript|score):/gimu);
});

test('task 2 PostgreSQL migration stores four safe question records and owner-cascades sessions', async () => {
  const migration = await fs.readFile(new URL('../migrations/042_speaking_task2_sessions.sql', import.meta.url), 'utf8');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS speaking_task2_sessions/u);
  assert.match(migration, /REFERENCES users\(username\) ON DELETE CASCADE/u);
  assert.match(migration, /jsonb_array_length\(questions\) = 4/u);
  assert.match(migration, /current_question BETWEEN 1 AND 4/u);
  assert.match(migration, /recordingDurationSeconds/u);
  assert.match(migration, /localPlayback/u);
  assert.match(migration, /selfRating/u);
  assert.doesNotMatch(migration, /\b(?:audio|transcript|score)\b/iu);
});
