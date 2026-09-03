export const SPEAKING_EVALUATION_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const SPEAKING_EVALUATION_RETRYABLE_ERRORS = Object.freeze([
  'AI_NOT_CONFIGURED',
  'AI_PROVIDER_UNAVAILABLE',
]);

const retryableErrors = new Set(SPEAKING_EVALUATION_RETRYABLE_ERRORS);

function instantMilliseconds(value) {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

export function speakingEvaluationClaimRecoverable(attempt, now = new Date(), {
  allowInvalidProviderResponse = false,
} = {}) {
  if (!attempt) return false;
  if (attempt.status === 'failed') return retryableErrors.has(attempt.error_code)
    || (allowInvalidProviderResponse && attempt.error_code === 'AI_RESPONSE_INVALID');
  if (attempt.status !== 'pending') return false;
  const claimedAt = instantMilliseconds(attempt.evaluation_claimed_at ?? attempt.created_at);
  const current = instantMilliseconds(now);
  return claimedAt != null && current != null
    && current - claimedAt >= SPEAKING_EVALUATION_CLAIM_LEASE_MS;
}

export function speakingEvaluationProviderRepeatPossible(attempt, now = new Date(), options = {}) {
  if (!speakingEvaluationClaimRecoverable(attempt, now, options)) return false;
  if (attempt.status === 'pending') return true;
  return ['AI_PROVIDER_UNAVAILABLE', 'AI_RESPONSE_INVALID'].includes(attempt.error_code)
    && Boolean(attempt.provider);
}

export function recoverSpeakingEvaluationAttempt(attempt, now = new Date(), options = {}) {
  if (!speakingEvaluationClaimRecoverable(attempt, now, options)) return false;
  const generation = Number(attempt.evaluation_claim_generation);
  attempt.status = 'pending';
  attempt.review = null;
  attempt.provider = null;
  attempt.model = null;
  attempt.error_code = null;
  attempt.evaluated_at = null;
  attempt.evaluation_claimed_at = instantMilliseconds(now);
  attempt.evaluation_claim_generation = Number.isInteger(generation) && generation >= 1
    ? generation + 1 : 1;
  return true;
}
