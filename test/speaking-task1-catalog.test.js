import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPEAKING_TASK1_CEFR_COUNTS,
  analyzeSpeakingTask1CatalogQuality,
  assertSpeakingTask1Catalog,
  speakingTask1PublicAssignment,
} from '../public/speaking-catalog-contract.js';
import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';

test('Speaking task 1 publishes exactly 60 original valid texts and rejects corrupted catalog data', () => {
  assert.equal(assertSpeakingTask1Catalog(SPEAKING_TASK1_CATALOG), SPEAKING_TASK1_CATALOG);
  assert.equal(SPEAKING_TASK1_CATALOG.tasks.length, 60);
  assert.deepEqual(
    Object.fromEntries(Object.keys(SPEAKING_TASK1_CEFR_COUNTS).map((cefr) => [
      cefr,
      SPEAKING_TASK1_CATALOG.tasks.filter((task) => task.cefr === cefr).length,
    ])),
    SPEAKING_TASK1_CEFR_COUNTS,
  );
  assert.equal(new Set(SPEAKING_TASK1_CATALOG.tasks.map((task) => task.id)).size, 60);
  assert.equal(new Set(SPEAKING_TASK1_CATALOG.tasks.map((task) => task.text)).size, 60);

  const assignment = speakingTask1PublicAssignment(SPEAKING_TASK1_CATALOG.tasks[0]);
  assert.deepEqual(Object.keys(assignment).sort(), [
    'cefr', 'id', 'instruction', 'maxScore', 'preparationSeconds', 'responseSeconds',
    'revision', 'taskType', 'text', 'topic',
  ]);
  assert.equal(assignment.preparationSeconds, 90);
  assert.equal(assignment.responseSeconds, 90);
  assert.equal(assignment.maxScore, 1);

  const corrupted = structuredClone(SPEAKING_TASK1_CATALOG);
  corrupted.tasks[1].id = corrupted.tasks[0].id;
  assert.throws(() => assertSpeakingTask1Catalog(corrupted), /id must be unique/u);

  const leakedReference = structuredClone(SPEAKING_TASK1_CATALOG.tasks[0]);
  leakedReference.reference.script += ' <script>alert(1)</script>';
  assert.throws(
    () => assertSpeakingTask1Catalog({ ...SPEAKING_TASK1_CATALOG, tasks: [
      leakedReference,
      ...SPEAKING_TASK1_CATALOG.tasks.slice(1),
    ] }),
    /unsafe markup/u,
  );
});

test('Speaking task 1 texts have independent lexical and similarity quality safeguards', () => {
  const quality = analyzeSpeakingTask1CatalogQuality(SPEAKING_TASK1_CATALOG);

  assert.equal(quality.uniqueOpenings, 60);
  assert.equal(quality.uniqueTopics, 60);
  assert.ok(quality.minimumLexicalDiversity >= 0.65, `minimum lexical diversity was ${quality.minimumLexicalDiversity}`);
  assert.ok(quality.maximumPairSimilarity <= 0.3, `maximum pair similarity was ${quality.maximumPairSimilarity}`);
  assert.equal(quality.sharedEightWordSequence, null);
});
