import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/modules/words.js', import.meta.url), 'utf8');
const screenSource = await fs.readFile(new URL('../public/screens/words.js', import.meta.url), 'utf8');
const indexSource = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');

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

test('verified EGE statistics exclude personal and generated cards', () => {
  const words = createWordsModule();
  const mixed = [
    { w: 'core one', t: 2, provenance: 'core' },
    { w: 'personal one', provenance: 'personal' },
    { w: 'generated one', t: 0, provenance: 'generated' },
  ];
  const records = {
    'core one': { s: 5 }, 'personal one': { s: 5 }, 'generated one': { s: 5 },
  };

  assert.deepEqual({ ...words.calculateStats(mixed, records) }, {
    learned: 1, learning: 0, fresh: 0, total: 1,
  });
});

test('core display spelling reuses the canonical personal mastery identity everywhere', () => {
  const words = createWordsModule();
  const core = [{ w: 'to volunteer', t: 2, provenance: 'core' }];
  const records = { volunteer: { word: 'volunteer', s: 5, due: 100 } };

  assert.equal(words.progressStorageKey(records, 'to volunteer'), 'volunteer');
  assert.deepEqual({ ...words.calculateStats(core, records) }, {
    learned: 1, learning: 0, fresh: 0, total: 1,
  });
  assert.deepEqual(Array.from(words.buildDailyQueue(core, records, {
    now: 200, newLimit: 1,
  }), (item) => item.w), ['to volunteer']);
});

test('words home keeps the four daily choices and estimates the visible workload', () => {
  const words = createWordsModule();

  assert.deepEqual(Array.from(words.newWordBudgets), [5, 10, 15, 20]);
  assert.equal(words.normalizeNewWordBudget(20), 20);
  assert.equal(words.normalizeNewWordBudget(7), 10);
  assert.equal(words.estimateSessionMinutes({ due: 2, weak: 1, fresh: 5 }), 7);
  assert.equal(words.estimateSessionMinutes({ due: 0, weak: 0, fresh: 0 }), 0);
});

test('vocabulary library supports search and multi-select topic, status and provenance filters', () => {
  const words = createWordsModule();
  const entries = words.buildLibraryEntries([
    { w: 'achievement', tr: 'достижение', t: 2, tags: [6], provenance: 'core' },
    { w: 'to volunteer', tr: 'работать волонтёром', t: 9, provenance: 'personal' },
    { w: 'headline', tr: 'заголовок', topics: [8, 9], provenance: 'generated' },
  ], {
    achievement: { state: 'review' },
    'to volunteer': { state: 'learning' },
  }, {
    stateFor: (record) => record?.state || 'new',
  });

  assert.deepEqual(Array.from(entries[0].topicIds), ['2', '6']);
  assert.equal(entries[2].state, 'new');
  assert.deepEqual(
    Array.from(words.filterLibraryEntries(entries, {
      query: 'достиж', topics: ['6', '9'], states: ['review', 'strong'], provenances: ['core'],
    }), (entry) => entry.word),
    ['achievement'],
  );
  assert.deepEqual(
    Array.from(words.filterLibraryEntries(entries, {
      query: '', topics: ['9'], states: ['learning', 'new'], provenances: ['personal', 'generated'],
    }), (entry) => entry.word),
    ['to volunteer', 'headline'],
  );
  assert.deepEqual(
    Array.from(words.filterLibraryEntries(words.buildLibraryEntries([{
      w: 'volunteer', tr: 'волонтёр', provenance: 'personal',
      examples: [{ text: 'They volunteer in other countries.' }],
    }], {}), { query: 'other countries' }), (entry) => entry.word),
    ['volunteer'],
  );
});

test('a persisted personal card becomes a truthful library item without inventing metadata', () => {
  const words = createWordsModule();
  const item = words.personalCardItem({
    id: 'personal:volunteer', canonicalWord: 'volunteer', word: 'volunteer',
    provenance: 'personal', meanings: ['работать волонтёром'],
    pronunciation: '/ˌvɒlənˈtɪə/', partOfSpeech: null, level: null,
    contexts: [{ text: 'They volunteer in other countries.', source: 'reading' }],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(item)), {
    id: 'personal:volunteer', w: 'volunteer', tr: 'работать волонтёром',
    meanings: ['работать волонтёром'], ipa: '/ˌvɒlənˈtɪə/', p: null, level: null,
    ex: 'They volunteer in other countries.',
    examples: [{ text: 'They volunteer in other countries.', source: 'reading' }],
    source: 'Из чтения', provenance: 'personal',
  });
});

test('word details preserve available enrichment and keep missing metadata explicit', () => {
  const words = createWordsModule();
  const original = { w: 'achievement', p: 'n', tr: 'достижение', ex: 'It was an achievement.' };

  assert.deepEqual(JSON.parse(JSON.stringify(words.wordDetails(original))), {
    word: 'achievement', pronunciation: null, partOfSpeech: 'n', level: null,
    meanings: ['достижение'],
    examples: [{ text: 'It was an achievement.', translation: null }],
    source: null,
  });
  assert.deepEqual(original, {
    w: 'achievement', p: 'n', tr: 'достижение', ex: 'It was an achievement.',
  });
});

test('Words screen wires an accessible home, persistent library and read-only detail card', () => {
  assert.match(screenSource, /buildVocabularyQueue/u);
  assert.match(screenSource, /deriveVocabularyState/u);
  assert.match(screenSource, /aria-live="polite"/u);
  assert.match(screenSource, /type="search"/u);
  assert.match(screenSource, /type="checkbox"/u);
  assert.match(screenSource, /Транскрипция пока не добавлена/u);
  assert.match(screenSource, /Перевод примера пока не добавлен/u);
  assert.match(screenSource, /wSpeakLibraryValue/u);
  assert.match(screenSource, /function wPracticeCatalog/u);
  assert.match(screenSource, /var catalog=wPracticeCatalog\(\)/u);
  assert.match(screenSource, /function wHonestDetailItem/u);
  assert.match(screenSource, /id="w_detail_title" tabindex="-1"/u);
  const detailStart = screenSource.indexOf('function wShowWord(');
  const detailEnd = screenSource.indexOf('\nfunction ', detailStart + 1);
  const detailSource = screenSource.slice(detailStart, detailEnd);
  assert.doesNotMatch(detailSource, /srsOk|srsFail|applyVocabularyOutcome/u);
  assert.match(indexSource, /@media\(max-width:375px\).*\.vocab/u);
  assert.match(indexSource, /@media\(prefers-reduced-motion:reduce\).*\.vocab/u);
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
