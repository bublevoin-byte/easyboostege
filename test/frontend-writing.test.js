import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/writing.js', import.meta.url), 'utf8');

function createWritingModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, Number, Math, Array, String, Boolean });
  return window.EasyBoostWriting;
}

// Values built inside the vm realm are not reference-equal to host literals.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('writing module counts words and reports the task volume limits', () => {
  const writing = createWritingModule();

  assert.equal(writing.countWords('  Dear   Emily,\n\nThanks a lot!  '), 5);
  assert.equal(writing.countWords(''), 0);
  assert.equal(writing.countWords(null), 0);

  const short = writing.wordCountStatus(new Array(99).fill('word').join(' '), 37);
  const exact = writing.wordCountStatus(new Array(100).fill('word').join(' '), 37);
  const over = writing.wordCountStatus(new Array(251).fill('word').join(' '), 38);

  assert.deepEqual({ ...short }, { count: 99, range: '100–140', state: 'short', ok: false });
  assert.deepEqual({ ...exact }, { count: 100, range: '100–140', state: 'ok', ok: true });
  assert.deepEqual({ ...over }, { count: 251, range: '200–250', state: 'over', ok: false });
  assert.equal(writing.limits(37).maxScore, 6);
  assert.equal(writing.limits(38).maxScore, 14);
});

test('writing module cycles the topic pool and keeps drafts per topic', () => {
  const writing = createWritingModule();
  const topics = writing.pool([{ topic: 'a' }, { topic: 'b' }], [{ topic: 'ai' }]);

  assert.equal(topics.length, 3);
  assert.equal(writing.current(topics, 3).topic, 'a');
  assert.equal(writing.current(topics, 5).topic, 'ai');
  assert.equal(writing.current([], 2), null);
  assert.equal(writing.currentIndex(-1, 3), 2);
  assert.equal(writing.draftKey(38, 5), 'd38_5');
  assert.equal(writing.draftKey(37, undefined), 'd37_0');
});

test('writing module caps history and averages the last five works', () => {
  const writing = createWritingModule();
  let works = [];
  for (let index = 0; index < 32; index += 1) {
    works = writing.appendWork(works, { t: 38, g: 7, m: 14, n: 220, ts: index });
  }

  assert.equal(works.length, writing.HISTORY_LIMIT);
  assert.equal(works[0].ts, 2);
  assert.deepEqual({ ...writing.summary(works) }, { count: 30, average: 50 });
  assert.deepEqual({ ...writing.summary([]) }, { count: 0, average: 0 });

  const recent = writing.appendWork(works, { t: 37, g: 6, m: 6, n: 120, ts: 99 });
  assert.equal(writing.summary(recent).average, 60);
});

test('writing module derives review totals from criteria when overall score is absent', () => {
  const writing = createWritingModule();

  assert.deepEqual(
    { ...writing.reviewTotals({ criteria: [{ got: 2, max: 3 }, { got: 1, max: 3 }] }) },
    { got: 3, max: 6, percent: 50 },
  );
  assert.deepEqual(
    { ...writing.reviewTotals({ overall_got: 0, overall_max: 0, criteria: [] }) },
    { got: 0, max: 0, percent: 0 },
  );
});

test('writing module builds typed payloads for both exam tasks', () => {
  const writing = createWritingModule();

  assert.deepEqual(
    plain(writing.buildPayload(37, { from: 'Emily', stim: 'text?', ask: 'her flat' }, ' answer ')),
    {
      taskType: 'writing_37',
      answer: ' answer ',
      assignment: { from: 'Emily', stimulus: 'text?', questionsTopic: 'her flat' },
    },
  );
  assert.deepEqual(
    plain(writing.buildPayload(38, { topic: 'Sport', rows: [['Fit', '45']] }, 'answer')),
    {
      taskType: 'writing_38',
      answer: 'answer',
      assignment: { topic: 'Sport', rows: [{ label: 'Fit', percent: 45 }] },
    },
  );
  assert.deepEqual(plain(writing.buildPayload(37, null, null).assignment), { from: '', stimulus: '', questionsTopic: '' });
});

test('writing module rejects malformed AI-generated topics', () => {
  const writing = createWritingModule();

  assert.equal(writing.normalizeGenerated(37, { from: 'Ben', stim: 'One? Two?', ask: 'dog' }), null);
  assert.deepEqual(
    plain(writing.normalizeGenerated(37, { from: 'Ben', stim: 'One? Two? Three?', ask: 'dog' })),
    { from: 'Ben', stim: 'One? Two? Three?', ask: 'dog' },
  );
  assert.equal(writing.normalizeGenerated(38, { topic: 'T', rows: [['a', 50], ['b', 50], ['c', 0]] }), null);
  assert.equal(writing.normalizeGenerated(38, { topic: 'T', rows: [['a', 40], ['b', 30], ['c', 20], ['d', 'x']] }), null);
  assert.deepEqual(
    plain(writing.normalizeGenerated(38, { topic: 'T', rows: [['a', 40], ['b', '30'], ['c', 20], ['d', 10]] })),
    { topic: 'T', rows: [['a', 40], ['b', 30], ['c', 20], ['d', 10]] },
  );
  assert.equal(writing.normalizeGenerated(38, null), null);
});

test('writing module produces an offline review that only scores volume', () => {
  const writing = createWritingModule();
  const passed = writing.localReview(120, 37, 'нет сети');
  const failed = writing.localReview(120, 38, '');

  assert.equal(passed.overall_got, 1);
  assert.equal(passed.overall_max, 1);
  assert.match(passed.criteria[0].name, /100–140/u);
  assert.equal(failed.overall_got, 0);
  assert.match(failed.criteria[0].name, /200–250/u);
  assert.match(failed.sub, /нет сети/u);
  assert.equal(failed.errors.every((error) => error.kind === 'warn'), true);
});
