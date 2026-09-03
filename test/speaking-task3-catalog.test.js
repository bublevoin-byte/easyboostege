import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  SPEAKING_TASK3_CEFR_COUNTS,
  analyzeSpeakingTask3CatalogQuality,
  assertSpeakingTask3Catalog,
  speakingTask3PublicAssignment,
} from '../public/speaking-catalog-contract.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';

test('Speaking task 3 publishes exactly 60 original five-answer interviews under the EGE-2026 contract', () => {
  assert.equal(assertSpeakingTask3Catalog(SPEAKING_TASK3_CATALOG), SPEAKING_TASK3_CATALOG);
  assert.equal(SPEAKING_TASK3_CATALOG.tasks.length, 60);
  assert.deepEqual(
    Object.fromEntries(Object.keys(SPEAKING_TASK3_CEFR_COUNTS).map((cefr) => [
      cefr,
      SPEAKING_TASK3_CATALOG.tasks.filter((task) => task.cefr === cefr).length,
    ])),
    SPEAKING_TASK3_CEFR_COUNTS,
  );
  assert.equal(new Set(SPEAKING_TASK3_CATALOG.tasks.map((task) => task.id)).size, 60);
  assert.equal(SPEAKING_TASK3_CATALOG.tasks.every((task) => task.questions.length === 5), true);
  assert.equal(SPEAKING_TASK3_CATALOG.tasks.every((task) => task.completeness.length === 5), true);

  const assignment = speakingTask3PublicAssignment(SPEAKING_TASK3_CATALOG.tasks[0]);
  assert.deepEqual(Object.keys(assignment).sort(), [
    'cefr', 'id', 'instruction', 'maxScore', 'preparationSeconds', 'questionSeconds',
    'questions', 'revision', 'taskType', 'topic',
  ]);
  assert.equal(assignment.preparationSeconds, 0);
  assert.equal(assignment.questionSeconds, 40);
  assert.equal(assignment.questions.length, 5);
  assert.equal(assignment.maxScore, 5);
  assert.equal(Object.hasOwn(assignment, 'completeness'), false);
  assert.equal(Object.hasOwn(assignment, 'provenance'), false);
  assert.equal(Object.hasOwn(assignment, 'reference'), false);
});

test('public Speaking task 3 catalog contains no ready answers or hidden reference material', async () => {
  assert.equal(SPEAKING_TASK3_CATALOG.tasks.every((task) => !Object.hasOwn(task, 'reference')), true);
  const source = await fs.readFile(new URL('../public/content/speaking/task3-v1.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:sample|model|ready)(?:Answer|Response)|reference|etalon/iu);
});

test('Speaking task 3 validator rejects a sixth question, duplicate interviews and unsafe content', () => {
  const sixQuestions = structuredClone(SPEAKING_TASK3_CATALOG);
  sixQuestions.tasks[0].questions.push('Which extra answer would you add?');
  assert.throws(() => assertSpeakingTask3Catalog(sixQuestions), /exactly five/u);

  const duplicateInterview = structuredClone(SPEAKING_TASK3_CATALOG);
  duplicateInterview.tasks[1].questions = [...duplicateInterview.tasks[0].questions];
  assert.throws(() => assertSpeakingTask3Catalog(duplicateInterview), /question sequence must be unique/u);

  const unsafe = structuredClone(SPEAKING_TASK3_CATALOG);
  unsafe.tasks[0].questions[0] = '<script>alert(1)</script>?';
  assert.throws(() => assertSpeakingTask3Catalog(unsafe), /unsafe markup/u);

  const unsafeMedicalAdvice = structuredClone(SPEAKING_TASK3_CATALOG);
  unsafeMedicalAdvice.tasks[0].questions[0] = 'Should teenagers stop taking prescribed medicine without asking a doctor?';
  assert.throws(() => assertSpeakingTask3Catalog(unsafeMedicalAdvice), /medical advice/u);

  const discriminatory = structuredClone(SPEAKING_TASK3_CATALOG);
  discriminatory.tasks[0].questions[0] = 'Why is one nationality naturally superior to another?';
  assert.throws(() => assertSpeakingTask3Catalog(discriminatory), /discriminatory stereotype/u);

  const timeSensitive = structuredClone(SPEAKING_TASK3_CATALOG);
  timeSensitive.tasks[0].questions[0] = 'Who was the current president in 2025?';
  assert.throws(() => assertSpeakingTask3Catalog(timeSensitive), /time-sensitive fact/u);
});

test('Speaking task 3 catalog has independently checked thematic and communicative coverage', () => {
  const quality = analyzeSpeakingTask3CatalogQuality(SPEAKING_TASK3_CATALOG);

  assert.equal(quality.uniqueInterviewSets, 60);
  assert.equal(quality.uniqueQuestions, 300);
  assert.equal(quality.uniqueTopics >= 40, true);
  assert.deepEqual(quality.codifierAreaCounts, {
    culture_and_media: 14,
    education_and_careers: 11,
    health_sport_and_community: 6,
    personal_and_family_life: 11,
    science_technology_and_environment: 9,
    travel_and_places: 9,
  });
  assert.deepEqual(quality.missingCodifierAreas, []);
  assert.equal(quality.completenessChecks, 300);
  assert.equal(quality.sharedFiveQuestionSequence, null);
  assert.equal(quality.sharedSixWordSequence, null);
  assert.equal(quality.maximumFourWordOpeningCount <= 2, true);
});
