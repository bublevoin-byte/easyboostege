import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createProgressRoutes } from '../routes/progress.js';
import { createFileRepository } from '../storage/file-repository.js';

function authentication() {
  return { auth(req, res, next) { req.user = req.headers['x-test-user']; next(); } };
}

async function request(baseUrl, owner, url, body, expectedOwner = owner) {
  const headers = { 'content-type': 'application/json', 'x-test-user': owner };
  if (expectedOwner !== null) headers['x-easyboost-expected-owner'] = expectedOwner;
  const response = await fetch(`${baseUrl}${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    owner: response.headers.get('x-easyboost-response-owner'),
    body: await response.json(),
  };
}

test('grammar mastery API owns time/revision and generic progress cannot forge canonical state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-grammar-mastery-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(8_811_001, 'Grammar API Owner');
  const app = express();
  app.use(express.json());
  app.use(createProgressRoutes({ authentication: authentication(), db: repository }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const event = {
    id: '00000000-0000-4000-8000-000000000011', type: 'session_completed',
    expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false,
    completedTypes: ['choice', 'input', 'correction', 'transform'],
    typeScores: {
      choice: { correct: 4, total: 4 }, input: { correct: 4, total: 4 },
      correction: { correct: 4, total: 4 }, transform: { correct: 4, total: 4 },
    },
  };
  try {
    const missingOwnerRead = await request(baseUrl, owner, '/api/v1/progress', undefined, null);
    assert.equal(missingOwnerRead.status, 400);
    assert.equal(missingOwnerRead.body.error.code, 'EXPECTED_OWNER_REQUIRED');
    const wrongOwnerRead = await request(
      baseUrl, owner, '/api/v1/progress', undefined, 'different-owner',
    );
    assert.equal(wrongOwnerRead.status, 409);
    assert.equal(wrongOwnerRead.body.error.code, 'OWNER_CHANGED');
    const ownerBoundRead = await request(baseUrl, owner, '/api/v1/progress', undefined);
    assert.equal(ownerBoundRead.status, 200);
    assert.equal(ownerBoundRead.owner, owner);

    const wrongOwnerReplace = await request(
      baseUrl, owner, '/api/v1/progress', { learned: 999 }, 'different-owner',
    );
    assert.equal(wrongOwnerReplace.status, 409);
    assert.equal(wrongOwnerReplace.body.error.code, 'OWNER_CHANGED');
    assert.equal((await request(baseUrl, owner, '/api/v1/progress', undefined)).body.learned, undefined);

    const wrongOwnerSingle = await request(
      baseUrl, owner, '/api/v1/grammar/mastery-events', { topicId: 1, event }, 'different-owner',
    );
    assert.equal(wrongOwnerSingle.status, 409);
    assert.equal(wrongOwnerSingle.body.error.code, 'OWNER_CHANGED');
    assert.equal((await request(baseUrl, owner, '/api/v1/progress', undefined)).body.grammarMastery?.['1'], undefined);

    const forged = await request(baseUrl, owner, '/api/v1/progress/modules', {
      owner,
      modules: { grammarMastery: { 1: { masteryVersion: 2, stage: 'stable' } } },
    });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error.reason, 'SERVER_OWNED_GRAMMAR_MASTERY');

    const forgedLegacy = await request(baseUrl, owner, '/api/v1/progress/modules', {
      owner,
      modules: { gram: { 2: {
        masteryVersion: 2, masteryRevision: 99, stage: 'stable', reviewStep: 5,
        eligibleAt: null, typeScores: event.typeScores,
      } } },
    });
    assert.equal(forgedLegacy.status, 200);
    const afterForgedLegacy = await request(baseUrl, owner, '/api/v1/progress', undefined);
    assert.equal(afterForgedLegacy.body.grammarMastery['2'].stage, 'not_started');
    assert.equal(afterForgedLegacy.body.grammarMastery['2'].masteryRevision, 0);

    const wrongOwnerProgress = await request(baseUrl, owner, '/api/v1/progress/modules', {
      owner: 'different-owner', modules: { learned: 999 },
    });
    assert.equal(wrongOwnerProgress.status, 409);
    assert.equal(wrongOwnerProgress.body.error.code, 'OWNER_CHANGED');
    const missingOwnerProgress = await request(baseUrl, owner, '/api/v1/progress/modules', {
      modules: { learned: 999 },
    });
    assert.equal(missingOwnerProgress.status, 400);

    const wrongOwnerAttempt = await request(baseUrl, owner, '/api/v1/module-attempts', {
      owner: 'different-owner', id: '00000000-0000-4000-8000-000000000099',
      module: 'grammar', activity: 'grammar_topic', score: 1, maxScore: 1,
    });
    assert.equal(wrongOwnerAttempt.status, 409);
    assert.equal(wrongOwnerAttempt.body.error.code, 'OWNER_CHANGED');
    const missingOwnerAttempt = await request(baseUrl, owner, '/api/v1/module-attempts', {
      id: '00000000-0000-4000-8000-000000000098',
      module: 'grammar', activity: 'grammar_topic', score: 1, maxScore: 1,
    });
    assert.equal(missingOwnerAttempt.status, 400);

    const clientTimed = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 1, event: { ...event, at: 9_999_999_999_999 },
    });
    assert.equal(clientTimed.status, 400, 'client timestamps are outside the strict contract');

    const failedSessionWithoutReason = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 2,
      event: { ...event, id: '00000000-0000-4000-8000-000000000013',
        typeScores: { ...event.typeScores, choice: { correct: 3, total: 4 } } },
    });
    assert.equal(failedSessionWithoutReason.status, 400, 'independent failure needs one evidenced taxonomy reason');
    const successfulSessionWithReason = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 2,
      event: { ...event, id: '00000000-0000-4000-8000-000000000014', reason: 'auxiliary' },
    });
    assert.equal(successfulSessionWithReason.status, 400, 'successful evidence cannot mint a weakness reason');
    const failedReviewWithoutReason = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 2,
      event: { id: '00000000-0000-4000-8000-000000000015', type: 'review_completed',
        expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
        source: 'builtin', assisted: false, passed: false },
    });
    assert.equal(failedReviewWithoutReason.status, 400, 'failed independent review needs one evidenced reason');
    const passedReviewWithReason = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 2,
      event: { id: '00000000-0000-4000-8000-000000000016', type: 'review_completed',
        expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
        source: 'builtin', assisted: false, passed: true, reason: 'auxiliary' },
    });
    assert.equal(passedReviewWithReason.status, 400, 'passed review cannot carry a failure reason');

    const before = Date.now();
    const accepted = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', { topicId: 1, event });
    const after = Date.now();
    assert.equal(accepted.status, 201);
    assert.equal(accepted.owner, owner);
    assert.equal(accepted.body.applied, true);
    assert.equal(accepted.body.record.masteryRevision, 1);
    assert.ok(accepted.body.record.lastStageAt >= before && accepted.body.record.lastStageAt <= after);
    assert.equal(accepted.body.record.eligibleAt, accepted.body.record.lastStageAt + 86_400_000);

    const replay = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', { topicId: 1, event });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.applied, false);
    assert.equal(replay.body.conflict, false);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.record.masteryRevision, 1);

    const partial = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 3,
      event: {
        ...event,
        id: '00000000-0000-4000-8000-000000000012',
        expectedStage: 'not_started',
        completedTypes: ['choice', 'input'],
        typeScores: { choice: { correct: 3, total: 4 }, input: { correct: 2, total: 3 } },
        reason: 'word_or_verb_form',
      },
    });
    assert.equal(partial.status, 201);
    assert.equal(partial.body.record.stage, 'learning');
    assert.equal(partial.body.record.masteryRevision, 1);
    assert.deepEqual(partial.body.record.stats, {
      correct: 5, errors: 2, advancedStreak: 0, assistedAttempts: 0,
    });
    const persisted = await request(baseUrl, owner, '/api/v1/progress', undefined);
    assert.equal(persisted.body.grammarMastery['3'].stats.correct, 5);

    const batchEvents = [4, 5].map((topicId, index) => ({
      topicId,
      event: {
        ...event,
        id: `00000000-0000-4000-8000-${String(20 + index).padStart(12, '0')}`,
        expectedStage: 'not_started', completedTypes: ['choice'],
        typeScores: { choice: { correct: 1, total: 1 } },
      },
    }));
    const batchId = batchEvents[0].event.id;
    const batch = await request(baseUrl, owner, '/api/v1/grammar/mastery-events/batch', { owner, batchId, events: batchEvents });
    assert.equal(batch.status, 201);
    assert.equal(batch.body.batchId, batchId);
    assert.equal(batch.body.results.length, 2);
    assert.ok(batch.body.results.every((result) => result.applied && result.record.stage === 'learning'));
    const batchReplay = await request(baseUrl, owner, '/api/v1/grammar/mastery-events/batch', { owner, batchId, events: batchEvents });
    assert.equal(batchReplay.status, 200);
    assert.ok(batchReplay.body.results.every((result) => result.replay && !result.conflict));

    const atomicBatch = [6, 7].map((topicId, index) => ({
      topicId,
      event: {
        ...event,
        id: `00000000-0000-4000-8000-${String(30 + index).padStart(12, '0')}`,
        expectedRevision: index,
        expectedStage: 'not_started',
        completedTypes: ['choice'],
        typeScores: { choice: { correct: 1, total: 1 } },
      },
    }));
    const atomicBatchId = atomicBatch[0].event.id;
    const conflict = await request(baseUrl, owner, '/api/v1/grammar/mastery-events/batch', { owner, batchId: atomicBatchId, events: atomicBatch });
    assert.equal(conflict.status, 200);
    assert.ok(conflict.body.results.every((result) => !result.applied));
    const afterConflict = await request(baseUrl, owner, '/api/v1/progress', undefined);
    assert.equal(afterConflict.body.grammarMastery['6'], undefined,
      'one stale event must prevent an unseen sibling event from being committed');

    const duplicate = await request(baseUrl, owner, '/api/v1/grammar/mastery-events/batch', {
      owner, batchId: atomicBatchId, events: [atomicBatch[0], { ...atomicBatch[1], event: { ...atomicBatch[1].event, id: atomicBatch[0].event.id } }],
    });
    assert.equal(duplicate.status, 400);

    const ownerChanged = await request(baseUrl, owner, '/api/v1/grammar/mastery-events/batch', {
      owner: 'different-owner', batchId: atomicBatchId, events: [atomicBatch[0]],
    });
    assert.equal(ownerChanged.status, 409);
    assert.equal(ownerChanged.body.error.code, 'GRAMMAR_MASTERY_OWNER_CHANGED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Grammar mastery OpenAPI documents every runtime score consistency constraint', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  function operationContract(pathname, method) {
    const pathStart = openapi.indexOf(`  ${pathname}:`);
    assert.notEqual(pathStart, -1, `missing OpenAPI path ${pathname}`);
    const nextPath = openapi.indexOf('\n  /api/', pathStart + 1);
    const pathBlock = openapi.slice(pathStart, nextPath === -1 ? openapi.length : nextPath);
    const methodStart = pathBlock.indexOf(`\n    ${method}:`);
    assert.notEqual(methodStart, -1, `missing ${method.toUpperCase()} ${pathname}`);
    const nextMethod = pathBlock.slice(methodStart + 1).search(/\n    [a-z]+:/u);
    return pathBlock.slice(
      methodStart,
      nextMethod === -1 ? pathBlock.length : methodStart + 1 + nextMethod,
    );
  }
  assert.match(openapi, /completedTypes.*exactly one matching typeScores/isu);
  assert.match(openapi, /correct must be less than or equal to total/iu);
  assert.match(openapi, /reason is required exactly when.*unassisted.*wrong/isu);
  assert.match(openapi, /required: \[owner, batchId, events\]/u);
  assert.match(openapi, /GRAMMAR_MASTERY_OWNER_CHANGED/u);
  assert.match(openapi, /Durable caller correlation ID/u);
  assert.equal((openapi.match(/required: \[owner, /gu) || []).length >= 3, true,
    'generic progress and attempt sync requests require the intended owner too');
  assert.equal((openapi.match(/maximum: 9007199254740991/gu) || []).length >= 2, true);
  for (const contract of [
    operationContract('/api/v1/progress', 'get'),
    operationContract('/api/v1/progress', 'post'),
    operationContract('/api/v1/grammar/mastery-events', 'post'),
  ]) {
    assert.match(contract, /#\/components\/parameters\/ExpectedOwner/u);
    assert.match(contract, /#\/components\/headers\/X-EasyBoost-Response-Owner/u);
    assert.match(contract, /OWNER_CHANGED/u);
  }
  assert.doesNotMatch(openapi, /review_error/u);
});
