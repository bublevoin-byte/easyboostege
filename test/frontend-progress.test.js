import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/progress.js', import.meta.url), 'utf8');

function createProgressModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, Number, Math, Array, String, Boolean, Date });
  return window.EasyBoostProgress;
}

// Values built inside the vm realm are not reference-equal to host literals.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('progress module counts whole days to the exam and never goes negative', () => {
  const progress = createProgressModule();
  const exam = Date.parse('2027-06-01T00:00:00Z');

  assert.equal(progress.daysLeft(exam - 10 * 86400000), 10);
  assert.equal(progress.daysLeft(exam), 0);
  assert.equal(progress.daysLeft(exam + 5 * 86400000), 0);
  assert.equal(progress.EXAM_DATE, '2027-06-01');
});

test('progress module caps the daily minute goal at 100 percent', () => {
  const progress = createProgressModule();

  assert.deepEqual({ ...progress.dailyGoal(15) }, { minutes: 15, goal: 30, percent: 50 });
  assert.deepEqual({ ...progress.dailyGoal(90) }, { minutes: 90, goal: 30, percent: 100 });
  assert.deepEqual({ ...progress.dailyGoal(undefined) }, { minutes: 0, goal: 30, percent: 0 });
  assert.deepEqual({ ...progress.dailyGoal(-5) }, { minutes: 0, goal: 30, percent: 0 });
  assert.equal(progress.percent(3, 0), 0);
});

test('progress module normalizes every module value into 0-100', () => {
  const progress = createProgressModule();
  const values = progress.values({ words: 42.6, gram: -10, read: 220, write: '35' });

  assert.deepEqual(plain(values), { words: 43, gram: 0, read: 100, listen: 0, write: 35, speak: 0 });
  assert.deepEqual(Array.from(progress.MODULES), ['words', 'gram', 'read', 'listen', 'write', 'speak']);
  assert.deepEqual(plain(progress.values(null)), { words: 0, gram: 0, read: 0, listen: 0, write: 0, speak: 0 });
});

test('progress module builds the dashboard overview and labels', () => {
  const progress = createProgressModule();
  const exam = Date.parse('2027-06-01T00:00:00Z');
  const view = progress.overview({ streak: 4, learned: 120, dayMin: 30, prog: { words: 50 } }, exam - 86400000);

  assert.equal(view.streak, 4);
  assert.equal(view.learned, 120);
  assert.equal(view.daily.percent, 100);
  assert.equal(view.modules.words, 50);
  assert.equal(view.daysLeft, 1);
  assert.equal(progress.learnedLabel(120), 'учу · 120 / 500');
  assert.equal(progress.learnedLabel(undefined), 'учу · 0 / 500');
  assert.equal(progress.streakLabel(4, true), '🔥 4 дней подряд');
  assert.equal(progress.streakLabel(0), '🔥 0');
});

test('progress module treats a missing state as a zero starting point', () => {
  const progress = createProgressModule();
  const view = progress.overview(null, Date.now());

  assert.equal(view.streak, 0);
  assert.equal(view.learned, 0);
  assert.equal(view.daily.percent, 0);
  assert.deepEqual(plain(view.modules), { words: 0, gram: 0, read: 0, listen: 0, write: 0, speak: 0 });
});
