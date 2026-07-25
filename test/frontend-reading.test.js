import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/reading.js', import.meta.url), 'utf8');

function createReadingModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, Number, Math, Array });
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
});
