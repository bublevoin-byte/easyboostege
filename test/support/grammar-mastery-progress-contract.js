import assert from 'node:assert/strict';
import {
  GRAMMAR_CATALOG, GRAMMAR_CATALOG_V1, GRAMMAR_CATALOG_V2, validateGeneratedGrammarSupplement,
} from '../../public/grammar-catalog.js';
import { EasyBoostGrammar } from '../../public/modules/grammar.js';
import { grammarMasteryEventSchema } from '../../validation/grammar-mastery.js';
import { decorateGeneratedVoiceTutorContent } from '../../voice-tutor/generated-items.js';

const TYPE_SCORES = Object.freeze({
  choice: { correct: 4, total: 4 },
  input: { correct: 4, total: 4 },
  correction: { correct: 4, total: 4 },
  transform: { correct: 4, total: 4 },
});

function selectedPracticeEvent(queue, {
  id, mode, topicId, revision, stage, reviewStep, topicExpectations = null, recommendation = null,
}) {
  const mixed = mode === 'mixed_practice';
  const items = queue.map((entry) => ({
    id: entry.q.id, ...(mixed ? { topicId: entry.t } : {}),
    type: entry.k, transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  }));
  const completedTypes = [...new Set(items.map((item) => item.type))];
  const typeScores = Object.fromEntries(completedTypes.map((type) => {
    const total = items.filter((item) => item.type === type).length;
    return [type, { correct: total, total }];
  }));
  return {
    topicId,
    event: {
      id, type: 'session_completed', expectedRevision: revision,
      expectedStage: stage, expectedReviewStep: reviewStep,
      source: 'builtin', assisted: false, completedTypes, typeScores,
      session: {
        id, scope: mixed ? 'mixed' : 'topic', mode, source: 'builtin',
        catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
        items, startedAt: 3_500, assisted: false,
        ...(mixed ? { topicExpectations } : {}),
        ...(mode === 'targeted_practice' ? { recommendation } : {}),
      },
    },
  };
}

function independentCatalogError(topicId) {
  const item = GRAMMAR_CATALOG.bank[topicId].c[0];
  const diagnostic = item.diagnostics?.find((candidate, index) => index !== item.a && candidate) || null;
  return {
    itemId: item.id,
    diagnosticId: diagnostic?.id || null,
    reason: diagnostic?.errorCode || item.errorSkill || 'construction_choice',
    confusionPair: diagnostic?.confusionPair || item.confusionPair || null,
  };
}

function practiceSession(id, typeScores = TYPE_SCORES) {
  const kinds = { choice: 'c', input: 'f', correction: 'correction', transform: 'transform' };
  return {
    id, scope: 'topic', mode: 'topic_practice', source: 'builtin',
    catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
    items: Object.entries(typeScores).flatMap(([type, score]) => GRAMMAR_CATALOG.bank[1][kinds[type]]
      .slice(0, score.total).map((item, index) => {
        const correct = index < score.correct;
        return {
          id: item.id, type, transfer: false, correct,
          diagnosticId: null,
          errorCode: correct ? null : item.errorSkill,
          confusionPair: correct ? null : (item.confusionPair || null),
          transferStatus: null,
        };
      })),
    startedAt: 1_000,
    assisted: false,
  };
}

function assistedDueSession(id, topicId = 2) {
  const levels = GRAMMAR_CATALOG.bank[topicId];
  const items = [];
  [['c', 'choice'], ['f', 'input'], ['correction', 'correction'], ['transform', 'transform']].forEach(([kind, type]) => {
    const pairs = new Map();
    levels[kind].forEach((item) => {
      if (!pairs.has(item.transferPair)) pairs.set(item.transferPair, []);
      pairs.get(item.transferPair).push(item);
    });
    pairs.forEach(([original, transfer]) => {
      const diagnostic = type === 'choice' ? original.diagnostics.find(Boolean) : null;
      const transferDiagnostic = type === 'choice' ? transfer.diagnostics.find((candidate) => candidate
        && candidate.errorCode === diagnostic.errorCode
        && (candidate.confusionPair || null) === (diagnostic.confusionPair || null)) : null;
      const errorCode = diagnostic?.errorCode || original.errorSkill;
      const confusionPair = diagnostic?.confusionPair || original.confusionPair || null;
      items.push({
        id: original.id, type, transfer: false, correct: false,
        diagnosticId: diagnostic?.id || null, errorCode, confusionPair, transferStatus: null,
      }, {
        id: transfer.id, type, transfer: true, correct: false,
        diagnosticId: transferDiagnostic?.id || null, errorCode, confusionPair,
        transferStatus: 'due_next_session',
      });
    });
  });
  const typeScores = Object.fromEntries(['choice', 'input', 'correction', 'transform'].map((type) => {
    const outcomes = items.filter((item) => item.type === type);
    return [type, { correct: outcomes.filter((item) => item.correct).length, total: outcomes.length }];
  }));
  return {
    typeScores,
    session: {
      id, scope: 'topic', mode: 'topic_practice', source: 'builtin',
      catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
      items, startedAt: 1_500, assisted: true,
    },
  };
}

function legacySession(id, { assisted = false, wrongRetry = false } = {}) {
  const topicId = 14;
  const originals = GRAMMAR_CATALOG_V1.bank[topicId].c.slice(0, wrongRetry ? 1 : 4);
  const items = originals.map((item) => ({
    id: item.id, type: item.type, transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  }));
  if (wrongRetry) {
    items[0].correct = false;
    items[0].errorCode = 'construction_choice';
    items.push({ ...items[0], correct: true, errorCode: null });
  }
  const typeScores = Object.fromEntries(['choice'].map((type) => {
    const outcomes = items.filter((item) => item.type === type);
    return [type, { correct: outcomes.filter((item) => item.correct).length, total: outcomes.length }];
  }).filter(([, score]) => score.total > 0));
  return {
    id, type: 'session_completed', expectedRevision: wrongRetry ? 1 : 0,
    expectedStage: wrongRetry ? 'learning' : 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted, completedTypes: Object.keys(typeScores), typeScores,
    session: {
      id, scope: 'topic', mode: 'legacy_practice', source: 'builtin',
      catalog: { version: GRAMMAR_CATALOG_V1.version, revision: GRAMMAR_CATALOG_V1.revision },
      items, startedAt: wrongRetry ? 2_500 : 2_000, assisted,
    },
  };
}

function generatedLegacyFixture(id) {
  const requestHash = 'd'.repeat(64);
  const result = {
    c: Array.from({ length: 3 }, (_, index) => ({
      t: [`Generated contract choice ${index + 1}: She `, ' every day.'],
      o: ['go', 'goes', 'going', 'went'], a: 1, e: 'Present Simple.',
    })),
    f: Array.from({ length: 3 }, (_, index) => ({
      s: `Generated contract input ${index + 1}: She _____ (GO) every day.`,
      b: 'GO', ans: ['goes'], e: 'Third person singular.',
    })),
  };
  const decorated = decorateGeneratedVoiceTutorContent('grammar_topic_set', requestHash, result);
  const item = decorated.c[0];
  const inputItem = decorated.f[0];
  const event = {
    id, type: 'session_completed', expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'generated', assisted: true, completedTypes: ['choice', 'input'],
    typeScores: { choice: { correct: 1, total: 1 }, input: { correct: 1, total: 1 } },
    session: {
      id, scope: 'topic', mode: 'legacy_practice', source: 'generated',
      catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
      items: [{
        id: item.voice.id, type: 'choice', transfer: false, correct: true,
        diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
        source: 'generated', revision: 1,
      }, {
        id: inputItem.voice.id, type: 'input', transfer: false, correct: true,
        diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
        source: 'generated', revision: 1,
      }],
      startedAt: 3_000, assisted: true,
    },
  };
  return {
    requestHash, result, event,
    task: {
      operation: 'grammar_topic_set', requestHash,
      request: { operation: 'grammar_topic_set', topicId: 5, topic: 'Shared contract generated' },
      result, provider: 'fixture', promptVersion: 'fixture-v1',
    },
  };
}

function examEventFixture(id, form, records, { source = 'builtin', wrongFirst = false } = {}) {
  const topicIds = [...new Set(form.gaps.map((gap) => Number(gap.t)))];
  const topicExpectations = topicIds.map((topicId) => {
    const record = EasyBoostGrammar.migrateMasteryRecord(records?.[topicId]);
    return {
      topicId, expectedRevision: record.masteryRevision,
      expectedStage: record.stage, expectedReviewStep: record.reviewStep,
    };
  });
  const items = form.gaps.map((gap, index) => ({
    id: gap.id, topicId: Number(gap.t), type: 'input', transfer: false,
    correct: !(wrongFirst && index === 0), diagnosticId: null,
    errorCode: wrongFirst && index === 0 ? 'word_or_verb_form' : null,
    confusionPair: null, transferStatus: null,
    ...(source === 'generated' ? { source: 'generated', revision: 1 } : {}),
  }));
  const owner = topicExpectations[0];
  return {
    topicId: owner.topicId,
    event: {
      id, type: 'session_completed', expectedRevision: owner.expectedRevision,
      expectedStage: owner.expectedStage, expectedReviewStep: owner.expectedReviewStep,
      source, assisted: source === 'generated' || wrongFirst,
      completedTypes: ['input'],
      typeScores: { input: { correct: wrongFirst ? 5 : 6, total: 6 } },
      session: {
        id, scope: 'mixed', mode: 'exam_19_24', source,
        catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
        items, startedAt: 3_800, assisted: source === 'generated' || wrongFirst, topicExpectations,
      },
      ...(wrongFirst ? { independentErrors: [{
        topicId: items[0].topicId, itemId: items[0].id,
        diagnosticId: null, reason: 'word_or_verb_form', confusionPair: null,
      }] } : {}),
    },
  };
}

function examEntries(payload) {
  return payload.event.session.topicExpectations.map((expectation) => ({
    topicId: expectation.topicId,
    event: {
      ...payload.event,
      expectedRevision: expectation.expectedRevision,
      expectedStage: expectation.expectedStage,
      expectedReviewStep: expectation.expectedReviewStep,
    },
  }));
}

export const GRAMMAR_MASTERY_FIXTURE = Object.freeze({
  masteryVersion: 2,
  masteryRevision: 0,
  stage: 'learned',
  reviewStep: 0,
  highestReviewStep: 0,
  eligibleAt: 1,
  stats: { correct: 14, errors: 3, advancedStreak: 4, assistedAttempts: 0 },
  legacy: { st: 2, ok: 14, err: 3, sr: 4, rs: 2, due: 1 },
  recentEventIds: [],
  masteryHistory: [],
  lastStageAt: null,
  lastAttemptAt: null,
  lastRegressionReason: null,
});

export async function assertGrammarMasteryProgressContract(repository, owner, stranger) {
  assert.deepEqual({
    currentVersion: GRAMMAR_CATALOG.version,
    currentRevision: GRAMMAR_CATALOG.revision,
    historicalVersion: GRAMMAR_CATALOG_V2.version,
    historicalRevision: GRAMMAR_CATALOG_V2.revision,
  }, {
    currentVersion: 'grammar-core-v3', currentRevision: 3,
    historicalVersion: 'grammar-core-v2', historicalRevision: 2,
  }, 'persistence fixtures bind current v3 separately from immutable pre-Ticket06 v2');
  await repository.saveProgress(owner, {
    gram: { 1: { st: 2, ok: 14, err: 3, sr: 4, rs: 2, due: 1 } },
    grammarRunner: { schema: 'grammar-runner-v1', sessionId: 'device-only-save' },
    words: { learned: 7 },
  });
  assert.equal(Object.hasOwn(await repository.getProgress(owner), 'grammarRunner'), false,
    'a device-local runner is never stored by generic full progress save');
  await repository.mergeProgress(owner, {
    grammarRunner: { schema: 'grammar-runner-v1', sessionId: 'device-only-merge' },
  });
  assert.equal(Object.hasOwn(await repository.getProgress(owner), 'grammarRunner'), false,
    'a device-local runner is never stored by generic module merge');
  const firstMigration = await repository.migrateGrammarMastery(owner);
  const secondMigration = await repository.migrateGrammarMastery(owner);
  assert.deepEqual(firstMigration['1'], GRAMMAR_MASTERY_FIXTURE);
  assert.deepEqual(secondMigration, firstMigration, 'legacy migration must be idempotent');
  assert.deepEqual(await repository.getProgress(stranger), {});

  await repository.mergeProgress(stranger, { gram: { 20: { st: 2, due: 1 } } });
  const lateBefore = (await repository.migrateGrammarMastery(stranger))['20'];
  const lateEvidence = independentCatalogError(20);
  const lateEvent = {
    id: '00000000-0000-4000-8000-000000000090', type: 'review_completed',
    expectedRevision: lateBefore.masteryRevision, expectedStage: lateBefore.stage,
    expectedReviewStep: lateBefore.reviewStep,
    source: 'builtin', assisted: true, passed: false, independentError: lateEvidence,
  };
  const parsedLate = grammarMasteryEventSchema.safeParse({ topicId: 20, event: lateEvent });
  assert.equal(parsedLate.success, true, JSON.stringify(parsedLate.error?.issues));
  const lateResult = await repository.applyGrammarMasteryEvent(stranger, 20, parsedLate.data.event);
  assert.equal(lateResult.applied, true);
  assert.equal(lateResult.record.stage, 'learned');
  assert.equal(lateResult.record.lastRegressionReason, lateEvidence.reason);
  assert.ok(lateResult.record.eligibleAt >= lateBefore.eligibleAt,
    'file/PostgreSQL both keep the independently observed late weakness due after disclosure');
  const forgedLate = structuredClone(lateEvent);
  forgedLate.id = '00000000-0000-4000-8000-000000000091';
  forgedLate.independentError.reason = lateEvidence.reason === 'agreement' ? 'auxiliary' : 'agreement';
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 20, event: forgedLate }).success, false,
    'the client cannot manufacture an unrelated regression reason');

  const baseEvent = {
    type: 'review_completed', passed: true, assisted: false, source: 'builtin',
    expectedRevision: 0, expectedStage: 'learned', expectedReviewStep: 0,
  };
  const [first, second] = await Promise.all([
    repository.applyGrammarMasteryEvent(owner, 1, { ...baseEvent, id: '00000000-0000-4000-8000-000000000001' }),
    repository.applyGrammarMasteryEvent(owner, 1, { ...baseEvent, id: '00000000-0000-4000-8000-000000000002' }),
  ]);
  assert.equal([first, second].filter((result) => result.applied).length, 1, 'one owner-serialized event wins');
  assert.equal([first, second].filter((result) => result.conflict).length, 1, 'the stale race returns a conflict');
  const confirmed = (await repository.getProgress(owner)).grammarMastery['1'];
  assert.equal(confirmed.stage, 'confirmed');
  assert.equal(confirmed.reviewStep, 1);
  assert.equal(confirmed.masteryRevision, 1);
  await repository.mergeProgress(owner, { grammarMastery: { 1: { masteryVersion: 2, stage: 'stable' } } });
  assert.deepEqual((await repository.getProgress(owner)).grammarMastery['1'], confirmed,
    'generic repository merge cannot overwrite canonical mastery');

  const winningId = first.applied ? first.eventId : second.eventId;
  const replay = await repository.applyGrammarMasteryEvent(owner, 1, {
    ...baseEvent, id: winningId,
  });
  assert.equal(replay.applied, false);
  assert.equal(replay.conflict, false);
  assert.equal(replay.replay, true);
  assert.equal(replay.record.masteryRevision, 1, 'an old revision cannot replay after bounded IDs rotate');

  await repository.mergeProgress(stranger, {
    gram: { 2: {
      masteryVersion: 2, masteryRevision: 99, stage: 'stable', reviewStep: 5,
      eligibleAt: null, typeScores: TYPE_SCORES,
    } },
  });
  const strictLegacy = await repository.getProgress(stranger);
  assert.equal(strictLegacy.grammarMastery['2'], undefined,
    'generic legacy progress cannot add a second canonical topic after one-time migration');

  const dueSessionId = '00000000-0000-4000-8000-000000000018';
  const dueEvidence = assistedDueSession(dueSessionId);
  const dueResult = await repository.applyGrammarMasteryEvent(stranger, 2, {
    id: dueSessionId, type: 'session_completed',
    expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: true,
    completedTypes: ['choice', 'input', 'correction', 'transform'],
    typeScores: dueEvidence.typeScores, session: dueEvidence.session,
  });
  assert.equal(dueResult.applied, true);
  assert.equal(dueResult.record.stage, 'not_started', 'an assisted failed transfer cannot advance mastery');
  assert.deepEqual(dueResult.record.masteryHistory.at(-1).session,
    { ...dueEvidence.session, endedAt: dueResult.record.lastAttemptAt });
  assert.equal(dueResult.record.masteryHistory.at(-1).session.items.length, 32);
  assert.equal(dueResult.record.masteryHistory.at(-1).session.items.filter((item) => item.transferStatus === 'due_next_session').length, 16);
  assert.equal(dueResult.record.masteryHistory.at(-1).session.items[1].transferStatus, 'due_next_session');
  assert.deepEqual(dueResult.record.masteryHistory.at(-1).session.items.slice(0, 2).map((item) => (
    [item.transfer, item.confusionPair, item.transferStatus]
  )), [[false, null, null], [true, null, 'due_next_session']],
  'a catalog-owned null confusion pair survives the original, bounded transfer and repository history');
  const dueReplay = await repository.applyGrammarMasteryEvent(stranger, 2, {
    id: dueSessionId, type: 'session_completed',
    expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: true,
    completedTypes: ['choice', 'input', 'correction', 'transform'],
    typeScores: dueEvidence.typeScores, session: dueEvidence.session,
  });
  assert.equal(dueReplay.replay, true);
  assert.equal(dueReplay.record.masteryHistory.at(-1).session.items.length, 32,
    'exact replay returns all ordered outcomes without truncation');

  const duplicatePairId = '00000000-0000-4000-8000-000000000019';
  const duplicatePairSession = practiceSession(duplicatePairId);
  const firstChoice = GRAMMAR_CATALOG.bank[1].c.find((item) => item.id === duplicatePairSession.items[0].id);
  const reusedPairMate = GRAMMAR_CATALOG.bank[1].c.find((item) => (
    item.id !== firstChoice.id && item.transferPair === firstChoice.transferPair
  ));
  duplicatePairSession.items[1] = {
    id: reusedPairMate.id, type: 'choice', transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  };
  const duplicatePairPayload = {
    topicId: 1,
    event: {
      id: duplicatePairId, type: 'session_completed',
      expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false,
      completedTypes: ['choice', 'input', 'correction', 'transform'], typeScores: TYPE_SCORES,
      session: duplicatePairSession,
    },
  };
  assert.equal(grammarMasteryEventSchema.safeParse(duplicatePairPayload).success, false,
    'the shared server boundary rejects a reused transfer pair before repository mutation');
  assert.equal((await repository.getProgress(stranger)).grammarMastery?.['1'], undefined,
    'the rejected duplicate-pair evidence cannot create or advance canonical mastery');

  const collisionId = '00000000-0000-4000-8000-000000000402';
  const collisionBase = {
    id: collisionId, type: 'session_completed', expectedRevision: 0,
    expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false, completedTypes: ['choice'],
    typeScores: { choice: { correct: 1, total: 1 } },
  };
  const collisionEvent = (startedAt) => ({
    ...collisionBase,
    session: {
      id: collisionId, scope: 'topic', mode: 'legacy_practice', source: 'builtin',
      catalog: { version: GRAMMAR_CATALOG_V1.version, revision: GRAMMAR_CATALOG_V1.revision },
      items: [{
        id: 'core.g.14.c.1', type: 'choice', transfer: false, correct: true,
        diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
      }],
      startedAt, assisted: false,
    },
  });
  const collisionA = collisionEvent(19_181_966_713_209);
  const collisionB = collisionEvent(288_105_508_095_880);
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 14, event: collisionA }).success, true);
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 14, event: collisionB }).success, true);
  const collisionApplied = await repository.applyGrammarMasteryEvent(stranger, 14, collisionA);
  assert.equal(collisionApplied.applied, true);
  const collisionConflict = await repository.applyGrammarMasteryEvent(stranger, 14, collisionB);
  assert.equal(collisionConflict.conflict, true);
  assert.equal(collisionConflict.replay, false,
    'file/PostgreSQL exact replay comparison rejects the reproduced FNV-1a-32 collision');
  assert.equal(collisionConflict.record.masteryHistory.length, 1,
    'changed colliding material cannot duplicate canonical statistics or history');

  const legacyClean = legacySession('00000000-0000-4000-8000-000000000070');
  legacyClean.expectedRevision = 1;
  legacyClean.expectedStage = 'learning';
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 14, event: legacyClean }).success, true);
  const legacyCleanResult = await repository.applyGrammarMasteryEvent(stranger, 14, legacyClean);
  assert.equal(legacyCleanResult.applied, true);
  assert.equal(legacyCleanResult.record.stage, 'learning',
    'choice-only legacy evidence remains partial and cannot claim four-type learned mastery');
  assert.deepEqual(legacyCleanResult.record.masteryHistory.at(-1).session,
    { ...legacyClean.session, endedAt: legacyCleanResult.record.lastAttemptAt });

  const legacyWrong = legacySession('00000000-0000-4000-8000-000000000071', {
    assisted: true, wrongRetry: true,
  });
  legacyWrong.expectedRevision = 2;
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 14, event: legacyWrong }).success, true,
    'the shared boundary accepts one exact assisted legacy retry with an ordered repeated item');
  const legacyWrongResult = await repository.applyGrammarMasteryEvent(stranger, 14, legacyWrong);
  assert.equal(legacyWrongResult.applied, true);
  assert.equal(legacyWrongResult.record.stage, 'learning',
    'automatic disclosure cannot advance partial legacy mastery');
  assert.deepEqual(legacyWrongResult.record.masteryHistory.at(-1).session.items,
    legacyWrong.session.items, 'the duplicate legacy retry stays ordered and answer-free');
  const legacyWrongReplay = await repository.applyGrammarMasteryEvent(stranger, 14, legacyWrong);
  assert.equal(legacyWrongReplay.replay, true);
  assert.equal(legacyWrongReplay.record.masteryHistory.length, 3,
    'exact assisted legacy replay cannot duplicate canonical history');
  const changedLegacyWrong = structuredClone(legacyWrong);
  changedLegacyWrong.session.startedAt += 1;
  const legacyWrongConflict = await repository.applyGrammarMasteryEvent(stranger, 14, changedLegacyWrong);
  assert.equal(legacyWrongConflict.conflict, true);
  assert.equal(legacyWrongConflict.replay, false,
    'changed legacy completion material cannot reuse its persisted UUID');
  const legacyDue = legacySession('00000000-0000-4000-8000-000000000075', {
    assisted: true, wrongRetry: true,
  });
  legacyDue.expectedRevision = 3;
  legacyDue.session.startedAt = 2_750;
  legacyDue.session.items[1] = {
    ...legacyDue.session.items[0], transferStatus: 'due_next_session',
  };
  legacyDue.typeScores.choice = { correct: 0, total: 2 };
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 14, event: legacyDue }).success, true);
  const legacyDueResult = await repository.applyGrammarMasteryEvent(stranger, 14, legacyDue);
  assert.equal(legacyDueResult.applied, true);
  assert.equal(legacyDueResult.record.stage, 'learning');
  assert.equal(legacyDueResult.record.masteryHistory.at(-1).session.items[1].transferStatus,
    'due_next_session', 'a second failed legacy attempt persists the bounded unresolved outcome');

  const generated = generatedLegacyFixture('00000000-0000-4000-8000-000000000072');
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 5, event: generated.event }).success, true);
  await repository.saveGeneratedTask(owner, generated.task);
  await assert.rejects(
    () => repository.applyGrammarMasteryEvent(stranger, 5, {
      ...generated.event, id: '00000000-0000-4000-8000-000000000073',
      session: { ...generated.event.session, id: '00000000-0000-4000-8000-000000000073' },
    }),
    /INVALID_GENERATED_GRAMMAR_REFERENCE/u,
    'an owner-generated pointer cannot cross the repository owner boundary',
  );
  const generatedResult = await repository.applyGrammarMasteryEvent(owner, 5, generated.event);
  assert.equal(generatedResult.applied, true);
  assert.equal(generatedResult.record.stage, 'not_started');
  assert.deepEqual(generatedResult.record.masteryHistory.at(-1).session.items,
    generated.event.session.items, 'history keeps exact pointer revision/outcome without generated content');
  assert.equal(/(?:prompt|answer|reference)/iu.test(JSON.stringify(
    generatedResult.record.masteryHistory.at(-1).session,
  )), false);
  const changedGeneratedType = structuredClone(generated.event);
  changedGeneratedType.completedTypes = ['input'];
  changedGeneratedType.typeScores = { input: { correct: 2, total: 2 } };
  changedGeneratedType.session.items[0].type = 'input';
  const changedGeneratedTypeConflict = await repository.applyGrammarMasteryEvent(owner, 5, changedGeneratedType);
  assert.equal(changedGeneratedTypeConflict.conflict, true);
  assert.equal(changedGeneratedTypeConflict.replay, false,
    'a same-UUID pointer suffix/type mismatch cannot reuse valid generated replay authority');
  const generatedCompositionConflicts = [
    ['builtin source with generated items', (event) => {
      event.source = 'builtin'; event.assisted = false;
      event.session.source = 'builtin'; event.session.assisted = false;
    }],
    ['generated source with only a built-in item', (event) => {
      event.completedTypes = ['choice'];
      event.typeScores = { choice: { correct: 1, total: 1 } };
      event.session.items = [{
        id: GRAMMAR_CATALOG.bank[5].c[0].id, type: 'choice', transfer: false, correct: true,
        diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
      }];
    }],
    ['mixed source without both item families', (event) => {
      event.source = 'mixed'; event.session.source = 'mixed';
    }],
    ['unassisted generated participation', (event) => {
      event.assisted = false; event.session.assisted = false;
    }],
  ];
  for (const [label, mutate] of generatedCompositionConflicts) {
    const changedComposition = structuredClone(generated.event);
    mutate(changedComposition);
    const result = await repository.applyGrammarMasteryEvent(owner, 5, changedComposition);
    assert.equal(result.conflict, true, label);
    assert.equal(result.replay, false, `${label} cannot reuse valid generated replay authority`);
  }
  const generatedAfterRead = (await repository.getProgress(owner)).grammarMastery['5'];
  assert.deepEqual(generatedAfterRead.masteryHistory.at(-1).session.items,
    generated.event.session.items,
    'canonical progress reads preserve the generated pointer source and revision');
  const ownerTopicOne = (await repository.getProgress(owner)).grammarMastery['1'];
  const unrelatedMastery = await repository.applyGrammarMasteryEvent(owner, 1, {
    id: '00000000-0000-4000-8000-000000000076', type: 'review_completed',
    expectedRevision: ownerTopicOne.masteryRevision, expectedStage: ownerTopicOne.stage,
    expectedReviewStep: ownerTopicOne.reviewStep, source: 'builtin', assisted: false,
    passed: false, reason: 'word_or_verb_form',
  });
  assert.equal(unrelatedMastery.applied, true,
    'the provenance check crosses an unrelated canonical mastery mutation');
  const generatedExport = await repository.exportUserData(owner);
  assert.deepEqual(generatedExport.progress.grammarMastery['5'].masteryHistory.at(-1).session.items,
    generated.event.session.items);
  assert.equal(/(?:prompt|answer|reference)/iu.test(JSON.stringify(
    generatedExport.progress.grammarMastery['5'].masteryHistory.at(-1).session,
  )), false, 'privacy export keeps pointer metadata without generated content');
  const mixedEvent = structuredClone(generated.event);
  mixedEvent.id = '00000000-0000-4000-8000-000000000077';
  mixedEvent.expectedRevision = 1;
  mixedEvent.source = 'mixed';
  mixedEvent.typeScores.choice = { correct: 2, total: 2 };
  mixedEvent.session.id = mixedEvent.id;
  mixedEvent.session.source = 'mixed';
  mixedEvent.session.startedAt = 3_100;
  mixedEvent.session.items.unshift({
    id: GRAMMAR_CATALOG.bank[5].c[0].id, type: 'choice', transfer: false, correct: true,
    diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
  });
  assert.equal(grammarMasteryEventSchema.safeParse({ topicId: 5, event: mixedEvent }).success, true);
  const mixedResult = await repository.applyGrammarMasteryEvent(owner, 5, mixedEvent);
  assert.equal(mixedResult.applied, true);
  assert.equal(mixedResult.record.stage, 'not_started', 'valid mixed generated participation stays assisted');
  const mixedAfterRead = (await repository.getProgress(owner)).grammarMastery['5'].masteryHistory.at(-1).session;
  assert.deepEqual(mixedAfterRead.items, mixedEvent.session.items,
    'valid mixed composition preserves built-in and generated provenance through canonical GET');
  const mixedExport = (await repository.exportUserData(owner)).progress.grammarMastery['5']
    .masteryHistory.at(-1).session;
  assert.deepEqual(mixedExport.items, mixedEvent.session.items);
  assert.equal(/(?:prompt|answer|reference)/iu.test(JSON.stringify(mixedExport)), false);
  assert.equal(await repository.deleteGeneratedTask(owner, generated.requestHash), true);
  const mixedReplay = await repository.applyGrammarMasteryEvent(owner, 5, mixedEvent);
  assert.equal(mixedReplay.replay, true,
    'valid mixed exact replay survives generated task removal without re-resolving content');
  const generatedReplay = await repository.applyGrammarMasteryEvent(owner, 5, generated.event);
  assert.equal(generatedReplay.replay, true,
    'exact canonical replay succeeds after the generated task is removed');
  const changedGenerated = structuredClone(generated.event);
  changedGenerated.session.startedAt += 1;
  const generatedConflict = await repository.applyGrammarMasteryEvent(owner, 5, changedGenerated);
  assert.equal(generatedConflict.conflict, true,
    'changed same-UUID material conflicts before missing generated content is resolved');
  await assert.rejects(
    () => repository.applyGrammarMasteryEvent(owner, 5, {
      ...generated.event, id: '00000000-0000-4000-8000-000000000074',
      session: { ...generated.event.session, id: '00000000-0000-4000-8000-000000000074' },
    }),
    /INVALID_GENERATED_GRAMMAR_REFERENCE/u,
    'a new event cannot reuse a removed generated source task',
  );

  const mixedQueue = EasyBoostGrammar.buildMixedPracticeQueue(
    GRAMMAR_CATALOG.bank, (await repository.getProgress(owner)).grammarMastery,
    { seed: 'repository-mixed-parity', now: 4_000 },
  );
  const mixedOwnerTopic = mixedQueue[0].t;
  const mixedProgressBefore = (await repository.getProgress(owner)).grammarMastery;
  const mixedExpectations = [...new Set(mixedQueue.map((entry) => entry.t))].map((topicId) => {
    const record = EasyBoostGrammar.migrateMasteryRecord(mixedProgressBefore[topicId]);
    return {
      topicId, expectedRevision: record.masteryRevision,
      expectedStage: record.stage, expectedReviewStep: record.reviewStep,
    };
  });
  const mixedBefore = EasyBoostGrammar.migrateMasteryRecord(mixedProgressBefore[mixedOwnerTopic]);
  const mixedPractice = selectedPracticeEvent(mixedQueue, {
    id: '00000000-0000-4000-8000-000000000078', mode: 'mixed_practice',
    topicId: mixedOwnerTopic, revision: mixedBefore.masteryRevision,
    stage: mixedBefore.stage, reviewStep: mixedBefore.reviewStep,
    topicExpectations: mixedExpectations,
  });
  assert.equal(grammarMasteryEventSchema.safeParse(mixedPractice).success, true);
  const mixedPracticeResults = await repository.applyGrammarMasteryEvents(owner,
    mixedExpectations.map((expectation) => ({
      topicId: expectation.topicId,
      event: {
        ...mixedPractice.event,
        expectedRevision: expectation.expectedRevision,
        expectedStage: expectation.expectedStage,
        expectedReviewStep: expectation.expectedReviewStep,
      },
    })));
  assert.equal(mixedPracticeResults.length, mixedExpectations.length);
  assert.ok(mixedPracticeResults.every((result) => result.applied),
    'one mixed completion atomically updates every exact topic expectation');
  assert.deepEqual(mixedPracticeResults.map((result) => result.record.stage),
    mixedExpectations.map((expectation) => expectation.expectedStage),
    'early mixed recall records per-topic history without granting later-stage advancement');
  const mixedPracticeResult = mixedPracticeResults[mixedExpectations
    .findIndex((expectation) => expectation.topicId === mixedOwnerTopic)];
  assert.deepEqual(mixedPracticeResult.record.masteryHistory.at(-1).session.items,
    mixedPractice.event.session.items);

  const targetedBefore = EasyBoostGrammar.migrateMasteryRecord(
    (await repository.getProgress(owner)).grammarMastery['3'],
  );
  const targetedPointer = {
    version: 'grammar-focus-v1',
    catalogVersion: GRAMMAR_CATALOG.version, catalogRevision: GRAMMAR_CATALOG.revision,
    topicId: 3, errorCode: 'word_or_verb_form', confusionPair: null,
    masteryRevision: targetedBefore.masteryRevision, eligibleAt: targetedBefore.eligibleAt,
    earlyPractice: true, stateFingerprint: 'a'.repeat(64), ref: 'b'.repeat(64),
  };
  const targetedQueue = EasyBoostGrammar.buildTargetedPracticeQueue(
    GRAMMAR_CATALOG.bank, targetedPointer, { seed: 'repository-targeted-parity' },
  );
  const targetedPractice = selectedPracticeEvent(targetedQueue, {
    id: '00000000-0000-4000-8000-000000000079', mode: 'targeted_practice',
    topicId: 3, revision: targetedBefore.masteryRevision,
    stage: targetedBefore.stage, reviewStep: targetedBefore.reviewStep,
    recommendation: {
      pointer: targetedPointer,
      itemIds: targetedQueue.map((entry) => entry.q.id),
      completionToken: 'c'.repeat(43),
    },
  });
  assert.equal(grammarMasteryEventSchema.safeParse(targetedPractice).success, true);
  const targetedPracticeResult = await repository.applyGrammarMasteryEvent(
    owner, targetedPractice.topicId, targetedPractice.event,
  );
  assert.equal(targetedPracticeResult.applied, true);
  assert.equal(targetedPracticeResult.record.stage, targetedBefore.stage,
    'early targeted recall persists exact server focus without granting later-stage advancement');
  const selectedExport = await repository.exportUserData(owner);
  assert.deepEqual(selectedExport.progress.grammarMastery[String(mixedOwnerTopic)]
    .masteryHistory.at(-1).session.items, mixedPractice.event.session.items);
  assert.deepEqual(selectedExport.progress.grammarMastery['3']
    .masteryHistory.at(-1).session.items, targetedPractice.event.session.items);

  const examProgressBefore = (await repository.getProgress(owner)).grammarMastery;
  const builtInExam = examEventFixture(
    '00000000-0000-4000-8000-000000000080', GRAMMAR_CATALOG.exams[0], examProgressBefore,
    { wrongFirst: true },
  );
  assert.equal(grammarMasteryEventSchema.safeParse(builtInExam).success, true);
  const builtInExamResults = await repository.applyGrammarMasteryEvents(owner, examEntries(builtInExam));
  assert.equal(builtInExamResults.length, builtInExam.event.session.topicExpectations.length);
  assert.ok(builtInExamResults.every((result) => result.applied),
    'one built-in exam completion atomically persists every physical topic');
  assert.deepEqual(builtInExamResults.map((result) => result.record.stage),
    builtInExam.event.session.topicExpectations.map((expectation) => expectation.expectedStage),
    'exam correctness records history without granting mastery');
  const builtInExamReplay = await repository.applyGrammarMasteryEvents(owner, examEntries(builtInExam));
  assert.ok(builtInExamReplay.every((result) => result.replay && !result.applied),
    'the exact exam identity replays across every physical topic without duplicate evidence');

  const generatedExamHash = 'e'.repeat(64);
  const generatedExamRaw = {
    tx: ['A ', ' B ', ' C ', ' D ', ' E ', ' F ', '.'],
    gaps: Array.from({ length: 6 }, (_, index) => ({
      b: `WORD${index}`, ans: [`answer${index}`], e: `Reason ${index}.`, t: index + 13,
    })),
  };
  const generatedExamForm = validateGeneratedGrammarSupplement('grammar_exam_19_24',
    decorateGeneratedVoiceTutorContent('grammar_exam_19_24', generatedExamHash, generatedExamRaw));
  await repository.saveGeneratedTask(owner, {
    operation: 'grammar_exam_19_24', requestHash: generatedExamHash,
    request: { operation: 'grammar_exam_19_24' }, result: generatedExamRaw,
    provider: 'fixture', promptVersion: 'fixture-v1',
  });
  const generatedExam = examEventFixture(
    '00000000-0000-4000-8000-000000000081', generatedExamForm,
    (await repository.getProgress(owner)).grammarMastery, { source: 'generated' },
  );
  assert.equal(grammarMasteryEventSchema.safeParse(generatedExam).success, true);
  const generatedExamResults = await repository.applyGrammarMasteryEvents(owner, examEntries(generatedExam));
  assert.ok(generatedExamResults.every((result) => result.applied
    && result.record.stage === 'not_started' && result.record.stats.assistedAttempts === 1),
  'owner-bound generated exam pointers persist only assisted history');
  const examExport = await repository.exportUserData(owner);
  assert.deepEqual(examExport.progress.grammarMastery['13'].masteryHistory.at(-1).session.items,
    generatedExam.event.session.items, 'export retains bounded generated exam refs without answer content');
  assert.equal(/(?:prompt|answer|reference)/iu.test(JSON.stringify(
    examExport.progress.grammarMastery['13'].masteryHistory.at(-1).session,
  )), false);

  const strangerSessionId = '00000000-0000-4000-8000-000000000001';
  const strangerSession = practiceSession(strangerSessionId);
  const strangerLearning = await repository.applyGrammarMasteryEvent(stranger, 1, {
    id: strangerSessionId, type: 'session_completed',
    expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false,
    completedTypes: ['choice', 'input', 'correction', 'transform'], typeScores: TYPE_SCORES,
    session: strangerSession,
  });
  assert.equal(strangerLearning.applied, true, 'event IDs are owner-scoped');
  assert.equal(strangerLearning.record.stage, 'learned');
  assert.deepEqual(strangerLearning.record.masteryHistory.at(-1).session,
    { ...strangerSession, endedAt: strangerLearning.record.lastStageAt });
  const exactSessionReplay = await repository.applyGrammarMasteryEvent(stranger, 1, {
    id: strangerSessionId, type: 'session_completed',
    expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false,
    completedTypes: ['choice', 'input', 'correction', 'transform'], typeScores: TYPE_SCORES,
    session: strangerSession,
  });
  assert.equal(exactSessionReplay.replay, true);
  const changedSession = structuredClone(strangerSession);
  changedSession.startedAt += 1;
  const changedSessionReplay = await repository.applyGrammarMasteryEvent(stranger, 1, {
    id: strangerSessionId, type: 'session_completed',
    expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false,
    completedTypes: ['choice', 'input', 'correction', 'transform'], typeScores: TYPE_SCORES,
    session: changedSession,
  });
  assert.equal(changedSessionReplay.conflict, true, 'changed session evidence cannot reuse a UUID');
  assert.equal(changedSessionReplay.replay, false);
  const partial = await repository.applyGrammarMasteryEvent(stranger, 3, {
    id: '00000000-0000-4000-8000-000000000003', type: 'session_completed',
    expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false,
    completedTypes: ['choice', 'input'],
    typeScores: { choice: { correct: 3, total: 4 }, input: { correct: 2, total: 3 } },
  });
  assert.equal(partial.applied, true);
  assert.equal(partial.record.stage, 'learning');
  assert.deepEqual(partial.record.stats, {
    correct: 5, errors: 2, advancedStreak: 0, assistedAttempts: 0,
  });
  const batch = await repository.applyGrammarMasteryEvents(stranger, [4, 8].map((topicId, index) => ({
    topicId,
    event: {
      id: `00000000-0000-4000-8000-${String(10 + index).padStart(12, '0')}`,
      type: 'session_completed', expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes: ['choice'],
      typeScores: { choice: { correct: 1, total: 1 } },
    },
  })));
  assert.equal(batch.length, 2);
  assert.ok(batch.every((result) => result.applied && result.record.stage === 'learning'),
    'one owner transaction returns one authoritative result per batch event');
  const atomicBefore = await repository.getProgress(stranger);
  const aborted = await repository.applyGrammarMasteryEvents(stranger, [{
    topicId: 6,
    event: {
      id: '00000000-0000-4000-8000-000000000016', type: 'session_completed',
      expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes: ['choice'],
      typeScores: { choice: { correct: 1, total: 1 } },
    },
  }, {
    topicId: 7,
    event: {
      id: '00000000-0000-4000-8000-000000000017', type: 'session_completed',
      expectedRevision: 1, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes: ['choice'],
      typeScores: { choice: { correct: 1, total: 1 } },
    },
  }]);
  assert.ok(aborted.every((result) => !result.applied));
  assert.deepEqual((await repository.getProgress(stranger)).grammarMastery, atomicBefore.grammarMastery,
    'one stale event aborts every unseen mutation in the owner batch');
  assert.equal((await repository.getProgress(owner)).words.learned, 7, 'mastery mutation preserves sibling progress');
  const ownerTopicOneExport = (await repository.exportUserData(owner)).progress.grammarMastery['1'];
  assert.deepEqual(ownerTopicOneExport.masteryHistory.find((entry) => entry.eventId === unrelatedMastery.eventId),
    unrelatedMastery.record.masteryHistory.find((entry) => entry.eventId === unrelatedMastery.eventId),
    'the unrelated mastery mutation remains authoritative beside generated and exam evidence');

  assert.equal(await repository.deleteUserData(owner), true);
  assert.deepEqual(await repository.getProgress(owner), {});
  await assert.rejects(() => repository.applyGrammarMasteryEvent(owner, 1, {
    id: '00000000-0000-4000-8000-000000000099', type: 'session_completed',
    expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false, completedTypes: ['choice'],
    typeScores: { choice: { correct: 1, total: 1 } },
  }), /USER_NOT_FOUND/u, 'a deleted owner cannot be recreated through a late mastery mutation');
  assert.deepEqual(await repository.getProgress(owner), {}, 'failed late mutation leaves no orphan progress');
  assert.equal((await repository.getProgress(stranger)).grammarMastery['1'].masteryRevision, 1);
  const strangerExport = await repository.exportUserData(stranger);
  assert.equal(strangerExport.progress.grammarMastery['1'].masteryHistory[0].session.id, strangerSessionId);
  assert.equal(strangerExport.progress.grammarMastery['2'].masteryHistory[0].session.id, dueSessionId);
  assert.equal(strangerExport.progress.grammarMastery['2'].masteryHistory[0].session.items.length, 32);
  assert.equal(strangerExport.progress.grammarMastery['2'].masteryHistory[0].session.items[1].transferStatus, 'due_next_session');
  assert.equal(strangerExport.progress.grammarMastery['14'].stage, 'learning');
  assert.equal(strangerExport.progress.grammarMastery['14'].masteryHistory.length, 4);
  assert.deepEqual(strangerExport.progress.grammarMastery['14'].masteryHistory[2].session.items,
    legacyWrong.session.items, 'privacy export preserves the exact bounded assisted legacy retry');
  assert.deepEqual(strangerExport.progress.grammarMastery['14'].masteryHistory[3].session.items,
    legacyDue.session.items, 'privacy export preserves the exact due-next-session retry outcome');
  assert.equal(JSON.stringify(strangerExport.progress.grammarMastery).includes('answer'), false);
  assert.equal(await repository.deleteUserData(stranger), true);
  assert.equal(await repository.exportUserData(stranger), null, 'deletion removes bounded grammar session evidence');
}
