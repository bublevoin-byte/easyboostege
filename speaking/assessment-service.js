import crypto from 'node:crypto';
import { parsePcm16Mono16kWav } from './wav-audio.js';

function requestFingerprint(input) {
  const digest = crypto.createHash('sha256');
  digest.update(String(input.locale || ''));
  digest.update('\0');
  digest.update(String(input.mode || ''));
  digest.update('\0');
  digest.update(String(input.contextId || ''));
  digest.update('\0');
  digest.update(String(input.durationSeconds || ''));
  digest.update('\0');
  digest.update(String(input.mimeType || ''));
  digest.update('\0');
  digest.update(String(input.referenceText || ''));
  digest.update('\0');
  digest.update(Buffer.isBuffer(input.audio) ? input.audio : Buffer.alloc(0));
  return digest.digest('hex');
}

function unavailableAssessment(reason, status = 'unavailable') {
  return { status, available: false, reason, retryable: true };
}

function billingView(reservation, { conservative = false } = {}) {
  return {
    assessmentId: reservation.id,
    reservedSeconds: Number(reservation.reserved_seconds),
    billableSeconds: Number(reservation.billable_seconds || 0),
    conservative: Boolean(conservative),
  };
}

function publicStoredResult(reservation, quota) {
  const result = reservation.result && typeof reservation.result === 'object'
    ? structuredClone(reservation.result)
    : {
      assessment: unavailableAssessment('previous_attempt_incomplete'),
      billing: billingView(reservation, { conservative: true }),
    };
  return { ...result, quota };
}

function failureAssessment(error) {
  if (error?.code === 'SPEAKING_PRONUNCIATION_TIMEOUT') {
    return unavailableAssessment('provider_timeout', 'timeout');
  }
  return unavailableAssessment('provider_error');
}

function existingAssessmentResponse(reservation, quota, requestHash) {
  if (reservation.request_hash !== requestHash) {
    throw Object.assign(new Error('SPEAKING_ASSESSMENT_IDEMPOTENCY_CONFLICT'), {
      code: 'SPEAKING_ASSESSMENT_IDEMPOTENCY_CONFLICT',
    });
  }
  if (reservation.status === 'finalized') return publicStoredResult(reservation, quota);
  if (reservation.status === 'released') {
    if (reservation.result && typeof reservation.result === 'object') {
      return publicStoredResult(reservation, quota);
    }
    return {
      assessment: unavailableAssessment('provider_error'),
      billing: billingView(reservation),
      quota,
    };
  }
  return {
    assessment: {
      status: 'processing', available: false, reason: 'assessment_in_progress', retryable: true,
    },
    billing: billingView(reservation),
    quota,
  };
}

export function createSpeakingAssessmentService({ db, provider, now = () => new Date() }) {
  if (!db?.dispatchSpeakingAssessment || !provider?.status || !provider?.assess) {
    throw new TypeError('Speaking assessment service requires repository and provider adapters');
  }

  async function status(username) {
    const [providerStatus, quota] = await Promise.all([
      provider.status().catch(() => ({
        available: false, provider: 'azure-speech', reason: 'provider_unavailable',
      })),
      db.getSpeakingAssessmentQuota(username, { now: now() }),
    ]);
    return { provider: providerStatus, quota };
  }

  async function assess(username, input) {
    const wav = parsePcm16Mono16kWav(input?.audio);
    if (!wav) {
      throw Object.assign(new Error('SPEAKING_AUDIO_CONTAINER_INVALID'), {
        code: 'SPEAKING_AUDIO_CONTAINER_INVALID',
      });
    }
    if (wav.durationSeconds < 1) {
      throw Object.assign(new Error('SPEAKING_AUDIO_DURATION_INVALID'), {
        code: 'SPEAKING_AUDIO_DURATION_INVALID',
      });
    }
    const trustedInput = { ...input, durationSeconds: wav.durationSeconds };
    const requestHash = requestFingerprint(trustedInput);
    if (typeof db.getSpeakingAssessmentReservation === 'function') {
      const existing = await db.getSpeakingAssessmentReservation(username, trustedInput.idempotencyKey, { now: now() });
      if (existing.reservation) {
        return existingAssessmentResponse(existing.reservation, existing.quota, requestHash);
      }
    }
    const providerStatus = await provider.status().catch(() => ({
      available: false, provider: 'azure-speech', reason: 'provider_unavailable',
    }));
    if (!providerStatus.available) {
      return {
        assessment: unavailableAssessment(providerStatus.reason || 'provider_unavailable'),
        billing: { assessmentId: null, reservedSeconds: 0, billableSeconds: 0, conservative: false },
        quota: await db.getSpeakingAssessmentQuota(username, { now: now() }),
      };
    }

    const reservedSeconds = Math.ceil(wav.durationSeconds);
    const reservation = await db.reserveSpeakingAssessment(username, {
      id: crypto.randomUUID(),
      idempotencyKey: trustedInput.idempotencyKey,
      requestHash,
      reservedSeconds,
      locale: trustedInput.locale,
      now: now(),
    });
    if (!reservation.created) {
      return existingAssessmentResponse(reservation.reservation, reservation.quota, requestHash);
    }

    // Persist the indeterminate paid-dispatch window before entering provider code.
    // A crash or a hanging provider-start callback can then only recover conservatively.
    const dispatch = await db.dispatchSpeakingAssessment(
      username, trustedInput.idempotencyKey, { now: now() },
    );

    let processingStarted = false;
    let durableStartAttempted = false;
    let durableStartPromise = null;
    try {
      const assessment = await provider.assess(trustedInput, {
        onProcessingStarted: async () => {
          durableStartAttempted = true;
          durableStartPromise ??= Promise.resolve().then(() => (
            db.startSpeakingAssessment(username, trustedInput.idempotencyKey, { now: now() })
          ));
          await durableStartPromise;
          processingStarted = true;
        },
      });
      if (durableStartAttempted && !processingStarted) {
        return existingAssessmentResponse(
          dispatch.reservation, dispatch.quota, requestHash,
        );
      }
      const observed = Math.ceil(Number(assessment.processedDurationSeconds));
      const measured = Number.isFinite(observed) && observed > 0;
      const billableSeconds = measured
        ? Math.max(0, Math.min(reservedSeconds, observed))
        : reservedSeconds;
      const stored = {
        assessment,
        billing: {
          assessmentId: reservation.reservation.id,
          reservedSeconds,
          billableSeconds,
          conservative: !measured,
        },
      };
      const finalized = await db.finalizeSpeakingAssessment(username, trustedInput.idempotencyKey, {
        billableSeconds,
        result: stored,
        now: now(),
      });
      return publicStoredResult(finalized.reservation, finalized.quota);
    } catch (error) {
      const providerStarted = processingStarted || error?.processingStarted === true;
      const assessment = failureAssessment(error);
      if (providerStarted) {
        if (!processingStarted) {
          if (durableStartAttempted) {
            return existingAssessmentResponse(
              dispatch.reservation, dispatch.quota, requestHash,
            );
          }
          await db.startSpeakingAssessment(username, trustedInput.idempotencyKey, { now: now() });
        }
        const stored = {
          assessment,
          billing: {
            assessmentId: reservation.reservation.id,
            reservedSeconds,
            billableSeconds: reservedSeconds,
            conservative: true,
          },
        };
        const finalized = await db.finalizeSpeakingAssessment(username, trustedInput.idempotencyKey, {
          billableSeconds: reservedSeconds,
          result: stored,
          now: now(),
        });
        return publicStoredResult(finalized.reservation, finalized.quota);
      }
      const stored = {
        assessment,
        billing: {
          assessmentId: reservation.reservation.id,
          reservedSeconds,
          billableSeconds: 0,
          conservative: false,
        },
      };
      const released = await db.releaseSpeakingAssessment(username, trustedInput.idempotencyKey, {
        reason: 'provider_unavailable_before_start',
        result: stored,
        now: now(),
      });
      return publicStoredResult(released.reservation, released.quota);
    }
  }

  return Object.freeze({ status, assess });
}
