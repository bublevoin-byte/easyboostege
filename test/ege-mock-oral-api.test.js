import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createEgeMockRoutes } from '../routes/ege-mocks.js';
import { createFileRepository } from '../storage/file-repository.js';
import { EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockForm } from '../ege-mock/catalog.js';

test('oral HTTP stages are owner-bound, replay-safe and observational GET never advances a stage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-oral-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = (await repository.grantDays(9_275_001, 30, 'EGE oral owner')).username;
  let now = new Date('2026-08-15T06:00:00.000Z');
  const app = express();
  app.use(express.json());
  app.use(createEgeMockRoutes({
    authentication: { auth(req, _res, next) { req.user = req.get('x-test-user'); next(); } },
    access: { requireActiveSubscription(_req, _res, next) { next(); } },
    db: repository, now: () => now,
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: { code: error.code } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = (pathname, { method = 'GET', body, key } = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    {
      method,
      headers: {
        'content-type': 'application/json', 'x-test-user': owner,
        'x-easyboost-expected-owner': owner, ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
  try {
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(owner, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: crypto.randomUUID(), requestHash: 'a'.repeat(64),
    }, { now: () => now });
    const written = await repository.submitEgeMockWritten(owner, started.attempt.id, {
      expectedRevision: 0, idempotencyKey: crypto.randomUUID(), requestHash: 'b'.repeat(64),
    }, { now: () => now });
    const oralPath = `/api/v1/ege-mocks/attempts/${started.attempt.id}/oral`;
    const oral = await (await request(`${oralPath}/start`, {
      method: 'POST', key: crypto.randomUUID(), body: { expectedRevision: written.attempt.revision },
    })).json();
    assert.equal(oral.attempt.oralProgress.phase, 'ready');

    const impossibleStage = await request(`${oralPath}/stage`, {
      method: 'POST', key: crypto.randomUUID(), body: {
        action: 'complete', expectedRevision: oral.attempt.revision,
        position: 39, responseNumber: 5,
        recording: {
          recordingId: crypto.randomUUID(), status: 'completed',
          durationSeconds: 180, sha256: 'f'.repeat(64),
        },
      },
    });
    assert.equal(impossibleStage.status, 400,
      'runtime request validation rejects the same impossible task shape as OpenAPI');
    assert.equal((await impossibleStage.json()).error.code, 'VALIDATION_ERROR');

    now = new Date('2026-08-15T06:00:10.000Z');
    const key = crypto.randomUUID();
    const stageBody = {
      action: 'advance', expectedRevision: oral.attempt.revision, position: 39, responseNumber: 1,
    };
    const prepared = await (await request(`${oralPath}/stage`, {
      method: 'POST', key, body: stageBody,
    })).json();
    assert.equal(prepared.attempt.oralProgress.phase, 'preparing');
    const replay = await (await request(`${oralPath}/stage`, {
      method: 'POST', key, body: stageBody,
    })).json();
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.attempt, prepared.attempt);

    const beforeGet = await repository.getEgeMockAttempt(owner, started.attempt.id, { now: () => now });
    const observed = await (await request(`/api/v1/ege-mocks/attempts/${started.attempt.id}`)).json();
    assert.deepEqual(observed.attempt, beforeGet);
    assert.deepEqual(await repository.getEgeMockAttempt(owner, started.attempt.id, { now: () => now }), beforeGet);

    now = new Date('2026-08-15T06:18:00.000Z');
    const forged = await request(`${oralPath}/stage`, {
      method: 'POST', key: crypto.randomUUID(), body: {
        action: 'advance', expectedRevision: prepared.attempt.revision,
        position: 39, responseNumber: 1, observedAt: '2026-08-15T06:01:40.000Z',
      },
    });
    assert.equal(forged.status, 400, 'untrusted client time cannot replay a stage after expiry');
    const expired = await (await request(`/api/v1/ege-mocks/attempts/${started.attempt.id}`)).json();
    assert.equal(expired.attempt.state, 'assessment_pending');
    assert.equal(expired.attempt.oralProgress.recordings['39:1'].technicalIssueCode,
      'oral_deadline_elapsed');
    assert.equal(Object.keys(expired.attempt.oralProgress.recordings).length, 11);
    assert.equal((await repository.getFullSpeakingSession(owner, started.attempt.id)).status, 'submitted');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production routes leave the repository clock authoritative when no test clock is injected', async () => {
  let repositoryOptions = Symbol('not-called');
  const db = {
    async startEgeMockAttempt(_username, _candidate, options) {
      repositoryOptions = options;
      return { created: true, attempt: { id: crypto.randomUUID() } };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createEgeMockRoutes({
    authentication: { auth(req, _res, next) { req.user = 'clock-owner'; next(); } },
    access: { requireActiveSubscription(_req, _res, next) { next(); } },
    db,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/v1/ege-mocks/attempts`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-easyboost-expected-owner': 'clock-owner',
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        }),
      },
    );
    assert.equal(response.status, 201);
    assert.equal(repositoryOptions, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
