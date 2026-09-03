import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockForm } from '../ege-mock/catalog.js';
import { createFileRepository } from '../storage/file-repository.js';
import { AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT } from '../public/automatic-assessment-contract.js';
import {
  assertEgeMockAssessmentRevisionExhaustionContract,
  assertEgeMockAssessmentRunSubscriptionContract,
  assertEgeMockAttemptRepositoryContract,
  assertEgeMockOralStageRepositoryContract,
  completeEgeMockOralStageLedger,
} from './support/ege-mock-attempt-contract.js';

const START_KEY = 'd250e109-6b0c-4ccd-9c47-c80bdf0627b4';

test('EGE mock domain owns every pure lifecycle mutation used by storage adapters', async () => {
  const domain = await import('../ege-mock/attempt.js');
  for (const operation of [
    'applyEgeMockDraftMutation',
    'applyEgeMockWrittenMutation',
    'applyEgeMockOralStartMutation',
    'applyEgeMockOralMutation',
    'applyEgeMockAssessmentRetryable',
    'applyEgeMockAssessmentRetryMutation',
    'egeMockStartDecision',
  ]) assert.equal(typeof domain[operation], 'function', operation);
  for (const internal of [
    'EGE_MOCK_WRITTEN_DURATION_MS',
    'EGE_MOCK_ORAL_START_WINDOW_MS',
    'EGE_MOCK_ORAL_DURATION_MS',
    'normalizeEgeMockDraft',
    'egeMockWrittenPayloadDigest',
    'egeMockOralPayloadDigest',
    'submitEgeMockWrittenPart',
    'startEgeMockOralPart',
    'normalizeEgeMockOralRecordings',
    'submitEgeMockOralPart',
  ]) assert.equal(Object.hasOwn(domain, internal), false, internal);
});

test('one pure domain policy owns assessment-run begin, rejection, settlement and replay decisions', async () => {
  const {
    applyEgeMockAssessmentRunDisposition,
    egeMockAssessmentRunBeginDecision,
    egeMockAssessmentRunCanSettleTerminalSnapshot,
    egeMockAssessmentRunSettlement,
  } = await import('../ege-mock/assessment-run-command.js');
  const attempt = {
    id: '9ed93fa6-29c0-47b0-a86e-2234a2255a44',
    writingAssessment: { status: 'pending' },
  };
  const active = egeMockAssessmentRunBeginDecision({
    responseSnapshot: null, attempt, subscriptionActive: true, hasFrozenAuthorization: false,
  });
  assert.deepEqual(active, {
    kind: 'start', finalized: false, responseSnapshot: { commandStatus: 'pending' },
  });
  assert.equal(egeMockAssessmentRunCanSettleTerminalSnapshot({
    responseSnapshot: active.responseSnapshot, attempt,
  }), false);
  assert.equal(egeMockAssessmentRunCanSettleTerminalSnapshot({
    responseSnapshot: active.responseSnapshot,
    attempt: { ...attempt, writingAssessment: { status: 'retryable' } },
  }), true, 'only an existing pending UUID with a terminal assessment bypasses revision mutation');
  const blockedAttempt = {
    ...attempt,
    writingAssessment: { ...attempt.writingAssessment, runDisposition: 'subscription_required' },
  };
  const staleAfterRenewal = egeMockAssessmentRunBeginDecision({
    responseSnapshot: { commandStatus: 'pending' }, attempt: blockedAttempt,
    subscriptionActive: true, hasFrozenAuthorization: false, explicitRenewal: false,
  });
  assert.equal(staleAfterRenewal.kind, 'finalize');
  assert.equal(staleAfterRenewal.response.disposition, 'subscription_required',
    'a stale pre-block UUID cannot resume merely because entitlement was renewed');
  const unmarkedAfterRenewal = egeMockAssessmentRunBeginDecision({
    responseSnapshot: null, attempt: blockedAttempt,
    subscriptionActive: true, hasFrozenAuthorization: false, explicitRenewal: false,
  });
  assert.equal(unmarkedAfterRenewal.kind, 'finalize',
    'a fresh UUID without the explicit renewal marker cannot clear the durable block');
  const explicitAfterRenewal = egeMockAssessmentRunBeginDecision({
    responseSnapshot: null, attempt: blockedAttempt,
    subscriptionActive: true, hasFrozenAuthorization: false, explicitRenewal: true,
  });
  assert.deepEqual(explicitAfterRenewal, {
    kind: 'start', finalized: false, responseSnapshot: { commandStatus: 'pending' },
  });
  const durable = {
    writing_assessment: { status: 'pending', run_disposition: 'subscription_required' },
    updated_at: '2026-08-13T06:00:00.000Z',
  };
  assert.equal(applyEgeMockAssessmentRunDisposition(durable, explicitAfterRenewal, {
    now: new Date('2026-08-13T06:01:00.000Z'),
  }), true);
  assert.equal(durable.writing_assessment.run_disposition, undefined,
    'a new accepted command after renewal explicitly clears the terminal block');
  assert.equal(durable.writing_assessment.assessment_revision, 1);
  assert.deepEqual(egeMockAssessmentRunBeginDecision({
    responseSnapshot: { commandStatus: 'pending' }, attempt,
    subscriptionActive: false, hasFrozenAuthorization: true,
  }), { kind: 'resume', finalized: false });

  const rejected = egeMockAssessmentRunBeginDecision({
    responseSnapshot: { commandStatus: 'pending' }, attempt,
    subscriptionActive: false, hasFrozenAuthorization: false,
  });
  assert.equal(rejected.kind, 'finalize');
  assert.equal(rejected.finalized, true);
  assert.deepEqual(rejected.response, {
    applied: true, replayed: false, disposition: 'subscription_required',
    attempt: {
      ...attempt,
      writingAssessment: {
        ...attempt.writingAssessment, assessmentRevision: 1,
        runDisposition: 'subscription_required',
      },
    },
  });
  assert.equal(applyEgeMockAssessmentRunDisposition(durable, rejected, {
    now: new Date('2026-08-13T06:02:00.000Z'),
  }), true);
  assert.equal(durable.writing_assessment.run_disposition, 'subscription_required');
  assert.equal(durable.writing_assessment.assessment_revision, 2);
  assert.deepEqual(rejected.responseSnapshot, rejected.response);
  assert.deepEqual(egeMockAssessmentRunBeginDecision({
    responseSnapshot: rejected.responseSnapshot, attempt: null,
    subscriptionActive: false, hasFrozenAuthorization: false,
  }), {
    kind: 'replay', finalized: true,
    response: { ...rejected.response, applied: true, replayed: true },
  });

  assert.deepEqual(egeMockAssessmentRunSettlement({
    responseSnapshot: { commandStatus: 'pending' }, attempt,
  }), {
    kind: 'pending', persistAttempt: false,
    response: { applied: false, replayed: false, attempt },
  });
  const completedAttempt = { ...attempt, writingAssessment: { status: 'completed' } };
  assert.deepEqual(egeMockAssessmentRunSettlement({
    responseSnapshot: { commandStatus: 'pending' }, attempt: completedAttempt,
  }), {
    kind: 'finalize', persistAttempt: false,
    response: { applied: true, replayed: false, attempt: completedAttempt },
  });
});

test('assessment revision reaches MAX_SAFE_INTEGER once and then fails before any disposition mutation', async () => {
  const {
    applyEgeMockAssessmentRunDisposition,
    egeMockAssessmentRunBeginDecision,
  } = await import('../ege-mock/assessment-run-command.js');
  const almostExhausted = {
    writing_assessment: {
      status: 'pending', assessment_revision: Number.MAX_SAFE_INTEGER - 1,
      run_disposition: 'subscription_required',
    },
    updated_at: '2026-08-13T06:00:00.000Z',
  };
  const explicit = egeMockAssessmentRunBeginDecision({
    attempt: {
      id: '9ed93fa6-29c0-47b0-a86e-2234a2255a45',
      writingAssessment: {
        status: 'pending', assessmentRevision: Number.MAX_SAFE_INTEGER - 1,
        runDisposition: 'subscription_required',
      },
    },
    subscriptionActive: true, hasFrozenAuthorization: false, explicitRenewal: true,
  });
  assert.equal(applyEgeMockAssessmentRunDisposition(almostExhausted, explicit, {
    now: new Date('2026-08-13T06:01:00.000Z'),
  }), true);
  assert.equal(almostExhausted.writing_assessment.assessment_revision, Number.MAX_SAFE_INTEGER);
  assert.equal(almostExhausted.writing_assessment.run_disposition, undefined);

  almostExhausted.writing_assessment.run_disposition = 'subscription_required';
  const before = structuredClone(almostExhausted);
  await assert.rejects(async () => applyEgeMockAssessmentRunDisposition(
    almostExhausted, explicit, { now: new Date('2026-08-13T06:02:00.000Z') },
  ), { code: 'ASSESSMENT_REVISION_EXHAUSTED' });
  assert.deepEqual(almostExhausted, before,
    'revision exhaustion rejects before clearing the disposition or changing timestamps');
  assert.throws(() => egeMockAssessmentRunBeginDecision({
    attempt: {
      id: '9ed93fa6-29c0-47b0-a86e-2234a2255a46',
      writingAssessment: { status: 'pending', assessmentRevision: Number.MAX_SAFE_INTEGER },
    },
    subscriptionActive: false, hasFrozenAuthorization: false,
  }), { code: 'ASSESSMENT_REVISION_EXHAUSTED' });
});

test('EGE mock domain alone selects an active restore or next diagnostic/training identity', async () => {
  const { egeMockStartDecision } = await import('../ege-mock/attempt.js');
  const active = { id: 'active', state: 'oral_ready', mode: 'diagnostic' };
  assert.deepEqual(egeMockStartDecision([active]), {
    active, mode: null, attemptNumber: null,
  });
  assert.deepEqual(egeMockStartDecision([
    { id: 'finished', state: 'assessment_pending', mode: 'diagnostic' },
  ]), { active: null, mode: 'training', attemptNumber: 2 });
  assert.deepEqual(egeMockStartDecision([
    { id: 'expired', state: 'expired', mode: 'diagnostic' },
  ]), { active: null, mode: 'diagnostic', attemptNumber: 2 });
});

test('file EGE mock start pins the authored form and replays one owner-bound attempt', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-attempt-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_201, 30, 'Mock owner');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const input = {
      formId: form.id,
      formRevision: form.revision,
      catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY,
      requestHash: 'a'.repeat(64),
    };
    const first = await repository.startEgeMockAttempt(username, input, {
      now: new Date('2026-08-13T06:00:00.000Z'),
    });
    const replay = await repository.startEgeMockAttempt(username, input, {
      now: new Date('2026-08-13T06:01:00.000Z'),
    });

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.attempt.id, first.attempt.id);
    assert.equal(first.attempt.formId, EGE_MOCK_FORM_ID);
    assert.equal(first.attempt.formRevision, EGE_MOCK_FORM_REVISION);
    assert.equal(first.attempt.catalogFingerprint, form.fingerprint);
    assert.equal(first.attempt.mode, 'diagnostic');
    assert.equal(first.attempt.attemptNumber, 1);
    assert.equal(first.attempt.state, 'written_in_progress');
    assert.equal(first.attempt.policyId, 'ege-mock-attempt-policy-v1');
    assert.equal(first.attempt.writtenDeadlineAt, '2026-08-13T09:10:00.000Z');
    assert.match(first.attempt.ownerGeneration, /^account:/u);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock keeps one unfinished diagnostic current and isolates it by owner', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-current-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username: owner } = await repository.grantDays(9_260_211, 30, 'Mock current owner');
    const { username: other } = await repository.grantDays(9_260_212, 30, 'Mock current other');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const first = await repository.startEgeMockAttempt(owner, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-08-13T06:00:00.000Z') });
    const resumed = await repository.startEgeMockAttempt(owner, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: '692e92c8-f766-4f6a-ad75-1c77d3b85b33', requestHash: 'b'.repeat(64),
    }, { now: new Date('2026-08-13T06:02:00.000Z') });

    assert.equal(resumed.created, false);
    assert.equal(resumed.replayed, false);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.attempt.id, first.attempt.id);
    assert.equal((await repository.getCurrentEgeMockAttempt(owner, {
      now: new Date('2026-08-13T06:03:00.000Z'),
    })).id, first.attempt.id);
    assert.equal(await repository.getCurrentEgeMockAttempt(other), null);
    assert.equal(await repository.getEgeMockAttempt(other, first.attempt.id), null);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock reconciles an expired active attempt before a new start', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-start-expiry-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_213, 90, 'Mock expired start owner');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const first = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-08-13T06:00:00.000Z') });
    const replacement = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: '5ba0b85d-9c89-43fd-9e0d-ae16902e688b', requestHash: 'b'.repeat(64),
    }, { now: new Date('2026-09-13T09:10:00.000Z') });

    assert.equal(replacement.created, true);
    assert.equal(replacement.attempt.attemptNumber, 2);
    assert.equal(replacement.attempt.mode, 'diagnostic');
    assert.equal((await repository.getEgeMockAttempt(username, first.attempt.id, {
      now: new Date('2026-09-13T09:10:00.000Z'),
    })).state, 'expired');
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock draft uses compare-and-set and exact idempotent replay', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-draft-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_221, 30, 'Mock draft owner');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const startInput = {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    };
    const started = await repository.startEgeMockAttempt(username, startInput, {
      now: new Date('2026-08-13T06:00:00.000Z'),
    });
    const mutation = {
      expectedRevision: 0,
      answers: { 1: ['A', 'C'], 19: 'went', 37: 'Private draft answer' },
      idempotencyKey: 'c4555a71-dc6a-4de5-871d-b0f87fd2ef56',
      requestHash: 'b'.repeat(64),
    };
    const saved = await repository.saveEgeMockDraft(username, started.attempt.id, mutation, {
      now: new Date('2026-08-13T06:05:00.000Z'),
    });
    const replay = await repository.saveEgeMockDraft(username, started.attempt.id, mutation, {
      now: new Date('2026-08-13T06:06:00.000Z'),
    });

    assert.equal(saved.applied, true);
    assert.equal(saved.replayed, false);
    assert.equal(saved.attempt.revision, 1);
    assert.deepEqual(saved.attempt.draft, mutation.answers);
    assert.deepEqual(replay, { ...saved, replayed: true });
    const startReplay = await repository.startEgeMockAttempt(username, startInput, {
      now: new Date('2026-08-13T06:06:00.000Z'),
    });
    assert.equal(startReplay.replayed, true);
    assert.equal(startReplay.attempt.revision, 0);
    assert.deepEqual(startReplay.attempt.draft, {});
    await assert.rejects(
      repository.saveEgeMockDraft(username, started.attempt.id, {
        ...mutation, requestHash: 'c'.repeat(64), answers: { 19: 'gone' },
      }, { now: new Date('2026-08-13T06:07:00.000Z') }),
      { code: 'EGE_MOCK_IDEMPOTENCY_CONFLICT' },
    );
    await assert.rejects(
      repository.saveEgeMockDraft(username, started.attempt.id, {
        ...mutation,
        idempotencyKey: '287e412b-e4bc-44b2-bd1d-52f37229476b', requestHash: 'd'.repeat(64),
        answers: { 19: 'gone' },
      }, { now: new Date('2026-08-13T06:08:00.000Z') }),
      { code: 'EGE_MOCK_REVISION_CONFLICT' },
    );
    await assert.rejects(
      repository.saveEgeMockDraft(username, started.attempt.id, {
        expectedRevision: 1,
        idempotencyKey: 'cb840cb5-5508-4ab5-9ba5-a7d847b4d783', requestHash: 'e'.repeat(64),
        answers: Object.fromEntries(Array.from({ length: 5 }, (_, index) => (
          [String(index + 1), 'я'.repeat(11_000)]
        ))),
      }, { now: new Date('2026-08-13T06:09:00.000Z') }),
      { code: 'EGE_MOCK_DRAFT_INVALID' },
    );
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock auto-submits the written part at the exact server deadline', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-written-time-'));
  const file = path.join(directory, 'data.json');
  let repository = createFileRepository(file);
  try {
    const { username } = await repository.grantDays(9_260_231, 30, 'Mock written timer');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-08-13T06:00:00.000Z') });

    const before = await repository.getEgeMockAttempt(username, started.attempt.id, {
      now: new Date('2026-08-13T09:09:59.999Z'),
    });
    await assert.rejects(repository.saveEgeMockDraft(username, started.attempt.id, {
      expectedRevision: 0, answers: { 19: 'late' },
      idempotencyKey: '08295e92-1ee8-4d39-a0fa-4ef207444191', requestHash: 'b'.repeat(64),
    }, { now: new Date('2026-08-13T09:10:00.000Z') }), { code: 'EGE_MOCK_WRITTEN_CLOSED' });
    await repository.close();
    repository = createFileRepository(file);
    const expired = await repository.getEgeMockAttempt(username, started.attempt.id, {
      now: new Date('2026-08-13T09:09:59.999Z'),
    });

    assert.equal(before.state, 'written_in_progress');
    assert.equal(expired.state, 'oral_ready');
    assert.equal(expired.writtenSubmittedAt, '2026-08-13T09:10:00.000Z');
    assert.equal(expired.oralAvailableUntil, '2026-09-12T09:10:00.000Z');
    assert.equal(expired.revision, 1);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock automatic written receipt digests the full authoritative draft with blanks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-written-digest-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_232, 30, 'Mock written digest');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-08-13T06:00:00.000Z') });
    await repository.saveEgeMockDraft(username, started.attempt.id, {
      expectedRevision: 0, answers: { 19: 'went' },
      idempotencyKey: 'f23116e7-f152-49c7-9931-761d1526070b', requestHash: 'b'.repeat(64),
    }, { now: new Date('2026-08-13T06:10:00.000Z') });
    const automatic = await repository.submitEgeMockWritten(username, started.attempt.id, {
      expectedRevision: 1,
      idempotencyKey: 'd14f1e39-e942-4e36-8367-5b699f942bcd', requestHash: 'c'.repeat(64),
    }, { now: new Date('2026-08-13T09:10:00.000Z') });

    assert.equal(automatic.receipt.automatic, true);
    assert.match(automatic.receipt.payloadDigest, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock written submit freezes blanks and replays one server receipt', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-written-submit-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_241, 30, 'Mock written submit');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-08-13T06:00:00.000Z') });
    const input = {
      expectedRevision: 0,
      idempotencyKey: 'af50e3a5-e937-452d-8f24-01302129a505',
      requestHash: 'e'.repeat(64),
    };
    const submitted = await repository.submitEgeMockWritten(username, started.attempt.id, input, {
      now: new Date('2026-08-13T06:10:00.000Z'),
    });
    const replay = await repository.submitEgeMockWritten(username, started.attempt.id, input, {
      now: new Date('2026-08-13T06:11:00.000Z'),
    });

    assert.equal(submitted.attempt.state, 'oral_ready');
    assert.equal(submitted.attempt.writtenSubmittedAt, '2026-08-13T06:10:00.000Z');
    assert.equal(submitted.attempt.oralAvailableUntil, '2026-09-12T06:10:00.000Z');
    assert.equal(submitted.receipt.operation, 'written_submit');
    assert.equal(submitted.receipt.attemptId, started.attempt.id);
    assert.equal(submitted.receipt.revision, 1);
    assert.deepEqual(submitted.receipt.orderedPositions, Array.from({ length: 38 }, (_, index) => index + 1));
    assert.match(submitted.receipt.payloadDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.notEqual(submitted.receipt.payloadDigest, input.requestHash);
    assert.deepEqual(replay, { ...submitted, replayed: true });
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock starts a separate 17-minute oral timer and auto-submits it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-oral-time-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_251, 30, 'Mock oral timer');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-08-13T06:00:00.000Z') });
    const written = await repository.submitEgeMockWritten(username, started.attempt.id, {
      expectedRevision: 0, idempotencyKey: 'fd9af062-999c-489f-b9c9-f914002862c0',
      requestHash: 'b'.repeat(64),
    }, { now: new Date('2026-08-13T06:10:00.000Z') });
    const oral = await repository.startEgeMockOral(username, started.attempt.id, {
      expectedRevision: written.attempt.revision,
      idempotencyKey: '3ec0f3ae-5b16-48ee-b022-4925c72204c4', requestHash: 'c'.repeat(64),
    }, { now: new Date('2026-08-13T07:00:00.000Z') });

    assert.equal(oral.attempt.state, 'oral_in_progress');
    assert.equal(oral.attempt.oralStartedAt, '2026-08-13T07:00:00.000Z');
    assert.equal(oral.attempt.oralDeadlineAt, '2026-08-13T07:17:00.000Z');
    assert.equal(oral.attempt.revision, 2);
    assert.equal((await repository.getEgeMockAttempt(username, started.attempt.id, {
      now: new Date('2026-08-13T07:16:59.999Z'),
    })).state, 'oral_in_progress');
    const expired = await repository.submitEgeMockOral(username, started.attempt.id, {
      expectedRevision: oral.attempt.revision, recordings: {},
      idempotencyKey: '2ae59f5a-17c1-46ae-92cb-88bfd61acb4d', requestHash: 'd'.repeat(64),
    }, {
      now: new Date('2026-08-13T07:17:00.000Z'),
    });
    assert.equal(expired.attempt.state, 'assessment_pending');
    assert.equal(expired.attempt.oralSubmittedAt, '2026-08-13T07:17:00.000Z');
    assert.equal(expired.attempt.revision, 3);
    assert.equal(expired.receipt.automatic, true);
    assert.match(expired.receipt.payloadDigest, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock persists diagnostic error focus when deadline reconciliation rejects the requested mutation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-deadline-focus-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_252, 30, 'Mock deadline focus');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-08-13T06:00:00.000Z') });
    const written = await repository.submitEgeMockWritten(username, started.attempt.id, {
      expectedRevision: started.attempt.revision,
      idempotencyKey: '4e5510b1-b303-41da-8c2e-cdad0a50554d', requestHash: 'b'.repeat(64),
    }, { now: new Date('2026-08-13T06:10:00.000Z') });
    const oral = await repository.startEgeMockOral(username, started.attempt.id, {
      expectedRevision: written.attempt.revision,
      idempotencyKey: 'd434f5d2-7143-4a42-8c78-fdd73c8bf848', requestHash: 'c'.repeat(64),
    }, { now: new Date('2026-08-13T07:00:00.000Z') });

    await assert.rejects(repository.saveEgeMockDraft(username, started.attempt.id, {
      expectedRevision: oral.attempt.revision, answers: {},
      idempotencyKey: '03473662-2532-45c3-b733-158cd7dd88aa', requestHash: 'd'.repeat(64),
    }, { now: new Date('2026-08-13T07:17:00.000Z') }), {
      code: 'EGE_MOCK_WRITTEN_CLOSED',
    });

    const exported = await repository.exportUserData(username);
    const focus = exported.error_bank.filter((entry) => (
      entry.error_type === 'ege_mock_diagnostic_weak_skill'
        && entry.details?.source_attempt_id === started.attempt.id
    ));
    assert.ok(focus.length > 0, 'deadline completion must durably project diagnostic weak skills');
    assert.ok(focus.every((entry) => entry.occurrence_count === 1
      && entry.details.mastery_credit === false));
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock reveals no result before both parts and replays explicit oral submit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-result-gate-'));
  const dataFile = path.join(directory, 'data.json');
  const repository = createFileRepository(dataFile);
  try {
    assert.deepEqual(await repository.getEgeMockHistory('missing-owner'), {
      baselineAttemptId: null, attempts: [],
    }, 'missing owners share the documented empty-history response across adapters');
    const { username } = await repository.grantDays(9_260_261, 30, 'Mock result gate');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-08-13T06:00:00.000Z') });
    assert.deepEqual(await repository.getEgeMockResult(username, started.attempt.id, {
      now: new Date('2026-08-13T06:01:00.000Z'),
    }), {
      available: false, state: 'written_in_progress', keysRevealed: false,
      writingAssessment: {
        status: 'not_started', assessmentRevision: 0,
        ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
        label: 'Предварительная автоматическая оценка',
        retryAllowed: false, retryCount: 0,
      },
    });
    const written = await repository.submitEgeMockWritten(username, started.attempt.id, {
      expectedRevision: 0, idempotencyKey: '28232177-c98f-4813-9438-3582fa2283d8',
      requestHash: 'b'.repeat(64),
    }, { now: new Date('2026-08-13T06:10:00.000Z') });
    const oral = await repository.startEgeMockOral(username, started.attempt.id, {
      expectedRevision: written.attempt.revision,
      idempotencyKey: 'e3739274-84fa-40d5-b88c-ac7479417a0a', requestHash: 'c'.repeat(64),
    }, { now: new Date('2026-08-13T07:00:00.000Z') });
    const completedOral = await completeEgeMockOralStageLedger(repository, username, oral);
    const input = {
      expectedRevision: completedOral.attempt.revision,
      idempotencyKey: '56b7a17a-c515-43e6-9e46-63f93d29fec8', requestHash: 'd'.repeat(64),
    };
    const submitted = await repository.submitEgeMockOral(username, started.attempt.id, input, {
      now: new Date('2026-08-13T07:05:00.000Z'),
    });
    const replay = await repository.submitEgeMockOral(username, started.attempt.id, input, {
      now: new Date('2026-08-13T07:06:00.000Z'),
    });

    assert.equal(submitted.attempt.state, 'assessment_pending');
    assert.equal(submitted.receipt.operation, 'oral_submit');
    assert.deepEqual(submitted.receipt.orderedPositions, [39, 40, 41, 42]);
    assert.deepEqual(replay, { ...submitted, replayed: true });
    const beforeObservations = await fs.readFile(dataFile);
    const result = await repository.getEgeMockResult(username, started.attempt.id);
    await repository.getEgeMockHistory(username);
    assert.deepEqual(await fs.readFile(dataFile), beforeObservations,
      'result/history GET repository seams are byte-for-byte observational');
    const automaticAssessment = {
      ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
      label: 'Предварительная автоматическая оценка',
    };
    const speakingItems = {
      39: {
        position: 39, maximum: 1, status: 'pending', score: null,
        mode: 'experimental', scoreKind: 'approximate',
      },
      40: {
        position: 40, maximum: 4, status: 'pending', score: null,
        mode: 'experimental', scoreKind: 'approximate',
      },
      41: {
        position: 41, maximum: 5, status: 'pending', score: null,
        mode: 'experimental', scoreKind: 'approximate',
      },
      42: {
        position: 42, maximum: 10, status: 'pending', score: null,
        mode: 'experimental', scoreKind: 'approximate',
      },
    };
    const speakingAssessment = {
      status: 'pending', ...automaticAssessment,
      retryAllowed: false, retryCount: 0, items: speakingItems,
    };
    const { canonical, ...legacyResult } = result.result;
    assert.equal(canonical.attemptId, started.attempt.id);
    assert.equal(canonical.items.length, 42);
    assert.equal(canonical.score.primaryTotal, null);
    assert.deepEqual(canonical.score.range, { minimum: 0, maximum: 40 });
    assert.equal(canonical.forecast.score, null);
    assert.equal(canonical.masteryCredit, false);
    assert.deepEqual({ ...result, result: legacyResult }, {
      available: true,
      state: 'assessment_pending',
      keysRevealed: true,
      writingAssessment: {
        status: 'pending', assessmentRevision: 1, ...automaticAssessment,
        retryAllowed: false, retryCount: 0,
      },
      speakingAssessment,
      assessment: { status: 'pending', retryAllowed: false, retryCount: 0 },
      result: {
        writing: {
          status: 'pending', assessmentRevision: 1, ...automaticAssessment,
          score: null, maximum: 20, items: [],
        },
        speaking: { ...speakingAssessment, score: null, maximum: 20 },
      },
    });
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE shadow Speaking session rejects legacy lifecycle mutations', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-shadow-guard-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_269, 30, 'Mock shadow guard');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    let { attempt } = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: '31d32e4d-8efd-432c-88b4-94766b768abc', requestHash: '1'.repeat(64),
    }, { now: new Date('2026-08-13T06:00:00.000Z') });
    ({ attempt } = await repository.submitEgeMockWritten(username, attempt.id, {
      expectedRevision: attempt.revision,
      idempotencyKey: '31d32e4d-8efd-432c-88b4-94766b768abd', requestHash: '2'.repeat(64),
    }, { now: new Date('2026-08-13T06:01:00.000Z') }));
    ({ attempt } = await repository.startEgeMockOral(username, attempt.id, {
      expectedRevision: attempt.revision,
      idempotencyKey: '31d32e4d-8efd-432c-88b4-94766b768abe', requestHash: '3'.repeat(64),
    }, { now: new Date('2026-08-13T07:00:00.000Z') }));
    await repository.syncEgeMockSpeakingBridge(username, attempt.id, {
      now: () => new Date('2026-08-13T07:00:01.000Z'),
    });
    for (const mutation of [
      () => repository.advanceFullSpeakingSessionStage(username, attempt.id),
      () => repository.completeFullSpeakingSessionResponse(username, attempt.id, {
        taskType: 1, responseNumber: 1, responseStatus: 'technical_issue',
        recordingDurationSeconds: 0, micCheck: 'skipped', localPlayback: false,
        technicalIssueCode: 'recording_failed',
      }),
      () => repository.submitFullSpeakingSessionResult(
        username, attempt.id, '31d32e4d-8efd-432c-88b4-94766b768abf',
      ),
      () => repository.claimFullSpeakingSessionAssessment(username, attempt.id, {
        taskType: 1, responseNumber: 1, audioSha256: 'a'.repeat(64),
        idempotencyKey: '31d32e4d-8efd-432c-88b4-94766b768ac0', durationSeconds: 10,
      }),
      () => repository.completeFullSpeakingSessionEvaluation(username, attempt.id, []),
    ]) await assert.rejects(mutation(), { code: 'SPEAKING_FULL_EGE_LIFECYCLE_REQUIRED' });
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock assessment retry is bounded and only server-state allowed', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-assessment-retry-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_271, 30, 'Mock retry owner');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-08-13T06:00:00.000Z') });
    await assert.rejects(repository.retryEgeMockAssessment(username, started.attempt.id, {
      idempotencyKey: '1f74f356-3733-49f3-968e-0f620fc2cd67', requestHash: 'b'.repeat(64),
    }, { now: new Date('2026-08-13T06:01:00.000Z') }),
    { code: 'EGE_MOCK_ASSESSMENT_RETRY_NOT_ALLOWED' });

    await repository.submitEgeMockWritten(username, started.attempt.id, {
      expectedRevision: 0, idempotencyKey: '14737173-7f85-48a0-8bdd-055d4a852361',
      requestHash: 'c'.repeat(64),
    }, { now: new Date('2026-08-13T06:10:00.000Z') });
    const oral = await repository.startEgeMockOral(username, started.attempt.id, {
      expectedRevision: 1, idempotencyKey: '37390a64-a070-4c00-9dd7-2a58660aba64',
      requestHash: 'd'.repeat(64),
    }, { now: new Date('2026-08-13T07:00:00.000Z') });
    const completedOral = await completeEgeMockOralStageLedger(repository, username, oral);
    await repository.submitEgeMockOral(username, started.attempt.id, {
      expectedRevision: completedOral.attempt.revision,
      idempotencyKey: 'b7749c89-c2d9-44f1-8b45-b9b922ff73ee', requestHash: 'e'.repeat(64),
    }, { now: new Date('2026-08-13T07:05:00.000Z') });
    await repository.markEgeMockAssessmentRetryable(username, started.attempt.id, {
      reason: 'provider_unavailable', now: new Date('2026-08-13T07:06:00.000Z'),
    });
    const retryInput = {
      idempotencyKey: '622b3907-a5dd-467b-ad68-582703a37c29', requestHash: 'f'.repeat(64),
    };
    const retry = await repository.retryEgeMockAssessment(username, started.attempt.id, retryInput, {
      now: new Date('2026-08-13T07:07:00.000Z'),
    });
    const replay = await repository.retryEgeMockAssessment(username, started.attempt.id, retryInput, {
      now: new Date('2026-08-13T07:08:00.000Z'),
    });

    assert.equal(retry.attempt.assessment.status, 'pending');
    assert.equal(retry.attempt.assessment.retryCount, 1);
    assert.deepEqual(replay, { ...retry, replayed: true });
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock export is allowlisted, oral-ready retention expires, and account deletion cascades', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-retention-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_281, 45, 'Mock retention owner');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-01-01T06:00:00.000Z') });
    const written = await repository.submitEgeMockWritten(username, started.attempt.id, {
      expectedRevision: 0, idempotencyKey: '4bd09eaa-97af-4d6b-a7d2-998510704a9a',
      requestHash: 'b'.repeat(64),
    }, { now: new Date('2026-01-01T06:10:00.000Z') });

    const exported = await repository.exportUserData(username);
    assert.equal(exported.ege_mock_attempts.length, 1);
    assert.equal(exported.ege_mock_attempts[0].id, started.attempt.id);
    assert.equal(exported.ege_mock_attempts[0].state, 'expired');
    assert.equal(exported.ege_mock_attempts[0].policy_id, 'ege-mock-attempt-policy-v1');
    assert.match(exported.ege_mock_attempts[0].written_receipt.payloadDigest,
      /^sha256:[a-f0-9]{64}$/u);
    assert.equal(/(?:idempotency|request_hash|username)/u.test(JSON.stringify(exported.ege_mock_attempts)), false);
    const expired = await repository.getEgeMockAttempt(username, started.attempt.id, {
      now: new Date(written.attempt.oralAvailableUntil),
    });
    assert.equal(expired.state, 'expired');
    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.getEgeMockAttempt(username, started.attempt.id), null);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock lifecycle matches the shared repository contract', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-shared-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try { await assertEgeMockAttemptRepositoryContract(assert, repository, 9_260_300); }
  finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE oral stages match the shared repository contract', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-oral-shared-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try { await assertEgeMockOralStageRepositoryContract(assert, repository, 9_260_310); }
  finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file assessment-run subscription command matches the shared repository contract', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-run-subscription-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    await assertEgeMockAssessmentRunSubscriptionContract(
      assert, repository, 9_260_320,
      async (owners) => Object.fromEntries(owners.map(({ username, sub_until: subUntil }) => [
        username, { now: new Date(Number(subUntil) + 1_000) },
      ])),
    );
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file assessment revision exhaustion matches the shared repository contract', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-revision-limit-'));
  const filePath = path.join(directory, 'data.json');
  let repository = createFileRepository(filePath);
  const adapter = {
    repository: () => repository,
    async seedAssessmentRevision({ username, attemptId, revision }) {
      await repository.close();
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      const attempt = data.ege_mock_attempts.find((candidate) => (
        candidate.username === username && candidate.id === attemptId
      ));
      assert.ok(attempt?.writing_assessment);
      attempt.writing_assessment.assessment_revision = revision;
      await fs.writeFile(filePath, JSON.stringify(data), 'utf8');
      repository = createFileRepository(filePath);
    },
    async expireSubscription(owner) {
      return { now: new Date(Number(owner.sub_until) + 1_000) };
    },
    async assessmentRunMutationCount({ username, attemptId, idempotencyKey }) {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      return data.ege_mock_mutations.filter((candidate) => (
        candidate.username === username && candidate.attempt_id === attemptId
        && candidate.operation === 'assessment_run'
        && candidate.idempotency_key === idempotencyKey
      )).length;
    },
  };
  try {
    await assertEgeMockAssessmentRevisionExhaustionContract(
      assert, adapter, 9_260_340,
    );
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file EGE mock draft rechecks subscription before new mutations and exact replays', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-subscription-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_401, 1, 'Mock subscription owner');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: START_KEY, requestHash: 'a'.repeat(64),
    });
    const input = {
      expectedRevision: 0, answers: { 19: 'went' },
      idempotencyKey: '38711530-3e28-411f-a0f5-3fa534c535e8', requestHash: 'b'.repeat(64),
    };
    await repository.saveEgeMockDraft(username, started.attempt.id, input);
    const afterExpiry = { now: new Date(Date.now() + 2 * 86_400_000) };
    await assert.rejects(
      repository.saveEgeMockDraft(username, started.attempt.id, input, afterExpiry),
      { code: 'SUBSCRIPTION_REQUIRED' },
    );
    await assert.rejects(repository.saveEgeMockDraft(username, started.attempt.id, {
      ...input, expectedRevision: 1,
      idempotencyKey: '6d2308be-31e8-4c8c-a42a-1f2601f5c045', requestHash: 'c'.repeat(64),
    }, afterExpiry), { code: 'SUBSCRIPTION_REQUIRED' });
    assert.equal((await repository.getEgeMockAttempt(username, started.attempt.id)).revision, 1);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
