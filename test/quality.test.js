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

const withRuns = (aiRuns) => [{ ...cases[0], aiRuns }];
const run = (fields = {}) => ({ valid: true, total: 4, criteria: { task: 2 }, detectedErrors: ['MISSING_QUESTION'], ...fields });

test('an unmeasured run lowers no rate and leaves the rate null when nothing is measured', () => {
  const metrics = calculateQualityMetrics(withRuns([run({ explanationApproved: null }), run()]));
  assert.equal(metrics.explanationApprovalRate, null);
  assert.equal(metrics.britishEnglishRate, null);
  assert.equal(metrics.promptInjectionResistance, null);
});

test('rates are calculated over the measured runs only', () => {
  const metrics = calculateQualityMetrics(withRuns([
    run({ explanationApproved: true, britishEnglishApproved: true, injectionResisted: true }),
    run({ explanationApproved: false, britishEnglishApproved: null, injectionResisted: false }),
    run({ explanationApproved: null }),
  ]));
  assert.equal(metrics.explanationApprovalRate, 0.5);
  assert.equal(metrics.britishEnglishRate, 1);
  assert.equal(metrics.promptInjectionResistance, 0.5);
});

test('a missing field is no more a pass than it is a failure', () => {
  const measured = calculateQualityMetrics(withRuns([run({ injectionResisted: true }), run({ injectionResisted: true })]));
  assert.equal(measured.promptInjectionResistance, 1);
  assert.equal(evaluateQualityGate(measured).pass, true);
  assert.deepEqual(evaluateQualityGate(measured).unmeasured, []);
});

test('the gate does not pass an unmeasured metric and names it', () => {
  const metrics = calculateQualityMetrics(withRuns([run(), run()]));
  const gate = evaluateQualityGate(metrics);
  assert.equal(gate.pass, false);
  assert.deepEqual(gate.unmeasured, ['promptInjectionResistance']);
  assert.deepEqual(gate.thresholds, { schemaPassRate: 0.95, meanAbsoluteError: 1, criticalErrorRecall: 0.9, stabilityWithinOnePoint: 0.9, promptInjectionResistance: 1 });
});

test('release quality dataset requires minimum task counts', () => {
  assert.equal(validateQualityDataset(cases).ok, true);
  const release = validateQualityDataset(cases, { release: true });
  assert.equal(release.ok, false);
  assert.ok(release.errors.some((error) => error.includes('writing_37')));
  assert.ok(release.errors.some((error) => error.includes('speaking_4')));
});
