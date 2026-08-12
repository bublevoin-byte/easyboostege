import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createProgressRoutes } from '../routes/progress.js';
import { createFileRepository } from '../storage/file-repository.js';
import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';
import { GRAMMAR_ACTIVE_TOPIC_IDS } from '../public/grammar-domain-contract.js';
import { EasyBoostGrammar } from '../public/modules/grammar.js';
import { grammarMasteryEventSchema } from '../validation/grammar-mastery.js';
import { decorateGeneratedVoiceTutorContent } from '../voice-tutor/generated-items.js';
import { compileOpenApiSchema } from './support/openapi-schema-evaluator.js';

function authentication() {
  return { auth(req, res, next) { req.user = req.headers['x-test-user']; next(); } };
}

function practiceSession(id, { topicId = 1, typeScores = null, assisted = false, ...overrides } = {}) {
  const kinds = { choice: 'c', input: 'f', correction: 'correction', transform: 'transform' };
  const scores = typeScores || {
    choice: { correct: 4, total: 4 }, input: { correct: 4, total: 4 },
    correction: { correct: 4, total: 4 }, transform: { correct: 4, total: 4 },
  };
  return {
    id, scope: 'topic', mode: GRAMMAR_ACTIVE_TOPIC_IDS.includes(topicId) ? 'topic_practice' : 'legacy_practice', source: 'builtin',
    catalog: { version: 'grammar-core-v2', revision: 2 },
    items: Object.entries(scores).flatMap(([type, score]) => {
      const catalog = GRAMMAR_CATALOG.bank[topicId][kinds[type]];
      const originals = GRAMMAR_ACTIVE_TOPIC_IDS.includes(topicId)
        ? [...new Map(catalog.map((item) => [item.transferPair, item])).values()]
        : catalog;
      return originals.slice(0, score.total).map((item, index) => {
        const correct = index < score.correct;
        const diagnostic = !correct && type === 'choice' ? item.diagnostics.find(Boolean) : null;
        return {
          id: item.id, type, transfer: false, correct,
          diagnosticId: diagnostic?.id || null,
          errorCode: correct ? null : (diagnostic?.errorCode || item.errorSkill),
          confusionPair: correct ? null : (diagnostic?.confusionPair || item.confusionPair || null),
          transferStatus: null,
        };
      });
    }),
    startedAt: 1_000, assisted,
    ...overrides,
  };
}

function addCorrectTransfers(session, topicId) {
  const kinds = { choice: 'c', input: 'f', correction: 'correction', transform: 'transform' };
  for (let index = 0; index < session.items.length; index += 1) {
    const outcome = session.items[index];
    if (outcome.transfer || outcome.correct) continue;
    const catalog = GRAMMAR_CATALOG.bank[topicId][kinds[outcome.type]];
    const original = catalog.find((item) => item.id === outcome.id);
    const transfer = catalog.find((item) => item.id !== original.id && item.transferPair === original.transferPair);
    session.items.splice(index + 1, 0, {
      id: transfer.id, type: outcome.type, transfer: true, correct: true,
      diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    });
    index += 1;
  }
  return session;
}

function scoresFromSession(session) {
  return Object.fromEntries(['choice', 'input', 'correction', 'transform'].map((type) => {
    const outcomes = session.items.filter((item) => item.type === type);
    return [type, { correct: outcomes.filter((item) => item.correct).length, total: outcomes.length }];
  }));
}

function independentChoiceError(topicId, item = GRAMMAR_CATALOG.bank[topicId].c[0]) {
  const diagnostic = item.diagnostics.find((candidate, index) => index !== item.a && candidate);
  return {
    itemId: item.id,
    diagnosticId: diagnostic.id,
    reason: diagnostic.errorCode,
    confusionPair: diagnostic.confusionPair || null,
  };
}

function legacyPracticeEvent(id, topicId = 10) {
  const queue = EasyBoostGrammar.buildTopicQueue(GRAMMAR_CATALOG.bank[topicId], topicId, () => 0.5);
  const items = queue.map((item) => ({
    id: item.q.id, type: item.q.type, transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  }));
  const typeScores = Object.fromEntries(['choice', 'input'].map((type) => {
    const total = items.filter((item) => item.type === type).length;
    return [type, { correct: total, total }];
  }).filter(([, score]) => score.total > 0));
  return {
    id, type: 'session_completed', expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false, completedTypes: Object.keys(typeScores), typeScores,
    session: {
      id, scope: 'topic', mode: 'legacy_practice', source: 'builtin',
      catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
      items, startedAt: 1_000, assisted: false,
    },
  };
}

function assistedLegacyPracticeEvent(id, topicId = 10) {
  const event = legacyPracticeEvent(id, topicId);
  const failed = event.session.items[0];
  failed.correct = false;
  failed.errorCode = failed.type === 'input' ? 'word_or_verb_form' : 'construction_choice';
  event.session.items.splice(1, 0, {
    ...failed, correct: true, errorCode: null,
  });
  const score = event.typeScores[failed.type];
  score.total += 1;
  event.assisted = true;
  event.session.assisted = true;
  return event;
}

function generatedGrammarFixture() {
  const requestHash = 'c'.repeat(64);
  const result = {
    c: Array.from({ length: 3 }, (_, index) => ({
      t: [`Generated choice ${index + 1}: She `, ' every day.'],
      o: ['go', 'goes', 'going', 'went'], a: 1, e: 'Present Simple.',
    })),
    f: Array.from({ length: 3 }, (_, index) => ({
      s: `Generated input ${index + 1}: She _____ (GO) every day.`,
      b: 'GO', ans: ['goes'], e: 'Third person singular.',
    })),
  };
  return {
    requestHash,
    request: { operation: 'grammar_topic_set', topicId: 5, topic: 'Generated legacy topic' },
    result,
    decorated: decorateGeneratedVoiceTutorContent('grammar_topic_set', requestHash, result),
  };
}

function generatedGrammarEvent(id, fixture) {
  return {
    id, type: 'session_completed', expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'generated', assisted: true, completedTypes: ['choice'],
    typeScores: { choice: { correct: 1, total: 1 } },
    session: {
      id, scope: 'topic', mode: 'legacy_practice', source: 'generated',
      catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
      items: [{
        id: fixture.decorated.c[0].voice.id, type: 'choice', transfer: false, correct: true,
        diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
        source: 'generated', revision: 1,
      }],
      startedAt: 1_000, assisted: true,
    },
  };
}

test('active mastery requires exact four-type declarations while legacy practice stays partial', () => {
  const id = '00000000-0000-4000-8000-000000000010';
  const session = practiceSession(id);
  const event = {
    id, type: 'session_completed', expectedRevision: 0,
    expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false,
    completedTypes: ['choice'],
    typeScores: { choice: { correct: 4, total: 4 } },
    session,
  };
  const incomplete = grammarMasteryEventSchema.safeParse({ topicId: 1, event });
  assert.equal(incomplete.success, false,
    'active outcomes of input/correction/transform cannot bypass canonical score accounting');

  const allTypeScores = scoresFromSession(session);
  const complete = grammarMasteryEventSchema.safeParse({
    topicId: 1,
    event: {
      ...event,
      completedTypes: ['choice', 'input', 'correction', 'transform'],
      typeScores: allTypeScores,
    },
  });
  assert.equal(complete.success, true);

  const extraScore = grammarMasteryEventSchema.safeParse({
    topicId: 1,
    event: {
      ...complete.data.event,
      typeScores: { ...allTypeScores, review: { correct: 1, total: 1 } },
    },
  });
  assert.equal(extraScore.success, false, 'unknown score keys are rejected before mastery reduction');

  const mismatchedScore = grammarMasteryEventSchema.safeParse({
    topicId: 1,
    event: {
      ...complete.data.event,
      typeScores: { ...allTypeScores, transform: { correct: 3, total: 3 } },
    },
  });
  assert.equal(mismatchedScore.success, false,
    'declared active scores must exactly match every canonical outcome before mastery reduction');

  const legacy = legacyPracticeEvent('00000000-0000-4000-8000-000000000019');
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 10, event: legacy }).success, true,
    'legacy practice keeps its truthful partial choice/input declaration');
  const omittedOutcomeType = structuredClone(legacy);
  omittedOutcomeType.completedTypes = ['choice'];
  omittedOutcomeType.typeScores = { choice: legacy.typeScores.choice };
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 10, event: omittedOutcomeType }).success, false,
    'legacy declarations must cover every distinct type that produced an outcome');
});

test('catalog-bound independent errors can regress after disclosure without authorizing advancement', () => {
  const activeId = '00000000-0000-4000-8000-000000000017';
  const activeSession = addCorrectTransfers(practiceSession(activeId, {
    topicId: 1,
    typeScores: {
      choice: { correct: 3, total: 4 }, input: { correct: 4, total: 4 },
      correction: { correct: 4, total: 4 }, transform: { correct: 4, total: 4 },
    },
    assisted: true,
  }), 1);
  const wrong = activeSession.items.find((item) => !item.correct && !item.transfer);
  const activeEvent = {
    id: activeId, type: 'session_completed', expectedRevision: 9,
    expectedStage: 'stable', expectedReviewStep: 5,
    source: 'builtin', assisted: true,
    completedTypes: ['choice', 'input', 'correction', 'transform'],
    typeScores: scoresFromSession(activeSession), session: activeSession,
    independentError: {
      itemId: wrong.id, diagnosticId: wrong.diagnosticId,
      reason: wrong.errorCode, confusionPair: wrong.confusionPair,
    },
  };
  const parsedActive = grammarMasteryEventSchema.safeParse({ topicId: 1, event: activeEvent });
  assert.equal(parsedActive.success, true, JSON.stringify(parsedActive.error?.issues));
  const regressedActive = EasyBoostGrammar.reduceMastery({
    masteryVersion: 2, masteryRevision: 9, stage: 'stable', reviewStep: 5,
    highestReviewStep: 5, eligibleAt: null,
  }, parsedActive.data.event, { now: 20_000, clockAuthority: 'server' });
  assert.equal(regressedActive.stage, 'confirmed');
  assert.equal(regressedActive.reviewStep, 4);
  assert.equal(regressedActive.lastRegressionReason, wrong.errorCode);
  assert.equal(regressedActive.masteryHistory.at(-1).outcome, 'regressed');

  const reviewEvidence = independentChoiceError(1);
  const reviewEvent = {
    id: '00000000-0000-4000-8000-000000000018', type: 'review_completed',
    expectedRevision: 4, expectedStage: 'confirmed', expectedReviewStep: 3,
    source: 'builtin', assisted: true, passed: false, independentError: reviewEvidence,
  };
  const parsedReview = grammarMasteryEventSchema.safeParse({ topicId: 1, event: reviewEvent });
  assert.equal(parsedReview.success, true, JSON.stringify(parsedReview.error?.issues));
  const regressedReview = EasyBoostGrammar.reduceMastery({
    masteryVersion: 2, masteryRevision: 4, stage: 'confirmed', reviewStep: 3,
    highestReviewStep: 3, eligibleAt: 1,
  }, parsedReview.data.event, { now: 20_000, clockAuthority: 'server' });
  assert.equal(regressedReview.stage, 'learned');
  assert.equal(regressedReview.lastRegressionReason, reviewEvidence.reason);

  const forged = structuredClone(reviewEvent);
  forged.independentError.reason = reviewEvidence.reason === 'agreement' ? 'auxiliary' : 'agreement';
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 1, event: forged }).success, false,
    'the client cannot choose a weakness that is not bound to the exact catalog pointer');
});

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
    session: practiceSession('00000000-0000-4000-8000-000000000011'),
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

    const lateErrorOwner = await repository.createTelegramUser(8_811_002, 'Grammar Late Error Owner');
    await repository.saveProgress(lateErrorOwner, { gram: { 1: { st: 2, due: 1 } } });
    const lateBefore = await request(baseUrl, lateErrorOwner, '/api/v1/progress', undefined);
    const lateEvidence = independentChoiceError(1);
    const lateError = await request(baseUrl, lateErrorOwner, '/api/v1/grammar/mastery-events', {
      topicId: 1,
      event: {
        id: '00000000-0000-4000-8000-000000000019', type: 'review_completed',
        expectedRevision: lateBefore.body.grammarMastery['1'].masteryRevision,
        expectedStage: lateBefore.body.grammarMastery['1'].stage,
        expectedReviewStep: lateBefore.body.grammarMastery['1'].reviewStep,
        source: 'builtin', assisted: true, passed: false, independentError: lateEvidence,
      },
    });
    assert.equal(lateError.status, 201, JSON.stringify(lateError.body));
    assert.equal(lateError.body.record.stage, 'learned');
    assert.equal(lateError.body.record.lastRegressionReason, lateEvidence.reason);
    assert.ok(lateError.body.record.eligibleAt >= lateBefore.body.grammarMastery['1'].eligibleAt,
      'a late independently committed error remains due after subsequent disclosure');

    const legacyOwner = await repository.createTelegramUser(8_811_003, 'Grammar Legacy Owner');
    const legacyEvent = legacyPracticeEvent('00000000-0000-4000-8000-000000000020');
    const legacyAccepted = await request(baseUrl, legacyOwner, '/api/v1/grammar/mastery-events', {
      topicId: 10, event: legacyEvent,
    });
    assert.equal(legacyAccepted.status, 201, JSON.stringify(legacyAccepted.body));
    assert.equal(legacyAccepted.body.record.stage, 'learning',
      'a clean choice/input legacy run records partial evidence without false learned mastery');
    assert.deepEqual(legacyAccepted.body.record.masteryHistory.at(-1).session.items, legacyEvent.session.items);
    const legacyReplay = await request(baseUrl, legacyOwner, '/api/v1/grammar/mastery-events', {
      topicId: 10, event: legacyEvent,
    });
    assert.equal(legacyReplay.status, 200);
    assert.equal(legacyReplay.body.replay, true);
    assert.equal(legacyReplay.body.record.masteryHistory.length, 1);
    const changedLegacyEvent = structuredClone(legacyEvent);
    changedLegacyEvent.session.startedAt += 1;
    const legacyConflict = await request(baseUrl, legacyOwner, '/api/v1/grammar/mastery-events', {
      topicId: 10, event: changedLegacyEvent,
    });
    assert.equal(legacyConflict.status, 200);
    assert.equal(legacyConflict.body.replay, false);
    assert.equal(legacyConflict.body.conflict, true,
      'a legacy completion UUID with changed material conflicts instead of duplicating history');
    assert.equal(legacyConflict.body.record.masteryHistory.length, 1);

    const legacyWrongOwner = await repository.createTelegramUser(8_811_004, 'Grammar Legacy Assisted Owner');
    const legacyWrong = assistedLegacyPracticeEvent('00000000-0000-4000-8000-000000000021');
    const invalidLegacyWrong = structuredClone(legacyWrong);
    invalidLegacyWrong.id = '00000000-0000-4000-8000-000000000022';
    invalidLegacyWrong.session.id = invalidLegacyWrong.id;
    invalidLegacyWrong.session.items[0].errorCode = 'word_order';
    assert.equal((await request(baseUrl, legacyWrongOwner, '/api/v1/grammar/mastery-events', {
      topicId: 10, event: invalidLegacyWrong,
    })).status, 400, 'legacy errors must match the catalog item and cannot claim an unrelated weakness');
    const legacyWrongAccepted = await request(baseUrl, legacyWrongOwner, '/api/v1/grammar/mastery-events', {
      topicId: 10, event: legacyWrong,
    });
    assert.equal(legacyWrongAccepted.status, 201, JSON.stringify(legacyWrongAccepted.body));
    assert.equal(legacyWrongAccepted.body.record.stage, 'not_started');
    assert.deepEqual(legacyWrongAccepted.body.record.masteryHistory.at(-1).session.items,
      legacyWrong.session.items, 'the repeated legacy retry remains ordered canonical evidence');
    const legacyWrongReplay = await request(baseUrl, legacyWrongOwner, '/api/v1/grammar/mastery-events', {
      topicId: 10, event: legacyWrong,
    });
    assert.equal(legacyWrongReplay.status, 200);
    assert.equal(legacyWrongReplay.body.replay, true);
    assert.equal(legacyWrongReplay.body.record.masteryHistory.length, 1);

    const generatedOwner = await repository.createTelegramUser(8_811_005, 'Grammar Generated Owner');
    const generated = generatedGrammarFixture();
    await repository.saveGeneratedTask(generatedOwner, {
      operation: 'grammar_topic_set', requestHash: generated.requestHash,
      request: generated.request, result: generated.result, provider: 'fixture', promptVersion: 'fixture-v1',
    });
    const generatedEvent = generatedGrammarEvent('00000000-0000-4000-8000-000000000023', generated);
    assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 5, event: generatedEvent }).success, true);
    const unassistedGenerated = structuredClone(generatedEvent);
    unassistedGenerated.assisted = false;
    unassistedGenerated.session.assisted = false;
    assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 5, event: unassistedGenerated }).success, false,
      'generated participation cannot masquerade as independent mastery evidence');
    const unversionedGenerated = structuredClone(generatedEvent);
    delete unversionedGenerated.session.items[0].revision;
    assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 5, event: unversionedGenerated }).success, false,
      'a generated pointer requires its exact item revision and provenance');
    const generatedAccepted = await request(baseUrl, generatedOwner, '/api/v1/grammar/mastery-events', {
      topicId: 5, event: generatedEvent,
    });
    assert.equal(generatedAccepted.status, 201, JSON.stringify(generatedAccepted.body));
    assert.equal(generatedAccepted.body.record.stage, 'not_started',
      'server-addressable generated participation remains assisted and cannot advance mastery');
    assert.deepEqual(generatedAccepted.body.record.masteryHistory.at(-1).session.items,
      generatedEvent.session.items);
    assert.deepEqual(generatedAccepted.body.record.masteryHistory.at(-1).session.items[0],
      generatedEvent.session.items[0], 'history retains only the exact generated pointer revision and outcome');
    assert.equal(/(?:prompt|answer|reference)/iu.test(JSON.stringify(
      generatedAccepted.body.record.masteryHistory.at(-1).session,
    )), false, 'generated mastery history never persists prompts, answers or references');
    const generatedExport = await repository.exportUserData(generatedOwner);
    assert.deepEqual(generatedExport.progress.grammarMastery['5'].masteryHistory.at(-1).session.items,
      generatedEvent.session.items, 'privacy export preserves the bounded generated pointer provenance');
    assert.equal(/(?:prompt|answer|reference)/iu.test(JSON.stringify(
      generatedExport.progress.grammarMastery['5'].masteryHistory,
    )), false);

    const crossOwner = await repository.createTelegramUser(8_811_006, 'Grammar Generated Stranger');
    assert.equal((await request(baseUrl, crossOwner, '/api/v1/grammar/mastery-events', {
      topicId: 5, event: generatedGrammarEvent('00000000-0000-4000-8000-000000000025', generated),
    })).status, 400, 'the same pointer cannot cross the owner-bound generated task lookup');
    const generatedReplay = await request(baseUrl, generatedOwner, '/api/v1/grammar/mastery-events', {
      topicId: 5, event: generatedEvent,
    });
    assert.equal(generatedReplay.status, 200);
    assert.equal(generatedReplay.body.replay, true);
    assert.equal(generatedReplay.body.record.masteryHistory.length, 1);
    const mismatchedGenerated = structuredClone(generatedEvent);
    mismatchedGenerated.id = '00000000-0000-4000-8000-000000000024';
    mismatchedGenerated.session.id = mismatchedGenerated.id;
    mismatchedGenerated.session.items[0].id = mismatchedGenerated.session.items[0].id.replace(/\.c1$/u, '.c9');
    assert.equal((await request(baseUrl, generatedOwner, '/api/v1/grammar/mastery-events', {
      topicId: 5, event: mismatchedGenerated,
    })).status, 400, 'unknown generated registry pointers fail closed before mastery mutation');
    assert.equal(await repository.deleteGeneratedTask(generatedOwner, generated.requestHash), true);
    const replayAfterRemoval = await request(baseUrl, generatedOwner, '/api/v1/grammar/mastery-events', {
      topicId: 5, event: generatedEvent,
    });
    assert.equal(replayAfterRemoval.status, 200);
    assert.equal(replayAfterRemoval.body.replay, true,
      'an exact durable replay is answered from canonical history after generated source removal');
    const changedAfterRemoval = structuredClone(generatedEvent);
    changedAfterRemoval.session.startedAt += 1;
    const conflictAfterRemoval = await request(baseUrl, generatedOwner, '/api/v1/grammar/mastery-events', {
      topicId: 5, event: changedAfterRemoval,
    });
    assert.equal(conflictAfterRemoval.status, 200);
    assert.equal(conflictAfterRemoval.body.conflict, true,
      'changed material under the stored UUID conflicts before generated source resolution');
    const unknownGenerated = structuredClone(generatedEvent);
    unknownGenerated.id = '00000000-0000-4000-8000-000000000026';
    unknownGenerated.session.id = unknownGenerated.id;
    assert.equal((await request(baseUrl, generatedOwner, '/api/v1/grammar/mastery-events', {
      topicId: 5, event: unknownGenerated,
    })).status, 400, 'a new event fails closed after its generated source task is removed');

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

    const deviceOnlyRunner = await request(baseUrl, owner, '/api/v1/progress/modules', {
      owner,
      modules: { grammarRunner: { schema: 'grammar-runner-v1', sessionId: 'device-only' } },
    });
    assert.equal(deviceOnlyRunner.status, 200);
    assert.equal(Object.hasOwn(deviceOnlyRunner.body.progress, 'grammarRunner'), false,
      'generic module merge strips a device-local runner from its authoritative response');
    assert.equal(Object.hasOwn((await request(baseUrl, owner, '/api/v1/progress', undefined)).body,
      'grammarRunner'), false, 'the server preserves no generic grammarRunner copy');

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

    const missingSessionEvidence = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 1, event: { ...event, session: undefined },
    });
    assert.equal(missingSessionEvidence.status, 400, 'practice completion requires stable bounded session evidence');
    const clientEndedSession = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 1, event: { ...event, session: { ...event.session, endedAt: 2_000 } },
    });
    assert.equal(clientEndedSession.status, 400, 'only the server may set the canonical completion time');
    const answerLeakingSession = structuredClone(event.session);
    answerLeakingSession.items[0].answer = 'goes';
    assert.equal((await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 1, event: { ...event, session: answerLeakingSession },
    })).status, 400, 'session evidence rejects answer-bearing item fields');
    const oversizedSession = structuredClone(event.session);
    oversizedSession.items.push(...Array.from({ length: 17 }, (_, index) => ({
      ...oversizedSession.items[index % oversizedSession.items.length], id: `oversized.${index}`,
    })));
    assert.equal((await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 1, event: { ...event, session: oversizedSession },
    })).status, 400, 'session evidence has a hard 32-outcome ceiling');

    const failedSessionWithoutReason = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 2,
      event: { ...event, id: '00000000-0000-4000-8000-000000000013',
        typeScores: { ...event.typeScores, choice: { correct: 3, total: 4 } },
        session: practiceSession('00000000-0000-4000-8000-000000000013', {
          topicId: 2, typeScores: { ...event.typeScores, choice: { correct: 3, total: 4 } },
        }) },
    });
    assert.equal(failedSessionWithoutReason.status, 400, 'automatic disclosure cannot be submitted as clean evidence');
    const unassistedWrongSession = addCorrectTransfers(practiceSession(
      '00000000-0000-4000-8000-000000000017', {
        topicId: 2, typeScores: { ...event.typeScores, choice: { correct: 3, total: 4 } },
      },
    ), 2);
    const unassistedWrongScores = scoresFromSession(unassistedWrongSession);
    const unassistedWrong = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 2,
      event: {
        ...event, id: unassistedWrongSession.id, reason: 'word_or_verb_form',
        typeScores: unassistedWrongScores, session: unassistedWrongSession,
      },
    });
    assert.equal(unassistedWrong.status, 400,
      'even complete adjacent transfer evidence is rejected when wrong-answer disclosure is falsely unassisted');
    const successfulSessionWithReason = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 2,
      event: { ...event, id: '00000000-0000-4000-8000-000000000014', reason: 'auxiliary',
        session: practiceSession('00000000-0000-4000-8000-000000000014', { topicId: 2 }) },
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
    assert.deepEqual(accepted.body.record.masteryHistory.at(-1).session, { ...event.session, endedAt: accepted.body.record.lastStageAt },
      'the stable answer-free session envelope is persisted with canonical mastery history');
    assert.ok(accepted.body.record.lastStageAt >= before && accepted.body.record.lastStageAt <= after);
    assert.equal(accepted.body.record.eligibleAt, accepted.body.record.lastStageAt + 86_400_000);

    const replay = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', { topicId: 1, event });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.applied, false);
    assert.equal(replay.body.conflict, false);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.record.masteryRevision, 1);

    const changedSession = practiceSession(event.id, {
      topicId: 1, assisted: true, typeScores: { ...event.typeScores, choice: { correct: 3, total: 4 } },
    });
    const changedWrongIndex = changedSession.items.findIndex((item) => item.type === 'choice' && !item.correct);
    const changedWrongCatalog = GRAMMAR_CATALOG.bank[1].c.find((item) => item.id === changedSession.items[changedWrongIndex].id);
    const changedTransferCatalog = GRAMMAR_CATALOG.bank[1].c.find((item) => (
      item.id !== changedWrongCatalog.id && item.transferPair === changedWrongCatalog.transferPair
    ));
    changedSession.items.splice(changedWrongIndex + 1, 0, {
      id: changedTransferCatalog.id, type: 'choice', transfer: true, correct: true,
      diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    });
    const changedScores = { ...event.typeScores, choice: { correct: 4, total: 5 } };
    const changedReplay = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 1,
      event: {
        ...event,
        typeScores: changedScores,
        session: changedSession,
        assisted: true,
      },
    });
    assert.equal(changedReplay.status, 200);
    assert.equal(changedReplay.body.applied, false);
    assert.equal(changedReplay.body.replay, false);
    assert.equal(changedReplay.body.conflict, true, 'a UUID cannot replay with changed outcomes');
    assert.equal(changedReplay.body.record.masteryHistory.length, 1);

    const changedTopLevelReplay = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 1,
      event: {
        ...event,
        expectedRevision: 99,
        completedTypes: [...event.completedTypes].reverse(),
      },
    });
    assert.equal(changedTopLevelReplay.status, 200);
    assert.equal(changedTopLevelReplay.body.replay, false);
    assert.equal(changedTopLevelReplay.body.conflict, true,
      'same UUID/session with changed expectations or completedTypes is not an exact replay');

    const reviewEvent = {
      id: '00000000-0000-4000-8000-000000000017', type: 'review_completed',
      expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, passed: true,
    };
    const acceptedReview = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', { topicId: 9, event: reviewEvent });
    assert.equal(acceptedReview.status, 201);
    const exactReviewReplay = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', { topicId: 9, event: reviewEvent });
    assert.equal(exactReviewReplay.body.replay, true);
    const changedReviewReplay = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 9, event: { ...reviewEvent, expectedRevision: 1 },
    });
    assert.equal(changedReviewReplay.status, 200);
    assert.equal(changedReviewReplay.body.replay, false);
    assert.equal(changedReviewReplay.body.conflict, true,
      'review_completed UUID also fingerprints its entire material payload');

    const duplicatePairOwner = await repository.createTelegramUser(8_811_003, 'Grammar Pair Owner');
    const duplicatePairSession = practiceSession('00000000-0000-4000-8000-000000000020', { topicId: 1 });
    const kindsByType = { choice: 'c', input: 'f', correction: 'correction', transform: 'transform' };
    for (const type of ['choice', 'input', 'correction', 'transform']) {
      const originals = duplicatePairSession.items.filter((item) => item.type === type && !item.transfer);
      const firstCatalog = GRAMMAR_CATALOG.bank[1][kindsByType[type]].find((item) => item.id === originals[0].id);
      const reusedPairMate = GRAMMAR_CATALOG.bank[1][kindsByType[type]].find((item) => (
        item.id !== firstCatalog.id && item.transferPair === firstCatalog.transferPair
      ));
      const replacementIndex = duplicatePairSession.items.findIndex((item) => item.id === originals[1].id);
      duplicatePairSession.items[replacementIndex] = {
        id: reusedPairMate.id, type, transfer: false, correct: true,
        diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
      };
    }
    const duplicatePairResponse = await request(baseUrl, duplicatePairOwner, '/api/v1/grammar/mastery-events', {
      topicId: 1,
      event: {
        ...event,
        id: duplicatePairSession.id,
        expectedRevision: 0,
        expectedStage: 'not_started',
        session: duplicatePairSession,
      },
    });
    assert.equal(duplicatePairResponse.status, 400,
      'the server rejects an initial queue that reuses an authored transferPair');
    const duplicatePairProgress = await request(baseUrl, duplicatePairOwner, '/api/v1/progress', undefined);
    assert.equal(duplicatePairProgress.body.grammarMastery?.['1']?.stage ?? 'not_started', 'not_started',
      'a forged duplicate-pair queue cannot grant learned');

    const diagnosticOwner = await repository.createTelegramUser(8_811_007, 'Grammar Diagnostic Owner');
    const diagnosticSession = practiceSession('00000000-0000-4000-8000-000000000018', { assisted: true });
    const diagnosticChoice = GRAMMAR_CATALOG.bank[1].c.find((item) => item.id === 'core.g.1.c.6');
    const firstChoiceIndex = diagnosticSession.items.findIndex((outcome) => outcome.type === 'choice'
      && GRAMMAR_CATALOG.bank[1].c.find((item) => item.id === outcome.id)?.transferPair === diagnosticChoice.transferPair);
    diagnosticSession.items[firstChoiceIndex] = {
      id: diagnosticChoice.id, type: 'choice', transfer: false, correct: false,
      diagnosticId: diagnosticChoice.diagnostics[3].id,
      errorCode: 'word_order', confusionPair: null, transferStatus: null,
    };
    const missingTransferSession = structuredClone(diagnosticSession);
    missingTransferSession.id = '00000000-0000-4000-8000-000000000019';
    assert.equal((await request(baseUrl, diagnosticOwner, '/api/v1/grammar/mastery-events', {
      topicId: 1,
      event: {
        ...event,
        id: missingTransferSession.id,
        typeScores: { ...event.typeScores, choice: { correct: 3, total: 4 } },
        assisted: true,
        session: missingTransferSession,
      },
    })).status, 400, 'every wrong original requires its adjacent paired transfer outcome');
    const diagnosticTransfer = GRAMMAR_CATALOG.bank[1].c.find((item) => (
      item.id !== diagnosticChoice.id && item.transferPair === diagnosticChoice.transferPair
    ));
    diagnosticSession.items.splice(firstChoiceIndex + 1, 0, {
      id: diagnosticTransfer.id, type: 'choice', transfer: true, correct: true,
      diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    });
    const diagnosticScores = { ...event.typeScores, choice: { correct: 4, total: 5 } };
    const diagnosticEvent = {
      ...event,
      id: diagnosticSession.id,
      assisted: true,
      expectedRevision: 0,
      expectedStage: 'not_started',
      expectedReviewStep: 0,
      typeScores: diagnosticScores,
      session: diagnosticSession,
    };
    const diagnosticAccepted = await request(baseUrl, diagnosticOwner, '/api/v1/grammar/mastery-events', {
      topicId: 1, event: diagnosticEvent,
    });
    assert.equal(diagnosticAccepted.status, 201,
      'server accepts the exact authored diagnostic for the chosen wrong option');
    assert.deepEqual(diagnosticAccepted.body.record.masteryHistory.at(-1).session.items[firstChoiceIndex],
      diagnosticSession.items[firstChoiceIndex]);
    const changedDiagnosticSession = structuredClone(diagnosticSession);
    changedDiagnosticSession.items[firstChoiceIndex] = {
      ...changedDiagnosticSession.items[firstChoiceIndex],
      diagnosticId: diagnosticChoice.diagnostics[0].id,
      errorCode: diagnosticChoice.diagnostics[0].errorCode,
      confusionPair: diagnosticChoice.diagnostics[0].confusionPair,
    };
    const changedDiagnostic = await request(baseUrl, diagnosticOwner, '/api/v1/grammar/mastery-events', {
      topicId: 1, event: {
        ...diagnosticEvent,
        session: changedDiagnosticSession,
      },
    });
    assert.equal(changedDiagnostic.status, 200);
    assert.equal(changedDiagnostic.body.replay, false);
    assert.equal(changedDiagnostic.body.conflict, true,
      'same UUID with a different authored diagnostic is a conflict, not replay');

    const partialSession = addCorrectTransfers(practiceSession('00000000-0000-4000-8000-000000000012', {
      topicId: 3,
      assisted: true,
      typeScores: {
        choice: { correct: 3, total: 4 }, input: { correct: 3, total: 4 },
        correction: { correct: 4, total: 4 }, transform: { correct: 4, total: 4 },
      },
    }), 3);
    const partialScores = scoresFromSession(partialSession);
    const partial = await request(baseUrl, owner, '/api/v1/grammar/mastery-events', {
      topicId: 3,
      event: {
        ...event,
        id: '00000000-0000-4000-8000-000000000012',
        expectedStage: 'not_started',
        assisted: true,
        completedTypes: ['choice', 'input', 'correction', 'transform'],
        typeScores: partialScores,
        session: partialSession,
      },
    });
    assert.equal(partial.status, 201, JSON.stringify(partial.body));
    assert.equal(partial.body.record.stage, 'not_started', 'automatic disclosure keeps the assisted run from advancing mastery');
    assert.equal(partial.body.record.masteryRevision, 1);
    assert.deepEqual(partial.body.record.stats, {
      correct: 16, errors: 2, advancedStreak: 0, assistedAttempts: 1,
    });
    const persisted = await request(baseUrl, owner, '/api/v1/progress', undefined);
    assert.equal(persisted.body.grammarMastery['3'].stats.correct, 16);

    const batchEvents = [10, 11].map((topicId, index) => ({
      topicId,
      event: {
        ...event,
        id: `00000000-0000-4000-8000-${String(20 + index).padStart(12, '0')}`,
        expectedStage: 'not_started', completedTypes: ['choice'],
        typeScores: { choice: { correct: 1, total: 1 } },
        session: practiceSession(`00000000-0000-4000-8000-${String(20 + index).padStart(12, '0')}`, {
          topicId, typeScores: { choice: { correct: 1, total: 1 } },
        }),
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

    const atomicBatch = [12, 14].map((topicId, index) => ({
      topicId,
      event: {
        ...event,
        id: `00000000-0000-4000-8000-${String(30 + index).padStart(12, '0')}`,
        expectedRevision: index,
        expectedStage: 'not_started',
        completedTypes: ['choice'],
        typeScores: { choice: { correct: 1, total: 1 } },
        session: practiceSession(`00000000-0000-4000-8000-${String(30 + index).padStart(12, '0')}`, {
          topicId, typeScores: { choice: { correct: 1, total: 1 } },
        }),
      },
    }));
    const atomicBatchId = atomicBatch[0].event.id;
    const conflict = await request(baseUrl, owner, '/api/v1/grammar/mastery-events/batch', { owner, batchId: atomicBatchId, events: atomicBatch });
    assert.equal(conflict.status, 200);
    assert.ok(conflict.body.results.every((result) => !result.applied));
    const afterConflict = await request(baseUrl, owner, '/api/v1/progress', undefined);
    assert.equal(afterConflict.body.grammarMastery['12'], undefined,
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

    const exported = await repository.exportUserData(owner);
    assert.deepEqual(exported.progress.grammarMastery['1'].masteryHistory[0].session,
      accepted.body.record.masteryHistory[0].session,
      'privacy export includes the bounded session evidence exactly once');
    assert.equal(JSON.stringify(exported.progress.grammarMastery).includes('answer'), false);
    assert.equal(await repository.deleteUserData(owner), true);
    assert.equal(await repository.exportUserData(owner), null, 'privacy deletion removes the session envelope');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Grammar OpenAPI structurally rejects wrong outcomes in an unassisted session', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateUnassisted = compileOpenApiSchema(openapi, 'GrammarBuiltinUnassistedMasterySessionEvent');
  const cleanSession = practiceSession('00000000-0000-4000-8000-000000000681', { topicId: 1 });
  const typeScores = scoresFromSession(cleanSession);
  assert.equal(validateUnassisted({ source: 'builtin', assisted: false, typeScores, session: cleanSession }), true,
    JSON.stringify(validateUnassisted.errors));
  const wrongUnassisted = structuredClone(cleanSession);
  const wrongChoice = GRAMMAR_CATALOG.bank[1].c.find((item) => item.id === wrongUnassisted.items[0].id);
  const wrongDiagnostic = wrongChoice.diagnostics.find(Boolean);
  Object.assign(wrongUnassisted.items[0], {
    correct: false, diagnosticId: wrongDiagnostic.id, errorCode: wrongDiagnostic.errorCode,
    confusionPair: wrongDiagnostic.confusionPair || null,
  });
  assert.equal(validateUnassisted({ source: 'builtin', assisted: false, typeScores, session: wrongUnassisted }), false,
    'the evaluated OAS composition rejects every wrong outcome in an unassisted session');
});

test('Grammar OpenAPI executable schema ties every type score to the submitted outcomes', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateEvent = compileOpenApiSchema(openapi, 'GrammarMasterySessionEvent');
  const session = practiceSession('00000000-0000-4000-8000-000000000682', { topicId: 1 });
  const event = {
    id: session.id, type: 'session_completed', expectedRevision: 0,
    expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false,
    completedTypes: ['choice', 'input', 'correction', 'transform'],
    typeScores: scoresFromSession(session), session,
  };
  assert.equal(validateEvent(event), true, JSON.stringify(validateEvent.errors));

  const mismatched = structuredClone(event);
  mismatched.typeScores.choice = { correct: 0, total: 4 };
  assert.equal(validateEvent(mismatched), false,
    'all-correct outcomes cannot structurally advertise a different correct count');

  const assistedSession = addCorrectTransfers(practiceSession(
    '00000000-0000-4000-8000-000000000683',
    { topicId: 1, typeScores: { ...event.typeScores, input: { correct: 3, total: 4 } }, assisted: true },
  ), 1);
  const assisted = {
    ...event, id: assistedSession.id, assisted: true, session: assistedSession,
    typeScores: scoresFromSession(assistedSession),
  };
  assert.equal(validateEvent(assisted), true, JSON.stringify(validateEvent.errors));
  assisted.typeScores.input.total -= 1;
  assert.equal(validateEvent(assisted), false,
    'assisted original plus transfer outcomes must also equal their declared exact totals');
});

test('Grammar OpenAPI request couples every runtime active built-in topic to its exact active envelope', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateRequest = compileOpenApiSchema(openapi, 'GrammarMasteryEventRequest');
  for (const topicId of Array.from({ length: 20 }, (_, index) => index + 1)) {
    const id = `00000000-0000-4000-8000-${String(700 + topicId).padStart(12, '0')}`;
    const item = GRAMMAR_CATALOG.bank[topicId].c[0];
    const legacy = {
      id, type: 'session_completed', expectedRevision: 0,
      expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes: ['choice'],
      typeScores: { choice: { correct: 1, total: 1 } },
      session: {
        id, scope: 'topic', mode: 'legacy_practice', source: 'builtin',
        catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
        items: [{
          id: item.id, type: 'choice', transfer: false, correct: true,
          diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
        }],
        startedAt: 1_000, assisted: false,
      },
    };
    const runtimeAccepted = grammarMasteryEventSchema.safeParse({ topicId, event: legacy }).success;
    assert.equal(runtimeAccepted, !GRAMMAR_ACTIVE_TOPIC_IDS.includes(topicId), `runtime topic ${topicId}`);
    assert.equal(validateRequest({ topicId, event: legacy }), runtimeAccepted,
      `OpenAPI must select the same built-in envelope for topic ${topicId}: ${JSON.stringify(validateRequest.errors)}`);
  }

  for (const topicId of GRAMMAR_ACTIVE_TOPIC_IDS) {
    const session = practiceSession(
      `00000000-0000-4000-8000-${String(800 + topicId).padStart(12, '0')}`,
      { topicId },
    );
    const event = {
      id: session.id, type: 'session_completed', expectedRevision: 0,
      expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false,
      completedTypes: ['choice', 'input', 'correction', 'transform'],
      typeScores: scoresFromSession(session), session,
    };
    assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event }).success, true, `runtime active topic ${topicId}`);
    assert.equal(validateRequest({ topicId, event }), true,
      `OpenAPI active topic ${topicId}: ${JSON.stringify(validateRequest.errors)}`);
  }

  const generated = generatedGrammarEvent('00000000-0000-4000-8000-000000000850', generatedGrammarFixture());
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 5, event: generated }).success, true);
  assert.equal(validateRequest({ topicId: 5, event: generated }), true,
    `generated legacy on an active topic: ${JSON.stringify(validateRequest.errors)}`);
  const mixed = structuredClone(generated);
  mixed.id = '00000000-0000-4000-8000-000000000851';
  mixed.source = 'mixed';
  mixed.session.id = mixed.id;
  mixed.session.source = 'mixed';
  mixed.session.items.unshift({
    id: GRAMMAR_CATALOG.bank[5].c[0].id, type: 'choice', transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  });
  mixed.typeScores.choice = { correct: 2, total: 2 };
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 5, event: mixed }).success, true);
  assert.equal(validateRequest({ topicId: 5, event: mixed }), true,
    `mixed legacy on an active topic: ${JSON.stringify(validateRequest.errors)}`);

  const review = {
    id: '00000000-0000-4000-8000-000000000852', type: 'review_completed',
    expectedRevision: 1, expectedStage: 'learned', expectedReviewStep: 0,
    assisted: false, source: 'builtin', passed: true,
  };
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 5, event: review }).success, true);
  assert.equal(validateRequest({ topicId: 5, event: review }), true,
    `review events remain topic-independent: ${JSON.stringify(validateRequest.errors)}`);
});

test('Grammar OpenAPI evaluator binds each built-in pointer kind to its runtime type', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateBuiltinItem = compileOpenApiSchema(openapi, 'GrammarBuiltinPracticeSessionItem');
  const builtinExamples = [
    ['core.g.1.c.1', 'choice', true],
    ['core.g.1.c2.1', 'choice', true],
    ['core.g.1.f.1', 'input', true],
    ['core.g.1.correction.1', 'correction', true],
    ['core.g.1.transform.1', 'transform', true],
    ['core.g.1.c.1', 'input', false],
    ['core.g.1.f.1', 'choice', false],
    ['core.g.1.correction.1', 'transform', false],
  ];
  for (const [id, type, accepted] of builtinExamples) {
    const item = {
      id, type, transfer: false, correct: true,
      diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    };
    assert.equal(validateBuiltinItem(item), accepted,
      `${id} must ${accepted ? 'match' : 'not match'} runtime type ${type}: ${JSON.stringify(validateBuiltinItem.errors)}`);
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
  const sessionEventBlock = openapi.slice(openapi.indexOf('    GrammarMasterySessionEvent:'),
    openapi.indexOf('    GrammarPracticeSession:'));
  assert.match(sessionEventBlock,
    /oneOf:[\s\S]+GrammarBuiltinAssistedMasterySessionEvent[\s\S]+GrammarBuiltinUnassistedMasterySessionEvent[\s\S]+GrammarGeneratedAssistedMasterySessionEvent[\s\S]+GrammarMixedAssistedMasterySessionEvent/iu,
    'OpenAPI structurally ties every event source/assisted combination to its session variant');
  assert.match(sessionEventBlock,
    /allOf:[\s\S]+oneOf:[\s\S]+GrammarActiveMasterySessionEvidence[\s\S]+GrammarLegacyMasterySessionEvidence/iu,
    'OpenAPI structurally selects strict active evidence or compatible partial legacy evidence');
  const activeEvidence = sessionEventBlock.slice(
    sessionEventBlock.indexOf('    GrammarActiveMasterySessionEvidence:'),
    sessionEventBlock.indexOf('    GrammarLegacyMasterySessionEvidence:'),
  );
  assert.match(activeEvidence,
    /completedTypes:[\s\S]+minItems: 4[\s\S]+maxItems: 4[\s\S]+uniqueItems: true[\s\S]+enum: \[choice, input, correction, transform\]/iu,
    'active evidence structurally requires the exact four practice types');
  assert.match(activeEvidence,
    /typeScores:[\s\S]+required: \[choice, input, correction, transform\][\s\S]+additionalProperties: false/iu,
    'active evidence structurally requires exactly four score properties');
  assert.match(activeEvidence, /session:[\s\S]+mode:[\s\S]+enum: \[topic_practice\]/iu,
    'active evidence is structurally tied to an active session');
  const legacyEvidence = sessionEventBlock.slice(
    sessionEventBlock.indexOf('    GrammarLegacyMasterySessionEvidence:'),
    sessionEventBlock.indexOf('    GrammarBuiltinAssistedMasterySessionEvent:'),
  );
  assert.match(legacyEvidence,
    /completedTypes:[\s\S]+minItems: 1[\s\S]+maxItems: 4[\s\S]+uniqueItems: true/iu,
    'legacy evidence may truthfully declare a partial completed type set');
  assert.doesNotMatch(legacyEvidence, /required: \[choice, input, correction, transform\]/iu,
    'legacy evidence does not require scores for uncompleted types');
  assert.match(legacyEvidence, /session:[\s\S]+mode:[\s\S]+enum: \[legacy_practice\]/iu,
    'legacy evidence is structurally tied to a legacy session');
  assert.match(sessionEventBlock, /Clean unassisted practice session[\s\S]+all submitted type scores must be fully correct/iu);
  assert.match(sessionEventBlock,
    /GrammarBuiltinAssistedMasterySessionEvent:[\s\S]+source:[\s\S]+enum: \[builtin\][\s\S]+assisted:[\s\S]+enum: \[true\][\s\S]+session:[\s\S]+GrammarPracticeSession[\s\S]+source:[\s\S]+enum: \[builtin\][\s\S]+assisted:[\s\S]+enum: \[true\]/iu);
  assert.match(sessionEventBlock,
    /GrammarBuiltinUnassistedMasterySessionEvent:[\s\S]+source:[\s\S]+enum: \[builtin\][\s\S]+assisted:[\s\S]+enum: \[false\][\s\S]+session:[\s\S]+GrammarPracticeSession[\s\S]+source:[\s\S]+enum: \[builtin\][\s\S]+assisted:[\s\S]+enum: \[false\]/iu);
  assert.match(sessionEventBlock,
    /GrammarGeneratedAssistedMasterySessionEvent:[\s\S]+source:[\s\S]+enum: \[generated\][\s\S]+assisted:[\s\S]+enum: \[true\][\s\S]+session:[\s\S]+GrammarPracticeSession[\s\S]+source:[\s\S]+enum: \[generated\][\s\S]+assisted:[\s\S]+enum: \[true\]/iu);
  assert.match(sessionEventBlock,
    /GrammarMixedAssistedMasterySessionEvent:[\s\S]+source:[\s\S]+enum: \[mixed\][\s\S]+assisted:[\s\S]+enum: \[true\][\s\S]+session:[\s\S]+GrammarPracticeSession[\s\S]+source:[\s\S]+enum: \[mixed\][\s\S]+assisted:[\s\S]+enum: \[true\]/iu);
  assert.doesNotMatch(sessionEventBlock, /^\s+reason:/mu,
    'automatic-disclosure practice sessions cannot advertise an independent wrong-answer reason');
  assert.match(openapi, /required: \[id, type, expectedRevision[^\n]+session\]/u);
  assert.match(openapi, /GrammarPracticeSession:/u);
  assert.match(openapi, /The server appends endedAt from its authoritative clock/iu);
  const practiceSchemas = openapi.slice(openapi.indexOf('    GrammarPracticeSession:'),
    openapi.indexOf('    GrammarPracticeSessionItem:'));
  assert.match(practiceSchemas, /GrammarPracticeSession:[\s\S]+oneOf:[\s\S]+GrammarActivePracticeSession[\s\S]+GrammarLegacyPracticeSession/iu);
  const activePractice = practiceSchemas.slice(practiceSchemas.indexOf('    GrammarActivePracticeSession:'),
    practiceSchemas.indexOf('    GrammarLegacyPracticeSession:'));
  const legacyPractice = practiceSchemas.slice(practiceSchemas.indexOf('    GrammarLegacyPracticeSession:'));
  assert.match(activePractice, /items:[\s\S]+minItems: 16[\s\S]+maxItems: 32/iu,
    'active OAS evidence requires all sixteen original outcomes before optional transfers');
  assert.match(activePractice, /mode:[\s\S]+enum: \[topic_practice\][\s\S]+items:[\s\S]+uniqueItems: true/iu,
    'only active sessions require globally unique item outcomes');
  assert.match(legacyPractice, /mode:[\s\S]+enum: \[legacy_practice\][\s\S]+items:[\s\S]+maxItems: 16/iu);
  assert.doesNotMatch(legacyPractice, /uniqueItems: true/iu,
    'legacy sessions structurally allow one repeated retry per original');
  assert.match(legacyPractice,
    /oneOf:[\s\S]+GrammarBuiltinLegacyPracticeSession[\s\S]+GrammarGeneratedLegacyPracticeSession[\s\S]+GrammarMixedLegacyPracticeSession/iu,
    'legacy source and assisted provenance are represented as mutually exclusive schemas');
  const legacyVariants = openapi.slice(openapi.indexOf('    GrammarBuiltinLegacyPracticeSession:'),
    openapi.indexOf('    GrammarPracticeSessionItem:'));
  assert.match(legacyVariants,
    /GrammarBuiltinLegacyPracticeSession:[\s\S]+source:[\s\S]+enum: \[builtin\][\s\S]+items:[\s\S]+GrammarBuiltinLegacyPracticeSessionItem/iu);
  assert.match(legacyVariants,
    /GrammarGeneratedLegacyPracticeSession:[\s\S]+source:[\s\S]+enum: \[generated\][\s\S]+assisted:[\s\S]+enum: \[true\][\s\S]+items:[\s\S]+GrammarGeneratedLegacyPracticeSessionItem/iu);
  const mixedLegacy = legacyVariants.slice(legacyVariants.indexOf('    GrammarMixedLegacyPracticeSession:'));
  assert.match(mixedLegacy, /at least one built-in and one generated/iu);
  assert.match(mixedLegacy,
    /source:[\s\S]+enum: \[mixed\][\s\S]+assisted:[\s\S]+enum: \[true\][\s\S]+allOf:[\s\S]+not:[\s\S]+GrammarBuiltinLegacyPracticeSessionItem[\s\S]+not:[\s\S]+GrammarGeneratedLegacyPracticeSessionItem/iu,
    'mixed evidence structurally rejects both all-built-in and all-generated item arrays');
  const itemSchemas = openapi.slice(openapi.indexOf('    GrammarPracticeSessionItem:'),
    openapi.indexOf('    GrammarMasteryReviewEvent:'));
  assert.match(itemSchemas,
    /GrammarBuiltinLegacyPracticeSessionItem:[\s\S]+transfer:[^\n]+enum: \[false\][\s\S]+diagnosticId:[\s\S]+enum: \[null\][\s\S]+confusionPair:[\s\S]+enum: \[null\][\s\S]+additionalProperties: false/iu,
    'legacy built-in outcomes structurally forbid active transfer and diagnostic metadata');
  assert.match(itemSchemas,
    /GrammarGeneratedLegacyPracticeSessionItem:[\s\S]+required: \[[^\]]*source[^\]]*revision[^\]]*\][\s\S]+transfer:[^\n]+enum: \[false\][\s\S]+source:[\s\S]+enum: \[generated\][\s\S]+revision:[\s\S]+enum: \[1\][\s\S]+additionalProperties: false/iu,
    'legacy generated outcomes add only exact generated pointer provenance');
  assert.match(itemSchemas,
    /GrammarPracticeSessionItem:[\s\S]+oneOf:[\s\S]+GrammarBuiltinPracticeSessionItem[\s\S]+GrammarGeneratedPracticeSessionItem/iu);
  assert.match(itemSchemas,
    /GrammarGeneratedPracticeSessionItem:[\s\S]+required: \[[^\]]*source[^\]]*revision[^\]]*\][\s\S]+pattern: '\^generated\\\.g\\\.q[\s\S]+source:[\s\S]+enum: \[generated\][\s\S]+revision:[\s\S]+enum: \[1\]/iu,
    'generated pointer provenance is required and addressable by exact pattern');
  assert.match(itemSchemas,
    /Generated choice pointer[\s\S]+pattern: '[^']+\\\.c\[1-9\][^']*'[\s\S]+enum: \[choice\][\s\S]+Generated input pointer[\s\S]+pattern: '[^']+\\\.f\[1-9\][^']*'[\s\S]+enum: \[input\]/iu,
    'generated c/f pointer suffixes are structurally tied to choice/input outcome types');
  assert.match(itemSchemas,
    /GrammarBuiltinPracticeSessionItem:[\s\S]+pattern: '\^core\\\.g[\s\S]+additionalProperties: false/iu,
    'built-in outcomes cannot independently advertise generated metadata');
  assert.match(itemSchemas,
    /GrammarBuiltinPracticeSessionItem:[\s\S]+oneOf:[\s\S]+Correct active outcome[\s\S]+Wrong active choice original[\s\S]+Wrong active text original[\s\S]+Wrong active choice transfer[\s\S]+Wrong active text transfer/iu,
    'active built-in outcome correctness structurally constrains weakness and transfer-status fields');
  const activeBuiltinItem = itemSchemas.slice(
    itemSchemas.indexOf('    GrammarBuiltinPracticeSessionItem:'),
    itemSchemas.indexOf('    GrammarGeneratedPracticeSessionItem:'),
  );
  const wrongBranches = [...activeBuiltinItem.matchAll(
    /^ {8}- title: (Wrong active (?:choice|text) (?:original|transfer))\r?\n([\s\S]*?)(?=^ {8}- title:|^ {6}additionalProperties:)/gmu,
  )].map((match) => ({ title: match[1], body: match[2] }));
  function inlineEnum(block, property) {
    const match = block.match(new RegExp(`^ {12}${property}: \\{[^\\n]*enum: \\[([^\\]]+)\\]`, 'mu'));
    return match ? match[1].split(',').map((value) => value.trim()) : null;
  }
  function activeWrongShapeAcceptedByOas(item) {
    return wrongBranches.some(({ body }) => {
      const types = inlineEnum(body, 'type');
      const transfers = inlineEnum(body, 'transfer');
      const correct = inlineEnum(body, 'correct');
      const diagnostics = inlineEnum(body, 'diagnosticId');
      const diagnosticIsString = /^ {12}diagnosticId: \{ type: string \}/mu.test(body);
      return types?.includes(item.type)
        && transfers?.includes(String(item.transfer))
        && correct?.includes(String(item.correct))
        && (diagnosticIsString ? typeof item.diagnosticId === 'string' : diagnostics?.includes('null') && item.diagnosticId === null);
    });
  }
  const diagnosticId = 'core.g.1.c.1.diagnostic.1';
  assert.deepEqual([
    activeWrongShapeAcceptedByOas({ type: 'choice', transfer: false, correct: false, diagnosticId }),
    activeWrongShapeAcceptedByOas({ type: 'choice', transfer: true, correct: false, diagnosticId }),
    activeWrongShapeAcceptedByOas({ type: 'input', transfer: false, correct: false, diagnosticId: null }),
    activeWrongShapeAcceptedByOas({ type: 'transform', transfer: true, correct: false, diagnosticId: null }),
    activeWrongShapeAcceptedByOas({ type: 'choice', transfer: false, correct: false, diagnosticId: null }),
    activeWrongShapeAcceptedByOas({ type: 'correction', transfer: true, correct: false, diagnosticId }),
  ], [true, true, true, true, false, false],
  'the executable active OAS branches accept and reject the same choice/text diagnostic shapes as runtime');
  assert.match(itemSchemas,
    /GrammarGeneratedPracticeSessionItem:[\s\S]+allOf:[\s\S]+Generated choice pointer[\s\S]+Generated input pointer[\s\S]+Correct generated outcome[\s\S]+Wrong generated original[\s\S]+Wrong generated transfer/iu,
    'generated active pointer and correctness invariants both apply');
  assert.match(itemSchemas,
    /GrammarGeneratedLegacyPracticeSessionItem:[\s\S]+allOf:[\s\S]+Generated legacy choice pointer[\s\S]+Generated legacy input pointer[\s\S]+Correct generated legacy outcome[\s\S]+Wrong generated legacy outcome or bounded retry/iu,
    'generated legacy pointer and correctness invariants both apply');
  assert.match(openapi, /errorCode:[\s\S]+confusionPair:/u);
  assert.doesNotMatch(openapi.slice(openapi.indexOf('    GrammarPracticeSession:'), openapi.indexOf('    GrammarMasteryReviewEvent:')), /^\s+(?:prompt|answer|reference):/imu);
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
