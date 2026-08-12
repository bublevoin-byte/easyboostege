import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  GRAMMAR_ACTIVE_PRACTICE_TYPES,
  GRAMMAR_ACTIVE_TOPIC_IDS,
  GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS,
  GRAMMAR_ERROR_CODES,
  GENERATED_GRAMMAR_REVISION,
  isGrammarConfusionPair,
  isGrammarErrorCode,
  isBuiltinGrammarDiagnosticId,
  parseGrammarConfusionPair,
  parseGeneratedGrammarItemId,
  parseGeneratedGrammarItemReference,
} from '../public/grammar-domain-contract.js';

test('one grammar domain contract owns the exact error taxonomy and active type set', () => {
  assert.deepEqual(GRAMMAR_ERROR_CODES, [
    'construction_choice', 'word_or_verb_form', 'auxiliary', 'agreement',
    'word_order', 'negation_or_question', 'confusion_pair',
  ]);
  assert.deepEqual(GRAMMAR_ACTIVE_PRACTICE_TYPES, ['choice', 'input', 'correction', 'transform']);
  assert.deepEqual(GRAMMAR_ACTIVE_TOPIC_IDS, [
    1, 2, 3, 13, 4, 5, 6, 7, 8, 9, 18, 10, 11, 12, 16, 17, 20, 14, 15, 19,
  ]);
  assert.deepEqual(GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS, [10, 11, 12, 16, 17, 20, 14, 15, 19]);
  assert.equal(Object.isFrozen(GRAMMAR_ERROR_CODES), true);
  assert.equal(Object.isFrozen(GRAMMAR_ACTIVE_PRACTICE_TYPES), true);
  assert.equal(Object.isFrozen(GRAMMAR_PREACTIVATION_LEGACY_TOPIC_IDS), true);
  assert.equal(isGrammarErrorCode('word_order'), true);
  assert.equal(isGrammarErrorCode('review_error'), false);
});

test('one grammar domain predicate accepts diagnostics for every active topic without screen-specific topic lists', () => {
  for (const topicId of GRAMMAR_ACTIVE_TOPIC_IDS) {
    assert.equal(isBuiltinGrammarDiagnosticId(`core.g.${topicId}.c.8.diagnostic.3`), true, String(topicId));
  }
  assert.equal(isBuiltinGrammarDiagnosticId('core.g.21.c.1.diagnostic.1'), false, 'unknown topic');
  assert.equal(isBuiltinGrammarDiagnosticId('core.g.5.f.1.diagnostic.1'), false, 'only authored choice diagnostics');
  assert.equal(isBuiltinGrammarDiagnosticId('core.g.5.c.0.diagnostic.1'), false, 'positive item index');
});

test('one grammar domain predicate owns exact confusion-pair parsing', () => {
  assert.equal(isGrammarConfusionPair('present_perfect__past_simple'), true);
  assert.equal(isGrammarConfusionPair('present-perfect__past-simple'), false);
  assert.equal(isGrammarConfusionPair(' present_perfect__past_simple '), false);
  assert.equal(parseGrammarConfusionPair(' present_perfect__past_simple '), 'present_perfect__past_simple');
  assert.equal(parseGrammarConfusionPair('present_perfect___past_simple'), null);
  assert.equal(parseGrammarConfusionPair(null), null);
});

test('one grammar domain parser owns generated pointer identity, type and revision mapping', () => {
  const requestHash = 'a'.repeat(64);
  const resultDigest = 'b'.repeat(16);
  const id = `generated.g.q.${requestHash}.${resultDigest}.f12`;
  assert.equal(GENERATED_GRAMMAR_REVISION, 1);
  assert.deepEqual(parseGeneratedGrammarItemId(id), {
    id, groupId: `generated.g.q.${requestHash}.${resultDigest}`,
    requestHash, resultDigest, kind: 'f', index: 12, type: 'input', revision: 1,
  });
  assert.deepEqual(parseGeneratedGrammarItemReference({ id, revision: 1 }), parseGeneratedGrammarItemId(id));
  assert.equal(parseGeneratedGrammarItemReference({ id, revision: 2 }), null);
  assert.equal(parseGeneratedGrammarItemReference({ id: id.replace('.f12', '.c0'), revision: 1 }), null);
  assert.equal(parseGeneratedGrammarItemId(`generated.g.q.${requestHash}.${resultDigest}.c12`).type, 'choice');
});

test('the shared grammar contract is part of the offline application shell', async () => {
  const worker = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /['"]\/grammar-domain-contract\.js['"]/u);
});

test('generated revision and confusion-pair consumers have no local primitive copies', async () => {
  const paths = [
    '../validation/generated-grammar-mastery.js',
    '../validation/grammar-mastery.js',
    '../public/grammar-catalog.js',
    '../public/modules/grammar.js',
    '../public/learning-activity-recorder.js',
    '../public/screens/grammar.js',
  ];
  const sources = await Promise.all(paths.map((path) => fs.readFile(new URL(path, import.meta.url), 'utf8')));
  for (const [index, source] of sources.entries()) {
    assert.doesNotMatch(source,
      /\^\[a-z0-9\]\+\(\?:_\[a-z0-9\]\+\)\*__\(\?:\[a-z0-9\]\+\(\?:_\[a-z0-9\]\+\)\*\)\$/u,
      `${paths[index]} must consume the shared confusion-pair parser`);
  }
  for (const [path, source, primitive] of [
    [paths[0], sources[0], /reference\.revision !== 1/u],
    [paths[1], sources[1], /revision: z\.literal\(1\)/u],
    [paths[3], sources[3], /source: 'generated', revision: 1/u],
    [paths[5], sources[5], /revision!==1|revision:1/gu],
  ]) {
    assert.match(source, /GENERATED_GRAMMAR_REVISION/u, `${path} must import the shared revision`);
    assert.doesNotMatch(source, primitive, `${path} must not hard-code the generated revision`);
  }
});
