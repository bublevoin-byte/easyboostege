import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createProgressRoutes } from '../routes/progress.js';
import { createFileRepository } from '../storage/file-repository.js';
import {
  GRAMMAR_CATALOG,
  GRAMMAR_CATALOG_RUNTIMES,
  GRAMMAR_CATALOG_V1,
  GRAMMAR_CATALOG_V2,
} from '../public/grammar-catalog.js';
import {
  GRAMMAR_ACTIVE_TOPIC_IDS,
  GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
} from '../public/grammar-domain-contract.js';
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
    catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
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

function legacyPracticeEvent(id, topicId = 14) {
  const queue = EasyBoostGrammar.buildTopicQueue(GRAMMAR_CATALOG_V1.bank[topicId], topicId, () => 0.5);
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
      catalog: { version: GRAMMAR_CATALOG_V1.version, revision: GRAMMAR_CATALOG_V1.revision },
      items, startedAt: 1_000, assisted: false,
    },
  };
}

function assistedLegacyPracticeEvent(id, topicId = 14) {
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
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 14, event: legacy }).success, true,
    'legacy practice keeps its truthful partial declaration');

  const historicalActive = practiceSession('00000000-0000-4000-8000-000000000029');
  historicalActive.catalog = { version: GRAMMAR_CATALOG_V2.version, revision: GRAMMAR_CATALOG_V2.revision };
  assert.equal(grammarMasteryEventSchema.safeParse({
    topicId: 1,
    event: {
      ...event,
      id: historicalActive.id,
      completedTypes: ['choice', 'input', 'correction', 'transform'],
      typeScores: scoresFromSession(historicalActive),
      session: historicalActive,
    },
  }).success, true, 'a queued active v2 session restores against its immutable v2 catalog');

  const historicalFunctionWords = legacyPracticeEvent('00000000-0000-4000-8000-000000000039');
  historicalFunctionWords.session.catalog = {
    version: GRAMMAR_CATALOG_V2.version,
    revision: GRAMMAR_CATALOG_V2.revision,
  };
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 14, event: historicalFunctionWords }).success, true,
    'a pre-Ticket06 function-words session restores as legacy practice against immutable v2');
  const extraDeclaredType = structuredClone(legacy);
  extraDeclaredType.completedTypes = ['choice', 'input'];
  extraDeclaredType.typeScores = { ...legacy.typeScores, input: { correct: 1, total: 1 } };
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 14, event: extraDeclaredType }).success, false,
    'legacy declarations must exactly equal the distinct types that produced outcomes');
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
      topicId: 14, event: legacyEvent,
    });
    assert.equal(legacyAccepted.status, 201, JSON.stringify(legacyAccepted.body));
    assert.equal(legacyAccepted.body.record.stage, 'learning',
      'a clean choice/input legacy run records partial evidence without false learned mastery');
    assert.deepEqual(legacyAccepted.body.record.masteryHistory.at(-1).session.items, legacyEvent.session.items);
    const legacyReplay = await request(baseUrl, legacyOwner, '/api/v1/grammar/mastery-events', {
      topicId: 14, event: legacyEvent,
    });
    assert.equal(legacyReplay.status, 200);
    assert.equal(legacyReplay.body.replay, true);
    assert.equal(legacyReplay.body.record.masteryHistory.length, 1);
    const changedLegacyEvent = structuredClone(legacyEvent);
    changedLegacyEvent.session.startedAt += 1;
    const legacyConflict = await request(baseUrl, legacyOwner, '/api/v1/grammar/mastery-events', {
      topicId: 14, event: changedLegacyEvent,
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
      topicId: 14, event: invalidLegacyWrong,
    })).status, 400, 'legacy errors must match the catalog item and cannot claim an unrelated weakness');
    const legacyWrongAccepted = await request(baseUrl, legacyWrongOwner, '/api/v1/grammar/mastery-events', {
      topicId: 14, event: legacyWrong,
    });
    assert.equal(legacyWrongAccepted.status, 201, JSON.stringify(legacyWrongAccepted.body));
    assert.equal(legacyWrongAccepted.body.record.stage, 'not_started');
    assert.deepEqual(legacyWrongAccepted.body.record.masteryHistory.at(-1).session.items,
      legacyWrong.session.items, 'the repeated legacy retry remains ordered canonical evidence');
    const legacyWrongReplay = await request(baseUrl, legacyWrongOwner, '/api/v1/grammar/mastery-events', {
      topicId: 14, event: legacyWrong,
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

    const batchEvents = [14, 15].map((topicId, index) => {
      const id = `00000000-0000-4000-8000-${String(20 + index).padStart(12, '0')}`;
      return { topicId, event: legacyPracticeEvent(id, topicId) };
    });
    const batchId = batchEvents[0].event.id;
    const batch = await request(baseUrl, owner, '/api/v1/grammar/mastery-events/batch', { owner, batchId, events: batchEvents });
    assert.equal(batch.status, 201);
    assert.equal(batch.body.batchId, batchId);
    assert.equal(batch.body.results.length, 2);
    assert.ok(batch.body.results.every((result) => result.applied && result.record.stage === 'learning'));
    const batchReplay = await request(baseUrl, owner, '/api/v1/grammar/mastery-events/batch', { owner, batchId, events: batchEvents });
    assert.equal(batchReplay.status, 200);
    assert.ok(batchReplay.body.results.every((result) => result.replay && !result.conflict));

    const atomicBatch = [19, 14].map((topicId, index) => {
      const id = `00000000-0000-4000-8000-${String(30 + index).padStart(12, '0')}`;
      return {
        topicId,
        event: { ...legacyPracticeEvent(id, topicId), expectedRevision: index * 2 },
      };
    });
    const atomicBatchId = atomicBatch[0].event.id;
    const conflict = await request(baseUrl, owner, '/api/v1/grammar/mastery-events/batch', { owner, batchId: atomicBatchId, events: atomicBatch });
    assert.equal(conflict.status, 200);
    assert.ok(conflict.body.results.every((result) => !result.applied));
    const afterConflict = await request(baseUrl, owner, '/api/v1/progress', undefined);
    assert.equal(afterConflict.body.grammarMastery['19'], undefined,
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
    const queuedBeforeActivation = GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS.includes(topicId);
    const eventCatalog = queuedBeforeActivation ? GRAMMAR_CATALOG_V1 : GRAMMAR_CATALOG;
    const item = eventCatalog.bank[topicId].c[0];
    const legacy = {
      id, type: 'session_completed', expectedRevision: 0,
      expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes: ['choice'],
      typeScores: { choice: { correct: 1, total: 1 } },
      session: {
        id, scope: 'topic', mode: 'legacy_practice', source: 'builtin',
        catalog: { version: eventCatalog.version, revision: eventCatalog.revision },
        items: [{
          id: item.id, type: 'choice', transfer: false, correct: true,
          diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
        }],
        startedAt: 1_000, assisted: false,
      },
    };
    const runtimeAccepted = grammarMasteryEventSchema.safeParse({ topicId, event: legacy }).success;
    const compatibilityExpected = !GRAMMAR_ACTIVE_TOPIC_IDS.includes(topicId) || queuedBeforeActivation;
    assert.equal(runtimeAccepted, compatibilityExpected,
      `runtime keeps only the explicitly versioned pre-activation legacy envelope for topic ${topicId}`);
    assert.equal(validateRequest({ topicId, event: legacy }), runtimeAccepted,
      `OpenAPI must select the same built-in envelope for topic ${topicId}: ${JSON.stringify(validateRequest.errors)}`);
  }

  const preActivationInput = assistedLegacyPracticeEvent(
    '00000000-0000-4000-8000-000000000799', 10,
  );
  preActivationInput.session.items = [
    {
      id: 'core.g.10.f.1', type: 'input', transfer: false, correct: false,
      diagnosticId: null, errorCode: 'word_or_verb_form', confusionPair: null, transferStatus: null,
    },
    {
      id: 'core.g.10.f.1', type: 'input', transfer: false, correct: true,
      diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    },
  ];
  preActivationInput.completedTypes = ['input'];
  preActivationInput.typeScores = { input: { correct: 1, total: 2 } };
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 10, event: preActivationInput }).success, true,
    'the current runtime accepts a queued v1 input error with the historical fallback weakness');
  assert.equal(validateRequest({ topicId: 10, event: preActivationInput }), true,
    `OpenAPI accepts the same queued v1 input envelope: ${JSON.stringify(validateRequest.errors)}`);

  for (const [topicIndex, topicId] of GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS.entries()) {
    const contracts = [
      GRAMMAR_CATALOG_V1.bank[topicId].c.length
        ? { pointerKind: 'c', type: 'choice', errorCode: 'construction_choice' } : null,
      GRAMMAR_CATALOG_V1.bank[topicId].c2.length
        ? { pointerKind: 'c2', type: 'choice', errorCode: 'construction_choice' } : null,
      GRAMMAR_CATALOG_V1.bank[topicId].f.length
        ? { pointerKind: 'f', type: 'input', errorCode: 'word_or_verb_form' } : null,
    ].filter(Boolean);
    for (const [kindIndex, contract] of contracts.entries()) {
      const id = `00000000-0000-4000-8000-${String(7300 + topicIndex * 2 + kindIndex).padStart(12, '0')}`;
      const exact = assistedLegacyPracticeEvent(id, topicId);
      exact.session.items = [
        {
          id: `core.g.${topicId}.${contract.pointerKind}.1`, type: contract.type,
          transfer: false, correct: false, diagnosticId: null,
          errorCode: contract.errorCode, confusionPair: null, transferStatus: null,
        },
        {
          id: `core.g.${topicId}.${contract.pointerKind}.1`, type: contract.type,
          transfer: false, correct: true, diagnosticId: null,
          errorCode: null, confusionPair: null, transferStatus: null,
        },
      ];
      exact.completedTypes = [contract.type];
      exact.typeScores = { [contract.type]: { correct: 1, total: 2 } };
      assert.deepEqual({
        runtime: grammarMasteryEventSchema.safeParse({ topicId, event: exact }).success,
        openapi: validateRequest({ topicId, event: exact }),
      }, { runtime: true, openapi: true },
      `queued topic ${topicId} ${contract.type} keeps first-miss/null then correct/null retry order`);

      const secondMiss = structuredClone(exact);
      secondMiss.id = `00000000-0000-4000-8000-${String(7350 + topicIndex * 2 + kindIndex).padStart(12, '0')}`;
      secondMiss.session.id = secondMiss.id;
      secondMiss.session.items[1].correct = false;
      secondMiss.session.items[1].errorCode = contract.errorCode;
      secondMiss.session.items[1].transferStatus = 'due_next_session';
      secondMiss.typeScores = { [contract.type]: { correct: 0, total: 2 } };
      assert.deepEqual({
        runtime: grammarMasteryEventSchema.safeParse({ topicId, event: secondMiss }).success,
        openapi: validateRequest({ topicId, event: secondMiss }),
      }, { runtime: true, openapi: true },
      `queued topic ${topicId} ${contract.type} keeps second-miss/due retry order`);

      const misplacedDue = structuredClone(exact);
      misplacedDue.id = `00000000-0000-4000-8000-${String(7375 + topicIndex * 2 + kindIndex).padStart(12, '0')}`;
      misplacedDue.session.id = misplacedDue.id;
      misplacedDue.session.items[0].transferStatus = 'due_next_session';
      const missingDue = structuredClone(secondMiss);
      missingDue.id = `00000000-0000-4000-8000-${String(7425 + topicIndex * 2 + kindIndex).padStart(12, '0')}`;
      missingDue.session.id = missingDue.id;
      missingDue.session.items[1].transferStatus = null;
      for (const [name, event] of [['misplaced due', misplacedDue], ['missing due', missingDue]]) {
        assert.deepEqual({
          runtime: grammarMasteryEventSchema.safeParse({ topicId, event }).success,
          openapi: validateRequest({ topicId, event }),
        }, { runtime: false, openapi: false },
        `queued topic ${topicId} ${contract.type} rejects ${name}`);
      }

      const forged = structuredClone(exact);
      forged.id = `00000000-0000-4000-8000-${String(7400 + topicIndex * 2 + kindIndex).padStart(12, '0')}`;
      forged.session.id = forged.id;
      forged.session.items[0].errorCode = 'auxiliary';
      assert.deepEqual({
        runtime: grammarMasteryEventSchema.safeParse({ topicId, event: forged }).success,
        openapi: validateRequest({ topicId, event: forged }),
      }, { runtime: false, openapi: false },
      `queued topic ${topicId} ${contract.type} rejects a non-historical weakness`);
    }
  }

  const wrongLegacyType = structuredClone(preActivationInput);
  wrongLegacyType.id = '00000000-0000-4000-8000-000000000797';
  wrongLegacyType.session.id = wrongLegacyType.id;
  wrongLegacyType.session.items.forEach((item) => { item.type = 'choice'; });
  wrongLegacyType.completedTypes = ['choice'];
  wrongLegacyType.typeScores = { choice: { correct: 1, total: 2 } };
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 10, event: wrongLegacyType }).success, false,
    'runtime rejects a pre-activation input pointer declared as a choice');

  const crossTopicPointer = structuredClone(preActivationInput);
  crossTopicPointer.id = '00000000-0000-4000-8000-000000000796';
  crossTopicPointer.session.id = crossTopicPointer.id;
  crossTopicPointer.session.items.forEach((item) => { item.id = 'core.g.11.f.1'; });
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 10, event: crossTopicPointer }).success, false,
    'runtime resolves every legacy pointer inside the selected topic');
  assert.deepEqual({
    typeCoupled: !validateRequest({ topicId: 10, event: wrongLegacyType }),
    topicCoupled: !validateRequest({ topicId: 10, event: crossTopicPointer }),
  }, { typeCoupled: true, topicCoupled: true },
  'OpenAPI couples pre-activation pointers to both their exact runtime type and selected topic');

  const postActivationPointer = structuredClone(preActivationInput);
  postActivationPointer.id = '00000000-0000-4000-8000-000000000798';
  postActivationPointer.session.id = postActivationPointer.id;
  postActivationPointer.session.items = [{
    id: 'core.g.10.f.6', type: 'input', transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  }];
  postActivationPointer.assisted = false;
  postActivationPointer.session.assisted = false;
  postActivationPointer.typeScores = { input: { correct: 1, total: 1 } };
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 10, event: postActivationPointer }).success, false,
    'legacy compatibility cannot submit content that did not exist before activation');
  assert.equal(validateRequest({ topicId: 10, event: postActivationPointer }), false,
    'OpenAPI exposes the same pre-activation content boundary');

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

  for (const [index, topicId] of GRAMMAR_ACTIVE_TOPIC_IDS.entries()) {
    const otherTopicId = GRAMMAR_ACTIVE_TOPIC_IDS[(index + 1) % GRAMMAR_ACTIVE_TOPIC_IDS.length];
    const crossTopicActive = practiceSession(
      `00000000-0000-4000-8000-${String(860 + topicId).padStart(12, '0')}`,
      { topicId: otherTopicId },
    );
    const crossTopicActiveEvent = {
      id: crossTopicActive.id, type: 'session_completed', expectedRevision: 0,
      expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false,
      completedTypes: ['choice', 'input', 'correction', 'transform'],
      typeScores: scoresFromSession(crossTopicActive), session: crossTopicActive,
    };
    assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event: crossTopicActiveEvent }).success, false,
      `runtime rejects topic ${otherTopicId} pointers submitted for active topic ${topicId}`);
    assert.equal(validateRequest({ topicId, event: crossTopicActiveEvent }), false,
      `OpenAPI rejects topic ${otherTopicId} pointers submitted for active topic ${topicId}`);
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

test('runtime and OpenAPI preserve the exact immutable v1 identity of a restored legacy session', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateRequest = compileOpenApiSchema(openapi, 'GrammarMasteryEventRequest');
  const topicId = 19;
  const event = legacyPracticeEvent('00000000-0000-4000-8000-000000009019', topicId);
  event.session.catalog = {
    version: GRAMMAR_CATALOG_V1.version,
    revision: GRAMMAR_CATALOG_V1.revision,
  };

  assert.deepEqual({
    runtime: grammarMasteryEventSchema.safeParse({ topicId, event }).success,
    openapi: validateRequest({ topicId, event }),
  }, { runtime: true, openapi: true },
  `the restored v1 session keeps one accepted identity: ${JSON.stringify(validateRequest.errors)}`);

  const postActivationPointer = structuredClone(event);
  postActivationPointer.id = '00000000-0000-4000-8000-000000009020';
  postActivationPointer.session.id = postActivationPointer.id;
  postActivationPointer.session.items = [{
    id: 'core.g.19.correction.1', type: 'correction', transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  }];
  postActivationPointer.completedTypes = ['correction'];
  postActivationPointer.typeScores = { correction: { correct: 1, total: 1 } };
  assert.deepEqual({
    runtime: grammarMasteryEventSchema.safeParse({ topicId, event: postActivationPointer }).success,
    openapi: validateRequest({ topicId, event: postActivationPointer }),
  }, { runtime: false, openapi: false },
  'a v1 identity cannot be used to submit post-activation built-in content');

  const topicPractice = structuredClone(event);
  topicPractice.id = '00000000-0000-4000-8000-000000009021';
  topicPractice.session.id = topicPractice.id;
  topicPractice.session.mode = 'topic_practice';
  assert.deepEqual({
    runtime: grammarMasteryEventSchema.safeParse({ topicId, event: topicPractice }).success,
    openapi: validateRequest({ topicId, event: topicPractice }),
  }, { runtime: false, openapi: false },
  'a v1 identity remains bounded to a queued legacy-practice session');
});

test('runtime and OpenAPI restore v2 only within its immutable pre-Ticket06 capabilities', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateRequest = compileOpenApiSchema(openapi, 'GrammarMasteryEventRequest');

  const activeSession = practiceSession('00000000-0000-4000-8000-000000009022', { topicId: 1 });
  activeSession.catalog = { version: GRAMMAR_CATALOG_V2.version, revision: GRAMMAR_CATALOG_V2.revision };
  const activeEvent = {
    id: activeSession.id, type: 'session_completed', expectedRevision: 0,
    expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false,
    completedTypes: ['choice', 'input', 'correction', 'transform'],
    typeScores: scoresFromSession(activeSession), session: activeSession,
  };
  assert.deepEqual({
    runtime: grammarMasteryEventSchema.safeParse({ topicId: 1, event: activeEvent }).success,
    openapi: validateRequest({ topicId: 1, event: activeEvent }),
  }, { runtime: true, openapi: true },
  `an active v2 runner remains resumable: ${JSON.stringify(validateRequest.errors)}`);

  const legacyEvent = legacyPracticeEvent('00000000-0000-4000-8000-000000009023', 14);
  legacyEvent.session.catalog = { version: GRAMMAR_CATALOG_V2.version, revision: GRAMMAR_CATALOG_V2.revision };
  assert.deepEqual({
    runtime: grammarMasteryEventSchema.safeParse({ topicId: 14, event: legacyEvent }).success,
    openapi: validateRequest({ topicId: 14, event: legacyEvent }),
  }, { runtime: true, openapi: true },
  `a function-words v2 runner stays pre-activation legacy practice: ${JSON.stringify(validateRequest.errors)}`);

  for (const [index, alreadyActiveTopicId] of [10, 11, 12, 16, 17, 20].entries()) {
    const impossibleLegacy = legacyPracticeEvent(
      `00000000-0000-4000-8000-${String(9026 + index).padStart(12, '0')}`,
      alreadyActiveTopicId,
    );
    impossibleLegacy.session.catalog = {
      version: GRAMMAR_CATALOG_V2.version,
      revision: GRAMMAR_CATALOG_V2.revision,
    };
    assert.deepEqual({
      runtime: grammarMasteryEventSchema.safeParse({
        topicId: alreadyActiveTopicId, event: impossibleLegacy,
      }).success,
      openapi: validateRequest({ topicId: alreadyActiveTopicId, event: impossibleLegacy }),
    }, { runtime: false, openapi: false },
    `v2 topic ${alreadyActiveTopicId} was already active and cannot use a legacy-practice envelope`);
  }

  const impossibleV2Active = practiceSession('00000000-0000-4000-8000-000000009024', { topicId: 14 });
  impossibleV2Active.catalog = { version: GRAMMAR_CATALOG_V2.version, revision: GRAMMAR_CATALOG_V2.revision };
  const impossibleV2Event = {
    ...activeEvent,
    id: impossibleV2Active.id,
    typeScores: scoresFromSession(impossibleV2Active),
    session: impossibleV2Active,
  };
  assert.deepEqual({
    runtime: grammarMasteryEventSchema.safeParse({ topicId: 14, event: impossibleV2Event }).success,
    openapi: validateRequest({ topicId: 14, event: impossibleV2Event }),
  }, { runtime: false, openapi: false },
  'v2 cannot claim topic practice that was introduced only by Ticket06');

  const impossibleCurrentLegacy = structuredClone(legacyEvent);
  impossibleCurrentLegacy.id = '00000000-0000-4000-8000-000000009025';
  impossibleCurrentLegacy.session.id = impossibleCurrentLegacy.id;
  impossibleCurrentLegacy.session.catalog = {
    version: GRAMMAR_CATALOG.version,
    revision: GRAMMAR_CATALOG.revision,
  };
  assert.deepEqual({
    runtime: grammarMasteryEventSchema.safeParse({ topicId: 14, event: impossibleCurrentLegacy }).success,
    openapi: validateRequest({ topicId: 14, event: impossibleCurrentLegacy }),
  }, { runtime: false, openapi: false },
  'current v3 cannot masquerade as a pre-activation legacy identity');
});

test('generated OpenAPI catalog unions match every registered runtime and active topic', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateRequest = compileOpenApiSchema(openapi, 'GrammarMasteryEventRequest');
  const validateActiveSession = compileOpenApiSchema(openapi, 'GrammarActivePracticeSession');
  const validateLegacySession = compileOpenApiSchema(openapi, 'GrammarLegacyPracticeSession');

  for (const [runtimeIndex, runtime] of GRAMMAR_CATALOG_RUNTIMES.entries()) {
    const identity = {
      version: runtime.catalog.version,
      revision: runtime.catalog.revision,
    };
    for (const topicId of GRAMMAR_ACTIVE_TOPIC_IDS) {
      const session = practiceSession(
        `00000000-0000-4000-8000-${String(9100 + runtimeIndex * 20 + topicId).padStart(12, '0')}`,
        { topicId },
      );
      session.catalog = identity;
      const event = {
        id: session.id, type: 'session_completed', expectedRevision: 0,
        expectedStage: 'not_started', expectedReviewStep: 0,
        source: 'builtin', assisted: false,
        completedTypes: ['choice', 'input', 'correction', 'transform'],
        typeScores: scoresFromSession(session), session,
      };
      const runtimeAccepted = grammarMasteryEventSchema.safeParse({ topicId, event }).success;
      assert.equal(runtimeAccepted, runtime.hasActivePractice(topicId),
        `${identity.version} topic ${topicId} runtime capability`);
      assert.equal(validateRequest({ topicId, event }), runtimeAccepted,
        `${identity.version} topic ${topicId} generated request parity: ${JSON.stringify(validateRequest.errors)}`);
    }

    const activeSession = practiceSession(
      `00000000-0000-4000-8000-${String(9200 + runtimeIndex).padStart(12, '0')}`,
      { topicId: 1 },
    );
    activeSession.catalog = identity;
    assert.equal(validateActiveSession(activeSession), runtime.hasActivePractice(1),
      `${identity.version} generated active-session catalog union`);

    const legacySession = legacyPracticeEvent(
      `00000000-0000-4000-8000-${String(9210 + runtimeIndex).padStart(12, '0')}`,
      14,
    ).session;
    legacySession.catalog = identity;
    assert.equal(validateLegacySession(legacySession), true,
      `${identity.version} generated immutable legacy-session catalog union`);
  }
});

test('Grammar OpenAPI accepts assisted wrong-choice diagnostics for every parts-of-speech topic', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateRequest = compileOpenApiSchema(openapi, 'GrammarMasteryEventRequest');
  const accepted = {};
  for (const topicId of GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS) {
    const id = `00000000-0000-4000-8000-${String(900 + topicId).padStart(12, '0')}`;
    const session = addCorrectTransfers(practiceSession(id, {
      topicId,
      assisted: true,
      typeScores: {
        choice: { correct: 3, total: 4 },
        input: { correct: 4, total: 4 },
        correction: { correct: 4, total: 4 },
        transform: { correct: 4, total: 4 },
      },
    }), topicId);
    const event = {
      id, type: 'session_completed', expectedRevision: 0,
      expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: true,
      completedTypes: ['choice', 'input', 'correction', 'transform'],
      typeScores: scoresFromSession(session), session,
    };
    assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event }).success, true,
      `runtime accepts the authored topic ${topicId} diagnostic`);
    accepted[topicId] = validateRequest({ topicId, event });
  }
  assert.deepEqual(accepted, Object.fromEntries(GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS.map((topicId) => [topicId, true])),
    `OpenAPI accepts every authored parts-of-speech diagnostic: ${JSON.stringify(validateRequest.errors)}`);
});

test('Grammar OpenAPI couples session and review diagnostics to every active topic', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  assert.equal((openapi.match(/^    GrammarActiveDiagnosticId:$/gmu) || []).length, 1,
    'the active diagnostic whitelist has one OpenAPI source of truth');
  assert.equal((openapi.match(/\$ref: '#\/components\/schemas\/GrammarActiveDiagnosticId'/gu) || []).length, 3,
    'built-in items, generated items, and independent errors reuse the active diagnostic whitelist');
  const validateRequest = compileOpenApiSchema(openapi, 'GrammarMasteryEventRequest');
  const parity = {};

  for (const [index, topicId] of GRAMMAR_ACTIVE_TOPIC_IDS.entries()) {
    const otherTopicId = GRAMMAR_ACTIVE_TOPIC_IDS[(index + 1) % GRAMMAR_ACTIVE_TOPIC_IDS.length];
    const id = `00000000-0000-4000-8000-${String(940 + topicId).padStart(12, '0')}`;
    const session = practiceSession(id, {
      topicId,
      assisted: true,
      typeScores: {
        choice: { correct: 3, total: 4 },
        input: { correct: 4, total: 4 },
        correction: { correct: 4, total: 4 },
        transform: { correct: 4, total: 4 },
      },
    });
    const wrong = session.items.find((item) => item.type === 'choice' && !item.correct);
    const wrongCatalogItem = GRAMMAR_CATALOG.bank[topicId].c.find((item) => item.id === wrong.id);
    const exactDiagnostic = wrongCatalogItem.diagnostics.find((diagnostic) => diagnostic
      && diagnostic.errorCode === wrongCatalogItem.errorSkill
      && (diagnostic.confusionPair || null) === (wrongCatalogItem.confusionPair || null));
    Object.assign(wrong, {
      diagnosticId: exactDiagnostic.id,
      errorCode: exactDiagnostic.errorCode,
      confusionPair: exactDiagnostic.confusionPair || null,
    });
    addCorrectTransfers(session, topicId);
    const evidence = {
      itemId: wrong.id, diagnosticId: wrong.diagnosticId,
      reason: wrong.errorCode, confusionPair: wrong.confusionPair,
    };
    const event = {
      id, type: 'session_completed', expectedRevision: 1,
      expectedStage: 'learned', expectedReviewStep: 0,
      source: 'builtin', assisted: true,
      completedTypes: ['choice', 'input', 'correction', 'transform'],
      typeScores: scoresFromSession(session), session, independentError: evidence,
    };
    const review = {
      id: `00000000-0000-4000-8000-${String(980 + topicId).padStart(12, '0')}`,
      type: 'review_completed', expectedRevision: 1,
      expectedStage: 'learned', expectedReviewStep: 0,
      source: 'builtin', assisted: true, passed: false, independentError: evidence,
    };
    const otherEvidence = independentChoiceError(otherTopicId);
    const crossSession = structuredClone(event);
    const crossWrong = crossSession.session.items.find((item) => item.id === evidence.itemId);
    crossWrong.diagnosticId = otherEvidence.diagnosticId;
    crossSession.independentError.diagnosticId = otherEvidence.diagnosticId;
    const crossReview = structuredClone(review);
    crossReview.independentError = otherEvidence;
    const sameTopicItem = GRAMMAR_CATALOG.bank[topicId].c.find((item) => item.id !== evidence.itemId);
    const sameTopicEvidence = independentChoiceError(topicId, sameTopicItem);
    const crossItemSession = structuredClone(event);
    const crossItemWrong = crossItemSession.session.items.find((item) => item.id === evidence.itemId);
    Object.assign(crossItemWrong, {
      diagnosticId: sameTopicEvidence.diagnosticId,
      errorCode: sameTopicEvidence.reason,
      confusionPair: sameTopicEvidence.confusionPair,
    });
    crossItemSession.independentError = { ...sameTopicEvidence, itemId: evidence.itemId };
    const crossItemReview = structuredClone(review);
    crossItemReview.independentError = { ...sameTopicEvidence, itemId: evidence.itemId };

    const runtime = {
      session: grammarMasteryEventSchema.safeParse({ topicId, event }).success,
      review: grammarMasteryEventSchema.safeParse({ topicId, event: review }).success,
      crossSession: grammarMasteryEventSchema.safeParse({ topicId, event: crossSession }).success,
      crossReview: grammarMasteryEventSchema.safeParse({ topicId, event: crossReview }).success,
      crossItemSession: grammarMasteryEventSchema.safeParse({ topicId, event: crossItemSession }).success,
      crossItemReview: grammarMasteryEventSchema.safeParse({ topicId, event: crossItemReview }).success,
    };
    assert.deepEqual(runtime, {
      session: true, review: true, crossSession: false, crossReview: false,
      crossItemSession: false, crossItemReview: false,
    },
      `runtime diagnostic ownership for active topic ${topicId}`);
    parity[topicId] = {
      session: validateRequest({ topicId, event }),
      review: validateRequest({ topicId, event: review }),
      crossSession: validateRequest({ topicId, event: crossSession }),
      crossReview: validateRequest({ topicId, event: crossReview }),
      crossItemSession: validateRequest({ topicId, event: crossItemSession }),
      crossItemReview: validateRequest({ topicId, event: crossItemReview }),
    };
  }

  const expected = Object.fromEntries(GRAMMAR_ACTIVE_TOPIC_IDS.map((topicId) => [topicId, {
    session: true, review: true, crossSession: false, crossReview: false,
    crossItemSession: false, crossItemReview: false,
  }]));
  assert.deepEqual(parity, expected, 'OpenAPI matches runtime diagnostic ownership for all active topics');
});

test('Grammar OpenAPI binds every active diagnostic to its exact catalog item', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateOwnership = compileOpenApiSchema(openapi, 'GrammarActiveItemDiagnosticOwnership');
  const validateCatalogItemId = compileOpenApiSchema(openapi, 'GrammarBuiltinCatalogItemId');
  const catalogIds = Object.values(GRAMMAR_CATALOG.bank).flatMap((levels) => (
    ['c', 'c2', 'f', 'correction', 'transform'].flatMap((kind) => levels[kind] || [])
  )).map((item) => item.id);
  for (const itemId of catalogIds) {
    assert.equal(validateCatalogItemId(itemId), true, `${itemId} is an exact built-in catalog pointer`);
  }
  assert.equal(validateCatalogItemId('core.g.10.c2.1'), false,
    'the public contract cannot invent an absent active pointer');
  const choices = GRAMMAR_ACTIVE_TOPIC_IDS.flatMap((topicId) => GRAMMAR_CATALOG.bank[topicId].c);
  for (const item of choices) {
    const topicId = Number(item.id.match(/^core\.g\.(\d+)\./u)?.[1]);
    const other = choices.find((candidate) => candidate.id !== item.id
      && candidate.id.startsWith(`core.g.${topicId}.`));
    for (const diagnostic of item.diagnostics.filter(Boolean)) {
      const sessionTuple = {
        id: item.id, diagnosticId: diagnostic.id,
        correct: false,
        errorCode: diagnostic.errorCode, confusionPair: diagnostic.confusionPair || null,
      };
      const reviewTuple = {
        itemId: item.id, diagnosticId: diagnostic.id,
        reason: diagnostic.errorCode, confusionPair: diagnostic.confusionPair || null,
      };
      assert.equal(validateOwnership(sessionTuple), true,
        `session item owns ${diagnostic.id}`);
      assert.equal(validateOwnership(reviewTuple), true,
        `independent error owns ${diagnostic.id}`);
      assert.equal(validateOwnership({ ...sessionTuple, id: other.id }), false,
        `${other.id} cannot borrow ${diagnostic.id}`);
      assert.equal(validateOwnership({ ...reviewTuple, itemId: other.id }), false,
        `${other.id} independent error cannot borrow ${diagnostic.id}`);
      const forgedReason = diagnostic.errorCode === 'auxiliary' ? 'agreement' : 'auxiliary';
      assert.equal(validateOwnership({ ...sessionTuple, errorCode: forgedReason }), false,
        `${diagnostic.id} session tuple cannot forge its weakness`);
      assert.equal(validateOwnership({ ...reviewTuple, reason: forgedReason }), false,
        `${diagnostic.id} review tuple cannot forge its weakness`);
    }
    assert.equal(validateOwnership({ id: item.id, diagnosticId: `${item.id}.diagnostic.99` }), false,
      `${item.id} cannot invent a selected-option diagnostic`);
  }
  assert.equal(validateOwnership({
    id: 'core.g.10.f.1', correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null,
  }), true, 'correct text outcomes retain the explicit clean null-diagnostic branch');
});

test('Grammar OpenAPI binds every active text item to its exact weakness tuple', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateOwnership = compileOpenApiSchema(openapi, 'GrammarActiveItemDiagnosticOwnership');
  const textItems = GRAMMAR_ACTIVE_TOPIC_IDS.flatMap((topicId) => (
    ['f', 'correction', 'transform'].flatMap((kind) => GRAMMAR_CATALOG.bank[topicId][kind])
  ));
  for (const item of textItems) {
    const topicId = Number(item.id.match(/^core\.g\.(\d+)\./u)?.[1]);
    const preActivationLegacyReview = GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS.includes(topicId)
      && item.provenance === 'grammar-1-migrated';
    const exactSession = {
      diagnosticId: null, confusionPair: item.confusionPair || null,
    };
    assert.equal(validateOwnership({
      ...exactSession, id: item.id, correct: false, errorCode: item.errorSkill,
    }), true, `${item.id} owns its wrong session weakness`);
    const reviewReason = item.errorSkill;
    const reviewPair = item.confusionPair || null;
    assert.equal(validateOwnership({
      itemId: item.id, diagnosticId: null, reason: reviewReason, confusionPair: reviewPair,
    }), true, `${item.id} owns its current independent review weakness`);
    if (preActivationLegacyReview) {
      assert.equal(validateOwnership({
        itemId: item.id, diagnosticId: null,
        reason: 'word_or_verb_form', confusionPair: null,
      }), true, `${item.id} retains its bounded historical independent review weakness`);
    }
    const forgedReason = item.errorSkill === 'auxiliary' ? 'agreement' : 'auxiliary';
    assert.equal(validateOwnership({
      ...exactSession, id: item.id, correct: false, errorCode: forgedReason,
    }), false, `${item.id} session cannot forge its weakness`);
    assert.equal(validateOwnership({
      itemId: item.id, diagnosticId: null, reason: forgedReason, confusionPair: reviewPair,
    }), false, `${item.id} review cannot forge its weakness`);
    assert.equal(validateOwnership({
      id: item.id, correct: true, diagnosticId: null, errorCode: null, confusionPair: null,
    }), true, `${item.id} still accepts a correct clean session outcome`);
  }
  assert.equal(textItems.length, GRAMMAR_ACTIVE_TOPIC_IDS.length * 24);
});

test('Grammar runtime and OpenAPI require exact active independent-error evidence', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateRequest = compileOpenApiSchema(openapi, 'GrammarMasteryEventRequest');
  const topicId = 10;

  const wrongSession = addCorrectTransfers(practiceSession(
    '00000000-0000-4000-8000-000000001022',
    {
      topicId, assisted: true,
      typeScores: {
        choice: { correct: 3, total: 4 }, input: { correct: 4, total: 4 },
        correction: { correct: 4, total: 4 }, transform: { correct: 4, total: 4 },
      },
    },
  ), topicId);
  const wrong = wrongSession.items.find((item) => item.type === 'choice' && !item.correct);
  const evidence = {
    itemId: wrong.id, diagnosticId: wrong.diagnosticId,
    reason: wrong.errorCode, confusionPair: wrong.confusionPair,
  };
  const exactSessionEvent = {
    id: wrongSession.id, type: 'session_completed', expectedRevision: 1,
    expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: true,
    completedTypes: ['choice', 'input', 'correction', 'transform'],
    typeScores: scoresFromSession(wrongSession), session: wrongSession, independentError: evidence,
  };
  const exactReviewEvent = {
    id: '00000000-0000-4000-8000-000000001023', type: 'review_completed',
    expectedRevision: 1, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: true, passed: false, independentError: evidence,
  };
  assert.deepEqual({
    runtimeSession: grammarMasteryEventSchema.safeParse({ topicId, event: exactSessionEvent }).success,
    openapiSession: validateRequest({ topicId, event: exactSessionEvent }),
    runtimeReview: grammarMasteryEventSchema.safeParse({ topicId, event: exactReviewEvent }).success,
    openapiReview: validateRequest({ topicId, event: exactReviewEvent }),
  }, { runtimeSession: true, openapiSession: true, runtimeReview: true, openapiReview: true },
  `exact evidence stays accepted: ${JSON.stringify(validateRequest.errors)}`);

  const currentTextSession = practiceSession(
    '00000000-0000-4000-8000-000000001028', { topicId, assisted: true },
  );
  const currentTextItem = GRAMMAR_CATALOG.bank[topicId].f.find((item) => item.id === 'core.g.10.f.1');
  const currentTextOutcome = currentTextSession.items.find((item) => (
    item.type === 'input'
    && GRAMMAR_CATALOG.bank[topicId].f.find((candidate) => candidate.id === item.id)?.transferPair
      === currentTextItem.transferPair
  ));
  Object.assign(currentTextOutcome, {
    id: currentTextItem.id, correct: false, errorCode: currentTextItem.errorSkill,
    confusionPair: currentTextItem.confusionPair || null,
  });
  addCorrectTransfers(currentTextSession, topicId);
  const currentTextEvidence = {
    itemId: currentTextItem.id, diagnosticId: null,
    reason: currentTextItem.errorSkill, confusionPair: currentTextItem.confusionPair || null,
  };
  const currentTextSessionEvent = {
    id: currentTextSession.id, type: 'session_completed', expectedRevision: 1,
    expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: true,
    completedTypes: ['choice', 'input', 'correction', 'transform'],
    typeScores: scoresFromSession(currentTextSession), session: currentTextSession,
    independentError: currentTextEvidence,
  };
  const currentTextReviewEvent = {
    id: '00000000-0000-4000-8000-000000001029', type: 'review_completed',
    expectedRevision: 1, expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: true, passed: false,
    independentError: currentTextEvidence,
  };
  assert.deepEqual({
    runtimeSession: grammarMasteryEventSchema.safeParse({ topicId, event: currentTextSessionEvent }).success,
    openapiSession: validateRequest({ topicId, event: currentTextSessionEvent }),
    runtimeReview: grammarMasteryEventSchema.safeParse({ topicId, event: currentTextReviewEvent }).success,
    openapiReview: validateRequest({ topicId, event: currentTextReviewEvent }),
  }, { runtimeSession: true, openapiSession: true, runtimeReview: true, openapiReview: true },
  `current migrated text evidence stays accepted: ${JSON.stringify(validateRequest.errors)}`);

  const forgedReason = wrong.errorCode === 'auxiliary' ? 'agreement' : 'auxiliary';
  const forgedSessionEvent = structuredClone(exactSessionEvent);
  const forgedOutcome = forgedSessionEvent.session.items.find((item) => item.id === evidence.itemId);
  forgedOutcome.errorCode = forgedReason;
  forgedSessionEvent.independentError.reason = forgedReason;
  const forgedReviewEvent = structuredClone(exactReviewEvent);
  forgedReviewEvent.independentError.reason = forgedReason;

  const absentItem = GRAMMAR_CATALOG.bank[topicId].c.find((item) => (
    !exactSessionEvent.session.items.some((outcome) => outcome.id === item.id)
  ));
  const allCorrectSession = practiceSession(
    '00000000-0000-4000-8000-000000001024', { topicId, assisted: true },
  );
  const outOfSessionEvent = {
    id: allCorrectSession.id, type: 'session_completed', expectedRevision: 1,
    expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: true,
    completedTypes: ['choice', 'input', 'correction', 'transform'],
    typeScores: scoresFromSession(allCorrectSession), session: allCorrectSession,
    independentError: independentChoiceError(topicId, absentItem),
  };

  const activeChoice = GRAMMAR_CATALOG.bank[topicId].c.find((item) => item.provenance !== 'grammar-1-migrated');
  const nullChoiceReview = {
    ...exactReviewEvent,
    id: '00000000-0000-4000-8000-000000001025',
    independentError: {
      itemId: activeChoice.id, diagnosticId: null,
      reason: activeChoice.errorSkill, confusionPair: activeChoice.confusionPair || null,
    },
  };

  const nonexistentPointerEvent = structuredClone({ ...exactSessionEvent, independentError: undefined });
  delete nonexistentPointerEvent.independentError;
  const replaced = nonexistentPointerEvent.session.items.find((item) => item.type === 'choice');
  replaced.id = 'core.g.10.c2.1';

  const preActivationCrossTopic = assistedLegacyPracticeEvent(
    '00000000-0000-4000-8000-000000001026', topicId,
  );
  preActivationCrossTopic.independentError = {
    itemId: 'core.g.11.c.1', diagnosticId: null,
    reason: 'construction_choice', confusionPair: null,
  };

  const wrongTextSession = addCorrectTransfers(practiceSession(
    '00000000-0000-4000-8000-000000001027',
    {
      topicId, assisted: true,
      typeScores: {
        choice: { correct: 4, total: 4 }, input: { correct: 3, total: 4 },
        correction: { correct: 4, total: 4 }, transform: { correct: 4, total: 4 },
      },
    },
  ), topicId);
  const wrongText = wrongTextSession.items.find((item) => item.type === 'input' && !item.correct);
  Object.assign(wrongText, { errorCode: 'auxiliary', confusionPair: 'be__have' });
  const forgedTextEvent = {
    id: wrongTextSession.id, type: 'session_completed', expectedRevision: 1,
    expectedStage: 'learned', expectedReviewStep: 0,
    source: 'builtin', assisted: true,
    completedTypes: ['choice', 'input', 'correction', 'transform'],
    typeScores: scoresFromSession(wrongTextSession), session: wrongTextSession,
    independentError: {
      itemId: wrongText.id, diagnosticId: null,
      reason: wrongText.errorCode, confusionPair: wrongText.confusionPair,
    },
  };

  const rejected = {
    forgedSession: forgedSessionEvent,
    forgedReview: forgedReviewEvent,
    outOfSession: outOfSessionEvent,
    nullActiveChoiceReview: nullChoiceReview,
    nonexistentActivePointer: nonexistentPointerEvent,
    preActivationCrossTopic,
    forgedActiveTextTuple: forgedTextEvent,
  };
  for (const [name, event] of Object.entries(rejected)) {
    assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event }).success, false,
      `runtime rejects ${name}`);
    assert.equal(validateRequest({ topicId, event }), false,
      `OpenAPI rejects ${name}: ${JSON.stringify(validateRequest.errors)}`);
  }
});

test('queued pre-activation review evidence retains its bounded legacy pointer contract', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateRequest = compileOpenApiSchema(openapi, 'GrammarMasteryEventRequest');
  const event = {
    id: '00000000-0000-4000-8000-000000001021', type: 'review_completed',
    expectedRevision: 9, expectedStage: 'stable', expectedReviewStep: 5,
    source: 'builtin', assisted: true, passed: false,
    independentError: {
      itemId: 'core.g.10.c.1', diagnosticId: null,
      reason: 'construction_choice', confusionPair: null,
    },
  };
  const parsed = grammarMasteryEventSchema.safeParse({ topicId: 10, event });
  assert.deepEqual({ runtime: parsed.success, openapi: validateRequest({ topicId: 10, event }) },
    { runtime: true, openapi: true },
    `queued Grammar 1 review evidence survives activation: ${JSON.stringify(parsed.error?.issues || validateRequest.errors)}`);
  const regressed = EasyBoostGrammar.reduceMastery({
    masteryVersion: 2, masteryRevision: 9, stage: 'stable', reviewStep: 5,
    highestReviewStep: 5, eligibleAt: null,
  }, parsed.data.event, { now: 20_000, clockAuthority: 'server' });
  assert.equal(regressed.stage, 'confirmed');
  assert.equal(regressed.lastRegressionReason, 'construction_choice');

  const currentItem = GRAMMAR_CATALOG.bank[10].f.find((item) => item.id === 'core.g.10.f.1');
  const currentEvent = {
    ...event,
    id: '00000000-0000-4000-8000-000000001030',
    independentError: {
      itemId: currentItem.id, diagnosticId: null,
      reason: currentItem.errorSkill, confusionPair: currentItem.confusionPair || null,
    },
  };
  const currentParsed = grammarMasteryEventSchema.safeParse({ topicId: 10, event: currentEvent });
  assert.deepEqual({
    runtime: currentParsed.success,
    openapi: validateRequest({ topicId: 10, event: currentEvent }),
  }, { runtime: true, openapi: true },
  `the current review runner's exact migrated-item weakness remains valid: ${JSON.stringify(currentParsed.error?.issues || validateRequest.errors)}`);
});

test('Grammar OpenAPI evaluator binds each built-in pointer kind to its runtime type', async () => {
  const openapi = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  const validateBuiltinItem = compileOpenApiSchema(openapi, 'GrammarBuiltinPracticeSessionItem');
  const builtinExamples = [
    ['core.g.1.c.1', 'choice', true],
    ['core.g.8.c2.1', 'choice', true],
    ['core.g.1.c2.1', 'choice', false],
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
