import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  SPEAKING_TASK2_CEFR_COUNTS,
  analyzeSpeakingTask2CatalogQuality,
  assertSpeakingTask2Catalog,
  speakingTask2PublicAssignment,
} from '../public/speaking-catalog-contract.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';

test('Speaking task 2 publishes exactly 60 original four-question assignments under the EGE-2026 contract', () => {
  assert.equal(assertSpeakingTask2Catalog(SPEAKING_TASK2_CATALOG), SPEAKING_TASK2_CATALOG);
  assert.equal(SPEAKING_TASK2_CATALOG.tasks.length, 60);
  assert.deepEqual(
    Object.fromEntries(Object.keys(SPEAKING_TASK2_CEFR_COUNTS).map((cefr) => [
      cefr,
      SPEAKING_TASK2_CATALOG.tasks.filter((task) => task.cefr === cefr).length,
    ])),
    SPEAKING_TASK2_CEFR_COUNTS,
  );
  assert.equal(new Set(SPEAKING_TASK2_CATALOG.tasks.map((task) => task.id)).size, 60);
  assert.equal(new Set(SPEAKING_TASK2_CATALOG.tasks.map((task) => task.advertisement)).size, 60);
  assert.equal(SPEAKING_TASK2_CATALOG.tasks.every((task) => task.supports.length === 4), true);

  const assignment = speakingTask2PublicAssignment(SPEAKING_TASK2_CATALOG.tasks[0]);
  assert.deepEqual(Object.keys(assignment).sort(), [
    'advertisement', 'cefr', 'id', 'instruction', 'maxScore', 'preparationSeconds',
    'questionSeconds', 'revision', 'supports', 'taskType', 'topic',
  ]);
  assert.equal(assignment.preparationSeconds, 60);
  assert.equal(assignment.questionSeconds, 20);
  assert.equal(assignment.supports.length, 4);
  assert.equal(assignment.maxScore, 4);
  assert.equal(Object.hasOwn(assignment, 'rubric'), false);
  assert.equal(Object.hasOwn(assignment, 'reference'), false);
  assert.equal(Object.hasOwn(assignment, 'provenance'), false);
});

test('public Speaking task 2 catalog does not ship model questions or hidden reference answers', async () => {
  assert.equal(SPEAKING_TASK2_CATALOG.tasks.every((task) => !Object.hasOwn(task, 'reference')), true);
  const source = await fs.readFile(new URL('../public/content/speaking/task2-v1.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /sampleQuestions|When does the pottery weekend take place\?/u);
});

test('Speaking task 2 validator rejects a fifth support, duplicate content and unsafe markup', () => {
  const fiveSupports = structuredClone(SPEAKING_TASK2_CATALOG);
  fiveSupports.tasks[0].supports.push('a fifth client-shaped support');
  assert.throws(() => assertSpeakingTask2Catalog(fiveSupports), /exactly four/u);

  const duplicateAdvertisement = structuredClone(SPEAKING_TASK2_CATALOG);
  duplicateAdvertisement.tasks[1].advertisement = duplicateAdvertisement.tasks[0].advertisement;
  assert.throws(() => assertSpeakingTask2Catalog(duplicateAdvertisement), /advertisement must be unique/u);

  const unsafe = structuredClone(SPEAKING_TASK2_CATALOG);
  unsafe.tasks[0].supports[0] = '<script>alert(1)</script>';
  assert.throws(() => assertSpeakingTask2Catalog(unsafe), /unsafe markup/u);
});

test('Speaking task 2 catalog has independently checked communicative content', () => {
  const quality = analyzeSpeakingTask2CatalogQuality(SPEAKING_TASK2_CATALOG);

  assert.equal(quality.uniqueAdvertisements, 60);
  assert.equal(quality.uniqueSupportSets, 60);
  assert.equal(quality.uniqueTopics >= 40, true);
  assert.equal(quality.supportsChecked, 240);
  assert.equal(quality.sharedFourSupportSequence, null);
});
