import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertListeningCatalog,
  loadMatchingCatalog,
  matchingSetForLegacyScreen,
} from '../public/listening-catalog-contract.js';
import {
  LISTENING_MATCHING_SETS,
  LISTENING_PILOT_CATALOG,
} from '../public/listening-pilot-v1.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('listening pilot exposes 20 original exam-sized matching sets', () => {
  assert.equal(LISTENING_PILOT_CATALOG.id, 'listening-pilot-v1');
  assert.equal(LISTENING_PILOT_CATALOG.revision, 1);
  assert.equal(LISTENING_MATCHING_SETS.length, 20);
  assert.equal(new Set(LISTENING_MATCHING_SETS.map((set) => set.id)).size, 20);
  assert.ok(new Set(LISTENING_MATCHING_SETS.map((set) => set.topic)).size >= 15);
  assert.deepEqual(new Set(LISTENING_MATCHING_SETS.map((set) => set.cefr)), new Set(['B1', 'B2']));

  for (const set of LISTENING_MATCHING_SETS) {
    assert.equal(set.type, 'matching');
    assert.equal(set.provenance, 'original');
    assert.equal(set.script.length, 6, set.id);
    assert.equal(set.task.statements.length, 7, set.id);
    assert.equal(set.task.answers.length, 6, set.id);
    assert.equal(new Set(set.task.answers).size, 6, set.id);
    assert.equal(set.task.evidence.length, 6, set.id);
    assert.equal(set.audio.path.startsWith('/audio/listening/listening-pilot-v1/matching/'), true, set.id);
    assert.equal(Object.isFrozen(set), true, set.id);

    const used = new Set(set.task.answers);
    assert.equal(set.task.statements.filter((_, index) => !used.has(index)).length, 1, set.id);
    set.task.evidence.forEach((evidence, index) => {
      assert.equal(evidence.statementIndex, set.task.answers[index], `${set.id} speaker ${index + 1}`);
      assert.ok(set.script[index].text.includes(evidence.quote), `${set.id} quote ${index + 1}`);
      assert.match(evidence.explanationRu, /[А-Яа-яЁё]/u, set.id);
    });
  }
});

test('catalog validator reports the damaged set id and rejects unsafe or ambiguous matching data', () => {
  const valid = clone(LISTENING_PILOT_CATALOG);
  assert.doesNotThrow(() => assertListeningCatalog(valid, { expectedCounts: { matching: 20 } }));

  const cases = [
    ['unsafe id', (catalog) => { catalog.sets[0].id = '../escape'; }, /\.\.\/escape.*safe stable id/iu],
    ['unversioned set', (catalog) => { catalog.sets[0].revision = 0; }, /revision/iu],
    ['copied provenance', (catalog) => { catalog.sets[0].provenance = 'external'; }, /provenance.*original/iu],
    ['wrong speaker count', (catalog) => { catalog.sets[0].script.pop(); }, /script.*6/iu],
    ['unknown role', (catalog) => { catalog.sets[0].script[0].role = 'narrator'; }, /role/iu],
    ['duplicate answer', (catalog) => { catalog.sets[0].task.answers[1] = catalog.sets[0].task.answers[0]; }, /unique/iu],
    ['missing evidence', (catalog) => { catalog.sets[0].task.evidence[0].quote = ''; }, /quote/iu],
    ['unsafe audio path', (catalog) => { catalog.sets[0].audio.path = '/audio/listening/../secret.mp3'; }, /audio\.path/iu],
    ['stale audio revision', (catalog) => { catalog.sets[0].revision = 2; }, /audio\.path/iu],
  ];

  for (const [name, mutate, expected] of cases) {
    const damaged = clone(LISTENING_PILOT_CATALOG);
    mutate(damaged);
    assert.throws(
      () => assertListeningCatalog(damaged, { expectedCounts: { matching: 20 } }),
      expected,
      name,
    );
  }
});

test('matching catalog adapter preserves identity, evidence and dynamic exam dimensions', () => {
  const source = LISTENING_MATCHING_SETS[0];
  const exercise = matchingSetForLegacyScreen(source);

  assert.deepEqual(exercise.st, source.task.statements);
  assert.deepEqual(exercise.a, source.task.answers);
  assert.equal(exercise.sp.length, 6);
  assert.equal(exercise.k.length, 6);
  assert.equal(exercise.maxScore, 6);
  assert.equal(exercise.id, source.id);
  assert.equal(exercise.revision, source.revision);
  assert.equal(exercise.evidenceSource, 'builtin');
  assert.equal(exercise.audioPath, source.audio.path);
});

test('catalog loader returns an empty set for load or validation failure so the screen can use fallback', async () => {
  assert.deepEqual(await loadMatchingCatalog(async () => { throw new Error('offline'); }), []);
  assert.deepEqual(await loadMatchingCatalog(async () => ({ LISTENING_MATCHING_SETS: [{}] })), []);
  assert.equal((await loadMatchingCatalog(async () => ({ LISTENING_MATCHING_SETS }))).length, 20);
});
