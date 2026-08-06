import crypto from 'node:crypto';

import { SPEAKING_ASSESSMENT_LEASE_MS } from '../../speaking/assessment-quota.js';

const BASE_LIMIT_SECONDS = 3_600;
const PREMIUM_LIMIT_SECONDS = 14_400;

function reservationInput(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    requestHash: crypto.randomBytes(32).toString('hex'),
    reservedSeconds: 60,
    locale: 'en-US',
    now: new Date('2026-08-06T10:00:00.000Z'),
    ...overrides,
  };
}

export async function assertSpeakingAssessmentQuotaContract(assert, repository, username) {
  const first = reservationInput({
    contextId: 'task1:71111111-1111-4111-8111-111111111111:read-v1-001@1',
  });
  const reserved = await repository.reserveSpeakingAssessment(username, first);
  assert.equal(reserved.created, true);
  assert.equal(reserved.reservation.status, 'reserved');
  assert.equal(reserved.reservation.reserved_seconds, 60);
  assert.equal(reserved.reservation.context_id, first.contextId);
  assert.deepEqual(reserved.quota, {
    tier: 'base', periodStart: '2026-08-01T00:00:00.000Z', limitSeconds: BASE_LIMIT_SECONDS,
    usedSeconds: 0, heldSeconds: 60, remainingSeconds: BASE_LIMIT_SECONDS - 60,
  });
  await assert.rejects(
    repository.startSpeakingAssessment(username, first.idempotencyKey, {
      now: new Date('2026-08-06T10:00:00.250Z'),
    }),
    (error) => error?.code === 'SPEAKING_ASSESSMENT_NOT_DISPATCHED',
  );

  const dispatching = await repository.dispatchSpeakingAssessment(username, first.idempotencyKey, {
    now: new Date('2026-08-06T10:00:00.500Z'),
  });
  assert.equal(dispatching.reservation.status, 'dispatching');
  assert.equal(dispatching.reservation.dispatch_started_at, '2026-08-06T10:00:00.500Z');
  assert.equal(dispatching.reservation.provider_started_at, null);

  const started = await repository.startSpeakingAssessment(username, first.idempotencyKey, {
    now: new Date('2026-08-06T10:00:01.000Z'),
  });
  assert.equal(started.reservation.status, 'started');
  assert.equal(started.reservation.provider_started_at, '2026-08-06T10:00:01.000Z');

  const safeResult = {
    status: 'success', locale: 'en-US', transcript: 'A short trusted transcript.',
    processedDurationSeconds: 42,
  };
  const finalized = await repository.finalizeSpeakingAssessment(username, first.idempotencyKey, {
    billableSeconds: 42,
    result: safeResult,
    now: new Date('2026-08-06T10:00:03.000Z'),
  });
  assert.equal(finalized.finalized, true);
  assert.equal(finalized.reservation.status, 'finalized');
  assert.equal(finalized.reservation.billable_seconds, 42);
  assert.deepEqual(finalized.reservation.result, safeResult);
  assert.equal(finalized.quota.usedSeconds, 42);
  assert.equal(finalized.quota.heldSeconds, 0);
  assert.equal(finalized.quota.remainingSeconds, BASE_LIMIT_SECONDS - 42);

  const finalizedAgain = await repository.finalizeSpeakingAssessment(username, first.idempotencyKey, {
    billableSeconds: 60,
    result: { status: 'must-not-replace-canonical-result' },
    now: new Date('2026-08-06T10:00:04.000Z'),
  });
  assert.equal(finalizedAgain.finalized, false);
  assert.equal(finalizedAgain.reservation.billable_seconds, 42);
  assert.deepEqual(finalizedAgain.reservation.result, safeResult);

  const replay = await repository.reserveSpeakingAssessment(username, {
    ...first, id: crypto.randomUUID(), now: new Date('2026-08-06T10:00:05.000Z'),
  });
  assert.equal(replay.created, false);
  assert.equal(replay.reservation.id, first.id);
  assert.equal(replay.reservation.billable_seconds, 42);
  await assert.rejects(
    repository.reserveSpeakingAssessment(username, {
      ...first, id: crypto.randomUUID(), requestHash: 'f'.repeat(64),
    }),
    (error) => error?.code === 'SPEAKING_ASSESSMENT_IDEMPOTENCY_CONFLICT',
  );

  const unused = reservationInput({ reservedSeconds: 100 });
  await repository.reserveSpeakingAssessment(username, unused);
  const safeReleaseResult = {
    assessment: { status: 'unavailable', reason: 'provider_error', retryable: true },
    billing: {
      assessmentId: unused.id, reservedSeconds: 100, billableSeconds: 0, conservative: false,
    },
  };
  const released = await repository.releaseSpeakingAssessment(username, unused.idempotencyKey, {
    reason: 'provider_unavailable_before_start',
    result: safeReleaseResult,
    now: new Date('2026-08-06T10:00:06.000Z'),
  });
  assert.equal(released.released, true);
  assert.equal(released.reservation.status, 'released');
  assert.equal(released.reservation.billable_seconds, 0);
  assert.deepEqual(released.reservation.result, safeReleaseResult);
  assert.equal(released.quota.usedSeconds, 42);
  assert.equal(released.quota.heldSeconds, 0);
  const releasedReplay = await repository.reserveSpeakingAssessment(username, {
    ...unused, id: crypto.randomUUID(), now: new Date('2026-08-06T10:00:07.000Z'),
  });
  assert.equal(releasedReplay.created, false);
  assert.deepEqual(releasedReplay.reservation.result, safeReleaseResult);

  const staleReserved = reservationInput({
    reservedSeconds: 70,
    now: new Date('2026-08-06T11:00:00.000Z'),
  });
  await repository.reserveSpeakingAssessment(username, staleReserved);
  const afterReservedLease = new Date(staleReserved.now.getTime() + SPEAKING_ASSESSMENT_LEASE_MS + 1);
  const reconciledReservedQuota = await repository.getSpeakingAssessmentQuota(username, { now: afterReservedLease });
  assert.equal(reconciledReservedQuota.heldSeconds, 0);
  const exportedAfterReservedRecovery = await repository.exportUserData(username);
  const recoveredReserved = exportedAfterReservedRecovery.speaking_assessments
    .find((entry) => entry.id === staleReserved.id);
  assert.equal(recoveredReserved.status, 'released');
  assert.equal(recoveredReserved.billable_seconds, 0);
  assert.equal(recoveredReserved.release_reason, 'process_interrupted_before_start');
  assert.equal(recoveredReserved.result.assessment.reason, 'process_interrupted_before_start');
  assert.equal(recoveredReserved.result.billing.billableSeconds, 0);

  const staleStarted = reservationInput({
    reservedSeconds: 80,
    now: new Date('2026-08-06T11:30:00.000Z'),
  });
  await repository.reserveSpeakingAssessment(username, staleStarted);
  await repository.dispatchSpeakingAssessment(username, staleStarted.idempotencyKey, {
    now: new Date('2026-08-06T11:30:00.500Z'),
  });
  await repository.startSpeakingAssessment(username, staleStarted.idempotencyKey, {
    now: new Date('2026-08-06T11:30:01.000Z'),
  });
  const recoveredStarted = await repository.getSpeakingAssessmentReservation(
    username,
    staleStarted.idempotencyKey,
    { now: new Date(new Date('2026-08-06T11:30:01.000Z').getTime() + SPEAKING_ASSESSMENT_LEASE_MS + 1) },
  );
  assert.equal(recoveredStarted.reservation.status, 'finalized');
  assert.equal(recoveredStarted.reservation.billable_seconds, 80);
  assert.equal(recoveredStarted.reservation.result.assessment.reason, 'process_interrupted_after_start');
  assert.deepEqual(recoveredStarted.reservation.result.billing, {
    assessmentId: staleStarted.id,
    reservedSeconds: 80,
    billableSeconds: 80,
    conservative: true,
  });
  assert.equal(recoveredStarted.quota.usedSeconds, 122);
  assert.equal(recoveredStarted.quota.heldSeconds, 0);

  const staleDispatching = reservationInput({
    reservedSeconds: 75,
    now: new Date('2026-08-06T11:45:00.000Z'),
  });
  await repository.reserveSpeakingAssessment(username, staleDispatching);
  const dispatchStartedAt = new Date('2026-08-06T11:45:01.000Z');
  await repository.dispatchSpeakingAssessment(username, staleDispatching.idempotencyKey, {
    now: dispatchStartedAt,
  });
  const recoveredDispatching = await repository.getSpeakingAssessmentReservation(
    username,
    staleDispatching.idempotencyKey,
    { now: new Date(dispatchStartedAt.getTime() + SPEAKING_ASSESSMENT_LEASE_MS + 1) },
  );
  assert.equal(recoveredDispatching.reservation.status, 'finalized');
  assert.equal(recoveredDispatching.reservation.billable_seconds, 75);
  assert.equal(recoveredDispatching.reservation.provider_started_at, null);
  assert.equal(
    recoveredDispatching.reservation.result.assessment.reason,
    'process_interrupted_during_dispatch',
  );
  assert.equal(recoveredDispatching.reservation.result.billing.conservative, true);

  const staleBeforeNextReserve = reservationInput({
    reservedSeconds: 90,
    now: new Date('2026-08-06T12:00:00.000Z'),
  });
  await repository.reserveSpeakingAssessment(username, staleBeforeNextReserve);
  const trigger = reservationInput({
    reservedSeconds: 1,
    now: new Date(staleBeforeNextReserve.now.getTime() + SPEAKING_ASSESSMENT_LEASE_MS + 1),
  });
  await repository.reserveSpeakingAssessment(username, trigger);
  const exportedAfterReserveRecovery = await repository.exportUserData(username);
  assert.equal(exportedAfterReserveRecovery.speaking_assessments
    .find((entry) => entry.id === staleBeforeNextReserve.id).status, 'released');
  await repository.releaseSpeakingAssessment(username, trigger.idempotencyKey, {
    reason: 'provider_unavailable_before_start',
    result: {
      assessment: { status: 'unavailable', reason: 'provider_error', retryable: true },
      billing: {
        assessmentId: trigger.id, reservedSeconds: 1, billableSeconds: 0, conservative: false,
      },
    },
    now: trigger.now,
  });

  for (let index = 0; index < 17; index += 1) {
    await repository.reserveSpeakingAssessment(username, reservationInput({ reservedSeconds: 180 }));
  }
  const race = await Promise.allSettled([
    repository.reserveSpeakingAssessment(username, reservationInput({ reservedSeconds: 180 })),
    repository.reserveSpeakingAssessment(username, reservationInput({ reservedSeconds: 180 })),
  ]);
  assert.equal(race.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(race.filter((item) => item.status === 'rejected'
    && item.reason?.code === 'SPEAKING_ASSESSMENT_QUOTA_EXHAUSTED').length, 1);

  const exported = await repository.exportUserData(username);
  assert.ok(Array.isArray(exported.speaking_assessments));
  assert.equal(exported.speaking_assessments.some((entry) => entry.id === first.id), true);
  assert.equal(exported.speaking_assessments.find((entry) => entry.id === first.id).context_id, first.contextId);
  assert.equal(JSON.stringify(exported.speaking_assessments).includes(first.idempotencyKey), false);
  assert.equal(JSON.stringify(exported.speaking_assessments).includes(first.requestHash), false);

  const premiumUsername = await repository.createTelegramUser(
    Number(`7${String(Date.now()).slice(-9)}`), `Speaking quota premium ${Date.now()}`,
  );
  await repository.grantDays(Number((await repository.getUser(premiumUsername)).telegram_id), 30, premiumUsername);
  await repository.setEntitlement(premiumUsername, 'voice_tutor', {
    startsAt: new Date('2026-08-01T00:00:00.000Z'),
    endsAt: new Date('2026-09-01T00:00:00.000Z'),
  });
  const premiumQuota = await repository.getSpeakingAssessmentQuota(premiumUsername, {
    now: new Date('2026-08-06T10:00:00.000Z'),
  });
  assert.equal(premiumQuota.tier, 'premium');
  assert.equal(premiumQuota.limitSeconds, PREMIUM_LIMIT_SECONDS);
  await repository.deleteUserData(premiumUsername);

  return { first };
}
