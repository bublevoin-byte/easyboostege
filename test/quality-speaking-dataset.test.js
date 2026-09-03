import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { validateQualityDataset } from '../ai/quality.js';

const dataset = JSON.parse(await fs.readFile(new URL('../quality/speaking-3-fipi.json', import.meta.url), 'utf8'));

test('the extracted set covers the section 11.1 minimum for speaking task 3', () => {
  assert.ok(dataset.length >= 10, `expected at least 10 scripts, found ${dataset.length}`);
  const ids = new Set(dataset.map((item) => item.id));
  assert.equal(ids.size, dataset.length, 'ids must be unique');
  for (const item of dataset) assert.equal(item.operation, 'speaking_3');
});

test('every script keeps five questions, five scores and a consistent total', () => {
  for (const item of dataset) {
    assert.equal(item.assignment.qs.length, 5, `${item.id}: five interview questions`);
    const criteria = Object.values(item.human.criteria);
    assert.equal(criteria.length, 5, `${item.id}: five per-question scores`);
    for (const score of criteria) assert.ok(score === 0 || score === 1, `${item.id}: task 3 scores are 0 or 1`);
    assert.equal(item.human.total, criteria.reduce((sum, score) => sum + score, 0), `${item.id}: total matches the criteria`);
    assert.equal(item.human.max, 5);
    assert.ok(item.human.total <= item.human.max, `${item.id}: total within the maximum`);
    assert.equal(item.human.notes.length, 5, `${item.id}: an expert note per answer`);
  }
});

test('answers and questions survived extraction as clean English', () => {
  for (const item of dataset) {
    assert.ok(item.transcript.length > 40, `${item.id}: transcript is too short to be a real answer`);
    // Cyrillic in the English text means a page artefact or a look-alike slipped through.
    assert.doesNotMatch(item.transcript, /[А-Яа-яЁё]/u, `${item.id}: transcript contains Cyrillic`);
    for (const question of item.assignment.qs) {
      assert.doesNotMatch(question, /[А-Яа-яЁё]/u, `${item.id}: question contains Cyrillic`);
      assert.match(question, /\?$/u, `${item.id}: a question ends with a question mark`);
    }
  }
});

test('each script names its qualified reviewer and difficulty', () => {
  for (const item of dataset) {
    assert.match(item.human.reviewer, /^fipi-20\d\d-expert-manual$/u, `${item.id}: reviewer is recorded`);
    const difficulty = item.tags.filter((tag) => ['strong', 'middle', 'weak'].includes(tag));
    assert.equal(difficulty.length, 1, `${item.id}: exactly one difficulty tag`);
  }
  const levels = new Set(dataset.flatMap((item) => item.tags.filter((tag) => ['strong', 'middle', 'weak'].includes(tag))));
  // Section 11.1 asks for strong, middle and weak works in the set.
  assert.deepEqual([...levels].sort(), ['middle', 'strong', 'weak']);
});

test('the set is not yet runnable: AI runs still have to be recorded', () => {
  const validation = validateQualityDataset(dataset, { release: false });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.every((error) => error.endsWith('scores are incomplete')),
    `only missing AI runs may block the set, got: ${validation.errors.slice(0, 3).join('; ')}`);
  assert.equal(validation.counts.speaking_3, dataset.length);
});
