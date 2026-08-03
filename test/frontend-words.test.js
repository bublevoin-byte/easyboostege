import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/words.js', import.meta.url), 'utf8');
const screenSource = await fs.readFile(new URL('../public/screens/words.js', import.meta.url), 'utf8');

function createWordsModule() {
  const window = {};
  vm.runInNewContext(source, { window, Object, String, Number, Math, Date, Set });
  return window.EasyBoostWords;
}

const catalog = [
  { w: 'alpha', p: 'n', tr: 'альфа' },
  { w: 'beta', p: 'n', tr: 'бета' },
  { w: 'gamma', p: 'n', tr: 'гамма' },
  { w: 'delta', p: 'n', tr: 'дельта' },
  { w: 'to improve', p: 'v', tr: 'улучшать' },
];

test('words module calculates SRS statistics and a due-first daily queue', () => {
  const words = createWordsModule();
  const records = {
    alpha: { s: 5, due: 500 },
    beta: { s: 2, due: 100 },
    gamma: { s: 1, due: 900 },
  };

  assert.deepEqual(
    { ...words.calculateStats(catalog, records) },
    { learned: 1, learning: 2, fresh: 2, total: 5 },
  );
  assert.deepEqual(
    Array.from(words.buildDailyQueue(catalog, records, { now: 600, newLimit: 1 }), (item) => item.w),
    ['beta', 'alpha', 'delta'],
  );
});

test('words module migrates legacy progress and selects the exercise mode', () => {
  const words = createWordsModule();
  const records = words.migrateLegacy(catalog, { alpha: 7, beta: 2 }, {}, 123);

  assert.deepEqual({ ...records.alpha }, { s: 3, e: 0, n: 7, due: 123 });
  assert.equal(words.modeFor(), 'c1');
  assert.equal(words.modeFor({ s: 2 }), 'c2');
  assert.equal(words.modeFor({ s: 3 }), 'type');
  assert.equal(words.baseForm('to Improve '), 'improve');
});

test('words module returns unique distractors and merges valid generated words once', () => {
  const words = createWordsModule();
  const mutableCatalog = catalog.map((item) => ({ ...item }));
  const distractors = words.distractors(mutableCatalog, mutableCatalog[0], 'tr', () => 0.1);
  const added = words.mergeGenerated(mutableCatalog, [
    { w: 'alpha', tr: 'дубликат' },
    { w: 'epsilon', tr: 'эпсилон' },
    { w: '', tr: 'пусто' },
    { w: 'epsilon', tr: 'дубликат' },
  ]);

  assert.equal(distractors.length, 3);
  assert.equal(new Set(distractors).size, 3);
  assert.deepEqual(Array.from(added, (item) => item.w), ['epsilon']);
  assert.equal(mutableCatalog.filter((item) => item.w === 'epsilon').length, 1);
});

test('background vocabulary top-up requests a provider-safe tracer batch', () => {
  assert.match(screenSource, /generateAiContent\('vocabulary_cards',\{count:8,exclude:have\}\)/u);
  assert.doesNotMatch(screenSource, /vocabulary_cards',\{count:30/u);
});
