import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceFullSpeakingStage,
  applyFullSpeakingEvaluation,
  completeFullSpeakingResponse,
  createFullSpeakingSession,
  publicFullSpeakingSession,
  selectFullSpeakingVariant,
  submitFullSpeakingSession,
} from '../speaking/full-section-session.js';
import { SPEAKING_SCORING_VERSION } from '../speaking/fipi-scoring.js';
import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';
import { AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT } from '../shared/automatic-assessment-contract.js';

const catalogs = [
  SPEAKING_TASK1_CATALOG, SPEAKING_TASK2_CATALOG,
  SPEAKING_TASK3_CATALOG, SPEAKING_TASK4_CATALOG,
];
const forbidden = /(?:reference|rubric|readyAnswer|analysis|transcript|audio|selfRating)/iu;

test('full Speaking session pins one compatible four-task variant and follows the official 1+4+5+10 lifecycle', () => {
  let now = new Date('2026-08-06T10:00:00.000Z');
  const session = createFullSpeakingSession({
    username: 'full-owner', catalogs, variantIndex: 7, selectionReason: 'unseen', now,
  });

  assert.equal(session.assignments.length, 4);
  assert.deepEqual(session.assignments.map((item) => item.task_type), [1, 2, 3, 4]);
  assert.deepEqual(session.assignments.map((item) => item.max_score), [1, 4, 5, 10]);
  assert.equal(session.maximum_score, 20);
  assert.equal(session.current_task, 1);
  assert.equal(session.current_response, 1);
  assert.equal(session.phase, 'ready');

  const assigned = publicFullSpeakingSession(session, catalogs);
  assert.equal(assigned.maximumScore, 20);
  assert.equal(assigned.earnedScore, null);
  assert.deepEqual(assigned.assessment, {
    available: false,
    reason: 'not_requested',
    message: 'Автоматическая тренировочная оценка запускается отдельно после сдачи раздела.',
  });
  assert.equal(assigned.task.taskType, 1);
  assert.equal(forbidden.test(JSON.stringify(assigned)), false);

  now = new Date('2026-08-06T10:00:01.000Z');
  advanceFullSpeakingStage(session, now);
  assert.equal(session.phase, 'preparing');
  assert.equal(new Date(session.stage_deadline_at) - now, 90_000);
  now = new Date('2026-08-06T10:00:21.000Z');
  advanceFullSpeakingStage(session, now);
  assert.equal(session.phase, 'recording');
  assert.equal(new Date(session.stage_deadline_at) - now, 90_000);
  completeFullSpeakingResponse(session, {
    responseStatus: 'completed', recordingDurationSeconds: 72,
    micCheck: 'passed', localPlayback: false, assessmentAudioSha256: 'a'.repeat(64),
  }, new Date('2026-08-06T10:01:33.000Z'));
  assert.equal(session.responses[0].entries[0].assessment_fingerprint, 'a'.repeat(64));
  assert.equal(session.current_task, 2);
  assert.equal(session.current_response, 1);
  assert.equal(session.phase, 'ready');

  const expectedResponses = { 2: 4, 3: 5, 4: 1 };
  for (const taskType of [2, 3, 4]) {
    for (let position = 1; position <= expectedResponses[taskType]; position += 1) {
      advanceFullSpeakingStage(session, now);
      if (session.phase === 'preparing') advanceFullSpeakingStage(session, now);
      completeFullSpeakingResponse(session, {
        responseStatus: taskType === 3 && position === 2 ? 'technical_issue' : 'completed',
        recordingDurationSeconds: taskType === 3 && position === 2 ? 0 : 10,
        micCheck: 'passed', localPlayback: false,
        ...(taskType === 3 && position === 2 ? { technicalIssueCode: 'recording_failed' } : {}),
      }, now);
    }
  }
  assert.equal(session.phase, 'ready_to_submit');

  const submitted = submitFullSpeakingSession(session, '75500000-0000-4000-8000-000000000001', now);
  const replayed = submitFullSpeakingSession(session, '75500000-0000-4000-8000-000000000002', new Date(now.getTime() + 1_000));
  assert.deepEqual(replayed, submitted);
  assert.equal(submitted.maximumScore, 20);
  assert.equal(submitted.earnedScore, null);
  assert.equal(submitted.assessment.available, false);
  assert.equal(submitted.taskResults.length, 4);
  assert.equal(submitted.taskResults[2].recordingStatus, 'technical_issue');
  assert.equal(forbidden.test(JSON.stringify(submitted)), false);
});

test('full Speaking restore fails closed when any pinned catalog or task revision is unavailable', () => {
  const session = createFullSpeakingSession({
    username: 'full-owner', catalogs, variantIndex: 0, selectionReason: 'unseen',
    now: new Date('2026-08-06T10:00:00.000Z'),
  });
  session.assignments[2].task_revision = 999;
  assert.throws(
    () => publicFullSpeakingSession(session, catalogs),
    { code: 'SPEAKING_FULL_CATALOG_REVISION_MISMATCH' },
  );
});

test('full Speaking old-variant rotation uses the least recently used variant after all 60 were seen', () => {
  const history = Array.from({ length: 60 }, (_, variantIndex) => ({
    variant_index: variantIndex,
    assigned_at: new Date(Date.UTC(2026, 7, 1, 0, 0, variantIndex)).toISOString(),
  }));
  const selected = [];
  for (let turn = 0; turn < 3; turn += 1) {
    const next = selectFullSpeakingVariant(catalogs, history);
    selected.push(next.variantIndex);
    history.push({
      variant_index: next.variantIndex,
      assigned_at: new Date(Date.UTC(2026, 7, 1, 0, 1, turn)).toISOString(),
    });
  }
  assert.deepEqual(selected, [0, 1, 2]);
});

test('full Speaking deadlines cannot be paused and an overdue answer becomes a technical timeout', () => {
  const assignedAt = new Date('2026-08-06T10:00:00.000Z');
  const session = createFullSpeakingSession({
    username: 'full-owner', catalogs, variantIndex: 0, selectionReason: 'unseen', now: assignedAt,
  });
  advanceFullSpeakingStage(session, new Date('2026-08-06T10:00:01.000Z'));
  const preparationDeadline = session.stage_deadline_at;

  advanceFullSpeakingStage(session, new Date('2026-08-07T10:00:01.000Z'));

  assert.equal(session.phase, 'recording');
  assert.equal(
    session.stage_deadline_at,
    new Date(new Date(preparationDeadline).getTime() + 90_000).toISOString(),
  );
  completeFullSpeakingResponse(session, {
    responseStatus: 'completed', recordingDurationSeconds: 90,
    micCheck: 'passed', localPlayback: false,
  }, new Date('2026-08-08T10:00:01.000Z'));
  assert.equal(session.responses[0].entries[0].status, 'technical_issue');
  assert.equal(session.responses[0].entries[0].technicalIssueCode, 'response_timeout');
  assert.equal(session.responses[0].entries[0].recordingDurationSeconds, 0);
  assert.equal(session.current_task, 2);
});

test('full Speaking publishes one honest approximate result from four owner-bound scored attempts', () => {
  const now = new Date('2026-08-06T10:20:00.000Z');
  const session = createFullSpeakingSession({
    username: 'full-owner', catalogs, variantIndex: 0, selectionReason: 'unseen', now,
  });
  session.responses.forEach((task) => task.entries.forEach((entry) => {
    Object.assign(entry, {
      status: 'completed', recordingDurationSeconds: 10, micCheck: 'passed',
      localPlayback: false, completedAt: now.toISOString(),
    });
  }));
  session.phase = 'ready_to_submit';
  submitFullSpeakingSession(session, '75500000-0000-4000-8000-000000000030', now);
  const attempts = session.assignments.map((assignment, index) => ({
    id: 501 + index,
    username: session.username,
    task_type: assignment.task_type,
    source_session_id: session.id,
    source_task_ref: assignment.task_id,
    source_task_revision: assignment.task_revision,
    source_catalog_id: assignment.catalog_id,
    source_catalog_revision: assignment.catalog_revision,
    status: 'completed',
    review: {
      status: 'scored', got: [1, 3, 4, 8][index], max: assignment.max_score,
      verdict: `Task ${assignment.task_type} review`, criteria: [], good: [],
      fix: index === 3 ? [{ wrong: 'People is', right: 'People are', note: 'grammar' }] : [],
      scoringVersion: SPEAKING_SCORING_VERSION,
      acousticFacts: { signalQuality: 'good', recognitionConfidence: 0.95 },
    },
  }));

  const result = applyFullSpeakingEvaluation(session, attempts, now);

  assert.equal(result.earnedScore, 16);
  assert.equal(result.maximumScore, 20);
  assert.equal(result.assessment.available, true);
  assert.equal(result.assessment.scoreKind, 'approximate');
  assert.equal(result.assessment.methodicallyValidated, false);
  assert.deepEqual(result.taskResults.map((item) => item.earnedScore), [1, 3, 4, 8]);
  assert.deepEqual(result.taskResults.map((item) => item.attemptId), [501, 502, 503, 504]);
  assert.equal(result.taskResults.every((item) => item.recordingQuality === 'good'), true);
  assert.deepEqual(result.improvementPlan.items, ['People is → People are · grammar']);
  assert.equal(publicFullSpeakingSession(session, catalogs).earnedScore, 16);
  assert.deepEqual(applyFullSpeakingEvaluation(session, attempts, now), result);
});

test('full Speaking scores skipped and technical tasks as zero without provider attempts', () => {
  const now = new Date('2026-08-06T10:20:00.000Z');
  const session = createFullSpeakingSession({
    username: 'full-owner', catalogs, variantIndex: 0, selectionReason: 'unseen', now,
  });
  session.responses.forEach((task, taskIndex) => task.entries.forEach((entry) => {
    const technical = taskIndex % 2 === 1;
    Object.assign(entry, {
      status: technical ? 'technical_issue' : 'skipped',
      recordingDurationSeconds: 0,
      micCheck: technical ? 'quiet' : 'skipped',
      localPlayback: false,
      technicalIssueCode: technical ? 'recording_failed' : null,
      completedAt: now.toISOString(),
    });
  }));
  session.phase = 'ready_to_submit';
  submitFullSpeakingSession(session, '75500000-0000-4000-8000-000000000032', now);

  const result = applyFullSpeakingEvaluation(session, [], now);

  assert.equal(result.earnedScore, 0);
  assert.equal(result.assessment.status, 'scored');
  assert.deepEqual(result.taskResults.map((item) => item.earnedScore), [0, 0, 0, 0]);
  assert.deepEqual(result.taskResults.map((item) => item.attemptId), [null, null, null, null]);
  assert.deepEqual(
    applyFullSpeakingEvaluation(session, [], new Date('2026-08-06T10:25:00.000Z')),
    result,
  );
});

test('EGE Speaking keeps incomplete evidence retryable and never invents a zero score', () => {
  const now = new Date('2026-08-06T10:20:00.000Z');
  const session = createFullSpeakingSession({
    username: 'ege-owner', catalogs, variantIndex: 0, selectionReason: 'ege_mock', now,
  });
  session.responses.forEach((task, taskIndex) => task.entries.forEach((entry) => {
    const technical = taskIndex % 2 === 1;
    Object.assign(entry, {
      status: technical ? 'technical_issue' : 'skipped', recordingDurationSeconds: 0,
      micCheck: technical ? 'quiet' : 'skipped', localPlayback: false,
      technicalIssueCode: technical ? 'recording_failed' : null,
      completedAt: now.toISOString(),
    });
  }));
  session.phase = 'ready_to_submit';
  submitFullSpeakingSession(session, '75500000-0000-4000-8000-000000000033', now);

  const result = applyFullSpeakingEvaluation(session, [], now);

  assert.equal(result.earnedScore, null);
  assert.equal(result.assessment.status, 'needs_retry');
  assert.deepEqual({
    mode: result.assessment.mode,
    scoreKind: result.assessment.scoreKind,
    warning: result.assessment.warning,
  }, AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT);
  assert.deepEqual(result.taskResults.map((item) => item.earnedScore), [null, null, null, null]);
});

test('full Speaking refuses cross-owner, wrong-task and incomplete evaluation evidence', () => {
  const now = new Date('2026-08-06T10:20:00.000Z');
  const session = createFullSpeakingSession({
    username: 'full-owner', catalogs, variantIndex: 0, selectionReason: 'unseen', now,
  });
  session.responses.forEach((task) => task.entries.forEach((entry) => {
    Object.assign(entry, { status: 'completed', recordingDurationSeconds: 10, micCheck: 'passed' });
  }));
  session.phase = 'ready_to_submit';
  submitFullSpeakingSession(session, '75500000-0000-4000-8000-000000000031', now);
  const attempts = session.assignments.map((assignment, index) => ({
    id: 601 + index, username: session.username, task_type: assignment.task_type,
    source_session_id: session.id, source_task_ref: assignment.task_id,
    source_task_revision: assignment.task_revision, source_catalog_id: assignment.catalog_id,
    source_catalog_revision: assignment.catalog_revision, status: 'completed',
    review: { status: 'scored', got: 0, max: assignment.max_score,
      scoringVersion: SPEAKING_SCORING_VERSION, acousticFacts: { signalQuality: 'good' } },
  }));

  assert.throws(
    () => applyFullSpeakingEvaluation(session, attempts.slice(0, 3), now),
    { code: 'SPEAKING_FULL_EVALUATION_INVALID' },
  );
  assert.throws(
    () => applyFullSpeakingEvaluation(session, [
      { ...attempts[0], username: 'other-owner' }, ...attempts.slice(1),
    ], now),
    { code: 'SPEAKING_FULL_EVALUATION_INVALID' },
  );
  assert.throws(
    () => applyFullSpeakingEvaluation(session, attempts.map((attempt) => ({
      ...attempt, review: { ...attempt.review, scoringVersion: 'obsolete-scoring-v1' },
    })), now),
    { code: 'SPEAKING_FULL_EVALUATION_INVALID' },
  );
});
