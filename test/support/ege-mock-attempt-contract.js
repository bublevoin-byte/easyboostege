import crypto from 'node:crypto';

import { EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockForm } from '../../ege-mock/catalog.js';
import { createEgeMockWritingAssessmentBinding } from '../../ege-mock/writing-assessment.js';
import { AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT } from '../../shared/automatic-assessment-contract.js';

export async function completeEgeMockOralStageLedger(
  repository, username, initial, candidate = (body) => ({
    ...body, idempotencyKey: crypto.randomUUID(),
    requestHash: crypto.randomBytes(32).toString('hex'),
  }),
) {
  let oral = initial;
  let cursorAt = oral.attempt.oralStartedAt;
  while (oral.attempt.oralProgress.phase !== 'ready_to_submit') {
    const progress = oral.attempt.oralProgress;
    const finalTaskAnchor = progress.position === 42 && progress.responseNumber === 1
      && progress.phase === 'ready'
      ? new Date(new Date(oral.attempt.oralDeadlineAt).getTime() - 330_000).toISOString()
      : null;
    const now = progress.stageDeadlineAt || finalTaskAnchor || cursorAt;
    if (progress.phase === 'ready' || progress.phase === 'preparing') {
      oral = await repository.advanceEgeMockOralStage(username, oral.attempt.id,
        candidate({
          action: 'advance', expectedRevision: oral.attempt.revision,
          position: progress.position, responseNumber: progress.responseNumber,
        }), { now: () => new Date(now) });
    } else {
      oral = await repository.advanceEgeMockOralStage(username, oral.attempt.id,
        candidate({
          action: 'complete', expectedRevision: oral.attempt.revision,
          position: progress.position, responseNumber: progress.responseNumber,
          recording: {
            recordingId: crypto.randomUUID(), status: 'completed',
            durationSeconds: { 39: 90, 40: 20, 41: 40, 42: 180 }[progress.position],
            sha256: crypto.randomBytes(32).toString('hex'),
          },
        }), { now: () => new Date(now) });
      cursorAt = now;
    }
  }
  return oral;
}

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
      writingAssessment: {
        status: 'not_started', assessmentRevision: 0,
        ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
        label: 'Предварительная автоматическая оценка',
        retryAllowed: false, retryCount: 0,
      },
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
    const assessmentRunInput = {
      idempotencyKey: crypto.randomUUID(), requestHash: 'd'.repeat(64),
    };
    const firstRunClaim = await repository.beginEgeMockAssessmentRun(
      owner, first.attempt.id, assessmentRunInput,
    );
    assert.equal(firstRunClaim.finalized, false);
    assert.equal((await repository.beginEgeMockAssessmentRun(
      owner, first.attempt.id, assessmentRunInput,
    )).finalized, false, 'the same pending command remains resumable with its UUID');
    await assert.rejects(repository.saveEgeMockDraft(owner, first.attempt.id, {
      expectedRevision: written.attempt.revision, answers: {},
      idempotencyKey: assessmentRunInput.idempotencyKey, requestHash: 'e'.repeat(64),
    }), { code: 'EGE_MOCK_IDEMPOTENCY_CONFLICT' });
    const writingClaims = await Promise.all([
      repository.claimEgeMockWritingAssessment(owner, first.attempt.id, {
        claimToken: crypto.randomUUID(), now: new Date(),
      }),
      repository.claimEgeMockWritingAssessment(owner, first.attempt.id, {
        claimToken: crypto.randomUUID(), now: new Date(),
      }),
    ]);
    assert.equal(writingClaims.filter((claim) => claim.claimed).length, 1);
    const writingClaim = writingClaims.find((claim) => claim.claimed);
    assert.deepEqual(writingClaim.work.items.map((item) => item.position), [37, 38]);
    assert.equal((await repository.renewEgeMockWritingAssessmentClaim(owner, first.attempt.id, {
      claimToken: writingClaim.work.claimToken, now: new Date(),
    })).renewed, true);
    for (const item of writingClaim.work.items) {
      const review = {
        words: 0, in_range: false, overall_got: 0, overall_max: item.maximum,
        verdict: 'Insufficient answer volume.', sub: 'Complete the authored task.',
        criteria: item.criteriaSnapshot.map(({ name, maximum }) => ({ name, got: 0, max: maximum })),
        errors: [],
      };
      const outcomeToken = crypto.randomUUID();
      await repository.prepareEgeMockWritingAssessmentItemOutcome(owner, first.attempt.id, {
        claimToken: writingClaim.work.claimToken,
        position: item.position,
        outcomeToken,
        now: new Date(),
      });
      await repository.recordEgeMockWritingAssessmentItemOutcome(owner, first.attempt.id, {
        claimToken: writingClaim.work.claimToken,
        position: item.position,
        outcomeToken,
        review,
        binding: createEgeMockWritingAssessmentBinding(item),
        provenance: { provider: 'deterministic', model: null },
        calls: [],
        now: new Date(),
      });
      await repository.completeEgeMockWritingAssessmentItem(owner, first.attempt.id, {
        claimToken: writingClaim.work.claimToken,
        position: item.position,
        outcomeToken,
        now: new Date(),
      });
    }
    assert.equal((await repository.getEgeMockAttempt(owner, first.attempt.id)).writingAssessment.status, 'completed');
    const finalizedRun = await repository.settleEgeMockAssessmentRun(
      owner, first.attempt.id, assessmentRunInput,
    );
    assert.equal(finalizedRun.applied, true);
    assert.equal(finalizedRun.replayed, false);
    assert.equal(finalizedRun.attempt.writingAssessment.status, 'completed');
    const replayedRun = await repository.beginEgeMockAssessmentRun(
      owner, first.attempt.id, assessmentRunInput,
    );
    assert.equal(replayedRun.finalized, true);
    assert.equal(replayedRun.response.replayed, true);
    assert.deepEqual(replayedRun.response.attempt, finalizedRun.attempt);
    await assert.rejects(repository.claimEgeMockWritingAssessment(other, first.attempt.id, {
      claimToken: crypto.randomUUID(), now: new Date(),
    }), { code: 'EGE_MOCK_ATTEMPT_NOT_FOUND' });
    const oral = await repository.startEgeMockOral(owner, first.attempt.id, {
      expectedRevision: written.attempt.revision,
      idempotencyKey: crypto.randomUUID(), requestHash: '7'.repeat(64),
    });
    assert.equal(new Date(oral.attempt.oralDeadlineAt) - new Date(oral.attempt.oralStartedAt), 17 * 60_000);
    const completedOral = await completeEgeMockOralStageLedger(repository, owner, oral);
    const oralCandidates = [
      {
        expectedRevision: completedOral.attempt.revision,
        idempotencyKey: crypto.randomUUID(), requestHash: '8'.repeat(64),
      },
      {
        expectedRevision: completedOral.attempt.revision,
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
    assert.equal((await repository.getEgeMockResult(owner, first.attempt.id)).result.writing.score, 0);

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
    await assert.rejects(repository.beginEgeMockAssessmentRun(
      owner, training.attempt.id, assessmentRunInput,
    ), { code: 'EGE_MOCK_IDEMPOTENCY_CONFLICT' }, 'the run key is owner-global and attempt-bound');
    await assert.rejects(
      repository.saveEgeMockDraft(owner, training.attempt.id, draftCandidates[winningIndex]),
      { code: 'EGE_MOCK_IDEMPOTENCY_CONFLICT' },
    );

    const contextClaimId = crypto.randomUUID();
    const contextFingerprint = `sha256:${'b'.repeat(64)}`;
    const contextClaim = {
      claimId: contextClaimId,
      operation: 'writing_context_fixture',
      promptVersion: 'writing-v8',
      contextFingerprint,
      requestsPerHour: 3,
      dailyLimit: 1_000_000,
      now: new Date(),
    };
    assert.equal((await repository.claimAiOperationSlot(owner, contextClaim)).applied, true);
    assert.equal((await repository.claimAiOperationSlot(owner, contextClaim)).applied, false);
    await assert.rejects(repository.claimAiOperationSlot(owner, {
      ...contextClaim, contextFingerprint: `sha256:${'c'.repeat(64)}`,
    }), { code: 'AI_OPERATION_CLAIM_CONFLICT' });

    const exported = await repository.exportUserData(owner);
    assert.equal(exported.ege_mock_attempts.length, 2);
    assert.equal(exported.ege_mock_attempts[0].policy_id, 'ege-mock-attempt-policy-v1');
    assert.match(exported.ege_mock_attempts[0].written_receipt.payloadDigest,
      /^sha256:[a-f0-9]{64}$/u);
    assert.match(exported.ege_mock_attempts[0].oral_receipt.payloadDigest,
      /^sha256:[a-f0-9]{64}$/u);
    assert.equal(exported.ege_mock_attempts[0].written_receipt.id, written.receipt.id);
    assert.equal(exported.ege_mock_attempts[0].oral_receipt.id, submitted.receipt.id);
    assert.equal(exported.ege_mock_attempts[0].writing_assessment.status, 'completed');
    assert.equal(exported.ege_mock_attempts[0].writing_assessment.items[0].provenance.provider, 'deterministic');
    const exportedContextClaim = exported.ai_requests.find((item) => (
      item.operation === 'writing_context_fixture'
    ));
    assert.equal(exportedContextClaim?.context_fingerprint, contextFingerprint);
    assert.deepEqual(Object.keys(exportedContextClaim || {}).sort(), [
      'completion_tokens', 'context_fingerprint', 'created_at', 'duration_ms', 'error_code',
      'estimated_cost_microusd', 'id', 'model', 'operation', 'prompt_tokens', 'prompt_version',
      'provider', 'status',
    ].sort(), 'file and PostgreSQL exports use one exact allowlisted AI request DTO');
    assert.equal(/(?:username|claim_key|contextFingerprint)/u.test(JSON.stringify(exported.ai_requests)), false);
    assert.equal(/(?:idempotency|request_hash|username)/u.test(JSON.stringify(exported.ege_mock_attempts)), false);
    assert.equal(await repository.deleteUserData(owner), true);
    assert.equal(await repository.getEgeMockAttempt(owner, first.attempt.id), null);
  } finally {
    await repository.deleteUserData(owner).catch(() => {});
    await repository.deleteUserData(other).catch(() => {});
  }
}

export async function assertEgeMockOralStageRepositoryContract(assert, repository, telegramBase) {
  const owner = await repository.grantDays(telegramBase, 45, `EGE oral stages ${telegramBase}`);
  const other = await repository.grantDays(telegramBase + 1, 45, `EGE oral other ${telegramBase}`);
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  let counter = 0;
  const candidate = (body) => ({
    ...body,
    idempotencyKey: crypto.randomUUID(),
    requestHash: crypto.createHash('sha256').update(`oral-stage:${telegramBase}:${counter += 1}`)
      .digest('hex'),
  });
  const voiceConsentPolicyVersion = '2026-08-02-voice-v1';
  try {
    await repository.setPrivacyConsent(owner.username, {
      text_processing: false, voice_processing: true,
      policy_version: voiceConsentPolicyVersion,
    });
    const started = await repository.startEgeMockAttempt(owner.username, candidate({
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    }));
    const written = await repository.submitEgeMockWritten(owner.username, started.attempt.id,
      candidate({ expectedRevision: started.attempt.revision }));
    let oral = await repository.startEgeMockOral(owner.username, started.attempt.id,
      candidate({ expectedRevision: written.attempt.revision }));
    assert.equal(oral.attempt.oralProgress.phase, 'ready');
    await repository.setSpeakingAccentProfile(owner.username, {
      locale: 'en-GB', source: 'manual', now: new Date('2026-08-15T05:55:00.000Z'),
    });
    const initiallyPinnedBridge = await repository.syncEgeMockSpeakingBridge(
      owner.username, started.attempt.id,
    );
    await repository.setSpeakingAccentProfile(owner.username, {
      locale: 'en-US', source: 'manual', now: new Date('2026-08-15T05:56:00.000Z'),
    });
    assert.equal(await repository.getEgeMockAttempt(other.username, started.attempt.id), null);

    const firstAdvance = candidate({
      action: 'advance', expectedRevision: oral.attempt.revision, position: 39, responseNumber: 1,
    });
    oral = await repository.advanceEgeMockOralStage(owner.username, started.attempt.id, firstAdvance);
    await repository.syncEgeMockSpeakingBridge(owner.username, started.attempt.id);
    const replay = await repository.advanceEgeMockOralStage(
      owner.username, started.attempt.id, firstAdvance,
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.attempt, oral.attempt);

    const closedUntil = new Date(
      new Date(oral.attempt.oralProgress.stageDeadlineAt).getTime() + 90_000 + 5_001,
    );
    const recovered = await repository.getEgeMockAttempt(owner.username, started.attempt.id, {
      now: () => closedUntil,
    });
    assert.equal(recovered.oralProgress.position, 40,
      'a real-clock restore advances beyond an expired preparation and response');
    assert.equal(recovered.oralProgress.phase, 'ready');
    assert.equal(recovered.revision, oral.attempt.revision + 2);
    assert.deepEqual({
      status: recovered.oralProgress.recordings['39:1'].status,
      durationSeconds: recovered.oralProgress.recordings['39:1'].durationSeconds,
      technicalIssueCode: recovered.oralProgress.recordings['39:1'].technicalIssueCode,
    }, {
      status: 'technical_issue', durationSeconds: 0, technicalIssueCode: 'response_timeout',
    });
    oral = { attempt: recovered };

    oral = await completeEgeMockOralStageLedger(repository, owner.username, oral, candidate);
    assert.equal(Object.keys(oral.attempt.oralProgress.recordings).length, 11);
    const submitted = await repository.submitEgeMockOral(owner.username, started.attempt.id,
      candidate({ expectedRevision: oral.attempt.revision }));
    assert.equal(submitted.attempt.speakingAssessment.status, 'pending');
    assert.equal(submitted.attempt.speakingAssessment.items['41'].mode, 'experimental');
    const bridge = await repository.syncEgeMockSpeakingBridge(
      owner.username, started.attempt.id,
    );
    const bridgeReplay = await repository.syncEgeMockSpeakingBridge(
      owner.username, started.attempt.id,
    );
    assert.equal(bridge.id, started.attempt.id);
    assert.equal(bridge.selection_reason, 'ege_mock');
    assert.equal(bridge.status, 'submitted');
    assert.deepEqual([
      bridge.accent_locale, bridge.accent_profile_revision, bridge.accent_effective_at,
    ], [
      initiallyPinnedBridge.accent_locale,
      initiallyPinnedBridge.accent_profile_revision,
      initiallyPinnedBridge.accent_effective_at,
    ], 'file and PostgreSQL preserve the same first-sync EGE accent pin');
    assert.deepEqual(bridgeReplay, bridge, 'bridge sync is exact and replay-safe');
    const firstRecordedTask = bridge.responses.find(({ entries }) => (
      entries.some(({ status }) => status === 'completed')
    ));
    const firstRecordedResponse = firstRecordedTask.entries
      .find(({ status }) => status === 'completed');
    const sourceAssignment = bridge.assignments.find(({ task_type: taskType }) => (
      Number(taskType) === Number(firstRecordedTask.taskType)
    ));
    await assert.rejects(repository.claimSpeakingEvaluation(
      owner.username, {
        taskType: Number(firstRecordedTask.taskType),
        assignment: { source: 'EGE oral claim-time authorization contract' },
        transcript: 'Owner-bound submitted EGE oral response.',
      }, 'speaking-semantic-v4', crypto.createHash('sha256')
        .update(`expired-ege-semantic:${telegramBase}`).digest('hex'), {
        now: () => new Date('2100-01-01T00:00:00.000Z'),
        source: {
          sessionMode: 'full_section', sessionId: bridge.id,
          taskRef: sourceAssignment.task_id,
          taskRevision: Number(sourceAssignment.task_revision),
          catalogId: sourceAssignment.catalog_id,
          catalogRevision: Number(sourceAssignment.catalog_revision),
          accentLocale: bridge.accent_locale,
          assistanceUsed: true,
          targetedPractice: null,
        },
        voiceConsentPolicyVersion,
      },
    ), { code: 'SUBSCRIPTION_REQUIRED' },
    'semantic provider reservation rechecks subscription at its claim-time instant');
    const assessmentKey = crypto.randomUUID();
    const claimed = await repository.claimFullSpeakingSessionAssessment(
      owner.username, started.attempt.id, {
        taskType: firstRecordedTask.taskType,
        responseNumber: firstRecordedResponse.responseNumber,
        audioSha256: firstRecordedResponse.assessment_fingerprint,
        durationSeconds: firstRecordedResponse.recordingDurationSeconds,
        idempotencyKey: assessmentKey,
      },
      { voiceConsentPolicyVersion },
    );
    const claimedResponse = claimed.responses.find(({ taskType }) => (
      taskType === firstRecordedTask.taskType
    )).entries.find(({ responseNumber }) => (
      responseNumber === firstRecordedResponse.responseNumber
    ));
    assert.equal(claimedResponse.assessment_idempotency_key, assessmentKey,
      'the provider seam opens only after the authoritative EGE oral submission');
    const anotherRecordedResponse = firstRecordedTask.entries.find(({ status, responseNumber }) => (
      status === 'completed' && responseNumber !== firstRecordedResponse.responseNumber
    ));
    await repository.setPrivacyConsent(owner.username, {
      text_processing: false, voice_processing: false,
      policy_version: voiceConsentPolicyVersion,
    });
    const frozenPronunciationReplay = await repository.claimFullSpeakingSessionAssessment(
      owner.username, started.attempt.id, {
        taskType: firstRecordedTask.taskType,
        responseNumber: firstRecordedResponse.responseNumber,
        audioSha256: firstRecordedResponse.assessment_fingerprint,
        durationSeconds: firstRecordedResponse.recordingDurationSeconds,
        idempotencyKey: assessmentKey,
      },
      { voiceConsentPolicyVersion },
    );
    assert.equal(frozenPronunciationReplay.responses.find(({ taskType }) => (
      taskType === firstRecordedTask.taskType
    )).entries.find(({ responseNumber }) => (
      responseNumber === firstRecordedResponse.responseNumber
    )).assessment_idempotency_key, assessmentKey,
    'an exact frozen pronunciation claim replays after consent revocation without new provider authority');
    await assert.rejects(repository.claimFullSpeakingSessionAssessment(
      owner.username, started.attempt.id, {
        taskType: firstRecordedTask.taskType,
        responseNumber: anotherRecordedResponse.responseNumber,
        audioSha256: anotherRecordedResponse.assessment_fingerprint,
        durationSeconds: anotherRecordedResponse.recordingDurationSeconds,
        idempotencyKey: crypto.randomUUID(),
      },
      { voiceConsentPolicyVersion },
    ), { code: 'PRIVACY_CONSENT_REQUIRED' },
    'claim-time revocation closes the pronunciation provider seam inside the owner lock');
    assert.equal((await repository.getFullSpeakingSession(
      other.username, started.attempt.id,
    )), null, 'the reusable provider boundary is owner-isolated');
    const exported = await repository.exportUserData(owner.username);
    const record = exported.ege_mock_attempts.find(({ id }) => id === started.attempt.id);
    assert.equal(record.oral_progress.phase, 'ready_to_submit');
    assert.equal(record.speaking_assessment.version, 'ege-mock-speaking-assessment-v1');
    assert.equal(/(?:audio|transcript|referenceText)/iu.test(JSON.stringify(record)), false);
  } finally {
    await repository.deleteUserData(owner.username).catch(() => {});
    await repository.deleteUserData(other.username).catch(() => {});
  }
}

export async function assertEgeMockAssessmentRunSubscriptionContract(
  assert, repository, telegramBase, expireSubscriptions,
) {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const unclaimed = await repository.grantDays(
    telegramBase, 1, `EGE mock expired command ${telegramBase}`,
  );
  const authorized = await repository.grantDays(
    telegramBase + 1, 1, `EGE mock frozen authorization ${telegramBase}`,
  );

  async function prepareWrittenAttempt(username, requestHash) {
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: crypto.randomUUID(), requestHash,
    });
    return (await repository.submitEgeMockWritten(username, started.attempt.id, {
      expectedRevision: 0, idempotencyKey: crypto.randomUUID(),
      requestHash: requestHash.replace(/^./u, requestHash[0] === 'a' ? 'b' : 'd'),
    })).attempt;
  }

  try {
    const unclaimedAttempt = await prepareWrittenAttempt(unclaimed.username, 'a'.repeat(64));
    const authorizedAttempt = await prepareWrittenAttempt(authorized.username, 'c'.repeat(64));
    assert.equal(Number.isSafeInteger(
      unclaimedAttempt.writingAssessment.assessmentRevision,
    ), true, 'the server projects a monotonic writing-assessment revision');
    const unclaimedAssessmentRevision = unclaimedAttempt.writingAssessment.assessmentRevision;
    const frozen = await repository.claimEgeMockWritingAssessment(
      authorized.username, authorizedAttempt.id, {
        claimToken: crypto.randomUUID(),
        authorization: { textProcessingConsent: false, consentPolicyVersion: null },
      },
    );
    assert.equal(frozen.claimed, true);
    assert.ok(frozen.work.authorization?.subscriptionExpiresAt,
      'the accepted assessment freezes its subscription authorization');

    const staleCandidate = {
      idempotencyKey: crypto.randomUUID(), requestHash: '0'.repeat(64),
    };
    assert.deepEqual(await repository.beginEgeMockAssessmentRun(
      unclaimed.username, unclaimedAttempt.id, staleCandidate,
    ), { finalized: false }, 'the first device durably records its automatic UUID before expiry');

    const operationOptions = await expireSubscriptions([unclaimed, authorized]);
    const optionsFor = (username) => operationOptions?.[username] || {};
    let dispatches = 0;
    async function beginPublicAssessmentRun(username, attemptId, candidate) {
      const command = await repository.beginEgeMockAssessmentRun(
        username, attemptId, candidate, optionsFor(username),
      );
      if (!command.finalized) dispatches += 1;
      return command;
    }

    const candidate = { idempotencyKey: crypto.randomUUID(), requestHash: 'e'.repeat(64) };
    const rejected = await beginPublicAssessmentRun(
      unclaimed.username, unclaimedAttempt.id, candidate,
    );
    const rejectedAttempt = {
      ...unclaimedAttempt,
      writingAssessment: {
        ...unclaimedAttempt.writingAssessment,
        assessmentRevision: unclaimedAssessmentRevision + 1,
        runDisposition: 'subscription_required',
      },
    };
    assert.deepEqual(rejected, {
      finalized: true,
      response: {
        applied: true, replayed: false, disposition: 'subscription_required',
        attempt: rejectedAttempt,
      },
    });
    assert.equal(dispatches, 0, 'an expired unfrozen command must never dispatch provider work');
    assert.deepEqual(
      await repository.getEgeMockAttempt(unclaimed.username, unclaimedAttempt.id),
      rejectedAttempt,
      'observational attempt GET keeps the server-durable terminal disposition',
    );
    const blockedResult = await repository.getEgeMockResult(
      unclaimed.username, unclaimedAttempt.id,
    );
    assert.equal(blockedResult.assessmentRunDisposition, 'subscription_required',
      'safe result GET projects the same server-durable terminal disposition');
    assert.equal(blockedResult.writingAssessment.assessmentRevision,
      rejectedAttempt.writingAssessment.assessmentRevision,
      'safe result GET projects the same server-owned assessment revision');

    const replayed = await beginPublicAssessmentRun(
      unclaimed.username, unclaimedAttempt.id, candidate,
    );
    assert.deepEqual(replayed, {
      finalized: true,
      response: {
        ...rejected.response, applied: true, replayed: true,
      },
    });
    assert.equal(dispatches, 0, 'the exact durable terminal replay must never dispatch provider work');

    await repository.grantDays(
      telegramBase, 40_000, `EGE mock renewed command ${telegramBase}`,
    );
    const staleAfterRenewal = await repository.beginEgeMockAssessmentRun(
      unclaimed.username, unclaimedAttempt.id, staleCandidate,
    );
    assert.equal(staleAfterRenewal.finalized, true);
    assert.equal(staleAfterRenewal.response.disposition, 'subscription_required',
      'a pending pre-block UUID terminalizes without dispatch after renewal');
    assert.equal(dispatches, 0);
    const unmarkedAfterRenewal = await repository.beginEgeMockAssessmentRun(
      unclaimed.username, unclaimedAttempt.id,
      { idempotencyKey: crypto.randomUUID(), requestHash: '2'.repeat(64) },
    );
    assert.equal(unmarkedAfterRenewal.finalized, true);
    assert.equal(unmarkedAfterRenewal.response.disposition, 'subscription_required',
      'only a server-verified explicit renewal command may clear the durable block');
    assert.equal(dispatches, 0);
    const renewed = await repository.beginEgeMockAssessmentRun(
      unclaimed.username, unclaimedAttempt.id,
      {
        idempotencyKey: crypto.randomUUID(), requestHash: '1'.repeat(64), explicitRenewal: true,
      },
    );
    assert.deepEqual(renewed, { finalized: false },
      'only a new explicit command after entitlement renewal rearms assessment');
    const renewedAttempt = await repository.getEgeMockAttempt(
      unclaimed.username, unclaimedAttempt.id,
    );
    assert.equal(renewedAttempt.writingAssessment.runDisposition, undefined,
      'the owner-locked accepted command clears the durable subscription block');
    assert.equal(renewedAttempt.writingAssessment.assessmentRevision,
      rejectedAttempt.writingAssessment.assessmentRevision + 1,
      'clearing the block advances the same monotonic assessment revision');
    dispatches += 1;

    const recoverable = await beginPublicAssessmentRun(
      authorized.username, authorizedAttempt.id,
      { idempotencyKey: crypto.randomUUID(), requestHash: 'f'.repeat(64) },
    );
    assert.deepEqual(recoverable, { finalized: false },
      'a frozen authorization remains recoverable after the live subscription expires');
    assert.equal(dispatches, 2);
  } finally {
    await repository.deleteUserData(unclaimed.username).catch(() => {});
    await repository.deleteUserData(authorized.username).catch(() => {});
  }
}

export async function assertEgeMockAssessmentRevisionExhaustionContract(
  assert, adapter, telegramBase,
) {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const repository = () => adapter.repository();
  let username;
  let attemptId;
  let activeUsername;
  let recoveryUsername;
  let blockedRecoveryUsername;
  try {
    const owner = await repository().grantDays(
      telegramBase, 1, `EGE mock assessment revision ${telegramBase}`,
    );
    username = owner.username;
    const started = await repository().startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: crypto.randomUUID(), requestHash: '7'.repeat(64),
    });
    attemptId = started.attempt.id;
    await repository().submitEgeMockWritten(username, attemptId, {
      expectedRevision: 0, idempotencyKey: crypto.randomUUID(), requestHash: '8'.repeat(64),
    });
    await adapter.seedAssessmentRevision({
      username, attemptId, revision: Number.MAX_SAFE_INTEGER - 1,
    });
    const seeded = await repository().getEgeMockAttempt(username, attemptId);
    assert.equal(seeded.writingAssessment.assessmentRevision, Number.MAX_SAFE_INTEGER - 1);

    const expiredOptions = await adapter.expireSubscription(owner);
    const blockedKey = crypto.randomUUID();
    const blocked = await repository().beginEgeMockAssessmentRun(username, attemptId, {
      idempotencyKey: blockedKey, requestHash: '9'.repeat(64),
    }, expiredOptions || {});
    assert.equal(blocked.finalized, true);
    assert.equal(blocked.response.disposition, 'subscription_required');
    assert.equal(
      blocked.response.attempt.writingAssessment.assessmentRevision,
      Number.MAX_SAFE_INTEGER,
      'MAX_SAFE_INTEGER - 1 advances exactly once to MAX_SAFE_INTEGER',
    );
    const frozenAtMaximum = await repository().getEgeMockAttempt(username, attemptId);
    assert.equal(frozenAtMaximum.writingAssessment.runDisposition, 'subscription_required');

    await repository().grantDays(
      telegramBase, 40_000, `EGE mock assessment revision renewal ${telegramBase}`,
    );
    const explicitKey = crypto.randomUUID();
    const explicitCandidate = {
      idempotencyKey: explicitKey, requestHash: 'a'.repeat(64), explicitRenewal: true,
    };
    await assert.rejects(
      repository().beginEgeMockAssessmentRun(username, attemptId, explicitCandidate),
      { code: 'ASSESSMENT_REVISION_EXHAUSTED' },
    );
    assert.deepEqual(
      await repository().getEgeMockAttempt(username, attemptId), frozenAtMaximum,
      'exhaustion leaves the exact attempt/disposition snapshot unchanged',
    );
    assert.equal(await adapter.assessmentRunMutationCount({
      username, attemptId, idempotencyKey: explicitKey,
    }), 0, 'the rejected explicit UUID is never settled in the mutation ledger');

    const activeOwner = await repository().grantDays(
      telegramBase + 1, 1, `EGE mock active assessment revision ${telegramBase}`,
    );
    activeUsername = activeOwner.username;
    const activeStarted = await repository().startEgeMockAttempt(activeUsername, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: crypto.randomUUID(), requestHash: 'b'.repeat(64),
    });
    const activeAttemptId = activeStarted.attempt.id;
    await repository().submitEgeMockWritten(activeUsername, activeAttemptId, {
      expectedRevision: 0, idempotencyKey: crypto.randomUUID(), requestHash: 'c'.repeat(64),
    });
    await adapter.seedAssessmentRevision({
      username: activeUsername, attemptId: activeAttemptId,
      revision: Number.MAX_SAFE_INTEGER,
    });
    const activeAtMaximum = await repository().getEgeMockAttempt(activeUsername, activeAttemptId);
    const activeKey = crypto.randomUUID();
    await assert.rejects(
      repository().beginEgeMockAssessmentRun(activeUsername, activeAttemptId, {
        idempotencyKey: activeKey, requestHash: 'd'.repeat(64),
      }),
      { code: 'ASSESSMENT_REVISION_EXHAUSTED' },
    );
    assert.deepEqual(
      await repository().getEgeMockAttempt(activeUsername, activeAttemptId), activeAtMaximum,
      'an active subscription cannot begin a ledger or claim at the exhausted revision',
    );
    assert.equal(await adapter.assessmentRunMutationCount({
      username: activeUsername, attemptId: activeAttemptId, idempotencyKey: activeKey,
    }), 0, 'MAX_SAFE preflight runs before the first active assessment-run ledger row');

    const recoveryOwner = await repository().grantDays(
      telegramBase + 2, 1, `EGE mock terminal settlement ${telegramBase}`,
    );
    recoveryUsername = recoveryOwner.username;
    const recoveryStarted = await repository().startEgeMockAttempt(recoveryUsername, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: crypto.randomUUID(), requestHash: 'e'.repeat(64),
    });
    const recoveryAttemptId = recoveryStarted.attempt.id;
    await repository().submitEgeMockWritten(recoveryUsername, recoveryAttemptId, {
      expectedRevision: 0, idempotencyKey: crypto.randomUUID(), requestHash: 'f'.repeat(64),
    });
    await adapter.seedAssessmentRevision({
      username: recoveryUsername, attemptId: recoveryAttemptId,
      revision: Number.MAX_SAFE_INTEGER - 2,
    });
    const recoveryCandidate = {
      idempotencyKey: crypto.randomUUID(), requestHash: '1'.repeat(64),
    };
    assert.deepEqual(
      await repository().beginEgeMockAssessmentRun(
        recoveryUsername, recoveryAttemptId, recoveryCandidate,
      ),
      { finalized: false },
      'the assessment command ledger begins while two safe assessment mutations remain',
    );
    const recoveryClaimToken = 'cf000000-0000-4000-8000-000000000023';
    const recoveryClaim = await repository().claimEgeMockWritingAssessment(
      recoveryUsername, recoveryAttemptId, { claimToken: recoveryClaimToken },
    );
    assert.equal(recoveryClaim.claimed, true);
    await repository().failEgeMockWritingAssessment(recoveryUsername, recoveryAttemptId, {
      claimToken: recoveryClaimToken, reason: 'provider_unavailable',
    });
    const terminalAtMaximum = await repository().getEgeMockAttempt(
      recoveryUsername, recoveryAttemptId,
    );
    assert.equal(terminalAtMaximum.writingAssessment.status, 'retryable');
    assert.equal(
      terminalAtMaximum.writingAssessment.assessmentRevision,
      Number.MAX_SAFE_INTEGER,
    );

    assert.deepEqual(
      await repository().beginEgeMockAssessmentRun(
        recoveryUsername, recoveryAttemptId, recoveryCandidate,
      ),
      { finalized: false },
      'an existing pending UUID may resume only to settle its already-terminal MAX snapshot',
    );
    assert.deepEqual(
      await repository().getEgeMockAttempt(recoveryUsername, recoveryAttemptId),
      terminalAtMaximum,
      'resuming terminal settlement performs no assessment-state mutation',
    );
    assert.equal(await adapter.assessmentRunMutationCount({
      username: recoveryUsername, attemptId: recoveryAttemptId,
      idempotencyKey: recoveryCandidate.idempotencyKey,
    }), 1, 'terminal settlement reuses the exact pending ledger UUID');

    const settled = await repository().settleEgeMockAssessmentRun(
      recoveryUsername, recoveryAttemptId, recoveryCandidate,
    );
    assert.deepEqual(settled, {
      applied: true, replayed: false, attempt: terminalAtMaximum,
    });
    assert.deepEqual(
      await repository().beginEgeMockAssessmentRun(
        recoveryUsername, recoveryAttemptId, recoveryCandidate,
      ),
      {
        finalized: true,
        response: { ...settled, applied: true, replayed: true },
      },
      'the finalized MAX response is frozen for exact immutable replay',
    );
    assert.equal(await adapter.assessmentRunMutationCount({
      username: recoveryUsername, attemptId: recoveryAttemptId,
      idempotencyKey: recoveryCandidate.idempotencyKey,
    }), 1, 'terminal settlement never creates a second command ledger row');

    const blockedRecoveryOwner = await repository().grantDays(
      telegramBase + 3, 1, `EGE mock subscription settlement ${telegramBase}`,
    );
    blockedRecoveryUsername = blockedRecoveryOwner.username;
    const blockedRecoveryStarted = await repository().startEgeMockAttempt(
      blockedRecoveryUsername, {
        formId: form.id, formRevision: form.revision,
        catalogFingerprint: form.fingerprint,
        idempotencyKey: crypto.randomUUID(), requestHash: '2'.repeat(64),
      },
    );
    const blockedRecoveryAttemptId = blockedRecoveryStarted.attempt.id;
    await repository().submitEgeMockWritten(
      blockedRecoveryUsername, blockedRecoveryAttemptId, {
        expectedRevision: 0, idempotencyKey: crypto.randomUUID(),
        requestHash: '3'.repeat(64),
      },
    );
    await adapter.seedAssessmentRevision({
      username: blockedRecoveryUsername, attemptId: blockedRecoveryAttemptId,
      revision: Number.MAX_SAFE_INTEGER - 1,
    });
    const pendingCandidate = {
      idempotencyKey: crypto.randomUUID(), requestHash: '4'.repeat(64),
    };
    assert.deepEqual(
      await repository().beginEgeMockAssessmentRun(
        blockedRecoveryUsername, blockedRecoveryAttemptId, pendingCandidate,
      ),
      { finalized: false },
      'the first UUID is durable while one safe assessment mutation remains',
    );
    const blockedRecoveryOptions = await adapter.expireSubscription(blockedRecoveryOwner);
    const blockingCandidate = {
      idempotencyKey: crypto.randomUUID(), requestHash: '5'.repeat(64),
    };
    const blocking = await repository().beginEgeMockAssessmentRun(
      blockedRecoveryUsername, blockedRecoveryAttemptId, blockingCandidate,
      blockedRecoveryOptions || {},
    );
    assert.equal(blocking.finalized, true);
    assert.equal(blocking.response.disposition, 'subscription_required');
    const blockedAtMaximum = blocking.response.attempt;
    assert.equal(
      blockedAtMaximum.writingAssessment.assessmentRevision,
      Number.MAX_SAFE_INTEGER,
      'the second UUID durably advances the subscription block to MAX',
    );

    const recoveredBlock = await repository().beginEgeMockAssessmentRun(
      blockedRecoveryUsername, blockedRecoveryAttemptId, pendingCandidate,
      blockedRecoveryOptions || {},
    );
    assert.deepEqual(recoveredBlock, {
      finalized: true,
      response: {
        applied: true, replayed: false, disposition: 'subscription_required',
        attempt: blockedAtMaximum,
      },
    }, 'the older pending UUID finalizes the already-durable block without mutation');
    assert.deepEqual(
      await repository().getEgeMockAttempt(
        blockedRecoveryUsername, blockedRecoveryAttemptId,
      ),
      blockedAtMaximum,
      'pending UUID recovery leaves the exact MAX assessment snapshot unchanged',
    );
    assert.equal(await adapter.assessmentRunMutationCount({
      username: blockedRecoveryUsername, attemptId: blockedRecoveryAttemptId,
      idempotencyKey: pendingCandidate.idempotencyKey,
    }), 1, 'subscription settlement reuses the exact pending ledger UUID');
    assert.deepEqual(
      await repository().beginEgeMockAssessmentRun(
        blockedRecoveryUsername, blockedRecoveryAttemptId, pendingCandidate,
        blockedRecoveryOptions || {},
      ),
      {
        finalized: true,
        response: { ...recoveredBlock.response, applied: true, replayed: true },
      },
      'the finalized subscription block is frozen for exact immutable replay',
    );
    assert.equal(await adapter.assessmentRunMutationCount({
      username: blockedRecoveryUsername, attemptId: blockedRecoveryAttemptId,
      idempotencyKey: pendingCandidate.idempotencyKey,
    }), 1, 'subscription replay never creates a second command ledger row');
  } finally {
    if (username) await repository().deleteUserData(username).catch(() => {});
    if (activeUsername) await repository().deleteUserData(activeUsername).catch(() => {});
    if (recoveryUsername) await repository().deleteUserData(recoveryUsername).catch(() => {});
    if (blockedRecoveryUsername) {
      await repository().deleteUserData(blockedRecoveryUsername).catch(() => {});
    }
  }
}
