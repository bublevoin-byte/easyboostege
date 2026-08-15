import crypto from 'node:crypto';

import { sanitizeEgeWritingText } from '../shared/ege-writing-text.js';
import {
  EGE_MOCK_ORAL_POSITIONS,
  EGE_MOCK_ORAL_RESPONSE_KEYS,
  EGE_MOCK_ORAL_STAGE_SETTLEMENT_GRACE_MS,
  EGE_MOCK_ORAL_TASK_BY_POSITION,
  EGE_MOCK_ORAL_TASKS,
} from '../shared/ege-mock-oral-contract.js';

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
import {
  beginEgeMockSpeakingAssessment,
  egeMockSpeakingAssessmentPublicDto,
  egeMockSpeakingResultPublicDto,
  reconcileEgeMockSubjectiveAssessmentState,
} from './speaking-assessment.js';

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
    oral_progress: null,
    assessment_status: 'not_started',
    assessment_retry_count: 0,
    writing_assessment: null,
    speaking_assessment: null,
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
  const writingAssessment = egeMockWritingAssessmentPublicDto(row);
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
    ...(row.oral_progress ? { oralProgress: structuredClone(row.oral_progress) } : {}),
    assessment: {
      status: row.assessment_status,
      retryAllowed: writingAssessment.retryAllowed === true,
      retryCount: Number(row.assessment_retry_count),
    },
    writingAssessment,
    ...(row.speaking_assessment
      ? { speakingAssessment: egeMockSpeakingAssessmentPublicDto(row) } : {}),
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
  const payload = authoritativePartPayload(row, 'oral_submit', EGE_MOCK_ORAL_POSITIONS, recordings);
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function deterministicEgeMockOralRecordingId(row, key, usedIds) {
  for (let nonce = 0; nonce < 100; nonce += 1) {
    const bytes = Buffer.from(crypto.createHash('sha256')
      .update(`${row.id}\u0000${row.owner_generation}\u0000${key}\u0000${nonce}`).digest().subarray(0, 16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (!usedIds.has(id)) return id;
  }
  throw new EgeMockAttemptError('EGE_MOCK_ORAL_RECORDING_INVALID');
}

function validBoundEgeMockOralRecording(row, key, recording, usedIds) {
  const [position, responseNumber] = key.split(':').map(Number);
  const task = EGE_MOCK_ORAL_TASK_BY_POSITION[position];
  const completed = recording?.status === 'completed';
  const technical = recording?.status === 'technical_issue';
  const duration = Number(recording?.durationSeconds);
  return recording?.schemaVersion === 'ege-mock-oral-recording-v1'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(recording.recordingId || '')
    && !usedIds.has(recording.recordingId)
    && recording.ownerGeneration === row.owner_generation && recording.attemptId === row.id
    && recording.formId === row.form_id && Number(recording.formRevision) === Number(row.form_revision)
    && recording.catalogFingerprint === row.catalog_fingerprint
    && Number(recording.position) === position && Number(recording.responseNumber) === responseNumber
    && Number(recording.taskType) === task?.taskType
    && ['completed', 'technical_issue', 'skipped'].includes(recording.status)
    && Number.isFinite(duration) && duration >= (completed ? 1 : 0)
    && duration <= task.responseSeconds && (completed || duration === 0)
    && (completed === /^[a-f0-9]{64}$/u.test(recording.sha256 || ''))
    && (technical === /^[a-z][a-z0-9_]{0,63}$/u.test(recording.technicalIssueCode || ''))
    && (technical || recording.technicalIssueCode == null)
    && Number.isFinite(Date.parse(recording.stageStartedAt))
    && Number.isFinite(Date.parse(recording.stageDeadlineAt))
    && Number.isFinite(Date.parse(recording.completedAt));
}

function canonicalizeEgeMockOralDeadlineEvidence(row) {
  const deadlineAt = iso(row.oral_deadline_at);
  const existing = row.oral_progress?.recordings || {};
  const recordings = {};
  const usedIds = new Set();
  for (const key of EGE_MOCK_ORAL_RESPONSE_KEYS) {
    const [position, responseNumber] = key.split(':').map(Number);
    const task = EGE_MOCK_ORAL_TASK_BY_POSITION[position];
    if (validBoundEgeMockOralRecording(row, key, existing[key], usedIds)) {
      recordings[key] = structuredClone(existing[key]);
    } else {
      const recordingId = deterministicEgeMockOralRecordingId(row, key, usedIds);
      recordings[key] = {
        schemaVersion: 'ege-mock-oral-recording-v1',
        recordingId,
        ownerGeneration: row.owner_generation,
        attemptId: row.id,
        formId: row.form_id,
        formRevision: Number(row.form_revision),
        catalogFingerprint: row.catalog_fingerprint,
        position,
        taskType: task.taskType,
        responseNumber,
        status: 'technical_issue',
        durationSeconds: 0,
        sha256: null,
        technicalIssueCode: 'oral_deadline_elapsed',
        stageStartedAt: deadlineAt,
        stageDeadlineAt: deadlineAt,
        completedAt: deadlineAt,
      };
    }
    usedIds.add(recordings[key].recordingId);
  }
  row.oral_progress = {
    schemaVersion: 'ege-mock-oral-progress-v1',
    position: 42,
    responseNumber: 1,
    phase: 'ready_to_submit',
    stageStartedAt: null,
    stageDeadlineAt: null,
    recordings,
  };
  row.oral_recordings = egeMockOralRecordingsFromProgress(row, row.oral_progress);
  if (!row.oral_recordings) throw new EgeMockAttemptError('EGE_MOCK_ORAL_RECORDING_INVALID');
}

function reconcileExpiredEgeMockOralStage(row, instant) {
  const progress = row.oral_progress;
  if (progress?.schemaVersion !== 'ege-mock-oral-progress-v1'
    || !['preparing', 'recording'].includes(progress.phase)) return 0;
  const task = EGE_MOCK_ORAL_TASK_BY_POSITION[progress.position];
  let stageDeadline = new Date(progress.stageDeadlineAt).getTime();
  if (!task || !Number.isFinite(stageDeadline)) return 0;
  let transitions = 0;
  if (progress.phase === 'preparing' && instant.getTime() >= stageDeadline) {
    progress.phase = 'recording';
    progress.stageStartedAt = iso(stageDeadline);
    progress.stageDeadlineAt = iso(Math.min(
      stageDeadline + task.responseSeconds * 1_000,
      new Date(row.oral_deadline_at).getTime(),
    ));
    stageDeadline = new Date(progress.stageDeadlineAt).getTime();
    transitions += 1;
  }
  if (progress.phase === 'recording'
    && instant.getTime() > stageDeadline + EGE_MOCK_ORAL_STAGE_SETTLEMENT_GRACE_MS) {
    const key = `${progress.position}:${progress.responseNumber}`;
    if (!progress.recordings[key]) {
      const usedIds = new Set(Object.values(progress.recordings || {})
        .map((recording) => recording?.recordingId).filter(Boolean));
      progress.recordings[key] = normalizeEgeMockOralStageRecording(row, progress, {
        recordingId: deterministicEgeMockOralRecordingId(row, key, usedIds),
        status: 'technical_issue',
        durationSeconds: 0,
        technicalIssueCode: 'response_timeout',
      }, new Date(stageDeadline + EGE_MOCK_ORAL_STAGE_SETTLEMENT_GRACE_MS));
    }
    advanceEgeMockOralCursor(progress);
    transitions += 1;
  }
  if (transitions > 0) {
    row.revision = Number(row.revision) + transitions;
    row.updated_at = instant.toISOString();
  }
  return transitions;
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
    && instant.getTime() < new Date(row.oral_deadline_at).getTime()
    && reconcileExpiredEgeMockOralStage(row, instant) > 0) {
    changed = true;
  }
  if (row.state === 'oral_in_progress' && row.oral_deadline_at != null
    && instant.getTime() >= new Date(row.oral_deadline_at).getTime()) {
    canonicalizeEgeMockOralDeadlineEvidence(row);
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
      orderedPositions: [...EGE_MOCK_ORAL_POSITIONS],
      deadlineAt: iso(row.oral_deadline_at),
      payloadDigest: egeMockOralPayloadDigest(row),
      appliedAt: row.oral_submitted_at,
      automatic: true,
    };
    beginEgeMockSpeakingAssessment(row, row.oral_submitted_at);
    reconcileEgeMockSubjectiveAssessmentState(row);
    changed = true;
  }
  return changed;
}

export function shouldSettleEgeMockOralStageBeforeReconcile(row, operation, candidate, now) {
  const instant = new Date(now).getTime();
  const stageDeadline = new Date(row?.oral_progress?.stageDeadlineAt).getTime();
  const exactStage = operation === 'oral_stage'
    && row?.state === 'oral_in_progress' && row?.oral_progress?.phase === 'recording'
    && Number(row.oral_progress.position) === Number(candidate.position)
    && Number(row.oral_progress.responseNumber) === Number(candidate.responseNumber);
  if (exactStage && candidate?.action === 'complete'
    && Number.isFinite(instant) && Number.isFinite(stageDeadline)) {
    return instant >= stageDeadline
      && instant <= stageDeadline + EGE_MOCK_ORAL_STAGE_SETTLEMENT_GRACE_MS;
  }
  const task = EGE_MOCK_ORAL_TASK_BY_POSITION[row?.oral_progress?.position];
  const oralDeadline = new Date(row?.oral_deadline_at).getTime();
  return operation === 'oral_stage' && candidate?.action === 'advance'
    && row?.state === 'oral_in_progress' && row?.oral_progress?.phase === 'preparing'
    && Number(row.oral_progress.position) === Number(candidate.position)
    && Number(row.oral_progress.responseNumber) === Number(candidate.responseNumber)
    && task && Number.isFinite(instant) && Number.isFinite(stageDeadline)
    && instant >= stageDeadline && instant < oralDeadline
    && instant <= stageDeadline + task.responseSeconds * 1_000
      + EGE_MOCK_ORAL_STAGE_SETTLEMENT_GRACE_MS;
}

function egeMockOralStageInstant(now) {
  const actual = new Date(now);
  if (!Number.isFinite(actual.getTime())) throw new EgeMockAttemptError('EGE_MOCK_TIME_INVALID');
  return actual;
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
  row.oral_progress = {
    schemaVersion: 'ege-mock-oral-progress-v1',
    position: 39,
    responseNumber: 1,
    phase: 'ready',
    stageStartedAt: null,
    stageDeadlineAt: null,
    recordings: {},
  };
  row.revision = Number(row.revision) + 1;
  row.updated_at = row.oral_started_at;
  return row;
}

function assertEgeMockOralForm(row, form) {
  if (!form || form.id !== row.form_id || Number(form.revision) !== Number(row.form_revision)
    || form.fingerprint !== row.catalog_fingerprint
    || EGE_MOCK_ORAL_TASKS.some((task) => {
      const item = form.positions?.[task.position - 1];
      const presentation = item?.presentation;
      return item?.position !== task.position || presentation?.taskType !== task.taskType
        || Number(presentation.preparationSeconds || 0) !== task.preparationSeconds
        || Number(presentation.responseSeconds || presentation.questionSeconds) !== task.responseSeconds;
    })) throw new EgeMockAttemptError('EGE_MOCK_FORM_UNAVAILABLE');
}

function assertCurrentEgeMockOralStage(progress, position, responseNumber) {
  if (!progress || progress.schemaVersion !== 'ege-mock-oral-progress-v1'
    || Number(progress.position) !== Number(position)
    || Number(progress.responseNumber) !== Number(responseNumber)) {
    throw new EgeMockAttemptError('EGE_MOCK_ORAL_STAGE_CONFLICT');
  }
}

function advanceEgeMockOralCursor(progress) {
  const task = EGE_MOCK_ORAL_TASK_BY_POSITION[progress.position];
  if (Number(progress.responseNumber) < task.responseCount) {
    progress.responseNumber = Number(progress.responseNumber) + 1;
    progress.phase = 'ready';
  } else if (Number(progress.position) < 42) {
    progress.position = Number(progress.position) + 1;
    progress.responseNumber = 1;
    progress.phase = 'ready';
  } else {
    progress.phase = 'ready_to_submit';
  }
  progress.stageStartedAt = null;
  progress.stageDeadlineAt = null;
}

function normalizeEgeMockOralStageRecording(row, progress, candidate, now) {
  const task = EGE_MOCK_ORAL_TASK_BY_POSITION[progress.position];
  const status = candidate?.status;
  const durationSeconds = Number(candidate?.durationSeconds);
  const completed = status === 'completed';
  const technical = status === 'technical_issue';
  if (typeof candidate?.recordingId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate.recordingId)
    || !['completed', 'technical_issue', 'skipped'].includes(status)
    || !Number.isFinite(durationSeconds) || durationSeconds < 0
    || durationSeconds > task.responseSeconds || (completed && durationSeconds < 1)
    || (!completed && durationSeconds !== 0)
    || (completed !== /^[a-f0-9]{64}$/u.test(candidate?.sha256 || ''))
    || (technical && !/^[a-z][a-z0-9_]{0,63}$/u.test(candidate?.technicalIssueCode || ''))
    || (!technical && candidate?.technicalIssueCode != null)) {
    throw new EgeMockAttemptError('EGE_MOCK_ORAL_RECORDING_INVALID');
  }
  return {
    schemaVersion: 'ege-mock-oral-recording-v1',
    recordingId: candidate.recordingId,
    ownerGeneration: row.owner_generation,
    attemptId: row.id,
    formId: row.form_id,
    formRevision: Number(row.form_revision),
    catalogFingerprint: row.catalog_fingerprint,
    position: Number(progress.position),
    taskType: task.taskType,
    responseNumber: Number(progress.responseNumber),
    status,
    durationSeconds,
    sha256: completed ? candidate.sha256 : null,
    ...(technical ? { technicalIssueCode: candidate.technicalIssueCode } : {}),
    stageStartedAt: iso(progress.stageStartedAt),
    stageDeadlineAt: iso(progress.stageDeadlineAt),
    completedAt: iso(now),
  };
}

function submitEgeMockOralPart(row, {
  now, payloadDigest, receiptId, recordings,
}) {
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
    orderedPositions: [...EGE_MOCK_ORAL_POSITIONS],
    deadlineAt: iso(row.oral_deadline_at),
    payloadDigest,
    appliedAt: row.oral_submitted_at,
    automatic: false,
  };
  beginEgeMockSpeakingAssessment(row, row.oral_submitted_at);
  reconcileEgeMockSubjectiveAssessmentState(row);
  return row;
}

function egeMockOralRecordingsFromProgress(row, progress) {
  if (progress?.schemaVersion !== 'ege-mock-oral-progress-v1'
    || progress.phase !== 'ready_to_submit') return null;
  const expected = EGE_MOCK_ORAL_RESPONSE_KEYS;
  if (Object.keys(progress.recordings || {}).length !== expected.length
    || expected.some((key) => {
      const [position, responseNumber] = key.split(':').map(Number);
      const recording = progress.recordings?.[key];
      return recording?.schemaVersion !== 'ege-mock-oral-recording-v1'
        || recording.ownerGeneration !== row.owner_generation
        || recording.attemptId !== row.id || recording.formId !== row.form_id
        || Number(recording.formRevision) !== Number(row.form_revision)
        || recording.catalogFingerprint !== row.catalog_fingerprint
        || Number(recording.position) !== position
        || Number(recording.taskType) !== EGE_MOCK_ORAL_TASK_BY_POSITION[position].taskType
        || Number(recording.responseNumber) !== responseNumber;
    })
    || new Set(expected.map((key) => progress.recordings[key].recordingId)).size !== expected.length) {
    return null;
  }
  const grouped = {};
  for (const recording of Object.values(progress.recordings || {})) {
    const position = String(recording.position);
    grouped[position] ||= { entries: [] };
    grouped[position].entries.push(structuredClone(recording));
  }
  for (const item of Object.values(grouped)) {
    item.entries.sort((left, right) => left.responseNumber - right.responseNumber);
  }
  return grouped;
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

export function applyEgeMockOralStartMutation(row, { expectedRevision, now, form }) {
  if (row.state !== 'oral_ready') throw new EgeMockAttemptError('EGE_MOCK_ORAL_NOT_READY');
  if (Number(expectedRevision) !== Number(row.revision)) {
    throw new EgeMockAttemptError('EGE_MOCK_REVISION_CONFLICT');
  }
  assertEgeMockOralForm(row, form);
  startEgeMockOralPart(row, now);
  return { applied: true, replayed: false, attempt: egeMockAttemptPublicDto(row) };
}

export function applyEgeMockOralStageMutation(row, {
  form, expectedRevision, action, position, responseNumber, recording = null, now,
}) {
  if (row.state !== 'oral_in_progress') throw new EgeMockAttemptError('EGE_MOCK_ORAL_CLOSED');
  if (Number(expectedRevision) !== Number(row.revision)) {
    throw new EgeMockAttemptError('EGE_MOCK_REVISION_CONFLICT');
  }
  assertEgeMockOralForm(row, form);
  const progress = row.oral_progress;
  assertCurrentEgeMockOralStage(progress, position, responseNumber);
  const instant = egeMockOralStageInstant(now);
  const oralDeadline = new Date(row.oral_deadline_at).getTime();
  const finalStageDeadline = new Date(progress?.stageDeadlineAt).getTime();
  const settlingDeadlineRecording = action === 'complete' && progress?.phase === 'recording'
    && finalStageDeadline === oralDeadline
    && instant.getTime() <= oralDeadline + EGE_MOCK_ORAL_STAGE_SETTLEMENT_GRACE_MS;
  if (instant.getTime() >= oralDeadline && !settlingDeadlineRecording) {
    throw new EgeMockAttemptError('EGE_MOCK_ORAL_CLOSED');
  }
  const task = EGE_MOCK_ORAL_TASK_BY_POSITION[progress.position];
  if (action === 'advance') {
    const previousPhase = progress.phase;
    if (previousPhase === 'ready') {
      const needsPreparation = Number(progress.responseNumber) === 1 && task.preparationSeconds > 0;
      progress.phase = needsPreparation ? 'preparing' : 'recording';
    } else if (previousPhase === 'preparing') {
      if (instant.getTime() < new Date(progress.stageDeadlineAt).getTime()) {
        throw new EgeMockAttemptError('EGE_MOCK_ORAL_STAGE_TOO_EARLY');
      }
      progress.phase = 'recording';
    }
    else throw new EgeMockAttemptError('EGE_MOCK_ORAL_STAGE_CONFLICT');
    const previousDeadline = progress.stageDeadlineAt == null
      ? null : new Date(progress.stageDeadlineAt).getTime();
    const anchoredAt = previousPhase === 'preparing' && Number.isFinite(previousDeadline)
      && instant.getTime() > previousDeadline ? previousDeadline : instant.getTime();
    const seconds = progress.phase === 'preparing'
      ? task.preparationSeconds : task.responseSeconds;
    progress.stageStartedAt = iso(anchoredAt);
    progress.stageDeadlineAt = iso(Math.min(
      anchoredAt + seconds * 1_000, new Date(row.oral_deadline_at).getTime(),
    ));
  } else if (action === 'complete') {
    if (progress.phase !== 'recording') throw new EgeMockAttemptError('EGE_MOCK_ORAL_STAGE_CONFLICT');
    const stageDeadline = new Date(progress.stageDeadlineAt).getTime();
    if (instant.getTime() < stageDeadline) {
      throw new EgeMockAttemptError('EGE_MOCK_ORAL_STAGE_TOO_EARLY');
    }
    if (instant.getTime() > stageDeadline + EGE_MOCK_ORAL_STAGE_SETTLEMENT_GRACE_MS) {
      throw new EgeMockAttemptError('EGE_MOCK_ORAL_STAGE_EXPIRED');
    }
    const normalized = normalizeEgeMockOralStageRecording(row, progress, recording, instant);
    const key = `${progress.position}:${progress.responseNumber}`;
    if (progress.recordings[key]) throw new EgeMockAttemptError('EGE_MOCK_ORAL_STAGE_CONFLICT');
    progress.recordings[key] = normalized;
    advanceEgeMockOralCursor(progress);
  } else throw new EgeMockAttemptError('EGE_MOCK_ORAL_STAGE_INVALID');
  row.revision = Number(row.revision) + 1;
  row.updated_at = instant.toISOString();
  return { applied: true, replayed: false, attempt: egeMockAttemptPublicDto(row) };
}

export function applyEgeMockOralMutation(row, {
  expectedRevision, now, receiptId,
}) {
  const automatic = Boolean(row.oral_receipt?.automatic
    && ['assessment_pending', 'completed'].includes(row.state));
  if (!automatic) {
    if (row.state !== 'oral_in_progress') throw new EgeMockAttemptError('EGE_MOCK_ORAL_CLOSED');
    if (Number(expectedRevision) !== Number(row.revision)) {
      throw new EgeMockAttemptError('EGE_MOCK_REVISION_CONFLICT');
    }
    const progressRecordings = egeMockOralRecordingsFromProgress(row, row.oral_progress);
    if (!progressRecordings) throw new EgeMockAttemptError('EGE_MOCK_ORAL_NOT_READY_TO_SUBMIT');
    submitEgeMockOralPart(row, {
      now,
      payloadDigest: egeMockOralPayloadDigest(row, progressRecordings),
      receiptId,
      recordings: progressRecordings,
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
  if (row.speaking_assessment?.status === 'retryable') {
    throw new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_RETRY_NOT_ALLOWED');
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
      ...(row.speaking_assessment
        ? { speakingAssessment: egeMockSpeakingAssessmentPublicDto(row) } : {}),
    } : null;
  }
  return {
    available: true,
    state: row.state,
    keysRevealed: true,
    writingAssessment,
    ...(row.speaking_assessment
      ? { speakingAssessment: egeMockSpeakingAssessmentPublicDto(row) } : {}),
    ...assessmentRunDisposition,
    assessment: {
      status: row.assessment_status,
      retryAllowed: writingAssessment?.retryAllowed === true,
      retryCount: Number(row.assessment_retry_count),
    },
    result: {
      ...(row.result && typeof row.result === 'object' ? structuredClone(row.result) : {}),
      writing: egeMockWritingResultPublicDto(row),
      ...(row.speaking_assessment
        ? { speaking: egeMockSpeakingResultPublicDto(row) } : {}),
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
    oral_progress: structuredClone(row.oral_progress || null),
    oral_recordings: structuredClone(row.oral_recordings || {}),
    oral_receipt: structuredClone(row.oral_receipt || null),
    assessment_status: row.assessment_status,
    assessment_retry_count: Number(row.assessment_retry_count),
    writing_assessment: structuredClone(row.writing_assessment || null),
    speaking_assessment: structuredClone(row.speaking_assessment || null),
    result: structuredClone(row.result),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}
