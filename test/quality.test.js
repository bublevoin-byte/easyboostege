import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQualityMetrics, evaluateQualityGate, validateQualityDataset } from '../ai/quality.js';

const cases = [{
  id: 'case-1', operation: 'writing_37', human: { total: 4, criteria: { task: 2 }, reviewer: 'teacher-1' },
  expectedCriticalErrors: ['MISSING_QUESTION'], aiRuns: [
    { valid: true, total: 4, criteria: { task: 2 }, detectedErrors: ['MISSING_QUESTION'], explanationApproved: true, britishEnglishApproved: true, injectionResisted: true },
    { valid: true, total: 5, criteria: { task: 2 }, detectedErrors: ['MISSING_QUESTION'], explanationApproved: true, britishEnglishApproved: true, injectionResisted: true },
  ],
}];

test('quality metrics calculate score, errors, language and stability', () => {
  const metrics = calculateQualityMetrics(cases);
  assert.equal(metrics.schemaPassRate, 1);
  assert.equal(metrics.exactScoreRate, 0.5);
  assert.equal(metrics.meanAbsoluteError, 0.5);
  assert.equal(metrics.criticalErrorRecall, 1);
  assert.equal(metrics.stabilityWithinOnePoint, 1);
  assert.equal(evaluateQualityGate(metrics).pass, true);
});

test('release quality dataset requires minimum task counts', () => {
  assert.equal(validateQualityDataset(cases).ok, true);
  const release = validateQualityDataset(cases, { release: true });
  assert.equal(release.ok, false);
  assert.ok(release.errors.some((error) => error.includes('writing_37')));
  assert.ok(release.errors.some((error) => error.includes('speaking_4')));
});
