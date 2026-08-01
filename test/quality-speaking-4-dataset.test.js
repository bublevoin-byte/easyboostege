import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import { validateQualityDataset } from '../ai/quality.js';

const dataset = JSON.parse(await fs.readFile(new URL('../quality/speaking-4-fipi.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(await fs.readFile(new URL('../quality/speaking-4-fipi-candidates.json', import.meta.url), 'utf8'));

test('speaking task 4 contains seven complete unique FIPI transcripts', () => {
  assert.equal(dataset.length, 7);
  assert.equal(new Set(dataset.map((item) => item.id)).size, dataset.length);
  assert.equal(dataset.filter((item) => item.assignment.topic === 'Life without gadgets').length, 2);
  for (const item of dataset) {
    assert.equal(item.operation, 'speaking_4');
    assert.ok(item.tags.includes('full-transcript'));
  }
});

test('task 4 uses the published FIPI 4/3/3 criteria and visually checked photos', () => {
  for (const item of dataset) {
    assert.equal(item.assignment.plan.length, 4, `${item.id}: four plan points`);
    assert.equal(item.assignment.ph.length, 2, `${item.id}: two photo descriptions`);
    assert.deepEqual(Object.keys(item.human.criteria), ['task', 'organisation', 'language']);
    assert.ok(item.human.criteria.task <= 4, `${item.id}: K1 max 4`);
    assert.ok(item.human.criteria.organisation <= 3, `${item.id}: K2 max 3`);
    assert.ok(item.human.criteria.language <= 3, `${item.id}: K3 max 3`);
    assert.equal(item.human.total, Object.values(item.human.criteria).reduce((sum, score) => sum + score, 0));
    assert.equal(item.human.max, 10);
    assert.equal(item.source.assignmentReview, 'visual-pdf-review');
    if (item.human.criteria.task === 0) assert.equal(item.human.total, 0, `${item.id}: zero K1 zeros the work`);
  }
});

test('task 4 transcripts contain no Russian asides or expert markup', () => {
  for (const item of dataset) {
    assert.ok(item.transcript.length > 400, `${item.id}: transcript must be complete`);
    assert.doesNotMatch(item.transcript, /[А-Яа-яЁё]/u, `${item.id}: Cyrillic aside or artefact`);
    assert.doesNotMatch(item.transcript, /(?:GR-R|LOGIC|PHON|LEX|ART|GR)/u, `${item.id}: expert markup`);
    assert.match(item.human.reviewer, /^fipi-20\d\d-expert-manual$/u);
  }
});

test('four fragmented task 4 works stay outside the golden dataset', () => {
  assert.equal(candidates.length, 4);
  const goldenTopics = new Set(dataset.map((item) => item.assignment.topic));
  for (const item of candidates) {
    assert.equal(item.status, 'excluded');
    assert.match(item.reason, /not a complete student transcript/u);
    assert.equal(goldenTopics.has(item.assignment.topic), false);
    assert.equal(item.assignment.ph.length, 2);
  }
});

test('task 4 remains below the minimum and without paid AI runs', () => {
  const validation = validateQualityDataset(dataset, { release: false });
  assert.equal(validation.ok, false);
  assert.equal(validation.counts.speaking_4, 7);
  assert.ok(validation.errors.every((error) => error.endsWith('scores are incomplete')));
});
