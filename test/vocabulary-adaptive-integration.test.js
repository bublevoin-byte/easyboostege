import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createAdaptiveLearningRoutes } from '../routes/adaptive-learning.js';
import { createProgressRoutes } from '../routes/progress.js';
import { createFileRepository } from '../storage/file-repository.js';

const NOW = new Date('2026-08-05T10:00:00.000Z');

function authentication() {
  return { auth(req, res, next) {
    const username = String(req.headers['x-test-user'] || '');
    if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
    req.user = username;
    return next();
  } };
}

async function withApp(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-vocabulary-adaptive-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const { username: owner } = await repository.createUser('vocabulary-owner', 'hash');
  const { username: stranger } = await repository.createUser('vocabulary-stranger', 'hash');
  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({ authentication: authentication(), db: repository, now: () => NOW }));
  app.use(createAdaptiveLearningRoutes({
    authentication: authentication(), db: repository, enabled: true, now: () => NOW,
    executionTokenSecret: 'vocabulary-adaptive-test-secret-32-characters',
  }));
  app.use((error, req, res, next) => res.status(500).json({
    error: { code: error?.code || error?.message || 'INTERNAL_ERROR' },
  }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = (username, pathname, options = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    { ...options,
      body: pathname === '/api/v1/module-attempts' && options.body
        ? JSON.stringify({ owner: username, ...JSON.parse(options.body) }) : options.body,
      headers: {
      'Content-Type': 'application/json', 'X-Test-User': username,
      'X-EasyBoost-Expected-Owner': username, ...(options.headers || {}),
    } },
  );
  try { await run({ owner, stranger, repository, request }); }
  finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function summaryAttempt() {
  return {
    id: '10000000-0000-4000-8000-000000000005',
    module: 'vocabulary', activity: 'vocabulary_active_recall_session',
    score: 2, maxScore: 3, durationMs: 93_000,
    metadata: {
      summaryVersion: 'vocabulary-session-summary-v1',
      objectiveEvidence: 'objective', objectiveAttempts: 3, objectiveCorrect: 2,
      guidedEvidence: 'guided', guidedAttempts: 1, guidedCorrect: 1,
      selfReportedEvidence: 'self_reported', selfReportedAttempts: 1, selfReportedKnown: 1,
      receptiveAttempts: 1, receptiveCorrect: 1,
      productionAttempts: 1, productionCorrect: 1,
      contextAttempts: 1, contextCorrect: 0,
      listeningAttempts: 1, listeningCorrect: 1,
      errors: 1,
    },
  };
}

test('ordinary vocabulary summary is idempotent, owner-bound and never trusted as mastery', async () => {
  await withApp(async ({ owner, stranger, repository, request }) => {
    const attempt = summaryAttempt();
    const first = await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify(attempt),
    });
    assert.equal(first.status, 201);
    assert.equal((await first.json()).created, true);

    const replay = await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify(attempt),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).created, false);

    const conflictingReplay = await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        ...attempt, score: 3,
        metadata: {
          ...attempt.metadata, objectiveCorrect: 3, contextCorrect: 1,
        },
      }),
    });
    assert.equal(conflictingReplay.status, 200);
    assert.equal((await conflictingReplay.json()).created, false);

    const corrupted = await request(owner, '/api/v1/module-attempts', {
      method: 'POST', body: JSON.stringify({
        ...attempt, score: 3,
        metadata: { ...attempt.metadata, selfReportedKnown: 1_000 },
      }),
    });
    assert.equal(corrupted.status, 400);

    const sources = await repository.getAdaptiveLearningEvidenceSources(owner);
    assert.equal(sources.attempts.length, 1);
    assert.equal(sources.attempts[0].evidence_quality, 'client_reported');
    assert.equal(sources.attempts[0].metadata.objectiveCorrect, 2);
    assert.equal(sources.attempts[0].metadata.selfReportedKnown, 1);

    const overview = await (await request(owner, '/api/v1/adaptive-learning/overview')).json();
    const vocabulary = overview.profile.skills.find((skill) => (
      skill.id === 'ege.vocabulary.lexical_choice'
    ));
    assert.equal(vocabulary.evidenceCount, 1);
    assert.equal(vocabulary.independentEvidenceCount, 0);
    assert.equal(vocabulary.evidenceQuality, 'client_reported');
    assert.equal(vocabulary.status, 'preliminary');
    assert.ok(vocabulary.mastery <= 49);
    assert.equal(overview.profile.independentEvidenceCount, 0);

    const strangerOverview = await (await request(stranger, '/api/v1/adaptive-learning/overview')).json();
    assert.equal(strangerOverview.profile.evidenceCount, 0);
  });
});
