import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyVocabularyOutcome,
  appendVocabularySessionHistory,
  buildVocabularyRecognitionOptions,
  buildVocabularyTrend,
  composeVocabularySession,
  buildVocabularyQueue,
  summarizeVocabularySession,
  deriveVocabularyState,
  gradeVocabularyAnswer,
  localVocabularyProgress,
  mergeLegacyVocabularyProgress,
  migrateVocabularyProgress,
  migrateLocalVocabularyProgress,
  reinsertVocabularyFailure,
} from '../public/vocabulary-domain.js';

test('mixed vocabulary session introduces new words before the deterministic recall ladder', () => {
  const items = [
    { w: 'new word' },
    { w: 'learning meaning' },
    { w: 'learning spelling' },
    { w: 'learning context' },
    { w: 'learning listening' },
  ];
  let progress = migrateVocabularyProgress({ word: 'template' });
  progress = applyVocabularyOutcome(progress, {
    mode: 'receptive_meaning', outcome: 'correct', now: 1_000,
  });
  const meaningProgress = progress;
  progress = applyVocabularyOutcome(progress, {
    mode: 'russian_reveal', outcome: 'knew', now: 2_000,
  });
  const spellingProgress = progress;
  progress = applyVocabularyOutcome(progress, {
    mode: 'english_production', outcome: 'correct', now: 3_000,
  });
  const contextProgress = progress;
  progress = applyVocabularyOutcome(progress, {
    mode: 'contextual_production', outcome: 'correct', now: 4_000,
  });
  const listeningProgress = progress;
  const progressByWord = Object.fromEntries([
    [items[1], meaningProgress], [items[2], spellingProgress],
    [items[3], contextProgress], [items[4], listeningProgress],
  ].map(([item, record]) => [item.w, { ...record, word: item.w }]));

  const session = composeVocabularySession(items, { progressByWord });

  assert.deepEqual(session.map(({ word, mode, introduced, reviewed }) => ({
    word, mode, introduced, reviewed,
  })), [
    { word: 'new word', mode: 'introduction', introduced: true, reviewed: false },
    { word: 'new word', mode: 'receptive_meaning', introduced: false, reviewed: false },
    { word: 'learning meaning', mode: 'russian_reveal', introduced: false, reviewed: true },
    { word: 'learning spelling', mode: 'english_production', introduced: false, reviewed: true },
    { word: 'learning context', mode: 'contextual_production', introduced: false, reviewed: true },
    { word: 'learning listening', mode: 'listening', introduced: false, reviewed: true },
  ]);
});

test('successful evidence advances a new word through every recall mode without stalling', () => {
  const item = { w: 'advance' };
  let progress = migrateVocabularyProgress({ word: item.w });
  progress = applyVocabularyOutcome(progress, {
    mode: 'receptive_meaning', outcome: 'correct', now: 1_000,
  });
  assert.equal(composeVocabularySession([item], {
    progressByWord: { advance: progress },
  })[0].mode, 'russian_reveal');

  progress = applyVocabularyOutcome(progress, {
    mode: 'russian_reveal', outcome: 'knew', now: 2_000,
  });
  assert.equal(progress.dimensions.meaning.evidence, 'self_reported');
  assert.equal(composeVocabularySession([item], {
    progressByWord: { advance: progress },
  })[0].mode, 'english_production');

  progress = applyVocabularyOutcome(progress, {
    mode: 'english_production', outcome: 'correct', now: 3_000,
  });
  assert.equal(composeVocabularySession([item], {
    progressByWord: { advance: progress },
  })[0].mode, 'contextual_production');

  progress = applyVocabularyOutcome(progress, {
    mode: 'contextual_production', outcome: 'correct', now: 4_000,
  });
  assert.equal(composeVocabularySession([item], {
    progressByWord: { advance: progress },
  })[0].mode, 'listening');

  progress = applyVocabularyOutcome(progress, {
    mode: 'listening', outcome: 'correct', now: 5_000,
  });
  assert.equal(composeVocabularySession([item], {
    progressByWord: { advance: progress },
  })[0].mode, 'russian_reveal');

  for (let attempt = 0; attempt < 40 && deriveVocabularyState(progress) !== 'strong'; attempt += 1) {
    const mode = composeVocabularySession([item], {
      progressByWord: { advance: progress },
    })[0].mode;
    progress = applyVocabularyOutcome(progress, {
      mode, outcome: mode === 'russian_reveal' ? 'knew' : 'correct', now: 6_000 + attempt,
    });
  }
  assert.equal(deriveVocabularyState(progress), 'strong');
});

test('recognition options are stable, unique and include the accepted meaning', () => {
  const catalog = [
    { w: 'beta', tr: 'бета' },
    { w: 'alpha', tr: 'альфа' },
    { w: 'gamma', tr: 'гамма' },
    { w: 'delta', tr: 'дельта' },
    { w: 'duplicate', tr: 'бета' },
  ];

  assert.deepEqual(buildVocabularyRecognitionOptions(catalog, catalog[0]), [
    'альфа', 'бета', 'гамма', 'дельта',
  ]);
  assert.deepEqual(buildVocabularyRecognitionOptions(catalog, catalog[0]), [
    'альфа', 'бета', 'гамма', 'дельта',
  ]);
});

test('session summary separates unique words from attempts and keeps difficult words actionable', () => {
  const summary = summarizeVocabularySession([
    { word: 'alpha', mode: 'introduction', introduced: true },
    { word: 'alpha', mode: 'receptive_meaning', outcome: 'correct', independentSuccess: false },
    { word: 'beta', mode: 'english_production', outcome: 'correct', independentSuccess: true, reviewed: true },
    { word: 'beta', mode: 'contextual_production', outcome: 'almost', independentSuccess: false, reviewed: true },
    { word: 'gamma', mode: 'listening', outcome: 'not_known', independentSuccess: false, reviewed: true },
  ]);

  assert.deepEqual(summary, {
    uniqueWords: 3,
    attempts: 4,
    introduced: 1,
    reviewed: 2,
    independent: 1,
    assisted: 1,
    errors: 2,
    difficultWords: [
      { word: 'beta', attempts: 2, errors: 1 },
      { word: 'gamma', attempts: 1, errors: 1 },
    ],
  });
});

test('local vocabulary history exposes deterministic 7 and 30 day independent-recall trends', () => {
  const august4 = Date.parse('2026-08-04T12:00:00.000Z');
  const older = appendVocabularySessionHistory([], {
    attempts: 4, independent: 1, errors: 2, uniqueWords: 3,
  }, { completedAt: august4 - 8 * 86_400_000 });
  const recent = appendVocabularySessionHistory(older, {
    attempts: 5, independent: 3, errors: 1, uniqueWords: 4,
  }, { completedAt: august4 - 2 * 86_400_000 });
  const history = appendVocabularySessionHistory(recent, {
    attempts: 4, independent: 3, errors: 0, uniqueWords: 3,
  }, { completedAt: august4 });

  assert.deepEqual(buildVocabularyTrend(history, { days: 7, now: august4 }), {
    days: 7,
    sessions: 2,
    attempts: 9,
    independent: 6,
    errors: 1,
    independentRate: 67,
    points: [
      { day: '2026-08-02', attempts: 5, independent: 3, errors: 1, independentRate: 60 },
      { day: '2026-08-04', attempts: 4, independent: 3, errors: 0, independentRate: 75 },
    ],
  });
  assert.equal(buildVocabularyTrend(history, { days: 30, now: august4 }).sessions, 3);
  assert.equal(buildVocabularyTrend([{
    completedAt: august4, attempts: 1, independent: 99, errors: 0,
  }], { days: 7, now: august4 }).independentRate, 100);
  const timezoneBoundary = Date.parse('2026-08-03T19:30:00.000Z');
  assert.equal(buildVocabularyTrend([{
    completedAt: timezoneBoundary,
    attempts: 1, independent: 1, errors: 0,
  }], {
    days: 7, now: august4, timezoneOffsetMinutes: -360,
  }).points[0].day, '2026-08-04');
  const localBoundary = new Date(timezoneBoundary);
  const localDay = [
    localBoundary.getFullYear(), String(localBoundary.getMonth() + 1).padStart(2, '0'),
    String(localBoundary.getDate()).padStart(2, '0'),
  ].join('-');
  assert.equal(buildVocabularyTrend([{
    completedAt: timezoneBoundary, attempts: 1, independent: 1, errors: 0,
  }], { days: 7, now: august4 }).points[0].day, localDay);
});

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
    fallbackItems: items,
  });
  assert.equal(repeated.insertedAt, 3);
  assert.equal(repeated.interveningAdded, 0);
  assert.deepEqual(repeated.items.map((item) => item.word), ['alpha', 'beta', 'gamma', 'alpha', 'delta']);
  assert.deepEqual(repeated.repeatCounts, { alpha: 1 });

  const capped = reinsertVocabularyFailure(repeated.items, items[0], {
    afterIndex: 3, minInterveningItems: 2, repeatCounts: repeated.repeatCounts, maxRepeatsPerWord: 1,
  });
  assert.equal(capped.insertedAt, null);
  assert.deepEqual(capped.items, repeated.items);

  const lateRetry = reinsertVocabularyFailure(items.slice(0, 1), items[0], {
    afterIndex: 0, minInterveningItems: 2, repeatCounts: {}, maxRepeatsPerWord: 2,
    fallbackItems: items.slice(1, 3).map((item) => ({ ...item, mode: 'bridge' })),
  });
  assert.equal(lateRetry.insertedAt, 3);
  assert.equal(lateRetry.interveningAdded, 2);
  assert.deepEqual(lateRetry.items.map((item) => item.word), [
    'alpha', 'beta', 'gamma', 'alpha',
  ]);
  assert.deepEqual(lateRetry.items.slice(1, 3).map((item) => item.bridge), [true, true]);
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
