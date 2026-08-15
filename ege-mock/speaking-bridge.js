import crypto from 'node:crypto';

import {
  SPEAKING_TASK1_CATALOG,
} from '../public/content/speaking/task1-v1.js';
import {
  SPEAKING_TASK2_CATALOG,
} from '../public/content/speaking/task2-v1.js';
import {
  SPEAKING_TASK3_CATALOG,
} from '../public/content/speaking/task3-v1.js';
import {
  SPEAKING_TASK4_CATALOG,
} from '../public/content/speaking/task4-v1.js';
import {
  createFullSpeakingSession,
  submitFullSpeakingSession,
} from '../speaking/full-section-session.js';
import {
  beginEgeMockSpeakingAssessment,
  reconcileEgeMockSubjectiveAssessmentState,
} from './speaking-assessment.js';
import {
  EGE_MOCK_ORAL_TASK_BY_POSITION,
  EGE_MOCK_ORAL_TASK_BY_TYPE,
  EGE_MOCK_ORAL_TASKS,
} from '../shared/ege-mock-oral-contract.js';

const CATALOGS = Object.freeze([
  SPEAKING_TASK1_CATALOG, SPEAKING_TASK2_CATALOG,
  SPEAKING_TASK3_CATALOG, SPEAKING_TASK4_CATALOG,
]);

function bridgeError() {
  return Object.assign(new Error('EGE_MOCK_SPEAKING_BRIDGE_INVALID'), {
    code: 'EGE_MOCK_SPEAKING_BRIDGE_INVALID',
  });
}

function exactVariant(form) {
  const indexes = EGE_MOCK_ORAL_TASKS.map(({ position }, catalogIndex) => {
    const reference = form?.positions?.[position - 1]?.contentRef;
    return CATALOGS[catalogIndex].tasks.findIndex((task) => (
      task.id === reference?.id && Number(task.revision) === Number(reference?.revision)
    ));
  });
  if (indexes.some((index) => index < 0) || new Set(indexes).size !== 1) throw bridgeError();
  return indexes[0];
}

function claimsByResponse(session) {
  return new Map((session?.responses || []).flatMap(({ taskType, entries }) => (
    (entries || []).map((entry) => [
      `${taskType}:${entry.responseNumber}`,
      entry.assessment_idempotency_key || null,
    ])
  )));
}

function applyRecordings(session, progress, previousClaims) {
  for (const task of session.responses) {
    for (const entry of task.entries) {
      const position = EGE_MOCK_ORAL_TASK_BY_TYPE[task.taskType]?.position;
      const key = `${position}:${entry.responseNumber}`;
      const recording = progress?.recordings?.[key];
      if (!recording) continue;
      Object.assign(entry, {
        recordingId: recording.recordingId,
        status: recording.status,
        recordingDurationSeconds: Number(recording.durationSeconds),
        micCheck: 'skipped',
        localPlayback: false,
        technicalIssueCode: recording.technicalIssueCode || null,
        completedAt: new Date(recording.completedAt).toISOString(),
        assessment_fingerprint: recording.status === 'completed' ? recording.sha256 : null,
        assessment_idempotency_key: previousClaims.get(
          `${task.taskType}:${entry.responseNumber}`,
        ) || null,
      });
    }
  }
}

export function syncEgeMockFullSpeakingSession(existing, {
  username, attempt, form, accentProfile = null, now = new Date(),
}) {
  if (!username || attempt?.id == null || attempt.form_id !== form?.id
    || Number(attempt.form_revision) !== Number(form?.revision)
    || attempt.catalog_fingerprint !== form?.fingerprint
    || !attempt.oral_progress) throw bridgeError();
  const previousClaims = claimsByResponse(existing);
  const pinnedAccentProfile = existing ? {
    locale: existing.accent_locale,
    revision: existing.accent_profile_revision,
    effective_at: existing.accent_effective_at,
  } : accentProfile;
  const session = createFullSpeakingSession({
    username,
    catalogs: CATALOGS,
    variantIndex: exactVariant(form),
    selectionReason: 'ege_mock',
    accentProfile: pinnedAccentProfile,
    now: attempt.oral_started_at || now,
  });
  session.id = attempt.id;
  applyRecordings(session, attempt.oral_progress, previousClaims);
  const progress = attempt.oral_progress;
  session.current_task = EGE_MOCK_ORAL_TASK_BY_POSITION[progress.position]?.taskType;
  session.current_response = Number(progress.responseNumber);
  session.phase = progress.phase;
  session.stage_started_at = progress.stageStartedAt || null;
  session.stage_deadline_at = progress.stageDeadlineAt || null;
  const submitted = ['assessment_pending', 'completed'].includes(attempt.state)
    || attempt.oral_submitted_at != null;
  if (submitted) {
    session.phase = 'ready_to_submit';
    submitFullSpeakingSession(session, attempt.id, attempt.oral_submitted_at || now);
    if (attempt.speaking_assessment?.settlement_fingerprint
      && existing?.submission_response?.assessment
      && ['scored', 'needs_retry'].includes(existing.submission_response.assessment.status)) {
      session.submission_response = structuredClone(existing.submission_response);
    }
  }
  return session;
}

export function applyEgeMockSpeakingBridgeEvaluation(row, result, now = new Date()) {
  if (!row || !Array.isArray(result?.taskResults)
    || result.taskResults.length !== EGE_MOCK_ORAL_TASKS.length) {
    throw bridgeError();
  }
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw bridgeError();
  const settlementFingerprint = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    assessmentStatus: result.assessment?.status || null,
    taskResults: result.taskResults.map((item) => ({
      taskType: Number(item.taskType), maximumScore: Number(item.maximumScore),
      earnedScore: item.earnedScore == null ? null : Number(item.earnedScore),
      recordingStatus: item.recordingStatus || null,
    })).sort((left, right) => left.taskType - right.taskType),
  })).digest('hex')}`;
  if (row.speaking_assessment?.settlement_fingerprint) {
    if (row.speaking_assessment.settlement_fingerprint !== settlementFingerprint) throw bridgeError();
    return row;
  }
  beginEgeMockSpeakingAssessment(row, instant);
  let retryable = false;
  for (const item of result.taskResults) {
    const task = EGE_MOCK_ORAL_TASK_BY_TYPE[Number(item.taskType)];
    const position = task?.position;
    const target = row.speaking_assessment.items[String(position)];
    if (!target || Number(item.maximumScore) !== task.maximumScore) throw bridgeError();
    const scored = item.recordingStatus === 'completed'
      && Number.isInteger(item.earnedScore)
      && item.earnedScore >= 0 && item.earnedScore <= task.maximumScore;
    if (!scored) retryable = true;
    Object.assign(target, {
      status: scored ? 'completed' : 'retryable',
      score: scored ? Number(item.earnedScore) : null,
      error_code: scored ? null : 'evidence_needs_retry',
    });
  }
  row.speaking_assessment.status = retryable ? 'retryable' : 'completed';
  row.speaking_assessment.settlement_fingerprint = settlementFingerprint;
  row.speaking_assessment.retry_count = retryable
    ? Number(row.speaking_assessment.retry_count || 0) + 1
    : Number(row.speaking_assessment.retry_count || 0);
  row.speaking_assessment.updated_at = instant.toISOString();
  reconcileEgeMockSubjectiveAssessmentState(row);
  row.revision = Number(row.revision) + 1;
  row.updated_at = instant.toISOString();
  return row;
}

export { CATALOGS as EGE_MOCK_SPEAKING_CATALOGS };
