import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createSpeakingRoutes } from '../routes/speaking.js';
import { createFileRepository } from '../storage/file-repository.js';
import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';

async function withServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-full-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(8_500_001, 'Full owner');
  const other = await repository.createTelegramUser(8_500_002, 'Full other');
  await repository.grantDays(8_500_001, 30, 'Full owner');
  await repository.grantDays(8_500_002, 30, 'Full other');
  await repository.setSpeakingAccentProfile(owner, { locale: 'en-GB', source: 'manual', now: new Date('2026-08-06T10:00:00.000Z') });
  await repository.setSpeakingAccentProfile(other, { locale: 'en-GB', source: 'manual', now: new Date('2026-08-06T10:00:00.000Z') });
  let now = new Date('2026-08-06T10:00:00.000Z');
  const app = express();
  app.use(express.json());
  app.use(createSpeakingRoutes({
    authentication: { auth(req, _res, next) { req.user = req.get('x-test-user'); next(); } },
    access: { requireActiveSubscription(_req, _res, next) { next(); } },
    db: repository,
    now: () => now,
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: { code: error.code || 'ERROR' } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = (username, pathname, { method = 'GET', body } = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    { method, headers: { 'content-type': 'application/json', 'x-test-user': username },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
  );
  try { await run({ owner, other, repository, request, setNow(value) { now = new Date(value); } }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('full Speaking HTTP lifecycle is owner-bound, revision-pinned, safe before submit and canonically idempotent', async () => {
  await withServer(async ({ owner, other, repository, request }) => {
    const assignedResponse = await request(owner, '/api/v1/speaking/full-sessions', { method: 'POST', body: {} });
    assert.equal(assignedResponse.status, 201);
    let session = await assignedResponse.json();
    assert.equal(session.mode, 'full_section');
    assert.equal(session.maximumScore, 20);
    assert.equal(session.earnedScore, null);
    assert.deepEqual(session.progress.map((item) => item.maximumScore), [1, 4, 5, 10]);
    assert.equal((await request(other, `/api/v1/speaking/full-sessions/${session.id}`)).status, 404);
    assert.equal(/(?:reference|rubric|readyAnswer|analysis|transcript|audio)/iu.test(JSON.stringify(session)), false);
    assert.equal(session.earnedScore, null);

    const expectedResponses = { 1: 1, 2: 4, 3: 5, 4: 1 };
    for (const taskType of [1, 2, 3, 4]) {
      for (let position = 1; position <= expectedResponses[taskType]; position += 1) {
        session = await (await request(owner, `/api/v1/speaking/full-sessions/${session.id}/stage`, {
          method: 'POST', body: {},
        })).json();
        if (session.phase === 'preparing') {
          session = await (await request(owner, `/api/v1/speaking/full-sessions/${session.id}/stage`, {
            method: 'POST', body: {},
          })).json();
        }
        const completed = await request(owner, `/api/v1/speaking/full-sessions/${session.id}/responses`, {
          method: 'POST', body: {
            taskType, responseNumber: position, responseStatus: 'completed',
            recordingDurationSeconds: 10, micCheck: 'passed', localPlayback: false,
          },
        });
        assert.equal(completed.status, 200);
        session = await completed.json();
        if (session.phase !== 'ready_to_submit') {
          assert.equal(/(?:reference|rubric|readyAnswer|analysis|transcript|audio)/iu.test(JSON.stringify(session)), false);
        }
      }
    }
    assert.equal(session.phase, 'ready_to_submit');

    const key = '75500000-0000-4000-8000-000000000001';
    const first = await (await request(owner, `/api/v1/speaking/full-sessions/${session.id}/submit`, {
      method: 'POST', body: { idempotencyKey: key },
    })).json();
    const replay = await (await request(owner, `/api/v1/speaking/full-sessions/${session.id}/submit`, {
      method: 'POST', body: { idempotencyKey: '75500000-0000-4000-8000-000000000002' },
    })).json();
    assert.deepEqual(replay, first);
    assert.equal(first.maximumScore, 20);
    assert.equal(first.earnedScore, null);
    assert.equal(first.assessment.available, false);

    const exported = await repository.exportUserData(owner);
    assert.equal(exported.speaking_full_sessions.length, 1);
    assert.equal(Object.hasOwn(exported.speaking_full_sessions[0], 'username'), false);
    assert.equal(Object.hasOwn(exported.speaking_full_sessions[0], 'submission_key'), false);
    assert.equal(/(?:transcript|audio|rubric|reference)/iu.test(JSON.stringify(exported.speaking_full_sessions)), false);
    assert.equal(await repository.deleteUserData(owner), true);
    assert.equal(await repository.getFullSpeakingSession(owner, session.id), null);
  });
});

test('full Speaking API rejects client task selection, out-of-order responses and premature submit', async () => {
  await withServer(async ({ owner, request }) => {
    assert.equal((await request(owner, '/api/v1/speaking/full-sessions', {
      method: 'POST', body: { tasks: ['client chosen'] },
    })).status, 400);
    const session = await (await request(owner, '/api/v1/speaking/full-sessions', { method: 'POST', body: {} })).json();
    assert.equal((await request(owner, `/api/v1/speaking/full-sessions/${session.id}/submit`, {
      method: 'POST', body: { idempotencyKey: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' },
    })).status, 400);
    assert.equal((await request(owner, `/api/v1/speaking/full-sessions/${session.id}/submit`, {
      method: 'POST', body: { idempotencyKey: '75500000-0000-4000-8000-000000000003' },
    })).status, 409);
    assert.equal((await request(owner, `/api/v1/speaking/full-sessions/${session.id}/responses`, {
      method: 'POST', body: {
        taskType: 2, responseNumber: 1, responseStatus: 'completed', recordingDurationSeconds: 10,
        micCheck: 'passed', localPlayback: false, score: 4,
      },
    })).status, 400);
    await request(owner, `/api/v1/speaking/full-sessions/${session.id}/stage`, { method: 'POST', body: {} });
    await request(owner, `/api/v1/speaking/full-sessions/${session.id}/stage`, { method: 'POST', body: {} });
    assert.equal((await request(owner, `/api/v1/speaking/full-sessions/${session.id}/responses`, {
      method: 'POST', body: {
        taskType: 1, responseNumber: 1, responseStatus: 'completed', recordingDurationSeconds: 100,
        micCheck: 'passed', localPlayback: false,
      },
    })).status, 400);
  });
});

test('full Speaking abandoned pointer returns 404 and assignment recovers with a compatible session', async () => {
  await withServer(async ({ owner, repository, request }) => {
    const stale = await (await request(owner, '/api/v1/speaking/full-sessions', {
      method: 'POST', body: {},
    })).json();
    const revisedCatalogs = structuredClone([
      SPEAKING_TASK1_CATALOG, SPEAKING_TASK2_CATALOG,
      SPEAKING_TASK3_CATALOG, SPEAKING_TASK4_CATALOG,
    ]);
    revisedCatalogs[0].tasks[0].revision += 1;
    revisedCatalogs[0].tasks[1].revision += 1;
    const incompatibleReplacement = await repository.assignFullSpeakingSession(owner, {
      catalogs: revisedCatalogs, now: new Date('2026-08-06T10:01:00.000Z'),
    });

    assert.equal((await request(owner, `/api/v1/speaking/full-sessions/${stale.id}`)).status, 404);
    const recoveredResponse = await request(owner, '/api/v1/speaking/full-sessions', {
      method: 'POST', body: {},
    });
    assert.equal(recoveredResponse.status, 201);
    const recovered = await recoveredResponse.json();
    assert.notEqual(recovered.id, stale.id);
    assert.notEqual(recovered.id, incompatibleReplacement.id);
    assert.equal(recovered.status, 'in_progress');
  });
});

test('full Speaking public contract documents the five owner-bound operations and metadata-only storage', async () => {
  const [specification, migration, database, retention] = await Promise.all([
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../migrations/045_speaking_full_sessions.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATABASE_SCHEMA.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../docs/DATA_RETENTION.md', import.meta.url), 'utf8'),
  ]);
  for (const endpoint of [
    '/api/v1/speaking/full-sessions:',
    '/api/v1/speaking/full-sessions/{sessionId}:',
    '/api/v1/speaking/full-sessions/{sessionId}/stage:',
    '/api/v1/speaking/full-sessions/{sessionId}/responses:',
    '/api/v1/speaking/full-sessions/{sessionId}/submit:',
  ]) assert.match(specification, new RegExp(endpoint.replace(/[{}]/gu, '\\$&'), 'u'));
  assert.match(specification, /SpeakingFullSession:/u);
  assert.match(specification, /SpeakingFullSubmission:/u);
  assert.match(specification, /SpeakingFullTaskResult:[\s\S]*?usedSeconds: \{ type: number, minimum: 0, maximum: 200 \}/u);
  assert.match(specification, /response_timeout/u);
  const completionContract = specification.slice(
    specification.indexOf('SpeakingFullResponseCompletion:'),
    specification.indexOf('SpeakingFullTaskResult:'),
  );
  assert.doesNotMatch(completionContract, /response_timeout/u);
  assert.match(specification, /deferred_to_tickets_06_07/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS speaking_full_sessions/u);
  assert.match(migration, /jsonb_array_length\(assignments\) = 4/u);
  assert.match(migration, /ON DELETE CASCADE/u);
  assert.match(migration, /status IN \('in_progress', 'submitted', 'abandoned'\)/u);
  assert.match(migration, /phase NOT IN \('submitted', 'abandoned'\)/u);
  assert.match(database, /`speaking_full_sessions`/u);
  assert.match(retention, /Полный устный раздел/u);
  assert.match(retention, /audio, transcript, score/u);
});
