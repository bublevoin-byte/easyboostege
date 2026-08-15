import assert from 'node:assert/strict';
import test from 'node:test';

import { getEgeMockForm } from '../ege-mock/catalog.js';
import {
  applyEgeMockSpeakingBridgeEvaluation,
  syncEgeMockFullSpeakingSession,
} from '../ege-mock/speaking-bridge.js';
import { canonicalSpeakingLearningSource } from '../speaking/learning-loop.js';
import { reconcileEgeMockSubjectiveAssessmentState } from '../ege-mock/speaking-assessment.js';
import { egeMockSpeakingAssessmentPublicDto } from '../ege-mock/speaking-assessment.js';
import { applyEgeMockAssessmentRetryMutation } from '../ege-mock/attempt.js';
import { effectiveFullSpeakingAccentLocale } from '../speaking/full-section-session.js';

const FORM = getEgeMockForm('ege-en-2026-form-1', 1);
const ATTEMPT_ID = '1b3101dc-1811-40c0-a7b4-1328a4a8b7dd';

function submittedAttempt() {
  const recordings = {};
  for (const [position, count] of [[39, 1], [40, 4], [41, 5], [42, 1]]) {
    for (let responseNumber = 1; responseNumber <= count; responseNumber += 1) {
      const completed = !(position === 42 && responseNumber === 1);
      recordings[`${position}:${responseNumber}`] = {
        schemaVersion: 'ege-mock-oral-recording-v1',
        recordingId: `00000000-0000-4000-8000-${String(position * 10 + responseNumber).padStart(12, '0')}`,
        position, taskType: position - 38, responseNumber,
        status: completed ? 'completed' : 'technical_issue',
        durationSeconds: completed ? 10 : 0,
        sha256: completed ? String(position).padStart(64, 'a').slice(-64) : null,
        ...(completed ? {} : { technicalIssueCode: 'recording_failed' }),
        completedAt: '2026-08-15T06:15:00.000Z',
      };
    }
  }
  return {
    id: ATTEMPT_ID, username: 'owner', owner_generation: 'account:2026-08-15T00:00:00.000Z',
    form_id: FORM.id, form_revision: FORM.revision, catalog_fingerprint: FORM.fingerprint,
    state: 'assessment_pending', oral_started_at: '2026-08-15T06:00:00.000Z',
    oral_submitted_at: '2026-08-15T06:16:00.000Z',
    oral_progress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
      phase: 'ready_to_submit', stageStartedAt: null, stageDeadlineAt: null, recordings,
    },
    writing_assessment: { status: 'completed' },
    speaking_assessment: null,
    assessment_status: 'not_started', revision: 20,
  };
}

test('EGE oral bridge reuses the pinned full-speaking session and preserves upload claims on replay', () => {
  const attempt = submittedAttempt();
  const first = syncEgeMockFullSpeakingSession(null, {
    username: 'owner', attempt, form: FORM, now: new Date('2026-08-15T06:16:00.000Z'),
  });
  assert.equal(first.id, ATTEMPT_ID);
  assert.equal(first.variant_index, 12);
  assert.equal(first.selection_reason, 'ege_mock');
  assert.equal(first.status, 'submitted');
  assert.equal(first.accent_locale, null);
  assert.equal(first.accent_profile_revision, null);
  assert.equal(first.accent_effective_at, null);
  assert.equal(effectiveFullSpeakingAccentLocale(first), 'en-GB');
  assert.equal(first.responses.flatMap(({ entries }) => entries).length, 11);
  first.responses[0].entries[0].assessment_idempotency_key = first.responses[0].entries[0].recordingId;

  const replay = syncEgeMockFullSpeakingSession(first, {
    username: 'owner', attempt, form: FORM, now: new Date('2026-08-15T06:16:01.000Z'),
  });
  assert.equal(
    replay.responses[0].entries[0].assessment_idempotency_key,
    first.responses[0].entries[0].assessment_idempotency_key,
  );
});

test('EGE oral bridge preserves the accent profile pinned by its first sync', () => {
  const attempt = submittedAttempt();
  const first = syncEgeMockFullSpeakingSession(null, {
    username: 'owner', attempt, form: FORM,
    accentProfile: {
      locale: 'en-GB', revision: 3, effective_at: '2026-08-15T05:55:00.000Z',
    },
    now: new Date('2026-08-15T06:16:00.000Z'),
  });
  const replay = syncEgeMockFullSpeakingSession(first, {
    username: 'owner', attempt, form: FORM,
    accentProfile: {
      locale: 'en-US', revision: 4, effective_at: '2026-08-15T06:16:30.000Z',
    },
    now: new Date('2026-08-15T06:17:00.000Z'),
  });

  assert.deepEqual({
    locale: replay.accent_locale,
    revision: replay.accent_profile_revision,
    effectiveAt: replay.accent_effective_at,
  }, {
    locale: 'en-GB', revision: 3, effectiveAt: '2026-08-15T05:55:00.000Z',
  }, 'an in-flight EGE attempt cannot silently switch its scoring/acoustic locale');
});

test('bridge imports approximate scores but never invents zero for missing oral evidence', () => {
  const attempt = submittedAttempt();
  applyEgeMockSpeakingBridgeEvaluation(attempt, {
    assessment: { status: 'scored' },
    taskResults: [
      { taskType: 1, maximumScore: 1, earnedScore: 1, recordingStatus: 'completed' },
      { taskType: 2, maximumScore: 4, earnedScore: 3, recordingStatus: 'completed' },
      { taskType: 3, maximumScore: 5, earnedScore: 4, recordingStatus: 'completed' },
      { taskType: 4, maximumScore: 10, earnedScore: 0, recordingStatus: 'technical_issue' },
    ],
  }, new Date('2026-08-15T06:18:00.000Z'));

  assert.equal(attempt.speaking_assessment.status, 'retryable');
  assert.equal(attempt.speaking_assessment.items['42'].score, null);
  assert.equal(attempt.speaking_assessment.items['42'].status, 'retryable');
  assert.equal(attempt.state, 'assessment_pending');
  assert.equal(egeMockSpeakingAssessmentPublicDto(attempt).retryAllowed, false,
    'terminal speaking evidence cannot advertise a retry the bridge cannot replace');
  assert.throws(() => applyEgeMockAssessmentRetryMutation(attempt, {
    now: new Date('2026-08-15T06:19:00.000Z'),
  }), { code: 'EGE_MOCK_ASSESSMENT_RETRY_NOT_ALLOWED' });
});

test('terminal speaking settlement replays without mutating EGE revision or retry counters', () => {
  const attempt = submittedAttempt();
  const result = {
    assessment: { status: 'needs_retry' },
    taskResults: [
      { taskType: 1, maximumScore: 1, earnedScore: 1, recordingStatus: 'completed' },
      { taskType: 2, maximumScore: 4, earnedScore: 3, recordingStatus: 'completed' },
      { taskType: 3, maximumScore: 5, earnedScore: 4, recordingStatus: 'completed' },
      { taskType: 4, maximumScore: 10, earnedScore: null, recordingStatus: 'technical_issue' },
    ],
  };
  applyEgeMockSpeakingBridgeEvaluation(attempt, result, new Date('2026-08-15T06:18:00.000Z'));
  const settled = structuredClone(attempt);
  applyEgeMockSpeakingBridgeEvaluation(attempt, result, new Date('2026-08-15T06:19:00.000Z'));
  assert.deepEqual(attempt, settled);
});

test('speaking-first settlement stays pending until writing completes, then composite completes', () => {
  const attempt = submittedAttempt();
  attempt.writing_assessment.status = 'pending';
  applyEgeMockSpeakingBridgeEvaluation(attempt, {
    assessment: { status: 'scored' },
    taskResults: [
      { taskType: 1, maximumScore: 1, earnedScore: 1, recordingStatus: 'completed' },
      { taskType: 2, maximumScore: 4, earnedScore: 4, recordingStatus: 'completed' },
      { taskType: 3, maximumScore: 5, earnedScore: 5, recordingStatus: 'completed' },
      { taskType: 4, maximumScore: 10, earnedScore: 10, recordingStatus: 'completed' },
    ],
  }, new Date('2026-08-15T06:18:00.000Z'));
  assert.equal(attempt.state, 'assessment_pending');
  assert.equal(attempt.assessment_status, 'pending');

  attempt.writing_assessment.status = 'completed';
  reconcileEgeMockSubjectiveAssessmentState(attempt);
  assert.equal(attempt.assessment_status, 'completed');
  assert.equal(attempt.state, 'completed');
});

test('EGE mock speaking evaluation remains assisted and cannot grant mastery credit', () => {
  const session = syncEgeMockFullSpeakingSession(null, {
    username: 'owner', attempt: submittedAttempt(), form: FORM,
    now: new Date('2026-08-15T06:16:00.000Z'),
  });
  const assignment = session.assignments[0];
  const source = canonicalSpeakingLearningSource({
    sessionMode: 'full_section', sessionId: session.id,
    taskRef: assignment.task_id, taskRevision: assignment.task_revision,
    catalogId: assignment.catalog_id, catalogRevision: assignment.catalog_revision,
    accentLocale: session.accent_locale, assistanceUsed: true, targetedPractice: null,
  }, { taskType: 1, session });
  assert.equal(source.assistanceUsed, true);
});
