import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/speaking.js', import.meta.url), 'utf8');

function createSpeakingModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, Number, Math, Array, String, Boolean });
  return window.EasyBoostSpeaking;
}

// Values built inside the vm realm are not reference-equal to host literals.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('speaking module exposes exam timings and a 20-point maximum', () => {
  const speaking = createSpeakingModule();

  assert.deepEqual(Array.from(speaking.TASKS), [1, 2, 3, 4]);
  assert.equal(speaking.EXAM_MAX, 20);
  assert.deepEqual(plain(speaking.config(1)), { name: 'Чтение вслух', prep: 90, rec: 90, max: 1, sub: 'задание 1 · 1 балл' });
  assert.equal(speaking.config(3).prep, 0);
  assert.equal(speaking.config(4).rec, 150);
  assert.equal(speaking.formatTime(150), '2:30');
  assert.equal(speaking.formatTime(-5), '0:00');
  assert.equal(speaking.formatTime(9), '0:09');
});

test('speaking module counts trainings before any AI score exists', () => {
  const speaking = createSpeakingModule();
  const state = speaking.normalizeState({ t1: { n: 3 }, t3: { n: -2 } });

  assert.deepEqual(plain(state), { t1: { n: 3 }, t3: { n: 0 }, t2: { n: 0 }, t4: { n: 0 } });
  assert.equal(speaking.trainingTotal(state), 3);
  assert.deepEqual(
    { ...speaking.summary([], state) },
    { count: 0, average: 0, trainings: 3, progress: 12, rated: false },
  );
  assert.equal(speaking.summary([], { t1: { n: 40 } }).progress, 100);
});

test('speaking module averages the last five AI scores and caps history', () => {
  const speaking = createSpeakingModule();
  let scores = [];
  for (let index = 0; index < 34; index += 1) {
    scores = speaking.appendScore(scores, { t: 4, g: 5, m: 10, ts: index });
  }

  assert.equal(scores.length, speaking.SCORE_LIMIT);
  assert.equal(scores[0].ts, 4);

  const summary = speaking.summary(scores, { t1: { n: 1 } });
  assert.equal(summary.rated, true);
  assert.equal(summary.average, 50);
  assert.equal(summary.progress, 50);
  assert.equal(summary.count, 30);
});

test('speaking module picks a supported recorder MIME type', () => {
  const speaking = createSpeakingModule();

  assert.equal(speaking.preferredMimeType({ isTypeSupported: () => true }), 'audio/mp4');
  assert.equal(
    speaking.preferredMimeType({ isTypeSupported: (type) => type.startsWith('audio/webm') }),
    'audio/webm;codecs=opus',
  );
  assert.equal(speaking.preferredMimeType({ isTypeSupported: () => false }), '');
  assert.equal(speaking.preferredMimeType(undefined), '');
  assert.equal(speaking.preferredMimeType({ isTypeSupported: () => { throw new Error('blocked'); } }), '');
});

test('speaking module cycles task sets and builds per-task assignments', () => {
  const speaking = createSpeakingModule();
  const sets = speaking.pool([{ tx: 'base' }], [{ tx: 'ai' }]);

  assert.equal(speaking.select(sets, 3).tx, 'ai');
  assert.equal(speaking.select([], 1), null);
  assert.deepEqual(plain(speaking.assignment(2, { ad: 'ad', points: ['a'], qs: ['ignored'] })), { ad: 'ad', points: ['a'] });
  assert.deepEqual(plain(speaking.assignment(3, { topic: 'T', qs: ['q'] })), { topic: 'T', qs: ['q'] });
  assert.deepEqual(plain(speaking.assignment(4, { topic: 'T', plan: ['p'], ph: ['1', '2'] })), { topic: 'T', plan: ['p'], ph: ['1', '2'] });
});

test('speaking module rejects unusable transcripts and clamps AI scores to the task maximum', () => {
  const speaking = createSpeakingModule();

  assert.equal(speaking.isTranscriptUsable('one two three'), true);
  assert.equal(speaking.isTranscriptUsable('  one   two  '), false);
  assert.equal(speaking.isTranscriptUsable(''), false);
  assert.equal(speaking.isTranscriptUsable(null), false);

  assert.deepEqual({ ...speaking.clampScore({ got: 40 }, 1) }, { got: 1, max: 1 });
  assert.deepEqual({ ...speaking.clampScore({ got: -3 }, 4) }, { got: 0, max: 10 });
  assert.deepEqual({ ...speaking.clampScore({ got: '3' }, 5) }, { got: 1, max: 1 });
  assert.deepEqual({ ...speaking.clampScore(null, 3) }, { got: 0, max: 5 });
});

test('speaking module totals the exam, finds the weakest task and updates the record', () => {
  const speaking = createSpeakingModule();
  const results = { 1: { got: 1 }, 2: { got: 4 }, 3: { got: 1 }, 4: { got: 8 } };

  assert.equal(speaking.examTotal(results), 14);
  assert.equal(speaking.weakestTask(results), 3);
  assert.deepEqual(plain(speaking.updateExamRecord(undefined, 14)), { n: 1, last: 14, best: 14 });
  assert.deepEqual(plain(speaking.updateExamRecord({ n: 1, last: 14, best: 14 }, 9)), { n: 2, last: 9, best: 14 });
  assert.equal(speaking.examTotal({}), 0);
});

test('speaking module splits sample answers into sentences for playback', () => {
  const speaking = createSpeakingModule();

  assert.deepEqual(
    Array.from(speaking.sentences('  Hello there! How are you?  ')),
    ['Hello there!', 'How are you?'],
  );
  assert.deepEqual(Array.from(speaking.sentences('no final punctuation')), ['no final punctuation']);
  assert.deepEqual(Array.from(speaking.sentences('   ')), []);
});

test('speaking module rejects malformed AI-generated task sets', () => {
  const speaking = createSpeakingModule();
  const longText = new Array(60).fill('word').join(' ');

  assert.equal(speaking.normalizeGenerated(1, { tx: 'too short' }), null);
  assert.deepEqual(plain(speaking.normalizeGenerated(1, { tx: longText })), { tx: longText });
  assert.equal(speaking.normalizeGenerated(2, { ad: 'ad', points: ['a', 'b', 'c'], exq: ['1', '2', '3', '4'] }), null);
  assert.equal(speaking.normalizeGenerated(2, { ad: 'ad', points: ['a', 'b', 'c', 'd'], exq: ['1'] }), null);
  assert.equal(speaking.normalizeGenerated(3, { topic: 'T', qs: ['1', '2', '3', '4'] }), null);
  assert.equal(speaking.normalizeGenerated(4, { topic: 'T', ph: ['one'] }), null);
  assert.equal(speaking.normalizeGenerated(4, null), null);

  const monologue = speaking.normalizeGenerated(4, { topic: 'T', ph: ['one', 'two'] });
  assert.equal(monologue.plan.length, 4);
  assert.equal(monologue.ph.length, 2);
});
