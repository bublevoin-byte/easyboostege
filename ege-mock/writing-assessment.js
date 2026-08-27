import crypto from 'node:crypto';

import {
  getWritingRules, parseStoredWritingReview, prepareWritingEvaluation, WRITING_PROMPT_VERSION,
} from '../ai/writing.js';
import { sanitizeStudentText } from '../validation/student-text.js';
import { resolveEgeMockCriteriaRef } from './criteria.js';
import {
  AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
  EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
  EGE_MOCK_WRITING_ASSESSMENT_LABEL,
} from '../shared/automatic-assessment-contract.js';
import { sameSemanticJsonValue } from '../shared/semantic-json.js';
import { reconcileEgeMockSubjectiveAssessmentState } from './speaking-assessment.js';

export const EGE_MOCK_WRITING_ASSESSMENT_VERSION = 'ege-mock-writing-assessment-v1';
export const EGE_MOCK_WRITING_ASSESSMENT_LEASE_MS = 5 * 60 * 1000;

const WRITING_POSITIONS = Object.freeze([37, 38]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export { EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING };

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw failure('EGE_MOCK_TIME_INVALID');
  return date.toISOString();
}

function taskType(position) {
  return `writing_${position}`;
}

function provenanceValue(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^[a-z0-9][a-z0-9._:/-]{0,79}$/iu.test(normalized)) {
    throw failure('EGE_MOCK_WRITING_PROVENANCE_INVALID');
  }
  return normalized;
}

function publicState(value) {
  const status = value?.status || 'not_started';
  return {
    status, assessmentRevision: egeMockWritingAssessmentRevision(value),
    ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
    label: EGE_MOCK_WRITING_ASSESSMENT_LABEL,
    retryAllowed: ['retryable', 'ambiguous'].includes(status) && Number(value?.retry_count) < 3,
    retryCount: Number(value?.retry_count) || 0,
    ...(value?.run_disposition === 'subscription_required'
      ? { runDisposition: 'subscription_required' } : {}),
    ...(status === 'ambiguous'
      ? { retryWarning: EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING } : {}),
  };
}

export function egeMockWritingAssessmentRevision(value) {
  if (value?.assessment_revision == null) return 0;
  const revision = Number(value?.assessment_revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_STATE_INVALID');
  }
  return revision;
}

export function nextEgeMockWritingAssessmentRevision(assessment) {
  const revision = egeMockWritingAssessmentRevision(assessment);
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw failure('ASSESSMENT_REVISION_EXHAUSTED');
  }
  return revision + 1;
}

export function assertEgeMockWritingAssessmentRevisionAvailable(assessment) {
  nextEgeMockWritingAssessmentRevision(assessment);
}

export function advanceEgeMockWritingAssessmentRevision(assessment) {
  if (!assessment || typeof assessment !== 'object') {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_STATE_INVALID');
  }
  assessment.assessment_revision = nextEgeMockWritingAssessmentRevision(assessment);
  return assessment.assessment_revision;
}

export function egeMockWritingAssessmentPublicDto(row) {
  return publicState(row?.writing_assessment);
}

export function beginEgeMockWritingAssessment(row, now) {
  if (row.writing_assessment?.status && row.writing_assessment.status !== 'not_started') return row;
  row.writing_assessment = {
    version: EGE_MOCK_WRITING_ASSESSMENT_VERSION,
    assessment_revision: 1,
    status: 'pending',
    score_kind: 'provisional',
    retry_count: 0,
    claim_token: null,
    claim_expires_at: null,
    authorization: null,
    items: null,
    updated_at: iso(now),
  };
  return row;
}

function assessmentItem(row, form, position) {
  const item = form.positions[position - 1];
  if (item?.position !== position || item.section !== 'writing'
    || item.assessment?.type !== 'provisional') {
    throw failure('EGE_MOCK_WRITING_FORM_INVALID');
  }
  const criteria = resolveEgeMockCriteriaRef(item.assessment.criteriaRef);
  const rules = getWritingRules(taskType(position));
  if (!criteria || criteria.fingerprint !== item.assessment.criteriaFingerprint
    || criteria.maxScore !== item.maxScore || rules?.overallMax !== item.maxScore) {
    throw failure('EGE_MOCK_WRITING_FORM_INVALID');
  }
  const fullAnswer = sanitizeStudentText(row.draft?.[String(position)] ?? '');
  const evaluation = prepareWritingEvaluation({
    taskType: taskType(position), answer: fullAnswer, assignment: item.presentation,
  });
  return {
    position,
    task_type: taskType(position),
    task_id: item.contentRef.id,
    form_ref: {
      id: form.id,
      revision: Number(form.revision),
      fingerprint: form.fingerprint,
    },
    content_ref: structuredClone(item.contentRef),
    assignment: structuredClone(item.presentation),
    criteria_ref: item.assessment.criteriaRef,
    criteria_fingerprint: item.assessment.criteriaFingerprint,
    criteria_snapshot: rules.criteria.map(([name, maximum]) => ({ name, maximum })),
    maximum: item.maxScore,
    prompt_version: WRITING_PROMPT_VERSION,
    full_answer: fullAnswer,
    evaluated_answer: evaluation.evaluatedAnswer,
    scope: structuredClone(evaluation.scope),
    status: 'pending',
    outcome: null,
    abandoned_outcomes: [],
    review: null,
    provenance: null,
    error_code: null,
  };
}

function workItem(item, retryCount) {
  return {
    position: item.position,
    taskType: item.task_type,
    taskId: item.task_id,
    formRef: structuredClone(item.form_ref),
    contentRef: structuredClone(item.content_ref),
    assignment: structuredClone(item.assignment),
    criteriaRef: item.criteria_ref,
    criteriaFingerprint: item.criteria_fingerprint,
    criteriaSnapshot: structuredClone(item.criteria_snapshot),
    maximum: item.maximum,
    promptVersion: item.prompt_version,
    fullAnswer: item.full_answer,
    evaluatedAnswer: item.evaluated_answer,
    scope: structuredClone(item.scope),
    retryCount: Number(retryCount) || 0,
    outcome: item.outcome == null ? null : structuredClone(item.outcome),
  };
}

function assertAssessmentItemsCurrent(row, form, items) {
  const expected = WRITING_POSITIONS.map((position) => assessmentItem(row, form, position));
  const boundFields = [
    'position', 'task_type', 'task_id', 'form_ref', 'content_ref', 'assignment',
    'criteria_ref', 'criteria_fingerprint', 'criteria_snapshot', 'maximum', 'prompt_version',
    'full_answer', 'evaluated_answer', 'scope',
  ];
  if (!Array.isArray(items) || items.length !== expected.length
    || expected.some((candidate, index) => boundFields.some((field) => (
      !sameSemanticJsonValue(items[index]?.[field], candidate[field])
    )))) {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONTEXT_INVALID');
  }
}

function storedAuthorization(value) {
  const authorizedAt = iso(value?.authorized_at);
  const subscriptionExpiresAt = iso(value?.subscription_expires_at);
  const policy = value?.consent_policy_version == null
    ? null : String(value.consent_policy_version).trim();
  if (Date.parse(subscriptionExpiresAt) <= Date.parse(authorizedAt)
    || typeof value?.text_processing_consent !== 'boolean'
    || (policy != null && (!policy || policy.length > 120))) {
    throw failure('EGE_MOCK_WRITING_AUTHORIZATION_INVALID');
  }
  return {
    authorized_at: authorizedAt,
    subscription_expires_at: subscriptionExpiresAt,
    text_processing_consent: value.text_processing_consent,
    consent_policy_version: policy,
  };
}

function initialAuthorization(value, instant) {
  const stored = storedAuthorization({
    authorized_at: instant,
    subscription_expires_at: value?.subscriptionExpiresAt,
    text_processing_consent: value?.textProcessingConsent,
    consent_policy_version: value?.consentPolicyVersion,
  });
  if (Date.parse(stored.subscription_expires_at) <= instant.getTime()) {
    throw failure('SUBSCRIPTION_REQUIRED');
  }
  return stored;
}

function workAuthorization(value) {
  const stored = storedAuthorization(value);
  return {
    authorizedAt: stored.authorized_at,
    subscriptionExpiresAt: stored.subscription_expires_at,
    textProcessingConsent: stored.text_processing_consent,
    consentPolicyVersion: stored.consent_policy_version,
  };
}

export function applyEgeMockWritingAssessmentClaim(row, {
  form, claimToken, authorization = null, now,
}) {
  const token = String(claimToken || '');
  if (!UUID_V4.test(token)) {
    throw failure('EGE_MOCK_WRITING_CLAIM_INVALID');
  }
  if (!['oral_ready', 'oral_in_progress', 'assessment_pending', 'completed'].includes(row.state)) {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_NOT_READY');
  }
  if (!form || form.id !== row.form_id || Number(form.revision) !== Number(row.form_revision)
    || form.fingerprint !== row.catalog_fingerprint) {
    throw failure('EGE_MOCK_FORM_UNAVAILABLE');
  }
  beginEgeMockWritingAssessment(row, row.written_submitted_at || now);
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw failure('EGE_MOCK_TIME_INVALID');
  const assessment = row.writing_assessment;
  const expiredClaim = assessment.status === 'in_progress'
    && Number.isFinite(Date.parse(assessment.claim_expires_at))
    && Date.parse(assessment.claim_expires_at) <= instant.getTime();
  if (assessment.status !== 'pending' && !expiredClaim) {
    return { claimed: false, status: assessment.status, attempt: egeMockWritingAssessmentPublicDto(row) };
  }
  const nextRevision = nextEgeMockWritingAssessmentRevision(assessment);
  if (expiredClaim) {
    assessment.status = 'pending';
    assessment.claim_token = null;
    assessment.claim_expires_at = null;
  }
  assessment.authorization = assessment.authorization
    ? storedAuthorization(assessment.authorization) : initialAuthorization(authorization, instant);
  if (assessment.items) assertAssessmentItemsCurrent(row, form, assessment.items);
  else assessment.items = WRITING_POSITIONS.map((position) => assessmentItem(row, form, position));
  assessment.status = 'in_progress';
  assessment.claim_token = token;
  assessment.claim_expires_at = iso(instant.getTime() + EGE_MOCK_WRITING_ASSESSMENT_LEASE_MS);
  assessment.updated_at = instant.toISOString();
  assessment.assessment_revision = nextRevision;
  row.updated_at = instant.toISOString();
  return {
    claimed: true,
    status: assessment.status,
    work: {
      version: EGE_MOCK_WRITING_ASSESSMENT_VERSION,
      attemptId: row.id,
      ownerGeneration: row.owner_generation,
      formId: row.form_id,
      formRevision: Number(row.form_revision),
      catalogFingerprint: row.catalog_fingerprint,
      claimToken: token,
      retryCount: Number(assessment.retry_count) || 0,
      authorization: workAuthorization(assessment.authorization),
      items: assessment.items.filter((item) => item.status === 'pending')
        .map((item) => workItem(item, assessment.retry_count)),
    },
  };
}

export function applyEgeMockWritingAssessmentClaimRenewal(row, { claimToken, now }) {
  const token = String(claimToken || '');
  if (!UUID_V4.test(token)) throw failure('EGE_MOCK_WRITING_CLAIM_INVALID');
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw failure('EGE_MOCK_TIME_INVALID');
  const assessment = row.writing_assessment;
  if (assessment?.status !== 'in_progress' || assessment.claim_token !== token) {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONFLICT');
  }
  const nextRevision = nextEgeMockWritingAssessmentRevision(assessment);
  assessment.claim_expires_at = iso(instant.getTime() + EGE_MOCK_WRITING_ASSESSMENT_LEASE_MS);
  assessment.updated_at = instant.toISOString();
  assessment.assessment_revision = nextRevision;
  row.updated_at = instant.toISOString();
  return { renewed: true, claimExpiresAt: assessment.claim_expires_at };
}

function exactReview(item, review) {
  const validated = parseStoredWritingReview(review, {
    taskType: item.task_type,
    assignment: item.assignment,
    answer: item.full_answer,
    criteriaSnapshot: item.criteria_snapshot,
  }, item.prompt_version);
  if (validated.overall_max !== item.maximum
    || validated.criteria.length !== item.criteria_snapshot.length
    || validated.criteria.some((criterion, index) => (
      criterion.name !== item.criteria_snapshot[index].name
        || criterion.max !== item.criteria_snapshot[index].maximum
    ))) throw failure('EGE_MOCK_WRITING_REVIEW_INVALID');
  return structuredClone(validated);
}

export function createEgeMockWritingAssessmentBinding(item) {
  const task = item?.taskType ?? item?.task_type;
  const expectedCriteria = task === 'writing_37' ? 3 : task === 'writing_38' ? 5 : 0;
  const expected = {
    assignment: item?.assignment,
    contentRef: item?.contentRef ?? item?.content_ref,
    criteriaRef: item?.criteriaRef ?? item?.criteria_ref,
    criteriaFingerprint: item?.criteriaFingerprint ?? item?.criteria_fingerprint,
    criteriaSnapshot: item?.criteriaSnapshot ?? item?.criteria_snapshot,
    formRef: item?.formRef ?? item?.form_ref,
  };
  const fingerprint = /^sha256:[a-f0-9]{64}$/u;
  if (!expected.assignment || typeof expected.assignment !== 'object'
    || !expected.formRef || typeof expected.formRef.id !== 'string'
    || !Number.isInteger(expected.formRef.revision) || expected.formRef.revision < 1
    || !fingerprint.test(expected.formRef.fingerprint)
    || !expected.contentRef || typeof expected.contentRef.id !== 'string'
    || !Number.isInteger(expected.contentRef.revision) || expected.contentRef.revision < 1
    || typeof expected.criteriaRef !== 'string' || !expected.criteriaRef
    || !fingerprint.test(expected.criteriaFingerprint)
    || !Array.isArray(expected.criteriaSnapshot)
    || expected.criteriaSnapshot.length !== expectedCriteria) {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONTEXT_INVALID');
  }
  return structuredClone(expected);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function egeMockWritingAssessmentContextFingerprint(item) {
  const binding = createEgeMockWritingAssessmentBinding(item);
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(binding)).digest('hex')}`;
}

function exactItemBinding(item, value) {
  const expected = createEgeMockWritingAssessmentBinding(item);
  if (!value || Object.keys(value).sort().join(',')
      !== 'assignment,contentRef,criteriaFingerprint,criteriaRef,criteriaSnapshot,formRef'
    || !sameSemanticJsonValue(value, expected)) {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONTEXT_INVALID');
  }
  return structuredClone(expected);
}

function requirePendingClaim(row, claimToken, position) {
  const assessment = row.writing_assessment;
  const item = assessment?.items?.find((candidate) => candidate.position === Number(position));
  if (!item) throw failure('EGE_MOCK_WRITING_ASSESSMENT_STATE_INVALID');
  if (assessment.status !== 'in_progress' || assessment.claim_token !== claimToken
    || item.status !== 'pending') {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONFLICT');
  }
  return { assessment, item };
}

function optionalOutcomeInteger(candidate, maximum = 10_000_000) {
  if (candidate == null) return null;
  if (!Number.isInteger(candidate) || candidate < 0 || candidate > maximum) {
    throw failure('EGE_MOCK_WRITING_OUTCOME_INVALID');
  }
  return candidate;
}

function normalizedCall(value) {
  const claimId = String(value?.claimId || '');
  if (!UUID_V4.test(claimId) || !['completed', 'failed'].includes(value?.status)) {
    throw failure('EGE_MOCK_WRITING_OUTCOME_INVALID');
  }
  const errorCode = value.errorCode == null ? null : String(value.errorCode);
  if (errorCode != null && !/^[a-z][a-z0-9_]{0,63}$/u.test(errorCode)) {
    throw failure('EGE_MOCK_WRITING_OUTCOME_INVALID');
  }
  return {
    claimId,
    status: value.status,
    provider: provenanceValue(value.provider),
    model: provenanceValue(value.model),
    durationMs: optionalOutcomeInteger(value.durationMs, 15 * 60 * 1000),
    errorCode,
    promptTokens: optionalOutcomeInteger(value.promptTokens),
    completionTokens: optionalOutcomeInteger(value.completionTokens),
  };
}

export function applyEgeMockWritingAssessmentItemOutcomePreparation(row, {
  claimToken, position, outcomeToken, now,
}) {
  const token = String(outcomeToken || '');
  if (!UUID_V4.test(token)) throw failure('EGE_MOCK_WRITING_OUTCOME_INVALID');
  const { assessment, item } = requirePendingClaim(row, claimToken, position);
  if (item.outcome) {
    if (item.outcome.token !== token) throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONFLICT');
    return { applied: false, outcome: structuredClone(item.outcome) };
  }
  const instant = iso(now);
  const nextRevision = nextEgeMockWritingAssessmentRevision(assessment);
  item.outcome = {
    token,
    status: 'prepared',
    binding: exactItemBinding(item, {
      assignment: item.assignment,
      contentRef: item.content_ref,
      criteriaRef: item.criteria_ref,
      criteriaFingerprint: item.criteria_fingerprint,
      criteriaSnapshot: item.criteria_snapshot,
      formRef: item.form_ref,
    }),
    review: null,
    provenance: null,
    calls: [],
    prepared_at: instant,
    recorded_at: null,
  };
  assessment.updated_at = instant;
  assessment.assessment_revision = nextRevision;
  row.updated_at = instant;
  return { applied: true, outcome: structuredClone(item.outcome) };
}

export function applyEgeMockWritingAssessmentItemOutcome(row, {
  claimToken, position, outcomeToken, review, binding, provenance, calls = [], now,
}) {
  const token = String(outcomeToken || '');
  if (!UUID_V4.test(token) || !Array.isArray(calls) || calls.length > 4) {
    throw failure('EGE_MOCK_WRITING_OUTCOME_INVALID');
  }
  const { assessment, item } = requirePendingClaim(row, claimToken, position);
  if (!item.outcome || item.outcome.token !== token) {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONFLICT');
  }
  const candidate = {
    token,
    status: 'recorded',
    binding: exactItemBinding(item, binding),
    review: exactReview(item, review),
    provenance: {
      provider: provenanceValue(provenance?.provider),
      model: provenanceValue(provenance?.model),
    },
    calls: calls.map(normalizedCall),
  };
  if (item.outcome.status === 'recorded') {
    const stored = {
      token: item.outcome.token,
      status: item.outcome.status,
      binding: item.outcome.binding,
      review: item.outcome.review,
      provenance: {
        provider: item.outcome.provenance?.provider ?? null,
        model: item.outcome.provenance?.model ?? null,
      },
      calls: item.outcome.calls,
    };
    if (!sameSemanticJsonValue(candidate, stored)) {
      throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONFLICT');
    }
    return { applied: false, outcome: structuredClone(item.outcome) };
  }
  if (!['prepared', 'prepared_unknown'].includes(item.outcome.status)) {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONFLICT');
  }
  exactItemBinding(item, item.outcome.binding);
  const instant = iso(now);
  const nextRevision = nextEgeMockWritingAssessmentRevision(assessment);
  item.outcome = {
    ...candidate,
    provenance: { ...candidate.provenance, assessed_at: instant },
    prepared_at: item.outcome.prepared_at,
    recorded_at: instant,
  };
  assessment.updated_at = instant;
  assessment.assessment_revision = nextRevision;
  row.updated_at = instant;
  return { applied: true, outcome: structuredClone(item.outcome) };
}

function publicResultItem(item) {
  const review = item.review;
  return {
    position: item.position,
    status: item.status,
    score: item.status === 'completed' ? review.overall_got : null,
    maximum: item.maximum,
    criteriaRef: item.criteria_ref,
    criteriaFingerprint: item.criteria_fingerprint,
    scope: structuredClone(item.scope),
    criteria: item.status === 'completed' ? structuredClone(review.criteria) : null,
    feedback: item.status === 'completed'
      ? { verdict: review.verdict, nextStep: review.sub } : null,
    evidence: item.status === 'completed' ? structuredClone(review.errors) : [],
  };
}

export function egeMockWritingResultPublicDto(row) {
  const assessment = row?.writing_assessment;
  const items = Array.isArray(assessment?.items) ? assessment.items.map(publicResultItem) : [];
  const complete = assessment?.status === 'completed'
    && items.length === WRITING_POSITIONS.length
    && items.every((item) => item.status === 'completed');
  return {
    status: assessment?.status || 'not_started',
    assessmentRevision: egeMockWritingAssessmentRevision(assessment),
    ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
    label: EGE_MOCK_WRITING_ASSESSMENT_LABEL,
    score: complete ? items.reduce((sum, item) => sum + item.score, 0) : null,
    maximum: 20,
    items,
  };
}

export function applyEgeMockWritingAssessmentItemCompletion(row, {
  claimToken, position, outcomeToken, now,
}) {
  const assessment = row.writing_assessment;
  const item = assessment?.items?.find((candidate) => candidate.position === Number(position));
  if (!item) throw failure('EGE_MOCK_WRITING_ASSESSMENT_STATE_INVALID');
  if (item.outcome?.status === 'recorded') {
    exactItemBinding(item, item.outcome.binding);
    exactReview(item, item.outcome.review);
  }
  if (item.status === 'completed') {
    if (item.outcome?.token !== outcomeToken) {
      throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONFLICT');
    }
    return { applied: false, writingAssessment: egeMockWritingAssessmentPublicDto(row) };
  }
  if (assessment.status !== 'in_progress' || assessment.claim_token !== claimToken
    || item.status !== 'pending' || item.outcome?.status !== 'recorded'
    || item.outcome.token !== outcomeToken) {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONFLICT');
  }
  const nextRevision = nextEgeMockWritingAssessmentRevision(assessment);
  item.review = exactReview(item, item.outcome.review);
  item.provenance = structuredClone(item.outcome.provenance);
  item.status = 'completed';
  item.error_code = null;
  const instant = iso(now);
  assessment.status = assessment.items.every((candidate) => candidate.status === 'completed')
    ? 'completed' : 'in_progress';
  if (assessment.status === 'completed') {
    assessment.claim_token = null;
    assessment.claim_expires_at = null;
  }
  assessment.updated_at = instant;
  assessment.assessment_revision = nextRevision;
  row.updated_at = instant;
  reconcileEgeMockSubjectiveAssessmentState(row);
  return { applied: true, writingAssessment: egeMockWritingAssessmentPublicDto(row) };
}

export function applyEgeMockWritingAssessmentFailure(row, {
  claimToken, reason, discardPreparedOutcome = false, now,
}) {
  const assessment = row.writing_assessment;
  const errorCode = String(reason || 'provider_unavailable');
  if (assessment?.status !== 'in_progress' || assessment.claim_token !== claimToken
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(errorCode)) {
    throw failure('EGE_MOCK_WRITING_ASSESSMENT_CONFLICT');
  }
  const nextRevision = nextEgeMockWritingAssessmentRevision(assessment);
  const ambiguous = errorCode === 'provider_result_ambiguous';
  const recoveryPending = errorCode === 'provider_result_recovery_pending';
  for (const item of assessment.items || []) {
    if (item.status === 'pending') {
      if (discardPreparedOutcome && item.outcome?.status === 'prepared') item.outcome = null;
      else if (!discardPreparedOutcome && item.outcome?.status === 'prepared') {
        item.outcome.status = 'prepared_unknown';
      }
      item.status = recoveryPending ? 'pending' : ambiguous ? 'ambiguous' : 'retryable';
      item.error_code = errorCode;
    }
  }
  const instant = iso(now);
  assessment.status = recoveryPending ? 'pending' : ambiguous ? 'ambiguous' : 'retryable';
  assessment.claim_token = null;
  assessment.claim_expires_at = null;
  assessment.updated_at = instant;
  assessment.assessment_revision = nextRevision;
  row.updated_at = instant;
  reconcileEgeMockSubjectiveAssessmentState(row);
  return egeMockWritingAssessmentPublicDto(row);
}

export function retryEgeMockWritingAssessment(row, now, { acknowledgePossibleProviderRepeat = false } = {}) {
  const assessment = row.writing_assessment;
  if (!['retryable', 'ambiguous'].includes(assessment?.status)
    || Number(assessment.retry_count) >= 3) return false;
  if (assessment.status === 'ambiguous' && acknowledgePossibleProviderRepeat !== true) {
    throw failure('EGE_MOCK_WRITING_AMBIGUOUS_RETRY_ACK_REQUIRED');
  }
  const nextRevision = nextEgeMockWritingAssessmentRevision(assessment);
  const instant = iso(now);
  for (const item of assessment.items || []) {
    if (item.status === 'retryable' || item.status === 'ambiguous') {
      if (item.status === 'ambiguous'
        && ['prepared', 'prepared_unknown'].includes(item.outcome?.status)) {
        item.abandoned_outcomes ||= [];
        item.abandoned_outcomes.push({
          token: item.outcome.token,
          status: 'ambiguous',
          binding: structuredClone(item.outcome.binding),
          prepared_at: item.outcome.prepared_at,
          abandoned_at: instant,
        });
        item.abandoned_outcomes = item.abandoned_outcomes.slice(-3);
        item.outcome = null;
      }
      item.status = 'pending';
      item.error_code = null;
    }
  }
  assessment.status = 'pending';
  assessment.retry_count = Number(assessment.retry_count) + 1;
  assessment.authorization = null;
  assessment.claim_token = null;
  assessment.claim_expires_at = null;
  assessment.updated_at = instant;
  assessment.assessment_revision = nextRevision;
  row.updated_at = instant;
  reconcileEgeMockSubjectiveAssessmentState(row);
  return true;
}
