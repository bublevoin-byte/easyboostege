import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFileRepository } from '../storage/file-repository.js';
import { SPEAKING_ASSESSMENT_LEASE_MS } from '../speaking/assessment-quota.js';
import { assertSpeakingAssessmentQuotaContract } from './support/speaking-assessment-quota-contract.js';

test('file Speaking assessment quota is atomic, idempotent, exportable and deletable', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-quota-'));
  const file = path.join(directory, 'data.json');
  const repository = createFileRepository(file);
  try {
    const username = await repository.createTelegramUser(9_600_001, 'Speaking quota owner');
    await assertSpeakingAssessmentQuotaContract(assert, repository, username);
    assert.equal(await repository.deleteUserData(username), true);
    assert.equal(await repository.exportUserData(username), null);
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(stored.speaking_assessments.some((entry) => entry.username === username), false);
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('file ledger reconciles interrupted reservations after repository restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-quota-restart-'));
  const file = path.join(directory, 'data.json');
  let repository = createFileRepository(file);
  try {
    const username = await repository.createTelegramUser(9_600_002, 'Speaking quota restart owner');
    const beforeStart = {
      id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), requestHash: 'a'.repeat(64),
      reservedSeconds: 60, locale: 'en-US', now: new Date('2026-08-06T10:00:00.000Z'),
    };
    const afterStart = {
      id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), requestHash: 'b'.repeat(64),
      reservedSeconds: 70, locale: 'en-US', now: new Date('2026-08-06T10:00:00.000Z'),
    };
    const duringDispatch = {
      id: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), requestHash: 'c'.repeat(64),
      reservedSeconds: 80, locale: 'en-US', now: new Date('2026-08-06T10:00:00.000Z'),
    };
    await repository.reserveSpeakingAssessment(username, beforeStart);
    await repository.reserveSpeakingAssessment(username, afterStart);
    await repository.reserveSpeakingAssessment(username, duringDispatch);
    await repository.dispatchSpeakingAssessment(username, afterStart.idempotencyKey, {
      now: new Date('2026-08-06T10:00:00.500Z'),
    });
    const providerStartedAt = new Date('2026-08-06T10:00:01.000Z');
    await repository.startSpeakingAssessment(username, afterStart.idempotencyKey, { now: providerStartedAt });
    const dispatchStartedAt = new Date('2026-08-06T10:00:01.000Z');
    await repository.dispatchSpeakingAssessment(username, duringDispatch.idempotencyKey, {
      now: dispatchStartedAt,
    });
    await repository.close();

    repository = createFileRepository(file);
    const recoveredAt = new Date(providerStartedAt.getTime() + SPEAKING_ASSESSMENT_LEASE_MS + 1);
    const quota = await repository.getSpeakingAssessmentQuota(username, { now: recoveredAt });
    assert.equal(quota.usedSeconds, 150);
    assert.equal(quota.heldSeconds, 0);
    const released = await repository.getSpeakingAssessmentReservation(
      username, beforeStart.idempotencyKey, { now: recoveredAt },
    );
    const finalized = await repository.getSpeakingAssessmentReservation(
      username, afterStart.idempotencyKey, { now: recoveredAt },
    );
    const dispatchRecovered = await repository.getSpeakingAssessmentReservation(
      username, duringDispatch.idempotencyKey, { now: recoveredAt },
    );
    assert.equal(released.reservation.status, 'released');
    assert.equal(released.reservation.result.assessment.reason, 'process_interrupted_before_start');
    assert.equal(finalized.reservation.status, 'finalized');
    assert.equal(finalized.reservation.result.assessment.reason, 'process_interrupted_after_start');
    assert.equal(finalized.reservation.billable_seconds, 70);
    assert.equal(dispatchRecovered.reservation.status, 'finalized');
    assert.equal(dispatchRecovered.reservation.provider_started_at, null);
    assert.equal(dispatchRecovered.reservation.billable_seconds, 80);
    assert.equal(
      dispatchRecovered.reservation.result.assessment.reason,
      'process_interrupted_during_dispatch',
    );
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
