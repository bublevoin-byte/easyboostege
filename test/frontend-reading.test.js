import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  READING_ACTIVITY_IDS,
  READING_DETAIL_ACTIVITY_IDS,
  READING_GIST_ACTIVITY_IDS,
  learningActivityPool,
  learningActivitySource,
  readingActivityId,
  splitLearningActivityDuration,
} from '../public/learning-activity-contract.js';

const source = (await fs.readFile(new URL('../public/modules/reading.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/mu, '');

function createReadingModule() {
  const window = {};
  vm.runInNewContext(source, {
    window, learningActivityPool, learningActivitySource, readingActivityId, splitLearningActivityDuration,
    Object, Number, Math, Array, Set, String,
  });
  return window.EasyBoostReading;
}

test('reading module normalizes state and calculates aggregate accuracy', () => {
  const reading = createReadingModule();
  const state = reading.normalizeState({ h: { ok: 3, tot: 4 }, texts: 2 });
  state.q = { ok: 2, tot: 4 };

  assert.deepEqual(
    { ...reading.summary(state) },
    { correct: 5, total: 8, accuracy: 63, texts: 2 },
  );
  assert.deepEqual({ ...state.g }, { ok: 0, tot: 0 });
});

test('reading module remaps heading and gap answers after shuffling', () => {
  const reading = createReadingModule();
  const headings = reading.shuffleHeadings({
    hl: ['A', 'B', 'C'],
    txts: [{ t: 'one', a: 0 }, { t: 'two', a: 2 }],
  }, () => 0);
  const gaps = reading.shuffleGaps({
    tx: ['x', 'y'],
    fr: ['A', 'B', 'C'],
    a: [0, 2],
    k: ['one', 'two'],
  }, () => 0);

  headings.txts.forEach((text, index) => {
    const original = index === 0 ? 'A' : 'C';
    assert.equal(headings.hl[text.a], original);
  });
  gaps.a.forEach((answer, index) => {
    const original = index === 0 ? 'A' : 'C';
    assert.equal(gaps.fr[answer], original);
  });
});

test('reading module enforces unique selections and scores a complete exam', () => {
  const reading = createReadingModule();
  const selected = reading.selectUnique([0, 1, null], 2, 1);
  assert.deepEqual(Array.from(selected), [0, null, 1]);

  const result = reading.scoreExam({
    h: { txts: [{ a: 0 }, { a: 1 }] },
    g: { a: [2, 0] },
    q: { qs: [{ a: 1 }, { a: 3 }] },
    selH: [0, 2],
    selG: [2, 0],
    ansQ: [1, 0],
  });
  assert.deepEqual({ ...result }, { headings: 1, gaps: 2, questions: 1, total: 4 });
  assert.deepEqual(Array.from(reading.pool([1], [2, 3])), [1, 2, 3]);

  const sourced = reading.pool([{ id: 'builtin' }], [{ id: 'generated' }]);
  assert.equal(sourced[0].evidenceSource, 'builtin');
  assert.equal(sourced[1].evidenceSource, 'generated');
  assert.equal(reading.sourceOf(sourced[0], sourced[1]), 'mixed');
});

test('reading completion taxonomy maps every supported format to its exact skill slice', () => {
  const reading = createReadingModule();

  assert.equal(reading.activityId('headings'), READING_ACTIVITY_IDS.headings);
  assert.equal(reading.activityId('gaps'), READING_ACTIVITY_IDS.gaps);
  assert.equal(reading.activityId('questions'), READING_ACTIVITY_IDS.questions);
  assert.ok(READING_GIST_ACTIVITY_IDS.includes(READING_ACTIVITY_IDS.headings));
  assert.ok(READING_DETAIL_ACTIVITY_IDS.includes(READING_ACTIVITY_IDS.gaps));
  assert.ok(READING_DETAIL_ACTIVITY_IDS.includes(READING_ACTIVITY_IDS.questions));
});

test('reading exam emits one gist and one detail slice whose durations sum to the real session', () => {
  const reading = createReadingModule();
  const slices = reading.examEvidenceSlices({ headings: 3, gaps: 2, questions: 4 }, 1_001);

  assert.deepEqual(JSON.parse(JSON.stringify(slices)), [
    { activityId: 'reading_headings', score: 3, maxScore: 4, durationMs: 364 },
    { activityId: 'reading_detail', score: 6, maxScore: 7, durationMs: 637 },
  ]);
  assert.equal(slices.reduce((sum, slice) => sum + slice.durationMs, 0), 1_001);
});
