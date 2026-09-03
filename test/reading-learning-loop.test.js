import assert from 'node:assert/strict';
import test from 'node:test';

import * as readingCatalog from '../public/reading-catalog-contract.js';
import { ADAPTIVE_ACTIVITY_DEFINITIONS, isAdaptiveLaunchDescriptor } from '../public/adaptive-activity-contract.js';
import { READING_TASK10_SETS } from '../public/content/reading/task10-v1.js';
import { READING_TASK11_SETS } from '../public/content/reading/task11-v1.js';
import { READING_TASK12_18_SETS } from '../public/content/reading/task12-18-v1.js';
import * as vocabulary from '../public/vocabulary-domain.js';
import { getCanonicalVoiceTutorItem, getCanonicalVoiceTutorResultSet } from '../voice-tutor/canonical-items.js';
import { adaptiveReadingMetadata } from '../adaptive-learning/evidence-quality.js';

const previousWindow = globalThis.window;
globalThis.window = {};
await import('../public/modules/reading.js?reading-learning-loop-test');
const reading = globalThis.window.EasyBoostReading;
if (previousWindow === undefined) delete globalThis.window;
else globalThis.window = previousWindow;

const SETS = Object.freeze({
  task10: READING_TASK10_SETS[0],
  task11: READING_TASK11_SETS[0],
  task12_18: READING_TASK12_18_SETS[0],
});

function correctAnswers(set) {
  if (set.kind === 'task12_18') return set.task.questions.map((question) => question.answer);
  return set.task.answers.slice();
}

test('canonical Reading evidence carries exact set provenance and full-section slices share one identity', () => {
  assert.equal(typeof readingCatalog.readingLearningActivityContract, 'function');
  assert.deepEqual(readingCatalog.readingLearningActivityContract(SETS.task10), {
    module: 'reading',
    skillId: 'ege.reading.gist',
    activityId: 'reading_headings',
    mode: 'reading_headings',
    source: 'catalog',
    setId: SETS.task10.id,
    setRevision: SETS.task10.revision,
    kind: 'task10',
    cefr: SETS.task10.cefr,
    maxScore: 7,
    contentRef: readingCatalog.readingAdaptiveContentRef('task10', SETS.task10.cefr),
  });
  assert.deepEqual(readingCatalog.readingLearningActivityContract(SETS.task11), {
    module: 'reading',
    skillId: 'ege.reading.detail',
    activityId: 'reading_gaps',
    mode: 'reading_gaps',
    source: 'catalog',
    setId: SETS.task11.id,
    setRevision: SETS.task11.revision,
    kind: 'task11',
    cefr: SETS.task11.cefr,
    maxScore: 6,
    contentRef: readingCatalog.readingAdaptiveContentRef('task11', SETS.task11.cefr),
  });
  assert.equal(readingCatalog.readingLearningActivityContract(SETS.task12_18).maxScore, 7);

  const attemptId = 'reading-full-learning-loop-01';
  const incomplete = reading.scoreFullSection({ sets: SETS }, {
    task10: correctAnswers(SETS.task10), task11: [], task12_18: [],
  }, { submitted: true, durationMs: 321, attemptId, source: 'catalog' });
  assert.deepEqual(incomplete.evidenceSlices, [], 'an incomplete full section publishes no adaptive evidence');

  const completed = reading.scoreFullSection({ sets: SETS }, {
    task10: correctAnswers(SETS.task10),
    task11: correctAnswers(SETS.task11),
    task12_18: correctAnswers(SETS.task12_18),
  }, { submitted: true, durationMs: 1_001, attemptId, source: 'catalog' });
  assert.deepEqual(completed.evidenceSlices.map((slice) => [slice.activityId, slice.maxScore]), [
    ['reading_headings', 7], ['reading_detail', 13],
  ]);
  assert.equal(completed.evidenceSlices.reduce((sum, slice) => sum + slice.durationMs, 0), 1_001);
  assert.deepEqual(completed.evidenceSlices.map((slice) => slice.attemptId), [attemptId, attemptId]);
  assert.deepEqual(completed.evidenceSlices.map((slice) => slice.slice), ['gist', 'detail']);
  assert.deepEqual(completed.evidenceSlices[0].sets, [readingCatalog.readingSetReference(SETS.task10)]
    .map(({ id, revision, kind }) => ({ id, revision, kind })));
  assert.deepEqual(completed.evidenceSlices[1].sets.map((set) => set.kind), ['task11', 'task12_18']);
});

test('adaptive Reading definitions launch an exact allowlisted kind and CEFR', () => {
  assert.equal(typeof readingCatalog.readingAdaptiveContentRef, 'function');
  assert.equal(typeof readingCatalog.parseReadingAdaptiveContentRef, 'function');
  const definitions = ADAPTIVE_ACTIVITY_DEFINITIONS.filter((item) => item.launch.kind === 'reading_mode');
  assert.equal(definitions.length, 9);
  assert.deepEqual(new Set(definitions.map((item) => item.launch.mode)), new Set(['task10', 'task11', 'task12_18']));
  assert.deepEqual(new Set(definitions.map((item) => item.launch.cefr)), new Set(['B1', 'B2', 'B2+/C1']));
  for (const definition of definitions) {
    assert.equal(isAdaptiveLaunchDescriptor(definition.launch), true);
    assert.deepEqual(readingCatalog.parseReadingAdaptiveContentRef(definition.contentRef), {
      kind: definition.launch.mode, cefr: definition.launch.cefr,
    });
  }
  assert.equal(readingCatalog.parseReadingAdaptiveContentRef('builtin:reading:detail:v1'), null);
  assert.equal(readingCatalog.parseReadingAdaptiveContentRef('browser:reading:task10:b1'), null);
});

test('server adaptive binding accepts only canonical Reading metadata for the exact planned content', () => {
  const block = {
    module: 'reading', activityId: 'reading_gaps', contentRef: 'builtin:reading:task11:b1:v1',
  };
  const metadata = {
    mode: 'reading_gaps', source: 'catalog', helpUsed: false, hintsUsed: 0,
    readingProvenance: 'canonical', readingSetId: SETS.task11.id,
    readingSetRevision: SETS.task11.revision, readingKind: 'task11', readingCefr: SETS.task11.cefr,
    readingContentRef: block.contentRef, readingAttemptId: 'reading-training-01', readingSlice: 'detail',
  };
  assert.deepEqual(adaptiveReadingMetadata(metadata, block), metadata);
  assert.throws(
    () => adaptiveReadingMetadata({ ...metadata, readingContentRef: 'builtin:reading:task11:b2:v1' }, block),
    /ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH/u,
  );
  assert.throws(() => adaptiveReadingMetadata({}, block), /ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH/u);
});

test('Reading vocabulary upsert is normalized, idempotent and preserves exact canonical source context', () => {
  assert.equal(typeof vocabulary.upsertReadingVocabularyCard, 'function');
  const input = {
    word: '  Journeys  ', translation: 'путешествия',
    context: {
      text: SETS.task12_18.task.questions[0].evidence.quote,
      source: 'reading', readingProvenance: 'canonical',
      readingSetId: SETS.task12_18.id, readingSetRevision: SETS.task12_18.revision,
      readingKind: 'task12_18', position: '12', questionId: SETS.task12_18.task.questions[0].id,
    },
  };
  const first = vocabulary.upsertReadingVocabularyCard([], input, { now: 100 });
  const replay = vocabulary.upsertReadingVocabularyCard(first, input, { now: 200 });
  assert.equal(first.length, 1);
  assert.equal(replay.length, 1);
  assert.equal(replay[0].id, 'personal:journeys');
  assert.deepEqual(replay[0].contexts, [input.context]);
  assert.equal(replay[0].createdAt, 100);
  assert.equal(replay[0].updatedAt, 200);
  assert.equal(input.context.text.length > 0, true);
});

test('Reading source locator keeps an exact sentence and question position without copying answer keys', () => {
  const question = SETS.task12_18.task.questions[0];
  const context = readingCatalog.readingSourceContext(SETS.task12_18, question.evidence.quote);
  assert.deepEqual(context, {
    text: question.evidence.quote, source: 'reading', readingProvenance: 'canonical',
    readingSetId: SETS.task12_18.id, readingSetRevision: SETS.task12_18.revision,
    readingKind: 'task12_18', position: '12', questionId: question.id,
  });
  assert.equal(JSON.stringify(context).includes(question.options[question.answer]), false);
  assert.equal(
    readingCatalog.readingSourceContext(SETS.task12_18, 'This sentence was injected into the page.').readingProvenance,
    'technical',
  );
  assert.equal(
    readingCatalog.readingSourceContextFromSets(
      [SETS.task12_18, SETS.task10], SETS.task10.task.evidence[0].quote,
    ).readingSetId,
    SETS.task10.id,
  );
});

test('all Reading 2 kinds rebuild bounded post-submit Voice items from the canonical catalog', () => {
  for (const set of Object.values(SETS)) {
    const resultSet = getCanonicalVoiceTutorResultSet(set.id);
    assert.ok(resultSet, set.id);
    assert.equal(resultSet.revision, set.revision);
    assert.equal(resultSet.items.length, set.kind === 'task11' ? 6 : 7);
    const item = getCanonicalVoiceTutorItem(resultSet.items[0]);
    assert.equal(item.module, 'reading');
    assert.equal(item.skill.id, set.kind === 'task10' ? 'ege.reading.gist' : 'ege.reading.detail');
    assert.deepEqual(item.origin, {
      setId: set.id, setRevision: set.revision, kind: set.kind,
      position: set.kind === 'task12_18' ? '12' : 'A',
      ...(set.kind === 'task12_18' ? { questionId: set.task.questions[0].id } : {}),
    });
    assert.equal(item.context.text.length > 0, true);
    assert.equal(item.context.text.length <= 600, true);
    assert.equal(item.rule.explanation.length > 0, true);
  }
});
