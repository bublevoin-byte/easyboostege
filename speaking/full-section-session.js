import crypto from 'node:crypto';
import {
  SPEAKING_ASSESSMENT_NOT_REQUESTED,
  speakingAssessmentNotRequested,
} from '../public/speaking-assessment-contract.js';

import {
  speakingTask1PublicAssignment,
  speakingTask2PublicAssignment,
  speakingTask3PublicAssignment,
  speakingTask4PublicAssignment,
} from '../public/speaking-catalog-contract.js';
import { combineFullSpeakingScore, SPEAKING_SCORING_VERSION } from './fipi-scoring.js';

export const FULL_SPEAKING_FORMAT = Object.freeze({
  id: 'ege-english-speaking-2026',
  revision: 1,
  source: 'FIPI EGE-2026 English speaking instructions',
  maximumScore: 20,
  tasks: Object.freeze([
    Object.freeze({ taskType: 1, responseCount: 1, preparationSeconds: 90, responseSeconds: 90, maximumScore: 1 }),
    Object.freeze({ taskType: 2, responseCount: 4, preparationSeconds: 60, responseSeconds: 20, maximumScore: 4 }),
    Object.freeze({ taskType: 3, responseCount: 5, preparationSeconds: 0, responseSeconds: 40, maximumScore: 5 }),
    Object.freeze({ taskType: 4, responseCount: 1, preparationSeconds: 150, responseSeconds: 180, maximumScore: 10 }),
  ]),
});

const publicAssignments = Object.freeze({
  1: speakingTask1PublicAssignment,
  2: speakingTask2PublicAssignment,
  3: speakingTask3PublicAssignment,
  4: speakingTask4PublicAssignment,
});

const assessmentUnavailable = () => speakingAssessmentNotRequested(
  'Автоматическая тренировочная оценка запускается отдельно после сдачи раздела.',
);
const RESPONSE_SUBMISSION_GRACE_MS = 10_000;

function fullError(code) {
  return Object.assign(new Error(code), { code });
}

function formatTask(taskType) {
  return FULL_SPEAKING_FORMAT.tasks.find((item) => item.taskType === Number(taskType));
}

function assertCatalogs(catalogs) {
  if (!Array.isArray(catalogs) || catalogs.length !== 4) {
    throw fullError('SPEAKING_FULL_CATALOG_REVISION_MISMATCH');
  }
  const catalogId = catalogs[0]?.id;
  const catalogRevision = Number(catalogs[0]?.revision);
  if (!catalogId || !Number.isInteger(catalogRevision) || catalogRevision < 1
    || catalogs.some((catalog, index) => catalog?.id !== catalogId
      || Number(catalog?.revision) !== catalogRevision
      || !Array.isArray(catalog.tasks) || catalog.tasks.length !== 60
      || catalog.tasks.some((task) => Number(task.taskType) !== index + 1))) {
    throw fullError('SPEAKING_FULL_CATALOG_REVISION_MISMATCH');
  }
  return { catalogId, catalogRevision };
}

export function selectFullSpeakingVariant(catalogs, sessions = []) {
  assertCatalogs(catalogs);
  const compatibleCount = Math.min(...catalogs.map((catalog) => catalog.tasks.length));
  const history = (sessions || []).filter((session) => Number.isInteger(Number(session.variant_index)))
    .sort((left, right) => new Date(left.assigned_at) - new Date(right.assigned_at));
  const seen = new Set(history.map((session) => Number(session.variant_index)));
  for (let index = 0; index < compatibleCount; index += 1) {
    if (!seen.has(index)) return { variantIndex: index, reason: 'unseen' };
  }
  const lastIndex = Number(history.at(-1)?.variant_index);
  const latestUse = new Map();
  history.forEach((session) => latestUse.set(
    Number(session.variant_index), new Date(session.assigned_at).getTime(),
  ));
  const candidates = Array.from({ length: compatibleCount }, (_, variantIndex) => variantIndex)
    .filter((variantIndex) => compatibleCount === 1 || variantIndex !== lastIndex)
    .sort((left, right) => (latestUse.get(left) - latestUse.get(right)) || left - right);
  return { variantIndex: candidates[0], reason: 'old' };
}

export function createFullSpeakingSession({
  username, catalogs, variantIndex, selectionReason, accentProfile = null, now = new Date(),
}) {
  const { catalogId, catalogRevision } = assertCatalogs(catalogs);
  if (!Number.isInteger(variantIndex) || variantIndex < 0 || variantIndex >= 60) {
    throw fullError('SPEAKING_FULL_VARIANT_INVALID');
  }
  const assignments = catalogs.map((catalog, index) => {
    const task = catalog.tasks[variantIndex];
    const official = FULL_SPEAKING_FORMAT.tasks[index];
    if (!task || task.taskType !== official.taskType || task.maxScore !== official.maximumScore) {
      throw fullError('SPEAKING_FULL_CATALOG_REVISION_MISMATCH');
    }
    return {
      task_type: official.taskType,
      catalog_id: catalog.id,
      catalog_revision: Number(catalog.revision),
      task_id: task.id,
      task_revision: Number(task.revision),
      max_score: official.maximumScore,
    };
  });
  const responses = FULL_SPEAKING_FORMAT.tasks.map((task) => ({
    taskType: task.taskType,
    maximumScore: task.maximumScore,
    entries: Array.from({ length: task.responseCount }, (_, index) => ({
      responseNumber: index + 1,
      status: 'pending',
      recordingDurationSeconds: null,
      micCheck: null,
      localPlayback: false,
      technicalIssueCode: null,
      completedAt: null,
      assessment_fingerprint: null,
      assessment_idempotency_key: null,
    })),
  }));
  return {
    id: crypto.randomUUID(),
    username,
    mode: 'full_section',
    format_id: FULL_SPEAKING_FORMAT.id,
    format_revision: FULL_SPEAKING_FORMAT.revision,
    catalog_id: catalogId,
    catalog_revision: catalogRevision,
    variant_index: variantIndex,
    selection_reason: selectionReason,
    accent_locale: accentProfile?.locale || null,
    accent_profile_revision: accentProfile?.revision == null ? null : Number(accentProfile.revision),
    accent_effective_at: accentProfile?.effective_at || null,
    maximum_score: FULL_SPEAKING_FORMAT.maximumScore,
    assignments,
    responses,
    status: 'in_progress',
    phase: 'ready',
    current_task: 1,
    current_response: 1,
    stage_started_at: null,
    stage_deadline_at: null,
    assigned_at: new Date(now).toISOString(),
    submitted_at: null,
    submission_key: null,
    submission_response: null,
  };
}

export function advanceFullSpeakingStage(session, now = new Date()) {
  const previousPhase = session.phase;
  const previousDeadline = session.stage_deadline_at;
  if (session.phase === 'preparing') {
    session.phase = 'recording';
  } else if (session.phase === 'ready') {
    const task = formatTask(session.current_task);
    const needsPreparation = Number(session.current_response) === 1 && task.preparationSeconds > 0;
    session.phase = needsPreparation ? 'preparing' : 'recording';
  } else if (session.phase === 'recording') {
    return session;
  } else {
    throw fullError('SPEAKING_FULL_STAGE_INVALID');
  }
  const task = formatTask(session.current_task);
  const seconds = session.phase === 'preparing' ? task.preparationSeconds : task.responseSeconds;
  const requestedAt = new Date(now);
  const preparationExpired = previousPhase === 'preparing'
    && previousDeadline && requestedAt.getTime() > new Date(previousDeadline).getTime();
  const startedAt = preparationExpired ? new Date(previousDeadline) : requestedAt;
  session.stage_started_at = startedAt.toISOString();
  session.stage_deadline_at = new Date(startedAt.getTime() + seconds * 1_000).toISOString();
  return session;
}

export function completeFullSpeakingResponse(session, completion, now = new Date()) {
  const task = formatTask(session.current_task);
  const response = session.responses
    .find((item) => item.taskType === task.taskType)?.entries[Number(session.current_response) - 1];
  if (!response || session.phase !== 'recording') throw fullError('SPEAKING_FULL_RESPONSE_OUT_OF_SEQUENCE');
  if (response.status !== 'pending') return session;
  const completedAt = new Date(now);
  const responseExpired = session.stage_deadline_at
    && completedAt.getTime() > new Date(session.stage_deadline_at).getTime() + RESPONSE_SUBMISSION_GRACE_MS;
  const effectiveCompletion = responseExpired ? {
    responseStatus: 'technical_issue',
    recordingDurationSeconds: 0,
    micCheck: completion.micCheck,
    localPlayback: false,
    technicalIssueCode: 'response_timeout',
  } : completion;
  const duration = Number(effectiveCompletion.recordingDurationSeconds);
  const responseStatus = effectiveCompletion.responseStatus;
  const issue = effectiveCompletion.technicalIssueCode || null;
  const assessmentAudioSha256 = effectiveCompletion.assessmentAudioSha256 || null;
  if (!['completed', 'skipped', 'technical_issue'].includes(responseStatus)
    || !Number.isFinite(duration) || duration < 0 || duration > task.responseSeconds
    || (responseStatus === 'completed' && duration < 1)
    || (responseStatus !== 'completed' && duration !== 0)
    || !['passed', 'quiet', 'skipped'].includes(effectiveCompletion.micCheck)
    || effectiveCompletion.localPlayback !== false
    || (responseStatus === 'technical_issue' && !issue)
    || (responseStatus !== 'technical_issue' && issue)
    || (assessmentAudioSha256 !== null
      && (responseStatus !== 'completed' || !/^[0-9a-f]{64}$/u.test(assessmentAudioSha256)))) {
    throw fullError('SPEAKING_FULL_RESPONSE_INVALID');
  }
  Object.assign(response, {
    status: responseStatus,
    recordingDurationSeconds: duration,
    micCheck: effectiveCompletion.micCheck,
    localPlayback: false,
    technicalIssueCode: issue,
    completedAt: completedAt.toISOString(),
    assessment_fingerprint: assessmentAudioSha256,
    assessment_idempotency_key: null,
  });
  session.stage_started_at = null;
  session.stage_deadline_at = null;
  if (Number(session.current_response) < task.responseCount) {
    session.current_response += 1;
    session.phase = 'ready';
  } else if (Number(session.current_task) < 4) {
    session.current_task += 1;
    session.current_response = 1;
    session.phase = 'ready';
  } else {
    session.phase = 'ready_to_submit';
  }
  return session;
}

export function claimFullSpeakingResponseAssessment(session, {
  taskType, responseNumber, audioSha256, idempotencyKey, durationSeconds,
}) {
  if (session.status !== 'submitted') throw fullError('SPEAKING_FULL_NOT_SUBMITTED');
  const entry = session.responses?.find((item) => Number(item.taskType) === Number(taskType))
    ?.entries?.find((item) => Number(item.responseNumber) === Number(responseNumber));
  if (entry?.status !== 'completed') throw fullError('SPEAKING_FULL_RESPONSE_NOT_RECORDED');
  const duration = Number(durationSeconds);
  if (!/^[0-9a-f]{64}$/u.test(String(audioSha256 || ''))
    || entry.assessment_fingerprint !== audioSha256
    || !Number.isFinite(duration)
    || Math.abs(Number(entry.recordingDurationSeconds) - duration) > 1) {
    throw fullError('SPEAKING_FULL_RESPONSE_ASSESSMENT_MISMATCH');
  }
  if (entry.assessment_idempotency_key && entry.assessment_idempotency_key !== idempotencyKey) {
    throw fullError('SPEAKING_FULL_RESPONSE_ASSESSMENT_CONFLICT');
  }
  entry.assessment_idempotency_key = idempotencyKey;
  return session;
}

function recordingStatus(entries) {
  if (entries.some((entry) => entry.status === 'technical_issue')) return 'technical_issue';
  if (entries.some((entry) => entry.status === 'skipped')) return 'skipped';
  if (entries.every((entry) => entry.status === 'completed')) return 'completed';
  if (entries.some((entry) => entry.status !== 'pending')) return 'in_progress';
  return 'pending';
}

function publicProgress(session) {
  return session.responses.map((task) => ({
    taskType: task.taskType,
    maximumScore: task.maximumScore,
    responseCount: task.entries.length,
    completedResponses: task.entries.filter((entry) => entry.status !== 'pending').length,
    status: recordingStatus(task.entries),
    responses: task.entries.map((entry) => ({
      responseNumber: entry.responseNumber,
      status: entry.status,
      ...(entry.status === 'pending' ? {} : {
        recordingDurationSeconds: Number(entry.recordingDurationSeconds),
        micCheck: entry.micCheck,
        localPlayback: false,
        ...(entry.technicalIssueCode ? { technicalIssueCode: entry.technicalIssueCode } : {}),
        completedAt: new Date(entry.completedAt).toISOString(),
      }),
    })),
  }));
}

function resolveCurrentTask(session, catalogs) {
  if (!['ready', 'preparing', 'recording'].includes(session.phase)) return null;
  const assignment = session.assignments.find((item) => item.task_type === Number(session.current_task));
  const catalog = catalogs[Number(session.current_task) - 1];
  if (!assignment || !catalog || assignment.catalog_id !== catalog.id
    || Number(assignment.catalog_revision) !== Number(catalog.revision)) {
    throw fullError('SPEAKING_FULL_CATALOG_REVISION_MISMATCH');
  }
  const task = catalog.tasks.find((candidate) => candidate.id === assignment.task_id
    && Number(candidate.revision) === Number(assignment.task_revision));
  if (!task) throw fullError('SPEAKING_FULL_CATALOG_REVISION_MISMATCH');
  return publicAssignments[assignment.task_type](task);
}

function assertPinnedAssignments(session, catalogs) {
  for (const assignment of session.assignments) {
    const catalog = catalogs[Number(assignment.task_type) - 1];
    const task = catalog?.tasks.find((candidate) => candidate.id === assignment.task_id
      && Number(candidate.revision) === Number(assignment.task_revision));
    if (!catalog || assignment.catalog_id !== catalog.id
      || Number(assignment.catalog_revision) !== Number(catalog.revision) || !task) {
      throw fullError('SPEAKING_FULL_CATALOG_REVISION_MISMATCH');
    }
  }
}

export function assertFullSpeakingSessionCompatibility(session, catalogs) {
  const { catalogId, catalogRevision } = assertCatalogs(catalogs);
  if (session.catalog_id !== catalogId || Number(session.catalog_revision) !== catalogRevision
    || session.format_id !== FULL_SPEAKING_FORMAT.id
    || Number(session.format_revision) !== FULL_SPEAKING_FORMAT.revision
    || !Array.isArray(session.assignments) || session.assignments.length !== 4
    || session.assignments.some((assignment, index) => assignment.task_type !== index + 1
      || assignment.max_score !== FULL_SPEAKING_FORMAT.tasks[index].maximumScore)) {
    throw fullError('SPEAKING_FULL_CATALOG_REVISION_MISMATCH');
  }
  assertPinnedAssignments(session, catalogs);
  return { catalogId, catalogRevision };
}

export function abandonFullSpeakingSession(session) {
  if (session.status !== 'in_progress') return session;
  session.status = 'abandoned';
  session.phase = 'abandoned';
  session.stage_started_at = null;
  session.stage_deadline_at = null;
  return session;
}

export function publicFullSpeakingSession(session, catalogs) {
  assertFullSpeakingSessionCompatibility(session, catalogs);
  const task = resolveCurrentTask(session, catalogs);
  return {
    id: session.id,
    mode: 'full_section',
    format: {
      id: FULL_SPEAKING_FORMAT.id,
      revision: FULL_SPEAKING_FORMAT.revision,
      source: FULL_SPEAKING_FORMAT.source,
    },
    catalog: { id: session.catalog_id, revision: Number(session.catalog_revision) },
    selectionReason: session.selection_reason,
    accentProfile: session.accent_locale ? {
      locale: session.accent_locale,
      revision: Number(session.accent_profile_revision),
      effectiveAt: new Date(session.accent_effective_at).toISOString(),
    } : null,
    status: session.status,
    phase: session.phase,
    current: task ? {
      taskType: Number(session.current_task),
      responseNumber: Number(session.current_response),
      stageStartedAt: session.stage_started_at ? new Date(session.stage_started_at).toISOString() : null,
      stageDeadlineAt: session.stage_deadline_at ? new Date(session.stage_deadline_at).toISOString() : null,
    } : null,
    task,
    progress: publicProgress(session),
    maximumScore: 20,
    earnedScore: session.submission_response?.earnedScore ?? null,
    assessment: session.submission_response?.assessment
      ? structuredClone(session.submission_response.assessment) : assessmentUnavailable(),
    assignedAt: new Date(session.assigned_at).toISOString(),
    submittedAt: session.submitted_at ? new Date(session.submitted_at).toISOString() : null,
    ...(session.submission_response ? { submission: structuredClone(session.submission_response) } : {}),
  };
}

export function submitFullSpeakingSession(session, idempotencyKey, now = new Date()) {
  if (session.submission_response) return structuredClone(session.submission_response);
  if (session.phase !== 'ready_to_submit') throw fullError('SPEAKING_FULL_NOT_READY_TO_SUBMIT');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(idempotencyKey)) {
    throw fullError('SPEAKING_FULL_SUBMISSION_INVALID');
  }
  const submittedAt = new Date(now).toISOString();
  const snapshot = {
    status: 'submitted',
    maximumScore: 20,
    earnedScore: null,
    assessment: assessmentUnavailable(),
    taskResults: session.responses.map((task) => ({
      taskType: task.taskType,
      maximumScore: task.maximumScore,
      earnedScore: null,
      recordingStatus: recordingStatus(task.entries),
      usedSeconds: task.entries.reduce((total, entry) => total + Number(entry.recordingDurationSeconds || 0), 0),
    })),
    improvementPlan: {
      available: false,
      reason: SPEAKING_ASSESSMENT_NOT_REQUESTED,
      message: 'План улучшения появится после автоматической тренировочной оценки.',
    },
    submittedAt,
  };
  session.status = 'submitted';
  session.phase = 'submitted';
  session.submitted_at = submittedAt;
  session.submission_key = idempotencyKey;
  session.submission_response = structuredClone(snapshot);
  return structuredClone(snapshot);
}

function fullEvaluationInvalid() {
  return fullError('SPEAKING_FULL_EVALUATION_INVALID');
}

function safeReview(review) {
  return {
    status: review.status,
    got: review.got ?? null,
    max: review.max,
    verdict: String(review.verdict || '').slice(0, 600),
    criteria: structuredClone(Array.isArray(review.criteria) ? review.criteria.slice(0, 5) : []),
    good: structuredClone(Array.isArray(review.good) ? review.good.slice(0, 3) : []),
    fix: structuredClone(Array.isArray(review.fix) ? review.fix.slice(0, 4) : []),
    needsRetryReason: review.needsRetryReason || null,
    scoringVersion: review.scoringVersion,
  };
}

function improvementItems(attempts) {
  const items = attempts.flatMap((attempt) => (
    Array.isArray(attempt?.review?.fix) ? attempt.review.fix : []
  )).flatMap((item) => {
    const wrong = String(item?.wrong || '').trim();
    const right = String(item?.right || '').trim();
    const note = String(item?.note || '').trim();
    if (!wrong && !right && !note) return [];
    return [`${wrong}${wrong && right ? ' → ' : ''}${right}${note ? ` · ${note}` : ''}`.slice(0, 700)];
  });
  const unique = [...new Set(items)].slice(0, 6);
  return unique.length ? unique : ['Сохраняй экзаменационный темп и повтори полный вариант с новым комплектом заданий.'];
}

export function applyFullSpeakingEvaluation(session, attempts, now = new Date()) {
  if (session?.status !== 'submitted' || session.phase !== 'submitted'
    || !session.submission_response || !Array.isArray(attempts)) throw fullEvaluationInvalid();
  const currentAttemptIds = session.submission_response.taskResults
    ?.flatMap((item) => Number.isSafeInteger(Number(item.attemptId)) && Number(item.attemptId) > 0
      ? [Number(item.attemptId)] : []) || [];
  const requestedAttemptIds = attempts.map((attempt) => Number(attempt?.id)).sort((a, b) => a - b);
  const alreadyEvaluated = ['scored', 'needs_retry']
    .includes(session.submission_response.assessment?.status);
  if (alreadyEvaluated) {
    const storedAttemptIds = [...currentAttemptIds].sort((a, b) => a - b);
    if (JSON.stringify(storedAttemptIds) !== JSON.stringify(requestedAttemptIds)) {
      throw fullEvaluationInvalid();
    }
    return structuredClone(session.submission_response);
  }

  const attemptByTask = new Map();
  attempts.forEach((attempt) => {
    const taskType = Number(attempt?.task_type);
    if (attemptByTask.has(taskType)) throw fullEvaluationInvalid();
    attemptByTask.set(taskType, attempt);
  });
  const scored = [];
  const taskResults = session.responses.map((response, index) => {
    const assignment = session.assignments[index];
    const taskType = Number(response.taskType);
    const allCompleted = response.entries.every((entry) => entry.status === 'completed');
    const attempt = attemptByTask.get(taskType);
    if (!allCompleted) {
      if (attempt) throw fullEvaluationInvalid();
      scored.push({ taskType, status: 'scored', score: 0, maxScore: assignment.max_score });
      return {
        ...session.submission_response.taskResults[index], earnedScore: 0, attemptId: null,
        assessmentStatus: 'not_assessed', recordingQuality: 'unavailable', review: null,
      };
    }
    const review = attempt?.review;
    if (!attempt || !Number.isSafeInteger(Number(attempt.id))
      || attempt.username !== session.username || Number(attempt.task_type) !== taskType
      || attempt.source_session_id !== session.id
      || attempt.source_task_ref !== assignment.task_id
      || Number(attempt.source_task_revision) !== Number(assignment.task_revision)
      || attempt.source_catalog_id !== assignment.catalog_id
      || Number(attempt.source_catalog_revision) !== Number(assignment.catalog_revision)
      || !['completed', 'needs_retry'].includes(attempt.status)
      || !review || !['scored', 'needs_retry'].includes(review.status)
      || Number(review.max) !== Number(assignment.max_score)
      || typeof review.scoringVersion !== 'string') throw fullEvaluationInvalid();
    const isScored = attempt.status === 'completed' && review.status === 'scored';
    if (isScored && (!Number.isInteger(review.got) || review.got < 0
      || review.got > assignment.max_score)) throw fullEvaluationInvalid();
    if (!isScored && review.got != null) throw fullEvaluationInvalid();
    scored.push({
      taskType, status: isScored ? 'scored' : 'needs_retry',
      score: isScored ? review.got : null, maxScore: assignment.max_score,
    });
    return {
      ...session.submission_response.taskResults[index],
      earnedScore: isScored ? review.got : null,
      attemptId: Number(attempt.id),
      assessmentStatus: review.status,
      recordingQuality: review.acousticFacts?.signalQuality || 'unavailable',
      review: safeReview(review),
    };
  });
  if (attemptByTask.size !== attempts.length || attempts.some((attempt) => (
    !session.responses.some((response) => Number(response.taskType) === Number(attempt.task_type))
  ))) throw fullEvaluationInvalid();

  const combined = combineFullSpeakingScore(scored);
  const scoringVersions = [...new Set(attempts.map((attempt) => attempt.review?.scoringVersion))];
  if (attempts.length > 0
    && (scoringVersions.length !== 1 || scoringVersions[0] !== SPEAKING_SCORING_VERSION)) {
    throw fullEvaluationInvalid();
  }
  const evaluatedAt = new Date(now);
  if (!Number.isFinite(evaluatedAt.getTime())) throw fullEvaluationInvalid();
  const scoredSuccessfully = combined.status === 'scored';
  const snapshot = {
    ...session.submission_response,
    earnedScore: scoredSuccessfully ? combined.score : null,
    taskResults,
    assessment: {
      available: scoredSuccessfully,
      status: combined.status,
      mode: 'automatic_training',
      scoreKind: 'approximate',
      methodicallyValidated: false,
      scoringVersion: combined.scoringVersion,
      warning: 'Автоматическая тренировочная оценка. Балл примерный и не является экспертным заключением или точным баллом ЕГЭ.',
      ...(scoredSuccessfully ? {} : {
        reason: 'evidence_needs_retry',
        message: 'Качества одной или нескольких записей недостаточно для надёжного общего балла.',
      }),
      evaluatedAt: evaluatedAt.toISOString(),
    },
    improvementPlan: scoredSuccessfully ? {
      available: true,
      items: improvementItems(attempts),
    } : {
      available: false,
      reason: 'evidence_needs_retry',
      message: 'Перезапиши задания с недостаточным качеством сигнала, чтобы получить общий план.',
    },
  };
  session.submission_response = structuredClone(snapshot);
  return structuredClone(snapshot);
}
