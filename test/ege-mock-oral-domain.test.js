import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  applyEgeMockOralMutation,
  applyEgeMockOralStageMutation,
  applyEgeMockOralStartMutation,
  createEgeMockAttempt,
  reconcileEgeMockAttempt,
  shouldSettleEgeMockOralStageBeforeReconcile,
} from '../ege-mock/attempt.js';
import { EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockForm } from '../ege-mock/catalog.js';

function oralReadyAttempt() {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const row = createEgeMockAttempt({
    id: 'f21d6f96-87e5-44e2-840c-18946d4f4415', username: 'oral-owner',
    ownerGeneration: 'account:2026-08-15T00:00:00.000Z', form, mode: 'diagnostic',
    attemptNumber: 1, idempotencyKey: crypto.randomUUID(), requestHash: 'a'.repeat(64),
    now: new Date('2026-08-15T05:00:00.000Z'),
  });
  row.state = 'oral_ready';
  row.written_submitted_at = '2026-08-15T05:30:00.000Z';
  row.oral_available_until = '2026-09-14T05:30:00.000Z';
  row.revision = 2;
  return { row, form };
}

test('oral domain owns official stages and binds one immutable response to the exact attempt', () => {
  const { row, form } = oralReadyAttempt();
  const started = applyEgeMockOralStartMutation(row, {
    expectedRevision: 2, now: new Date('2026-08-15T06:00:00.000Z'), form,
  });
  assert.deepEqual(started.attempt.oralProgress, {
    schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 1,
    phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
  });
  const preparing = applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 3, action: 'advance', position: 39, responseNumber: 1,
    now: new Date('2026-08-15T06:00:10.000Z'),
  });
  assert.equal(preparing.attempt.oralProgress.phase, 'preparing');
  assert.equal(preparing.attempt.oralProgress.stageDeadlineAt, '2026-08-15T06:01:40.000Z');

  assert.throws(() => applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 4, action: 'advance', position: 39, responseNumber: 1,
    now: new Date('2026-08-15T06:01:39.999Z'),
  }), { code: 'EGE_MOCK_ORAL_STAGE_TOO_EARLY' });

  const recording = applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 4, action: 'advance', position: 39, responseNumber: 1,
    now: new Date('2026-08-15T06:01:50.000Z'),
  });
  assert.equal(recording.attempt.oralProgress.phase, 'recording');
  assert.equal(recording.attempt.oralProgress.stageStartedAt, '2026-08-15T06:01:40.000Z');
  assert.equal(recording.attempt.oralProgress.stageDeadlineAt, '2026-08-15T06:03:10.000Z');

  const recordingId = '6d0e8916-ec2a-4a13-98f7-ad692d31acc8';
  const completed = applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 5, action: 'complete', position: 39, responseNumber: 1,
    recording: {
      recordingId, durationSeconds: 70, sha256: 'b'.repeat(64), status: 'completed',
    },
    now: new Date('2026-08-15T06:03:10.000Z'),
  });
  assert.equal(completed.attempt.oralProgress.position, 40);
  assert.equal(completed.attempt.oralProgress.responseNumber, 1);
  assert.equal(completed.attempt.oralProgress.phase, 'ready');
  assert.deepEqual(completed.attempt.oralProgress.recordings['39:1'], {
    schemaVersion: 'ege-mock-oral-recording-v1',
    recordingId, ownerGeneration: row.owner_generation, attemptId: row.id,
    formId: row.form_id, formRevision: row.form_revision,
    catalogFingerprint: row.catalog_fingerprint, position: 39, taskType: 1, responseNumber: 1,
    status: 'completed', durationSeconds: 70, sha256: 'b'.repeat(64),
    stageStartedAt: '2026-08-15T06:01:40.000Z',
    stageDeadlineAt: '2026-08-15T06:03:10.000Z',
    completedAt: '2026-08-15T06:03:10.000Z',
  });
  assert.throws(() => applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 6, action: 'complete', position: 39, responseNumber: 1,
    recording: { recordingId, durationSeconds: 70, sha256: 'b'.repeat(64), status: 'completed' },
    now: new Date('2026-08-15T06:02:56.000Z'),
  }), { code: 'EGE_MOCK_ORAL_STAGE_CONFLICT' });
});

test('oral stage cannot be completed before its fixed response deadline or long after it', () => {
  const { row, form } = oralReadyAttempt();
  applyEgeMockOralStartMutation(row, {
    expectedRevision: 2, now: new Date('2026-08-15T06:00:00.000Z'), form,
  });
  applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 3, action: 'advance', position: 39, responseNumber: 1,
    now: new Date('2026-08-15T06:00:10.000Z'),
  });
  applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 4, action: 'advance', position: 39, responseNumber: 1,
    now: new Date('2026-08-15T06:01:40.000Z'),
  });
  const recording = {
    recordingId: crypto.randomUUID(), durationSeconds: 90,
    sha256: 'd'.repeat(64), status: 'completed',
  };
  assert.throws(() => applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 5, action: 'complete', position: 39, responseNumber: 1,
    recording, now: new Date('2026-08-15T06:03:09.999Z'),
  }), { code: 'EGE_MOCK_ORAL_STAGE_TOO_EARLY' });
  assert.throws(() => applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 5, action: 'complete', position: 39, responseNumber: 1,
    recording, now: new Date('2026-08-15T06:03:15.001Z'),
  }), { code: 'EGE_MOCK_ORAL_STAGE_EXPIRED' });
});

test('server reconciliation settles a closed expired response as a technical timeout', () => {
  const { row, form } = oralReadyAttempt();
  applyEgeMockOralStartMutation(row, {
    expectedRevision: 2, now: new Date('2026-08-15T06:00:00.000Z'), form,
  });
  applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 3, action: 'advance', position: 39, responseNumber: 1,
    now: new Date('2026-08-15T06:00:10.000Z'),
  });
  const revisionBefore = row.revision;
  assert.equal(reconcileEgeMockAttempt(row, new Date('2026-08-15T06:03:15.001Z')), true);
  assert.equal(row.state, 'oral_in_progress');
  assert.equal(row.oral_progress.position, 40);
  assert.equal(row.oral_progress.phase, 'ready');
  assert.equal(row.oral_progress.recordings['39:1'].status, 'technical_issue');
  assert.equal(row.oral_progress.recordings['39:1'].technicalIssueCode, 'response_timeout');
  assert.equal(row.oral_progress.recordings['39:1'].durationSeconds, 0);
  assert.equal(row.revision, revisionBefore + 2,
    'missed preparation and response boundaries are authoritative transitions');
});

test('a forged historical observation cannot bypass the server-authoritative oral deadline', () => {
  const { row, form } = oralReadyAttempt();
  applyEgeMockOralStartMutation(row, {
    expectedRevision: 2, now: new Date('2026-08-15T06:00:00.000Z'), form,
  });
  const actualNow = new Date('2026-08-15T06:17:00.001Z');
  const forgedAdvance = {
    expectedRevision: 3, action: 'advance', position: 39, responseNumber: 1,
    observedAt: '2026-08-15T06:00:10.000Z',
  };
  assert.equal(shouldSettleEgeMockOralStageBeforeReconcile(
    row, 'oral_stage', forgedAdvance, actualNow,
  ), false);
  reconcileEgeMockAttempt(row, actualNow);
  assert.equal(row.state, 'assessment_pending');
  assert.throws(() => applyEgeMockOralStageMutation(row, {
    ...forgedAdvance, form, now: actualNow,
  }), { code: 'EGE_MOCK_ORAL_CLOSED' });
  assert.equal(Object.keys(row.oral_progress.recordings).length, 11);
  assert.equal(row.oral_progress.recordings['39:1'].technicalIssueCode,
    'oral_deadline_elapsed');
});

test('the final recording may settle at the exact overall deadline before automatic submission', () => {
  const { row, form } = oralReadyAttempt();
  applyEgeMockOralStartMutation(row, {
    expectedRevision: 2, now: new Date('2026-08-15T06:00:00.000Z'), form,
  });
  row.oral_progress = {
    schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
    phase: 'recording', stageStartedAt: '2026-08-15T06:14:00.000Z',
    stageDeadlineAt: row.oral_deadline_at, recordings: {},
  };

  const completed = applyEgeMockOralStageMutation(row, {
    form, expectedRevision: 3, action: 'complete', position: 42, responseNumber: 1,
    recording: {
      recordingId: crypto.randomUUID(), durationSeconds: 180,
      sha256: 'e'.repeat(64), status: 'completed',
    },
    now: new Date(row.oral_deadline_at),
  });

  assert.equal(completed.attempt.state, 'oral_in_progress');
  assert.equal(completed.attempt.oralProgress.phase, 'ready_to_submit');
  assert.equal(completed.attempt.oralProgress.recordings['42:1'].status, 'completed');
});

test('oral submit cannot bypass the eleven server-owned response stages', () => {
  const { row, form } = oralReadyAttempt();
  applyEgeMockOralStartMutation(row, {
    expectedRevision: 2, now: new Date('2026-08-15T06:00:00.000Z'), form,
  });
  assert.throws(() => applyEgeMockOralMutation(row, {
    expectedRevision: 3, now: new Date('2026-08-15T06:00:01.000Z'),
    receiptId: crypto.randomUUID(), recordings: {
      39: { recordingId: 'candidate-bypass', durationSeconds: 90 },
    },
  }), { code: 'EGE_MOCK_ORAL_NOT_READY_TO_SUBMIT' });
  assert.equal(row.state, 'oral_in_progress');
  assert.equal(row.speaking_assessment, null);
});

test('the exact seventeen-minute automatic close begins provisional speaking assessment', () => {
  const { row, form } = oralReadyAttempt();
  applyEgeMockOralStartMutation(row, {
    expectedRevision: 2, now: new Date('2026-08-15T06:00:00.000Z'), form,
  });
  assert.equal(reconcileEgeMockAttempt(row, new Date('2026-08-15T06:17:00.000Z')), true);
  assert.equal(row.state, 'assessment_pending');
  assert.equal(row.oral_submitted_at, '2026-08-15T06:17:00.000Z');
  assert.equal(row.speaking_assessment.status, 'pending');
  assert.equal(row.speaking_assessment.items['42'].maximum, 10);
  assert.equal(row.oral_progress.phase, 'ready_to_submit');
  assert.equal(Object.keys(row.oral_progress.recordings).length, 11);
  assert.deepEqual(Object.keys(row.oral_recordings), ['39', '40', '41', '42']);
  assert.deepEqual(
    Object.values(row.oral_recordings).map(({ entries }) => entries.length),
    [1, 4, 5, 1],
  );
  const evidence = Object.values(row.oral_recordings).flatMap(({ entries }) => entries);
  assert.equal(new Set(evidence.map(({ recordingId }) => recordingId)).size, 11);
  assert.equal(evidence.every((entry) => entry.status === 'technical_issue'
    && entry.durationSeconds === 0 && entry.sha256 === null
    && entry.technicalIssueCode === 'oral_deadline_elapsed'), true);
  const payload = {
    schemaVersion: 'ege-mock-part-payload-v1',
    operation: 'oral_submit',
    attemptId: row.id,
    ownerGeneration: row.owner_generation,
    formId: row.form_id,
    formRevision: row.form_revision,
    catalogFingerprint: row.catalog_fingerprint,
    orderedItems: [39, 40, 41, 42].map((position) => ({
      position, value: row.oral_recordings[String(position)],
    })),
  };
  assert.equal(row.oral_receipt.payloadDigest, `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(payload)).digest('hex')}`);
});

test('oral submit trusts only server-bound stage recordings and opens an honest provisional assessment', () => {
  const { row, form } = oralReadyAttempt();
  applyEgeMockOralStartMutation(row, {
    expectedRevision: 2, now: new Date('2026-08-15T06:00:00.000Z'), form,
  });
  row.oral_progress = {
    schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
    phase: 'ready_to_submit', stageStartedAt: null, stageDeadlineAt: null,
    recordings: Object.fromEntries([[39, 1], [40, 4], [41, 5], [42, 1]].flatMap(
      ([position, count]) => Array.from({ length: count }, (_, index) => {
        const responseNumber = index + 1;
        return [`${position}:${responseNumber}`, {
        schemaVersion: 'ege-mock-oral-recording-v1', recordingId: crypto.randomUUID(),
        ownerGeneration: row.owner_generation, attemptId: row.id, formId: row.form_id,
        formRevision: row.form_revision, catalogFingerprint: row.catalog_fingerprint,
        position, taskType: position - 38, responseNumber, status: 'completed',
        durationSeconds: 70, sha256: 'c'.repeat(64),
        stageStartedAt: '2026-08-15T06:00:10.000Z',
        stageDeadlineAt: '2026-08-15T06:01:40.000Z', completedAt: '2026-08-15T06:01:20.000Z',
        }];
      }),
    )),
  };
  const submitted = applyEgeMockOralMutation(row, {
    expectedRevision: 3, now: new Date('2026-08-15T06:10:00.000Z'),
    receiptId: crypto.randomUUID(), recordings: {},
  });
  assert.equal(submitted.attempt.state, 'assessment_pending');
  assert.equal(submitted.attempt.speakingAssessment.status, 'pending');
  assert.equal(submitted.attempt.speakingAssessment.label, 'Предварительная автоматическая оценка');
  assert.equal(submitted.attempt.speakingAssessment.scoreKind, 'approximate');
  assert.equal(submitted.attempt.speakingAssessment.items['41'].mode, 'experimental');
  assert.equal(submitted.attempt.speakingAssessment.items['42'].mode, 'experimental');
  assert.equal(submitted.attempt.speakingAssessment.items['39'].maximum, 1);
  assert.deepEqual(Object.keys(row.oral_recordings), ['39', '40', '41', '42']);
  assert.equal(row.oral_recordings['39'].entries[0].attemptId, row.id);
  assert.equal(row.oral_recordings['42'].entries.length, 1);
});

test('ready-to-submit persistence is rejected unless all eleven exact bound stages exist', () => {
  const { row, form } = oralReadyAttempt();
  applyEgeMockOralStartMutation(row, {
    expectedRevision: 2, now: new Date('2026-08-15T06:00:00.000Z'), form,
  });
  row.oral_progress = {
    schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
    phase: 'ready_to_submit', stageStartedAt: null, stageDeadlineAt: null,
    recordings: {},
  };
  assert.throws(() => applyEgeMockOralMutation(row, {
    expectedRevision: 3, now: new Date('2026-08-15T06:16:00.000Z'),
    receiptId: crypto.randomUUID(),
  }), { code: 'EGE_MOCK_ORAL_NOT_READY_TO_SUBMIT' });
});
