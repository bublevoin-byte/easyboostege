import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  coreGrammarVoice,
  coreVocabularyVoice,
  decorateCoreGrammar,
  decorateCoreVocabulary,
} from '../public/modules/core-voice-catalog.js';
import { GRAMMAR_CATALOG, GRAMMAR_CATALOG_V1 } from '../public/grammar-catalog.js';
import { getCanonicalVoiceTutorItem } from '../voice-tutor/canonical-items.js';
import {
  CORE_VOICE_TUTOR_COVERAGE,
  CORE_VOICE_TUTOR_ITEMS,
  CORE_VOICE_TUTOR_LEGACY_GRAMMAR_ITEMS,
} from '../voice-tutor/core-catalog.js';
import { CORE_VOICE_CATALOG_SOURCE } from '../voice-tutor/generated-core-catalog.js';
import { maskAcceptedAnswers, practicePromptKey } from '../voice-tutor/practice.js';
import {
  buildGeneratedVoiceTutorDefinitions,
  decorateGeneratedVoiceTutorContent,
  parseGeneratedVoiceTutorItemId,
} from '../voice-tutor/generated-items.js';

const HASH = 'a'.repeat(64);

function assertDistinctSameSkillPractice(item) {
  assert.equal(item.microCheck.skillId, item.skill.id, `${item.id} micro-check skill`);
  assert.equal(item.transferTask.skillId, item.skill.id, `${item.id} transfer skill`);
  assert.equal(item.recoveryTasks.day1.skillId, item.skill.id, `${item.id} day-1 skill`);
  assert.equal(item.recoveryTasks.day7.skillId, item.skill.id, `${item.id} day-7 skill`);
  const prompts = [
    item.prompt,
    item.microCheck.prompt,
    item.transferTask.prompt,
    item.recoveryTasks.day1.prompt,
    item.recoveryTasks.day7.prompt,
  ];
  assert.equal(new Set(prompts.map(practicePromptKey)).size, prompts.length, `${item.id} must use four unseen analogs`);
  if (item.module === 'vocabulary') {
    const positions = [item.microCheck, item.transferTask, item.recoveryTasks.day1, item.recoveryTasks.day7]
      .map((task) => task.answers.find((answer) => /^[a-d]$/u.test(answer)));
    assert.equal(new Set(positions).size, 4, `${item.id} must exercise every answer position`);
  }
}

function correctOption(task) {
  const answer = task.answers.find((candidate) => /^[a-d]$/u.test(candidate));
  const options = Object.fromEntries([...task.prompt.matchAll(/([ABCD]) — ([^;?]+)/gu)]
    .map((match) => [match[1].toLocaleLowerCase('en'), match[2].trim()]));
  return options[answer];
}

function assertVocabularyPracticeTargets(item, headword) {
  for (const task of [item.microCheck, item.transferTask, item.recoveryTasks.day1, item.recoveryTasks.day7]) {
    assert.equal(correctOption(task), headword, `${item.id} must make its own lexeme correct`);
    assert.ok(task.answers.includes(headword), `${item.id} accepts the spoken or typed lexeme`);
  }
}

test('core Voice Tutor consumes the versioned grammar catalog and generated vocabulary source', () => {
  const check = spawnSync(process.execPath, ['scripts/build-core-voice-catalog.js', '--check'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const grammarCount = Object.values(GRAMMAR_CATALOG.bank)
    .reduce((count, levels) => count + Object.values(levels).reduce((sum, questions) => sum + questions.length, 0), 0)
    + GRAMMAR_CATALOG.exams.reduce((count, exam) => count + exam.gaps.length, 0);
  assert.deepEqual(CORE_VOICE_TUTOR_COVERAGE, { grammar: grammarCount, vocabulary: CORE_VOICE_CATALOG_SOURCE.vocabulary.length * 3 });
  assert.equal(grammarCount, 470);
  assert.equal(CORE_VOICE_TUTOR_COVERAGE.vocabulary, 897);
  assert.equal(Object.keys(CORE_VOICE_TUTOR_LEGACY_GRAMMAR_ITEMS).length, 218);

  for (const levels of Object.values(GRAMMAR_CATALOG_V1.bank)) {
    for (const questions of Object.values(levels)) {
      for (const question of questions) {
        const legacy = getCanonicalVoiceTutorItem(question.id, question.revision);
        assert.equal(legacy, CORE_VOICE_TUTOR_LEGACY_GRAMMAR_ITEMS[question.id], `${question.id} v1 registry identity`);
        assert.equal(legacy.revision, 1, `${question.id} v1 revision`);
        const legacyTopic = GRAMMAR_CATALOG_V1.topics[question.id.split('.')[2]];
        assert.deepEqual(legacy.rule, {
          id: `core.grammar.topic.${legacyTopic.id}.v1`, revision: 1,
          title: legacyTopic.n.replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ').trim(),
          explanation: legacyTopic.th.replace(/<br\s*\/?\s*>/giu, ' ').replace(/<[^>]+>/gu, '').replace(/&nbsp;/gu, ' ').replace(/\s+/gu, ' ').trim(),
          examples: legacy.rule.examples,
        }, `${question.id} v1 rule derives from the immutable v1 topic`);
      }
    }
  }
  for (const exam of GRAMMAR_CATALOG_V1.exams) {
    for (const gap of exam.gaps) {
      const legacy = getCanonicalVoiceTutorItem(gap.id, gap.revision);
      assert.equal(legacy, CORE_VOICE_TUTOR_LEGACY_GRAMMAR_ITEMS[gap.id], `${gap.id} v1 registry identity`);
      assert.deepEqual([...legacy.reference], gap.ans, `${gap.id} v1 reference`);
    }
  }
  assert.equal(getCanonicalVoiceTutorItem('core.g.1.c.1', 999), null, 'unknown revisions fail closed');
  assert.equal(getCanonicalVoiceTutorItem('core.g.1.c.6', 1), null, 'a v2-only item cannot resolve through v1');

  for (const levels of Object.values(GRAMMAR_CATALOG.bank)) {
    for (const questions of Object.values(levels)) {
      for (const question of questions) {
        assert.deepEqual(Object.keys(question.voice).sort(), ['id', 'revision'], `${question.id} exposes a pointer-only DTO`);
        assert.deepEqual(question.voice, { id: question.id, revision: question.revision }, `${question.id} pointer identity`);
        const registered = getCanonicalVoiceTutorItem(question.voice.id, question.voice.revision);
        assert.equal(registered, CORE_VOICE_TUTOR_ITEMS[question.id], `${question.id} resolves through the canonical registry`);
        assert.equal(registered.revision, question.voice.revision, `${question.id} revision`);
        const accepted = question.type === 'choice' ? [question.o[question.a]] : question.ans;
        assert.deepEqual([...registered.reference], accepted, `${question.id} server reference matches the catalog revision`);
      }
    }
  }
  for (const exam of GRAMMAR_CATALOG.exams) {
    for (const gap of exam.gaps) {
      assert.deepEqual(gap.voice, { id: gap.id, revision: gap.revision }, `${gap.id} pointer identity`);
      assert.equal(getCanonicalVoiceTutorItem(gap.id, gap.revision), CORE_VOICE_TUTOR_ITEMS[gap.id], `${gap.id} current registry identity`);
      assert.equal(CORE_VOICE_TUTOR_ITEMS[gap.id].revision, gap.revision, `${gap.id} revision`);
      assert.deepEqual([...CORE_VOICE_TUTOR_ITEMS[gap.id].reference], gap.ans, `${gap.id} current reference`);
    }
  }

  for (const item of Object.values(CORE_VOICE_TUTOR_ITEMS)) {
    assertDistinctSameSkillPractice(item);
    if (item.module === 'vocabulary' && item.id.endsWith('.type')) {
      for (const answer of item.reference) {
        assert.equal(item.prompt.toLocaleLowerCase().includes(answer.toLocaleLowerCase()), false, `${item.id} reveals ${answer}`);
      }
    }
    if (item.module === 'vocabulary') {
      const word = CORE_VOICE_CATALOG_SOURCE.vocabulary[Number(item.id.split('.')[2]) - 1];
      assertVocabularyPracticeTargets(item, word.w);
      const tasks = [item.microCheck, item.transferTask, item.recoveryTasks.day1, item.recoveryTasks.day7];
      const reference = [word.w, word.w.replace(/^to\s+/iu, '')];
      for (const [index, task] of tasks.entries()) {
        assert.equal(task.prompt.includes(word.ex), false, `${item.id} reuses its authored source example`);
        assert.equal(task.prompt.includes(word.tr), false, `${item.id} reveals the Russian answer`);
        assert.ok(task.prompt.includes(maskAcceptedAnswers(word.practice[index], reference)), `${item.id} uses reviewed context ${index + 1}`);
        assert.doesNotMatch(task.prompt, /action card|chooses the action|значени/u, `${item.id} uses a real sentence, not a meta-label`);
      }
    }
  }
  const relationship = CORE_VOICE_TUTOR_ITEMS['core.v.1.c1'];
  assert.equal(relationship.recoveryTasks.day1.answers.includes('отношения'), false, 'C1 contextual repeat expects an option, not its Russian source answer');
  const sibling = CORE_VOICE_TUTOR_ITEMS['core.v.2.c1'];
  const answerSequence = (item) => [item.microCheck, item.transferTask, item.recoveryTasks.day1, item.recoveryTasks.day7]
    .map((task) => task.answers.find((answer) => /^[a-d]$/u.test(answer))).join('');
  assert.notEqual(answerSequence(relationship), answerSequence(sibling), 'answer positions vary by lexeme');
  assert.match(relationship.recoveryTasks.day1.prompt, /Новый пример/u);
  assert.doesNotMatch(relationship.recoveryTasks.day1.prompt, /They have a close relationship/u);
  assert.doesNotMatch(relationship.microCheck.prompt, /брат или сестра/u, 'contextual choice is not a renamed translation question');

  const words = [{ w: 'relationship', tr: 'отношения', ex: 'A close relationship matters.' }];
  decorateCoreVocabulary(words);
  for (const mode of ['c1', 'c2', 'type']) {
    const voice = coreVocabularyVoice(words[0], mode);
    assert.equal(voice.revision, 1);
    assert.ok(getCanonicalVoiceTutorItem(voice.id));
  }

  const bank = { 1: { c: [{ t: ['She ', ' every day.'], o: ['go', 'goes'], a: 1, e: 'rule' }], f: [] } };
  const exams = [{ gaps: [{ b: 'GO', ans: ['went'], e: 'rule', t: 1 }] }];
  decorateCoreGrammar(bank, exams);
  assert.deepEqual(coreGrammarVoice(bank[1].c[0]), { id: 'core.g.1.c.1', revision: 1 });
  assert.deepEqual(coreGrammarVoice(exams[0].gaps[0]), { id: 'core.g.exam.1.1', revision: 1 });
});

test('generated direct exercises expose stable server-owned definitions without client references', () => {
  const topic = {
    c: [0, 1, 2].map((index) => ({ t: [`Before ${index} `, ' after'], o: ['bad', 'right', 'x', 'y'], a: 1, e: 'Because.' })),
    f: [0, 1, 2].map((index) => ({ s: `Sentence ${index} _____ (GO)`, b: 'GO', ans: ['went'], e: 'Past.' })),
  };
  const decorated = decorateGeneratedVoiceTutorContent('grammar_topic_set', HASH, topic);
  const voice = decorated.c[0].voice;
  const parsed = parseGeneratedVoiceTutorItemId(voice.id, 'grammar');
  assert.equal(parsed.operation, 'grammar_topic_set');
  assert.equal(parsed.requestHash, HASH);
  const definitions = buildGeneratedVoiceTutorDefinitions('grammar_topic_set', HASH, topic);
  assert.equal(definitions.getItem(voice.id).reference[0], 'right');
  assert.equal(definitions.getItem(voice.id).prompt, 'Before 0 _____ after');
  assertDistinctSameSkillPractice(definitions.getItem(voice.id));
  assert.equal(definitions.getItem(voice.id).skill.id, `ege.grammar.generated_${HASH.slice(0, 16)}`);

  const cards = [{ w: 'to achieve', p: 'v', tr: 'достигать', ex: 'People achieve goals.' }];
  const decoratedCards = decorateGeneratedVoiceTutorContent('vocabulary_cards', HASH, cards);
  assert.equal(decoratedCards[0].voice_tutor, undefined, 'one card cannot provide four unseen contexts');
  const cardDefinitions = buildGeneratedVoiceTutorDefinitions('vocabulary_cards', HASH, cards);
  assert.equal(cardDefinitions, null);

  const withPractice = (card, examples) => ({ ...card, practice: examples });
  const mixedCards = [
    withPractice(
      { w: 'to achieve', p: 'v', tr: 'достигать', ex: 'People achieve goals.' },
      ['Students can achieve better results.', 'Teams achieve more by working together.', 'You can achieve this goal with practice.', 'Athletes train daily to achieve success.'],
    ),
    withPractice(
      { w: 'decision', p: 'n', tr: 'решение', ex: 'This decision matters.' },
      ['Her decision surprised the class.', 'Every decision has consequences.', 'The final decision belongs to the team.', 'He explained his decision calmly.'],
    ),
    withPractice(
      { w: 'to improve', p: 'v', tr: 'улучшать', ex: 'Practice can improve results.' },
      ['Daily reading can improve vocabulary.', 'They want to improve the school library.', 'Feedback helps learners improve quickly.', 'Exercise can improve your mood.'],
    ),
    withPractice(
      { w: 'honest', p: 'adj', tr: 'честный', ex: 'Be honest with your friends.' },
      ['An honest answer builds trust.', 'She gave an honest opinion.', 'The student was honest about the mistake.', 'Please be honest during the interview.'],
    ),
    withPractice(
      { w: 'abroad', p: 'adv', tr: 'за границей', ex: 'She studies abroad.' },
      ['Many graduates work abroad.', 'He hopes to travel abroad next year.', 'Living abroad can teach independence.', 'My cousin moved abroad last summer.'],
    ),
  ];
  const mixedDecorated = decorateGeneratedVoiceTutorContent('vocabulary_cards', HASH, mixedCards);
  const mixedDefinitions = buildGeneratedVoiceTutorDefinitions('vocabulary_cards', HASH, mixedCards);
  const mixedItem = mixedDefinitions.getItem(mixedDecorated[0].voice_tutor.type.id);
  assertDistinctSameSkillPractice(mixedItem);
  assertVocabularyPracticeTargets(mixedItem, 'to achieve');
  assert.deepEqual(mixedItem.reference, ['to achieve', 'achieve']);
  assert.equal(mixedItem.prompt.toLowerCase().includes('achieve'), false);
  assert.match(mixedItem.recoveryTasks.day1.prompt, /Новый пример/u);
  assert.doesNotMatch(mixedItem.recoveryTasks.day1.prompt, /People achieve goals/u);
  const otherVerb = mixedDefinitions.getItem(mixedDecorated[2].voice_tutor.type.id);
  assert.notEqual(mixedItem.skill.id, otherVerb.skill.id, 'different verbs are not the same recovery skill');

  const exam = {
    tx: ['A ', ' B ', ' C.'],
    gaps: [
      { b: 'GO', ans: ['went'], e: 'Past.', t: 1 },
      { b: 'USE', ans: ['useful'], e: 'Word formation.', t: 16 },
    ],
  };
  const decoratedExam = decorateGeneratedVoiceTutorContent('grammar_exam_19_24', HASH, exam);
  const examDefinitions = buildGeneratedVoiceTutorDefinitions('grammar_exam_19_24', HASH, exam);
  for (const gap of decoratedExam.gaps) {
    const item = examDefinitions.getItem(gap.voice.id);
    assertDistinctSameSkillPractice(item);
  }

  const duplicateTopic = {
    c: [
      { t: ['Same ', ' sentence.'], o: ['bad', 'right', 'x', 'y'], a: 1, e: 'Because.' },
      { t: [' same  ', '  sentence!'], o: ['bad', 'right', 'x', 'y'], a: 1, e: 'Because.' },
      { t: ['SAME ', ' SENTENCE?'], o: ['bad', 'right', 'x', 'y'], a: 1, e: 'Because.' },
    ],
    f: [
      { s: 'Same _____ sentence.', b: 'GO', ans: ['went'], e: 'Past.' },
      { s: ' same   _____  sentence!', b: 'GO', ans: ['went'], e: 'Past.' },
      { s: 'SAME _____ SENTENCE?', b: 'GO', ans: ['went'], e: 'Past.' },
    ],
  };
  assert.equal(
    buildGeneratedVoiceTutorDefinitions('grammar_topic_set', HASH, duplicateTopic),
    null,
    'voice tracer fails closed when four unseen same-skill analogs are unavailable',
  );
  assert.deepEqual(
    decorateGeneratedVoiceTutorContent('grammar_topic_set', HASH, duplicateTopic),
    duplicateTopic,
    'unavailable tracer is not advertised to the learner',
  );
});
