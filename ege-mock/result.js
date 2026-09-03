import { AUTOMATIC_ASSESSMENT_WARNING } from '../shared/automatic-assessment-contract.js';
import {
  EGE_MOCK_FORECAST_POLICY,
  EGE_MOCK_RESULT_HISTORY_LIMIT,
  EGE_MOCK_RESULT_PRIMARY_MAXIMUM,
  EGE_MOCK_RESULT_RECOMMENDATION_DEFINITIONS,
  EGE_MOCK_RESULT_SCHEMA_VERSION,
  EGE_MOCK_RESULT_SECTION_MATRIX,
  EGE_MOCK_RESULT_SPEAKING_REVIEW_DEFINITIONS,
  egeMockForecastScore,
  egeMockResultSkillForPosition,
} from '../shared/ege-mock-result-contract.js';

import { normalizeEgeMockAnswer } from './assessment.js';
import { egeMockSpeakingResultPublicDto } from './speaking-assessment.js';
import { egeMockWritingResultPublicDto } from './writing-assessment.js';

export { EGE_MOCK_RESULT_SCHEMA_VERSION } from '../shared/ege-mock-result-contract.js';
export const EGE_MOCK_FORECAST_POLICY_ID = EGE_MOCK_FORECAST_POLICY.id;

function scoreFromRule(item, correctCount) {
  const rule = item.assessment.scoreRule;
  if (rule.kind === 'all_or_nothing') return correctCount === 1 ? item.maxScore : 0;
  const band = rule.bands.find(([minimum]) => correctCount >= minimum);
  return band ? Number(band[1]) : 0;
}

function hasLearnerResponse(value) {
  if (Array.isArray(value)) return value.length > 0
    && value.every((entry) => typeof entry === 'string' && entry.trim() !== '');
  return typeof value === 'string' ? value.trim() !== '' : value != null;
}

function createdAtMillis(value) {
  const timestamp = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function newestAttemptFirst(left, right) {
  const leftTime = createdAtMillis(left?.created_at);
  const rightTime = createdAtMillis(right?.created_at);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(right?.id ?? '').localeCompare(String(left?.id ?? ''));
}

function oldestAttemptFirst(left, right) {
  return newestAttemptFirst(right, left);
}

function objectiveItemResult(row, form, item) {
  const learnerAnswer = Object.hasOwn(row.draft || {}, String(item.position))
    ? structuredClone(row.draft[String(item.position)]) : null;
  let normalized = null;
  if (learnerAnswer != null) {
    try {
      normalized = normalizeEgeMockAnswer({
        formId: form.id, formRevision: form.revision,
        position: item.position, value: learnerAnswer,
        allowIncomplete: true,
      });
    } catch {
      normalized = null;
    }
  }
  const correctCount = Number(normalized?.correctCount || 0);
  const score = scoreFromRule(item, correctCount);
  return {
    position: item.position,
    section: item.section,
    status: 'completed',
    scoreKind: 'exact',
    score,
    maximum: item.maxScore,
    correct: score === item.maxScore,
    learnerAnswer,
    responseState: hasLearnerResponse(learnerAnswer) ? 'provided' : 'blank',
    correctAnswer: structuredClone(item.assessment.type === 'ordered_choice_list'
      ? item.assessment.accepted : item.assessment.accepted[0]),
    contentRef: structuredClone(item.contentRef),
  };
}

function hiddenSubjectiveResponseState(row, position) {
  if (position <= 38) {
    return hasLearnerResponse(row.draft?.[String(position)]) ? 'submitted_hidden' : 'blank';
  }
  const entries = row.oral_recordings?.[String(position)]?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return 'blank';
  if (entries.some(({ status }) => status === 'completed')) return 'submitted_hidden';
  return entries.some(({ status }) => status === 'technical_issue') ? 'technical' : 'blank';
}

function speakingSafeReview(item, assessment) {
  if (item.position < 39 || !Number.isInteger(assessment?.score)) return {};
  const definition = EGE_MOCK_RESULT_SPEAKING_REVIEW_DEFINITIONS[
    item.assessment.criteriaRef
  ];
  if (!definition || definition.maximum !== item.maxScore) {
    throw new TypeError('EGE_MOCK_RESULT_SPEAKING_REVIEW_INVALID');
  }
  return {
    criteria: [{ name: definition.name, got: assessment.score, max: definition.maximum }],
    feedback: {
      verdict: `Предварительная оценка: ${assessment.score} из ${definition.maximum}.`,
      nextStep: definition.nextStep,
    },
  };
}

function subjectiveItems(row, form, writing, speaking) {
  const writingByPosition = new Map(writing.items.map((item) => [Number(item.position), item]));
  const speakingByPosition = new Map(Object.values(speaking.items).map((item) => [Number(item.position), item]));
  return form.positions.filter(({ position }) => position >= 37).map((item) => {
    const assessment = item.position <= 38
      ? writingByPosition.get(item.position) : speakingByPosition.get(item.position);
    const authoredSpeakingReview = speakingSafeReview(item, assessment);
    return {
      position: item.position,
      section: item.section,
      status: assessment?.status || (item.position <= 38 ? writing.status : speaking.status),
      scoreKind: 'approximate',
      score: Number.isInteger(assessment?.score) ? assessment.score : null,
      maximum: item.maxScore,
      learnerAnswer: null,
      responseState: hiddenSubjectiveResponseState(row, item.position),
      correctAnswer: null,
      criteriaRef: item.assessment.criteriaRef,
      criteriaFingerprint: item.assessment.criteriaFingerprint,
      contentRef: structuredClone(item.contentRef),
      ...(assessment?.criteria
        ? { criteria: structuredClone(assessment.criteria) } : authoredSpeakingReview.criteria
          ? { criteria: structuredClone(authoredSpeakingReview.criteria) } : {}),
      ...(assessment?.feedback
        ? { feedback: structuredClone(assessment.feedback) } : authoredSpeakingReview.feedback
          ? { feedback: structuredClone(authoredSpeakingReview.feedback) } : {}),
      ...(Array.isArray(assessment?.evidence)
        ? { evidence: structuredClone(assessment.evidence) } : {}),
    };
  });
}

function recommendations(items) {
  const evidenceBySkill = new Map();
  for (const item of items) {
    const hasEvidence = item.score != null;
    if (!hasEvidence || item.score >= item.maximum) continue;
    const skillId = egeMockResultSkillForPosition(item.position);
    if (!skillId) continue;
    const current = evidenceBySkill.get(skillId) || {
      positions: [], provisional: false,
    };
    current.positions.push(item.position);
    current.provisional ||= item.scoreKind === 'approximate';
    evidenceBySkill.set(skillId, current);
  }
  return [...evidenceBySkill.entries()].map(([skillId, evidence]) => {
    const definition = EGE_MOCK_RESULT_RECOMMENDATION_DEFINITIONS[skillId];
    return {
      id: skillId,
      skillId,
      ...definition,
      evidencePositions: evidence.positions.sort((left, right) => left - right),
      evidenceKind: evidence.provisional ? 'provisional_low_score' : 'objective_error',
      masteryCredit: false,
    };
  });
}

export function buildEgeMockCanonicalResult(row, form) {
  if (!row || !form || row.form_id !== form.id || Number(row.form_revision) !== Number(form.revision)
    || row.catalog_fingerprint !== form.fingerprint || row.oral_submitted_at == null) {
    throw new TypeError('EGE_MOCK_RESULT_CONTEXT_INVALID');
  }
  const writing = egeMockWritingResultPublicDto(row);
  const speaking = egeMockSpeakingResultPublicDto(row);
  const objectiveItems = form.positions.filter(({ position }) => position <= 36)
    .map((item) => objectiveItemResult(row, form, item));
  const extendedItems = subjectiveItems(row, form, writing, speaking);
  const items = [...objectiveItems, ...extendedItems];
  const sections = EGE_MOCK_RESULT_SECTION_MATRIX.map(([id]) => {
    const section = form.sections.find((candidate) => candidate.id === id);
    const matching = items.filter((item) => item.section === id);
    const scoreKind = ['writing', 'speaking'].includes(id) ? 'approximate' : 'exact';
    const scored = matching.filter((item) => item.score != null);
    const complete = scored.length === matching.length;
    return {
      id,
      score: scored.length ? scored.reduce((total, item) => total + item.score, 0) : null,
      maximum: section.maxScore,
      scoreKind,
      status: complete ? 'completed'
        : id === 'writing' ? writing.status : id === 'speaking' ? speaking.status : 'completed',
    };
  });
  const objectivePrimary = sections.filter(({ scoreKind }) => scoreKind === 'exact')
    .reduce((total, section) => total + section.score, 0);
  const provisionalSections = sections.filter(({ scoreKind }) => scoreKind === 'approximate');
  const subjectiveResultItems = items.filter(({ scoreKind }) => scoreKind === 'approximate');
  const scoredSubjectiveItems = subjectiveResultItems.filter(({ score }) => score != null);
  const provisionalComplete = scoredSubjectiveItems.length === subjectiveResultItems.length;
  const scoredProvisional = scoredSubjectiveItems.reduce((total, item) => total + item.score, 0);
  const pendingMaximum = subjectiveResultItems.filter(({ score }) => score == null)
    .reduce((total, item) => total + item.maximum, 0);
  const minimum = objectivePrimary + scoredProvisional;
  const maximum = minimum + pendingMaximum;
  const diagnostic = row.mode === 'diagnostic';
  return {
    schemaVersion: EGE_MOCK_RESULT_SCHEMA_VERSION,
    attemptId: row.id,
    formId: row.form_id,
    formRevision: Number(row.form_revision),
    catalogFingerprint: row.catalog_fingerprint,
    mode: row.mode,
    attemptNumber: Number(row.attempt_number),
    label: diagnostic ? 'Диагностический' : 'Тренировочный повтор',
    score: {
      objectivePrimary,
      provisionalSubjectivePrimary: scoredSubjectiveItems.length ? scoredProvisional : null,
      primaryTotal: provisionalComplete ? minimum : null,
      maximum: EGE_MOCK_RESULT_PRIMARY_MAXIMUM,
      range: { minimum, maximum },
    },
    sections,
    forecast: {
      policyId: EGE_MOCK_FORECAST_POLICY.id,
      label: EGE_MOCK_FORECAST_POLICY.label,
      score: diagnostic && provisionalComplete ? egeMockForecastScore(minimum) : null,
      range: diagnostic ? {
        minimum: egeMockForecastScore(minimum), maximum: egeMockForecastScore(maximum),
      } : null,
      disclaimer: EGE_MOCK_FORECAST_POLICY.disclaimer,
      baselineEligible: diagnostic,
    },
    assessmentWarning: AUTOMATIC_ASSESSMENT_WARNING,
    items,
    recommendations: recommendations(items),
    masteryCredit: false,
  };
}

export function buildEgeMockHistory(rows, formOrResolver, { includeAttemptId = null } = {}) {
  const resolveForm = (row) => (typeof formOrResolver === 'function'
    ? formOrResolver(row.form_id, row.form_revision) : formOrResolver);
  const eligible = (rows || []).filter((row) => row?.oral_submitted_at != null
    && ['assessment_pending', 'completed'].includes(row.state));
  const baseline = eligible.filter((row) => row.mode === 'diagnostic')
    .sort(oldestAttemptFirst)[0] || null;
  const included = eligible.find((row) => row.id === includeAttemptId) || null;
  const retained = new Map();
  for (const row of [baseline, included]) {
    if (row) retained.set(row.id, row);
  }
  for (const row of eligible.sort(newestAttemptFirst)) {
    if (retained.size >= EGE_MOCK_RESULT_HISTORY_LIMIT) break;
    retained.set(row.id, row);
  }
  const attempts = [...retained.values()].sort(newestAttemptFirst).map((row) => ({
    id: row.id,
    formId: row.form_id,
    formRevision: Number(row.form_revision),
    mode: row.mode,
    attemptNumber: Number(row.attempt_number),
    label: row.mode === 'diagnostic' ? 'Диагностический' : 'Тренировочный повтор',
    state: row.state,
    completedAt: row.oral_submitted_at,
    isBaseline: row.id === baseline?.id,
    replacesBaseline: false,
    result: buildEgeMockCanonicalResult(row, resolveForm(row)),
  }));
  return { baselineAttemptId: baseline?.id || null, attempts };
}

export function selectEgeMockHistoryRows(rows, { includeAttemptId = null } = {}) {
  const unique = new Map();
  const ordered = [...(rows || [])].sort(newestAttemptFirst);
  const eligible = ordered.filter((row) => row?.oral_submitted_at != null
    && ['assessment_pending', 'completed'].includes(row.state));
  for (const row of eligible.slice(0, EGE_MOCK_RESULT_HISTORY_LIMIT)) unique.set(row.id, row);
  const active = ordered.find((row) => row?.oral_submitted_at == null
    && !['expired', 'completed'].includes(row.state));
  if (active) unique.set(active.id, active);
  const baseline = [...(rows || [])].filter((row) => (
    row?.mode === 'diagnostic' && row.oral_submitted_at != null
  )).sort(oldestAttemptFirst)[0];
  if (baseline) unique.set(baseline.id, baseline);
  const included = ordered.find((row) => row.id === includeAttemptId
    && row.oral_submitted_at != null
    && ['assessment_pending', 'completed'].includes(row.state));
  if (included) unique.set(included.id, included);
  return [...unique.values()];
}

export function buildEgeMockDashboardSummary(history) {
  const attempts = Array.isArray(history?.attempts) ? history.attempts : [];
  const baseline = attempts.find(({ id }) => id === history?.baselineAttemptId) || null;
  return {
    baselineAttemptId: baseline?.id || null,
    displayedAttempts: attempts.length,
    baseline: baseline ? {
      attemptId: baseline.id,
      primaryTotal: baseline.result.score.primaryTotal,
      maximum: baseline.result.score.maximum,
      range: structuredClone(baseline.result.score.range),
      forecast: structuredClone(baseline.result.forecast),
    } : null,
  };
}

export function egeMockErrorFocusEntries(row, form) {
  if (row?.mode !== 'diagnostic' || row.oral_submitted_at == null) return [];
  return buildEgeMockCanonicalResult(row, form).recommendations.map((recommendation) => ({
    module: recommendation.module,
    itemKey: `ege-mock:${row.id}:${recommendation.skillId}`,
    errorType: 'ege_mock_diagnostic_weak_skill',
    details: {
      skill_id: recommendation.skillId,
      source_attempt_id: row.id,
      evidence_positions: recommendation.evidencePositions.join(','),
      evidence_kind: recommendation.evidenceKind,
      evidence_context: 'diagnostic_full_mock',
      mastery_credit: false,
    },
  }));
}

export function egeMockAdaptiveEvidenceAttempts(rows, formOrResolver) {
  const diagnostic = [...new Map((rows || [])
    .filter((row) => row?.mode === 'diagnostic' && row.oral_submitted_at != null
      && ['assessment_pending', 'completed'].includes(row.state))
    .map((row) => [row.id, row])).values()]
    .sort(oldestAttemptFirst)[0] || null;
  if (!diagnostic) return [];
  const form = typeof formOrResolver === 'function'
    ? formOrResolver(diagnostic.form_id, diagnostic.form_revision) : formOrResolver;
  const canonical = buildEgeMockCanonicalResult(diagnostic, form);
  const itemByPosition = new Map(canonical.items.map((item) => [item.position, item]));
  return canonical.recommendations.map((recommendation) => {
    const evidence = recommendation.evidencePositions.map((position) => itemByPosition.get(position));
    return {
      id: `ege-mock:${diagnostic.id}:${recommendation.skillId}`,
      module: recommendation.module,
      activity: recommendation.skillId,
      score: evidence.reduce((total, item) => total + item.score, 0),
      max_score: evidence.reduce((total, item) => total + item.maximum, 0),
      duration_ms: null,
      metadata: {
        skill_id: recommendation.skillId,
        source_attempt_id: diagnostic.id,
        ege_mock_attempt_id: diagnostic.id,
        evidence_positions: [...recommendation.evidencePositions],
        evidence_context: 'diagnostic_full_mock',
        mastery_credit: false,
      },
      evidence_quality: 'server_verified_assisted',
      created_at: diagnostic.oral_submitted_at,
    };
  });
}

export function refreshEgeMockStoredResult(row, form) {
  if (!row || row.oral_submitted_at == null
    || !['assessment_pending', 'completed'].includes(row.state)) return false;
  const canonical = buildEgeMockCanonicalResult(row, form);
  if (JSON.stringify(row.result) === JSON.stringify(canonical)) return false;
  row.result = canonical;
  return true;
}
