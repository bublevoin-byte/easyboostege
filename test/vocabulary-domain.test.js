import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVocabularyOutcome,
  buildVocabularyQueue,
  deriveVocabularyState,
  gradeVocabularyAnswer,
  localVocabularyProgress,
  mergeLegacyVocabularyProgress,
  migrateVocabularyProgress,
  migrateLocalVocabularyProgress,
  reinsertVocabularyFailure,
} from '../public/vocabulary-domain.js';

test('legacy SRS progress migrates once into preliminary multidimensional mastery', () => {
  const legacy = {
    word: ' To Achieve ', stage: 5, errorCount: 2, reviewCount: 9,
    dueAt: Date.parse('2026-08-05T09:00:00.000Z'),
  };

  const migrated = migrateVocabularyProgress(legacy);

  assert.deepEqual(migrated, {
    masteryVersion: 1,
    word: 'achieve',
    stage: 5,
    errorCount: 2,
    reviewCount: 9,
    dueAt: Date.parse('2026-08-05T09:00:00.000Z'),
    dimensions: {
      meaning: { score: 70, attempts: 11, independentSuccesses: 0, evidence: 'preliminary', lastPracticedAt: null },
      spelling: { score: 70, attempts: 0, independentSuccesses: 0, evidence: 'preliminary', lastPracticedAt: null },
      context: { score: 70, attempts: 0, independentSuccesses: 0, evidence: 'preliminary', lastPracticedAt: null },
      listening: { score: 70, attempts: 0, independentSuccesses: 0, evidence: 'preliminary', lastPracticedAt: null },
    },
    lastMode: null,
    lastOutcome: null,
  });
  assert.deepEqual(migrateVocabularyProgress(migrated), migrated);
});

test('objective success updates only its dimension and a failure schedules a near retry', () => {
  const now = Date.parse('2026-08-04T10:00:00.000Z');
  const legacy = migrateVocabularyProgress({
    word: 'achieve', stage: 3, errorCount: 1, reviewCount: 4, dueAt: now,
  });

  const successful = applyVocabularyOutcome(legacy, {
    mode: 'english_production', outcome: 'correct', now,
  });
  assert.equal(successful.dimensions.spelling.score, 65);
  assert.equal(successful.dimensions.spelling.independentSuccesses, 1);
  assert.equal(successful.dimensions.spelling.evidence, 'objective');
  assert.equal(successful.dimensions.meaning.score, 45);
  assert.equal(successful.reviewCount, 5);
  assert.equal(successful.dueAt, now + 3 * 86_400_000);
  assert.equal(deriveVocabularyState(successful), 'review');

  const failed = applyVocabularyOutcome(successful, {
    mode: 'contextual_production', outcome: 'not_known', now: now + 1_000,
  });
  assert.equal(failed.dimensions.context.score, 25);
  assert.equal(failed.errorCount, 2);
  assert.equal(failed.reviewCount, 6);
  assert.equal(failed.stage, 2);
  assert.equal(failed.dueAt, now + 1_000 + 10 * 60_000);
});

test('recognition and self-report cannot promote a word to strong', () => {
  const now = Date.parse('2026-08-04T10:00:00.000Z');
  const dimensions = Object.fromEntries(['meaning', 'spelling', 'context', 'listening'].map((name) => [name, {
    score: 90, attempts: 8, independentSuccesses: 0,
    evidence: name === 'meaning' ? 'self_reported' : 'preliminary', lastPracticedAt: now,
  }]));
  const progress = migrateVocabularyProgress({
    masteryVersion: 1, word: 'achievement', stage: 5, errorCount: 0,
    reviewCount: 20, dueAt: now, dimensions, lastMode: 'russian_reveal', lastOutcome: 'knew',
  });

  assert.equal(deriveVocabularyState(progress), 'review');
});

test('queue keeps every due word first, then the weakest review, and reduces new work', () => {
  const now = Date.parse('2026-08-04T10:00:00.000Z');
  const legacy = (word, stage, dueAt, reviewCount = 3) => ({
    word, stage, errorCount: 0, reviewCount, dueAt,
  });
  const records = [
    legacy('new beta', 0, null, 0),
    legacy('weak later', 1, now + 86_400_000),
    legacy('due recent', 4, now - 60_000),
    legacy('due oldest', 3, now - 86_400_000),
    legacy('new alpha', 0, null, 0),
  ];

  const queue = buildVocabularyQueue(records, { now, newWordBudget: 5, reviewLimit: 3 });

  assert.deepEqual(queue.due.map((item) => item.word), ['due oldest', 'due recent']);
  assert.deepEqual(queue.weak.map((item) => item.word), ['weak later']);
  assert.equal(queue.effectiveNewWordBudget, 2);
  assert.deepEqual(queue.new.map((item) => item.word), ['new alpha', 'new beta']);
  assert.deepEqual(queue.items.map((item) => item.word), [
    'due oldest', 'due recent', 'weak later', 'new alpha', 'new beta',
  ]);
});

test('failed words return only after intervening items and stop at the session cap', () => {
  const items = ['alpha', 'beta', 'gamma', 'delta'].map((word) => ({ word }));

  const repeated = reinsertVocabularyFailure(items, items[0], {
    afterIndex: 0, minInterveningItems: 2, repeatCounts: {}, maxRepeatsPerWord: 1,
  });
  assert.equal(repeated.insertedAt, 3);
  assert.deepEqual(repeated.items.map((item) => item.word), ['alpha', 'beta', 'gamma', 'alpha', 'delta']);
  assert.deepEqual(repeated.repeatCounts, { alpha: 1 });

  const capped = reinsertVocabularyFailure(repeated.items, items[0], {
    afterIndex: 3, minInterveningItems: 2, repeatCounts: repeated.repeatCounts, maxRepeatsPerWord: 1,
  });
  assert.equal(capped.insertedAt, null);
  assert.deepEqual(capped.items, repeated.items);
});

test('English grading normalizes optional to while Russian recall requires self-rating', () => {
  assert.deepEqual(gradeVocabularyAnswer({
    mode: 'english_production', answer: '  TO   Achieve ', acceptedAnswers: ['achieve'],
  }), {
    outcome: 'correct', normalizedAnswer: 'achieve', independentSuccess: true,
  });
  assert.deepEqual(gradeVocabularyAnswer({
    mode: 'english_production', answer: 'achiev', acceptedAnswers: ['achieve'],
  }), {
    outcome: 'almost', normalizedAnswer: 'achiev', independentSuccess: false,
  });
  assert.deepEqual(gradeVocabularyAnswer({
    mode: 'russian_reveal', answer: 'достигать', acceptedAnswers: ['достигать'],
  }), {
    outcome: null, normalizedAnswer: 'достигать', independentSuccess: false,
    requiresSelfRating: true,
  });
  assert.deepEqual(gradeVocabularyAnswer({
    mode: 'russian_reveal', answer: 'дойти', acceptedAnswers: ['достигать'], selfRating: 'knew',
  }), {
    outcome: 'knew', normalizedAnswer: 'дойти', independentSuccess: false,
    requiresSelfRating: false,
  });
});

test('local legacy records migrate idempotently and later legacy reviews preserve richer dimensions', () => {
  const local = migrateLocalVocabularyProgress({
    'to achieve': { s: 3, e: 1, n: 4, due: 1_000 },
  });
  assert.equal(local['to achieve'].word, 'achieve');
  assert.equal(local['to achieve'].masteryVersion, 1);
  assert.equal(local['to achieve'].s, 3);
  assert.deepEqual(migrateLocalVocabularyProgress(local), local);

  const mastered = applyVocabularyOutcome(local['to achieve'], {
    mode: 'english_production', outcome: 'correct', now: 2_000,
  });
  const merged = mergeLegacyVocabularyProgress(mastered, {
    word: 'to achieve', s: 4, e: 1, n: 5, due: 3_000,
  });
  assert.equal(merged.stage, 4);
  assert.equal(merged.dimensions.spelling.independentSuccesses, 1);
  assert.equal(merged.dimensions.spelling.evidence, 'objective');
  assert.equal(localVocabularyProgress('to achieve', merged).s, 4);
});
