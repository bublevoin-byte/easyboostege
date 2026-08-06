import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createSpeakingRoutes } from '../routes/speaking.js';
import { createFileRepository } from '../storage/file-repository.js';

async function withSpeakingServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-task1-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(8_100_001, 'Speaking Owner');
  const other = await repository.createTelegramUser(8_100_002, 'Speaking Other');
  const expired = await repository.createTelegramUser(8_100_003, 'Speaking Expired');
  await repository.grantDays(8_100_001, 30, 'Speaking Owner');
  await repository.grantDays(8_100_002, 30, 'Speaking Other');
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
    await run({ owner, other, expired, request, advanceDays(days) {
      now = new Date(now.getTime() + days * 86_400_000);
    } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('task 1 session API assigns server-owned work, isolates owners and rotates unseen, weak, old and due material', async () => {
  await withSpeakingServer(async ({ owner, other, expired, request, advanceDays }) => {
    assert.equal((await request(expired, '/api/v1/speaking/task-1/sessions', { method: 'POST', body: {} })).status, 403);
    assert.equal((await request(owner, '/api/v1/speaking/task-1/sessions/not-a-uuid')).status, 400);
    assert.equal((await request(owner, '/api/v1/speaking/task-1/sessions/not-a-uuid/complete', {
      method: 'POST',
      body: { recordingDurationSeconds: 72, micCheck: 'passed', localPlayback: true, selfRating: 'steady' },
    })).status, 400);

    const assigned = [];
    for (let index = 0; index < 60; index += 1) {
      const response = await request(owner, '/api/v1/speaking/task-1/sessions', { method: 'POST', body: {} });
      assert.equal(response.status, 201);
      const session = await response.json();
      assigned.push(session);
      assert.equal(session.selectionReason, 'unseen');
      assert.equal(session.task.preparationSeconds, 90);
      assert.equal(session.task.responseSeconds, 90);
      assert.equal(session.task.maxScore, 1);
      assert.deepEqual(session.pronunciationAssessment, {
        available: false,
        reason: 'provider_not_connected',
        message: 'Оценка произношения пока не подключена.',
      });
      assert.equal(Object.hasOwn(session.task, 'reference'), false);
      assert.equal(Object.hasOwn(session.task, 'provenance'), false);

      const completed = await request(owner, `/api/v1/speaking/task-1/sessions/${session.id}/complete`, {
        method: 'POST',
        body: {
          recordingDurationSeconds: 72,
          micCheck: 'passed',
          localPlayback: true,
          selfRating: index < 2 ? 'weak' : 'strong',
        },
      });
      assert.equal(completed.status, 200);
      const publicSession = await completed.json();
      assert.equal(publicSession.status, 'completed');
      assert.deepEqual(publicSession.practice, {
        recordingDurationSeconds: 72,
        micCheck: 'passed',
        localPlayback: true,
        selfRating: index < 2 ? 'weak' : 'strong',
      });
      assert.equal(Object.hasOwn(publicSession, 'username'), false);
      assert.equal(Object.hasOwn(publicSession, 'audio'), false);
      assert.equal(Object.hasOwn(publicSession, 'transcript'), false);
    }
    assert.equal(new Set(assigned.map((session) => session.task.id)).size, 60);

    const foreign = await request(other, `/api/v1/speaking/task-1/sessions/${assigned[0].id}`);
    assert.equal(foreign.status, 404);
    const injection = await request(owner, `/api/v1/speaking/task-1/sessions/${assigned[0].id}/complete`, {
      method: 'POST',
      body: {
        recordingDurationSeconds: 72, micCheck: 'passed', localPlayback: true,
        selfRating: 'weak', audio: 'not allowed', score: 1,
      },
    });
    assert.equal(injection.status, 400);

    const weak = await (await request(owner, '/api/v1/speaking/task-1/sessions', { method: 'POST', body: {} })).json();
    assert.equal(weak.selectionReason, 'weak');
    assert.notEqual(weak.task.id, assigned.at(-1).task.id);
    await request(owner, `/api/v1/speaking/task-1/sessions/${weak.id}/complete`, {
      method: 'POST',
      body: { recordingDurationSeconds: 80, micCheck: 'passed', localPlayback: true, selfRating: 'strong' },
    });

    const secondWeak = await (await request(owner, '/api/v1/speaking/task-1/sessions', { method: 'POST', body: {} })).json();
    assert.equal(secondWeak.selectionReason, 'weak');
    assert.notEqual(secondWeak.task.id, weak.task.id);
    await request(owner, `/api/v1/speaking/task-1/sessions/${secondWeak.id}/complete`, {
      method: 'POST',
      body: { recordingDurationSeconds: 80, micCheck: 'passed', localPlayback: true, selfRating: 'weak' },
    });

    const old = await (await request(owner, '/api/v1/speaking/task-1/sessions', { method: 'POST', body: {} })).json();
    assert.equal(old.selectionReason, 'old');
    assert.notEqual(old.task.id, secondWeak.task.id);

    advanceDays(15);
    const due = await (await request(owner, '/api/v1/speaking/task-1/sessions', { method: 'POST', body: {} })).json();
    assert.equal(due.selectionReason, 'due');
    assert.notEqual(due.task.id, old.task.id);
  });
});

test('the public API description publishes the task 1 session contract without audio or transcript fields', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const start = specification.indexOf('  /api/v1/speaking/task-1/sessions:');
  const end = specification.indexOf('\n  /api/v1/', start + 1);
  const operation = start < 0 ? '' : specification.slice(start, end < 0 ? undefined : end);

  assert.match(operation, /post:/u);
  assert.match(specification, /\/api\/v1\/speaking\/task-1\/sessions\/\{sessionId\}:/u);
  assert.match(specification, /\/api\/v1\/speaking\/task-1\/sessions\/\{sessionId\}\/complete:/u);
  assert.match(specification, /SpeakingTask1Session:/u);
  assert.match(specification, /id: \{ type: string, enum: \[speaking-pilot-v1\] \}/u);
  assert.match(specification, /provider_not_connected/u);
  assert.doesNotMatch(operation, /^\s+(?:audio|transcript):/gimu);
});
