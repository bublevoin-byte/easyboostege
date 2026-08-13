import crypto from 'node:crypto';

import { EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockForm } from '../../ege-mock/catalog.js';

export async function assertEgeMockAttemptRepositoryContract(assert, repository, telegramBase) {
  const owner = await repository.createTelegramUser(telegramBase, `EGE mock ${telegramBase}`);
  const other = await repository.createTelegramUser(telegramBase + 1, `EGE mock other ${telegramBase}`);
  await repository.grantDays(telegramBase, 45, `EGE mock ${telegramBase}`);
  await repository.grantDays(telegramBase + 1, 45, `EGE mock other ${telegramBase}`);
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const startKey = crypto.randomUUID();
  const startInput = {
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    idempotencyKey: startKey, requestHash: '1'.repeat(64),
  };
  try {
    const first = await repository.startEgeMockAttempt(owner, startInput);
    const replay = await repository.startEgeMockAttempt(owner, startInput);
    assert.equal(first.created, true);
    assert.equal(first.attempt.policyId, 'ege-mock-attempt-policy-v1');
    assert.equal(replay.replayed, true);
    assert.equal(replay.attempt.id, first.attempt.id);
    assert.equal(new Date(first.attempt.writtenDeadlineAt) - new Date(first.attempt.writtenStartedAt), 190 * 60_000);
    await assert.rejects(
      repository.startEgeMockAttempt(owner, { ...startInput, requestHash: '2'.repeat(64) }),
      { code: 'EGE_MOCK_IDEMPOTENCY_CONFLICT' },
    );

    const resumeInput = { ...startInput, idempotencyKey: crypto.randomUUID(), requestHash: '3'.repeat(64) };
    const resumed = await repository.startEgeMockAttempt(owner, resumeInput);
    const resumedReplay = await repository.startEgeMockAttempt(owner, resumeInput);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.attempt.id, first.attempt.id);
    assert.equal(resumedReplay.replayed, true);
    assert.equal(await repository.getEgeMockAttempt(other, first.attempt.id), null);

    const draftCandidates = [
      { expectedRevision: 0, answers: { 19: 'went' }, idempotencyKey: crypto.randomUUID(), requestHash: '4'.repeat(64) },
      { expectedRevision: 0, answers: { 19: 'gone' }, idempotencyKey: crypto.randomUUID(), requestHash: '5'.repeat(64) },
    ];
    const draftRace = await Promise.allSettled(draftCandidates.map((candidate) => (
      repository.saveEgeMockDraft(owner, first.attempt.id, candidate)
    )));
    assert.equal(draftRace.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(draftRace.find(({ status }) => status === 'rejected').reason.code, 'EGE_MOCK_REVISION_CONFLICT');
    const winningIndex = draftRace.findIndex(({ status }) => status === 'fulfilled');
    const draft = draftRace[winningIndex].value;
    assert.equal(draft.attempt.revision, 1);
    assert.equal((await repository.saveEgeMockDraft(
      owner, first.attempt.id, draftCandidates[winningIndex],
    )).replayed, true);
    const delayedStartReplay = await repository.startEgeMockAttempt(owner, startInput);
    assert.equal(delayedStartReplay.replayed, true);
    assert.equal(delayedStartReplay.attempt.revision, 0);
    assert.deepEqual(delayedStartReplay.attempt.draft, {});
    assert.equal((await repository.getCurrentEgeMockAttempt(owner)).id, first.attempt.id);

    assert.deepEqual(await repository.getEgeMockResult(owner, first.attempt.id), {
      available: false, state: 'written_in_progress', keysRevealed: false,
    });
    const writtenCandidates = [
      { expectedRevision: 1, idempotencyKey: crypto.randomUUID(), requestHash: '6'.repeat(64) },
      { expectedRevision: 1, idempotencyKey: crypto.randomUUID(), requestHash: 'b'.repeat(64) },
    ];
    const writtenRace = await Promise.allSettled(writtenCandidates.map((candidate) => (
      repository.submitEgeMockWritten(owner, first.attempt.id, candidate)
    )));
    assert.equal(writtenRace.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(['EGE_MOCK_WRITTEN_CLOSED', 'EGE_MOCK_REVISION_CONFLICT'].includes(
      writtenRace.find(({ status }) => status === 'rejected').reason.code,
    ), true);
    const written = writtenRace.find(({ status }) => status === 'fulfilled').value;
    assert.equal(written.attempt.state, 'oral_ready');
    assert.deepEqual(written.receipt.orderedPositions, Array.from({ length: 38 }, (_, index) => index + 1));
    assert.match(written.receipt.payloadDigest, /^sha256:[a-f0-9]{64}$/u);
    const oral = await repository.startEgeMockOral(owner, first.attempt.id, {
      expectedRevision: written.attempt.revision,
      idempotencyKey: crypto.randomUUID(), requestHash: '7'.repeat(64),
    });
    assert.equal(new Date(oral.attempt.oralDeadlineAt) - new Date(oral.attempt.oralStartedAt), 17 * 60_000);
    const oralCandidates = [
      {
        expectedRevision: oral.attempt.revision,
        recordings: { 39: { recordingId: 'shared-local-39-a', durationSeconds: 60 } },
        idempotencyKey: crypto.randomUUID(), requestHash: '8'.repeat(64),
      },
      {
        expectedRevision: oral.attempt.revision,
        recordings: { 39: { recordingId: 'shared-local-39-b', durationSeconds: 61 } },
        idempotencyKey: crypto.randomUUID(), requestHash: 'c'.repeat(64),
      },
    ];
    const oralRace = await Promise.allSettled(oralCandidates.map((candidate) => (
      repository.submitEgeMockOral(owner, first.attempt.id, candidate)
    )));
    assert.equal(oralRace.filter(({ status }) => status === 'fulfilled').length, 1);
    assert.equal(['EGE_MOCK_ORAL_CLOSED', 'EGE_MOCK_REVISION_CONFLICT'].includes(
      oralRace.find(({ status }) => status === 'rejected').reason.code,
    ), true);
    const submitted = oralRace.find(({ status }) => status === 'fulfilled').value;
    assert.equal(submitted.attempt.state, 'assessment_pending');
    assert.deepEqual(submitted.receipt.orderedPositions, [39, 40, 41, 42]);
    assert.match(submitted.receipt.payloadDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal((await repository.getEgeMockResult(owner, first.attempt.id)).keysRevealed, true);

    await repository.markEgeMockAssessmentRetryable(owner, first.attempt.id, {
      reason: 'provider_unavailable',
    });
    const retryInput = {
      idempotencyKey: crypto.randomUUID(), requestHash: '9'.repeat(64),
    };
    const retry = await repository.retryEgeMockAssessment(owner, first.attempt.id, retryInput);
    assert.equal(retry.attempt.assessment.status, 'pending');
    assert.equal((await repository.retryEgeMockAssessment(owner, first.attempt.id, retryInput)).replayed, true);

    const training = await repository.startEgeMockAttempt(owner, {
      ...startInput, idempotencyKey: crypto.randomUUID(), requestHash: 'a'.repeat(64),
    });
    assert.equal(training.created, true);
    assert.equal(training.attempt.mode, 'training');
    assert.equal(training.attempt.attemptNumber, 2);
    await assert.rejects(
      repository.saveEgeMockDraft(owner, training.attempt.id, draftCandidates[winningIndex]),
      { code: 'EGE_MOCK_IDEMPOTENCY_CONFLICT' },
    );

    const exported = await repository.exportUserData(owner);
    assert.equal(exported.ege_mock_attempts.length, 2);
    assert.equal(exported.ege_mock_attempts[0].policy_id, 'ege-mock-attempt-policy-v1');
    assert.match(exported.ege_mock_attempts[0].written_receipt.payloadDigest,
      /^sha256:[a-f0-9]{64}$/u);
    assert.match(exported.ege_mock_attempts[0].oral_receipt.payloadDigest,
      /^sha256:[a-f0-9]{64}$/u);
    assert.equal(exported.ege_mock_attempts[0].written_receipt.id, written.receipt.id);
    assert.equal(exported.ege_mock_attempts[0].oral_receipt.id, submitted.receipt.id);
    assert.equal(/(?:idempotency|request_hash|username)/u.test(JSON.stringify(exported.ege_mock_attempts)), false);
    assert.equal(await repository.deleteUserData(owner), true);
    assert.equal(await repository.getEgeMockAttempt(owner, first.attempt.id), null);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
  }
}
