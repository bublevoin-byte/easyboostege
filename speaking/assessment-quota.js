export const SPEAKING_ASSESSMENT_LIMITS = Object.freeze({ base: 3_600, premium: 14_400 });
// Longer than the maximum 120-second provider timeout plus bounded SDK cleanup.
export const SPEAKING_ASSESSMENT_LEASE_MS = 5 * 60 * 1_000;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class SpeakingAssessmentQuotaError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SpeakingAssessmentQuotaError';
    this.code = code;
  }
}

export function speakingAssessmentPeriodStart(now = new Date()) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_TIME_INVALID');
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1));
}

export function assertSpeakingAssessmentIdempotencyKey(value) {
  const key = String(value || '');
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_IDEMPOTENCY_KEY_INVALID');
  }
  return key;
}

export function assertSpeakingAssessmentReservation(input) {
  const id = String(input?.id || '');
  const idempotencyKey = String(input?.idempotencyKey || '');
  const requestHash = String(input?.requestHash || '').toLowerCase();
  const audioHash = input?.audioHash == null ? null : String(input.audioHash).toLowerCase();
  const reservedSeconds = Number(input?.reservedSeconds);
  const locale = String(input?.locale || '');
  const contextId = input?.contextId == null ? null : String(input.contextId);
  const now = new Date(input?.now ?? new Date());
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)
    || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
    || !/^[a-f0-9]{64}$/u.test(requestHash)
    || (audioHash != null && !/^[a-f0-9]{64}$/u.test(audioHash))
    || !Number.isInteger(reservedSeconds) || reservedSeconds < 1 || reservedSeconds > 180
    || !['en-GB', 'en-US'].includes(locale)
    || (contextId !== null && (!/^[a-zA-Z0-9:@._-]{1,300}$/u.test(contextId)))
    || !Number.isFinite(now.getTime())) {
    throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RESERVATION_INVALID');
  }
  return {
    id, idempotencyKey, requestHash, audioHash, reservedSeconds, locale, contextId, now,
    periodStart: speakingAssessmentPeriodStart(now),
  };
}

export function speakingAssessmentQuotaView(rows, { premium = false, now = new Date() } = {}) {
  const periodStart = speakingAssessmentPeriodStart(now).toISOString();
  const current = (rows || []).filter((row) => row.period_start === periodStart);
  const usedSeconds = current
    .filter((row) => row.status === 'finalized')
    .reduce((total, row) => total + Number(row.billable_seconds || 0), 0);
  const heldSeconds = current
    .filter((row) => ['reserved', 'dispatching', 'started'].includes(row.status))
    .reduce((total, row) => total + Number(row.reserved_seconds || 0), 0);
  const tier = premium ? 'premium' : 'base';
  const limitSeconds = SPEAKING_ASSESSMENT_LIMITS[tier];
  return {
    tier,
    periodStart,
    limitSeconds,
    usedSeconds,
    heldSeconds,
    remainingSeconds: Math.max(0, limitSeconds - usedSeconds - heldSeconds),
  };
}

export function speakingAssessmentExportDto(row) {
  return {
    id: row.id,
    status: row.status,
    locale: row.locale,
    context_id: row.context_id || null,
    period_start: row.period_start,
    allowance_seconds: Number(row.allowance_seconds),
    reserved_seconds: Number(row.reserved_seconds),
    billable_seconds: row.billable_seconds == null ? null : Number(row.billable_seconds),
    reserved_at: row.reserved_at,
    dispatch_started_at: row.dispatch_started_at || null,
    provider_started_at: row.provider_started_at || null,
    finalized_at: row.finalized_at || null,
    released_at: row.released_at || null,
    release_reason: row.release_reason || null,
    result: row.result ? structuredClone(row.result) : null,
  };
}

export function interruptedSpeakingAssessmentResult(row, {
  processingStarted = true,
  reason = processingStarted ? 'process_interrupted_after_start' : 'process_interrupted_before_start',
} = {}) {
  const reservedSeconds = Number(row?.reserved_seconds);
  const billableSeconds = processingStarted ? reservedSeconds : 0;
  return {
    assessment: {
      status: 'unavailable',
      available: false,
      reason,
      retryable: true,
    },
    billing: {
      assessmentId: row?.id,
      reservedSeconds,
      billableSeconds,
      conservative: processingStarted,
    },
  };
}
