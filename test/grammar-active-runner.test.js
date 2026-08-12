import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { GRAMMAR_CATALOG, grammarCatalogCoverage } from '../public/grammar-catalog.js';
import { grammarActivityId, splitLearningActivityDuration } from '../public/learning-activity-contract.js';
import {
  GENERATED_GRAMMAR_REVISION,
  GRAMMAR_ACTIVE_PRACTICE_TYPES,
  GRAMMAR_ERROR_CODES,
  parseGeneratedGrammarItemId,
  parseGeneratedGrammarItemReference,
} from '../public/grammar-domain-contract.js';

const moduleSource = (await fs.readFile(new URL('../public/modules/grammar.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gmu, '')
  .replace(/^export /gmu, '');

function createGrammarModule() {
  const window = {};
  vm.runInNewContext(moduleSource, {
    window, grammarActivityId, splitLearningActivityDuration,
    GENERATED_GRAMMAR_REVISION, GRAMMAR_ACTIVE_PRACTICE_TYPES, GRAMMAR_ERROR_CODES,
    parseGeneratedGrammarItemId, parseGeneratedGrammarItemReference,
    Object, String, Number, Math, Date, Set, Map,
  });
  return window.EasyBoostGrammar;
}

const TENSE_TOPIC_IDS = [1, 2, 3, 13, 4];
const PRACTICE_TYPES = ['choice', 'input', 'correction', 'transform'];
const ERROR_CODES = new Set([
  'construction_choice', 'word_or_verb_form', 'auxiliary', 'agreement',
  'word_order', 'negation_or_question', 'confusion_pair',
]);

const CHOICE_DIAGNOSTIC_FIXTURE = Object.freeze({
  'core.g.1.c.1': [['agreement', null], null, ['confusion_pair', 'present_simple__present_continuous'], ['word_or_verb_form', null]],
  'core.g.1.c.2': [['confusion_pair', 'present_simple__present_continuous'], null, ['agreement', null], ['word_or_verb_form', null]],
  'core.g.1.c.3': [null, ['confusion_pair', 'present_simple__present_continuous'], ['agreement', null], ['word_or_verb_form', null]],
  'core.g.1.c.4': [null, ['confusion_pair', 'stative_verb__present_continuous'], ['agreement', null], ['word_or_verb_form', null]],
  'core.g.1.c.5': [['agreement', null], null, ['confusion_pair', 'present_simple__present_continuous'], ['word_or_verb_form', null]],
  'core.g.1.c.6': [['confusion_pair', 'present_simple__present_continuous'], null, ['word_order', null], ['word_order', null]],
  'core.g.1.c.7': [['confusion_pair', 'stative_verb__present_continuous'], null, ['agreement', null], ['word_or_verb_form', null]],
  'core.g.1.c.8': [['confusion_pair', 'present_simple__present_continuous'], null, ['word_order', null], ['word_order', null]],
  'core.g.2.c.1': [['word_or_verb_form', null], null, ['confusion_pair', 'present_perfect__past_simple'], ['confusion_pair', 'past_simple__past_continuous']],
  'core.g.2.c.2': [['confusion_pair', 'past_simple__past_continuous'], null, ['word_or_verb_form', null], ['word_or_verb_form', null]],
  'core.g.2.c.3': [['word_or_verb_form', null], null, ['confusion_pair', 'present_perfect__past_simple'], ['confusion_pair', 'past_simple__past_continuous']],
  'core.g.2.c.4': [['confusion_pair', 'past_simple__past_continuous'], null, ['word_or_verb_form', null], ['word_or_verb_form', null]],
  'core.g.2.c.5': [['word_or_verb_form', null], null, ['confusion_pair', 'present_perfect__past_simple'], ['confusion_pair', 'past_simple__past_continuous']],
  'core.g.2.c.6': [['word_or_verb_form', null], null, ['confusion_pair', 'past_simple__past_continuous'], ['word_or_verb_form', null]],
  'core.g.2.c.7': [['word_or_verb_form', null], null, ['confusion_pair', 'present_perfect__past_simple'], ['confusion_pair', 'past_simple__past_continuous']],
  'core.g.2.c.8': [['word_or_verb_form', null], null, ['confusion_pair', 'past_simple__past_continuous'], ['word_or_verb_form', null]],
  'core.g.3.c.1': [['auxiliary', null], null, ['auxiliary', null], ['auxiliary', null]],
  'core.g.3.c.2': [['word_or_verb_form', null], ['confusion_pair', 'present_perfect__past_simple'], null, ['word_or_verb_form', null]],
  'core.g.3.c.3': [['confusion_pair', 'present_perfect__past_simple'], null, ['word_or_verb_form', null], ['confusion_pair', 'present_perfect__past_simple']],
  'core.g.3.c.4': [['auxiliary', null], null, ['auxiliary', null], ['auxiliary', null]],
  'core.g.3.c.5': [['auxiliary', null], ['auxiliary', null], null, ['auxiliary', null]],
  'core.g.3.c.6': [['confusion_pair', 'present_perfect__past_simple'], null, ['word_or_verb_form', null], ['word_or_verb_form', null]],
  'core.g.3.c.7': [['auxiliary', null], ['auxiliary', null], null, ['auxiliary', null]],
  'core.g.3.c.8': [['confusion_pair', 'present_perfect__past_simple'], null, ['word_or_verb_form', null], ['word_or_verb_form', null]],
  'core.g.13.c.1': [['auxiliary', null], null, ['auxiliary', null], ['auxiliary', null]],
  'core.g.13.c.2': [['confusion_pair', 'past_perfect__past_simple'], null, ['auxiliary', null], ['word_or_verb_form', null]],
  'core.g.13.c.3': [['confusion_pair', 'past_perfect__past_simple'], null, ['auxiliary', null], ['word_or_verb_form', null]],
  'core.g.13.c.4': [null, ['confusion_pair', 'past_perfect__past_simple'], ['auxiliary', null], ['word_or_verb_form', null]],
  'core.g.13.c.5': [['auxiliary', null], null, ['auxiliary', null], ['auxiliary', null]],
  'core.g.13.c.6': [['confusion_pair', 'past_perfect__past_simple'], null, ['auxiliary', null], ['word_or_verb_form', null]],
  'core.g.13.c.7': [['confusion_pair', 'past_perfect__past_simple'], null, ['auxiliary', null], ['word_or_verb_form', null]],
  'core.g.13.c.8': [['confusion_pair', 'past_perfect__past_simple'], null, ['auxiliary', null], ['word_or_verb_form', null]],
  'core.g.4.c.1': [['construction_choice', null], null, ['construction_choice', 'will__be_going_to'], ['word_or_verb_form', null]],
  'core.g.4.c.2': [['construction_choice', 'will__be_going_to'], null, ['construction_choice', null], ['word_or_verb_form', null]],
  'core.g.4.c.3': [null, ['construction_choice', 'present_simple_schedule__will'], ['construction_choice', null], ['word_or_verb_form', null]],
  'core.g.4.c.4': [['construction_choice', null], null, ['construction_choice', 'present_continuous_arrangement__will'], ['word_or_verb_form', null]],
  'core.g.4.c.5': [['auxiliary', null], ['construction_choice', 'will__be_going_to'], null, ['auxiliary', null]],
  'core.g.4.c.6': [['construction_choice', 'will__be_going_to'], null, ['auxiliary', null], ['auxiliary', null]],
  'core.g.4.c.7': [null, ['construction_choice', 'present_simple_schedule__will'], ['construction_choice', null], ['word_or_verb_form', null]],
  'core.g.4.c.8': [['construction_choice', null], null, ['construction_choice', 'present_continuous_arrangement__will'], ['word_or_verb_form', null]],
});

test('five tense topics expose 160 unique paired active-practice items with exact metadata', () => {
  const coverage = grammarCatalogCoverage(GRAMMAR_CATALOG);
  const activeIds = [];

  for (const topicId of TENSE_TOPIC_IDS) {
    assert.deepEqual(coverage.byPracticeType[topicId], {
      choice: 8, input: 8, correction: 8, transform: 8, total: 32,
    });
    const levels = GRAMMAR_CATALOG.bank[topicId];
    const items = [...levels.c, ...levels.f, ...levels.correction, ...levels.transform];
    assert.equal(items.length, 32);
    for (const item of items) {
      assert.ok(PRACTICE_TYPES.includes(item.type), `${item.id} type`);
      assert.ok(ERROR_CODES.has(item.errorSkill), `${item.id} errorSkill`);
      if (item.confusionPair != null) {
        assert.match(item.confusionPair, /^[a-z0-9]+(?:_[a-z0-9]+)*__(?:[a-z0-9]+(?:_[a-z0-9]+)*)$/u, `${item.id} confusionPair`);
      }
      if (item.errorSkill === 'confusion_pair') assert.ok(item.confusionPair, `${item.id} exact pair`);
      assert.ok(item.e.trim(), `${item.id} explanation`);
      activeIds.push(item.id);
    }
  }

  assert.equal(activeIds.length, 160);
  assert.equal(new Set(activeIds).size, 160);
});

test('every active choice authors one exact diagnostic per wrong option', () => {
  const grammar = createGrammarModule();
  let wrongSlots = 0;
  for (const topicId of TENSE_TOPIC_IDS) {
    for (const item of GRAMMAR_CATALOG.bank[topicId].c) {
      const expected = CHOICE_DIAGNOSTIC_FIXTURE[item.id];
      assert.ok(expected, `${item.id} has an explicit semantic audit fixture`);
      assert.equal(item.diagnostics.length, item.o.length, `${item.id} diagnostic cardinality`);
      item.diagnostics.forEach((diagnostic, optionIndex) => {
        if (optionIndex === item.a) {
          assert.equal(diagnostic, null, `${item.id}:${optionIndex} correct option has no error`);
          assert.equal(expected[optionIndex], null, `${item.id}:${optionIndex} fixture correct option`);
          return;
        }
        wrongSlots += 1;
        assert.ok(ERROR_CODES.has(diagnostic?.errorCode), `${item.id}:${optionIndex} exact errorCode`);
        assert.deepEqual([diagnostic.errorCode, diagnostic.confusionPair], expected[optionIndex],
          `${item.id}:${optionIndex} diagnosis describes the selected option`);
        if (diagnostic.confusionPair != null) {
          assert.match(diagnostic.confusionPair, /^[a-z0-9]+(?:_[a-z0-9]+)*__(?:[a-z0-9]+(?:_[a-z0-9]+)*)$/u,
            `${item.id}:${optionIndex} exact confusionPair`);
        }
        assert.deepEqual(JSON.parse(JSON.stringify(
          grammar.checkPracticeAnswer({ k: 'choice', q: item }, optionIndex),
        )), {
          correct: false,
          normalized: String(optionIndex),
          diagnosticId: diagnostic.id,
          errorCode: diagnostic.errorCode,
          confusionPair: diagnostic.confusionPair,
        });
      });
    }
  }
  assert.equal(Object.keys(CHOICE_DIAGNOSTIC_FIXTURE).length, 40);
  assert.equal(wrongSlots, 120, 'all wrong choice slots receive a literal semantic audit');

  const wordOrder = GRAMMAR_CATALOG.bank[1].c.find((item) => item.id === 'core.g.1.c.6');
  assert.deepEqual(JSON.parse(JSON.stringify(
    grammar.checkPracticeAnswer({ k: 'choice', q: wordOrder }, 3),
  )), {
    correct: false, normalized: '3', diagnosticId: wordOrder.diagnostics[3].id,
    errorCode: 'word_order', confusionPair: null,
  }, '“you are looking” is diagnosed as word order, not a tense confusion');
});

test('every directed active weakness has an exact outcome in its authored transfer mate', () => {
  let pairCount = 0;
  let directedWeaknessCount = 0;
  const bankKind = { choice: 'c', input: 'f', correction: 'correction', transform: 'transform' };
  for (const topicId of TENSE_TOPIC_IDS) {
    const levels = GRAMMAR_CATALOG.bank[topicId];
    for (const type of PRACTICE_TYPES) {
      const pairs = Map.groupBy(levels[bankKind[type]], (item) => item.transferPair);
      assert.equal(pairs.size, 4, `${topicId}:${type} four authored pairs`);
      for (const pair of pairs.values()) {
        assert.equal(pair.length, 2, `${topicId}:${type}:${pair[0]?.transferPair} exact mate`);
        pairCount += 1;
        for (const [index, item] of pair.entries()) {
          const mate = pair[1 - index];
          const weaknesses = item.type === 'choice'
            ? item.diagnostics.filter(Boolean)
            : [{ errorCode: item.errorSkill, confusionPair: item.confusionPair }];
          const mateWeaknesses = mate.type === 'choice'
            ? mate.diagnostics.filter(Boolean)
            : [{ errorCode: mate.errorSkill, confusionPair: mate.confusionPair }];
          for (const weakness of weaknesses) {
            directedWeaknessCount += 1;
            assert.ok(mateWeaknesses.some((candidate) => (
              candidate.errorCode === weakness.errorCode
              && (candidate.confusionPair || null) === (weakness.confusionPair || null)
            )), `${item.id} -> ${mate.id} supports ${weakness.errorCode}:${weakness.confusionPair || '-'}`);
          }
        }
      }
    }
  }
  assert.equal(pairCount, 80);
  assert.equal(directedWeaknessCount, 240,
    '120 authored wrong choice slots plus 120 directed text-item weaknesses are covered');
});

test('active runner builds four ordered levels and checks all answer types through one boundary', () => {
  const grammar = createGrammarModule();
  const queue = grammar.buildActiveTopicQueue(GRAMMAR_CATALOG.bank[1], 1, 'session-one');
  const replayedQueue = grammar.buildActiveTopicQueue(GRAMMAR_CATALOG.bank[1], 1, 'session-one');
  const anotherQueue = grammar.buildActiveTopicQueue(GRAMMAR_CATALOG.bank[1], 1, 'session-two');

  assert.equal(queue.length, 16);
  assert.deepEqual(queue.map((item) => item.q.id), replayedQueue.map((item) => item.q.id));
  assert.notDeepEqual(queue.map((item) => item.q.id), anotherQueue.map((item) => item.q.id));
  assert.deepEqual(Array.from(new Set(queue.map((item) => item.k))), PRACTICE_TYPES);
  for (const type of PRACTICE_TYPES) {
    assert.equal(queue.filter((item) => item.k === type).length, 4, type);
  }
  assert.equal(new Set(queue.map((item) => item.q.id)).size, 16);

  for (const item of queue) {
    const expected = item.k === 'choice' ? item.q.a : `  ${item.q.ans[0].toUpperCase()}... `;
    const result = grammar.checkPracticeAnswer(item, expected);
    assert.equal(result.correct, true, item.q.id);
    assert.equal(result.errorCode, null);
    assert.equal(result.confusionPair, null);
  }
  const controlled = queue.find((item) => item.k === 'transform');
  assert.equal(grammar.checkPracticeAnswer(controlled, 'a plausible but unauthored paraphrase').correct, false,
    'the checker accepts only explicitly catalogued variants');
  const apostropheVariant = {
    k: 'input', q: { ans: ["hasn't finished"], errorSkill: 'auxiliary', confusionPair: null },
  };
  assert.equal(grammar.checkPracticeAnswer(apostropheVariant, '  HASN’T   FINISHED... ').correct, true);
  assert.equal(grammar.checkPracticeAnswer(apostropheVariant, 'has not finished').correct, false,
    'even a semantic equivalent must be explicitly authored');
  assert.equal(grammar.checkPracticeAnswer(apostropheVariant, 'hasnt finished').correct, false,
    'an internal apostrophe remains semantically significant');
  const punctuationVariant = {
    k: 'transform', q: { ans: ['Is Tom reading an article now?'], errorSkill: 'word_order', confusionPair: null },
  };
  for (const answer of [
    'Is Tom reading an article now',
    'Is Tom reading an article now.',
    'Is Tom reading an article now!',
    'Is Tom reading an article now?!',
  ]) assert.equal(grammar.checkPracticeAnswer(punctuationVariant, answer).correct, true,
    `safe terminal punctuation is optional: ${answer}`);
  const internalPunctuation = {
    k: 'transform', q: {
      ans: ["John's well-known answer, however, isn't final."],
      errorSkill: 'word_or_verb_form', confusionPair: null,
    },
  };
  assert.equal(grammar.checkPracticeAnswer(internalPunctuation,
    'John’s well-known answer, however, isn’t final!').correct, true,
  'curly and straight apostrophes normalize to the same preserved mark');
  for (const changed of [
    'Johns well-known answer, however, isnt final.',
    "John's well known answer, however, isn't final.",
    "John's well-known answer however isn't final.",
  ]) assert.equal(grammar.checkPracticeAnswer(internalPunctuation, changed).correct, false,
    `internal punctuation cannot be discarded: ${changed}`);

  const contractions = [
    [1, 'core.g.1.f.3', "doesn't like", 'doesn’t like', 'doesnt like'],
    [2, 'core.g.2.f.5', "didn't see", 'didn’t see', 'didnt see'],
    [3, 'core.g.3.f.4', "hasn't finished", 'hasn’t finished', 'hasnt finished'],
    [13, 'core.g.13.f.2', "hadn't slept", 'hadn’t slept', 'hadnt slept'],
  ];
  for (const [topicId, itemId, straight, typographic, malformed] of contractions) {
    const item = GRAMMAR_CATALOG.bank[topicId].f.find((candidate) => candidate.id === itemId);
    assert.ok(item.ans.includes(straight), `${itemId} authors the standard ASCII contraction`);
    assert.equal(grammar.checkPracticeAnswer({ k: 'input', q: item }, straight).correct, true, itemId);
    assert.equal(grammar.checkPracticeAnswer({ k: 'input', q: item }, typographic).correct, true,
      `${itemId} explicitly normalizes the typographic apostrophe`);
    assert.equal(grammar.checkPracticeAnswer({ k: 'input', q: item }, malformed).correct, false,
      `${itemId} does not accept a missing internal apostrophe`);
  }
  const pastPerfectNegative = GRAMMAR_CATALOG.bank[13].f.find((item) => item.id === 'core.g.13.f.2');
  assert.match(pastPerfectNegative.s, /^Complete in Past Perfect:/u,
    'the all-night context explicitly asks for Past Perfect instead of allowing an ordinary Past Simple reading');
  assert.equal(grammar.checkPracticeAnswer({ k: 'input', q: pastPerfectNegative }, "didn't sleep").correct, false);
  const pastPerfectSet = GRAMMAR_CATALOG.bank[13].f.find((item) => item.id === 'core.g.13.f.7');
  assert.match(pastPerfectSet.s, /^Complete in Past Perfect:/u,
    'the table-setting prompt explicitly fixes the target tense instead of allowing ordinary Past Simple');
  assert.equal(grammar.checkPracticeAnswer({ k: 'input', q: pastPerfectSet }, 'set').correct, false);
});

test('legacy topic choices dispatch by the catalog item type instead of the old queue kind', () => {
  const grammar = createGrammarModule();
  for (let topicId = 5; topicId <= 20; topicId += 1) {
    const question = GRAMMAR_CATALOG.bank[topicId].c[0];
    assert.equal(grammar.checkPracticeAnswer({ k: 'c', q: question, t: topicId }, question.a).correct, true,
      `topic ${topicId} legacy choice`);
  }
});

test('the bridge completion input explicitly requires Past Perfect', () => {
  const grammar = createGrammarModule();
  const item = GRAMMAR_CATALOG.bank[13].f.find((candidate) => candidate.id === 'core.g.13.f.3');
  assert.match(item.s, /^Complete in Past Perfect:/u,
    'the prompt must exclude the grammatical Past Simple reading "they built"');
  assert.equal(grammar.checkPracticeAnswer({ k: 'input', q: item }, 'built').correct, false);
});

test('the forgotten-password input explicitly requires Past Perfect', () => {
  const grammar = createGrammarModule();
  const item = GRAMMAR_CATALOG.bank[13].f.find((candidate) => candidate.id === 'core.g.13.f.5');
  assert.match(item.s, /^Complete in Past Perfect:/u,
    'the prompt must exclude the grammatical sequence-of-events reading "she forgot"');
  assert.equal(grammar.checkPracticeAnswer({ k: 'input', q: item }, 'forgot').correct, false);
});

test('the school-bus input explicitly targets a fixed timetable in Present Simple', () => {
  const grammar = createGrammarModule();
  const item = GRAMMAR_CATALOG.bank[4].f.find((candidate) => candidate.id === 'core.g.4.f.6');
  assert.match(item.s, /^Complete the fixed timetable in Present Simple:/u,
    'the prompt must exclude the grammatical future arrangement "is leaving"');
  assert.equal(grammar.checkPracticeAnswer({ k: 'input', q: item }, 'is leaving').correct, false);
});

test('the when transform uniquely requires an ongoing background action in authored order', () => {
  const grammar = createGrammarModule();
  const item = GRAMMAR_CATALOG.bank[2].transform.find((candidate) => candidate.id === 'core.g.2.transform.1');
  assert.match(item.s, /Сделайте первое действие фоновым процессом, а второе — коротким событием/u);
  assert.match(item.s, /Начните с I/u, 'the instruction fixes the authored clause order');
  assert.equal(grammar.checkPracticeAnswer({ k: 'transform', q: item },
    'I was watching TV when the phone rang.').correct, true);
  assert.equal(grammar.checkPracticeAnswer({ k: 'transform', q: item },
    'I watched TV when the phone rang.').correct, false,
  'Past Simple does not satisfy the requested ongoing background process');
  assert.equal(grammar.checkPracticeAnswer({ k: 'transform', q: item },
    'When the phone rang, I was watching TV.').correct, false,
  'the equally grammatical reversed order is excluded explicitly rather than silently rejected');
});

test('every active item has an authored bounded descriptor and a reserve for its exact weakness', () => {
  for (const topicId of TENSE_TOPIC_IDS) {
    const items = Object.values(GRAMMAR_CATALOG.bank[topicId]).flat();
    const weaknessCounts = new Map();
    for (const item of items) {
      assert.ok(Number.isInteger(item.difficulty) && item.difficulty >= 1 && item.difficulty <= 4, `${item.id} difficulty`);
      assert.match(item.provenance, /^grammar-(?:1-migrated|2-ticket-03)$/u, `${item.id} provenance`);
      const weakness = `${item.errorSkill}:${item.confusionPair || '-'}`;
      weaknessCounts.set(weakness, (weaknessCounts.get(weakness) || 0) + 1);
    }
    assert.ok(weaknessCounts.size > 1, `topic ${topicId} must not claim one topic-wide weakness`);
    for (const [weakness, count] of weaknessCounts) assert.ok(count >= 2, `${topicId}:${weakness} transfer reserve`);
  }
});

test('reviewed controlled prompts do not reject the known grammatical alternatives', () => {
  const items = TENSE_TOPIC_IDS.flatMap((topicId) => Object.values(GRAMMAR_CATALOG.bank[topicId]).flat());
  const prompts = items.map((item) => item.type === 'choice' ? item.t.join('_____') : item.s);
  for (const ambiguous of [
    'Why _____ at me like that?',
    'My keys disappeared; I cannot open the door now.',
    'Nina lost her glasses and still cannot find them.',
    'After we _____ (CHECK) the map, we continued our journey.',
    'They did not ate before they left.',
    'Look! That glass will fall.',
    'I promise I am calling you tonight.',
    'Исправьте ошибку: I was seeing him at the station yesterday.',
    'Перепишите с since 2021: We live in Omsk.',
    'Соедините с before: The shop closed. We reached it.',
    'I hope he _____ (WIN) the match.',
    'She was sad because she _____ her keys.',
    'After I _____ (FINISH) my homework, I went out.',
    'The train _____ at 6:30.',
    'I am sure she _____ (COME) tomorrow.',
    'Передайте действие как происходящее сейчас: The mechanic repairs my bike.',
    'Задайте вопрос к действию: Max was fixing the door at noon.',
  ]) assert.equal(prompts.includes(ambiguous), false, ambiguous);
  assert.ok(prompts.includes('Use Present Simple for the fixed weekday timetable: the train _____ at 6:30.'),
    'the Present Simple choice has one schedule reading');
  assert.ok(prompts.includes('Complete the prediction with will + COME: I am sure she _____ (COME) tomorrow.'),
    'the prediction input explicitly requires will');
  assert.ok(prompts.includes('Добавьте now и передайте действие в Present Continuous: The mechanic repairs my bike.'),
    'the transform explicitly requires the authored now');
  assert.ok(prompts.includes('Задайте вопрос к объекту действия: Max was fixing the door at noon.'),
    'the transform asks for the object answered by what');
});

test('controlled transforms accept only their finite authored adjunct-order variants', () => {
  const grammar = createGrammarModule();
  const allowed = new Map([
    ['core.g.1.transform.4', ['Usually, Kate goes to the gym.']],
    ['core.g.1.transform.6', ['Now the mechanic is repairing my bike.', 'The mechanic is now repairing my bike.']],
    ['core.g.2.transform.5', ['At 8 pm yesterday, I was reading the book.']],
    ['core.g.3.transform.1', ['Since 2021, we have lived in Omsk.']],
    ['core.g.3.transform.3', ['Yesterday, I sent the parcel.']],
    ['core.g.3.transform.6', ["They haven't yet completed the task.", 'They have not yet completed the task.']],
    ['core.g.3.transform.7', ['Last week, I visited the gallery.']],
    ['core.g.13.transform.5', ['By six o’clock yesterday, the team had completed the work.']],
    ['core.g.4.transform.2', ['This weekend, we are going to repaint the kitchen.']],
    ['core.g.4.transform.3', ['At five tomorrow, I am meeting Lena.', "At five tomorrow, I'm meeting Lena."]],
  ]);
  const items = new Map(TENSE_TOPIC_IDS.flatMap((topicId) => (
    GRAMMAR_CATALOG.bank[topicId].transform.map((item) => [item.id, item])
  )));
  const rejected = [];
  for (const [id, variants] of allowed) {
    const item = items.get(id);
    assert.ok(item, id);
    for (const variant of variants) {
      if (!grammar.checkPracticeAnswer({ k: 'transform', q: item }, variant).correct) {
        rejected.push(`${id}: ${variant}`);
      }
    }
  }
  assert.deepEqual(rejected, [], 'every listed variant is grammatical and instruction-compliant');
});

test('a failed answer inserts a distinct unseen transfer item for the exact same weakness', () => {
  const grammar = createGrammarModule();
  const queue = grammar.buildActiveTopicQueue(GRAMMAR_CATALOG.bank[2], 2, () => 0.5);
  const failed = queue[0];
  const session = {
    activeRunner: true,
    queue: queue.slice(),
    i: 0,
    reservedItemIds: queue.map((item) => item.q.id),
  };

  const transfer = grammar.enqueueTransferAfterFailure(session, GRAMMAR_CATALOG.bank[2], failed, () => 0);

  assert.ok(transfer);
  assert.notEqual(transfer.q.id, failed.q.id);
  assert.equal(queue.some((item) => item.q.id === transfer.q.id), false);
  assert.equal(transfer.transfer, true);
  assert.equal(transfer.q.errorSkill, failed.q.errorSkill);
  assert.equal(transfer.q.confusionPair, failed.q.confusionPair);
  assert.equal(session.queue[1].q.id, transfer.q.id);
});

test('deterministic initial queues select one item per exact pair and leave its same-type mate unseen', () => {
  const grammar = createGrammarModule();
  for (const topicId of TENSE_TOPIC_IDS) {
    const bank = GRAMMAR_CATALOG.bank[topicId];
    const all = Object.values(bank).flat();
    for (let seed = 0; seed < 256; seed += 1) {
      const queue = grammar.buildActiveTopicQueue(bank, topicId, `reserve-${topicId}-${seed}`);
      assert.equal(queue.length, 16, `${topicId}:${seed} complete queue`);
      const reserved = new Set(queue.map((item) => item.q.id));
      for (const type of PRACTICE_TYPES) {
        const selected = queue.filter((item) => item.k === type);
        assert.equal(new Set(selected.map((item) => item.q.transferPair)).size, 4,
          `${topicId}:${seed}:${type} one original per exact pair`);
      }
      for (const item of queue) {
        assert.ok(all.some((candidate) => candidate.type === item.q.type && candidate.id !== item.q.id && !reserved.has(candidate.id)
          && candidate.transferPair === item.q.transferPair
          && candidate.errorSkill === item.q.errorSkill && candidate.confusionPair === item.q.confusionPair),
        `${topicId}:${seed}:${item.q.id} same-type exact mate`);
      }
    }
  }
});

test('all sixteen original errors receive sixteen unique authored transfers', () => {
  const grammar = createGrammarModule();
  for (const topicId of TENSE_TOPIC_IDS) {
    const bank = GRAMMAR_CATALOG.bank[topicId];
    const originals = grammar.buildActiveTopicQueue(bank, topicId, `all-wrong-${topicId}`);
    const session = {
      activeRunner: true,
      queue: originals.slice(),
      i: 0,
      reservedItemIds: originals.map((item) => item.q.id),
    };
    const transfers = [];
    for (const original of originals) {
      session.i = session.queue.findIndex((item) => item.q.id === original.q.id);
      const transfer = grammar.enqueueTransferAfterFailure(session, bank, original, `transfer-${original.q.id}`);
      assert.ok(transfer?.q, `${topicId}:${original.q.id} transfer exists`);
      assert.equal(transfer.k, original.k, `${topicId}:${original.q.id} same type`);
      assert.equal(transfer.q.errorSkill, original.q.errorSkill, `${topicId}:${original.q.id} exact error`);
      assert.equal(transfer.q.confusionPair, original.q.confusionPair, `${topicId}:${original.q.id} exact pair`);
      transfers.push(transfer.q.id);
    }
    assert.equal(transfers.length, 16, `${topicId} transfer count`);
    assert.equal(new Set(transfers).size, 16, `${topicId} unique transfers`);
    assert.ok(transfers.every((id) => !originals.some((item) => item.q.id === id)), `${topicId} all transfers unseen`);
  }
});

test('a wrong transfer closes the bounded attempt as due next session instead of silently returning null', () => {
  const grammar = createGrammarModule();
  const bank = GRAMMAR_CATALOG.bank[13];
  const queue = grammar.buildActiveTopicQueue(bank, 13, 'bounded-transfer');
  const original = queue[0];
  const session = { activeRunner: true, queue: queue.slice(), i: 0, reservedItemIds: queue.map((item) => item.q.id) };
  const transfer = grammar.enqueueTransferAfterFailure(session, bank, original, 'first-transfer');
  session.i = session.queue.findIndex((item) => item.q.id === transfer.q.id);
  const resolution = grammar.enqueueTransferAfterFailure(session, bank, transfer, 'no-recursion');
  assert.deepEqual(JSON.parse(JSON.stringify(resolution)), {
    status: 'due_next_session',
    errorCode: transfer.q.errorSkill,
    confusionPair: transfer.q.confusionPair,
    maxTransferAttempts: 1,
  });
});

test('mastery replay fingerprints the entire material event for sessions and reviews', () => {
  const grammar = createGrammarModule();
  const session = {
    id: '00000000-0000-4000-8000-000000000401', scope: 'topic', mode: 'topic_practice', source: 'builtin',
    catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
    items: [{
      id: GRAMMAR_CATALOG.bank[1].c[0].id, type: 'choice', transfer: false, correct: true,
      diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    }],
    startedAt: 1_700_000_000_000, assisted: false,
  };
  const event = {
    id: session.id, type: 'session_completed', expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
    source: 'builtin', assisted: false, completedTypes: ['choice'], typeScores: { choice: { correct: 1, total: 1 } }, session,
  };
  const applied = grammar.reduceMastery(grammar.migrateMasteryRecord(), event, { now: 1_700_000_001_000, clockAuthority: 'server' });
  assert.equal(grammar.masteryEventReplayMatches(applied, event), true);
  assert.equal(grammar.masteryEventReplayMatches(applied, {
    ...event, typeScores: { choice: { correct: 0, total: 1 } }, reason: 'agreement',
  }), false, 'same session with changed scores/reason is not an exact replay');
  assert.equal(grammar.masteryEventReplayMatches(applied, { ...event, expectedRevision: 99 }), false,
    'expectations are part of the replay fingerprint');
  assert.equal(grammar.completionEventIsDurable({ record: applied, event, result: false }), true,
    'a startup flush that wins the retry race is durable through its exact authoritative record');
  assert.equal(grammar.completionEventIsDurable({
    record: applied, event: { ...event, expectedRevision: 99 }, result: false,
  }), false, 'same UUID with mismatched top-level material cannot clear completion_pending');
  assert.equal(grammar.completionEventIsDurable({
    event, result: false, pendingEvents: [{ topicId: 1, event }],
  }), false, 'an exact owner-bound local queue envelope is recoverable but is not durable before server acknowledgement');
  assert.equal(grammar.completionEventIsDurable({
    event: { ...event, expectedRevision: 99 }, result: { queued: true }, pendingEvents: [{ topicId: 1, event }],
  }), false, 'a queued flag or UUID alone cannot conflate changed payloads');

  const review = {
    id: '00000000-0000-4000-8000-000000000402', type: 'review_completed', expectedRevision: 1,
    expectedStage: applied.stage, expectedReviewStep: applied.reviewStep, source: 'builtin', assisted: false, passed: true,
  };
  const reviewed = grammar.reduceMastery(applied, review, { now: 1_700_000_002_000, clockAuthority: 'server' });
  assert.equal(grammar.masteryEventReplayMatches(reviewed, review), true);
  assert.equal(grammar.masteryEventReplayMatches(reviewed, { ...review, passed: false, reason: 'agreement' }), false,
    'review_completed also conflicts on a changed material payload');
});

test('Past Continuous inputs explicitly require an action in progress at the named past moment', () => {
  const prompts = GRAMMAR_CATALOG.bank[2].f.slice(5, 7).map((item) => item.s);
  assert.deepEqual(prompts, [
    'Show the action in progress at nine last night: I _____ (PREPARE) for the test.',
    'Show the action in progress at six yesterday evening: the team _____ (REHEARSE) on stage.',
  ]);
  assert.deepEqual(GRAMMAR_CATALOG.bank[2].f.slice(5, 7).map((item) => item.ans), [
    ['was preparing'], ['was rehearsing'],
  ]);
});

test('transfer exhaustion is an explicit bounded due-next-session outcome', () => {
  const grammar = createGrammarModule();
  const queue = grammar.buildActiveTopicQueue(GRAMMAR_CATALOG.bank[2], 2, 'exhausted');
  const session = {
    activeRunner: true,
    queue: queue.slice(),
    i: 0,
    reservedItemIds: [
      ...GRAMMAR_CATALOG.bank[2].c,
      ...GRAMMAR_CATALOG.bank[2].f,
      ...GRAMMAR_CATALOG.bank[2].correction,
      ...GRAMMAR_CATALOG.bank[2].transform,
    ].map((item) => item.id),
  };
  const before = session.queue.map((item) => item.q.id);

  assert.deepEqual(JSON.parse(JSON.stringify(grammar.enqueueTransferAfterFailure(
    session, GRAMMAR_CATALOG.bank[2], queue[0], 'none-left',
  ))), {
    status: 'due_next_session',
    errorCode: queue[0].q.errorSkill,
    confusionPair: queue[0].q.confusionPair,
    maxTransferAttempts: 1,
  });
  assert.deepEqual(session.queue.map((item) => item.q.id), before);
});

test('the production screen exposes four levels, assisted rule evidence and transfer feedback', async () => {
  const screen = await fs.readFile(new URL('../public/screens/grammar.js', import.meta.url), 'utf8');

  assert.match(screen, /buildActiveTopicQueue/u);
  assert.match(screen, /checkPracticeAnswer/u);
  assert.match(screen, /enqueueTransferAfterFailure/u);
  assert.match(screen, /ИСПРАВЛЕНИЕ/u);
  assert.match(screen, /ПРЕОБРАЗОВАНИЕ/u);
  assert.match(screen, /ТРАНСФЕР/u);
  assert.match(screen, /подход не повышает стадию/u);
  assert.match(screen, /aria-live=["']polite["']/u);
  assert.match(screen, /id="g_rule_btn"[^>]+box-sizing:border-box[^>]+min-block-size:48px[^>]+min-inline-size:48px[^>]+flex:0 0 auto[^>]+display:inline-flex/u,
    'the rule control keeps an actual, non-shrinking touch target above 44px');
  assert.match(screen, /function gExplain[\s\S]+?id="g_card"[^>]+aria-live="polite"/u,
    'the dynamically inserted explanation is announced');
  const choiceFailure = screen.indexOf('enqueueTransferAfterFailure(GS,G_BANK[it.t||GS.t],it');
  const durableExplain = screen.indexOf("GS.phase='explain'", choiceFailure);
  const durablePersist = screen.indexOf('gPersistRunner()', durableExplain);
  const delayedExplain = screen.indexOf('setTimeout(function()', choiceFailure);
  assert.ok(choiceFailure >= 0 && durableExplain > choiceFailure && durablePersist > durableExplain
    && durablePersist < delayedExplain,
    'wrong answer plus transfer must be persisted as explain before the timer can yield');
  const completionStart = screen.indexOf('async function gFinish()');
  const completionEvent = screen.indexOf('finishedSession.completionEvent=gCompletionEvent', completionStart);
  const completionPhase = screen.indexOf("finishedSession.phase='completion_pending'", completionStart);
  const completionPersist = screen.indexOf('gPersistRunner()', completionPhase);
  const completionAwait = screen.indexOf('await gSubmitMasteryEvent', completionPersist);
  assert.ok(completionEvent > completionStart && completionPhase > completionStart
    && completionPersist > completionEvent && completionPersist > completionPhase && completionAwait > completionPersist,
  'completion persists the exact event and pending phase before the async owner lock or network can yield');
  assert.match(screen, /gMasteryDurable[\s\S]+?gClearRunner\(\)/u,
    'the workflow clears only after durable queue acceptance or server replay/application');
});
