import crypto from 'node:crypto';
import { speakingCalibrationSampleMaterial } from './speaking-calibration-fixture.js';

export async function assertSpeakingAccentCalibrationRepositoryContract(
  assert, repository, { owner, expertA, expertB, recreateExpertA },
) {
  const startedAt = new Date('2026-08-06T10:00:00.000Z');
  const setup = await repository.startSpeakingAccentCalibration(owner, { now: startedAt });
  const pendingExport = await repository.exportUserData(owner);
  assert.deepEqual(pendingExport.speaking_accent_calibration, {
    id: setup.id,
    status: 'pending',
    started_at: startedAt.toISOString(),
    completed_at: null,
    locale: null,
    confidence: null,
    policy_version: null,
  });
  assert.equal(Object.hasOwn(pendingExport.speaking_accent_calibration, 'evidence_keys'), false);
  await assert.rejects(
    repository.startSpeakingAccentCalibration(owner, { now: startedAt }),
    (error) => error?.code === 'SPEAKING_ACCENT_CALIBRATION_ALREADY_USED',
  );
  const completedProfile = await repository.completeSpeakingAccentCalibration(owner, {
    setupId: setup.id, locale: 'en-US', suggestionConfidence: 'clear',
    evidenceKeys: [crypto.randomUUID(), crypto.randomUUID()],
    policyVersion: 'speaking-accent-suggestion-v1', now: startedAt,
  });
  assert.equal(completedProfile.profile.locale, 'en-US');
  assert.equal(completedProfile.profile.revision, 1);
  const changed = await repository.setSpeakingAccentProfile(owner, {
    locale: 'en-GB', source: 'manual', now: new Date('2026-08-06T11:00:00.000Z'),
  });
  assert.equal(changed.profile.revision, 2);
  assert.equal((await repository.getSpeakingAccentHistory(owner)).length, 2);

  await repository.setSpeakingCalibrationConsent(owner, {
    granted: true, ageGroup: 'adult', guardianConfirmed: false,
    policyVersion: 'speaking-calibration-consent-v1', now: startedAt,
  });
  const sample = await repository.createSpeakingCalibrationSample(owner, {
    id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 4,
    taskRef: `task4:${crypto.randomUUID()}:photo-v1-001@1`,
    ...speakingCalibrationSampleMaterial(4, `task4:${crypto.randomUUID()}:photo-v1-001@1`),
    locale: 'en-GB', maximumScore: 10,
    audio: Buffer.from('repository-parity-private-audio'), now: startedAt,
  });
  const first = await repository.claimSpeakingCalibrationSample(expertA, { now: startedAt });
  assert.equal(first.sampleId, sample.id);
  assert.equal((await repository.claimSpeakingCalibrationSample(expertA, { now: startedAt })).sampleId,
    sample.id, 'the active reviewer can resume the same blinded card');
  assert.equal(await repository.claimSpeakingCalibrationSample(expertB, { now: startedAt }), null,
    'one review round must not expose raw audio to parallel reviewers');
  assert.equal(JSON.stringify(first).includes(owner), false);
  assert.deepEqual(await repository.getSpeakingCalibrationAudio(sample.id, expertA, { now: startedAt }),
    Buffer.from('repository-parity-private-audio'));
  await repository.submitSpeakingCalibrationReview(expertA, sample.id, {
    sufficient: true, score: 8, criticalError: false, now: new Date('2026-08-06T10:05:00.000Z'),
  });
  const second = await repository.claimSpeakingCalibrationSample(expertB, {
    now: new Date('2026-08-06T10:06:00.000Z'),
  });
  assert.equal(second.sampleId, sample.id);
  const reviewed = await repository.submitSpeakingCalibrationReview(expertB, sample.id, {
    sufficient: true, score: 8, criticalError: false, now: new Date('2026-08-06T10:10:00.000Z'),
  });
  assert.deepEqual(reviewed, {
    sampleId: sample.id, status: 'completed', audio_retained: false, reviewCount: 2,
  });
  assert.equal(await repository.getSpeakingCalibrationAudio(sample.id, expertB), null);

  const exported = await repository.exportUserData(owner);
  assert.equal(exported.speaking_accent_profile.locale, 'en-GB');
  assert.equal(exported.speaking_accent_history.length, 2);
  assert.deepEqual(exported.speaking_accent_calibration, {
    id: setup.id,
    status: 'completed',
    started_at: startedAt.toISOString(),
    completed_at: startedAt.toISOString(),
    locale: 'en-US',
    confidence: 'clear',
    policy_version: 'speaking-accent-suggestion-v1',
  });
  assert.equal(Object.hasOwn(exported.speaking_accent_calibration, 'evidence_keys'), false);
  assert.equal(exported.speaking_calibration_consent.granted, true);
  assert.equal(exported.speaking_calibration_samples.length, 1);
  assert.equal(exported.speaking_calibration_samples[0].audio_retained, false);
  assert.equal(Object.hasOwn(exported.speaking_calibration_samples[0], 'reviews'), false);

  const leaseStartedAt = new Date('2026-08-06T11:00:00.000Z');
  const leased = await repository.createSpeakingCalibrationSample(owner, {
    id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 1,
    taskRef: `task1:${crypto.randomUUID()}:speaking-pilot-v1.task1.community-garden@1`,
    ...speakingCalibrationSampleMaterial(
      1, `task1:${crypto.randomUUID()}:speaking-pilot-v1.task1.community-garden@1`,
    ),
    locale: 'en-GB', maximumScore: 1, audio: Buffer.from('lease-private-audio'), now: leaseStartedAt,
  });
  await repository.claimSpeakingCalibrationSample(expertA, { now: leaseStartedAt });
  const expiredAt = new Date('2026-08-06T11:15:00.001Z');
  assert.equal(await repository.getSpeakingCalibrationAudio(leased.id, expertA, { now: expiredAt }), null);
  await assert.rejects(
    repository.submitSpeakingCalibrationReview(expertA, leased.id, {
      sufficient: true, score: 1, criticalError: false, now: expiredAt,
    }),
    (error) => error?.code === 'SPEAKING_CALIBRATION_REVIEW_CLAIM_REQUIRED',
  );
  assert.equal((await repository.claimSpeakingCalibrationSample(expertB, { now: expiredAt })).sampleId,
    leased.id, 'an expired lease is available for takeover');
  await repository.submitSpeakingCalibrationReview(expertB, leased.id, {
    sufficient: true, score: 1, criticalError: false, now: new Date('2026-08-06T11:16:00.000Z'),
  });
  await repository.claimSpeakingCalibrationSample(expertA, {
    now: new Date('2026-08-06T11:17:00.000Z'),
  });
  await repository.submitSpeakingCalibrationReview(expertA, leased.id, {
    sufficient: true, score: 1, criticalError: false, now: new Date('2026-08-06T11:18:00.000Z'),
  });

  const expiryStartedAt = new Date('2026-08-07T10:00:00.000Z');
  const expiryTaskRef = `task1:${crypto.randomUUID()}:speaking-pilot-v1.task1.community-garden@1`;
  const expirySample = await repository.createSpeakingCalibrationSample(owner, {
    id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 1,
    taskRef: expiryTaskRef, ...speakingCalibrationSampleMaterial(1, expiryTaskRef),
    locale: 'en-GB', maximumScore: 1, audio: Buffer.from('expiry-private-audio'), now: expiryStartedAt,
  });
  const expiryBoundary = new Date(expiryStartedAt.getTime() + 180 * 86_400_000);
  await repository.claimSpeakingCalibrationSample(expertA, {
    now: new Date(expiryBoundary.getTime() - 1_000),
  });
  assert.equal(await repository.getSpeakingCalibrationAudio(expirySample.id, expertA, {
    now: new Date(expiryBoundary.getTime() + 1_000),
  }), null, 'the 180-day boundary overrides a still-active reviewer lease');
  await assert.rejects(repository.submitSpeakingCalibrationReview(expertA, expirySample.id, {
    sufficient: true, score: 1, criticalError: false,
    now: new Date(expiryBoundary.getTime() + 1_000),
  }), (error) => error?.code === 'SPEAKING_CALIBRATION_SAMPLE_NOT_AVAILABLE');
  const expiredSample = (await repository.listSpeakingCalibrationSamplesForOwner(owner))
    .find((entry) => entry.id === expirySample.id);
  assert.equal(expiredSample.status, 'expired');
  assert.equal(expiredSample.audio_retained, false);

  const identitySample = await repository.createSpeakingCalibrationSample(owner, {
    id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 1,
    taskRef: `task1:${crypto.randomUUID()}:speaking-pilot-v1.task1.community-garden@1`,
    ...speakingCalibrationSampleMaterial(
      1, `task1:${crypto.randomUUID()}:speaking-pilot-v1.task1.community-garden@1`,
    ),
    locale: 'en-GB', maximumScore: 1, audio: Buffer.from('identity-private-audio'),
    now: new Date('2026-08-06T12:00:00.000Z'),
  });
  await repository.claimSpeakingCalibrationSample(expertA, {
    now: new Date('2026-08-06T12:00:00.000Z'),
  });
  assert.equal(await repository.deleteUserData(expertA), true);
  const recreated = await recreateExpertA();
  assert.equal(recreated, expertA, 'the replacement account must reproduce the deleted username');
  assert.equal(await repository.getSpeakingCalibrationAudio(identitySample.id, recreated, {
    now: new Date('2026-08-06T12:01:00.000Z'),
  }), null, 'a recreated username must not inherit the deleted expert lease');
  const anonymous = await repository.listAnonymousSpeakingCalibrationLabels();
  assert.equal(anonymous.find((entry) => entry.sampleId === sample.id).ratings
    .some((rating) => rating.reviewer_account_deleted === true), true,
  'completed labels retain only a reviewer-deletion marker');
  return { sampleId: sample.id };
}
