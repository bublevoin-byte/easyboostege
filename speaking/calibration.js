import crypto from 'node:crypto';

const TASK_MAXIMA = Object.freeze({ 1: 1, 2: 4, 3: 5, 4: 10 });
export const SPEAKING_CALIBRATION_THRESHOLDS = Object.freeze({
  structuralValidityRate: 1,
  meanAbsoluteError: 1,
  withinOneRate: 0.9,
  task1ExactAgreementRate: 0.9,
  criticalErrorRecall: 0.9,
  criticalErrorFalsePositiveRate: 0.1,
  stabilityWithinOneRate: 0.9,
  subgroupWithinOneGap: 0.1,
  subgroupMaeGap: 0.5,
});

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isTimestamp = (value) => isText(value)
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(new Date(value).getTime())
  && new Date(value).toISOString() === value;
const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;

function materialDisagreement(item, first, second) {
  return (item?.taskType === 1 ? first.total !== second.total : Math.abs(first.total - second.total) > 1)
    || first.criticalError !== second.criticalError;
}

function referenceFor(item) {
  if (!Array.isArray(item?.expertRatings) || item.expertRatings.length !== 2) return null;
  const [first, second] = item.expertRatings;
  if (!isObject(first) || !isObject(second)) return null;
  const material = materialDisagreement(item, first, second);
  if (material) return item.adjudication || null;
  return {
    total: (first.total + second.total) / 2,
    criticalError: first.criticalError || second.criticalError,
  };
}

function validateCandidate(candidate, errors) {
  const keys = ['catalogVersion', 'promptVersion', 'scoringVersion', 'acousticProviderVersion', 'semanticProviderVersion'];
  if (!isObject(candidate) || keys.some((key) => !isText(candidate[key]))) {
    errors.push('candidate: all version fields are required');
  }
}

function validRating(rating, maximum) {
  return isObject(rating) && isText(rating.reviewerPseudonym)
    && Number.isInteger(rating.total) && rating.total >= 0 && rating.total <= maximum
    && typeof rating.criticalError === 'boolean';
}

export function validateSpeakingCalibrationDataset(dataset, {
  minimumPerTask = 40,
  minimumSubgroupCases = 5,
} = {}) {
  const errors = [];
  const ids = new Set();
  const learners = new Set();
  const countsByTask = { 1: 0, 2: 0, 3: 0, 4: 0 };
  if (!isObject(dataset) || dataset.schemaVersion !== 'speaking-calibration-dataset-v1') {
    errors.push('schemaVersion: speaking-calibration-dataset-v1 is required');
  }
  validateCandidate(dataset?.candidate, errors);
  if (!Array.isArray(dataset?.cases)) errors.push('cases: an array is required');
  for (const [index, item] of (Array.isArray(dataset?.cases) ? dataset.cases : []).entries()) {
    const location = `cases[${index}]`;
    if (!isText(item?.id) || ids.has(item.id)) errors.push(`${location}.id: unique id is required`);
    else ids.add(item.id);
    if (!isText(item?.learnerPseudonym) || learners.has(item.learnerPseudonym)) {
      errors.push(`${location}.learnerPseudonym: unique pseudonym is required`);
    } else learners.add(item.learnerPseudonym);
    const maximum = TASK_MAXIMA[item?.taskType];
    if (!maximum) errors.push(`${location}.taskType: must be 1, 2, 3 or 4`);
    else countsByTask[item.taskType] += 1;
    const ageGroup = item?.participantAgeGroup;
    if (!['minor', 'adult'].includes(ageGroup)) {
      errors.push(`${location}.participantAgeGroup: minor or adult is required`);
    }
    const consent = item?.consent;
    if (!isObject(consent) || consent.kind !== 'speaking_calibration' || !isText(consent.version)
      || !isTimestamp(consent.grantedAt)
      || (ageGroup === 'minor' && consent.guardianConfirmed !== true)
      || (ageGroup === 'adult' && consent.guardianConfirmed === true)) {
      errors.push(`${location}.consent: versioned provenance and applicable guardian confirmation are required`);
    }
    const subgroup = item?.subgroup;
    if (!isObject(subgroup) || !['en-GB', 'en-US'].includes(subgroup.locale)
      || !['B1', 'B2', 'B2+', 'C1'].includes(subgroup.level)
      || !['mobile', 'desktop'].includes(subgroup.device)
      || !['quiet', 'ordinary_noise'].includes(subgroup.environment)) {
      errors.push(`${location}.subgroup: supported locale, device and environment are required`);
    }
    if (!Array.isArray(item?.expertRatings) || item.expertRatings.length !== 2
      || item.expertRatings.some((rating) => !validRating(rating, maximum))) {
      errors.push(`${location}.expertRatings: exactly two complete ratings are required`);
    } else {
      const [first, second] = item.expertRatings;
      if (first.reviewerPseudonym === second.reviewerPseudonym) {
        errors.push(`${location}.expertRatings: two independent experts are required`);
      }
      const material = materialDisagreement(item, first, second);
      if (material && (!validRating(item.adjudication, maximum)
        || [first.reviewerPseudonym, second.reviewerPseudonym].includes(item.adjudication.reviewerPseudonym))) {
        errors.push(`${location}.adjudication: an independent third expert must resolve material disagreement`);
      }
    }
    if (!Array.isArray(item?.runs) || item.runs.length < 2
      || item.runs.some((run) => !isText(run?.runId) || !Number.isInteger(run.total)
        || run.total < 0 || run.total > maximum || typeof run.criticalError !== 'boolean')
      || new Set((item?.runs || []).map((run) => run.runId)).size !== item?.runs?.length) {
      errors.push(`${location}.runs: at least two unique bounded runs are required`);
    }
  }
  for (const [taskType, count] of Object.entries(countsByTask)) {
    if (count < minimumPerTask) errors.push(`task ${taskType}: requires ${minimumPerTask} cases, found ${count}`);
  }
  for (const dimension of ['locale', 'level', 'device', 'environment']) {
    const groups = new Map();
    for (const item of dataset?.cases || []) {
      const value = item?.subgroup?.[dimension];
      if (value) groups.set(value, (groups.get(value) || 0) + 1);
    }
    if (groups.size < 2) errors.push(`${dimension}: at least two subgroups are required`);
    for (const [value, count] of groups) {
      if (count < minimumSubgroupCases) errors.push(`${dimension}.${value}: requires ${minimumSubgroupCases} cases, found ${count}`);
    }
  }
  const expectedValues = {
    locale: ['en-GB', 'en-US'],
    level: ['B1', 'B2', 'B2+', 'C1'],
    device: ['mobile', 'desktop'],
    environment: ['quiet', 'ordinary_noise'],
  };
  for (const taskType of [1, 2, 3, 4]) {
    const taskCases = (dataset?.cases || []).filter((item) => item?.taskType === taskType);
    for (const [dimension, values] of Object.entries(expectedValues)) {
      for (const value of values) {
        const count = taskCases.filter((item) => item?.subgroup?.[dimension] === value).length;
        if (count < minimumSubgroupCases) {
          errors.push(`task ${taskType}.${dimension}.${value}: requires ${minimumSubgroupCases} cases, found ${count}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, countsByTask };
}

function canonicalMeasurements(dataset) {
  return dataset.cases.map((item) => ({
    item,
    reference: referenceFor(item),
    run: Array.isArray(item?.runs) ? item.runs[0] : null,
  }))
    .filter(({ reference, run }) => reference && run);
}

function metricsFor(measurements, allCases = measurements.map(({ item }) => item)) {
  const absolute = measurements.map(({ reference, run }) => Math.abs(run.total - reference.total));
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const { reference, run } of measurements.filter(({ item }) => item.taskType === 1)) {
    if (reference.criticalError && run.criticalError) truePositive += 1;
    else if (!reference.criticalError && run.criticalError) falsePositive += 1;
    else if (reference.criticalError) falseNegative += 1;
    else trueNegative += 1;
  }
  const stable = allCases.filter((item) => {
    const totals = (Array.isArray(item?.runs) ? item.runs : []).map((run) => run.total)
      .filter(Number.isFinite);
    return totals.length >= 2 && Math.max(...totals) - Math.min(...totals) <= 1;
  }).length;
  return {
    meanAbsoluteError: absolute.length ? absolute.reduce((sum, value) => sum + value, 0) / absolute.length : null,
    withinOneRate: ratio(absolute.filter((value) => value <= 1).length, absolute.length),
    exactAgreementRate: ratio(absolute.filter((value) => value === 0).length, absolute.length),
    criticalErrorRecall: ratio(truePositive, truePositive + falseNegative),
    criticalErrorFalsePositiveRate: ratio(falsePositive, falsePositive + trueNegative),
    stabilityWithinOneRate: ratio(stable, allCases.length),
  };
}

function subgroupReport(dataset, overall) {
  const dimensions = {};
  const failures = [];
  const measurements = canonicalMeasurements(dataset);
  for (const dimension of ['locale', 'level', 'device', 'environment']) {
    dimensions[dimension] = {};
    const values = [...new Set(dataset.cases.map((item) => item?.subgroup?.[dimension]).filter(Boolean))].sort();
    for (const value of values) {
      const subset = measurements.filter(({ item }) => item?.subgroup?.[dimension] === value);
      const groupCases = dataset.cases.filter((item) => item?.subgroup?.[dimension] === value);
      const metrics = metricsFor(subset, groupCases);
      dimensions[dimension][value] = { cases: groupCases.length, ...metrics };
      if (metrics.withinOneRate === null || metrics.withinOneRate + SPEAKING_CALIBRATION_THRESHOLDS.subgroupWithinOneGap < overall.withinOneRate
        || metrics.meanAbsoluteError === null || metrics.meanAbsoluteError > overall.meanAbsoluteError + SPEAKING_CALIBRATION_THRESHOLDS.subgroupMaeGap) {
        failures.push(`${dimension}.${value}: product-significant accuracy degradation`);
      }
    }
  }
  return { dimensions, failures };
}

function perTaskReport(dataset) {
  const dimensions = {};
  const failures = [];
  const measurements = canonicalMeasurements(dataset);
  for (const taskType of [1, 2, 3, 4]) {
    const subset = measurements.filter(({ item }) => item.taskType === taskType);
    const taskCases = dataset.cases.filter((item) => item?.taskType === taskType);
    const metrics = metricsFor(subset, taskCases);
    dimensions[taskType] = { cases: taskCases.length, ...metrics };
    if (!Number.isFinite(metrics.meanAbsoluteError)
      || metrics.meanAbsoluteError > SPEAKING_CALIBRATION_THRESHOLDS.meanAbsoluteError
      || !Number.isFinite(metrics.withinOneRate)
      || metrics.withinOneRate < SPEAKING_CALIBRATION_THRESHOLDS.withinOneRate
      || !Number.isFinite(metrics.stabilityWithinOneRate)
      || metrics.stabilityWithinOneRate < SPEAKING_CALIBRATION_THRESHOLDS.stabilityWithinOneRate
      || (taskType === 1 && (!Number.isFinite(metrics.exactAgreementRate)
        || metrics.exactAgreementRate < SPEAKING_CALIBRATION_THRESHOLDS.task1ExactAgreementRate))) {
      failures.push(`task ${taskType}: score metrics do not meet the release thresholds`);
    }
  }
  return { dimensions, failures };
}

function metricsPass(metrics) {
  return metrics.structuralValidityRate === 1
    && Number.isFinite(metrics.meanAbsoluteError) && metrics.meanAbsoluteError <= SPEAKING_CALIBRATION_THRESHOLDS.meanAbsoluteError
    && Number.isFinite(metrics.withinOneRate) && metrics.withinOneRate >= SPEAKING_CALIBRATION_THRESHOLDS.withinOneRate
    && Number.isFinite(metrics.criticalErrorRecall) && metrics.criticalErrorRecall >= SPEAKING_CALIBRATION_THRESHOLDS.criticalErrorRecall
    && Number.isFinite(metrics.criticalErrorFalsePositiveRate)
    && metrics.criticalErrorFalsePositiveRate <= SPEAKING_CALIBRATION_THRESHOLDS.criticalErrorFalsePositiveRate
    && Number.isFinite(metrics.stabilityWithinOneRate)
    && metrics.stabilityWithinOneRate >= SPEAKING_CALIBRATION_THRESHOLDS.stabilityWithinOneRate;
}

function reportDigest(value) {
  const canonical = (input) => {
    if (Array.isArray(input)) return input.map(canonical);
    if (!isObject(input)) return input;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function approvalValid(report) {
  const approval = report?.methodologicalApproval;
  return isObject(approval) && isText(approval.signedBy) && isTimestamp(approval.signedAt)
    && isText(approval.statement) && isText(approval.signatureReference)
    && approval.signatureReference.length <= 500
    && approval.reportDigest === report.reportDigest;
}

function calibrationReportDigestPayload(report) {
  return {
    schemaVersion: report?.schemaVersion,
    reportVersion: report?.reportVersion,
    candidate: report?.candidate,
    datasetDigest: report?.datasetDigest,
    metrics: report?.metrics,
    perTask: report?.perTask,
    subgroups: report?.subgroups,
    thresholds: report?.thresholds,
    validationErrors: report?.validationErrors,
    metricsStatus: report?.metricsStatus,
    expertGate: report?.expertGate,
    perTaskGate: report?.perTaskGate,
    subgroupGate: report?.subgroupGate,
  };
}

export function evaluateSpeakingCalibrationGate(report) {
  const reasons = [];
  if (report?.schemaVersion !== 'speaking-calibration-report-v1' || !isText(report?.reportVersion)) {
    reasons.push('a versioned calibration report is required');
  }
  if (report?.metricsStatus !== 'pass') reasons.push('all quantitative thresholds must pass');
  if (report?.perTaskGate?.pass !== true) reasons.push('every speaking task must pass its score thresholds');
  if (report?.expertGate?.pass !== true) reasons.push('two independent expert ratings are required for every case');
  if (report?.subgroupGate?.pass !== true) reasons.push('subgroup gate must pass');
  const expectedDigest = reportDigest(calibrationReportDigestPayload(report));
  if (report?.reportDigest !== expectedDigest) reasons.push('report digest must match the canonical report content');
  if (!approvalValid(report)) reasons.push('signed methodological approval for the exact report digest is required');
  return { validated: reasons.length === 0, reasons };
}

export function buildSpeakingCalibrationReport(dataset, {
  reportVersion,
  approval = null,
  minimumPerTask = 40,
  minimumSubgroupCases = 5,
} = {}) {
  const safeDataset = isObject(dataset)
    ? { ...dataset, cases: Array.isArray(dataset.cases) ? dataset.cases : [] }
    : { schemaVersion: null, candidate: null, cases: [] };
  const validation = validateSpeakingCalibrationDataset(safeDataset, { minimumPerTask, minimumSubgroupCases });
  const baseMetrics = metricsFor(canonicalMeasurements(safeDataset), safeDataset.cases);
  const metrics = {
    structuralValidityRate: validation.ok ? 1 : 0,
    ...baseMetrics,
  };
  const subgroup = subgroupReport(safeDataset, metrics);
  const perTask = perTaskReport(safeDataset);
  const metricsStatus = metricsPass(metrics) && subgroup.failures.length === 0
    && perTask.failures.length === 0 ? 'pass' : 'fail';
  const report = {
    schemaVersion: 'speaking-calibration-report-v1',
    reportVersion,
    candidate: safeDataset.candidate,
    datasetDigest: reportDigest(safeDataset),
    metrics,
    perTask: perTask.dimensions,
    subgroups: subgroup.dimensions,
    thresholds: SPEAKING_CALIBRATION_THRESHOLDS,
    validationErrors: validation.errors,
    metricsStatus,
    expertGate: { pass: validation.ok, cases: safeDataset.cases.length },
    perTaskGate: { pass: validation.ok && perTask.failures.length === 0, failures: perTask.failures },
    subgroupGate: { pass: validation.ok && subgroup.failures.length === 0, failures: subgroup.failures },
    reportDigest: null,
    methodologicalApproval: approval ? { ...approval } : null,
    releaseStatus: 'not_validated',
  };
  report.reportDigest = reportDigest(calibrationReportDigestPayload(report));
  const gate = evaluateSpeakingCalibrationGate(report);
  report.releaseStatus = gate.validated ? 'validated' : 'not_validated';
  return report;
}
