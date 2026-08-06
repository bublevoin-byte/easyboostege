import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { createSpeakingRoutes } from '../routes/speaking.js';
import { createSpeakingAssessmentService } from '../speaking/assessment-service.js';
import { createFakePronunciationProvider } from '../speaking/pronunciation-provider.js';
import { createFileRepository } from '../storage/file-repository.js';
import { testPcmWavAudio } from './support/wav-audio.js';

async function withServer({
  scenario = 'success', maxAudioBytes = 4 * 1024 * 1024, voiceConsent = true, rateLimited = false,
  pronunciationProvider = null, maxAudioSeconds = 180,
} = {}, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-speaking-pronunciation-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const owner = await repository.createTelegramUser(9_620_001, 'Pronunciation API owner');
  const other = await repository.createTelegramUser(9_620_002, 'Pronunciation API other');
  await repository.grantDays(9_620_001, 30, 'Pronunciation API owner');
  await repository.grantDays(9_620_002, 30, 'Pronunciation API other');
  const fixedNow = new Date('2026-08-06T13:00:00.000Z');
  const provider = pronunciationProvider || createFakePronunciationProvider({ scenario, maxAudioBytes });
  const pronunciationAssessment = createSpeakingAssessmentService({
    db: repository, provider, now: () => fixedNow,
  });
  const app = express();
  app.use(express.json());
  app.use(createSpeakingRoutes({
    authentication: { auth(req, res, next) {
      const username = req.get('x-test-user');
      if (!username) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
      req.user = username;
      return next();
    } },
    access: { async requireActiveSubscription(req, res, next) {
      if ((await repository.getSub(req.user)).active) return next();
      return res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED' } });
    }, sttLimiter(_req, res, next) {
      return rateLimited ? res.status(429).json({ error: { code: 'RATE_LIMITED' } }) : next();
    }, requirePrivacyConsent(kind) { return (_req, res, next) => (
      kind === 'voice_processing' && voiceConsent
        ? next()
        : res.status(403).json({ error: { code: 'PRIVACY_CONSENT_REQUIRED' } })
    ); } },
    db: repository,
    pronunciationAssessment,
    pronunciationMaxAudioBytes: maxAudioBytes,
    pronunciationMaxAudioSeconds: maxAudioSeconds,
    now: () => fixedNow,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jsonRequest = (username, pathname, { method = 'GET', body } = {}) => fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': username },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const audioRequest = (username, sessionId, {
    audio = testPcmWavAudio(),
    idempotencyKey = '10000000-0000-4000-8000-000000000071',
    locale = 'en-US', duration = '3', contentType = 'audio/wav', taskType = 1, item = null,
  } = {}) => fetch(`${baseUrl}/api/v1/speaking/task-${taskType}/sessions/${sessionId}/pronunciation-assessment`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      'x-test-user': username,
      'idempotency-key': idempotencyKey,
      'x-speech-locale': locale,
      'x-audio-duration-seconds': duration,
      ...(item == null ? {} : { 'x-speaking-item': String(item) }),
    },
    body: audio,
  });
  try {
    await run({ owner, other, repository, jsonRequest, audioRequest });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('task 1 pronunciation endpoint binds server reference, returns bounded DTO and bills exact replay once', async () => {
  await withServer({}, async ({ owner, other, repository, jsonRequest, audioRequest }) => {
    const assignedResponse = await jsonRequest(owner, '/api/v1/speaking/task-1/sessions', { method: 'POST', body: {} });
    const assigned = await assignedResponse.json();
    const status = await (await jsonRequest(owner, '/api/v1/speaking/pronunciation-assessments/status')).json();
    assert.equal(status.provider.available, true);
    assert.equal(status.quota.remainingSeconds, 3_600);

    assert.equal((await audioRequest(other, assigned.id)).status, 404);
    assert.equal((await audioRequest(owner, 'not-a-uuid')).status, 400);
    assert.equal((await audioRequest(owner, assigned.id, { idempotencyKey: 'bad' })).status, 400);
    assert.equal((await audioRequest(owner, assigned.id, { locale: 'fr-FR' })).status, 400);
    assert.equal((await audioRequest(owner, assigned.id, { duration: '181' })).status, 400);
    assert.equal((await audioRequest(owner, assigned.id, { contentType: 'text/plain' })).status, 415);
    assert.equal((await audioRequest(owner, assigned.id, { contentType: 'audio/webm' })).status, 415);
    assert.equal((await audioRequest(owner, assigned.id, {
      audio: Buffer.from('not-a-wave-container'),
      idempotencyKey: '10000000-0000-4000-8000-000000000079',
    })).status, 400);
    assert.equal((await audioRequest(owner, assigned.id, { audio: Buffer.alloc(4 * 1024 * 1024 + 1) })).status, 413);
    assert.equal((await audioRequest(owner, assigned.id, {
      duration: '1', idempotencyKey: '10000000-0000-4000-8000-000000000077',
    })).status, 400);
    assert.equal((await audioRequest(owner, assigned.id, {
      audio: testPcmWavAudio({ durationSeconds: 90.001 }), duration: '90',
      idempotencyKey: '10000000-0000-4000-8000-000000000078',
    })).status, 400);

    const assessedResponse = await audioRequest(owner, assigned.id);
    assert.equal(assessedResponse.status, 200);
    assert.equal(assessedResponse.headers.get('cache-control'), 'no-store');
    const assessed = await assessedResponse.json();
    assert.equal(assessed.assessment.status, 'success');
    assert.equal(assessed.assessment.transcript, 'A short trusted transcript.');
    assert.equal(assessed.assessment.words.length, 1);
    assert.equal(assessed.billing.reservedSeconds, 3);
    assert.equal(assessed.billing.billableSeconds, 3);
    assert.equal(assessed.quota.usedSeconds, 3);
    assert.equal(Object.hasOwn(assessed, 'audio'), false);
    assert.equal(Object.hasOwn(assessed.assessment, 'raw'), false);
    assert.equal(JSON.stringify(assessed).includes('RIFF-route-audio'), false);

    const replay = await (await audioRequest(owner, assigned.id)).json();
    assert.deepEqual(replay, assessed);
    assert.equal((await repository.exportUserData(owner)).speaking_assessments.length, 1);

    await jsonRequest(owner, `/api/v1/speaking/task-1/sessions/${assigned.id}/complete`, {
      method: 'POST',
      body: { recordingDurationSeconds: 3, micCheck: 'passed', localPlayback: true, selfRating: 'steady' },
    });
    const afterLocalPlayback = await (await jsonRequest(owner, '/api/v1/speaking/pronunciation-assessments/status')).json();
    assert.equal(afterLocalPlayback.quota.usedSeconds, 3);
  });
});

test('tasks 2-4 pronunciation uploads are owner-bound and use exact item contexts', async () => {
  const providerInputs = [];
  const pronunciationProvider = {
    async status() { return { available: true, provider: 'test-azure', reason: null }; },
    async assess(input, { onProcessingStarted }) {
      providerInputs.push({
        mode: input.mode,
        referenceText: input.referenceText,
        contextId: input.contextId,
      });
      await onProcessingStarted();
      return {
        status: 'success', isFinal: true, available: true,
        processedDurationSeconds: input.durationSeconds,
        transcript: 'A server assessed answer.', confidence: 96, words: [],
        quality: { acceptable: true, warnings: [] },
      };
    },
  };
  await withServer({ pronunciationProvider }, async ({ owner, other, jsonRequest, audioRequest }) => {
    const sessions = {};
    for (const taskType of [2, 3, 4]) {
      sessions[taskType] = await (await jsonRequest(owner, `/api/v1/speaking/task-${taskType}/sessions`, {
        method: 'POST', body: {},
      })).json();
    }

    assert.equal((await audioRequest(owner, sessions[2].id, {
      taskType: 2, idempotencyKey: '10000000-0000-4000-8000-000000000072',
    })).status, 400, 'task 2 requires an exact question position');
    assert.equal((await audioRequest(owner, sessions[3].id, {
      taskType: 3, item: 6, idempotencyKey: '10000000-0000-4000-8000-000000000073',
    })).status, 400, 'task 3 rejects an out-of-range answer position');
    assert.equal((await audioRequest(other, sessions[4].id, {
      taskType: 4, idempotencyKey: '10000000-0000-4000-8000-000000000074',
    })).status, 404, 'another user cannot attach audio to the owner session');

    const uploads = [
      { taskType: 2, item: 3, key: '10000000-0000-4000-8000-000000000082' },
      { taskType: 3, item: 5, key: '10000000-0000-4000-8000-000000000083' },
      { taskType: 4, item: null, key: '10000000-0000-4000-8000-000000000084' },
    ];
    for (const upload of uploads) {
      const response = await audioRequest(owner, sessions[upload.taskType].id, {
        taskType: upload.taskType,
        item: upload.item,
        idempotencyKey: upload.key,
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).assessment.status, 'success');
    }

    assert.deepEqual(providerInputs, uploads.map(({ taskType, item }) => ({
      mode: 'unscripted',
      referenceText: null,
      contextId: `task${taskType}:${sessions[taskType].id}:${sessions[taskType].task.id}@${sessions[taskType].task.revision}${item == null ? '' : `:item${item}`}`,
    })));
  });
});

test('unconfigured provider status and assessment fail closed without creating a quota row', async () => {
  await withServer({ scenario: 'unavailable' }, async ({ owner, repository, jsonRequest, audioRequest }) => {
    const assigned = await (await jsonRequest(owner, '/api/v1/speaking/task-1/sessions', {
      method: 'POST', body: {},
    })).json();
    const status = await (await jsonRequest(owner, '/api/v1/speaking/pronunciation-assessments/status')).json();
    assert.deepEqual(status.provider, {
      available: false, reason: 'provider_unavailable', provider: 'fake-azure',
    });
    const response = await audioRequest(owner, assigned.id);
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.error.code, 'SPEAKING_PRONUNCIATION_UNAVAILABLE');
    assert.equal((await repository.exportUserData(owner)).speaking_assessments.length, 0);
  });
});

test('assessment requires current external voice-processing consent before parsing or reserving audio', async () => {
  await withServer({ voiceConsent: false }, async ({ owner, repository, jsonRequest, audioRequest }) => {
    const assigned = await (await jsonRequest(owner, '/api/v1/speaking/task-1/sessions', {
      method: 'POST', body: {},
    })).json();
    const response = await audioRequest(owner, assigned.id, { audio: Buffer.alloc(4 * 1024 * 1024 + 1) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'PRIVACY_CONSENT_REQUIRED');
    assert.equal((await repository.exportUserData(owner)).speaking_assessments.length, 0);
  });
});

test('paid assessment rate limit runs before raw body parsing and provider reservation', async () => {
  await withServer({ rateLimited: true }, async ({ owner, repository, jsonRequest, audioRequest }) => {
    const assigned = await (await jsonRequest(owner, '/api/v1/speaking/task-1/sessions', {
      method: 'POST', body: {},
    })).json();
    const response = await audioRequest(owner, assigned.id, { audio: Buffer.alloc(4 * 1024 * 1024 + 1) });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'RATE_LIMITED');
    assert.equal((await repository.exportUserData(owner)).speaking_assessments.length, 0);
  });
});

test('sub-second WAV is rejected before provider lookup or quota reservation', async () => {
  const providerCalls = { status: 0, assess: 0 };
  const pronunciationProvider = {
    async status() { providerCalls.status += 1; return { available: true, provider: 'test', reason: null }; },
    async assess() { providerCalls.assess += 1; throw new Error('provider must not be reached'); },
  };
  await withServer({ pronunciationProvider }, async ({ owner, repository, jsonRequest, audioRequest }) => {
    const assigned = await (await jsonRequest(owner, '/api/v1/speaking/task-1/sessions', {
      method: 'POST', body: {},
    })).json();
    const response = await audioRequest(owner, assigned.id, {
      audio: testPcmWavAudio({ durationSeconds: 0.5 }),
      duration: '1',
      idempotencyKey: '10000000-0000-4000-8000-000000000076',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(providerCalls, { status: 0, assess: 0 });
    assert.equal((await repository.exportUserData(owner)).speaking_assessments.length, 0);
  });
});

test('operator duration cap is enforced before provider lookup or quota reservation', async () => {
  const providerCalls = { status: 0, assess: 0 };
  const pronunciationProvider = {
    async status() { providerCalls.status += 1; return { available: true, provider: 'test', reason: null }; },
    async assess(_input, { onProcessingStarted }) {
      providerCalls.assess += 1;
      await onProcessingStarted();
      return { status: 'success', processedDurationSeconds: 3, transcript: 'test', words: [] };
    },
  };
  await withServer({ pronunciationProvider, maxAudioSeconds: 2 }, async ({
    owner, repository, jsonRequest, audioRequest,
  }) => {
    const assigned = await (await jsonRequest(owner, '/api/v1/speaking/task-1/sessions', {
      method: 'POST', body: {},
    })).json();
    const response = await audioRequest(owner, assigned.id);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /2 секунд/u);
    assert.deepEqual(providerCalls, { status: 0, assess: 0 });
    assert.equal((await repository.exportUserData(owner)).speaking_assessments.length, 0);
  });
});

test('OpenAPI and migrations publish bounded audio, quota and safe assessment contracts', async () => {
  const [specification, migration, contextMigration] = await Promise.all([
    fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../migrations/046_speaking_pronunciation_assessments.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../migrations/047_speaking_assessment_context.sql', import.meta.url), 'utf8'),
  ]);
  assert.match(specification, /\/api\/v1\/speaking\/pronunciation-assessments\/status:/u);
  assert.match(specification, /\/api\/v1\/speaking\/task-1\/sessions\/\{sessionId\}\/pronunciation-assessment:/u);
  assert.match(specification, /\/api\/v1\/speaking\/task-2\/sessions\/\{sessionId\}\/pronunciation-assessment:/u);
  assert.match(specification, /\/api\/v1\/speaking\/task-3\/sessions\/\{sessionId\}\/pronunciation-assessment:/u);
  assert.match(specification, /\/api\/v1\/speaking\/task-4\/sessions\/\{sessionId\}\/pronunciation-assessment:/u);
  const pronunciationPath = specification.split(
    '/api/v1/speaking/task-1/sessions/{sessionId}/pronunciation-assessment:',
  )[1].split('/api/v1/speaking/task-1/sessions:')[0];
  assert.match(specification, /Idempotency-Key/u);
  assert.match(specification, /X-Audio-Duration-Seconds/u);
  assert.match(pronunciationPath, /audio\/wav/u);
  assert.doesNotMatch(pronunciationPath, /audio\/(?:webm|mp4|mpeg|ogg)/iu);
  assert.match(specification, /maxLength: 10485760, x-maxBytes: 10485760/u);
  assert.match(specification, /SpeakingPronunciationAssessment:/u);
  assert.match(migration, /UNIQUE \(username, idempotency_key\)/u);
  assert.match(migration, /status IN \('reserved', 'dispatching', 'started', 'finalized', 'released'\)/u);
  assert.match(migration, /dispatch_started_at TIMESTAMPTZ/u);
  assert.match(migration, /ON DELETE CASCADE/u);
  assert.doesNotMatch(migration, /subscription_key|audio BYTEA|provider_payload/iu);
  assert.match(contextMigration, /ADD COLUMN IF NOT EXISTS context_id VARCHAR\(300\)/u);
  assert.match(contextMigration, /char_length\(context_id\) BETWEEN 1 AND 300/u);
  assert.match(contextMigration, /context_id ~ '\^\[a-zA-Z0-9:@\._-\]\+\$'/u);
});
