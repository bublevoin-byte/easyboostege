const PROFILE_KEYS = Object.freeze([
  'assisted_evidence_count',
  'client_reported_evidence_count',
  'confidence',
  'established_skill_count',
  'estimates',
  'evidence_count',
  'evidence_observed_at',
  'evidence_source_count',
  'evidence_watermark_version',
  'explanation_codes',
  'independent_evidence_count',
  'independent_module_count',
  'needs_diagnostic',
  'preliminary',
  'profile_calculation_revision',
  'status',
  'taxonomy_version',
  'updated_at',
  'weighting_version',
]);

const ESTIMATE_KEYS = Object.freeze([
  'critical_retention_expires_at',
  'due_state',
  'effective_evidence_count',
  'evidence_count',
  'evidence_quality',
  'explanation_code',
  'independent_evidence_count',
  'last_observed_at',
  'mastery',
  'module',
  'skill_id',
  'status',
  'taxonomy_version',
  'uncertainty',
  'updated_at',
]);

export async function assertAdaptiveProfileRepositoryContract(assert, repository, username, profile, now) {
  const saved = await repository.saveAdaptiveLearningProfile(username, profile, { now });
  const loaded = await repository.getAdaptiveLearningProfile(username);

  assert.deepEqual(saved, loaded, 'save and get return the same repository DTO');
  assert.deepEqual(Object.keys(loaded).sort(), [...PROFILE_KEYS]);
  assert.equal(loaded.updated_at, now.toISOString());
  assert.equal(loaded.estimates.length, 12);
  assert.deepEqual(
    loaded.estimates.map((estimate) => estimate.skill_id),
    [...loaded.estimates.map((estimate) => estimate.skill_id)].sort(),
    'estimate order is backend-independent',
  );
  for (const estimate of loaded.estimates) {
    assert.deepEqual(Object.keys(estimate).sort(), [...ESTIMATE_KEYS]);
    assert.equal(estimate.updated_at, now.toISOString());
    assert.equal('username' in estimate, false);
  }
  assert.equal('username' in loaded, false);
  const exported = await repository.exportUserData(username);
  const { estimates, ...profileWithoutEstimates } = loaded;
  assert.deepEqual(exported.adaptive_learning_profile, profileWithoutEstimates);
  assert.deepEqual(exported.adaptive_learning_skill_estimates, estimates);
  assert.deepEqual(
    JSON.parse(JSON.stringify({
      profile: exported.adaptive_learning_profile,
      estimates: exported.adaptive_learning_skill_estimates,
    })),
    { profile: profileWithoutEstimates, estimates },
    'adaptive export is already one backend-independent JSON shape',
  );
  return loaded;
}

export async function assertAdaptiveProfileRejectsStale(
  assert,
  repository,
  username,
  { older, newer, backfilled },
) {
  const first = await repository.saveAdaptiveLearningProfile(username, newer, {
    now: new Date('2026-08-04T07:00:00.000Z'),
  });
  assert.equal(first.evidence_source_count, 2);

  const stale = await repository.saveAdaptiveLearningProfile(username, older, {
    now: new Date('2026-08-04T07:01:00.000Z'),
  });
  assert.equal(stale.evidence_source_count, 2, 'older computation is a no-op');

  const acceptedBackfill = await repository.saveAdaptiveLearningProfile(username, backfilled, {
    now: new Date('2026-08-04T07:02:00.000Z'),
  });
  assert.equal(acceptedBackfill.evidence_source_count, 3, 'same latest time with a larger source count wins');

  const regressiveSameTime = await repository.saveAdaptiveLearningProfile(username, newer, {
    now: new Date('2026-08-04T07:03:00.000Z'),
  });
  assert.equal(regressiveSameTime.evidence_source_count, 3, 'same-time lower count cannot erase a backfill');
  assert.deepEqual(await repository.getAdaptiveLearningProfile(username), acceptedBackfill);
  return acceptedBackfill;
}

export async function assertAdaptiveProfileAppendOnlyOrdering(assert, repository, username, buildProfile) {
  const attempts = (count, observedAt) => Array.from({ length: count }, (_, index) => ({
    id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    module: 'grammar',
    activity: 'grammar_19_24',
    score: 8,
    max_score: 10,
    evidence_quality: 'server_verified_unassisted',
    created_at: observedAt,
  }));
  const current = buildProfile({ attempts: attempts(100, '2026-08-04T10:00:00.000Z') });
  const laterButSmaller = buildProfile({ attempts: attempts(2, '2026-08-04T10:01:00.000Z') });
  const moreButOlder = buildProfile({ attempts: attempts(101, '2026-08-04T09:59:00.000Z') });

  await repository.saveAdaptiveLearningProfile(username, current, {
    now: new Date('2026-08-04T10:02:00.000Z'),
  });
  const rejectedSmaller = await repository.saveAdaptiveLearningProfile(username, laterButSmaller, {
    now: new Date('2026-08-04T10:03:00.000Z'),
  });
  assert.equal(rejectedSmaller.evidence_source_count, 100, 'a later two-event snapshot cannot erase 100 events');

  const newerAlgorithmButSmaller = {
    ...laterButSmaller,
    profileCalculationRevision: laterButSmaller.profileCalculationRevision + 1,
  };
  const acceptedNewerAlgorithmButSmaller = await repository.saveAdaptiveLearningProfile(
    username,
    newerAlgorithmButSmaller,
    { now: new Date('2026-08-04T10:03:30.000Z') },
  );
  assert.equal(
    acceptedNewerAlgorithmButSmaller.evidence_source_count,
    2,
    'a newer calculation revision may intentionally filter sources under a new algorithm',
  );
  assert.equal(acceptedNewerAlgorithmButSmaller.profile_calculation_revision, 2);

  const acceptedBackfill = await repository.saveAdaptiveLearningProfile(username, moreButOlder, {
    now: new Date('2026-08-04T10:04:00.000Z'),
  });
  assert.equal(acceptedBackfill.evidence_source_count, 2,
    'an older calculation revision cannot overwrite a newer revision even with a larger backfill');

  const higherCalculationRevision = {
    ...moreButOlder,
    profileCalculationRevision: moreButOlder.profileCalculationRevision + 1,
  };
  const recomputed = await repository.saveAdaptiveLearningProfile(username, higherCalculationRevision, {
    now: new Date('2026-08-04T10:05:00.000Z'),
  });
  assert.equal(recomputed.profile_calculation_revision, 2, 'the current algorithm revision remains authoritative');
  assert.equal(recomputed.evidence_source_count, 101,
    'a larger append-only backfill is accepted inside the same calculation revision');

  const olderAlgorithmWithLaterEvidence = {
    ...buildProfile({ attempts: attempts(102, '2026-08-04T10:06:00.000Z') }),
    profileCalculationRevision: 1,
  };
  const rejectedOldAlgorithm = await repository.saveAdaptiveLearningProfile(username, olderAlgorithmWithLaterEvidence, {
    now: new Date('2026-08-04T10:07:00.000Z'),
  });
  assert.equal(rejectedOldAlgorithm.profile_calculation_revision, 2, 'an old algorithm never overwrites a newer revision');
  assert.equal(rejectedOldAlgorithm.evidence_source_count, 101);
}
