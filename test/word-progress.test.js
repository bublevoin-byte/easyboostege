import test from 'node:test';
import assert from 'node:assert/strict';
import { wordProgressBatchSchema } from '../validation/word-progress.js';

const word = { word: 'achievement', stage: 3, errorCount: 1, reviewCount: 5, dueAt: Date.now() + 86_400_000 };

test('word progress validates SRS bounds and rejects duplicate words', () => {
  assert.equal(wordProgressBatchSchema.safeParse({ words: [word] }).success, true);
  assert.equal(wordProgressBatchSchema.safeParse({ words: [{ ...word, stage: 6 }] }).success, false);
  assert.equal(wordProgressBatchSchema.safeParse({ words: [word, { ...word, word: 'Achievement' }] }).success, false);
});

test('word progress accepts legacy and strict multidimensional payloads as one versioned record', () => {
  const legacy = wordProgressBatchSchema.parse({ words: [word] }).words[0];
  assert.equal(legacy.masteryVersion, 1);
  assert.equal(legacy.dimensions.meaning.evidence, 'preliminary');
  assert.equal(legacy.dimensions.spelling.independentSuccesses, 0);

  const dimension = {
    score: 65, attempts: 4, independentSuccesses: 2,
    evidence: 'objective', lastPracticedAt: Date.now(),
  };
  const mastery = {
    ...word,
    masteryVersion: 1,
    dimensions: {
      meaning: { ...dimension, evidence: 'self_reported', independentSuccesses: 0 },
      spelling: dimension,
      context: dimension,
      listening: dimension,
    },
    lastMode: 'english_production',
    lastOutcome: 'correct',
  };
  assert.equal(wordProgressBatchSchema.safeParse({ words: [mastery] }).success, true);
  assert.equal(wordProgressBatchSchema.safeParse({
    words: [{
      ...mastery,
      dimensions: { ...mastery.dimensions, spelling: { ...dimension, attempts: 1, independentSuccesses: 2 } },
    }],
  }).success, false);
  assert.equal(wordProgressBatchSchema.safeParse({ words: [{ ...mastery, backendOwner: 'other' }] }).success, false);
});
