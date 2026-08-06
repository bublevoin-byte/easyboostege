import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPEAKING_TASK4_CEFR_COUNTS,
  assertSpeakingTask4Catalog,
  speakingTask4PublicAssignment,
} from '../public/speaking-catalog-contract.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';

test('Speaking task 4 publishes 60 original four-point photo projects under the EGE-2026 contract', () => {
  assert.equal(assertSpeakingTask4Catalog(SPEAKING_TASK4_CATALOG), SPEAKING_TASK4_CATALOG);
  assert.equal(SPEAKING_TASK4_CATALOG.tasks.length, 60);
  assert.deepEqual(
    Object.fromEntries(Object.keys(SPEAKING_TASK4_CEFR_COUNTS).map((cefr) => [
      cefr,
      SPEAKING_TASK4_CATALOG.tasks.filter((task) => task.cefr === cefr).length,
    ])),
    SPEAKING_TASK4_CEFR_COUNTS,
  );
  assert.equal(new Set(SPEAKING_TASK4_CATALOG.tasks.map((task) => task.id)).size, 60);
  assert.equal(new Set(SPEAKING_TASK4_CATALOG.tasks.map((task) => task.projectTitle)).size, 60);
  assert.equal(SPEAKING_TASK4_CATALOG.tasks.every((task) => task.plan.length === 4), true);
  assert.equal(SPEAKING_TASK4_CATALOG.tasks.every((task) => task.photoPair.panels.length === 2), true);
  assert.equal(SPEAKING_TASK4_CATALOG.tasks.every((task) => (
    task.rubric.content.maxScore === 4
      && task.rubric.organisation.maxScore === 3
      && task.rubric.language.maxScore === 3
      && task.rubric.zeroContentMeansZero === true
  )), true);

  const assignment = speakingTask4PublicAssignment(SPEAKING_TASK4_CATALOG.tasks[0]);
  assert.deepEqual(Object.keys(assignment).sort(), [
    'cefr', 'id', 'instruction', 'maxScore', 'photoPair', 'plan', 'preparationSeconds',
    'projectTitle', 'responseSeconds', 'revision', 'taskType', 'topic',
  ]);
  assert.equal(assignment.preparationSeconds, 150);
  assert.equal(assignment.responseSeconds, 180);
  assert.equal(assignment.maxScore, 10);
  assert.equal(assignment.plan.length, 4);
  assert.equal(assignment.photoPair.panels.length, 2);
  assert.equal(Object.hasOwn(assignment, 'rubric'), false);
  assert.equal(Object.hasOwn(assignment, 'provenance'), false);
});

test('Speaking task 4 validator rejects non-substantive plans, invalid rubric and external assets', () => {
  const shortPlan = structuredClone(SPEAKING_TASK4_CATALOG);
  shortPlan.tasks[0].plan[0] = 'Describe them.';
  assert.throws(() => assertSpeakingTask4Catalog(shortPlan), /substantive/u);

  const wrongRubric = structuredClone(SPEAKING_TASK4_CATALOG);
  wrongRubric.tasks[0].rubric.language.maxScore = 4;
  assert.throws(() => assertSpeakingTask4Catalog(wrongRubric), /4\/3\/3/u);

  const externalAsset = structuredClone(SPEAKING_TASK4_CATALOG);
  externalAsset.tasks[0].photoPair.src = 'https://example.com/pair.webp';
  assert.throws(() => assertSpeakingTask4Catalog(externalAsset), (error) => (
    error.message.startsWith('SPEAKING_CATALOG_INVALID:')
      && /local speaking asset/u.test(error.message)
  ));
});
