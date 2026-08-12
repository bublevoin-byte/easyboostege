import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import {
  GRAMMAR_CATALOG,
  GRAMMAR_CATALOG_V1,
  GRAMMAR_CATALOG_V2,
  grammarCatalogCoverage,
} from '../public/grammar-catalog.js';
import { EasyBoostGrammar as grammar } from '../public/modules/grammar.js';
import { grammarMasteryEventSchema } from '../validation/grammar-mastery.js';

const FUNCTION_WORD_TOPIC_IDS = Object.freeze([14, 15, 19]);
const TYPES = Object.freeze(['choice', 'input', 'correction', 'transform']);
const BANK_KIND = Object.freeze({ choice: 'c', input: 'f', correction: 'correction', transform: 'transform' });

function topicItems(topicId) {
  return Object.values(GRAMMAR_CATALOG.bank[topicId]).flat();
}

function itemById(itemId) {
  for (const topicId of FUNCTION_WORD_TOPIC_IDS) {
    const item = topicItems(topicId).find((candidate) => candidate.id === itemId);
    if (item) return item;
  }
  assert.fail(`missing function-word item ${itemId}`);
}

function visiblePrompt(item) {
  return item.type === 'choice' ? item.t.join(' _____ ') : item.s;
}

function promptDisclosesAnswer(item, answer) {
  const prompt = visiblePrompt(item).toLowerCase().replace(/\s+/gu, ' ');
  const token = String(answer).toLowerCase().trim().replace(/\s+/gu, ' ')
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^a-z])${token}([^a-z]|$)`, 'u').test(prompt);
}

test('all three function-word topics expose the complete four-level public catalog contract', () => {
  const coverage = grammarCatalogCoverage(GRAMMAR_CATALOG);
  const activeIds = [];

  for (const topicId of FUNCTION_WORD_TOPIC_IDS) {
    assert.deepEqual(coverage.byPracticeType[topicId], {
      choice: 8,
      input: 8,
      correction: 8,
      transform: 8,
      total: 32,
    });
    assert.equal(grammar.hasActivePractice(GRAMMAR_CATALOG.bank[topicId]), true);

    for (const type of TYPES) {
      const items = GRAMMAR_CATALOG.bank[topicId][BANK_KIND[type]];
      assert.equal(items.length, 8, `${topicId}:${type}`);
      const pairs = Map.groupBy(items, (item) => item.transferPair);
      assert.equal(pairs.size, 4, `${topicId}:${type} has four transfer pairs`);
      for (const [pairId, pair] of pairs) {
        assert.equal(pair.length, 2, pairId);
        assert.equal(new Set(pair.map((item) => `${item.errorSkill}:${item.confusionPair || '-'}`)).size, 1,
          `${pairId} keeps one exact weakness`);
        assert.notEqual(visiblePrompt(pair[0]), visiblePrompt(pair[1]), `${pairId} changes the context`);
      }
      for (const item of items) {
        assert.equal(item.type, type, item.id);
        assert.match(item.e, /\S/u, item.id);
        assert.match(item.provenance, /^(grammar-1-migrated|grammar-2-ticket-06)$/u, item.id);
        assert.ok(Number.isInteger(item.difficulty) && item.difficulty >= 1 && item.difficulty <= 3, item.id);
        activeIds.push(item.id);
      }
    }
  }

  assert.equal(activeIds.length, 96);
  assert.equal(new Set(activeIds).size, 96);
});

test('zero articles and context-bound article choices publish finite exact answers', () => {
  const accepted = Object.freeze({
    'core.g.14.f.1': ['an'],
    'core.g.14.f.3': ['—', '-', 'no article', 'zero article'],
    'core.g.14.f.4': ['—', '-', 'no article', 'zero article'],
    'core.g.14.f.5': ['the'],
    'core.g.14.f.7': ['—', '-', 'no article', 'zero article'],
    'core.g.14.f.8': ['the'],
  });

  for (const [itemId, answers] of Object.entries(accepted)) {
    const item = itemById(itemId);
    assert.deepEqual(item.ans, answers, itemId);
    for (const answer of answers) assert.equal(grammar.checkPracticeAnswer(item, answer).correct, true, `${itemId}:${answer}`);
  }
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.14.f.3'), 'the').correct, false);
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.14.f.8'), '—').correct, false);
});

test('article inputs state the discourse or institutional context that makes one answer exact', () => {
  const firstSolution = itemById('core.g.14.f.1');
  const firstMention = itemById('core.g.14.f.2');
  const ordinaryMeal = itemById('core.g.14.f.3');
  const normalPurpose = itemById('core.g.14.f.4');

  assert.match(firstSolution.s, /listener does not know which solution/iu);
  assert.deepEqual(firstSolution.ans, ['an']);
  assert.match(firstMention.s, /listener does not know which umbrella/iu);
  assert.deepEqual(firstMention.ans, ['an']);
  assert.match(ordinaryMeal.s, /ordinary meal/iu);
  assert.match(ordinaryMeal.s, /not a scheduled event/iu);
  assert.deepEqual(ordinaryMeal.ans, ['—', '-', 'no article', 'zero article']);
  assert.match(normalPurpose.s, /as pupils/iu);
  assert.match(normalPurpose.s, /normal purpose/iu);
  assert.deepEqual(normalPurpose.ans, ['—', '-', 'no article', 'zero article']);
});

test('the activated first article choice states a listener-new idea without mutating v1', () => {
  const active = itemById('core.g.14.c.1');
  assert.match(visiblePrompt(active), /listener has not heard this suggestion before/iu);
  assert.equal(active.o[active.a], 'an');
  assert.deepEqual(GRAMMAR_CATALOG_V1.bank[14].c[0].t, ['I have ', ' idea!']);
});

test('the added honest-person choice and meal correction state the exact article context', () => {
  const honestPerson = itemById('core.g.14.c.6');
  const breakfast = itemById('core.g.14.correction.3');
  assert.match(visiblePrompt(honestPerson), /not identifying her among known people/iu);
  assert.equal(honestPerson.o[honestPerson.a], 'an');
  assert.match(breakfast.s, /ordinary meal/iu);
  assert.match(breakfast.s, /not a scheduled event/iu);
  assert.deepEqual(breakfast.ans, ['We had breakfast at seven.']);
});

test('an extra indefinite meal article transfers to the same zero-article weakness', () => {
  const breakfast = itemById('core.g.14.correction.3');
  const mealMate = itemById('core.g.14.correction.4');
  assert.equal(breakfast.confusionPair, 'zero_article__indefinite_article');
  assert.equal(mealMate.confusionPair, 'zero_article__indefinite_article');
  assert.equal(breakfast.transferPair, mealMate.transferPair);
  assert.match(mealMate.s, /ordinary meal/iu);
  assert.notEqual(breakfast.s, mealMate.s);
});

test('time and dependent prepositions remain explicit at the shared answer boundary', () => {
  const accepted = Object.freeze({
    'core.g.15.f.1': ['at'],
    'core.g.15.f.2': ['at'],
    'core.g.15.f.3': ['on'],
    'core.g.15.f.4': ['on'],
    'core.g.15.f.5': ['in', 'during'],
    'core.g.15.f.6': ['in', 'during', 'over'],
    'core.g.15.f.7': ['to'],
    'core.g.15.f.8': ['for'],
  });

  for (const [itemId, answers] of Object.entries(accepted)) {
    const item = itemById(itemId);
    assert.deepEqual(item.ans, answers, itemId);
    for (const answer of answers) {
      assert.equal(grammar.checkPracticeAnswer(item, answer).correct, true, `${itemId}:${answer}`);
    }
    assert.equal(grammar.checkPracticeAnswer(item, `${answers[0]}wards`).correct, false, itemId);
  }
  assert.match(itemById('core.g.15.f.5').e, /during/iu);
  assert.match(itemById('core.g.15.f.6').e, /during/iu);
});

test('time-preposition inputs bound the intended relation without disclosing accepted tokens', () => {
  const constraints = Object.freeze({
    'core.g.15.f.1': /exactly.*not earlier, later, or approximately/iu,
    'core.g.15.f.2': /specific rule-card expression.*night/iu,
    'core.g.15.f.3': /takes place.*scheduled day/iu,
    'core.g.15.f.4': /takes place.*scheduled date/iu,
    'core.g.15.f.5': /exact date.*inside.*calendar year/iu,
    'core.g.15.f.6': /one or more times inside.*not across the whole/iu,
  });
  for (const [itemId, constraint] of Object.entries(constraints)) {
    const item = itemById(itemId);
    assert.match(item.s, constraint, itemId);
    for (const answer of item.ans) assert.equal(promptDisclosesAnswer(item, answer), false, `${itemId}:${answer}`);
  }
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.15.f.1'), 'before').correct, false);
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.15.f.3'), 'for').correct, false);
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.15.f.4'), 'for').correct, false);
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.15.f.6'), 'throughout').correct, false);
});

test('the listen input fixes the dependent-preposition reading instead of a duration or search reading', () => {
  const item = itemById('core.g.15.f.7');
  assert.match(item.s, /fixed dependent preposition/iu);
  assert.match(item.s, /pay attention/iu);
  assert.deepEqual(item.ans, ['to']);
  assert.equal(promptDisclosesAnswer(item, 'to'), false);
});

test('the responsibility input fixes accountability instead of manner while handling equipment', () => {
  const item = itemById('core.g.15.f.8');
  assert.match(item.s, /duty is to maintain/iu);
  assert.deepEqual(item.ans, ['for']);
  assert.equal(grammar.checkPracticeAnswer(item, 'with').correct, false);
  assert.equal(promptDisclosesAnswer(item, 'for'), false);
});

test('the December choice fixes an in-month meaning instead of also allowing a deadline', () => {
  const item = itemById('core.g.15.c.7');
  assert.deepEqual(item.t, ['Our course ends ', ' December, sometime during that month.']);
  assert.deepEqual(item.o, ['at', 'on', 'in', 'of']);
  assert.equal(item.o[item.a], 'in');
  assert.deepEqual(item.diagnostics[3], {
    id: 'core.g.15.c.7.diagnostic.4',
    errorCode: 'confusion_pair',
    confusionPair: 'time_preposition__non_time_preposition',
  });
});

test('the active Monday choice removes a valid deadline reading without mutating v1', () => {
  const active = itemById('core.g.15.c.3');
  assert.deepEqual(active.o, ['at', 'on', 'in', 'of']);
  assert.equal(active.o[active.a], 'on');
  assert.deepEqual(GRAMMAR_CATALOG_V1.bank[15].c[2].o, ['at', 'on', 'in', 'by']);
});

test('the recurring-day choice labels only an unambiguously non-time distractor as non-time', () => {
  const item = itemById('core.g.15.c.8');
  assert.deepEqual(item.o, ['at', 'on', 'in', 'of']);
  assert.equal(item.o[item.a], 'on');
  assert.deepEqual(item.diagnostics[3], {
    id: 'core.g.15.c.8.diagnostic.4',
    errorCode: 'confusion_pair',
    confusionPair: 'time_preposition__non_time_preposition',
  });
});

test('the noon choice labels only an unambiguously non-time distractor as non-time', () => {
  const item = itemById('core.g.15.c.6');
  assert.deepEqual(item.o, ['at', 'on', 'in', 'of']);
  assert.equal(item.o[item.a], 'at');
  assert.equal(item.diagnostics[3].confusionPair, 'time_preposition__non_time_preposition');
});

test('fixed-preposition corrections name the exact structure required by their finite grader', () => {
  const month = itemById('core.g.15.correction.5');
  const year = itemById('core.g.15.correction.6');
  const dependent = itemById('core.g.15.correction.8');
  assert.match(month.s, /Используйте IN/u);
  assert.match(year.s, /Используйте IN/u);
  assert.match(dependent.s, /Используйте ON/u);
  assert.deepEqual(month.ans, ['The festival is in August.']);
  assert.deepEqual(year.ans, ['The bridge opened in 2010.']);
  assert.deepEqual(dependent.ans, ['Success depends on regular practice.']);
});

test('each cause-result correction transfers the same concrete connector weakness', () => {
  const item = itemById('core.g.19.correction.2');
  const mate = itemById('core.g.19.correction.1');

  assert.match(item.s, /Замените SO на BECAUSE/u);
  assert.doesNotMatch(item.s, /BECAUSE OF/iu);
  assert.deepEqual(item.ans, [
    'We drove slowly because the road was icy.',
    'Because the road was icy, we drove slowly.',
  ]);
  assert.equal(item.confusionPair, 'because__so');
  assert.equal(item.transferPair, mate.transferPair);
  assert.equal(item.confusionPair, mate.confusionPair);
});

test('connector tasks distinguish clauses, noun phrases and independent-sentence punctuation', () => {
  const accepted = Object.freeze({
    'core.g.19.f.1': ['because', 'since', 'as'],
    'core.g.19.f.2': ['so', 'and so', 'and therefore'],
    'core.g.19.f.3': ['although', 'though', 'even though', 'while', 'whereas', 'whilst'],
    'core.g.19.f.4': ['despite', 'in spite of'],
    'core.g.19.f.5': ['however', 'nevertheless', 'nonetheless', 'regardless', 'still', 'yet'],
    'core.g.19.f.6': ['but', 'yet', 'and yet'],
    'core.g.19.f.7': ['while', 'whilst', 'whereas', 'although', 'though', 'even though', 'but', 'yet', 'and yet'],
    'core.g.19.f.8': ['so', 'and so', 'and therefore'],
  });

  for (const [itemId, answers] of Object.entries(accepted)) {
    const item = itemById(itemId);
    assert.deepEqual(item.ans, answers, itemId);
    for (const answer of answers) assert.equal(grammar.checkPracticeAnswer(item, answer).correct, true, `${itemId}:${answer}`);
  }
  assert.match(itemById('core.g.19.f.3').s, /she felt tired/iu);
  assert.match(itemById('core.g.19.f.4').s, /her tiredness/iu);
  assert.match(itemById('core.g.19.f.5').s, /\. _____,/u);
  assert.match(itemById('core.g.19.f.6').s, /, _____/u);
});

test('connector inputs bound the relation and syntax without disclosing accepted tokens', () => {
  const constraints = Object.freeze({
    'core.g.19.f.1': /one-word subordinating cause connector/iu,
    'core.g.19.f.2': /result conjunction.*rule card.*preceded by and/iu,
    'core.g.19.f.3': /concessive subordinator.*asserts.*actually felt tired/iu,
    'core.g.19.f.4': /concessive prepositions.*contrasted with.*clause subordinator.*rule card/iu,
    'core.g.19.f.5': /single-word contrast adverb.*safer route.*despite being longer/iu,
    'core.g.19.f.6': /coordinating conjunction.*one word.*and.*coordinating conjunction/iu,
    'core.g.19.f.7': /conjunction.*parallel facts.*inside one sentence/iu,
    'core.g.19.f.8': /result conjunction.*rule card.*preceded by and/iu,
  });
  for (const [itemId, constraint] of Object.entries(constraints)) {
    const item = itemById(itemId);
    assert.match(item.s, constraint, itemId);
    for (const answer of item.ans) assert.equal(promptDisclosesAnswer(item, answer), false, `${itemId}:${answer}`);
  }
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.19.f.2'), 'and consequently').correct, false);
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.19.f.5'), 'even so').correct, false);
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.19.f.6'), 'and still').correct, false);
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.19.f.5'), 'yet').correct, true);
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.19.f.3'), 'even if').correct, false);
  assert.equal(grammar.checkPracticeAnswer(itemById('core.g.19.f.5'), 'regardless').correct, true);
});

test('the active concessive explanation describes only the published sentence', () => {
  const concession = itemById('core.g.19.c.3');
  assert.match(concession.e, /continuing to work despite tiredness/iu);
  assert.doesNotMatch(concession.e, /finishing/iu);
});

test('the active USA explanation teaches the exact convention without mutating v2', () => {
  const usa = itemById('core.g.14.c.5');
  assert.match(usa.e, /USA.*conventional.*the/iu);
  assert.doesNotMatch(usa.e, /countries.*several words|multiword countr/iu);
  assert.equal(GRAMMAR_CATALOG_V2.bank[14].c[4].e, 'Страны из нескольких слов → the USA.');
});

test('open connector prompts accept their central category-correct alternatives', () => {
  const accepted = Object.freeze({
    'core.g.19.f.3': 'while',
    'core.g.19.f.5': 'still',
    'core.g.19.f.7': 'yet',
  });

  for (const [itemId, answer] of Object.entries(accepted)) {
    const item = itemById(itemId);
    assert.ok(item.ans.includes(answer), `${itemId}:${answer}`);
    assert.equal(grammar.checkPracticeAnswer(item, answer).correct, true, `${itemId}:${answer}`);
  }
});

test('open coordinating connector prompts accept their grammatical multiword equivalents', () => {
  const accepted = Object.freeze({
    'core.g.19.f.2': 'and therefore',
    'core.g.19.f.6': 'and yet',
    'core.g.19.f.7': 'and yet',
    'core.g.19.f.8': 'and therefore',
  });

  for (const [itemId, answer] of Object.entries(accepted)) {
    const item = itemById(itemId);
    assert.ok(item.ans.includes(answer), `${itemId}:${answer}`);
    assert.equal(grammar.checkPracticeAnswer(item, answer).correct, true, `${itemId}:${answer}`);
  }
});

test('the SO to BECAUSE correction accepts both finite clause orders', () => {
  const item = itemById('core.g.19.correction.2');
  assert.deepEqual(item.ans, [
    'We drove slowly because the road was icy.',
    'Because the road was icy, we drove slowly.',
  ]);
  assert.equal(grammar.checkPracticeAnswer(item, item.ans[1]).correct, true);
});

test('a migrated concessive choice uses only genuine wrong-relation distractors', () => {
  const item = itemById('core.g.19.c.4');
  assert.deepEqual(item.o, ['so', 'because', 'but', 'or']);
  assert.deepEqual(item.diagnostics[3], {
    id: 'core.g.19.c.4.diagnostic.4',
    errorCode: 'confusion_pair',
    confusionPair: 'target_relation__wrong_relation',
  });
  assert.equal(item.diagnostics[0].confusionPair, 'target_relation__wrong_relation');
  assert.equal(item.diagnostics[1].confusionPair, 'target_relation__wrong_relation');
});

test('the second migrated result choice uses only grammatical wrong-relation distractors', () => {
  const item = itemById('core.g.19.c.5');
  assert.deepEqual(item.o, ['because', 'so', 'although', 'but']);
  assert.equal(item.o[item.a], 'so');
  for (const index of [0, 2, 3]) {
    assert.equal(item.diagnostics[index].confusionPair, 'target_relation__wrong_relation');
  }
});

test('concessive choices attach relation diagnostics only to grammatical same-syntax distractors', () => {
  const nounPhraseChoices = Object.freeze({
    'core.g.19.c.2': ['because of', 'owing to', 'despite', 'as a result of'],
    'core.g.19.c.7': ['Because of', 'Owing to', 'Despite', 'As a result of'],
  });
  for (const [itemId, options] of Object.entries(nounPhraseChoices)) {
    const item = itemById(itemId);
    assert.deepEqual(item.o, options, itemId);
    assert.equal(item.o[item.a].toLowerCase(), 'despite', itemId);
    assert.deepEqual(item.diagnostics.map((diagnostic) => diagnostic?.confusionPair || null), [
      'cause_connector__concession_connector',
      'cause_connector__concession_connector',
      null,
      'result_connector__concession_connector',
    ], itemId);
  }
  for (const itemId of ['core.g.19.c.3', 'core.g.19.c.8']) {
    const item = itemById(itemId);
    assert.deepEqual(item.o, ['Since', 'Although', 'If', 'Because'], itemId);
    assert.equal(item.o[item.a], 'Although', itemId);
    assert.deepEqual(item.diagnostics.map((diagnostic) => diagnostic?.confusionPair || null), [
      'cause_connector__concession_connector',
      null,
      'target_relation__wrong_relation',
      'cause_connector__concession_connector',
    ], itemId);
  }
});

test('same-syntax concessive choices explain the intended relation instead of pretending syntax decides', () => {
  for (const itemId of ['core.g.19.c.2', 'core.g.19.c.3', 'core.g.19.c.7', 'core.g.19.c.8']) {
    const item = itemById(itemId);
    assert.match(item.e, /concession|contrast/iu, itemId);
    assert.doesNotMatch(item.e, /noun phrase follows|full clause follows|full sentence/iu, itemId);
  }
});

test('the concessive choice has one grammatical answer at the published choice seam', () => {
  const item = itemById('core.g.19.c.7');
  assert.deepEqual(item.t, ['', ' his nervousness, Kai answered every question.']);
  assert.equal(item.o[item.a], 'Despite');
});

test('the concessive noun-phrase choice keeps every option compatible with its published phrase', () => {
  const item = itemById('core.g.19.c.7');
  assert.deepEqual(item.o, ['Because of', 'Owing to', 'Despite', 'As a result of']);
  assert.match(item.e, /concession/iu);
});

test('controlled concessive rewrites publish the exact finite structure accepted by the grader', () => {
  const although = itemById('core.g.19.transform.3');
  const despite = itemById('core.g.19.transform.4');
  assert.match(
    although.s,
    /Начните: Although it was raining, \.\.\./u,
  );
  assert.match(
    despite.s,
    /Начните: Despite being tired, \.\.\./u,
  );
  assert.deepEqual(although.ans, ['Although it was raining, the game continued.']);
  assert.deepEqual(despite.ans, ['Despite being tired, she kept working.']);
});

test('authored transfer mates change the literal source context, not only the instruction', () => {
  const pair = ['core.g.19.transform.1', 'core.g.19.transform.2'].map((itemId) => itemById(itemId));
  const sources = pair.map((item) => item.s.match(/Исходное: (.+)$/u)?.[1]);
  assert.ok(sources.every(Boolean));
  assert.notEqual(sources[0], sources[1]);
});

test('the BUT transform explicitly requires two full clauses at the finite answer seam', () => {
  assert.match(
    itemById('core.g.19.transform.6').s,
    /Используйте две полные части и начните: The route was long, but it \.\.\./u,
  );
});

test('correction and controlled transform require reconstruction without answer options', () => {
  let checked = 0;
  for (const topicId of FUNCTION_WORD_TOPIC_IDS) {
    for (const kind of ['correction', 'transform']) {
      for (const item of GRAMMAR_CATALOG.bank[topicId][kind]) {
        assert.equal(Object.hasOwn(item, 'o'), false, item.id);
        assert.equal(Object.hasOwn(item, 'a'), false, item.id);
        assert.ok(Array.isArray(item.ans) && item.ans.length >= 1, item.id);
        assert.equal(grammar.checkPracticeAnswer(item, item.ans[0]).correct, true, item.id);
        assert.equal(grammar.checkPracticeAnswer(item, '__not_an_answer__').correct, false, item.id);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 48);
});

test('every function-word choice reports the selected option diagnostic and transfers that exact weakness', () => {
  let wrongChoices = 0;
  for (const topicId of FUNCTION_WORD_TOPIC_IDS) {
    const bank = GRAMMAR_CATALOG.bank[topicId];
    for (const item of bank.c) {
      item.o.forEach((_, choiceIndex) => {
        const result = grammar.checkPracticeAnswer(item, choiceIndex);
        if (choiceIndex === item.a) {
          assert.deepEqual(result, {
            correct: true, normalized: String(choiceIndex), diagnosticId: null, errorCode: null, confusionPair: null,
          });
          return;
        }
        const diagnostic = item.diagnostics[choiceIndex];
        assert.deepEqual(result, {
          correct: false, normalized: String(choiceIndex), diagnosticId: diagnostic.id,
          errorCode: diagnostic.errorCode, confusionPair: diagnostic.confusionPair,
        });
        const failed = { k: 'choice', q: item, t: topicId, transfer: false };
        const session = { activeRunner: true, i: 0, queue: [failed], reservedItemIds: [item.id] };
        const transfer = grammar.enqueueTransferAfterFailure(
          session, bank, failed, `function-diagnostic-${item.id}-${choiceIndex}`,
          { errorCode: diagnostic.errorCode, confusionPair: diagnostic.confusionPair },
        );
        assert.ok(transfer?.q, `${item.id}:${choiceIndex}`);
        assert.equal(transfer.q.transferPair, item.transferPair);
        assert.equal(transfer.q.id === item.id, false);
        wrongChoices += 1;
      });
    }
  }
  assert.equal(wrongChoices, 72);
});

test('a forged function-word weakness fails closed instead of selecting an unrelated transfer', () => {
  for (const topicId of FUNCTION_WORD_TOPIC_IDS) {
    const bank = GRAMMAR_CATALOG.bank[topicId];
    const item = bank.c[0];
    const failed = { k: 'choice', q: item, t: topicId, transfer: false };
    const session = { activeRunner: true, i: 0, queue: [failed], reservedItemIds: [item.id] };
    const forged = { errorCode: 'auxiliary', confusionPair: 'be__have' };
    assert.deepEqual(grammar.enqueueTransferAfterFailure(
      session, bank, failed, `function-forged-${topicId}`, forged,
    ), {
      status: 'due_next_session', errorCode: 'auxiliary', confusionPair: 'be__have', maxTransferAttempts: 1,
    });
  }
});

test('deterministic function-word queues always reserve one unseen exact transfer mate', () => {
  for (const topicId of FUNCTION_WORD_TOPIC_IDS) {
    const bank = GRAMMAR_CATALOG.bank[topicId];
    for (let seed = 0; seed < 256; seed += 1) {
      const queue = grammar.buildActiveTopicQueue(bank, topicId, `function-property-${topicId}-${seed}`);
      assert.equal(queue.length, 16);
      const selectedIds = new Set(queue.map((item) => item.q.id));
      assert.equal(selectedIds.size, 16);
      for (const selected of queue) {
        const unseenMates = bank[BANK_KIND[selected.k]].filter((candidate) => (
          candidate.id !== selected.q.id && candidate.transferPair === selected.q.transferPair && !selectedIds.has(candidate.id)
        ));
        assert.equal(unseenMates.length, 1, `${topicId}:${seed}:${selected.q.id}`);
      }
    }
  }
});

test('each clean function-word session passes the shared server envelope and reaches learned', () => {
  for (const topicId of FUNCTION_WORD_TOPIC_IDS) {
    const id = `00000000-0000-4000-8000-${String(topicId).padStart(12, '0')}`;
    const queue = grammar.buildActiveTopicQueue(GRAMMAR_CATALOG.bank[topicId], topicId, `function-flow-${topicId}`);
    const items = queue.map((item) => ({
      id: item.q.id, type: item.k, transfer: false, correct: true,
      diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    }));
    const event = {
      id, type: 'session_completed', expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false,
      completedTypes: [...TYPES],
      typeScores: Object.fromEntries(TYPES.map((type) => [type, { correct: 4, total: 4 }])),
      session: {
        id, scope: 'topic', mode: 'topic_practice', source: 'builtin',
        catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
        items, startedAt: 2_000, assisted: false,
      },
    };
    assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event }).success, true, `topic ${topicId}`);
    const learned = grammar.reduceMastery(grammar.migrateMasteryRecord(), event, { now: 2_000, clockAuthority: 'server' });
    assert.equal(learned.stage, 'learned');
    assert.equal(learned.eligibleAt, 86_402_000);
    assert.equal(learned.masteryHistory.at(-1).session.items.length, 16);
  }
});

test('the function-word bank is available in an already-installed offline shell', async () => {
  const serviceWorker = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
  assert.match(serviceWorker, /['"]\/grammar-function-words-content\.js['"]/u);
});
