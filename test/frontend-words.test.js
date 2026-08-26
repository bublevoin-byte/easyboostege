import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { createVocabularySessionView } from '../public/vocabulary-session-view.js';

const source = await fs.readFile(new URL('../public/modules/words.js', import.meta.url), 'utf8');
const screenSource = await fs.readFile(new URL('../public/screens/words.js', import.meta.url), 'utf8');
const appSource = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const indexSource = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const wordsStyles = await fs.readFile(new URL('../public/words.css', import.meta.url), 'utf8').catch(() => '');
const workerSource = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');

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
  assert.match(wordsStyles, /@media \(max-width: 359px\)/u);
  assert.match(wordsStyles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(screenSource, /class="vocab-empty-plan" role="status" aria-live="polite"/u);
  assert.match(screenSource, /Следующие слова появятся здесь, когда подойдёт срок повторения/u);
  assert.match(wordsStyles, /\.vocab-empty-plan[\s\S]*?var\(--aisy-color-success-soft\)/u);
  assert.match(screenSource, /<h1 id="w_home_title" tabindex="-1">Сегодня<\/h1>/u);
  assert.match(screenSource, /focusHome=W_VIEW==='library'\|\|W_VIEW==='practice'/u);
  assert.match(screenSource, /if\(focusHome\)requestAnimationFrame\(function\(\)\{var heading=document\.getElementById\('w_home_title'\);if\(heading\)heading\.focus\(\)\}\)/u);
});

test('Words deep route uses the shared paper shell and a single production action dock', () => {
  const wordsStart = indexSource.indexOf('<div class="screen" id="scr2"');
  const wordsEnd = indexSource.indexOf('<div class="screen" id="scr3"', wordsStart);
  const wordsMarkup = indexSource.slice(wordsStart, wordsEnd);

  assert.match(indexSource, /<link rel="stylesheet" href="\/words\.css">/u);
  assert.match(workerSource, /'\/words\.css'/u);
  assert.match(indexSource, /<main class="words-route"[^>]*aria-labelledby="w_header_title"/u);
  assert.match(indexSource, /id="w_action_dock" class="vocab-action-dock"/u);
  assert.doesNotMatch(wordsMarkup, /class="navclay"/u);
  assert.match(wordsStyles, /\.words-route/u);
  assert.match(wordsStyles, /\.vocab-action-dock/u);
  assert.match(wordsStyles, /var\(--aisy-color-background\)/u);
  assert.match(wordsStyles, /var\(--aisy-button-height\)/u);
  assert.doesNotMatch(wordsStyles, /#[0-9a-f]{3,8}\b/iu);
  assert.match(screenSource, /class="aisy-button vocab-primary/u);
  assert.doesNotMatch(wordsMarkup, /words-legacy|status bar|gradient header/u);
  assert.doesNotMatch(wordsMarkup, /style=/u);
});

test('recognition renders native radio choices and requires an explicit dock commit', () => {
  const card = { innerHTML: '' };
  const options = { innerHTML: '' };
  const actions = [];
  const view = createVocabularySessionView({
    escapeHtml: (value) => String(value), decoration: () => '', badge: () => '', speaker: () => '',
    handlerValue: encodeURIComponent, requestFrame: () => {},
    setPrimaryAction: (...args) => actions.push(args),
  });

  view.renderTask(card, options, {
    token: 17,
    task: { mode: 'receptive_meaning' },
    item: { w: 'achievement', tr: 'достижение' },
    choices: ['результат', 'достижение'],
  });

  assert.match(options.innerHTML, /<fieldset class="vocab-choice-group"><legend>Варианты значения<\/legend>/u);
  assert.equal((options.innerHTML.match(/type="radio" name="w_recognition_choice"/gu) || []).length, 2);
  assert.match(options.innerHTML, /id="w_choice_status"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(options.innerHTML, /data-vocab-choice="%D0%B4%D0%BE%D1%81%D1%82%D0%B8%D0%B6%D0%B5%D0%BD%D0%B8%D0%B5"/u);
  assert.match(options.innerHTML, /event\.key==='Enter'/u);
  assert.deepEqual(actions.at(-1), ['Проверить ответ', 'wSubmitRecognition(17)', true]);
});

test('Russian answer review uses native radio ratings and one explicit primary commit', () => {
  const card = { innerHTML: '' };
  const options = { innerHTML: '' };
  const actions = [];
  const view = createVocabularySessionView({
    escapeHtml: (value) => String(value), decoration: () => '', badge: () => '', speaker: () => '',
    handlerValue: encodeURIComponent, requestFrame: () => {},
    setPrimaryAction: (...args) => actions.push(args),
  });

  view.renderRussianReveal(card, options, { w: 'achievement', tr: 'достижение' }, 19);

  assert.match(options.innerHTML, /<fieldset class="vocab-self-rating"><legend>Насколько близко ты вспомнил\(а\)\?<\/legend>/u);
  assert.equal((options.innerHTML.match(/type="radio" name="w_russian_rating"/gu) || []).length, 3);
  assert.match(options.innerHTML, /wChooseRussianRating\('not_known',19\)/u);
  assert.match(options.innerHTML, /event\.key==='Enter'/u);
  assert.deepEqual(actions.at(-1), ['Сохранить оценку', 'wSubmitRussianRating(19)', true]);
});

test('recognition answer state remains observable until the learner opens review', () => {
  const answerStart = screenSource.indexOf('function wMarkRecognitionResult(');
  const answerEnd = screenSource.indexOf('\nfunction wCompleteIntroduction(', answerStart);
  const answerSource = screenSource.slice(answerStart, answerEnd);

  assert.match(answerSource, /dataset\.sessionPhase='answer'/u);
  assert.match(answerSource, /wSetPrimaryAction\('Разобрать ответ','wShowRecognitionFeedback\('/u);
  assert.match(answerSource, /wFocusPrimaryAction\(\)/u);
  assert.match(answerSource, /id\('w_choice_status'\)|getElementById\('w_choice_status'\)/u);
  assert.doesNotMatch(answerSource, /setTimeout/u);
});

test('Words exposes visible keyboard focus for hidden filter and choice radio inputs', () => {
  assert.match(wordsStyles, /\.vocab-filter-chip input:focus-visible \+ span/u);
  assert.match(wordsStyles, /\.vocab-choice:has\(input:focus-visible\)/u);
  assert.match(wordsStyles, /outline:\s*3px solid var\(--aisy-focus-color\)/u);
});

test('Words uses the approved horizontal paper settle and removes spatial motion when reduced', () => {
  assert.match(screenSource, /wAnim\('vocab-paper-settle','\.36s'\)/u);
  assert.match(wordsStyles, /@keyframes vocab-paper-settle[\s\S]*?translateX\(16px\)[\s\S]*?translateX\(0\)/u);
  assert.match(wordsStyles, /@keyframes vocab-paper-fade[\s\S]*?opacity:\s*0[\s\S]*?transform:\s*none[\s\S]*?opacity:\s*1/u);
  assert.match(wordsStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?#w_card[\s\S]*?animation-name:\s*vocab-paper-fade !important[\s\S]*?animation-duration:\s*var\(--aisy-motion-reduced-opacity\) !important[\s\S]*?transform:\s*none !important/u);
});

test('Words guards every task commit and async mutation with attempt and owner generations', () => {
  assert.match(screenSource, /function wClaimCommit\(token\)/u);
  assert.match(screenSource, /function wClaimAdvance\(token\)/u);
  assert.match(screenSource, /function wClaimReview\(token\)/u);
  assert.match(screenSource, /W_TASK_COMMITTED\.has\(Number\(token\)\)/u);
  assert.match(screenSource, /reportGeneration===W_REPORT_GENERATION/u);
  assert.match(screenSource, /wSameOwner\(owner,currentOwnerBinding\(\)\)/u);
  assert.match(screenSource, /requestGeneration!==W_TOPUP_GENERATION/u);
  assert.match(screenSource, /requestGeneration!==W_SCREEN_GENERATION/u);
  assert.match(screenSource, /dataset\.sessionAttemptId=W_SESSION_ATTEMPT_ID/u);
  assert.match(screenSource, /dataset\.sessionPhase=task\?'task':'summary'/u);
});

test('generated words stay scoped to the current owner state instead of mutating the shared catalog', () => {
  assert.match(appSource, /function wMergeAi\(\)\{return S&&Array\.isArray\(S\.aiWords\)\?S\.aiWords\.slice\(\):\[\]\}/u);
  assert.match(screenSource, /function wOwnerCatalog\(\)\{var catalog=EGE_WORDS\.slice\(\);wordModule\.mergeGenerated\(catalog,wMergeAi\(\)\);return catalog\}/u);
  assert.doesNotMatch(screenSource, /EGE_WORDS\.push/u);
});

test('ordinary vocabulary completion posts one stable bounded session summary', () => {
  assert.match(screenSource, /buildVocabularyModuleAttempt/u);
  assert.match(screenSource, /W_SESSION_ATTEMPT_ID/u);
  assert.match(screenSource, /W_MODULE_ATTEMPT_REPORTED/u);
  assert.match(screenSource, /syncModuleAttempt\(attempt,\{owner:owner\.username,ownerGeneration:owner\.generation\}\)/u);
  assert.match(screenSource, /completeAdaptiveModuleActivity\(\{module:'vocabulary',activityId:W_ADAPTIVE_ACTIVITY,score:attempt\.score,maxScore:attempt\.maxScore/u);
});

test('adaptive vocabulary launch uses the full trainer for topic and evidence mode', () => {
  assert.match(screenSource, /english_production.*vocabulary_productive/su);
  assert.match(screenSource, /contextual_production.*vocabulary_context/su);
  assert.match(screenSource, /listening.*vocabulary_listening/su);
  assert.match(screenSource, /composeVocabularySession\(items,\{progressByWord:progressByWord,forcedMode:forcedMode\}\)/u);
  assert.doesNotMatch(screenSource, /mode!==['"]lexical_choice['"]\|\|!\[1,6\]\.includes\(topicId\)/u);
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
