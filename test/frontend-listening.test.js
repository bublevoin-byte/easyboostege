import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  LISTENING_ACTIVITY_IDS,
  LISTENING_DETAIL_ACTIVITY_IDS,
  LISTENING_GIST_ACTIVITY_IDS,
  learningActivityPool,
  learningActivitySource,
  listeningActivityId,
  splitLearningActivityDuration,
} from '../public/learning-activity-contract.js';

const source = (await fs.readFile(new URL('../public/modules/listening.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/mu, '');

function createListeningModule() {
  const window = {};
  vm.runInNewContext(source, {
    window, learningActivityPool, learningActivitySource, listeningActivityId, splitLearningActivityDuration,
    Object, Number, Math, Array, Set, String,
  });
  return window.EasyBoostListening;
}

test('listening module normalizes state and calculates aggregate accuracy', () => {
  const listening = createListeningModule();
  const state = listening.normalizeState({ m: { ok: 3, tot: 4 }, done: 2 });
  state.tf = { ok: 2, tot: 5 };
  state.iq = { ok: 3, tot: 4 };

  assert.deepEqual(
    { ...listening.summary(state) },
    { correct: 8, total: 13, accuracy: 62, completed: 2 },
  );
});

test('listening module remaps matching answers and enforces unique selections', () => {
  const listening = createListeningModule();
  const shuffled = listening.shuffleMatching({
    st: ['A', 'B', 'C'],
    sp: [{ t: 'one' }, { t: 'two' }],
    a: [0, 2],
    k: ['one', 'two'],
  }, () => 0);

  shuffled.a.forEach((answer, index) => {
    assert.equal(shuffled.st[answer], index === 0 ? 'A' : 'C');
  });
  assert.deepEqual(Array.from(listening.selectUnique([0, 1, null], 2, 1)), [0, null, 1]);
});

test('listening module scores an exam and enforces the playback limit', () => {
  const listening = createListeningModule();
  const result = listening.scoreExam({
    m: { a: [0, 1] },
    tf: { st: [{ a: 2 }, { a: 0 }] },
    iq: { qs: [{ a: 1 }, { a: 2 }] },
    selM: [0, 2],
    selT: [2, 0],
    selI: [1, 0],
  });
  const plays = [0, 0, 0];

  assert.deepEqual({ ...result }, { matching: 1, trueFalse: 2, interview: 1, total: 4 });
  assert.equal(listening.registerPlay(plays, 1), true);
  assert.equal(listening.registerPlay(plays, 1), true);
  assert.equal(listening.registerPlay(plays, 1), false);
  assert.deepEqual(plays, [0, 2, 0]);
  assert.deepEqual(Array.from(listening.pool([1], [2, 3])), [1, 2, 3]);
});

test('listening completion taxonomy maps every supported format to its exact skill slice', () => {
  const listening = createListeningModule();

  assert.equal(listening.activityId('matching'), LISTENING_ACTIVITY_IDS.matching);
  assert.equal(listening.activityId('true_false'), LISTENING_ACTIVITY_IDS.trueFalse);
  assert.equal(listening.activityId('interview'), LISTENING_ACTIVITY_IDS.interview);
  assert.ok(LISTENING_GIST_ACTIVITY_IDS.includes(LISTENING_ACTIVITY_IDS.matching));
  assert.ok(LISTENING_DETAIL_ACTIVITY_IDS.includes(LISTENING_ACTIVITY_IDS.trueFalse));
  assert.ok(LISTENING_DETAIL_ACTIVITY_IDS.includes(LISTENING_ACTIVITY_IDS.interview));
});

test('listening exam emits one gist and one detail slice whose durations sum to the real session', () => {
  const listening = createListeningModule();
  const slices = listening.examEvidenceSlices({
    matching: 5,
    matchingMax: 6,
    trueFalse: 4,
    trueFalseMax: 7,
    interview: 5,
    interviewMax: 7,
  }, 1_001);

  assert.deepEqual(JSON.parse(JSON.stringify(slices)), [
    { activityId: 'listening_matching', score: 5, maxScore: 6, durationMs: 300 },
    { activityId: 'listening_detail', score: 9, maxScore: 14, durationMs: 701 },
  ]);
  assert.equal(slices.reduce((sum, slice) => sum + slice.durationMs, 0), 1_001);
});

test('listening history keeps only bounded attempt metadata for a stable set revision', () => {
  const listening = createListeningModule();
  const set = { id: 'listening-pilot-v1.interview.city-gardens', revision: 2 };
  const history = listening.recordCatalogAttempt(null, set, {
    score: 4,
    maxScore: 7,
    attemptedAt: Date.parse('2026-08-05T10:00:00.000Z'),
    transcriptExposed: true,
    help: { slowPlayback: true, additionalPlaybacks: 2, synthFallback: true },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(history)), {
    version: 1,
    items: {
      'listening-pilot-v1.interview.city-gardens@2': {
        id: 'listening-pilot-v1.interview.city-gardens',
        revision: 2,
        attempts: 1,
        lastScore: 4,
        lastMaxScore: 7,
        lastAttemptAt: 1_785_924_000_000,
        transcriptExposed: true,
        help: { slowPlayback: true, additionalPlaybacks: 2, synthFallback: true },
      },
    },
    presented: {},
    lastSelected: {},
  });
  assert.doesNotMatch(JSON.stringify(history), /city gardens|correct answer|audio\/listening/iu);
});

test('listening history uses help from the latest attempt instead of permanently weakening a set', () => {
  const listening = createListeningModule();
  const set = { id: 'listening-pilot-v1.interview.latest-help', revision: 1 };
  let history = listening.recordCatalogAttempt(null, set, {
    score: 2, maxScore: 7, attemptedAt: 100, transcriptExposed: true,
    help: { slowPlayback: true, additionalPlaybacks: 3, synthFallback: true },
  });
  history = listening.recordCatalogAttempt(history, set, {
    score: 7, maxScore: 7, attemptedAt: 200, transcriptExposed: true,
    help: { slowPlayback: false, additionalPlaybacks: 0, synthFallback: false },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(history.items[`${set.id}@1`].help)), {
    slowPlayback: false, additionalPlaybacks: 0, synthFallback: false,
  });
  assert.equal(history.items[`${set.id}@1`].attempts, 2);
});

test('listening selector prefers unseen sets and avoids the immediately previous id', () => {
  const listening = createListeningModule();
  const pool = [
    { id: 'listening-pilot-v1.matching.alpha', revision: 1, type: 'matching' },
    { id: 'listening-pilot-v1.matching.beta', revision: 1, type: 'matching' },
    { id: 'listening-pilot-v1.matching.gamma', revision: 1, type: 'matching' },
  ];
  let history = listening.rememberCatalogSelection(null, 'matching', pool[0]);
  history = listening.recordCatalogAttempt(history, pool[0], {
    score: 6, maxScore: 6, attemptedAt: 100, transcriptExposed: true,
  });

  const first = listening.selectCatalogSet(pool, history, 'matching', 200);
  assert.equal(first.id, pool[1].id);
  history = listening.rememberCatalogSelection(history, 'matching', first);
  history = listening.recordCatalogAttempt(history, first, {
    score: 5, maxScore: 6, attemptedAt: 200, transcriptExposed: true,
  });

  const second = listening.selectCatalogSet(pool, history, 'matching', 300);
  assert.equal(second.id, pool[2].id);
});

test('twenty abandoned listening launches present twenty unique sets before any repeat', () => {
  const listening = createListeningModule();
  const pool = Array.from({ length: 20 }, (_, index) => ({
    id: `listening-pilot-v1.matching.set-${String(index + 1).padStart(2, '0')}`,
    revision: 1, type: 'matching',
  }));
  let history = null;
  const selected = [];
  for (let index = 0; index < pool.length; index += 1) {
    const set = listening.selectCatalogSet(pool, history, 'matching', 100 + index);
    selected.push(set.id);
    history = listening.rememberCatalogSelection(history, 'matching', set);
  }
  assert.deepEqual(selected, pool.map((set) => set.id));
  assert.equal(Object.keys(history.presented).length, 20);
});

test('after unseen listening sets are exhausted selection is deterministic, due-first and weak-first', () => {
  const listening = createListeningModule();
  const now = Date.parse('2026-08-05T12:00:00.000Z');
  const pool = [
    { id: 'listening-pilot-v1.true-false.strong', revision: 1, type: 'true_false' },
    { id: 'listening-pilot-v1.true-false.weak', revision: 1, type: 'true_false' },
    { id: 'listening-pilot-v1.true-false.recent', revision: 1, type: 'true_false' },
  ];
  let history = null;
  history = listening.recordCatalogAttempt(history, pool[0], {
    score: 7, maxScore: 7, attemptedAt: now - 8 * 86_400_000, transcriptExposed: true,
  });
  history = listening.recordCatalogAttempt(history, pool[1], {
    score: 2, maxScore: 7, attemptedAt: now - 2 * 86_400_000, transcriptExposed: true,
  });
  history = listening.recordCatalogAttempt(history, pool[2], {
    score: 4, maxScore: 7, attemptedAt: now - 60_000, transcriptExposed: true,
  });
  history = listening.rememberCatalogSelection(history, 'true_false', pool[2]);

  assert.equal(listening.selectCatalogSet(pool, history, 'true_false', now).id, pool[1].id);
  assert.equal(listening.catalogAttemptIsAssisted(history, pool[1]), true);
  assert.equal(listening.catalogAttemptIsAssisted(null, pool[1]), false);
});
