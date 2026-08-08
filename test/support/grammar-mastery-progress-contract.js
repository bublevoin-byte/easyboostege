import assert from 'node:assert/strict';

const TYPE_SCORES = Object.freeze({
  choice: { correct: 4, total: 4 },
  input: { correct: 4, total: 4 },
  correction: { correct: 4, total: 4 },
  transform: { correct: 4, total: 4 },
});

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
  await repository.saveProgress(owner, {
    gram: { 1: { st: 2, ok: 14, err: 3, sr: 4, rs: 2, due: 1 } },
    words: { learned: 7 },
  });
  const firstMigration = await repository.migrateGrammarMastery(owner);
  const secondMigration = await repository.migrateGrammarMastery(owner);
  assert.deepEqual(firstMigration['1'], GRAMMAR_MASTERY_FIXTURE);
  assert.deepEqual(secondMigration, firstMigration, 'legacy migration must be idempotent');
  assert.deepEqual(await repository.getProgress(stranger), {});

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
  assert.equal(strictLegacy.grammarMastery['2'].stage, 'not_started');
  assert.equal(strictLegacy.grammarMastery['2'].masteryRevision, 0,
    'generic legacy progress cannot forge canonical fields');

  const strangerLearning = await repository.applyGrammarMasteryEvent(stranger, 1, {
    id: '00000000-0000-4000-8000-000000000001', type: 'session_completed',
    expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false,
    completedTypes: ['choice', 'input', 'correction', 'transform'], typeScores: TYPE_SCORES,
  });
  assert.equal(strangerLearning.applied, true, 'event IDs are owner-scoped');
  assert.equal(strangerLearning.record.stage, 'learned');
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
  const batch = await repository.applyGrammarMasteryEvents(stranger, [4, 5].map((topicId, index) => ({
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
  assert.deepEqual((await repository.exportUserData(owner)).progress.grammarMastery['1'], confirmed);

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
}
