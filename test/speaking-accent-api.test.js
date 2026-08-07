import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createSpeakingRoutes } from '../routes/speaking.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { speakingCalibrationRubric } from '../speaking/accent-calibration.js';
import { createFileRepository } from '../storage/file-repository.js';
import { testPcmWavAudio } from './support/wav-audio.js';

async function withServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-accent-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(9_681_001, 'Accent API owner');
  const other = await repository.createTelegramUser(9_681_002, 'Accent API other');
  const expertA = await repository.createTelegramUser(9_681_003, 'Accent Expert A');
  const expertB = await repository.createTelegramUser(9_681_004, 'Accent Expert B');
  const expertC = await repository.createTelegramUser(9_681_005, 'Accent Expert C');
  await repository.setUserRole(expertA, 'admin');
  await repository.setUserRole(expertB, 'admin');
  await repository.setUserRole(expertC, 'admin');
  for (const telegramId of [9_681_001, 9_681_002, 9_681_003, 9_681_004, 9_681_005]) {
    await repository.grantDays(telegramId, 30, 'Accent API test');
  }
  let now = new Date('2026-08-06T10:00:00.000Z');
  const app = express();
  app.use(express.json());
  app.use(createSpeakingRoutes({
    authentication: {
      auth(req, res, next) {
        const username = req.get('x-test-user');
        if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        req.user = username;
        return next();
      },
      requireRole(role) {
        return async (req, res, next) => {
          const user = await repository.getUser(req.user);
          return user?.role === role ? next() : res.status(403).json({ error: { code: 'FORBIDDEN' } });
        };
      },
    },
    access: { async requireActiveSubscription(req, res, next) {
      return (await repository.getSub(req.user)).active
        ? next() : res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED' } });
    } },
    db: repository,
    now: () => now,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const json = (username, pathname, { method = 'GET', body } = {}) => fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': username },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const binary = (username, pathname, audio, headers = {}) => fetch(`${baseUrl}${pathname}`, {
    method: 'POST', body: audio,
    headers: { 'content-type': 'audio/wav', 'x-test-user': username, ...headers },
  });
  try {
    await run({ repository, owner, other, expertA, expertB, expertC, json, binary, setNow(value) { now = new Date(value); } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function finalizedAssessment(repository, username, {
  key = crypto.randomUUID(), locale, contextId, overallScore, audio = testPcmWavAudio(),
}) {
  await repository.reserveSpeakingAssessment(username, {
    id: crypto.randomUUID(), idempotencyKey: key, requestHash: crypto.randomBytes(32).toString('hex'),
    audioHash: crypto.createHash('sha256').update(audio).digest('hex'),
    reservedSeconds: 3, locale, contextId, now: new Date('2026-08-06T10:00:00.000Z'),
  });
  await repository.dispatchSpeakingAssessment(username, key, { now: new Date('2026-08-06T10:00:00.100Z') });
  await repository.startSpeakingAssessment(username, key, { now: new Date('2026-08-06T10:00:00.200Z') });
  await repository.finalizeSpeakingAssessment(username, key, {
    billableSeconds: 3,
    result: {
      assessment: {
        status: 'success', isFinal: true, locale, overallScore, confidence: 94,
        quality: { acceptable: true, warnings: [] },
      },
      billing: { assessmentId: crypto.randomUUID(), reservedSeconds: 3, billableSeconds: 3 },
    },
    now: new Date('2026-08-06T10:00:01.000Z'),
  });
  return key;
}

test('profile API persists manual future-effective session locale and prevents client override', async () => {
  await withServer(async ({ owner, json, binary }) => {
    const empty = await (await json(owner, '/api/v1/speaking/accent-profile')).json();
    assert.deepEqual(empty, { profile: null, calibration: null, setupRequired: true });
    const chosen = await json(owner, '/api/v1/speaking/accent-profile', {
      method: 'PUT', body: { locale: 'en-US' },
    });
    assert.equal(chosen.status, 200);
    assert.equal((await chosen.json()).profile.locale, 'en-US');
    const session = await (await json(owner, '/api/v1/speaking/task-1/sessions', {
      method: 'POST', body: {},
    })).json();
    assert.deepEqual(session.accentProfile, {
      locale: 'en-US', revision: 1, effectiveAt: '2026-08-06T10:00:00.000Z',
    });

    const override = await binary(
      owner,
      `/api/v1/speaking/task-1/sessions/${session.id}/pronunciation-assessment`,
      testPcmWavAudio(),
      {
        'idempotency-key': crypto.randomUUID(),
        'x-speech-locale': 'en-GB',
        'x-audio-duration-seconds': '3',
      },
    );
    assert.equal(override.status, 409);
    assert.equal((await override.json()).error.code, 'SPEAKING_ACCENT_PROFILE_MISMATCH');
  });
});

test('ordinary assignments require an accent profile and only a matching pending setup unlocks dual-locale task 1', async () => {
  await withServer(async ({ repository, owner, json, binary }) => {
    const denied = await json(owner, '/api/v1/speaking/task-1/sessions', {
      method: 'POST', body: {},
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error.code, 'SPEAKING_ACCENT_PROFILE_REQUIRED');

    const setup = await (await json(owner, '/api/v1/speaking/accent-profile/calibration', {
      method: 'POST', body: {},
    })).json();
    assert.equal((await json(owner, '/api/v1/speaking/task-1/sessions', {
      method: 'POST', body: {},
    })).status, 409, 'a pending setup alone does not turn every assignment into a dual-locale session');
    const calibrationSession = await json(owner, '/api/v1/speaking/task-1/sessions', {
      method: 'POST', body: { calibrationSetupId: setup.id },
    });
    assert.equal(calibrationSession.status, 201);
    const calibrationSessionBody = await calibrationSession.json();
    assert.equal(calibrationSessionBody.accentProfile, null);
    assert.equal((await repository.getSpeakingTask1Session(owner, calibrationSessionBody.id))
      .calibration_setup_id, setup.id, 'the exceptional session persists its exact setup binding');
    for (const locale of ['en-GB', 'en-US']) {
      assert.equal((await binary(
        owner,
        `/api/v1/speaking/task-1/sessions/${calibrationSessionBody.id}/pronunciation-assessment`,
        testPcmWavAudio(),
        {
          'idempotency-key': crypto.randomUUID(),
          'x-speech-locale': locale,
          'x-audio-duration-seconds': '3',
        },
      )).status, 503, 'only the setup-bound task 1 session accepts both calibration locales');
    }
    assert.equal((await json(owner, '/api/v1/speaking/task-2/sessions', {
      method: 'POST', body: { calibrationSetupId: setup.id },
    })).status, 409, 'dual-locale calibration is restricted to the scripted task-1 session');

    const legacyNullAccent = await repository.assignSpeakingTask2Session(owner, {
      catalogId: SPEAKING_TASK2_CATALOG.id,
      catalogRevision: SPEAKING_TASK2_CATALOG.revision,
      tasks: SPEAKING_TASK2_CATALOG.tasks,
      accentProfile: null,
      now: new Date('2026-08-06T10:00:00.000Z'),
    });
    const migratedBypass = await binary(
      owner,
      `/api/v1/speaking/task-2/sessions/${legacyNullAccent.id}/pronunciation-assessment`,
      testPcmWavAudio(),
      {
        'idempotency-key': crypto.randomUUID(),
        'x-speech-locale': 'en-GB',
        'x-audio-duration-seconds': '3',
        'x-speaking-item': '1',
      },
    );
    assert.equal(migratedBypass.status, 409, 'legacy null-accent task 2 cannot borrow a pending setup');
    assert.equal((await migratedBypass.json()).error.code, 'SPEAKING_ACCENT_PROFILE_MISMATCH');
  });
});

test('unknown setup is one-time and accepts only two owner-bound final assessments of one context', async () => {
  await withServer(async ({ repository, owner, other, json }) => {
    const start = await json(owner, '/api/v1/speaking/accent-profile/calibration', { method: 'POST', body: {} });
    assert.equal(start.status, 201);
    const setup = await start.json();
    const contextId = `task1:${crypto.randomUUID()}:read-v1-001@1`;
    const enGbAssessmentKey = await finalizedAssessment(repository, owner, {
      locale: 'en-GB', contextId, overallScore: 82,
    });
    const enUsAssessmentKey = await finalizedAssessment(repository, owner, {
      locale: 'en-US', contextId, overallScore: 91,
    });
    const foreignKey = await finalizedAssessment(repository, other, {
      locale: 'en-US', contextId, overallScore: 99,
    });
    const differentAudio = Buffer.from(testPcmWavAudio());
    differentAudio[differentAudio.length - 1] ^= 1;
    const differentRecordingKey = await finalizedAssessment(repository, owner, {
      locale: 'en-US', contextId, overallScore: 99, audio: differentAudio,
    });
    assert.equal((await json(owner, `/api/v1/speaking/accent-profile/calibration/${setup.id}/complete`, {
      method: 'POST', body: { enGbAssessmentKey, enUsAssessmentKey: foreignKey },
    })).status, 409);
    assert.equal((await json(owner, `/api/v1/speaking/accent-profile/calibration/${setup.id}/complete`, {
      method: 'POST', body: { enGbAssessmentKey, enUsAssessmentKey: differentRecordingKey },
    })).status, 409, 'both locale assessments must come from the exact same recording');
    const complete = await json(owner, `/api/v1/speaking/accent-profile/calibration/${setup.id}/complete`, {
      method: 'POST', body: { enGbAssessmentKey, enUsAssessmentKey },
    });
    assert.equal(complete.status, 200);
    assert.deepEqual((await complete.json()).profile, {
      locale: 'en-US', revision: 1, source: 'calibration',
      effective_at: '2026-08-06T10:00:00.000Z', calibration_used: true,
    });
    assert.equal((await json(owner, '/api/v1/speaking/accent-profile/calibration', {
      method: 'POST', body: {},
    })).status, 409);
  });
});

test('calibration consent does not affect training and minor enrollment is guardian-gated', async () => {
  await withServer(async ({ owner, json }) => {
    const denied = await json(owner, '/api/v1/speaking/calibration-consent', {
      method: 'PUT', body: { granted: true, ageGroup: 'minor', guardianConfirmed: false },
    });
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).error.code, 'SPEAKING_CALIBRATION_GUARDIAN_REQUIRED');
    const granted = await json(owner, '/api/v1/speaking/calibration-consent', {
      method: 'PUT', body: { granted: true, ageGroup: 'minor', guardianConfirmed: true },
    });
    assert.equal(granted.status, 200);
    assert.equal((await granted.json()).granted, true);
    const revoked = await json(owner, '/api/v1/speaking/calibration-consent', {
      method: 'PUT', body: { granted: false, ageGroup: 'minor', guardianConfirmed: true },
    });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).granted, false);
    await json(owner, '/api/v1/speaking/accent-profile', {
      method: 'PUT', body: { locale: 'en-GB' },
    });
    assert.equal((await json(owner, '/api/v1/speaking/task-1/sessions', {
      method: 'POST', body: {},
    })).status, 201, 'declining research calibration never blocks training');
  });
});

test('an owner can read and revoke calibration consent after subscription expiry and raw audio is deleted', async () => {
  await withServer(async ({ repository, owner, json, binary }) => {
    await json(owner, '/api/v1/speaking/calibration-consent', {
      method: 'PUT', body: { granted: true, ageGroup: 'adult', guardianConfirmed: false },
    });
    const audio = testPcmWavAudio();
    const assessmentKey = await finalizedAssessment(repository, owner, {
      locale: 'en-GB', contextId: `task1:${crypto.randomUUID()}:speaking-pilot-v1.task1.community-garden@1`,
      overallScore: 90, audio,
    });
    assert.equal((await binary(owner, '/api/v1/speaking/calibration-samples', audio, {
      'x-speaking-assessment-key': assessmentKey,
    })).status, 201);
    await repository.grantDays(9_681_001, -100);

    assert.equal((await json(owner, '/api/v1/speaking/calibration-consent')).status, 200);
    const revoked = await json(owner, '/api/v1/speaking/calibration-consent', {
      method: 'PUT', body: { granted: false, ageGroup: 'adult', guardianConfirmed: false },
    });
    assert.equal(revoked.status, 200);
    const [sample] = await repository.listSpeakingCalibrationSamplesForOwner(owner);
    assert.equal(sample.audio_retained, false);
    assert.equal(sample.status, 'consent_revoked');
  });
});

test('sample upload verifies exact assessed audio and expert endpoints provide blinded task and rubric', async () => {
  await withServer(async ({ repository, owner, other, expertA, expertB, json, binary }) => {
    await json(owner, '/api/v1/speaking/calibration-consent', {
      method: 'PUT', body: { granted: true, ageGroup: 'adult', guardianConfirmed: false },
    });
    const contextId = `task4:${crypto.randomUUID()}:speaking-pilot-v1.task4.learning-new-skills@1`;
    const audio = testPcmWavAudio();
    const assessmentKey = await finalizedAssessment(repository, owner, {
      locale: 'en-US', contextId, overallScore: 88, audio,
    });
    const unknownTaskKey = await finalizedAssessment(repository, owner, {
      locale: 'en-US',
      contextId: `task4:${crypto.randomUUID()}:speaking-pilot-v1.task4.not-a-catalog-task@1`,
      overallScore: 88,
      audio,
    });
    const unknownTask = await binary(owner, '/api/v1/speaking/calibration-samples', audio, {
      'x-speaking-assessment-key': unknownTaskKey,
    });
    assert.equal(unknownTask.status, 409, 'calibration accepts only a server-catalog task reference');
    assert.equal((await unknownTask.json()).error.code, 'SPEAKING_ACCENT_CALIBRATION_EVIDENCE_INVALID');
    const partialTaskKey = await finalizedAssessment(repository, owner, {
      locale: 'en-US',
      contextId: `task3:${crypto.randomUUID()}:speaking-pilot-v1.task3.free-time-routines@1:item1`,
      overallScore: 4,
      audio,
    });
    const partialTask = await binary(owner, '/api/v1/speaking/calibration-samples', audio, {
      'x-speaking-assessment-key': partialTaskKey,
    });
    assert.equal(partialTask.status, 409, 'one task 2/3 item is not a complete calibration sample');
    assert.equal((await partialTask.json()).error.code, 'SPEAKING_ACCENT_CALIBRATION_EVIDENCE_INVALID');
    assert.equal((await binary(other, '/api/v1/speaking/calibration-samples', testPcmWavAudio(), {
      'x-speaking-assessment-key': assessmentKey,
    })).status, 409);
    const unrelatedAudio = Buffer.from(audio);
    unrelatedAudio[unrelatedAudio.length - 1] ^= 1;
    const mismatch = await binary(owner, '/api/v1/speaking/calibration-samples', unrelatedAudio, {
      'x-speaking-assessment-key': assessmentKey,
    });
    assert.equal(mismatch.status, 409);
    assert.equal((await mismatch.json()).error.code, 'SPEAKING_ACCENT_CALIBRATION_EVIDENCE_INVALID');
    const uploaded = await binary(owner, '/api/v1/speaking/calibration-samples', audio, {
      'x-speaking-assessment-key': assessmentKey,
    });
    assert.equal(uploaded.status, 201);

    assert.equal((await json(owner, '/api/v1/speaking/calibration-reviews/next')).status, 403);
    const first = await json(expertA, '/api/v1/speaking/calibration-reviews/next');
    assert.equal(first.status, 200);
    const card = await first.json();
    assert.deepEqual(Object.keys(card).sort(), [
      'accentLocale', 'expiresAt', 'maximumScore', 'reviewRound', 'rubric', 'sampleId', 'task', 'taskRef', 'taskType',
    ]);
    assert.equal(card.task.id, 'speaking-pilot-v1.task4.learning-new-skills');
    assert.equal(card.rubric.maximumScore, 10);
    assert.equal(card.rubric.version, 'ege-speaking-expert-rubric-v1');
    assert.equal(JSON.stringify(card).includes(owner), false);
    const audioResponse = await json(expertA, `/api/v1/speaking/calibration-reviews/${card.sampleId}/audio`);
    assert.equal(audioResponse.status, 200);
    assert.equal(audioResponse.headers.get('content-type'), 'audio/wav');
    assert.equal((await audioResponse.arrayBuffer()).byteLength, testPcmWavAudio().length);
    assert.equal((await json(expertA, `/api/v1/speaking/calibration-reviews/${card.sampleId}`, {
      method: 'POST', body: { sufficient: true, score: 8, criticalError: false },
    })).status, 200);
    const second = await (await json(expertB, '/api/v1/speaking/calibration-reviews/next')).json();
    const completed = await json(expertB, `/api/v1/speaking/calibration-reviews/${second.sampleId}`, {
      method: 'POST', body: { sufficient: true, score: 8, criticalError: false },
    });
    assert.equal((await completed.json()).audio_retained, false);
    assert.equal((await json(expertB, `/api/v1/speaking/calibration-reviews/${card.sampleId}/audio`)).status, 404);
  });
});

test('expert review uses the immutable enrolled task after that revision leaves the active catalog', async () => {
  await withServer(async ({ repository, owner, expertA, json }) => {
    await json(owner, '/api/v1/speaking/calibration-consent', {
      method: 'PUT', body: { granted: true, ageGroup: 'adult', guardianConfirmed: false },
    });
    const taskRef = `task4:${crypto.randomUUID()}:speaking-archive-v0.task4.archived-project@7`;
    const archivedTask = {
      id: 'speaking-archive-v0.task4.archived-project',
      revision: 7,
      taskType: 4,
      maxScore: 10,
      instruction: 'Archived server-owned calibration task.',
      plan: ['point one', 'point two', 'point three', 'point four'],
    };
    await repository.createSpeakingCalibrationSample(owner, {
      id: crypto.randomUUID(), assessmentKey: crypto.randomUUID(), taskType: 4,
      taskRef, taskSnapshot: archivedTask, rubricSnapshot: speakingCalibrationRubric(4),
      locale: 'en-GB', maximumScore: 10, audio: Buffer.from('archived-private-audio'),
      now: new Date('2026-08-06T10:00:00.000Z'),
    });

    const response = await json(expertA, '/api/v1/speaking/calibration-reviews/next');
    assert.equal(response.status, 200);
    const card = await response.json();
    assert.deepEqual(card.task, archivedTask);
    assert.deepEqual(card.rubric, speakingCalibrationRubric(4));
    assert.equal(card.taskRef, taskRef);
  });
});

test('expired expert leases deny audio and submission while an insufficient review does not count toward deletion', async () => {
  await withServer(async ({ repository, owner, expertA, expertB, expertC, json, binary, setNow }) => {
    await json(owner, '/api/v1/speaking/calibration-consent', {
      method: 'PUT', body: { granted: true, ageGroup: 'adult', guardianConfirmed: false },
    });
    const audio = testPcmWavAudio();
    const assessmentKey = await finalizedAssessment(repository, owner, {
      locale: 'en-GB', contextId: `task1:${crypto.randomUUID()}:speaking-pilot-v1.task1.community-garden@1`,
      overallScore: 89, audio,
    });
    const uploaded = await binary(owner, '/api/v1/speaking/calibration-samples', audio, {
      'x-speaking-assessment-key': assessmentKey,
    });
    const sampleId = (await uploaded.json()).id;
    assert.equal((await json(expertA, '/api/v1/speaking/calibration-reviews/next')).status, 200);

    setNow('2026-08-06T10:16:00.000Z');
    assert.equal((await json(expertA, `/api/v1/speaking/calibration-reviews/${sampleId}/audio`)).status, 404);
    const expiredSubmit = await json(expertA, `/api/v1/speaking/calibration-reviews/${sampleId}`, {
      method: 'POST', body: { sufficient: true, score: 1, criticalError: false },
    });
    assert.equal(expiredSubmit.status, 409);
    assert.equal((await expiredSubmit.json()).error.code, 'SPEAKING_CALIBRATION_REVIEW_CLAIM_REQUIRED');

    const takeover = await json(expertB, '/api/v1/speaking/calibration-reviews/next');
    assert.equal((await takeover.json()).sampleId, sampleId);
    const insufficient = await json(expertB, `/api/v1/speaking/calibration-reviews/${sampleId}`, {
      method: 'POST', body: { sufficient: false },
    });
    assert.deepEqual(await insufficient.json(), {
      sampleId, status: 'awaiting_reviews', audio_retained: true, reviewCount: 0,
    });

    const third = await (await json(expertC, '/api/v1/speaking/calibration-reviews/next')).json();
    assert.equal(third.sampleId, sampleId);
    const oneSufficient = await json(expertC, `/api/v1/speaking/calibration-reviews/${sampleId}`, {
      method: 'POST', body: { sufficient: true, score: 1, criticalError: false },
    });
    assert.equal((await oneSufficient.json()).audio_retained, true);
  });
});
