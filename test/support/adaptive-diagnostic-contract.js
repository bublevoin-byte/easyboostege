export async function assertAdaptiveDiagnosticRepositoryContract(assert, repository, username) {
  const startedAt = new Date('2026-08-04T09:00:00.000Z');
  const start = {
    id: '51000000-0000-4000-8000-000000000001',
    idempotencyKey: 'diagnostic-contract-start-01',
    requestHash: 'a'.repeat(64),
    catalogVersion: 'ege-short-diagnostic-v2',
    currentItemId: 'grammar-forms-present-perfect-1',
    now: startedAt,
    expiresAt: new Date('2026-08-04T09:20:00.000Z'),
  };
  const created = await repository.startAdaptiveDiagnostic(username, start);
  const replay = await repository.startAdaptiveDiagnostic(username, start);
  assert.equal(created.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.diagnostic.id, created.diagnostic.id);
  assert.equal('username' in created.diagnostic, false);
  assert.equal('idempotency_key' in created.diagnostic, false);
  assert.match(created.diagnostic.started_at, /^2026-08-04T09:00:00/u);

  const resumeRequests = [2, 3].map((suffix) => repository.startAdaptiveDiagnostic(username, {
    ...start,
    id: `51000000-0000-4000-8000-00000000000${suffix}`,
    idempotencyKey: `diagnostic-contract-start-0${suffix}`,
    requestHash: String(suffix).repeat(64),
  }));
  const [resumedSecond, resumedThird] = await Promise.all(resumeRequests);
  assert.equal(resumedSecond.created, false);
  assert.equal(resumedThird.created, false);
  assert.equal(resumedSecond.diagnostic.id, start.id);
  assert.equal(resumedThird.diagnostic.id, start.id);
  assert.equal(resumedSecond.diagnostic.answered_items, 0);
  await assert.rejects(
    repository.startAdaptiveDiagnostic(username, {
      ...start,
      idempotencyKey: 'diagnostic-contract-start-02',
      requestHash: '9'.repeat(64),
    }),
    /ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT/u,
  );

  const answered = await repository.answerAdaptiveDiagnostic(username, {
    id: '52000000-0000-4000-8000-000000000001',
    diagnosticId: start.id,
    itemId: start.currentItemId,
    skillId: 'ege.grammar.forms',
    module: 'grammar',
    evidenceQuality: 'independent',
    choiceId: 'a',
    correct: true,
    responseMs: 25_000,
    idempotencyKey: 'diagnostic-contract-answer-01',
    requestHash: 'b'.repeat(64),
    nextItemId: null,
    status: 'ready',
    stopReason: 'target_coverage',
    now: new Date('2026-08-04T09:00:25.000Z'),
  });
  const answerReplay = await repository.answerAdaptiveDiagnostic(username, {
    id: '52000000-0000-4000-8000-000000000002',
    diagnosticId: start.id,
    itemId: start.currentItemId,
    skillId: 'ege.grammar.forms',
    module: 'grammar',
    evidenceQuality: 'independent',
    choiceId: 'a',
    correct: true,
    responseMs: 25_000,
    idempotencyKey: 'diagnostic-contract-answer-01',
    requestHash: 'b'.repeat(64),
    nextItemId: null,
    status: 'ready',
    stopReason: 'target_coverage',
    now: new Date('2026-08-04T09:00:25.000Z'),
  });
  assert.equal(answered.created, true);
  assert.equal(answerReplay.created, false);
  assert.equal(answered.diagnostic.answered_items, 1);
  assert.equal(answered.diagnostic.responses[0].skill_id, 'ege.grammar.forms');
  assert.equal(answered.diagnostic.responses[0].evidence_quality, 'independent');

  for (let suffix = 4; suffix <= 16; suffix += 1) {
    const boundedClaim = await repository.startAdaptiveDiagnostic(username, {
      ...start,
      id: `51000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
      idempotencyKey: `diagnostic-contract-start-${String(suffix).padStart(2, '0')}`,
      requestHash: suffix.toString(16).padStart(64, '0'),
      now: new Date('2026-08-04T09:00:30.000Z'),
    });
    assert.equal(boundedClaim.created, false);
    assert.equal(boundedClaim.diagnostic.status, 'ready');
  }
  await assert.rejects(
    repository.startAdaptiveDiagnostic(username, {
      ...start,
      id: '51000000-0000-4000-8000-000000000017',
      idempotencyKey: 'diagnostic-contract-start-17',
      requestHash: 'f'.repeat(64),
      now: new Date('2026-08-04T09:00:31.000Z'),
    }),
    /ADAPTIVE_DIAGNOSTIC_START_LIMIT/u,
  );

  const completionResponseSnapshot = {
    completed: true,
    diagnostic: {
      id: start.id,
      catalogVersion: start.catalogVersion,
      status: 'completed',
      estimatedMinutes: 15,
      deadlineMinutes: 20,
      answeredItems: 1,
      maxItems: 12,
      progressPercent: 10,
      canComplete: true,
      stopReason: 'target_coverage',
      startedAt: startedAt.toISOString(),
      expiresAt: start.expiresAt.toISOString(),
      completedAt: '2026-08-04T09:01:00.000Z',
      unsafeInternal: 'must-not-persist',
    },
    item: null,
    result: {
      preliminary: true,
      confidence: 7,
      answeredItems: 1,
      correctItems: 1,
      explanationCodes: ['short_diagnostic_complete'],
      unsafeInternal: 'must-not-persist',
    },
    profile: {
      taxonomyVersion: 'ege-en-v2',
      weightingVersion: 'adaptive-evidence-v2',
      profileCalculationRevision: 1,
      evidenceWatermarkVersion: 'adaptive-evidence-watermark-v1',
      evidenceObservedAt: '2026-08-04T09:01:00.000Z',
      evidenceSourceCount: 2,
      preliminary: true,
      status: 'preliminary',
      confidence: 7,
      evidenceCount: 1,
      independentEvidenceCount: 1,
      assistedEvidenceCount: 0,
      clientReportedEvidenceCount: 0,
      independentModuleCount: 1,
      establishedSkillCount: 0,
      needsDiagnostic: false,
      explanationCodes: ['short_diagnostic_complete'],
      skills: [],
      modules: [],
      unsafeInternal: 'must-not-persist',
    },
    unsafeInternal: 'must-not-persist',
  };
  const completion = {
    diagnosticId: start.id,
    idempotencyKey: 'diagnostic-contract-complete',
    requestHash: 'c'.repeat(64),
    now: new Date('2026-08-04T09:01:00.000Z'),
    responseSnapshot: completionResponseSnapshot,
  };
  await assert.rejects(repository.completeAdaptiveDiagnostic(username, {
    ...completion,
    responseSnapshot: null,
  }), /ADAPTIVE_DIAGNOSTIC_COMPLETION_SNAPSHOT_INVALID/u);
  assert.equal((await repository.getAdaptiveDiagnostic(username, start.id)).status, 'ready');
  const concurrentCompletions = await Promise.all([
    repository.completeAdaptiveDiagnostic(username, completion),
    repository.completeAdaptiveDiagnostic(username, completion),
  ]);
  assert.deepEqual(concurrentCompletions.map((entry) => entry.created).sort(), [false, true]);
  const completed = concurrentCompletions.find((entry) => entry.created);
  assert.equal(completed.diagnostic.status, 'completed');
  assert.deepEqual(concurrentCompletions[0].responseSnapshot, concurrentCompletions[1].responseSnapshot);
  assert.equal(JSON.stringify(completed.responseSnapshot).includes('unsafeInternal'), false);
  const claimedCompletion = await repository.getAdaptiveDiagnosticCompletionReplay(username, {
    diagnosticId: start.id,
    idempotencyKey: completion.idempotencyKey,
    requestHash: completion.requestHash,
  });
  assert.deepEqual(claimedCompletion, completed.responseSnapshot);
  const exactAfterChangedCandidate = await repository.completeAdaptiveDiagnostic(username, {
    ...completion,
    responseSnapshot: {
      ...completionResponseSnapshot,
      result: { ...completionResponseSnapshot.result, confidence: 99 },
    },
  });
  assert.equal(exactAfterChangedCandidate.created, false);
  assert.deepEqual(exactAfterChangedCandidate.responseSnapshot, completed.responseSnapshot);
  const differentKeyReplay = await repository.getAdaptiveDiagnosticCompletionReplay(username, {
    diagnosticId: start.id,
    idempotencyKey: 'diagnostic-contract-complete-different',
    requestHash: 'd'.repeat(64),
  });
  assert.deepEqual(differentKeyReplay, completed.responseSnapshot);
  await assert.rejects(repository.getAdaptiveDiagnosticCompletionReplay(username, {
    diagnosticId: start.id,
    idempotencyKey: completion.idempotencyKey,
    requestHash: '0'.repeat(64),
  }), /ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT/u);
  assert.equal(await repository.getCurrentAdaptiveDiagnostic(username), null);

  const answerReplayAfterCompletion = await repository.answerAdaptiveDiagnostic(username, {
    id: '52000000-0000-4000-8000-000000000099',
    diagnosticId: start.id,
    itemId: start.currentItemId,
    skillId: 'ege.grammar.forms',
    module: 'grammar',
    evidenceQuality: 'independent',
    choiceId: 'a',
    correct: true,
    responseMs: 25_000,
    idempotencyKey: 'diagnostic-contract-answer-01',
    requestHash: 'b'.repeat(64),
    nextItemId: 'must-not-replace-the-snapshot',
    status: 'in_progress',
    stopReason: null,
    now: new Date('2026-08-04T09:02:00.000Z'),
  });
  assert.equal(answerReplayAfterCompletion.created, false);
  assert.equal(answerReplayAfterCompletion.diagnostic.status, 'ready');
  assert.equal(answerReplayAfterCompletion.diagnostic.answered_items, 1);
  assert.equal(answerReplayAfterCompletion.diagnostic.current_item_id, null);

  assert.equal((await repository.getAdaptiveLearningCommercialUsage(username)).shortDiagnosticsCompleted, 1);
  await assert.rejects(repository.startAdaptiveDiagnostic(username, {
    ...start,
    id: '51000000-0000-4000-8000-000000000019',
    idempotencyKey: 'diagnostic-contract-free-repeat',
    requestHash: '1'.repeat(64),
    commercialMode: 'free_short',
    now: new Date('2026-08-04T09:02:00.000Z'),
  }), /ADAPTIVE_FREE_DIAGNOSTIC_USED/u);

  const replayedResume = await repository.startAdaptiveDiagnostic(username, {
    ...start,
    id: '51000000-0000-4000-8000-000000000009',
    idempotencyKey: 'diagnostic-contract-start-02',
    requestHash: '2'.repeat(64),
    now: new Date('2026-08-04T09:02:00.000Z'),
  });
  assert.equal(replayedResume.created, false);
  assert.equal(replayedResume.diagnostic.id, start.id);
  assert.equal(replayedResume.diagnostic.status, 'in_progress');
  assert.equal(replayedResume.diagnostic.answered_items, 0);

  const afterRetention = await repository.startAdaptiveDiagnostic(username, {
    ...start,
    id: '51000000-0000-4000-8000-000000000017',
    idempotencyKey: 'diagnostic-contract-start-17',
    requestHash: 'f'.repeat(64),
    now: new Date('2026-08-05T10:00:00.000Z'),
    expiresAt: new Date('2026-08-05T10:20:00.000Z'),
  });
  assert.equal(afterRetention.created, true);
  assert.notEqual(afterRetention.diagnostic.id, start.id);

  const expiredClaimKeyReused = await repository.startAdaptiveDiagnostic(username, {
    ...start,
    id: '51000000-0000-4000-8000-000000000018',
    idempotencyKey: 'diagnostic-contract-start-02',
    requestHash: '2'.repeat(64),
    now: new Date('2026-08-05T10:00:01.000Z'),
    expiresAt: new Date('2026-08-05T10:20:01.000Z'),
  });
  assert.equal(expiredClaimKeyReused.created, false);
  assert.equal(expiredClaimKeyReused.diagnostic.id, afterRetention.diagnostic.id);

  const exported = await repository.exportUserData(username);
  assert.equal(exported.adaptive_diagnostic_sessions.length, 2);
  assert.equal(exported.adaptive_diagnostic_responses.length, 1);
  assert.equal(exported.adaptive_diagnostic_sessions[0].id, start.id);
  assert.equal(exported.adaptive_diagnostic_responses[0].skill_id, 'ege.grammar.forms');
  assert.equal(exported.adaptive_diagnostic_responses[0].evidence_quality, 'independent');
  assert.equal(JSON.stringify(exported.adaptive_diagnostic_sessions).includes('idempotency'), false);
  assert.equal(JSON.stringify(exported).includes('completion_response_snapshot'), false);
  assert.equal(JSON.stringify(exported).includes('unsafeInternal'), false);
  assert.equal(JSON.stringify(exported.adaptive_diagnostic_responses).includes('request_hash'), false);
  assert.equal(JSON.stringify(exported).includes('diagnostic-contract-start-02'), false);
}
