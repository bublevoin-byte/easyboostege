import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSpeakingCalibrationReport,
  evaluateSpeakingCalibrationGate,
  validateSpeakingCalibrationDataset,
} from '../speaking/calibration.js';

const candidate = Object.freeze({
  catalogVersion: 'speaking-pilot-v1@1',
  promptVersion: 'speaking-semantic-v4',
  scoringVersion: 'speaking-fipi-combiner-v2',
  acousticProviderVersion: 'azure-pa-test-v1',
  semanticProviderVersion: 'xai-test-model',
});

function calibrationCase(index, overrides = {}) {
  const taskType = (index % 4) + 1;
  const expectedCritical = taskType === 1 && index % 5 === 0;
  const total = [null, 1, 4, 5, 10][taskType];
  const subgroupIndex = Math.floor(index / 4);
  const participantAgeGroup = subgroupIndex % 2 ? 'adult' : 'minor';
  return {
    id: `case-${String(index).padStart(3, '0')}`,
    learnerPseudonym: `learner-${String(index).padStart(3, '0')}`,
    taskType,
    participantAgeGroup,
    consent: {
      kind: 'speaking_calibration', version: '2026-08-06-v1', grantedAt: '2026-08-06T10:00:00.000Z',
      guardianConfirmed: participantAgeGroup === 'minor',
    },
    subgroup: {
      locale: subgroupIndex % 2 ? 'en-GB' : 'en-US',
      level: ['B1', 'B2', 'B2+', 'C1'][subgroupIndex % 4],
      device: Math.floor(subgroupIndex / 2) % 2 ? 'mobile' : 'desktop',
      environment: Math.floor(subgroupIndex / 4) % 2 ? 'quiet' : 'ordinary_noise',
    },
    expertRatings: [
      { reviewerPseudonym: `expert-a-${index}`, total, criticalError: expectedCritical },
      { reviewerPseudonym: `expert-b-${index}`, total, criticalError: expectedCritical },
    ],
    runs: [
      { runId: 'run-1', total, criticalError: expectedCritical },
      { runId: 'run-2', total, criticalError: expectedCritical },
    ],
    ...overrides,
  };
}

function dataset(count = 160) {
  return {
    schemaVersion: 'speaking-calibration-dataset-v1',
    candidate,
    cases: Array.from({ length: count }, (_, index) => calibrationCase(index)),
  };
}

test('calibration runner deterministically measures all release metrics and subgroups', () => {
  const input = dataset();
  const validation = validateSpeakingCalibrationDataset(input);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.countsByTask, { 1: 40, 2: 40, 3: 40, 4: 40 });

  const report = buildSpeakingCalibrationReport(input, {
    reportVersion: 'speaking-calibration-2026-08-06.1',
  });
  assert.deepEqual(report.metrics, {
    structuralValidityRate: 1,
    meanAbsoluteError: 0,
    withinOneRate: 1,
    exactAgreementRate: 1,
    criticalErrorRecall: 1,
    criticalErrorFalsePositiveRate: 0,
    stabilityWithinOneRate: 1,
  });
  assert.ok(report.subgroups.locale['en-GB']);
  assert.ok(report.subgroups.level.B1);
  assert.ok(report.subgroups.device.mobile);
  assert.equal(report.perTask[1].exactAgreementRate, 1);
  assert.equal(report.perTaskGate.pass, true);
  assert.equal(report.metricsStatus, 'pass');
  assert.equal(report.releaseStatus, 'not_validated');
});

test('validated is impossible without two independent experts, resolved disagreement and signed versioned report', () => {
  const missingSecond = dataset();
  missingSecond.cases[0].expertRatings = [missingSecond.cases[0].expertRatings[0]];
  assert.equal(validateSpeakingCalibrationDataset(missingSecond).ok, false);

  const sameExpert = dataset();
  sameExpert.cases[0].expertRatings[1].reviewerPseudonym = sameExpert.cases[0].expertRatings[0].reviewerPseudonym;
  assert.equal(validateSpeakingCalibrationDataset(sameExpert).ok, false);

  const disagreement = dataset();
  disagreement.cases[0].expertRatings[1].total = 0;
  disagreement.cases[0].expertRatings[1].criticalError = !disagreement.cases[0].expertRatings[0].criticalError;
  assert.equal(validateSpeakingCalibrationDataset(disagreement).ok, false);

  const binaryDisagreement = dataset();
  binaryDisagreement.cases[0].expertRatings[1].total = 0;
  assert.equal(validateSpeakingCalibrationDataset(binaryDisagreement).ok, false);
  assert.match(
    validateSpeakingCalibrationDataset(binaryDisagreement).errors.join(' '),
    /adjudication/u,
    'any task 1 score disagreement requires a third expert',
  );

  const unsigned = buildSpeakingCalibrationReport(dataset(), { reportVersion: 'candidate-v1' });
  assert.equal(evaluateSpeakingCalibrationGate(unsigned).validated, false);
  assert.match(evaluateSpeakingCalibrationGate(unsigned).reasons.join(' '), /signed methodological approval/u);

  const signed = buildSpeakingCalibrationReport(dataset(), {
    reportVersion: 'candidate-v1',
    approval: {
      signedBy: 'methodologist-pseudonym',
      signedAt: '2026-08-06T12:00:00.000Z',
      statement: 'I approve this exact candidate and report digest.',
      reportDigest: unsigned.reportDigest,
      signatureReference: 'external-governance://speaking/candidate-v1/approval-001',
    },
  });
  assert.equal(evaluateSpeakingCalibrationGate(signed).validated, true);
  assert.equal(signed.releaseStatus, 'validated');

  const changed = dataset();
  changed.cases[0].runs[0].total = 0;
  const staleApproval = buildSpeakingCalibrationReport(changed, {
    reportVersion: 'candidate-v1',
    approval: signed.methodologicalApproval,
  });
  assert.notEqual(staleApproval.reportDigest, unsigned.reportDigest);
  assert.equal(staleApproval.releaseStatus, 'not_validated');
  assert.match(evaluateSpeakingCalibrationGate(staleApproval).reasons.join(' '), /exact report digest/u);
});

test('every threshold is fail-closed, including false positives, stability and subgroup degradation', () => {
  const input = dataset();
  input.cases[0].runs[0].total = 0;
  input.cases[0].runs[0].criticalError = !input.cases[0].expertRatings[0].criticalError;
  input.cases[0].runs[1].total = 10;
  for (const item of input.cases) {
    if (item.subgroup.locale === 'en-GB') item.runs[0].total = 0;
  }
  const report = buildSpeakingCalibrationReport(input, { reportVersion: 'failing-v1' });
  assert.equal(report.metricsStatus, 'fail');
  const gate = evaluateSpeakingCalibrationGate(report);
  assert.equal(gate.validated, false);
  assert.ok(gate.reasons.length > 0);
  assert.ok(report.subgroupGate.failures.length > 0);
});

test('dataset contract requires consent provenance and unique learner coverage', () => {
  const input = dataset();
  delete input.cases[0].consent.grantedAt;
  input.cases[1].learnerPseudonym = input.cases[0].learnerPseudonym;
  const result = validateSpeakingCalibrationDataset(input);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /consent/u);
  assert.match(result.errors.join(' '), /learnerPseudonym/u);
});

test('guardian confirmation is required only for minors and timestamps are canonical UTC', () => {
  const input = dataset();
  const adult = input.cases.find((item) => item.participantAgeGroup === 'adult');
  adult.consent.guardianConfirmed = false;
  assert.equal(validateSpeakingCalibrationDataset(input).ok, true);
  adult.consent.guardianConfirmed = true;
  assert.match(validateSpeakingCalibrationDataset(input).errors.join(' '), /applicable guardian/u);

  const nonCanonical = dataset();
  nonCanonical.cases[0].consent.grantedAt = '1';
  assert.match(validateSpeakingCalibrationDataset(nonCanonical).errors.join(' '), /consent/u);
});

test('every task must cover every level, locale, device and environment subgroup', () => {
  const confounded = dataset();
  for (const item of confounded.cases) item.subgroup.level = ['B1', 'B2', 'B2+', 'C1'][item.taskType - 1];
  const result = validateSpeakingCalibrationDataset(confounded);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /task 1\.level\.B2/u);
});

test('a fully inverted task 1 scorer fails even when tasks 2–4 are perfect', () => {
  const input = dataset();
  for (const item of input.cases.filter((candidateCase) => candidateCase.taskType === 1)) {
    const expected = item.expertRatings[0].total;
    item.runs = item.runs.map((run) => ({ ...run, total: expected === 1 ? 0 : 1 }));
  }
  const report = buildSpeakingCalibrationReport(input, { reportVersion: 'task1-inverted-v1' });
  assert.equal(report.perTask[1].exactAgreementRate, 0);
  assert.equal(report.perTaskGate.pass, false);
  assert.equal(report.metricsStatus, 'fail');
  assert.match(report.perTaskGate.failures.join(' '), /task 1/u);
});

test('report digests use canonical key ordering but still change with values', () => {
  const input = dataset();
  const reverseKeys = (value) => {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  };
  const reordered = reverseKeys(input);
  const first = buildSpeakingCalibrationReport(input, { reportVersion: 'canonical-v1' });
  const second = buildSpeakingCalibrationReport(reordered, { reportVersion: 'canonical-v1' });
  assert.equal(second.reportDigest, first.reportDigest);
  reordered.cases[0].runs[0].total = 0;
  const changed = buildSpeakingCalibrationReport(reordered, { reportVersion: 'canonical-v1' });
  assert.notEqual(changed.reportDigest, first.reportDigest);
});

test('approved digest binds every trusted gate field and cannot be promoted by mutation', () => {
  const invalid = buildSpeakingCalibrationReport({
    schemaVersion: 'speaking-calibration-dataset-v1', candidate, cases: [],
  }, { reportVersion: 'invalid-v1' });
  const forged = structuredClone(invalid);
  forged.metricsStatus = 'pass';
  forged.expertGate.pass = true;
  forged.perTaskGate.pass = true;
  forged.subgroupGate.pass = true;
  forged.methodologicalApproval = {
    signedBy: 'methodologist', signedAt: '2026-08-06T12:00:00.000Z', statement: 'approve',
    reportDigest: invalid.reportDigest, signatureReference: 'external://invalid',
  };
  const result = evaluateSpeakingCalibrationGate(forged);
  assert.equal(result.validated, false);
  assert.match(result.reasons.join(' '), /canonical report content/u);
});
