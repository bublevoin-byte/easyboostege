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
