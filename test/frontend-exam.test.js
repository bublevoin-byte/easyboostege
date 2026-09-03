import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/exam.js', import.meta.url), 'utf8');

function createExamModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, Number, Math, Array, String, Boolean });
  return window.EasyBoostExam;
}

// Values built inside the vm realm are not reference-equal to host literals.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('exam module keeps attempt count, last and best score', () => {
  const exam = createExamModule();

  assert.deepEqual(plain(exam.record(undefined, 6)), { n: 1, last: 6, best: 6 });
  assert.deepEqual(plain(exam.record({ n: 1, last: 6, best: 6 }, 4)), { n: 2, last: 4, best: 6 });
  assert.deepEqual(plain(exam.record({ n: 2, last: 4, best: 6 }, 9)), { n: 3, last: 9, best: 9 });
  assert.deepEqual(plain(exam.record({ n: 1, last: 3, best: 3 }, -5)), { n: 2, last: 0, best: 3 });
});

test('exam module measures elapsed whole seconds and never goes negative', () => {
  const exam = createExamModule();

  assert.equal(exam.elapsedSeconds(1_000, 91_500), 90);
  assert.equal(exam.elapsedSeconds(5_000, 5_000), 0);
  assert.equal(exam.elapsedSeconds(9_000, 1_000), 0);
});

test('exam module summarizes sections and names the weakest one', () => {
  const exam = createExamModule();
  const parts = [['Заголовки', 4, 4], ['Пропуски', 1, 3], ['Вопросы', 3, 4]];

  assert.equal(exam.total(parts), 8);
  assert.equal(exam.maxScore(parts), 11);
  assert.equal(exam.sectionLine(parts), 'Заголовки 4/4 · Пропуски 1/3 · Вопросы 3/4');
  assert.equal(exam.weakestSection(parts).label, 'Пропуски');
  assert.equal(exam.weakestSection([]), null);
  assert.equal(exam.maxScore([]), 0);
});

test('exam module awards badges by share of the maximum', () => {
  const exam = createExamModule();

  assert.equal(exam.badge(6, 6), '🏆');
  assert.equal(exam.badge(5, 6), '💪');
  assert.equal(exam.badge(3, 6), '📚');
  assert.equal(exam.badge(10, 11), '🏆');
  assert.equal(exam.badge(7, 11), '💪');
  assert.equal(exam.badge(6, 11), '📚');
  assert.equal(exam.badge(12, 13), '🏆');
  assert.equal(exam.badge(8, 13), '💪');
  assert.equal(exam.badge(7, 13), '📚');
  assert.equal(exam.badge(5, 0), '📚');
});

test('exam module honours a section-specific badge scale', () => {
  const exam = createExamModule();
  const oral = { gold: 0.8, silver: 0.5 };

  assert.equal(exam.badge(16, 20, oral), '🏆');
  assert.equal(exam.badge(10, 20, oral), '💪');
  assert.equal(exam.badge(9, 20, oral), '📚');
  assert.equal(exam.badge(16, 20), '💪');
});

test('exam module builds a clamped module-attempt body', () => {
  const exam = createExamModule();

  assert.deepEqual(
    plain(exam.attempt('id-1', { module: 'exam', activity: 'grammar_19_24', score: 5, maxScore: 6, durationMs: 90_000 })),
    {
      id: 'id-1',
      module: 'exam',
      activity: 'grammar_19_24',
      score: 5,
      maxScore: 6,
      durationMs: 90_000,
      metadata: { source: 'builtin' },
    },
  );
  assert.deepEqual(
    plain(exam.attempt(7, { activity: 'x', score: -3, maxScore: '11', durationMs: -1, metadata: { source: 'ai' } })),
    { id: '7', module: 'exam', activity: 'x', score: 0, maxScore: 11, durationMs: 0, metadata: { source: 'ai' } },
  );
});
