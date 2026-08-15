import crypto from 'node:crypto';

import { sanitizeEgeWritingText } from '../shared/ege-writing-text.js';

import {
  EGE_MOCK_ATTEMPT_POLICY,
  EGE_MOCK_ORAL_DURATION_MS,
  EGE_MOCK_ORAL_START_WINDOW_MS,
  EGE_MOCK_WRITTEN_DURATION_MS,
} from './policy.js';
import {
  beginEgeMockWritingAssessment,
  egeMockWritingAssessmentPublicDto,
  egeMockWritingResultPublicDto,
  retryEgeMockWritingAssessment,
} from './writing-assessment.js';

export class EgeMockAttemptError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = 'EgeMockAttemptError';
  }
}

function iso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new EgeMockAttemptError('EGE_MOCK_TIME_INVALID');
  return date.toISOString();
}

export function createEgeMockAttempt({
  id,
  username,
  ownerGeneration,
  form,
  mode,
  attemptNumber,
  idempotencyKey,
  requestHash,
  now,
}) {
  const startedAt = iso(now);
  const attempt = {
    id,
    username,
    owner_generation: ownerGeneration,
    policy_id: EGE_MOCK_ATTEMPT_POLICY.id,
    form_id: form.id,
    form_revision: form.revision,
    exam_year: form.examYear,
    catalog_fingerprint: form.fingerprint,
    mode,
    attempt_number: attemptNumber,
    state: 'written_in_progress',
    revision: 0,
    draft: {},
    written_started_at: startedAt,
    written_deadline_at: iso(new Date(startedAt).getTime() + EGE_MOCK_WRITTEN_DURATION_MS),
    written_submitted_at: null,
    oral_available_until: null,
    oral_started_at: null,
    oral_deadline_at: null,
    oral_submitted_at: null,
    assessment_status: 'not_started',
    assessment_retry_count: 0,
    writing_assessment: null,
    result: null,
    start_idempotency_key: idempotencyKey,
    start_request_hash: requestHash,
    created_at: startedAt,
    updated_at: startedAt,
  };
  attempt.start_response_attempt = egeMockAttemptPublicDto(attempt);
  return attempt;
}

export function egeMockStartDecision(attempts) {
  const active = attempts.find((attempt) => (
    !['assessment_pending', 'completed', 'expired'].includes(attempt.state)
  )) || null;
  if (active) return { active, mode: null, attemptNumber: null };
  const diagnosticComplete = attempts.some((attempt) => (
    attempt.mode === 'diagnostic' && ['assessment_pending', 'completed'].includes(attempt.state)
  ));
  return {
    active: null,
    mode: diagnosticComplete ? 'training' : 'diagnostic',
    attemptNumber: attempts.length + 1,
  };
}

export function egeMockAttemptPublicDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerGeneration: row.owner_generation,
    policyId: row.policy_id,
    formId: row.form_id,
    formRevision: Number(row.form_revision),
    examYear: Number(row.exam_year),
    catalogFingerprint: row.catalog_fingerprint,
    mode: row.mode,
    attemptNumber: Number(row.attempt_number),
    state: row.state,
    revision: Number(row.revision),
    draft: structuredClone(row.draft || {}),
    writtenStartedAt: iso(row.written_started_at),
    writtenDeadlineAt: iso(row.written_deadline_at),
    writtenSubmittedAt: row.written_submitted_at == null ? null : iso(row.written_submitted_at),
    oralAvailableUntil: row.oral_available_until == null ? null : iso(row.oral_available_until),
    oralStartedAt: row.oral_started_at == null ? null : iso(row.oral_started_at),
    oralDeadlineAt: row.oral_deadline_at == null ? null : iso(row.oral_deadline_at),
    oralSubmittedAt: row.oral_submitted_at == null ? null : iso(row.oral_submitted_at),
    assessment: {
      status: row.assessment_status,
      retryAllowed: row.assessment_status === 'retryable' && Number(row.assessment_retry_count) < 3,
      retryCount: Number(row.assessment_retry_count),
    },
    writingAssessment: egeMockWritingAssessmentPublicDto(row),
  };
}

function normalizeEgeMockDraft(form, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new EgeMockAttemptError('EGE_MOCK_DRAFT_INVALID');
  }
  const writtenPositions = new Set(form.positions
    .filter(({ position }) => position <= 38).map(({ position }) => String(position)));
  const normalized = {};
  for (const key of Object.keys(answers).sort((left, right) => Number(left) - Number(right))) {
    if (!writtenPositions.has(key)) throw new EgeMockAttemptError('EGE_MOCK_DRAFT_INVALID');
    const value = answers[key];
    const item = form.positions[Number(key) - 1];
    const writingLimit = item?.position === 37 ? 12_000 : item?.position === 38 ? 20_000 : null;
    const validString = typeof value === 'string' && value.length <= (writingLimit || 20_000);
    const validList = writingLimit == null && Array.isArray(value) && value.length <= 20
      && value.every((entry) => typeof entry === 'string' && entry.length <= 500);
    if (!validString && !validList && value !== null) {
      throw new EgeMockAttemptError('EGE_MOCK_DRAFT_INVALID');
    }
    normalized[key] = writingLimit != null && typeof value === 'string'
      ? sanitizeEgeWritingText(value) : structuredClone(value);
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 100_000) {
    throw new EgeMockAttemptError('EGE_MOCK_DRAFT_INVALID');
  }
  return normalized;
}

function authoritativePartPayload(row, operation, positions, values) {
  return {
    schemaVersion: 'ege-mock-part-payload-v1',
    operation,
    attemptId: row.id,
    ownerGeneration: row.owner_generation,
    formId: row.form_id,
    formRevision: Number(row.form_revision),
    catalogFingerprint: row.catalog_fingerprint,
    orderedItems: positions.map((position) => ({
      position,
      value: structuredClone(values[String(position)] ?? null),
    })),
  };
}

function egeMockWrittenPayloadDigest(row) {
  const payload = authoritativePartPayload(
    row, 'written_submit', Array.from({ length: 38 }, (_, index) => index + 1), row.draft || {},
  );
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function egeMockOralPayloadDigest(row, recordings = row.oral_recordings || {}) {
  const payload = authoritativePartPayload(row, 'oral_submit', [39, 40, 41, 42], recordings);
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

export function reconcileEgeMockAttempt(row, now = new Date()) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new EgeMockAttemptError('EGE_MOCK_TIME_INVALID');
  let changed = false;
  if (row.state === 'written_in_progress'
    && instant.getTime() >= new Date(row.written_deadline_at).getTime()) {
    row.state = 'oral_ready';
    row.written_submitted_at = iso(row.written_deadline_at);
    row.oral_available_until = iso(
      new Date(row.written_deadline_at).getTime() + EGE_MOCK_ORAL_START_WINDOW_MS,
    );
    row.revision = Number(row.revision) + 1;
    row.updated_at = row.written_submitted_at;
    row.written_receipt ||= {
      id: `written:auto:${row.id}`,
      operation: 'written_submit',
      attemptId: row.id,
      ownerGeneration: row.owner_generation,
      formId: row.form_id,
      formRevision: Number(row.form_revision),
      catalogFingerprint: row.catalog_fingerprint,
      revision: Number(row.revision),
      orderedPositions: Array.from({ length: 38 }, (_, index) => index + 1),
      deadlineAt: iso(row.written_deadline_at),
      payloadDigest: egeMockWrittenPayloadDigest(row),
      appliedAt: row.written_submitted_at,
      automatic: true,
    };
    beginEgeMockWritingAssessment(row, row.written_submitted_at);
    changed = true;
  }
  if (row.state === 'oral_ready' && row.oral_available_until != null
    && instant.getTime() >= new Date(row.oral_available_until).getTime()) {
    row.state = 'expired';
    row.revision = Number(row.revision) + 1;
    row.updated_at = iso(row.oral_available_until);
    changed = true;
  }
  if (row.state === 'oral_in_progress' && row.oral_deadline_at != null
    && instant.getTime() >= new Date(row.oral_deadline_at).getTime()) {
    row.state = 'assessment_pending';
    row.oral_submitted_at = iso(row.oral_deadline_at);
    row.assessment_status = 'not_started';
    row.revision = Number(row.revision) + 1;
    row.updated_at = row.oral_submitted_at;
    row.oral_receipt ||= {
      id: `oral:auto:${row.id}`,
      operation: 'oral_submit',
      attemptId: row.id,
      ownerGeneration: row.owner_generation,
      formId: row.form_id,
      formRevision: Number(row.form_revision),
      catalogFingerprint: row.catalog_fingerprint,
      revision: Number(row.revision),
      orderedPositions: [39, 40, 41, 42],
      deadlineAt: iso(row.oral_deadline_at),
      payloadDigest: egeMockOralPayloadDigest(row),
      appliedAt: row.oral_submitted_at,
      automatic: true,
    };
    changed = true;
  }
  return changed;
}

function submitEgeMockWrittenPart(row, { now, payloadDigest, receiptId }) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new EgeMockAttemptError('EGE_MOCK_TIME_INVALID');
  row.state = 'oral_ready';
  row.written_submitted_at = instant.toISOString();
  row.oral_available_until = iso(instant.getTime() + EGE_MOCK_ORAL_START_WINDOW_MS);
  row.revision = Number(row.revision) + 1;
  row.updated_at = row.written_submitted_at;
  row.written_receipt = {
    id: receiptId,
    operation: 'written_submit',
    attemptId: row.id,
    ownerGeneration: row.owner_generation,
    formId: row.form_id,
    formRevision: Number(row.form_revision),
    catalogFingerprint: row.catalog_fingerprint,
    revision: Number(row.revision),
    orderedPositions: Array.from({ length: 38 }, (_, index) => index + 1),
    deadlineAt: iso(row.written_deadline_at),
    payloadDigest,
    appliedAt: row.written_submitted_at,
    automatic: false,
  };
  beginEgeMockWritingAssessment(row, row.written_submitted_at);
  return row;
}

function startEgeMockOralPart(row, now) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new EgeMockAttemptError('EGE_MOCK_TIME_INVALID');
  row.state = 'oral_in_progress';
  row.oral_started_at = instant.toISOString();
  row.oral_deadline_at = iso(instant.getTime() + EGE_MOCK_ORAL_DURATION_MS);
  row.revision = Number(row.revision) + 1;
  row.updated_at = row.oral_started_at;
  return row;
}

function normalizeEgeMockOralRecordings(recordings) {
  if (!recordings || typeof recordings !== 'object' || Array.isArray(recordings)) {
    throw new EgeMockAttemptError('EGE_MOCK_ORAL_PAYLOAD_INVALID');
  }
  const normalized = {};
  for (const [key, value] of Object.entries(recordings)) {
    if (!['39', '40', '41', '42'].includes(key) || !value || typeof value !== 'object'
      || typeof value.recordingId !== 'string' || value.recordingId.length < 1
      || value.recordingId.length > 120 || !Number.isFinite(Number(value.durationSeconds))
      || Number(value.durationSeconds) < 0 || Number(value.durationSeconds) > 1_020) {
      throw new EgeMockAttemptError('EGE_MOCK_ORAL_PAYLOAD_INVALID');
    }
    normalized[key] = {
      recordingId: value.recordingId,
      durationSeconds: Number(value.durationSeconds),
    };
  }
  return normalized;
}

function submitEgeMockOralPart(row, { now, payloadDigest, receiptId, recordings }) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new EgeMockAttemptError('EGE_MOCK_TIME_INVALID');
  row.state = 'assessment_pending';
  row.oral_submitted_at = instant.toISOString();
  row.oral_recordings = structuredClone(recordings);
  row.assessment_status = 'not_started';
  row.revision = Number(row.revision) + 1;
  row.updated_at = row.oral_submitted_at;
  row.oral_receipt = {
    id: receiptId,
    operation: 'oral_submit',
    attemptId: row.id,
    ownerGeneration: row.owner_generation,
    formId: row.form_id,
    formRevision: Number(row.form_revision),
    catalogFingerprint: row.catalog_fingerprint,
    revision: Number(row.revision),
    orderedPositions: [39, 40, 41, 42],
    deadlineAt: iso(row.oral_deadline_at),
    payloadDigest,
    appliedAt: row.oral_submitted_at,
    automatic: false,
  };
  return row;
}

export function applyEgeMockDraftMutation(row, {
  form, expectedRevision, answers, now,
}) {
  if (row.state !== 'written_in_progress') {
    throw new EgeMockAttemptError('EGE_MOCK_WRITTEN_CLOSED');
  }
  if (Number(expectedRevision) !== Number(row.revision)) {
    throw new EgeMockAttemptError('EGE_MOCK_REVISION_CONFLICT');
  }
  if (!form || form.id !== row.form_id || Number(form.revision) !== Number(row.form_revision)
    || form.fingerprint !== row.catalog_fingerprint) {
    throw new EgeMockAttemptError('EGE_MOCK_FORM_UNAVAILABLE');
  }
  row.draft = normalizeEgeMockDraft(form, answers);
  row.revision = Number(row.revision) + 1;
  row.updated_at = iso(now);
  return { applied: true, replayed: false, attempt: egeMockAttemptPublicDto(row) };
}

export function applyEgeMockWrittenMutation(row, {
  expectedRevision, now, receiptId, reconciled = false,
}) {
  const automatic = Boolean(reconciled && row.written_receipt);
  if (!automatic) {
    if (row.state !== 'written_in_progress') {
      throw new EgeMockAttemptError('EGE_MOCK_WRITTEN_CLOSED');
    }
    if (Number(expectedRevision) !== Number(row.revision)) {
      throw new EgeMockAttemptError('EGE_MOCK_REVISION_CONFLICT');
    }
    submitEgeMockWrittenPart(row, {
      now, payloadDigest: egeMockWrittenPayloadDigest(row), receiptId,
    });
  }
  return {
    applied: !automatic,
    replayed: automatic,
    attempt: egeMockAttemptPublicDto(row),
    receipt: structuredClone(row.written_receipt),
  };
}

export function applyEgeMockOralStartMutation(row, { expectedRevision, now }) {
  if (row.state !== 'oral_ready') throw new EgeMockAttemptError('EGE_MOCK_ORAL_NOT_READY');
  if (Number(expectedRevision) !== Number(row.revision)) {
    throw new EgeMockAttemptError('EGE_MOCK_REVISION_CONFLICT');
  }
  startEgeMockOralPart(row, now);
  return { applied: true, replayed: false, attempt: egeMockAttemptPublicDto(row) };
}

export function applyEgeMockOralMutation(row, {
  expectedRevision, recordings: candidateRecordings, now, receiptId, reconciled = false,
}) {
  const automatic = Boolean(reconciled && row.oral_receipt);
  if (!automatic) {
    if (row.state !== 'oral_in_progress') throw new EgeMockAttemptError('EGE_MOCK_ORAL_CLOSED');
    if (Number(expectedRevision) !== Number(row.revision)) {
      throw new EgeMockAttemptError('EGE_MOCK_REVISION_CONFLICT');
    }
    const recordings = normalizeEgeMockOralRecordings(candidateRecordings);
    submitEgeMockOralPart(row, {
      now,
      payloadDigest: egeMockOralPayloadDigest(row, recordings),
      receiptId,
      recordings,
    });
  }
  return {
    applied: !automatic,
    replayed: automatic,
    attempt: egeMockAttemptPublicDto(row),
    receipt: structuredClone(row.oral_receipt),
  };
}

export function applyEgeMockAssessmentRetryable(row, { reason, now }) {
  if (row.state !== 'assessment_pending'
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(String(reason || ''))) {
    throw new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_STATE_INVALID');
  }
  row.assessment_status = 'retryable';
  row.assessment_error_code = String(reason);
  row.updated_at = iso(now);
  return egeMockAttemptPublicDto(row);
}

export function applyEgeMockAssessmentRetryMutation(row, {
  now, acknowledgePossibleProviderRepeat = false,
}) {
  if (retryEgeMockWritingAssessment(row, now, { acknowledgePossibleProviderRepeat })) {
    return { applied: true, replayed: false, attempt: egeMockAttemptPublicDto(row) };
  }
  if (row.state !== 'assessment_pending' || row.assessment_status !== 'retryable'
    || Number(row.assessment_retry_count) >= 3) {
    throw new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_RETRY_NOT_ALLOWED');
  }
  row.assessment_status = 'pending';
  row.assessment_error_code = null;
  row.assessment_retry_count = Number(row.assessment_retry_count) + 1;
  row.updated_at = iso(now);
  return { applied: true, replayed: false, attempt: egeMockAttemptPublicDto(row) };
}

export function egeMockResultPublicDto(row) {
  const assessmentRunDisposition = row?.writing_assessment?.run_disposition === 'subscription_required'
    ? { assessmentRunDisposition: 'subscription_required' } : {};
  const writingAssessment = row ? egeMockWritingAssessmentPublicDto(row) : null;
  if (!row || !['assessment_pending', 'completed'].includes(row.state)) {
    return row ? {
      available: false, state: row.state, keysRevealed: false,
      writingAssessment, ...assessmentRunDisposition,
    } : null;
  }
  return {
    available: true,
    state: row.state,
    keysRevealed: true,
    writingAssessment,
    ...assessmentRunDisposition,
    assessment: {
      status: row.assessment_status,
      retryAllowed: row.assessment_status === 'retryable' && Number(row.assessment_retry_count) < 3,
      retryCount: Number(row.assessment_retry_count),
    },
    result: {
      ...(row.result && typeof row.result === 'object' ? structuredClone(row.result) : {}),
      writing: egeMockWritingResultPublicDto(row),
    },
  };
}

export function egeMockAttemptExportDto(row) {
  return {
    id: row.id,
    owner_generation: row.owner_generation,
    policy_id: row.policy_id,
    form_id: row.form_id,
    form_revision: Number(row.form_revision),
    exam_year: Number(row.exam_year),
    catalog_fingerprint: row.catalog_fingerprint,
    mode: row.mode,
    attempt_number: Number(row.attempt_number),
    state: row.state,
    revision: Number(row.revision),
    draft: structuredClone(row.draft || {}),
    written_started_at: iso(row.written_started_at),
    written_deadline_at: iso(row.written_deadline_at),
    written_submitted_at: row.written_submitted_at == null ? null : iso(row.written_submitted_at),
    written_receipt: structuredClone(row.written_receipt || null),
    oral_available_until: row.oral_available_until == null ? null : iso(row.oral_available_until),
    oral_started_at: row.oral_started_at == null ? null : iso(row.oral_started_at),
    oral_deadline_at: row.oral_deadline_at == null ? null : iso(row.oral_deadline_at),
    oral_submitted_at: row.oral_submitted_at == null ? null : iso(row.oral_submitted_at),
    oral_recordings: structuredClone(row.oral_recordings || {}),
    oral_receipt: structuredClone(row.oral_receipt || null),
    assessment_status: row.assessment_status,
    assessment_retry_count: Number(row.assessment_retry_count),
    writing_assessment: structuredClone(row.writing_assessment || null),
    result: structuredClone(row.result),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}
