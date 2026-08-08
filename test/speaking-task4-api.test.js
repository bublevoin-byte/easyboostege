import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createSpeakingRoutes } from '../routes/speaking.js';
import { createFileRepository } from '../storage/file-repository.js';

async function withSpeakingServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-task4-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(8_400_001, 'Speaking Four Owner');
  const other = await repository.createTelegramUser(8_400_002, 'Speaking Four Other');
  const expired = await repository.createTelegramUser(8_400_003, 'Speaking Four Expired');
  await repository.grantDays(8_400_001, 30, 'Speaking Four Owner');
  await repository.grantDays(8_400_002, 30, 'Speaking Four Other');
  await repository.setSpeakingAccentProfile(owner, { locale: 'en-GB', source: 'manual', now: new Date('2026-08-06T14:00:00.000Z') });
  await repository.setSpeakingAccentProfile(other, { locale: 'en-GB', source: 'manual', now: new Date('2026-08-06T14:00:00.000Z') });
  let now = new Date('2026-08-06T14:00:00.000Z');
  const app = express();
  app.use(express.json());
  app.use(createSpeakingRoutes({
    authentication: { auth(req, res, next) {
      const username = req.get('x-test-user');
      if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      req.user = username;
      return next();
    } },
    access: { async requireActiveSubscription(req, res, next) {
      if ((await repository.getSub(req.user)).active) return next();
      return res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED' } });
    } },
    db: repository,
    now: () => now,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = (username, pathname, { method = 'GET', body } = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    { method, headers: { 'content-type': 'application/json', 'x-test-user': username },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  );
  try {
    await run({ owner, other, expired, request, advance(seconds) {
      now = new Date(now.getTime() + seconds * 1_000);
    } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('task 4 API assigns, restores and completes an owner-bound local-only photo project', async () => {
  await withSpeakingServer(async ({ owner, other, expired, request, advance }) => {
    assert.equal((await request(expired, '/api/v1/speaking/task-4/sessions', { method: 'POST', body: {} })).status, 403);
    assert.equal((await request(owner, '/api/v1/speaking/task-4/sessions', {
      method: 'POST', body: { photoPair: { src: 'client-must-not-choose.png' } },
    })).status, 400);
    const assignedResponse = await request(owner, '/api/v1/speaking/task-4/sessions', { method: 'POST', body: {} });
    assert.equal(assignedResponse.status, 201);
    const assigned = await assignedResponse.json();
    assert.equal(assigned.task.preparationSeconds, 150);
    assert.equal(assigned.task.responseSeconds, 180);
    assert.equal(assigned.task.maxScore, 10);
    assert.equal(assigned.task.plan.length, 4);
    assert.match(assigned.task.photoPair.src, /^\/assets\/speaking\/task4-v1\/[a-z0-9-]+\.png$/u);
    assert.equal(assigned.task.photoPair.panels.length, 2);
    assert.equal(Object.hasOwn(assigned.task, 'rubric'), false);
    assert.equal(Object.hasOwn(assigned.task, 'provenance'), false);
    assert.deepEqual(assigned.assessment, {
      available: false,
      reason: 'not_requested',
      message: 'Automatic training assessment is a separate action after local recording.',
    });

    assert.equal((await request(other, `/api/v1/speaking/task-4/sessions/${assigned.id}`)).status, 404);
    const restored = await (await request(owner, `/api/v1/speaking/task-4/sessions/${assigned.id}`)).json();
    assert.equal(restored.task.id, assigned.task.id);
    assert.equal((await request(owner, `/api/v1/speaking/task-4/sessions/${assigned.id}/complete`, {
      method: 'POST', body: { recordingDurationSeconds: 171, micCheck: 'passed', localPlayback: true,
        selfRating: 'steady', audio: 'binary', transcript: 'secret', score: 10 },
    })).status, 400);

    advance(171);
    const completedResponse = await request(owner, `/api/v1/speaking/task-4/sessions/${assigned.id}/complete`, {
      method: 'POST', body: { recordingDurationSeconds: 171, micCheck: 'passed', localPlayback: true,
        selfRating: 'steady' },
    });
    assert.equal(completedResponse.status, 200);
    const completed = await completedResponse.json();
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.practice, {
      recordingDurationSeconds: 171, micCheck: 'passed', localPlayback: true, selfRating: 'steady',
    });
    assert.equal(/(?:audio|transcript|score)/iu.test(JSON.stringify(completed.practice)), false);
  });
});

test('task 4 rotates all 60 server-owned photo projects', async () => {
  await withSpeakingServer(async ({ owner, request }) => {
    const assignments = [];
    for (let index = 0; index < 60; index += 1) {
      const response = await request(owner, '/api/v1/speaking/task-4/sessions', { method: 'POST', body: {} });
      assert.equal(response.status, 201);
      assignments.push(await response.json());
    }
    assert.equal(new Set(assignments.map((session) => session.task.id)).size, 60);
    assert.equal(assignments.every((session) => session.selectionReason === 'unseen'), true);
  });
});

test('task 4 API description and migration publish only safe local-audio metadata', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const migration = await fs.readFile(new URL('../migrations/044_speaking_task4_sessions.sql', import.meta.url), 'utf8');
  const taskSchema = specification.split('    SpeakingTask4Task:')[1]
    .split('    SpeakingTask4Completion:')[0];
  assert.match(specification, /\/api\/v1\/speaking\/task-4\/sessions:/u);
  assert.match(specification, /SpeakingTask4Session:/u);
  assert.match(specification, /preparationSeconds: \{ type: integer, enum: \[150\] \}/u);
  assert.match(specification, /responseSeconds: \{ type: integer, enum: \[180\] \}/u);
  assert.match(taskSchema, /topic: \{ type: string, minLength: 3, maxLength: 100 \}/u);
  assert.match(taskSchema, /projectTitle: \{ type: string, minLength: 8, maxLength: 120 \}/u);
  assert.match(taskSchema, /alt: \{ type: string, minLength: 20, maxLength: 260 \}/u);
  assert.match(taskSchema, /required: \[number, alt\]/u);
  assert.match(taskSchema, /number: \{ type: integer, enum: \[1, 2\] \}/u);
  assert.doesNotMatch(taskSchema, /required: \[position, alt\]|position: \{/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS speaking_task4_sessions/u);
  assert.match(migration, /REFERENCES users\(username\) ON DELETE CASCADE/u);
  assert.match(migration, /recording_duration_seconds BETWEEN 1 AND 180/u);
  assert.doesNotMatch(migration, /\b(?:audio|transcript|score)\b/iu);
});
