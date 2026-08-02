import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  coreGrammarVoice,
  coreVocabularyVoice,
  decorateCoreGrammar,
  decorateCoreVocabulary,
} from '../public/modules/core-voice-catalog.js';
import { getCanonicalVoiceTutorItem } from '../voice-tutor/canonical-items.js';
import { CORE_VOICE_TUTOR_COVERAGE } from '../voice-tutor/core-catalog.js';
import { CORE_VOICE_CATALOG_SOURCE } from '../voice-tutor/generated-core-catalog.js';
import {
  buildGeneratedVoiceTutorDefinitions,
  decorateGeneratedVoiceTutorContent,
  parseGeneratedVoiceTutorItemId,
} from '../voice-tutor/generated-items.js';

const HASH = 'a'.repeat(64);

test('committed core catalog is generated from every current built-in grammar and vocabulary path', () => {
  const check = spawnSync(process.execPath, ['scripts/build-core-voice-catalog.js', '--check'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const grammarCount = Object.values(CORE_VOICE_CATALOG_SOURCE.grammar)
    .reduce((count, levels) => count + Object.values(levels).reduce((sum, questions) => sum + questions.length, 0), 0)
    + CORE_VOICE_CATALOG_SOURCE.exams.reduce((count, exam) => count + exam.gaps.length, 0);
  assert.deepEqual(CORE_VOICE_TUTOR_COVERAGE, { grammar: grammarCount, vocabulary: CORE_VOICE_CATALOG_SOURCE.vocabulary.length * 3 });
  assert.equal(grammarCount, 218);
  assert.equal(CORE_VOICE_TUTOR_COVERAGE.vocabulary, 897);

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

  const cards = [{ w: 'to achieve', p: 'v', tr: 'достигать', ex: 'People achieve goals.' }];
  const decoratedCards = decorateGeneratedVoiceTutorContent('vocabulary_cards', HASH, cards);
  const cardVoice = decoratedCards[0].voice_tutor.type;
  const cardDefinitions = buildGeneratedVoiceTutorDefinitions('vocabulary_cards', HASH, cards);
  assert.deepEqual(cardDefinitions.getItem(cardVoice.id).reference, ['to achieve', 'achieve']);
});
