import crypto from 'node:crypto';

export async function assertWritingEvaluationClaimContract(assert, repository, owner, otherOwner) {
  const policyVersion = 'writing-claim-test-v1';
  for (const username of [owner, otherOwner]) {
    const account = await repository.getUser(username);
    await repository.activateTrial(account.telegram_id, 30, account.display_name || 'Writing claim');
    await repository.setPrivacyConsent(username, {
      text_processing: true, voice_processing: false, policy_version: policyVersion,
    });
  }
  const authorized = { consentPolicyVersion: policyVersion };
  const idempotencyKey = crypto.randomUUID();
  const requestFingerprint = 'a'.repeat(64);
  const input = {
    taskType: 'writing_37',
    sourceTaskRef: 'builtin:writing_37:emily-new-flat',
    assignment: { from: 'Emily', stimulus: 'Answer three questions.', questionsTopic: 'her new flat' },
    answer: 'Dear Emily,\n\nThis exact answer keeps its newlines.',
    evaluatedAnswer: 'Dear Emily,\n\nThis exact answer keeps its newlines.',
  };

  const [first, raced] = await Promise.all([
    repository.claimWritingEvaluation(owner, input, 'writing-v5', requestFingerprint, idempotencyKey.toUpperCase(), authorized),
    repository.claimWritingEvaluation(owner, input, 'writing-v5', requestFingerprint, idempotencyKey, authorized),
  ]);
  assert.equal([first, raced].filter((claim) => claim.created).length, 1);
  assert.equal(first.attempt.id, raced.attempt.id);
  assert.equal(first.attempt.idempotency_key, idempotencyKey);
  assert.equal((await repository.getWritingEvaluationClaim(owner, idempotencyKey.toUpperCase())).id, first.attempt.id);

  await assert.rejects(
    repository.claimWritingEvaluation(owner, { ...input, answer: 'Changed answer' }, 'writing-v5', 'b'.repeat(64), idempotencyKey, authorized),
    /WRITING_EVALUATION_IDEMPOTENCY_CONFLICT/u,
  );
  const isolated = await repository.claimWritingEvaluation(
    otherOwner, input, 'writing-v5', requestFingerprint, idempotencyKey, authorized,
  );
  assert.equal(isolated.created, true);
  assert.notEqual(isolated.attempt.id, first.attempt.id);

  const responseSnapshot = { review: { overall_got: 4, overall_max: 6, criteria: [] }, provider: 'test',
    attemptId: Number(first.attempt.id), voiceTutor: null, assessment: { version: 'claim-contract-v1' },
    evaluationScope: { fullWords: 7, evaluatedWords: 7, truncated: false, evaluatedLimit: 140 } };
  await repository.finishWritingAttempt(first.attempt.id, {
    status: 'completed', provider: 'test', model: 'writing-contract-model',
    review: { overall_got: 4, overall_max: 6, criteria: [] },
    responseSnapshot,
  });
  const completed = await repository.getWritingEvaluationClaim(owner, idempotencyKey);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.review.overall_got, 4);
  assert.deepEqual(completed.response_snapshot, responseSnapshot);
  const losingCompletedKey = crypto.randomUUID();
  const processLossReplay = await repository.claimWritingEvaluation(
    owner, input, 'writing-v5', requestFingerprint, losingCompletedKey, authorized,
  );
  assert.equal(processLossReplay.created, false);
  assert.equal(processLossReplay.attempt.id, first.attempt.id);
  assert.deepEqual(processLossReplay.attempt.response_snapshot, responseSnapshot);
  const upgradedPrompt = await repository.claimWritingEvaluation(
    owner, input, 'writing-v99', requestFingerprint, crypto.randomUUID(), authorized,
  );
  assert.equal(upgradedPrompt.created, true,
    'a fresh key may execute the same payload under a newer prompt while exact-key replay remains stable');
  assert.notEqual(upgradedPrompt.attempt.id, first.attempt.id);
  const losingCompletedReplayAfterDeploy = await repository.claimWritingEvaluation(
    owner, input, 'writing-v99', requestFingerprint, losingCompletedKey, authorized,
  );
  assert.equal(losingCompletedReplayAfterDeploy.created, false);
  assert.equal(losingCompletedReplayAfterDeploy.attempt.id, first.attempt.id,
    'the losing device UUID remains an exact alias after its canonical result completed and the prompt changed');

  const ambiguousInput = { ...input, answer: `${input.answer}\nAn ambiguous provider dispatch.` };
  const ambiguousFingerprint = 'd'.repeat(64);
  const ambiguousKey = crypto.randomUUID();
  const pending = await repository.claimWritingEvaluation(
    owner, ambiguousInput, 'writing-v5', ambiguousFingerprint, ambiguousKey, authorized,
  );
  assert.equal(pending.created, true);
  const automaticRetry = await repository.claimWritingEvaluation(
    owner, ambiguousInput, 'writing-v5', ambiguousFingerprint, crypto.randomUUID(), authorized,
  );
  assert.equal(automaticRetry.created, false);
  assert.equal(automaticRetry.attempt.id, pending.attempt.id,
    'an ordinary retry cannot replace possibly paid provider work');
  const upgradedWhilePending = await repository.claimWritingEvaluation(
    owner, ambiguousInput, 'writing-v9', ambiguousFingerprint, crypto.randomUUID(), authorized,
  );
  assert.equal(upgradedWhilePending.created, false,
    'a prompt deploy cannot automatically repeat an identical possibly-paid pending answer');
  assert.equal(upgradedWhilePending.attempt.id, pending.attempt.id);
  await assert.rejects(
    repository.claimWritingEvaluation(
      owner, ambiguousInput, 'writing-v5', ambiguousFingerprint, crypto.randomUUID(), {
        ...authorized, acknowledgePossibleProviderRepeatKey: crypto.randomUUID(),
      },
    ),
    /WRITING_EVALUATION_REPEAT_ACK_INVALID/u,
    'an acknowledgement must name the canonical coalesced claim, never a discarded client alias',
  );
  await repository.markWritingEvaluationAmbiguous(pending.attempt.id);
  const leftAcknowledgementKey = crypto.randomUUID();
  const rightAcknowledgementKey = crypto.randomUUID();
  const [leftAcknowledgement, rightAcknowledgement] = await Promise.all([
    repository.claimWritingEvaluation(
      owner, ambiguousInput, 'writing-v5', ambiguousFingerprint, leftAcknowledgementKey, {
        ...authorized, acknowledgePossibleProviderRepeatKey: ambiguousKey,
      },
    ),
    repository.claimWritingEvaluation(
      owner, ambiguousInput, 'writing-v5', ambiguousFingerprint, rightAcknowledgementKey, {
        ...authorized, acknowledgePossibleProviderRepeatKey: ambiguousKey,
      },
    ),
  ]);
  assert.equal([leftAcknowledgement, rightAcknowledgement].filter((claim) => claim.created).length, 1,
    'two devices acknowledging the same predecessor coalesce to one successor');
  assert.equal(leftAcknowledgement.attempt.id, rightAcknowledgement.attempt.id);
  const acknowledgedRetry = leftAcknowledgement.created ? leftAcknowledgement : rightAcknowledgement;
  const losingAcknowledgementKey = leftAcknowledgement.created
    ? rightAcknowledgementKey : leftAcknowledgementKey;
  assert.notEqual(acknowledgedRetry.attempt.id, pending.attempt.id);
  await repository.finishWritingAttempt(acknowledgedRetry.attempt.id, {
    status: 'completed', provider: 'test', model: 'writing-contract-model',
    review: { words: 8, overall_got: 5, overall_max: 6, criteria: [] },
    responseSnapshot: { review: { overall_got: 5, overall_max: 6 }, attemptId: acknowledgedRetry.attempt.id },
  });
  const acknowledgementAfterSuccessorCompletion = await repository.claimWritingEvaluation(
    owner, ambiguousInput, 'writing-v5', ambiguousFingerprint, crypto.randomUUID(), {
      ...authorized, acknowledgePossibleProviderRepeatKey: ambiguousKey,
    },
  );
  assert.equal(acknowledgementAfterSuccessorCompletion.created, false);
  assert.equal(acknowledgementAfterSuccessorCompletion.attempt.id, acknowledgedRetry.attempt.id,
    'a losing device coalesces even when the acknowledged successor already completed');
  const losingAcknowledgementReplayAfterDeploy = await repository.claimWritingEvaluation(
    owner, ambiguousInput, 'writing-v99', ambiguousFingerprint, losingAcknowledgementKey, {
      ...authorized, acknowledgePossibleProviderRepeatKey: ambiguousKey,
    },
  );
  assert.equal(losingAcknowledgementReplayAfterDeploy.created, false);
  assert.equal(losingAcknowledgementReplayAfterDeploy.attempt.id, acknowledgedRetry.attempt.id,
    'the losing acknowledged UUID remains exact after successor completion and a prompt deploy');

  const crossVersionInput = { ...input, answer: `${input.answer}\nA deploy crossed two devices.` };
  const crossVersionFingerprint = 'e'.repeat(64);
  const crossVersionKey = crypto.randomUUID();
  const oldVersionPending = await repository.claimWritingEvaluation(
    owner, crossVersionInput, 'writing-v5', crossVersionFingerprint, crossVersionKey, authorized,
  );
  assert.equal(oldVersionPending.created, true);
  await repository.markWritingEvaluationAmbiguous(oldVersionPending.attempt.id);
  const [crossVersionLeft, crossVersionRight] = await Promise.all([
    repository.claimWritingEvaluation(
      owner, crossVersionInput, 'writing-v9', crossVersionFingerprint, crypto.randomUUID(), {
        ...authorized, acknowledgePossibleProviderRepeatKey: crossVersionKey,
      },
    ),
    repository.claimWritingEvaluation(
      owner, crossVersionInput, 'writing-v9', crossVersionFingerprint, crypto.randomUUID(), {
        ...authorized, acknowledgePossibleProviderRepeatKey: crossVersionKey,
      },
    ),
  ]);
  assert.equal([crossVersionLeft, crossVersionRight].filter((claim) => claim.created).length, 1,
    'two current clients replace one old-prompt ambiguous claim exactly once');
  assert.equal(crossVersionLeft.attempt.id, crossVersionRight.attempt.id,
    'the losing current client coalesces to the successor even though the predecessor used an old prompt');
  await repository.finishWritingAttempt(crossVersionLeft.attempt.id, {
    status: 'failed', provider: null, model: null, errorCode: 'TEST_CLEANUP',
  });
  const retired = await repository.getWritingEvaluationClaim(owner, ambiguousKey);
  assert.equal(retired.status, 'failed');
  assert.equal(retired.error_code, 'WRITING_EVALUATION_REPEAT_ACKNOWLEDGED');

  const writingProgress = await repository.getWritingProgressSummary(owner);
  assert.equal(writingProgress.version, 'writing-progress-v1');
  assert.equal(writingProgress.attemptCount, 2);
  assert.deepEqual(writingProgress.works.map((work) => work.attemptId), [
    first.attempt.id, acknowledgedRetry.attempt.id,
  ]);
  const staleDeviceProgress = {
    works: [{ attemptId: first.attempt.id, g: 4, m: 6 }], essays: 1,
    writingAttemptIds: Array.from({ length: 2_000 }, (_, index) => index + 1),
    prog: { write: 1, words: 44 },
  };
  await repository.mergeProgress(owner, staleDeviceProgress);
  const afterStaleDevice = await repository.getProgress(owner);
  assert.equal(afterStaleDevice.essays, 2, 'a stale device cannot regress the server attempt count');
  assert.deepEqual(afterStaleDevice.works.map((work) => work.attemptId), [
    first.attempt.id, acknowledgedRetry.attempt.id,
  ]);
  assert.equal(Object.hasOwn(afterStaleDevice, 'writingAttemptIds'), false,
    'an unbounded client tombstone array is never stored or echoed');
  assert.equal(afterStaleDevice.prog.write, writingProgress.average,
    'client progress cannot replace the server-authoritative Writing average');
  assert.equal(afterStaleDevice.prog.words, 44, 'unrelated progress fields are preserved');

  /* Revocation and claim use the same owner lock. Once revocation wins that lock, a fresh
     provider claim must fail even if route middleware observed the older consent. */
  await repository.setPrivacyConsent(owner, {
    text_processing: false, voice_processing: false, policy_version: policyVersion,
  });
  let preparationCalls = 0;
  await assert.rejects(
    repository.claimWritingEvaluation(owner, { ...input, answer: `${input.answer}\nA new answer.` },
      'writing-v5', 'c'.repeat(64), crypto.randomUUID(), {
        ...authorized,
        prepareEvaluation() { preparationCalls += 1; return { evaluatedAnswer: 'must not run' }; },
      }),
    (error) => error?.code === 'PRIVACY_CONSENT_REQUIRED' && error?.status === 403,
  );
  assert.equal(preparationCalls, 0, 'revoked text is not analysed or prepared inside a rejected claim');

  const exported = await repository.exportUserData(owner);
  assert.equal(Object.hasOwn(exported, 'writing_evaluation_idempotency_aliases'), false);
  assert.equal(exported.writing_attempts.length, 6);
  for (const attempt of exported.writing_attempts) {
    assert.equal(Object.hasOwn(attempt, 'idempotency_key'), false);
    assert.equal(Object.hasOwn(attempt, 'request_fingerprint'), false);
    assert.equal(Object.hasOwn(attempt, 'response_snapshot'), false);
  }
}
