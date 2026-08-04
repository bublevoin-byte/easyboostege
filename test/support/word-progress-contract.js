import { applyVocabularyOutcome, migrateVocabularyProgress } from '../../public/vocabulary-domain.js';

export async function assertWordProgressRepositoryContract(assert, repository, owner, other) {
  const now = Date.parse('2026-08-04T10:00:00.000Z');
  await repository.upsertWordProgress(owner, [{
    word: ' To Achieve ', stage: 3, errorCount: 1, reviewCount: 4, dueAt: now,
  }]);
  await repository.upsertWordProgress(other, [{
    word: 'private', stage: 5, errorCount: 0, reviewCount: 20, dueAt: now,
  }]);

  const migrated = (await repository.getWordProgress(owner))[0];
  assert.deepEqual(migrated, migrateVocabularyProgress({
    word: 'achieve', stage: 3, errorCount: 1, reviewCount: 4, dueAt: now,
  }));
  assert.equal((await repository.getWordProgress(owner)).some((item) => item.word === 'private'), false);

  const mastered = applyVocabularyOutcome(migrated, {
    mode: 'english_production', outcome: 'correct', now,
  });
  await repository.upsertWordProgress(owner, [mastered]);
  assert.deepEqual(await repository.getWordProgress(owner), [mastered]);

  await repository.upsertWordProgress(owner, [{
    word: 'to achieve', stage: 4, errorCount: 1, reviewCount: 6, dueAt: now + 4_000,
    legacyInput: true,
  }]);
  const afterLegacy = (await repository.getWordProgress(owner))[0];
  assert.equal(afterLegacy.stage, 4);
  assert.equal(afterLegacy.dimensions.spelling.independentSuccesses, 1);
  assert.equal(afterLegacy.dimensions.spelling.evidence, 'objective');

  const exported = await repository.exportUserData(owner);
  assert.equal(exported.word_progress.length, 1);
  assert.deepEqual(Object.keys(exported.word_progress[0]).sort(), [
    'dimensions', 'due_at', 'error_count', 'last_mode', 'last_outcome',
    'mastery_version', 'review_count', 'stage', 'updated_at', 'word',
  ]);
  assert.equal(exported.word_progress[0].mastery_version, 1);
  assert.equal(exported.word_progress[0].dimensions.spelling.independentSuccesses, 1);
  assert.equal(JSON.stringify(exported.word_progress).includes('username'), false);

  assert.equal(await repository.deleteUserData(owner), true);
  assert.equal(await repository.exportUserData(owner), null);
  assert.deepEqual(await repository.getWordProgress(owner), []);
}
