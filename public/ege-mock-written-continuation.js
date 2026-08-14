const STORAGE_VERSION = 1;
const ATTEMPT_POLICY_ID = 'ege-mock-attempt-policy-v1';
const WRITTEN_DURATION_MS = 190 * 60 * 1000;

function egeMockWrittenStorageKey(owner) {
  return `easyboost-ege-mock-written-v1:${owner.username}:${owner.generation}`;
}

function egeMockWrittenInvalidationKey(owner) {
  return `${egeMockWrittenStorageKey(owner)}:invalidation`;
}

function validEgeMockWrittenTiming(attempt, expected = null) {
  const started = Date.parse(attempt?.writtenStartedAt);
  const deadline = Date.parse(attempt?.writtenDeadlineAt);
  return attempt?.policyId === ATTEMPT_POLICY_ID
    && Number.isFinite(started) && Number.isFinite(deadline) && deadline - started === WRITTEN_DURATION_MS
    && (!expected?.writtenStartedAt || attempt.writtenStartedAt === expected.writtenStartedAt)
    && (!expected?.writtenDeadlineAt || attempt.writtenDeadlineAt === expected.writtenDeadlineAt);
}

function egeMockLocalContinuation(storage, candidateOwner, form) {
  try {
    const username = String(candidateOwner?.username || '').trim();
    const generation = Number(candidateOwner?.generation);
    if (!username || !Number.isSafeInteger(generation) || generation < 0) return null;
    const owner = { username, generation };
    const saved = JSON.parse(storage?.getItem?.(egeMockWrittenStorageKey(owner)) || 'null');
    const invalidation = JSON.parse(storage?.getItem?.(egeMockWrittenInvalidationKey(owner)) || 'null');
    const invalidationWatermark = invalidation?.version === 1
      && invalidation.owner?.username === owner.username && invalidation.owner?.generation === owner.generation
      && Number.isSafeInteger(invalidation.watermark) && invalidation.watermark >= 0
      ? invalidation.watermark : 0;
    if (saved?.version !== STORAGE_VERSION || saved.owner?.username !== owner.username
      || saved.owner?.generation !== owner.generation || saved.formIdentity !== form?.identity
      || saved.catalogFingerprint !== form?.fingerprint
      || (Number.isSafeInteger(saved.invalidationWatermark) ? saved.invalidationWatermark : 0) !== invalidationWatermark
      || !['running', 'asset_blocked', 'objective_queued', 'objective_completed', 'submit_queued', 'written_submitted'].includes(saved.phase)
      || typeof saved.attemptId !== 'string'
      || typeof saved.attemptOwnerGeneration !== 'string' || !saved.attemptOwnerGeneration
      || !validEgeMockWrittenTiming(saved) || !Array.isArray(saved.queue)
      || !saved.answers || typeof saved.answers !== 'object' || Array.isArray(saved.answers)) return null;
    return { attemptId: saved.attemptId, phase: saved.phase };
  } catch (_) { return null; }
}

export {
  ATTEMPT_POLICY_ID, STORAGE_VERSION, WRITTEN_DURATION_MS, egeMockLocalContinuation,
  egeMockWrittenInvalidationKey, egeMockWrittenStorageKey, validEgeMockWrittenTiming,
};
