import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  materialSpeakingCalibrationDisagreement,
  selectSpeakingAccentSuggestion,
} from '../speaking/accent-calibration.js';
import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';
import { createFileRepository } from '../storage/file-repository.js';
import { speakingCalibrationSampleMaterial } from './support/speaking-calibration-fixture.js';

const SPEAKING_CATALOGS = [
  SPEAKING_TASK1_CATALOG, SPEAKING_TASK2_CATALOG,
  SPEAKING_TASK3_CATALOG, SPEAKING_TASK4_CATALOG,
];

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const startedAt = new Date('2026-08-06T10:00:00.000Z');

async function withRepository(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-accent-'));
  const dataPath = path.join(directory, 'data.json');
  const repository = createFileRepository(dataPath);
  const owner = await repository.createTelegramUser(9_680_001, 'Accent owner');
  const other = await repository.createTelegramUser(9_680_002, 'Accent other');
  const expertA = await repository.createTelegramUser(9_680_003, 'Expert A');
  const expertB = await repository.createTelegramUser(9_680_004, 'Expert B');
  const expertC = await repository.createTelegramUser(9_680_005, 'Expert C');
  try {
    await run({ repository, dataPath, owner, other, expertA, expertB, expertC });
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function assessment(locale, overallScore, overrides = {}) {
  return {
    status: 'success', isFinal: true, locale, overallScore,
    confidence: 94, quality: { acceptable: true, warnings: [] },
    ...overrides,
  };
}

test('one dual-accent comparison yields one bounded suggestion and rejects weak evidence', () => {
  assert.deepEqual(selectSpeakingAccentSuggestion({
    enGB: assessment('en-GB', 78),
    enUS: assessment('en-US', 91),
  }), {
    locale: 'en-US', confidence: 'clear', scoreGap: 13,
    policyVersion: 'speaking-accent-suggestion-v1',
  });
  assert.deepEqual(selectSpeakingAccentSuggestion({
    enGB: assessment('en-GB', 86),
    enUS: assessment('en-US', 84),
  }), {
    locale: 'en-GB', confidence: 'close', scoreGap: 2,
    policyVersion: 'speaking-accent-suggestion-v1',
  });
  assert.throws(() => selectSpeakingAccentSuggestion({
    enGB: assessment('en-GB', 90, { isFinal: false }),
    enUS: assessment('en-US', 80),
  }), (error) => error?.code === 'SPEAKING_ACCENT_CALIBRATION_EVIDENCE_INVALID');
});

test('task-aware disagreement requires adjudication without allowing the same expert twice', () => {
  assert.equal(materialSpeakingCalibrationDisagreement(1,
    { score: 1, criticalError: false }, { score: 0, criticalError: false }), true);
  assert.equal(materialSpeakingCalibrationDisagreement(4,
    { score: 8, criticalError: false }, { score: 7, criticalError: false }), false);
  assert.equal(materialSpeakingCalibrationDisagreement(4,
    { score: 8, criticalError: false }, { score: 6, criticalError: false }), true);
  assert.equal(materialSpeakingCalibrationDisagreement(1,
    { score: 1, criticalError: false }, { score: 1, criticalError: true }), true);
});

test('accent profile has one-time unknown setup, append-only audit and future-effective revisions', async () => {
  await withRepository(async ({ repository, owner }) => {
    assert.equal(await repository.getSpeakingAccentProfile(owner), null);
    const started = await repository.startSpeakingAccentCalibration(owner, { now: startedAt });
    assert.equal(started.status, 'pending');
    assert.equal(started.started_at, startedAt.toISOString());
    await assert.rejects(
      repository.startSpeakingAccentCalibration(owner, { now: new Date(startedAt.getTime() + HOUR) }),
      (error) => error?.code === 'SPEAKING_ACCENT_CALIBRATION_ALREADY_USED',
    );

    const calibrated = await repository.completeSpeakingAccentCalibration(owner, {
      setupId: started.id,
      locale: 'en-US',
      suggestionConfidence: 'clear',
      evidenceKeys: [crypto.randomUUID(), crypto.randomUUID()],
      policyVersion: 'speaking-accent-suggestion-v1',
      now: new Date(startedAt.getTime() + HOUR),
    });
    assert.deepEqual(calibrated.profile, {
      locale: 'en-US', revision: 1, source: 'calibration',
      effective_at: '2026-08-06T11:00:00.000Z', calibration_used: true,
    });

    const changed = await repository.setSpeakingAccentProfile(owner, {
      locale: 'en-GB', source: 'manual', now: new Date(startedAt.getTime() + 2 * HOUR),
    });
    assert.equal(changed.changed, true);
    assert.equal(changed.profile.locale, 'en-GB');
    assert.equal(changed.profile.revision, 2);
    const replay = await repository.setSpeakingAccentProfile(owner, {
      locale: 'en-GB', source: 'manual', now: new Date(startedAt.getTime() + 3 * HOUR),
    });
    assert.equal(replay.changed, false);
    assert.equal(replay.profile.revision, 2);
    assert.deepEqual((await repository.getSpeakingAccentHistory(owner)).map((entry) => ({
      locale: entry.locale, revision: entry.revision, source: entry.source, effective_at: entry.effective_at,
    })), [
      { locale: 'en-US', revision: 1, source: 'calibration', effective_at: '2026-08-06T11:00:00.000Z' },
      { locale: 'en-GB', revision: 2, source: 'manual', effective_at: '2026-08-06T12:00:00.000Z' },
    ]);

    const oldSession = await repository.assignSpeakingTask1Session(owner, {
      catalogId: 'catalog', catalogRevision: 1,
      tasks: [{ id: 'task-1', revision: 1 }],
      accentProfile: calibrated.profile,
      now: new Date(startedAt.getTime() + 90 * 60_000),
    });
    const newSession = await repository.assignSpeakingTask1Session(owner, {
      catalogId: 'catalog', catalogRevision: 1,
      tasks: [{ id: 'task-2', revision: 1 }],
      accentProfile: changed.profile,
      now: new Date(startedAt.getTime() + 3 * HOUR),
    });
    assert.deepEqual([oldSession.accent_locale, oldSession.accent_profile_revision], ['en-GB', 2],
      'a stale caller snapshot must not override the canonical profile at assignment time');
    assert.deepEqual([newSession.accent_locale, newSession.accent_profile_revision], ['en-GB', 2]);
    const fullSession = await repository.assignFullSpeakingSession(owner, {
      catalogs: SPEAKING_CATALOGS,
      accentProfile: calibrated.profile,
      now: new Date(startedAt.getTime() + 4 * HOUR),
    });
    assert.deepEqual([fullSession.accent_locale, fullSession.accent_profile_revision], ['en-GB', 2],
      'a full session must snapshot the canonical profile, not a stale route value');
  });
});

test('manual selection and accent calibration are mutually exclusive', async () => {
  await withRepository(async ({ repository, owner, other }) => {
    await repository.setSpeakingAccentProfile(owner, {
      locale: 'en-GB', source: 'manual', now: startedAt,
    });
    await assert.rejects(
      repository.startSpeakingAccentCalibration(owner, { now: startedAt }),
      (error) => error?.code === 'SPEAKING_ACCENT_CALIBRATION_ALREADY_USED',
    );

    const setup = await repository.startSpeakingAccentCalibration(other, { now: startedAt });
    await repository.setSpeakingAccentProfile(other, {
      locale: 'en-US', source: 'manual', now: new Date(startedAt.getTime() + MINUTE),
    });
    const cancelled = await repository.getSpeakingAccentCalibration(other, setup.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(new Date(cancelled.completed_at).toISOString(), '2026-08-06T10:01:00.000Z');
    assert.equal(cancelled.locale, null);
    assert.equal(cancelled.confidence, null);
    assert.equal(cancelled.evidence_keys, null);
    assert.equal(cancelled.policy_version, null);
    assert.equal(await repository.getPendingSpeakingAccentCalibration(other), null);
    await assert.rejects(repository.completeSpeakingAccentCalibration(other, {
      setupId: setup.id,
      locale: 'en-GB',
      suggestionConfidence: 'clear',
      evidenceKeys: [crypto.randomUUID(), crypto.randomUUID()],
      policyVersion: 'speaking-accent-suggestion-v1',
      now: new Date(startedAt.getTime() + 2 * MINUTE),
    }), (error) => error?.code === 'SPEAKING_ACCENT_CALIBRATION_ALREADY_USED');
  });
});

test('serialized file assignments snapshot a profile update queued immediately before them', async () => {
  await withRepository(async ({ repository, owner }) => {
    const first = (await repository.setSpeakingAccentProfile(owner, {
      locale: 'en-GB', source: 'manual', now: startedAt,
    })).profile;
    const [second, ordinary] = await Promise.all([
      repository.setSpeakingAccentProfile(owner, {
        locale: 'en-US', source: 'manual', now: new Date(startedAt.getTime() + MINUTE),
      }),
      repository.assignSpeakingTask1Session(owner, {
        catalogId: 'file-concurrent-accent', catalogRevision: 1,
        tasks: [{ id: 'file-concurrent-task', revision: 1 }], accentProfile: first,
        now: new Date(startedAt.getTime() + MINUTE),
      }),
    ]);
    assert.deepEqual([ordinary.accent_locale, ordinary.accent_profile_revision], ['en-US', 2]);

    const [third, full] = await Promise.all([
      repository.setSpeakingAccentProfile(owner, {
        locale: 'en-GB', source: 'manual', now: new Date(startedAt.getTime() + 2 * MINUTE),
      }),
      repository.assignFullSpeakingSession(owner, {
        catalogs: SPEAKING_CATALOGS, accentProfile: second.profile,
        now: new Date(startedAt.getTime() + 2 * MINUTE),
      }),
    ]);
    assert.equal(third.profile.revision, 3);
    assert.deepEqual([full.accent_locale, full.accent_profile_revision], ['en-GB', 3]);
  });
});

test('calibration consent is separate, guardian-gated and revoke deletes retained binary', async () => {
  await withRepository(async ({ repository, dataPath, owner }) => {
    await assert.rejects(repository.setSpeakingCalibrationConsent(owner, {
      granted: true, ageGroup: 'minor', guardianConfirmed: false,
      policyVersion: 'speaking-calibration-consent-v1', now: startedAt,
    }), (error) => error?.code === 'SPEAKING_CALIBRATION_GUARDIAN_REQUIRED');

    const consent = await repository.setSpeakingCalibrationConsent(owner, {
      granted: true, ageGroup: 'minor', guardianConfirmed: true,
      policyVersion: 'speaking-calibration-consent-v1', now: startedAt,
    });
    assert.equal(consent.granted, true);
    assert.equal(consent.guardian_confirmed, true);
    const rawAudio = Buffer.from('private-calibration-audio-revoke');
    const sample = await repository.createSpeakingCalibrationSample(owner, {
      id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 1,
      taskRef: 'task1:session:read-001@1',
      ...speakingCalibrationSampleMaterial(1, 'task1:session:read-001@1'),
      locale: 'en-GB', maximumScore: 1,
      audio: rawAudio, now: new Date(startedAt.getTime() + HOUR),
    });
    assert.equal(sample.audio_retained, true);
    assert.equal((await fs.readFile(dataPath, 'utf8')).includes(rawAudio.toString('base64')), true);

    const revoked = await repository.setSpeakingCalibrationConsent(owner, {
      granted: false, ageGroup: 'minor', guardianConfirmed: true,
      policyVersion: 'speaking-calibration-consent-v1', now: new Date(startedAt.getTime() + 2 * HOUR),
    });
    assert.equal(revoked.granted, false);
    assert.equal(await repository.getSpeakingCalibrationAudio(sample.id, owner), null);
    assert.equal((await fs.readFile(dataPath, 'utf8')).includes(rawAudio.toString('base64')), false);
  });
});

test('blind queue hides owner identifiers, enforces independent reviews and erases raw audio', async () => {
  await withRepository(async ({ repository, dataPath, owner, expertA, expertB }) => {
    await repository.setSpeakingCalibrationConsent(owner, {
      granted: true, ageGroup: 'adult', guardianConfirmed: false,
      policyVersion: 'speaking-calibration-consent-v1', now: startedAt,
    });
    const rawAudio = Buffer.from('private-calibration-audio-two-ratings');
    const sample = await repository.createSpeakingCalibrationSample(owner, {
      id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 4,
      taskRef: 'task4:session:photo-001@1',
      ...speakingCalibrationSampleMaterial(4, 'task4:session:photo-001@1'),
      locale: 'en-US', maximumScore: 10,
      audio: rawAudio, now: startedAt,
    });

    const firstCard = await repository.claimSpeakingCalibrationSample(expertA, { now: startedAt });
    assert.equal(firstCard.sampleId, sample.id);
    assert.deepEqual(Object.keys(firstCard).sort(), [
      'accentLocale', 'expiresAt', 'maximumScore', 'reviewRound', 'rubric', 'sampleId',
      'task', 'taskRef', 'taskType',
    ]);
    assert.equal(firstCard.task.id, 'photo-001');
    assert.equal(firstCard.rubric.maximumScore, 10);
    assert.equal(JSON.stringify(firstCard).includes(owner), false);
    assert.equal(JSON.stringify(firstCard).includes('9680001'), false);
    assert.deepEqual(await repository.getSpeakingCalibrationAudio(sample.id, expertA, { now: startedAt }), rawAudio);
    await repository.submitSpeakingCalibrationReview(expertA, sample.id, {
      sufficient: true, score: 8, criticalError: false, now: new Date(startedAt.getTime() + 5 * MINUTE),
    });
    await assert.rejects(repository.submitSpeakingCalibrationReview(expertA, sample.id, {
      sufficient: true, score: 8, criticalError: false, now: new Date(startedAt.getTime() + 6 * MINUTE),
    }), (error) => error?.code === 'SPEAKING_CALIBRATION_REVIEWER_NOT_INDEPENDENT');

    const secondCard = await repository.claimSpeakingCalibrationSample(expertB, {
      now: new Date(startedAt.getTime() + 6 * MINUTE),
    });
    assert.equal(secondCard.reviewRound, 2);
    const completed = await repository.submitSpeakingCalibrationReview(expertB, sample.id, {
      sufficient: true, score: 7, criticalError: false, now: new Date(startedAt.getTime() + 10 * MINUTE),
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.audio_retained, false);
    assert.equal(await repository.getSpeakingCalibrationAudio(sample.id, expertB), null);
    assert.equal((await fs.readFile(dataPath, 'utf8')).includes(rawAudio.toString('base64')), false);

    const exported = await repository.exportUserData(owner);
    assert.equal(exported.speaking_calibration_samples[0].audio_retained, false);
    assert.equal(Object.hasOwn(exported.speaking_calibration_samples[0], 'audio'), false);
    assert.equal(Object.hasOwn(exported.speaking_calibration_samples[0], 'reviews'), false);
  });
});

test('material disagreement keeps audio only for an independent adjudicator, then deletes it', async () => {
  await withRepository(async ({ repository, owner, expertA, expertB, expertC }) => {
    await repository.setSpeakingCalibrationConsent(owner, {
      granted: true, ageGroup: 'adult', guardianConfirmed: false,
      policyVersion: 'speaking-calibration-consent-v1', now: startedAt,
    });
    const sample = await repository.createSpeakingCalibrationSample(owner, {
      id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 1,
      taskRef: 'task1:session:read-002@1',
      ...speakingCalibrationSampleMaterial(1, 'task1:session:read-002@1'),
      locale: 'en-GB', maximumScore: 1,
      audio: Buffer.from('private-calibration-audio-adjudication'), now: startedAt,
    });
    await repository.claimSpeakingCalibrationSample(expertA, { now: startedAt });
    await repository.submitSpeakingCalibrationReview(expertA, sample.id, {
      sufficient: true, score: 1, criticalError: false, now: new Date(startedAt.getTime() + 5 * MINUTE),
    });
    await repository.claimSpeakingCalibrationSample(expertB, { now: new Date(startedAt.getTime() + 6 * MINUTE) });
    const disagreement = await repository.submitSpeakingCalibrationReview(expertB, sample.id, {
      sufficient: true, score: 0, criticalError: true, now: new Date(startedAt.getTime() + 10 * MINUTE),
    });
    assert.equal(disagreement.status, 'adjudication_pending');
    assert.equal(disagreement.audio_retained, true);
    const adjudicationCard = await repository.claimSpeakingCalibrationSample(expertC, {
      now: new Date(startedAt.getTime() + 11 * MINUTE),
    });
    assert.equal(adjudicationCard.reviewRound, 3);
    const adjudicated = await repository.submitSpeakingCalibrationReview(expertC, sample.id, {
      sufficient: true, score: 1, criticalError: false, now: new Date(startedAt.getTime() + 14 * MINUTE),
    });
    assert.equal(adjudicated.status, 'completed');
    assert.equal(adjudicated.audio_retained, false);
  });
});

test('180-day retention and account deletion remove unfinished audio but preserve anonymous labels only', async () => {
  await withRepository(async ({ repository, owner, expertA, expertB }) => {
    await repository.setSpeakingCalibrationConsent(owner, {
      granted: true, ageGroup: 'adult', guardianConfirmed: false,
      policyVersion: 'speaking-calibration-consent-v1', now: startedAt,
    });
    const expired = await repository.createSpeakingCalibrationSample(owner, {
      id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 2,
      taskRef: 'task2:session:question-001@1',
      ...speakingCalibrationSampleMaterial(2, 'task2:session:question-001@1'),
      locale: 'en-US', maximumScore: 4,
      audio: Buffer.from('expired-private-audio'), now: startedAt,
    });
    const purged = await repository.purgeExpiredSpeakingCalibrationSamples({
      now: new Date(startedAt.getTime() + 180 * DAY + 1),
    });
    assert.equal(purged.deletedAudio, 1);
    assert.equal(await repository.getSpeakingCalibrationAudio(expired.id, expertA), null);

    const completed = await repository.createSpeakingCalibrationSample(owner, {
      id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 3,
      taskRef: 'task3:session:answer-001@1',
      ...speakingCalibrationSampleMaterial(3, 'task3:session:answer-001@1'),
      locale: 'en-GB', maximumScore: 5,
      audio: Buffer.from('completed-private-audio'), now: startedAt,
    });
    await repository.claimSpeakingCalibrationSample(expertA, { now: startedAt });
    await repository.submitSpeakingCalibrationReview(expertA, completed.id, {
      sufficient: true, score: 4, criticalError: false, now: new Date(startedAt.getTime() + 5 * MINUTE),
    });
    await repository.claimSpeakingCalibrationSample(expertB, { now: new Date(startedAt.getTime() + 6 * MINUTE) });
    await repository.submitSpeakingCalibrationReview(expertB, completed.id, {
      sufficient: true, score: 4, criticalError: false, now: new Date(startedAt.getTime() + 10 * MINUTE),
    });
    assert.equal(await repository.deleteUserData(owner), true);
    const labels = await repository.listAnonymousSpeakingCalibrationLabels();
    assert.equal(labels.some((entry) => entry.sampleId === completed.id), true);
    assert.equal(labels.some((entry) => entry.sampleId === expired.id), false);
    assert.equal(JSON.stringify(labels).includes(owner), false);
    assert.equal(JSON.stringify(labels).includes(expertA), false);
    assert.equal(JSON.stringify(labels).includes(expertB), false);
    assert.equal(labels.find((entry) => entry.sampleId === completed.id).ratings
      .every((rating) => !rating.reviewer), true,
    'anonymous labels surviving owner deletion must not retain reviewer identities');
  });
});
