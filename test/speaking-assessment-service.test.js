import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSpeakingAssessmentService } from '../speaking/assessment-service.js';
import { SPEAKING_ASSESSMENT_LEASE_MS } from '../speaking/assessment-quota.js';
import { createFakePronunciationProvider, SpeakingPronunciationError } from '../speaking/pronunciation-provider.js';
import { createFileRepository } from '../storage/file-repository.js';
import { testPcmWavAudio } from './support/wav-audio.js';

async function withService(provider, run, { wrapDb = (repository) => repository } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-service-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const username = await repository.createTelegramUser(9_610_001, 'Speaking service owner');
  let now = new Date('2026-08-06T12:00:00.000Z');
  const service = createSpeakingAssessmentService({
    db: wrapDb(repository),
    provider,
    now: () => now,
  });
  try {
    await run({ service, repository, username, advance(seconds) {
      now = new Date(now.getTime() + seconds * 1_000);
    } });
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const assessmentInput = (idempotencyKey, overrides = {}) => {
  const durationSeconds = Number(overrides.durationSeconds ?? 3);
  return {
    idempotencyKey,
    audio: testPcmWavAudio({ durationSeconds }),
    mimeType: 'audio/wav',
    durationSeconds,
    locale: 'en-US',
    mode: 'scripted',
    referenceText: 'A short trusted transcript.',
    ...overrides,
  };
};

test('service reserves before provider start, bills capped observed seconds once and replays canonical result', async () => {
  await withService(createFakePronunciationProvider({ scenario: 'success' }), async ({ service, repository, username }) => {
    const key = '10000000-0000-4000-8000-000000000061';
    const first = await service.assess(username, assessmentInput(key));
    assert.equal(first.assessment.status, 'success');
    assert.equal(first.assessment.transcript, 'A short trusted transcript.');
    assert.equal(first.billing.billableSeconds, 3);
    assert.equal(first.billing.reservedSeconds, 3);
    assert.equal(first.quota.usedSeconds, 3);
    assert.equal(first.quota.heldSeconds, 0);
    const replay = await service.assess(username, assessmentInput(key));
    assert.deepEqual(replay, first);
    const exported = await repository.exportUserData(username);
    assert.equal(exported.speaking_assessments.length, 1);
    assert.equal(JSON.stringify(exported).includes('RIFF-service-audio'), false);
  });
});

test('service releases an unused reservation when provider fails before processing starts', async () => {
  const provider = {
    async status() { return { available: true, provider: 'test', reason: null }; },
    async assess() { throw new SpeakingPronunciationError('SPEAKING_PRONUNCIATION_PROVIDER_ERROR'); },
  };
  await withService(provider, async ({ service, repository, username }) => {
    const result = await service.assess(username, assessmentInput('10000000-0000-4000-8000-000000000062'));
    assert.deepEqual(result.assessment, {
      status: 'unavailable', available: false, reason: 'provider_error', retryable: true,
    });
    assert.equal(result.billing.billableSeconds, 0);
    assert.equal(result.quota.usedSeconds, 0);
    assert.equal(result.quota.heldSeconds, 0);
    const exported = await repository.exportUserData(username);
    assert.equal(exported.speaking_assessments[0].status, 'released');
  });
});

test('pre-start timeout releases quota and exact retry returns the same canonical outcome', async () => {
  const provider = {
    async status() { return { available: true, provider: 'test', reason: null }; },
    async assess() { throw new SpeakingPronunciationError('SPEAKING_PRONUNCIATION_TIMEOUT'); },
  };
  await withService(provider, async ({ service, repository, username }) => {
    const input = assessmentInput('10000000-0000-4000-8000-000000000059');
    const first = await service.assess(username, input);
    assert.deepEqual(first.assessment, {
      status: 'timeout', available: false, reason: 'provider_timeout', retryable: true,
    });
    assert.equal(first.billing.billableSeconds, 0);
    assert.deepEqual(await service.assess(username, input), first);
    assert.equal((await repository.exportUserData(username)).speaking_assessments.length, 1);
  });
});

test('successful provider start with no measurable segment conservatively bills the reservation', async () => {
  const provider = {
    async status() { return { available: true, provider: 'test', reason: null }; },
    async assess(_input, { onProcessingStarted }) {
      await onProcessingStarted();
      return { status: 'low_quality', processedDurationSeconds: 0, transcript: '', words: [] };
    },
  };
  await withService(provider, async ({ service, username }) => {
    const result = await service.assess(username, assessmentInput(
      '10000000-0000-4000-8000-000000000065', { durationSeconds: 9 },
    ));
    assert.equal(result.billing.billableSeconds, 9);
    assert.equal(result.billing.conservative, true);
  });
});

test('idempotency fingerprint binds the server-owned session context', async () => {
  await withService(createFakePronunciationProvider({ scenario: 'success' }), async ({ service, username }) => {
    const key = '10000000-0000-4000-8000-000000000066';
    await service.assess(username, assessmentInput(key, { contextId: 'task1:session-a' }));
    await assert.rejects(
      service.assess(username, assessmentInput(key, { contextId: 'task1:session-b' })),
      (error) => error?.code === 'SPEAKING_ASSESSMENT_IDEMPOTENCY_CONFLICT',
    );
  });
});

test('service derives reservation and billing duration from WAV bytes instead of a forged caller claim', async () => {
  await withService(createFakePronunciationProvider({ scenario: 'success' }), async ({ service, username }) => {
    const result = await service.assess(username, assessmentInput(
      '10000000-0000-4000-8000-000000000069', { durationSeconds: 1, audio: testPcmWavAudio({ durationSeconds: 3 }) },
    ));
    assert.equal(result.billing.reservedSeconds, 3);
    assert.equal(result.billing.billableSeconds, 3);
    assert.equal(result.quota.usedSeconds, 3);
  });
});

test('service rejects sub-second WAV before provider lookup or quota reservation', async () => {
  const providerCalls = { status: 0, assess: 0 };
  const provider = {
    async status() { providerCalls.status += 1; return { available: true, provider: 'test', reason: null }; },
    async assess() { providerCalls.assess += 1; throw new Error('provider must not be reached'); },
  };
  await withService(provider, async ({ service, repository, username }) => {
    await assert.rejects(
      service.assess(username, assessmentInput('10000000-0000-4000-8000-000000000060', {
        durationSeconds: 1,
        audio: testPcmWavAudio({ durationSeconds: 0.5 }),
      })),
      (error) => error?.code === 'SPEAKING_AUDIO_DURATION_INVALID',
    );
    assert.deepEqual(providerCalls, { status: 0, assess: 0 });
    assert.equal((await repository.exportUserData(username)).speaking_assessments.length, 0);
  });
});

test('timeout after provider start conservatively bills the full reservation and exact retry does not bill again', async () => {
  await withService(createFakePronunciationProvider({ scenario: 'timeout' }), async ({ service, repository, username }) => {
    const key = '10000000-0000-4000-8000-000000000063';
    const first = await service.assess(username, assessmentInput(key, { durationSeconds: 17 }));
    assert.deepEqual(first.assessment, {
      status: 'timeout', available: false, reason: 'provider_timeout', retryable: true,
    });
    assert.equal(first.billing.reservedSeconds, 17);
    assert.equal(first.billing.billableSeconds, 17);
    assert.equal(first.billing.conservative, true);
    const replay = await service.assess(username, assessmentInput(key, { durationSeconds: 17 }));
    assert.deepEqual(replay, first);
    assert.equal((await repository.getSpeakingAssessmentQuota(username, {
      now: new Date('2026-08-06T12:00:10.000Z'),
    })).usedSeconds, 17);
  });
});

test('service returns bounded processing state when an attempted durable start claim never settles', async () => {
  const provider = {
    async status() { return { available: true, provider: 'test', reason: null }; },
    async assess(_input, { onProcessingStarted }) {
      void onProcessingStarted();
      await new Promise((resolve) => setImmediate(resolve));
      throw new SpeakingPronunciationError('SPEAKING_PRONUNCIATION_TIMEOUT', { processingStarted: true });
    },
  };
  await withService(provider, async ({ service, repository, username, advance }) => {
    const idempotencyKey = '10000000-0000-4000-8000-000000000070';
    let timeout;
    const outcome = await Promise.race([
      service.assess(username, assessmentInput(idempotencyKey)),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve('service_hung'), 1_000);
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.notEqual(outcome, 'service_hung');
    assert.deepEqual(outcome.assessment, {
      status: 'processing', available: false, reason: 'assessment_in_progress', retryable: true,
    });
    assert.equal(outcome.billing.reservedSeconds, 3);
    assert.equal(outcome.billing.billableSeconds, 0);
    assert.equal(outcome.quota.heldSeconds, 3);
    advance((SPEAKING_ASSESSMENT_LEASE_MS / 1_000) + 1);
    const recovered = await repository.getSpeakingAssessmentReservation(username, idempotencyKey, {
      now: new Date('2026-08-06T12:05:01.000Z'),
    });
    assert.equal(recovered.reservation.status, 'finalized');
    assert.equal(recovered.reservation.billable_seconds, 3);
    assert.equal(recovered.reservation.provider_started_at, null);
    assert.equal(recovered.reservation.result.assessment.reason, 'process_interrupted_during_dispatch');
    assert.equal(recovered.reservation.result.billing.conservative, true);
  }, {
    wrapDb: (repository) => ({
      ...repository,
      startSpeakingAssessment: async () => new Promise(() => {}),
    }),
  });
});

test('unconfigured provider status is honest and local recording consumes zero quota', async () => {
  await withService(createFakePronunciationProvider({ scenario: 'unavailable' }), async ({ service, repository, username }) => {
    const status = await service.status(username);
    assert.deepEqual(status.provider, {
      available: false, reason: 'provider_unavailable', provider: 'fake-azure',
    });
    assert.equal(status.quota.limitSeconds, 3_600);
    assert.equal(status.quota.remainingSeconds, 3_600);
    const result = await service.assess(username, assessmentInput('10000000-0000-4000-8000-000000000064'));
    assert.deepEqual(result.assessment, {
      status: 'unavailable', available: false, reason: 'provider_unavailable', retryable: true,
    });
    assert.equal((await repository.exportUserData(username)).speaking_assessments.length, 0);
  });
});

test('finalized exact replay survives a later provider outage without creating a new ledger row', async () => {
  let available = true;
  const fake = createFakePronunciationProvider({ scenario: 'success' });
  const provider = {
    async status() {
      return available
        ? { available: true, provider: 'test', reason: null }
        : { available: false, provider: 'test', reason: 'provider_unavailable' };
    },
    assess: (...args) => fake.assess(...args),
  };
  await withService(provider, async ({ service, repository, username }) => {
    const key = '10000000-0000-4000-8000-000000000067';
    const input = assessmentInput(key, { contextId: 'task1:stable-session' });
    const first = await service.assess(username, input);
    available = false;
    assert.deepEqual(await service.assess(username, input), first);
    const fresh = await service.assess(username, assessmentInput(
      '10000000-0000-4000-8000-000000000068', { contextId: 'task1:new-session' },
    ));
    assert.equal(fresh.assessment.reason, 'provider_unavailable');
    assert.equal((await repository.exportUserData(username)).speaking_assessments.length, 1);
  });
});
