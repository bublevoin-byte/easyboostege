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
import {
  READING_CATALOG_ID,
  READING_KINDS,
  READING_KIND_RULES,
  adaptLegacyReadingFallback,
  assertReadingCatalog,
  assertReadingSet,
  loadReadingCatalog,
  readingSetForLegacyScreen,
  readingSetReference,
} from '../public/reading-catalog-contract.js';
import { assembleReadingPilotCatalog, loadReadingTask10Shard } from '../public/reading-pilot-v1.js';

const source = (await fs.readFile(new URL('../public/modules/reading.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gmu, '');

function createReadingModule() {
  const window = {};
  vm.runInNewContext(source, {
    window, learningActivityPool, learningActivitySource, readingActivityId, splitLearningActivityDuration,
    assertReadingCatalog, loadReadingCatalog, readingSetForLegacyScreen,
    READING_CATALOG_ID, READING_KINDS, READING_KIND_RULES, assertReadingSet, readingSetReference,
    adaptLegacyReadingFallback, assembleReadingPilotCatalog, loadReadingTask10Shard,
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
    { activityId: 'reading_headings', score: 3, maxScore: 7, durationMs: 350 },
    { activityId: 'reading_detail', score: 6, maxScore: 13, durationMs: 651 },
  ]);
  assert.equal(slices.reduce((sum, slice) => sum + slice.durationMs, 0), 1_001);
});

function setReference(kind, suffix, revision = 1) {
  return { id: `reading-pilot-v1.${kind}.${suffix}`, revision, kind, cefr: 'B2' };
}

function scoringSet(kind, suffix = 'score') {
  const set = setReference(kind, suffix);
  if (kind === 'task10') {
    set.task = {
      texts: Array.from({ length: 7 }, (_, index) => ({ id: String.fromCharCode(65 + index), text: `Task 10 source ${index}` })),
      headings: Array.from({ length: 8 }, (_, index) => `Heading ${index}`),
      answers: [0, 1, 2, 3, 4, 5, 6],
      evidence: Array.from({ length: 7 }, (_, index) => ({
        position: String.fromCharCode(65 + index), answer: index,
        quote: `quote ${index}`, explanationRu: `Объяснение ${index}`,
      })),
    };
  } else if (kind === 'task11') {
    set.task = {
      segments: Array.from({ length: 7 }, (_, index) => `Segment ${index}`),
      fragments: Array.from({ length: 7 }, (_, index) => `Fragment ${index}`),
      answers: [0, 1, 2, 3, 4, 5],
      evidence: Array.from({ length: 6 }, (_, index) => ({
        position: String.fromCharCode(65 + index), answer: index,
        leftContext: `Segment ${index}`, rightContext: `Segment ${index + 1}`,
        quote: `Segment ${index}`, explanationRu: `Объяснение ${index}`,
      })),
    };
  } else {
    set.task = {
      text: 'Long source',
      questions: Array.from({ length: 7 }, (_, index) => ({
        id: `${set.id}.q${index + 1}`, prompt: `Question ${index}`,
        options: ['A', 'B', 'C', 'D'], answer: index % 4,
        evidence: { quote: `quote ${index}`, explanationRu: `Объяснение ${index}` },
      })),
    };
  }
  return set;
}

function record(reading, ownerId, history, set, {
  score, maxScore, attemptedAt, durationMs = 1_000, source = 'catalog', assistance,
}) {
  return reading.recordAttempt(ownerId, history, set, {
    attemptId: `${set.id}:${attemptedAt}`,
    score, maxScore, attemptedAt, durationMs, source, assistance,
  });
}

test('Reading exposes one domain API for catalog validation/loading/adaptation', () => {
  const reading = createReadingModule();
  assert.equal(reading.validateCatalog, assertReadingCatalog);
  assert.equal(reading.validateSet, assertReadingSet);
  assert.equal(reading.loadCatalog, loadReadingCatalog);
  assert.equal(reading.adaptSet, readingSetForLegacyScreen);
  assert.equal(reading.adaptLegacyFallback, adaptLegacyReadingFallback);
  assert.equal(reading.assembleCatalog, assembleReadingPilotCatalog);
  assert.equal(reading.loadTask10Shard, loadReadingTask10Shard);
});

test('Reading history is owner-bound, bounded and contains metadata only', () => {
  const reading = createReadingModule();
  const owner = 'student-1';
  let history = null;
  for (let index = 0; index < 205; index += 1) {
    history = record(reading, owner, history, setReference('task10', `history-${index}`), {
      score: 5, maxScore: 7, attemptedAt: 1_700_000_000_000 + index, durationMs: 500,
    });
  }

  assert.equal(history.ownerId, owner);
  assert.equal(history.items.length, 200);
  assert.equal(history.items[0].id, 'reading-pilot-v1.task10.history-204');
  assert.equal(history.items.at(-1).id, 'reading-pilot-v1.task10.history-5');
  assert.deepEqual(Object.keys(history.items[0]).sort(), [
    'assistance', 'attempts', 'durationMs', 'firstAttemptAt', 'id', 'kind',
    'lastAttemptAt', 'maxScore', 'revision', 'score', 'source',
  ]);
  assert.equal(reading.normalizeHistory('student-2', history).items.length, 0);
  assert.doesNotMatch(JSON.stringify(history), /texts|headings|questions|evidence/u);
});

test('recording the same stable attempt twice leaves bounded history unchanged', () => {
  const reading = createReadingModule();
  const set = setReference('task10', 'idempotent');
  const attempt = {
    attemptId: 'attempt-idempotent-1', score: 5, maxScore: 7,
    attemptedAt: 1_700_000_000_000, durationMs: 900, source: 'catalog',
  };
  const first = reading.recordAttempt('student-idempotent', null, set, attempt);
  const replay = reading.recordAttempt('student-idempotent', first, set, attempt);
  assert.deepEqual(JSON.parse(JSON.stringify(replay)), JSON.parse(JSON.stringify(first)));
  assert.equal(replay.items[0].attempts, 1);
  assert.equal(replay.submissions.length, 1);
});

test('technical legacy fallback cannot enter Reading 2.0 history even with a canonical-looking requested id', () => {
  const reading = createReadingModule();
  const legacy = reading.adaptLegacyFallback('task10', {
    hl: ['Heading'], txts: [{ t: 'Legacy text', a: 0, k: 'Старое объяснение' }],
  }, { id: 'reading-pilot-v1.task10.looks-canonical' });
  assert.equal(legacy.recordable, false);
  assert.doesNotMatch(legacy.id, /^reading-pilot-v1\./u);
  assert.throws(() => reading.recordAttempt('student-legacy', null, legacy, {
    attemptId: 'legacy-attempt-1', score: 1, maxScore: 1,
    attemptedAt: 1_700_000_000_000, durationMs: 100, source: 'legacy',
  }), /cannot be recorded/u);

  const task10 = { ...scoringSet('task10', 'forged-legacy'), recordable: false, provenance: 'legacy' };
  const task11 = scoringSet('task11', 'ordinary-11');
  const task12 = scoringSet('task12_18', 'ordinary-12');
  assert.throws(() => reading.submitFullAttempt('student-legacy', null, {
    id: 'legacy-full-attempt', ownerId: 'student-legacy',
    section: {
      catalogId: 'reading-pilot-v1', catalogRevision: 1,
      sets: { task10, task11, task12_18: task12 },
    },
  }, {
    task10: task10.task.answers,
    task11: task11.task.answers,
    task12_18: task12.task.questions.map((question) => question.answer),
  }, { submittedAt: 1_700_000_000_000 }), /cannot be submitted or recorded/u);
});

test('Reading rotation is deterministic unseen then due then weak then old', async (t) => {
  const reading = createReadingModule();
  const owner = 'student-rotation';
  const now = 1_800_000_000_000;
  const a = setReference('task10', 'a');
  const b = setReference('task10', 'b');
  const c = setReference('task10', 'c');

  await t.test('unseen', () => {
    assert.equal(reading.selectNextSet([c, b, a], owner, null, 'task10', { now }).id, a.id);
  });
  await t.test('due beats weak and old', () => {
    let history = record(reading, owner, null, a, { score: 7, maxScore: 7, attemptedAt: now - 8 * 86_400_000 });
    history = record(reading, owner, history, b, { score: 1, maxScore: 7, attemptedAt: now - 1_000 });
    history = record(reading, owner, history, b, { score: 1, maxScore: 7, attemptedAt: now - 500 });
    history = record(reading, owner, history, c, { score: 7, maxScore: 7, attemptedAt: now - 2_000 });
    assert.equal(reading.selectNextSet([c, b, a], owner, history, 'task10', { now }).id, a.id);
  });
  await t.test('weak beats old when neither is due', () => {
    let history = record(reading, owner, null, a, { score: 1, maxScore: 7, attemptedAt: now - 2_000 });
    history = record(reading, owner, history, a, { score: 1, maxScore: 7, attemptedAt: now - 1_000 });
    history = record(reading, owner, history, b, { score: 7, maxScore: 7, attemptedAt: now - 6 * 3_600_000 });
    assert.equal(reading.selectNextSet([b, a], owner, history, 'task10', { now }).id, a.id);
  });
  await t.test('oldest wins when work is neither due nor weak', () => {
    let history = record(reading, owner, null, a, { score: 7, maxScore: 7, attemptedAt: now - 6 * 86_400_000 });
    history = record(reading, owner, history, b, { score: 7, maxScore: 7, attemptedAt: now - 2 * 86_400_000 });
    assert.equal(reading.selectNextSet([b, a], owner, history, 'task10', { now }).id, a.id);
  });
});

test('Reading rotation avoids the last set while an alternative exists and honors CEFR as a preference', () => {
  const reading = createReadingModule();
  const owner = 'student-repeat';
  const a = { ...setReference('task10', 'a'), cefr: 'B1' };
  const b = { ...setReference('task10', 'b'), cefr: 'B2' };
  let history = reading.rememberSelection(owner, null, 'task10', a, 100);

  assert.equal(reading.selectNextSet([a, b], owner, history, 'task10', { now: 200, preferredCefr: 'B1' }).id, b.id);
  history = reading.rememberSelection(owner, history, 'task10', b, 300);
  assert.equal(reading.selectNextSet([a, b], owner, history, 'task10', { now: 400 }).id, a.id);

  const seenPreferred = record(reading, owner, null, a, {
    score: 7, maxScore: 7, attemptedAt: 350,
  });
  assert.equal(
    reading.selectNextSet([a, b], owner, seenPreferred, 'task10', { now: 400, preferredCefr: 'B1' }).id,
    b.id,
    'an unseen set must beat a seen preferred-CEFR set',
  );
});

test('Reading builds and reserves one deterministic set of every format for a full section', () => {
  const reading = createReadingModule();
  const catalog = {
    id: 'reading-pilot-v1', revision: 5,
    sets: [
      setReference('task12_18', 'b'), setReference('task11', 'b'), setReference('task10', 'b'),
      setReference('task12_18', 'a'), setReference('task11', 'a'), setReference('task10', 'a'),
    ],
  };
  const section = reading.selectFullSection(catalog, 'student-full-selection', null, { now: 123 });
  assert.deepEqual(JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(section.sets).map(([kind, set]) => (
    [kind, set.id]
  ))))), {
    task10: 'reading-pilot-v1.task10.a',
    task11: 'reading-pilot-v1.task11.a',
    task12_18: 'reading-pilot-v1.task12_18.a',
  });
  assert.deepEqual(Object.keys(section.history.lastSelected).sort(), ['task10', 'task11', 'task12_18']);
});

test('legacy Reading state migrates all aggregate progress without granting it to another owner', () => {
  const reading = createReadingModule();
  const migrated = reading.migrateLegacyState('student-legacy', {
    h: { ok: 9, tot: 12 }, g: { ok: 4, tot: 6 }, q: { ok: 8, tot: 10 }, texts: 7,
    readExam: { n: 3, best: 10 },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(migrated.totals)), {
    task10: { correct: 9, total: 12 },
    task11: { correct: 4, total: 6 },
    task12_18: { correct: 8, total: 10 },
  });
  assert.equal(migrated.completedSets, 7);
  assert.deepEqual({ ...migrated.legacyFullSections }, { attempts: 3, bestScore: 10, maxScore: 11 });
  const otherOwner = reading.migrateLegacyState('other-owner', migrated);
  assert.deepEqual(JSON.parse(JSON.stringify(otherOwner.totals)), {
    task10: { correct: 0, total: 0 },
    task11: { correct: 0, total: 0 },
    task12_18: { correct: 0, total: 0 },
  });
  assert.equal(otherOwner.completedSets, 0);
  assert.deepEqual({ ...otherOwner.legacyFullSections }, { attempts: 0, bestScore: 0, maxScore: 11 });
  assert.equal(otherOwner.history.items.length, 0);
});

test('Reading official scoring differs from raw fields exactly as FIPI specifies', () => {
  const reading = createReadingModule();
  const task10 = scoringSet('task10');
  const task11 = scoringSet('task11');
  const task12 = scoringSet('task12_18');

  assert.deepEqual([0, 1, 2, 3].map((errors) => (
    reading.scoreSet(task10, task10.task.answers.map((answer, index) => index < errors ? 7 : answer)).officialScore
  )), [3, 2, 1, 0]);
  assert.deepEqual([0, 1, 2].map((errors) => (
    reading.scoreSet(task11, task11.task.answers.map((answer, index) => index < errors ? 6 : answer)).officialScore
  )), [2, 1, 0]);
  assert.equal(reading.scoreSet(task10, [...task10.task.answers, 0]).officialScore, 0);
  assert.equal(reading.scoreSet(task11, [...task11.task.answers, 0]).officialScore, 0);
  assert.deepEqual(
    { ...reading.scoreSet(task12, task12.task.questions.map((question) => question.answer)) },
    {
      kind: 'task12_18', rawScore: 7, rawMaxScore: 7, officialScore: 7, officialMaxScore: 7,
      review: reading.scoreSet(task12, task12.task.questions.map((question) => question.answer)).review,
    },
  );
});

test('submitted full Reading returns 12 official points, 20 raw fields, reviews and two raw evidence slices', () => {
  const reading = createReadingModule();
  const task10 = scoringSet('task10', 'full-10');
  const task11 = scoringSet('task11', 'full-11');
  const task12 = scoringSet('task12_18', 'full-12');
  const section = {
    catalogId: 'reading-pilot-v1', catalogRevision: 4,
    sets: { task10, task11, task12_18: task12 },
  };
  const answers = {
    task10: task10.task.answers,
    task11: task11.task.answers,
    task12_18: task12.task.questions.map((question) => question.answer),
  };

  const hidden = reading.scoreFullSection(section, answers, { durationMs: 2_003, submitted: false });
  assert.deepEqual(
    JSON.parse(JSON.stringify({ review: hidden.review, evidenceSlices: hidden.evidenceSlices })),
    { review: null, evidenceSlices: [] },
  );

  const result = reading.scoreFullSection(section, answers, {
    durationMs: 2_003, submitted: true, source: 'catalog', assistance: { hintUsed: false },
    attemptId: 'full-score-1',
  });
  assert.deepEqual(
    [result.officialScore, result.officialMaxScore, result.rawScore, result.rawMaxScore, result.review.length],
    [12, 12, 20, 20, 20],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.evidenceSlices.map(({ activityId, score, maxScore }) => (
      { activityId, score, maxScore }
    )))),
    [
      { activityId: 'reading_headings', score: 7, maxScore: 7 },
      { activityId: 'reading_detail', score: 13, maxScore: 13 },
    ],
  );
  assert.equal(result.evidenceSlices.reduce((sum, slice) => sum + slice.durationMs, 0), 2_003);
  assert.deepEqual(Array.from(result.evidenceSlices.map((slice) => slice.idempotencyKey)), [
    'full-score-1:reading_headings', 'full-score-1:reading_detail',
  ]);
  assert.deepEqual(
    Array.from(result.evidenceSlices.flatMap((slice) => slice.sets.map((set) => set.kind))),
    ['task10', 'task11', 'task12_18'],
  );
});

test('full Reading submission records history and evidence only once for one attempt id', () => {
  const reading = createReadingModule();
  const sets = {
    task10: scoringSet('task10', 'submit-10'),
    task11: scoringSet('task11', 'submit-11'),
    task12_18: scoringSet('task12_18', 'submit-12'),
  };
  const attempt = {
    id: 'full-submit-1', ownerId: 'student-submit',
    section: { catalogId: 'reading-pilot-v1', catalogRevision: 1, sets },
  };
  const answers = {
    task10: sets.task10.task.answers,
    task11: sets.task11.task.answers,
    task12_18: sets.task12_18.task.questions.map((question) => question.answer),
  };
  const options = { durationMs: 2_003, submittedAt: 1_700_000_000_000, source: 'catalog' };
  const first = reading.submitFullAttempt('student-submit', null, attempt, answers, options);
  const replay = reading.submitFullAttempt('student-submit', first.history, attempt, answers, options);

  assert.equal(first.duplicate, false);
  assert.equal(first.history.items.length, 3);
  assert.equal(first.history.items.reduce((sum, item) => sum + item.durationMs, 0), 2_003);
  assert.equal(first.result.evidenceSlices.length, 2);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.result.evidenceSlices.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(replay.history)), JSON.parse(JSON.stringify(first.history)));
});

test('full Reading resume stores answers but no content and rejects owner, catalog or set revision drift', () => {
  const reading = createReadingModule();
  const sets = {
    task10: scoringSet('task10', 'resume-10'),
    task11: scoringSet('task11', 'resume-11'),
    task12_18: scoringSet('task12_18', 'resume-12'),
  };
  const catalog = { id: 'reading-pilot-v1', revision: 3, sets: Object.values(sets) };
  const snapshot = reading.serializeFullAttempt({
    id: 'attempt-1', ownerId: 'student-resume',
    section: { catalogId: catalog.id, catalogRevision: catalog.revision, sets },
    answers: { task10: [0, null, null, null, null, null, null], task11: [], task12_18: [] },
    currentKind: 'task10', startedAt: 1_700_000_000_000, durationMs: 456,
  });

  assert.doesNotMatch(JSON.stringify(snapshot), /Long source|Task 10 source|evidence|questions/u);
  assert.equal(reading.restoreFullAttempt(snapshot, catalog, 'student-resume').ok, true);
  assert.equal(reading.restoreFullAttempt(snapshot, catalog, 'other-owner').reason, 'owner-mismatch');
  assert.equal(reading.restoreFullAttempt(snapshot, { ...catalog, id: 'reading-pilot-v2' }, 'student-resume').reason, 'catalog-version-mismatch');
  assert.equal(reading.restoreFullAttempt(snapshot, { ...catalog, revision: 4 }, 'student-resume').reason, 'catalog-revision-mismatch');
  const revisedCatalog = structuredClone(catalog);
  revisedCatalog.sets[0].revision = 2;
  assert.equal(reading.restoreFullAttempt(snapshot, revisedCatalog, 'student-resume').reason, 'set-revision-mismatch');
});
