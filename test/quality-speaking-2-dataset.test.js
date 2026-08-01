import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { validateQualityDataset } from '../ai/quality.js';

const dataset = JSON.parse(await fs.readFile(new URL('../quality/speaking-2-fipi.json', import.meta.url), 'utf8'));

test('the extracted speaking task 2 set reaches the section 11.1 minimum', () => {
  assert.equal(dataset.length, 10);
  assert.equal(new Set(dataset.map((item) => item.id)).size, dataset.length);
  for (const item of dataset) assert.equal(item.operation, 'speaking_2');
});

test('every task 2 work keeps four questions, marks and reviewed assignment points', () => {
  for (const item of dataset) {
    assert.equal(item.assignment.points.length, 4, `${item.id}: four information points`);
    assert.ok((item.transcript.match(/\?/gu) || []).length >= 4, `${item.id}: four scored question attempts`);
    const criteria = Object.values(item.human.criteria);
    assert.equal(criteria.length, 4, `${item.id}: four question marks`);
    assert.ok(criteria.every((score) => score === 0 || score === 1), `${item.id}: binary marks`);
    assert.equal(item.human.total, criteria.reduce((sum, score) => sum + score, 0), `${item.id}: total matches marks`);
    assert.equal(item.human.max, 4);
    assert.equal(item.human.notes.length, 4, `${item.id}: four expert comments`);
    assert.equal(item.source.assignmentReview, 'visual-pdf-review');
  }
});

test('task 2 transcripts are clean English with qualified provenance', () => {
  for (const item of dataset) {
    assert.doesNotMatch(item.transcript, /[А-Яа-яЁё]/u, `${item.id}: Cyrillic artefact`);
    assert.doesNotMatch(item.transcript, /(?:GR|LEX|PHON)/u, `${item.id}: expert markup`);
    assert.match(item.human.reviewer, /^fipi-20\d\d-expert-manual$/u);
    assert.match(item.source.document, /^fipi-uch-20\d\d\.pdf$/u);
  }
});

test('task 2 has no AI runs yet and is not falsely marked release-ready', () => {
  const validation = validateQualityDataset(dataset, { release: false });
  assert.equal(validation.ok, false);
  assert.equal(validation.counts.speaking_2, 10);
  assert.ok(validation.errors.every((error) => error.endsWith('scores are incomplete')));
});
