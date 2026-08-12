import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { GRAMMAR_CATALOG_CONTENT } from '../public/grammar-catalog-content.js';
import {
  GRAMMAR_CATALOG,
  createGrammarCatalog,
  grammarCatalogCoverage,
} from '../public/grammar-catalog.js';
import { grammarActivityId, splitLearningActivityDuration } from '../public/learning-activity-contract.js';
import {
  GENERATED_GRAMMAR_REVISION,
  GRAMMAR_ACTIVE_PRACTICE_TYPES,
  GRAMMAR_ERROR_CODES,
  parseGeneratedGrammarItemId,
  parseGeneratedGrammarItemReference,
} from '../public/grammar-domain-contract.js';
import { grammarMasteryEventSchema } from '../validation/grammar-mastery.js';

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

const VERB_TOPIC_IDS = Object.freeze([5, 6, 7, 8, 9, 18]);
const TYPES = Object.freeze(['choice', 'input', 'correction', 'transform']);
const BANK_KIND = Object.freeze({ choice: 'c', input: 'f', correction: 'correction', transform: 'transform' });
const D = (errorCode, confusionPair = null) => Object.freeze([errorCode, confusionPair]);
const C_PASSIVE = D('construction_choice', 'active_voice__passive_voice');
const PASSIVE_ASPECT = D('confusion_pair', 'simple_passive__continuous_passive');
const CONDITIONAL = D('construction_choice', 'if_clause_pattern__result_clause_pattern');
const FIRST_SECOND = D('confusion_pair', 'first_conditional__second_conditional');
const ZERO_SECOND = D('confusion_pair', 'zero_conditional__second_conditional');
const SECOND_THIRD = D('confusion_pair', 'second_conditional__third_conditional');
const REPORTED = D('construction_choice', 'direct_speech__reported_speech');
const REPORTED_ORDER = D('word_order', 'direct_question__reported_question');
const REPORTED_PAST = D('confusion_pair', 'past_simple__past_perfect');
const WILL_WOULD = D('confusion_pair', 'will__would');
const MODAL = D('construction_choice', 'required_modal__other_modal');
const PROHIBITION = D('confusion_pair', 'must_not__do_not_have_to');
const PERMISSION = D('construction_choice', 'permission__obligation');
const CAN_COULD = D('confusion_pair', 'can__could');
const VERB_PATTERN = D('confusion_pair', 'gerund__to_infinitive');
const STOP_PATTERN = D('confusion_pair', 'stop_doing__stop_to_do');
const BARE_INFINITIVE = D('confusion_pair', 'bare_infinitive__to_infinitive');
const SUBJECT_QUESTION = D('word_order', 'subject_question__object_question');
const QUESTION_TAG = D('negation_or_question', 'positive_statement__negative_tag');
const INDIRECT_QUESTION = D('word_order', 'direct_question__indirect_question');
const AUXILIARY = D('auxiliary');
const AGREEMENT = D('agreement');
const WORD_FORM = D('word_or_verb_form');

const CHOICE_OPTION_FIXTURE = Object.freeze({
  'core.g.5.c.1': [C_PASSIVE, null, WORD_FORM, C_PASSIVE],
  'core.g.5.c.2': [AUXILIARY, null, AUXILIARY, C_PASSIVE],
  'core.g.5.c.3': [C_PASSIVE, null, WORD_FORM, C_PASSIVE],
  'core.g.5.c.4': [C_PASSIVE, null, WORD_FORM, C_PASSIVE],
  'core.g.5.c.5': [PASSIVE_ASPECT, null, C_PASSIVE, WORD_FORM],
  'core.g.5.c.6': [AUXILIARY, null, AUXILIARY, C_PASSIVE],
  'core.g.5.c.7': [C_PASSIVE, null, WORD_FORM, C_PASSIVE],
  'core.g.5.c.8': [PASSIVE_ASPECT, null, C_PASSIVE, WORD_FORM],
  'core.g.6.c.1': [AUXILIARY, null, FIRST_SECOND, WORD_FORM],
  'core.g.6.c.2': [AGREEMENT, AGREEMENT, null, WORD_FORM],
  'core.g.6.c.3': [WORD_FORM, null, CONDITIONAL, SECOND_THIRD],
  'core.g.6.c.4': [null, CONDITIONAL, ZERO_SECOND, WORD_FORM],
  'core.g.6.c.5': [CONDITIONAL, ZERO_SECOND, null, WORD_FORM],
  'core.g.6.c.6': [AUXILIARY, null, FIRST_SECOND, WORD_FORM],
  'core.g.6.c.7': [AGREEMENT, AGREEMENT, null, WORD_FORM],
  'core.g.6.c.8': [SECOND_THIRD, null, CONDITIONAL, WORD_FORM],
  'core.g.7.c.1': [REPORTED, null, AGREEMENT, WORD_FORM],
  'core.g.7.c.2': [WILL_WOULD, null, WORD_FORM, WORD_FORM],
  'core.g.7.c.3': [REPORTED_ORDER, null, REPORTED_ORDER, WORD_FORM],
  'core.g.7.c.4': [REPORTED_PAST, WORD_FORM, null, WORD_FORM],
  'core.g.7.c.5': [REPORTED, null, WORD_FORM, AGREEMENT],
  'core.g.7.c.6': [WILL_WOULD, null, WORD_FORM, WORD_FORM],
  'core.g.7.c.7': [null, REPORTED_ORDER, REPORTED_ORDER, WORD_FORM],
  'core.g.7.c.8': [REPORTED_PAST, WORD_FORM, null, WORD_FORM],
  'core.g.8.c.1': [MODAL, null, PERMISSION, MODAL],
  'core.g.8.c.2': [null, PROHIBITION, MODAL, MODAL],
  'core.g.8.c.3': [PERMISSION, null, MODAL, PERMISSION],
  'core.g.8.c.4': [CAN_COULD, null, MODAL, PERMISSION],
  'core.g.8.c.5': [MODAL, null, PERMISSION, MODAL],
  'core.g.8.c.6': [PROHIBITION, null, MODAL, MODAL],
  'core.g.8.c.7': [PERMISSION, null, PERMISSION, MODAL],
  'core.g.8.c.8': [CAN_COULD, null, MODAL, PERMISSION],
  'core.g.9.c.1': [WORD_FORM, VERB_PATTERN, null, WORD_FORM],
  'core.g.9.c.2': [WORD_FORM, VERB_PATTERN, null, WORD_FORM],
  'core.g.9.c.3': [WORD_FORM, null, STOP_PATTERN, WORD_FORM],
  'core.g.9.c.4': [null, BARE_INFINITIVE, WORD_FORM, WORD_FORM],
  'core.g.9.c.5': [WORD_FORM, VERB_PATTERN, null, WORD_FORM],
  'core.g.9.c.6': [WORD_FORM, VERB_PATTERN, null, WORD_FORM],
  'core.g.9.c.7': [STOP_PATTERN, null, WORD_FORM, WORD_FORM],
  'core.g.9.c.8': [BARE_INFINITIVE, WORD_FORM, null, WORD_FORM],
  'core.g.18.c.1': [null, AUXILIARY, AGREEMENT, WORD_FORM],
  'core.g.18.c.2': [null, WORD_FORM, AUXILIARY, WORD_FORM],
  'core.g.18.c.3': [QUESTION_TAG, null, AUXILIARY, AGREEMENT],
  'core.g.18.c.4': [QUESTION_TAG, null, AUXILIARY, AGREEMENT],
  'core.g.18.c.5': [null, INDIRECT_QUESTION, AGREEMENT, WORD_FORM],
  'core.g.18.c.6': [null, AUXILIARY, AGREEMENT, WORD_FORM],
  'core.g.18.c.7': [null, WORD_FORM, AUXILIARY, WORD_FORM],
  'core.g.18.c.8': [null, INDIRECT_QUESTION, AGREEMENT, WORD_FORM],
});

const NON_CHOICE_PAIR_FIXTURE = Object.freeze({
  5: Object.freeze({
    input: ['word_or_verb_form:-', 'word_or_verb_form:-', 'word_or_verb_form:-', 'word_or_verb_form:-'],
    correction: ['construction_choice:active_voice__passive_voice', 'auxiliary:-', 'agreement:-', 'confusion_pair:simple_passive__continuous_passive'],
    transform: ['construction_choice:active_voice__passive_voice', 'auxiliary:-', 'negation_or_question:-', 'confusion_pair:simple_passive__continuous_passive'],
  }),
  6: Object.freeze({
    input: Array(4).fill('construction_choice:if_clause_pattern__result_clause_pattern'),
    correction: ['construction_choice:if_clause_pattern__result_clause_pattern', 'agreement:-', 'confusion_pair:second_conditional__third_conditional', 'negation_or_question:-'],
    transform: ['construction_choice:if_clause_pattern__result_clause_pattern', 'confusion_pair:second_conditional__third_conditional', 'negation_or_question:-', 'auxiliary:-'],
  }),
  7: Object.freeze({
    input: Array(4).fill('construction_choice:direct_speech__reported_speech'),
    correction: ['construction_choice:direct_speech__reported_speech', 'confusion_pair:will__would', 'word_order:direct_question__reported_question', 'negation_or_question:-'],
    transform: ['construction_choice:direct_speech__reported_speech', 'confusion_pair:will__would', 'word_order:direct_question__reported_question', 'negation_or_question:-'],
  }),
  8: Object.freeze({
    input: ['confusion_pair:must_not__do_not_have_to', 'construction_choice:permission__obligation', 'confusion_pair:can__could', 'construction_choice:required_modal__other_modal'],
    correction: ['confusion_pair:must_not__do_not_have_to', 'auxiliary:-', 'word_or_verb_form:-', 'negation_or_question:-'],
    transform: ['confusion_pair:must_not__do_not_have_to', 'construction_choice:required_modal__other_modal', 'negation_or_question:-', 'word_or_verb_form:-'],
  }),
  9: Object.freeze({
    input: ['confusion_pair:gerund__to_infinitive', 'confusion_pair:gerund__to_infinitive', 'confusion_pair:gerund__to_infinitive', 'confusion_pair:bare_infinitive__to_infinitive'],
    correction: ['confusion_pair:gerund__to_infinitive', 'confusion_pair:stop_doing__stop_to_do', 'confusion_pair:bare_infinitive__to_infinitive', 'word_or_verb_form:-'],
    transform: ['confusion_pair:gerund__to_infinitive', 'confusion_pair:stop_doing__stop_to_do', 'confusion_pair:bare_infinitive__to_infinitive', 'word_or_verb_form:-'],
  }),
  18: Object.freeze({
    input: ['auxiliary:-', 'auxiliary:-', 'negation_or_question:positive_statement__negative_tag', 'word_order:direct_question__indirect_question'],
    correction: ['auxiliary:-', 'word_order:subject_question__object_question', 'negation_or_question:positive_statement__negative_tag', 'word_order:direct_question__indirect_question'],
    transform: ['auxiliary:-', 'word_order:subject_question__object_question', 'negation_or_question:positive_statement__negative_tag', 'word_order:direct_question__indirect_question'],
  }),
});

const CROSS_PAIR_MEMBERS = Object.freeze([1, 2, 3, 4, 1, 2, 3, 4]);
const ADJACENT_PAIR_MEMBERS = Object.freeze([1, 1, 2, 2, 3, 3, 4, 4]);
const NON_CHOICE_PAIR_MEMBER_FIXTURE = Object.freeze({
  5: Object.freeze({ input: Object.freeze([1, 2, 3, 1, 4, 3, 2, 4]), correction: ADJACENT_PAIR_MEMBERS, transform: ADJACENT_PAIR_MEMBERS }),
  6: Object.freeze({ input: Object.freeze([1, 2, 1, 2, 3, 4, 4, 3]), correction: ADJACENT_PAIR_MEMBERS, transform: ADJACENT_PAIR_MEMBERS }),
  7: Object.freeze({ input: Object.freeze([1, 2, 3, 4, 2, 1, 3, 4]), correction: ADJACENT_PAIR_MEMBERS, transform: ADJACENT_PAIR_MEMBERS }),
  8: Object.freeze({ input: Object.freeze([1, 1, 2, 3, 4, 2, 4, 3]), correction: ADJACENT_PAIR_MEMBERS, transform: ADJACENT_PAIR_MEMBERS }),
  9: Object.freeze({ input: CROSS_PAIR_MEMBERS, correction: ADJACENT_PAIR_MEMBERS, transform: ADJACENT_PAIR_MEMBERS }),
  18: Object.freeze({ input: Object.freeze([1, 2, 3, 3, 4, 4, 2, 1]), correction: ADJACENT_PAIR_MEMBERS, transform: ADJACENT_PAIR_MEMBERS }),
});

const CONTROLLED_EQUIVALENT_FIXTURE = Object.freeze({
  'core.g.5.transform.2': 'The castle was built by workers in 1880.',
  'core.g.6.transform.1': 'We will cancel the trip if it snows.',
  'core.g.7.transform.1': 'Maya said that she lived in Omsk.',
});

const REVIEW_EQUIVALENT_FIXTURE = Object.freeze({
  'core.g.5.transform.3': Object.freeze([
    'Tomorrow, the results will be published.', 'Tomorrow the results will be published.',
    'Tomorrow, the results will be published by them.', 'Tomorrow the results will be published by them.',
  ]),
  'core.g.5.transform.7': Object.freeze([
    'Now, the candidates are being interviewed.', 'Now the candidates are being interviewed.',
    'Now, the candidates are being interviewed by them.', 'Now the candidates are being interviewed by them.',
  ]),
  'core.g.5.transform.8': Object.freeze([
    'At noon, the road was being repaired.', 'At noon the road was being repaired.',
    'At noon, the road was being repaired by them.', 'At noon the road was being repaired by them.',
  ]),
  'core.g.6.transform.4': Object.freeze([
    "If we hadn't missed the bus, we would not have been late.",
    "If we had not missed the bus, we wouldn't have been late.",
    "We wouldn't have been late if we had not missed the bus.",
    "We would not have been late if we hadn't missed the bus.",
  ]),
  'core.g.6.transform.8': Object.freeze([
    "If they hadn't left late, they would not have missed the train.",
    "If they had not left late, they wouldn't have missed the train.",
  ]),
  'core.g.7.correction.7': Object.freeze(['He asked whether I needed help.']),
  'core.g.7.correction.8': Object.freeze(['She asked whether I was ready.']),
  'core.g.7.transform.7': Object.freeze(['She asked me whether I was ready.']),
  'core.g.7.transform.8': Object.freeze(['He asked me whether I had seen the sign.']),
  'core.g.7.transform.3': Object.freeze([
    'Nina said she would call the following day.',
    'Nina said that she would call the following day.',
  ]),
  'core.g.8.correction.2': Object.freeze([
    'You cannot enter; staff only.', "You can't enter; staff only.",
  ]),
  'core.g.9.transform.3': Object.freeze(['He has stopped eating sweets.']),
});

const CHOICE_SURFACE_FIXTURE = Object.freeze({
  'core.g.8.c.2': Object.freeze({
    text: ['Choose must not for this explicit prohibition: You ', ' smoke here — it is forbidden.'],
    options: ['must not', 'do not have to', 'can', "shouldn't"],
  }),
  'core.g.8.c.5': Object.freeze({
    text: ['Choose must for a required rule: Visitors ', ' show identification.'],
    options: ['can', 'must', 'may', 'might'],
  }),
  'core.g.9.c.7': Object.freeze({
    text: ['Choose stop to do for a purpose, not an activity already in progress: On the long drive, we stopped ',
      ' some coffee before we had taken the first sip, then continued the drive.'],
    options: ['drinking', 'to drink', 'drink', 'drank'],
  }),
  'core.g.18.c.2': Object.freeze({
    text: ['Choose the subject-question form: Who ', ' the window yesterday?'],
    options: ['broke', 'did broke', 'was break', 'break'],
  }),
  'core.g.18.c.5': Object.freeze({
    text: ['Complete the indirect question with statement word order: I wonder where ', '.'],
    options: ['he lives', 'does he live', 'he live', 'he is live'],
  }),
  'core.g.18.c.7': Object.freeze({
    text: ['Choose the subject-question form: Who ', ' this message last night?'],
    options: ['sent', 'did sent', 'was send', 'send'],
  }),
});

const NARROW_PROMPT_FIXTURE = Object.freeze({
  'core.g.5.correction.1': /начав с Coffee/u,
  'core.g.6.transform.1': /с помощью if/u,
  'core.g.6.transform.2': /с помощью if/u,
  'core.g.8.transform.1': /с do not have to/u,
  'core.g.8.transform.2': /с must not/u,
  'core.g.9.correction.4': /цель остановки/u,
  'core.g.9.transform.3': /с stop/u,
  'core.g.9.transform.4': /с stop/u,
});

const REQUIRED_BACKSHIFT_FIXTURE = Object.freeze([
  Object.freeze({ id: 'core.g.7.f.1', retained: 'lives' }),
  Object.freeze({ id: 'core.g.7.f.6', retained: "doesn't like" }),
  Object.freeze({ id: 'core.g.7.transform.1', retained: 'Maya said she lives in Omsk.' }),
  Object.freeze({ id: 'core.g.7.transform.2', retained: 'Leo said he works from home.' }),
]);
const TOPIC_7_REQUIRED_BACKSHIFT_IDS = Object.freeze([
  ...Array.from({ length: 8 }, (_, index) => `core.g.7.f.${index + 1}`),
  ...Array.from({ length: 8 }, (_, index) => `core.g.7.transform.${index + 1}`),
]);

const INPUT_SURFACE_FIXTURE = Object.freeze({
  'core.g.18.f.1': Object.freeze({
    prompt: 'Where _____ (YOUR PARENTS / LIVE)?', answers: ['do your parents live'],
  }),
  'core.g.6.f.7': Object.freeze({
    prompt: 'If metal _____ (GET) hot, it expands.', answers: ['gets'],
  }),
  'core.g.18.f.7': Object.freeze({
    prompt: 'Who _____ (SEND) this message last night?', answers: ['sent'],
  }),
  'core.g.18.f.8': Object.freeze({
    prompt: 'Why _____ (SHE / LEAVE) early every day?', answers: ['does she leave'],
  }),
});

const CHOICE_PROMPT_FIXTURE = Object.freeze({
  'core.g.5.c.3': /will be for a future passive prediction/u,
  'core.g.6.c.4': /zero conditional general fact/u,
  'core.g.6.c.2': /formal second conditional/u,
  'core.g.6.c.5': /zero conditional general result/u,
  'core.g.7.c.2': /Backshift will/u,
  'core.g.7.c.3': /Backshift the reported question asked yesterday/u,
  'core.g.7.c.4': /earlier action with Past Perfect/u,
  'core.g.8.c.3': /polite permission/u,
  'core.g.9.c.5': /to-infinitive after the adjective/u,
  'core.g.18.c.1': /present object question/u,
});

const LITERAL_PAIR_SURFACE_FIXTURE = Object.freeze([
  Object.freeze([
    Object.freeze({ id: 'core.g.5.correction.1', prompt: /People grow coffee/u }),
    Object.freeze({ id: 'core.g.5.correction.2', prompt: /Maya wrote the final report/u,
      answers: Object.freeze(['The final report was written by Maya.']) }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.5.transform.3', prompt: /publish the results tomorrow/u }),
    Object.freeze({ id: 'core.g.5.transform.4', prompt: /will repair the lift/u,
      answers: Object.freeze(['The lift will be repaired.', 'The lift will be repaired by them.']) }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.5.transform.5', prompt: /room was cleaned yesterday/u }),
    Object.freeze({ id: 'core.g.5.transform.6', prompt: /letters were delivered yesterday/u,
      answers: Object.freeze(['Were the letters delivered yesterday?']) }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.6.correction.3', prompt: /If I was you/u }),
    Object.freeze({ id: 'core.g.6.correction.4', prompt: /If he was here/u,
      answers: Object.freeze(['If he were here, he would help us.']) }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.6.f.2', prompt: /If I _____ \(BE\) you/u }),
    Object.freeze({ id: 'core.g.6.f.4', prompt: /If he _____ \(BE\) here/u,
      answers: Object.freeze(['were']) }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.6.f.5', prompt: /they _____ \(LEAVE\) earlier/u }),
    Object.freeze({ id: 'core.g.6.f.8', prompt: /Nora _____ \(SET\) an alarm/u,
      answers: Object.freeze(['had set']) }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.6.correction.7', prompt: /would not told him/u }),
    Object.freeze({ id: 'core.g.6.correction.8', prompt: /would not answered her/u,
      answers: Object.freeze(['If she had called, I would not have answered her.']) }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.6.transform.1', prompt: /It may snow/u }),
    Object.freeze({ id: 'core.g.6.transform.2', prompt: /It may rain/u }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.6.transform.5', prompt: /If she calls/u }),
    Object.freeze({ id: 'core.g.6.transform.6', prompt: /If they arrive/u }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.7.correction.1', prompt: /He said he is tired/u }),
    Object.freeze({ id: 'core.g.7.correction.2', prompt: /She said she is busy/u }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.7.f.2', prompt: /He told me he _____ \(CALL\) later/u }),
    Object.freeze({ id: 'core.g.7.f.5', prompt: /She said she _____ \(CALL\) later/u,
      answers: Object.freeze(['would call']) }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.7.transform.1', prompt: /I live in Omsk/u }),
    Object.freeze({ id: 'core.g.7.transform.2', prompt: /I work from home/u }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.8.correction.5', prompt: /Yesterday I must finish/u }),
    Object.freeze({ id: 'core.g.8.correction.6', prompt: /Last week she must work/u }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.8.correction.7', prompt: /Do I may leave/u }),
    Object.freeze({ id: 'core.g.8.correction.8', prompt: /Does she can drive/u }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.8.transform.3', prompt: /good idea to rest/u }),
    Object.freeze({ id: 'core.g.8.transform.4', prompt: /good idea to save/u }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.8.transform.5', prompt: /I may open/u }),
    Object.freeze({ id: 'core.g.8.transform.6', prompt: /He can swim/u,
      answers: Object.freeze(['Can he swim?']) }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.8.transform.7', prompt: /I must work late yesterday/u }),
    Object.freeze({ id: 'core.g.8.transform.8', prompt: /She must work late yesterday/u }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.18.correction.1', prompt: /Where your sister works/u }),
    Object.freeze({ id: 'core.g.18.correction.2', prompt: /What he buy yesterday/u,
      answers: Object.freeze(['What did he buy yesterday?']) }),
  ]),
  Object.freeze([
    Object.freeze({ id: 'core.g.18.f.1', prompt: /YOUR PARENTS \/ LIVE/u }),
    Object.freeze({ id: 'core.g.18.f.8', prompt: /SHE \/ LEAVE/u,
      answers: Object.freeze(['does she leave']) }),
  ]),
]);

function itemWeaknesses(item) {
  return item.type === 'choice'
    ? item.diagnostics.filter(Boolean).map(({ errorCode, confusionPair }) => `${errorCode}:${confusionPair || '-'}`)
    : [`${item.errorSkill}:${item.confusionPair || '-'}`];
}

function verbItem(itemId) {
  for (const topicId of VERB_TOPIC_IDS) {
    const item = Object.values(GRAMMAR_CATALOG.bank[topicId]).flat().find(candidate => candidate.id === itemId);
    if (item) return item;
  }
  assert.fail(`missing verb-construction item ${itemId}`);
}

test('six verb-construction topics expose 192 unique paired exercises through the release catalog', () => {
  const coverage = grammarCatalogCoverage(GRAMMAR_CATALOG);
  const ids = [];
  const prompts = [];
  const usedErrorCodes = new Set();

  for (const topicId of VERB_TOPIC_IDS) {
    assert.deepEqual(coverage.byPracticeType[topicId], {
      choice: 8, input: 8, correction: 8, transform: 8, total: 32,
    });
    const levels = GRAMMAR_CATALOG.bank[topicId];
    const items = [...levels.c, ...levels.f, ...levels.correction, ...levels.transform];
    assert.equal(items.length, 32, `topic ${topicId}`);
    for (const item of items) {
      ids.push(item.id);
      prompts.push(item.type === 'choice' ? `${item.t[0]} _____ ${item.t[1]}` : item.s);
      usedErrorCodes.add(item.errorSkill);
      assert.ok(item.e.trim(), `${item.id} explanation`);
      assert.ok(item.transferPair.startsWith(`grammar-v2:${topicId}:`), `${item.id} bounded pair`);
      assert.ok(['grammar-1-migrated', 'grammar-2-ticket-04'].includes(item.provenance), `${item.id} provenance`);
      assert.ok(Number.isInteger(item.difficulty) && item.difficulty >= 1 && item.difficulty <= 4,
        `${item.id} difficulty`);
    }
  }

  assert.equal(ids.length, 192);
  assert.equal(new Set(ids).size, 192);
  assert.equal(new Set(prompts).size, 192);
  for (const code of [
    'construction_choice', 'auxiliary', 'agreement', 'word_order',
    'negation_or_question', 'confusion_pair',
  ]) assert.equal(usedErrorCodes.has(code), true, `${code} is represented`);
});

test('every verb-construction answer and authored transfer stays exact at the generic runner boundary', () => {
  const grammar = createGrammarModule();
  let pairCount = 0;
  let directedWeaknesses = 0;

  for (const topicId of VERB_TOPIC_IDS) {
    const bank = GRAMMAR_CATALOG.bank[topicId];
    assert.equal(grammar.hasActivePractice(bank), true, `topic ${topicId} activates the generic runner`);
    for (const type of TYPES) {
      const pairs = Map.groupBy(bank[BANK_KIND[type]], item => item.transferPair);
      assert.equal(pairs.size, 4, `${topicId}:${type} four pairs`);
      for (const [pairId, pair] of pairs) {
        assert.equal(pair.length, 2, `${topicId}:${type} exact mate`);
        pairCount += 1;
        if (type !== 'choice') {
          const pairNumber = Number(pairId.split(':').at(-1));
          const expectedWeakness = NON_CHOICE_PAIR_FIXTURE[topicId][type][pairNumber - 1];
          const expectedMembers = bank[BANK_KIND[type]]
            .filter((_, index) => NON_CHOICE_PAIR_MEMBER_FIXTURE[topicId][type][index] === pairNumber)
            .map(item => item.id);
          assert.deepEqual(pair.map(item => item.id), expectedMembers, `${pairId} literal members`);
          assert.deepEqual(pair.map(item => `${item.errorSkill}:${item.confusionPair || '-'}`),
            [expectedWeakness, expectedWeakness], `${pairId} literal micro-skill`);
        }
        for (const [index, item] of pair.entries()) {
          const mateWeaknesses = new Set(itemWeaknesses(pair[1 - index]));
          for (const weakness of itemWeaknesses(item)) {
            directedWeaknesses += 1;
            assert.equal(mateWeaknesses.has(weakness), true, `${item.id} -> ${pair[1 - index].id}: ${weakness}`);
          }
        }
      }
    }

    for (let seed = 0; seed < 128; seed += 1) {
      const queue = grammar.buildActiveTopicQueue(bank, topicId, `verb-${topicId}-${seed}`);
      assert.equal(queue.length, 16, `${topicId}:${seed} full queue`);
      assert.equal(new Set(queue.map(item => item.q.id)).size, 16, `${topicId}:${seed} unique originals`);
      const session = { activeRunner: true, queue: queue.slice(), i: 0, reservedItemIds: queue.map(item => item.q.id) };
      const transfers = queue.map((item, index) => {
        session.i = index * 2;
        return grammar.enqueueTransferAfterFailure(session, bank, item, `verb-transfer-${topicId}-${seed}-${index}`);
      });
      assert.equal(transfers.every(item => item?.q), true, `${topicId}:${seed} every failure has a transfer`);
      assert.equal(new Set(transfers.map(item => item.q.id)).size, 16, `${topicId}:${seed} unique transfers`);
    }

    for (const item of Object.values(bank).flat().filter(candidate => TYPES.includes(candidate.type))) {
      const correct = item.type === 'choice' ? item.a : item.ans[0];
      assert.equal(grammar.checkPracticeAnswer(item, correct).correct, true, `${item.id} accepts authored answer`);
      const falseAnswer = item.type === 'choice'
        ? item.o.findIndex((_, index) => index !== item.a)
        : '__not_an_authored_equivalent__';
      assert.equal(grammar.checkPracticeAnswer(item, falseAnswer).correct, false, `${item.id} rejects false answer`);
    }
  }

  assert.equal(pairCount, 96);
  assert.ok(directedWeaknesses >= 288, 'all text weaknesses and choice-option diagnoses have a mate');
});

test('choice diagnostics identify the selected verb-construction error without leaking another option', () => {
  const grammar = createGrammarModule();
  let wrongOptions = 0;
  for (const topicId of VERB_TOPIC_IDS) {
    for (const item of GRAMMAR_CATALOG.bank[topicId].c) {
      const expectedDiagnostics = CHOICE_OPTION_FIXTURE[item.id];
      assert.ok(expectedDiagnostics, `${item.id} literal per-option semantic fixture`);
      assert.equal(expectedDiagnostics.length, item.o.length, `${item.id} fixture covers every option`);
      assert.equal(item.diagnostics.length, item.o.length, item.id);
      item.diagnostics.forEach((diagnostic, optionIndex) => {
        const expectedWeakness = expectedDiagnostics[optionIndex];
        if (optionIndex === item.a) {
          assert.equal(expectedWeakness, null, `${item.id}:${optionIndex} fixture marks the answer`);
          assert.equal(diagnostic, null, `${item.id}:${optionIndex} correct option`);
          return;
        }
        wrongOptions += 1;
        assert.ok(diagnostic?.id, `${item.id}:${optionIndex} stable diagnostic`);
        assert.ok(GRAMMAR_ERROR_CODES.includes(diagnostic?.errorCode), `${item.id}:${optionIndex} exact taxonomy`);
        assert.deepEqual([diagnostic.errorCode, diagnostic.confusionPair], expectedWeakness,
          `${item.id}:${optionIndex} authored semantic diagnosis`);
        assert.deepEqual(JSON.parse(JSON.stringify(grammar.checkPracticeAnswer(item, optionIndex))), {
          correct: false,
          normalized: String(optionIndex),
          diagnosticId: diagnostic.id,
          errorCode: diagnostic.errorCode,
          confusionPair: diagnostic.confusionPair,
        });
      });
    }
  }
  assert.equal(Object.keys(CHOICE_OPTION_FIXTURE).length, 48);
  assert.equal(wrongOptions, 144);
});

test('choice surfaces and controlled prompts exclude unintended grammatical answers', () => {
  const byId = new Map(VERB_TOPIC_IDS.flatMap(topicId => Object.values(GRAMMAR_CATALOG.bank[topicId]).flat())
    .map(item => [item.id, item]));
  for (const [itemId, expected] of Object.entries(CHOICE_SURFACE_FIXTURE)) {
    assert.deepEqual(byId.get(itemId)?.t, expected.text, `${itemId} complete controlled frame`);
    assert.deepEqual(byId.get(itemId)?.o, expected.options, `${itemId} only one grammatical option`);
  }
  for (const [itemId, pattern] of Object.entries(NARROW_PROMPT_FIXTURE)) {
    assert.match(byId.get(itemId)?.s || '', pattern, `${itemId} narrows exact-answer scope`);
  }
  for (const [itemId, expected] of Object.entries(INPUT_SURFACE_FIXTURE)) {
    assert.equal(byId.get(itemId)?.s, expected.prompt, `${itemId} exact paired input prompt`);
    assert.deepEqual(byId.get(itemId)?.ans, expected.answers, `${itemId} exact paired input answers`);
  }
  for (const [itemId, pattern] of Object.entries(CHOICE_PROMPT_FIXTURE)) {
    assert.match(byId.get(itemId)?.t.join('_____') || '', pattern, `${itemId} excludes a valid competing reading`);
  }
});

test('the stop-purpose choice explicitly excludes an already-running drinking activity', () => {
  const item = verbItem('core.g.9.c.7');
  const frame = item.t.join('_____');
  assert.match(frame, /stop to do for a purpose/iu);
  assert.match(frame, /not an activity already in progress/iu);
  assert.match(frame, /stopped _____ some coffee/iu);
  assert.match(frame, /before we had taken the first sip/iu);
  assert.equal(item.o[item.a], 'to drink');
  assert.deepEqual(item.diagnostics[0] && [item.diagnostics[0].errorCode, item.diagnostics[0].confusionPair],
    ['confusion_pair', 'stop_doing__stop_to_do']);
});

for (const { id, retained } of REQUIRED_BACKSHIFT_FIXTURE) {
  test(`${id} explicitly requires later reporting with backshift`, () => {
    const grammar = createGrammarModule();
    const item = verbItem(id);
    assert.match(item.s, /later.*backshift|backshift.*later/iu);
    assert.equal(grammar.checkPracticeAnswer(item, item.ans[0]).correct, true);
    assert.equal(grammar.checkPracticeAnswer(item, retained).correct, false);
  });
}

test('every exact-answer Topic 7 input and transform fixes a later backshift context', () => {
  assert.deepEqual(TOPIC_7_REQUIRED_BACKSHIFT_IDS.map(id => verbItem(id).id), TOPIC_7_REQUIRED_BACKSHIFT_IDS);
  for (const id of TOPIC_7_REQUIRED_BACKSHIFT_IDS) {
    assert.match(verbItem(id).s, /later.*backshift|backshift.*later/iu, id);
  }
});

test('controlled verb-construction prompts accept their finite instruction-compliant alternatives', () => {
  const grammar = createGrammarModule();
  for (const [itemId, answer] of Object.entries(CONTROLLED_EQUIVALENT_FIXTURE)) {
    const [, topicId, kind, index] = /^core\.g\.(\d+)\.(transform)\.(\d+)$/u.exec(itemId);
    const item = GRAMMAR_CATALOG.bank[Number(topicId)][kind][Number(index) - 1];
    assert.equal(item.id, itemId);
    assert.equal(grammar.checkPracticeAnswer(item, answer).correct, true, `${itemId}: ${answer}`);
  }
  const passive = GRAMMAR_CATALOG.bank[5].transform[1];
  assert.equal(grammar.checkPracticeAnswer(passive, 'The castle was built by the workers in 1880.').correct, true);
  assert.equal(grammar.checkPracticeAnswer(passive, 'The castle was built in 1880 by the workers.').correct, true);

  for (const [itemId, answers] of Object.entries(REVIEW_EQUIVALENT_FIXTURE)) {
    const item = verbItem(itemId);
    for (const answer of answers) {
      assert.equal(grammar.checkPracticeAnswer(item, answer).correct, true, `${itemId}: ${answer}`);
    }
  }
});

test('every verb-construction input exposes one generic blank and completes one grammatical frame', () => {
  const grammar = createGrammarModule();
  for (const topicId of VERB_TOPIC_IDS) {
    for (const item of GRAMMAR_CATALOG.bank[topicId].f) {
      assert.equal(item.s.match(/_____/gu)?.length, 1, `${item.id} generic one-gap renderer`);
    }
  }

  const tag = verbItem('core.g.18.f.3');
  assert.deepEqual(tag.ans, ["haven't"]);
  assert.equal(grammar.checkPracticeAnswer(tag, 'have not').correct, false);
  assert.equal(tag.s.replace('_____', tag.ans[0]), "You have finished, haven't you?");
});

test('reviewed transfer pairs expose the same literal correction principle independently of metadata', () => {
  for (const pair of LITERAL_PAIR_SURFACE_FIXTURE) {
    const items = pair.map(({ id }) => verbItem(id));
    assert.equal(items[0].transferPair, items[1].transferPair, `${items[0].id} literal mate`);
    pair.forEach(({ id, prompt, answers }, index) => {
      assert.match(items[index].s, prompt, `${id} literal semantic surface`);
      if (answers) assert.deepEqual(items[index].ans, answers, `${id} literal answers`);
    });
  }
});

test('verb-construction coverage fails closed when one generic active level loses its transfer reserve', () => {
  const missingTransform = structuredClone(GRAMMAR_CATALOG_CONTENT);
  missingTransform.bank[5].transform.pop();
  assert.throws(() => createGrammarCatalog(missingTransform), /INCOMPLETE_ACTIVE_GRAMMAR_COVERAGE/u);

  const brokenPair = structuredClone(GRAMMAR_CATALOG_CONTENT);
  brokenPair.bank[18].correction[0].transferPair = 'grammar-v2:18:correction:99';
  assert.throws(() => createGrammarCatalog(brokenPair), /INVALID_GRAMMAR_TRANSFER_PAIR/u);
});

test('the authored verb-construction bank is available in an already-installed offline shell', async () => {
  const worker = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /['"]\/grammar-verb-constructions-content\.js['"]/u);
});

test('a clean verb-construction session passes the shared server envelope and reaches learned without a thematic branch', () => {
  const grammar = createGrammarModule();
  for (const topicId of VERB_TOPIC_IDS) {
    const queue = grammar.buildActiveTopicQueue(GRAMMAR_CATALOG.bank[topicId], topicId, `flow-${topicId}`);
    const id = `00000000-0000-4000-8000-${String(topicId).padStart(12, '0')}`;
    const items = queue.map(item => ({
      id: item.q.id, type: item.k, transfer: false, correct: true,
      diagnosticId: null, errorCode: null, confusionPair: null, transferStatus: null,
    }));
    const typeScores = Object.fromEntries(TYPES.map(type => [type, { correct: 4, total: 4 }]));
    const event = {
      type: 'session_completed', id, expectedRevision: 0, expectedStage: 'not_started', expectedReviewStep: 0,
      source: 'builtin', assisted: false, completedTypes: [...TYPES], typeScores,
      session: {
        id, scope: 'topic', mode: 'topic_practice', source: 'builtin',
        catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
        items, startedAt: 1_000, assisted: false,
      },
    };
    assert.equal(grammarMasteryEventSchema.safeParse({ topicId, event }).success, true, `topic ${topicId} envelope`);
    const learned = grammar.reduceMastery(grammar.migrateMasteryRecord(), event, { now: 2_000, clockAuthority: 'server' });
    assert.equal(learned.stage, 'learned', `topic ${topicId} learned`);
    assert.equal(learned.eligibleAt, 86_402_000, `topic ${topicId} due in one day`);
    assert.equal(learned.masteryHistory.at(-1).session.items.length, 16, `topic ${topicId} history`);
  }
});
