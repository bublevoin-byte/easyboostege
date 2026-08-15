import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createEgeMockRoutes } from '../routes/ege-mocks.js';
import { createFileRepository } from '../storage/file-repository.js';
import { createEgeMockAttempt, egeMockAttemptPublicDto } from '../ege-mock/attempt.js';
import { EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockForm } from '../ege-mock/catalog.js';
import { compileOpenApiSchema } from './support/openapi-schema-evaluator.js';
import { EGE_MOCK_FORM_1_V1_PUBLIC } from '../public/ege-mock-form-1-v1.js';
import { createEgeMockWrittenRunner } from '../public/ege-mock-written-runner.js';
import {
  createEgeMockWritingAssessmentService,
  createEgeMockWritingConsentAuthority,
} from '../ege-mock/writing-assessment-service.js';
import {
  EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
  egeMockWritingResultPublicDto,
} from '../ege-mock/writing-assessment.js';
import { AUTOMATIC_ASSESSMENT_WARNING } from '../public/automatic-assessment-contract.js';
import { completeEgeMockOralStageLedger } from './support/ege-mock-attempt-contract.js';

function objectKeys(value) {
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  if (!value || typeof value !== 'object') return [];
  return [...Object.keys(value), ...Object.values(value).flatMap(objectKeys)];
}

const writingWords = (count, prefix) => Array.from(
  { length: count }, (_, index) => `${prefix}${index + 1}`,
).join(' ');

async function withServer(run, {
  writingAssessmentFactory = null, routeLogger = null, ownerDays = 30,
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const ownerRecord = await repository.grantDays(9_270_001, ownerDays, 'Mock API owner');
  const { username: owner } = ownerRecord;
  const { username: other } = await repository.grantDays(9_270_002, 30, 'Mock API other');
  let now = new Date('2026-08-13T06:00:00.000Z');
  const app = express();
  app.use(express.json());
  const writingAssessment = writingAssessmentFactory?.(repository) || null;
  app.use(createEgeMockRoutes({
    authentication: { auth(req, _res, next) { req.user = req.get('x-test-user'); next(); } },
    access: { requireActiveSubscription(_req, _res, next) { next(); } },
    db: repository,
    writingAssessment,
    logger: routeLogger,
    now: () => now,
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: { code: error.code || 'ERROR' } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const request = (username, pathname, {
    method = 'GET', body, idempotencyKey, expectedOwner = username,
  } = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${pathname}`,
    {
      method,
      headers: {
        'content-type': 'application/json',
        'x-test-user': username,
        'x-easyboost-expected-owner': expectedOwner,
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  try {
    await run({
      owner, other, repository, request,
      ownerSubscriptionExpiresAt: Number(ownerRecord.sub_until),
      setNow(value) { now = new Date(value); },
    });
  }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('explicit assessment run POST executes deterministic zeros and exact replay is idempotent', async () => {
  let evaluatorCalls = 0;
  await withServer(async ({ owner, request }) => {
    const formResponse = await (await request(owner, '/api/v1/ege-mocks/forms')).json();
    const started = await (await request(owner, '/api/v1/ege-mocks/attempts', {
      method: 'POST', idempotencyKey: '747c4ad1-e12a-4e4c-b1be-4457d52cbff3',
      body: {
        formId: formResponse.forms[0].id,
        formRevision: formResponse.forms[0].revision,
        catalogFingerprint: formResponse.forms[0].fingerprint,
      },
    })).json();
    const submitted = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/written/submit`, {
        method: 'POST', idempotencyKey: '033a2e4a-b89a-4ab1-906a-fb37d9df346d',
        body: { expectedRevision: 0 },
    })).json();
    assert.equal(submitted.attempt.state, 'oral_ready');
    assert.equal(submitted.attempt.writingAssessment.status, 'pending');
    const runPath = `/api/v1/ege-mocks/attempts/${started.attempt.id}/assessment/run`;
    const runKey = '031e11c5-0f1b-4d1f-a81d-d2f48c7cab1b';
    const completed = await (await request(owner, runPath, {
      method: 'POST', idempotencyKey: runKey, body: {},
    })).json();
    assert.equal(completed.applied, true);
    assert.equal(completed.replayed, false);
    assert.equal(completed.attempt.writingAssessment.status, 'completed');
    assert.equal(completed.attempt.writingAssessment.mode, 'experimental');
    assert.equal(completed.attempt.writingAssessment.scoreKind, 'approximate');
    const oralStarted = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/oral/start`, {
        method: 'POST', idempotencyKey: 'af9be76c-2b0f-43f1-af59-91c133c75a88',
        body: { expectedRevision: completed.attempt.revision },
      })).json();
    assert.equal(oralStarted.attempt.state, 'oral_in_progress');
    const replay = await (await request(owner, runPath, {
      method: 'POST', idempotencyKey: runKey, body: {},
    })).json();
    assert.equal(replay.applied, true);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.attempt, completed.attempt,
      'the exact run replay returns its immutable terminal snapshot, not live mutable state');
    assert.equal(evaluatorCalls, 0);
  }, {
    writingAssessmentFactory: (repository) => createEgeMockWritingAssessmentService({
      repository,
      evaluator: async () => { evaluatorCalls += 1; throw new Error('provider must stay unused'); },
      uuid: (() => { let value = 0; return () => `67f6d408-f796-4a25-8000-${String(++value).padStart(12, '0')}`; })(),
      now: () => new Date('2026-08-13T06:01:00.000Z'),
    }),
  });
});

test('offline assessment replay keeps one server-durable subscription block across reloads and renewal', async () => {
  let dispatches = 0;
  await withServer(async ({
    owner, repository, request, setNow, ownerSubscriptionExpiresAt,
  }) => {
    const formResponse = await (await request(owner, '/api/v1/ege-mocks/forms')).json();
    const started = await (await request(owner, '/api/v1/ege-mocks/attempts', {
      method: 'POST', idempotencyKey: '04d927cf-0b25-45f4-997c-68ec07d146c5',
      body: {
        formId: formResponse.forms[0].id,
        formRevision: formResponse.forms[0].revision,
        catalogFingerprint: formResponse.forms[0].fingerprint,
      },
    })).json();
    const submitted = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/written/submit`, {
        method: 'POST', idempotencyKey: '174c15c6-1b6a-4ea1-8b03-42d2066cff1d',
        body: { expectedRevision: 0 },
    })).json();
    assert.equal(submitted.attempt.writingAssessment.status, 'pending');
    assert.equal(Number.isSafeInteger(
      submitted.attempt.writingAssessment.assessmentRevision,
    ), true, 'written submission creates the server-owned assessment revision');

    const staleKey = 'eac647c2-86aa-4d43-86b8-2eb4801425e1';
    const staleRequestHash = crypto.createHash('sha256').update(JSON.stringify({
      operation: 'assessment_run', attemptId: started.attempt.id, body: {},
    })).digest('hex');
    assert.deepEqual(await repository.beginEgeMockAssessmentRun(owner, started.attempt.id, {
      idempotencyKey: staleKey, requestHash: staleRequestHash,
    }), { finalized: false }, 'device A records its automatic UUID while access is active');

    let online = false;
    let terminalRejection = null;
    const idempotencyKey = 'b7cc7429-d9b8-425d-b08b-a6bb043198ef';
    const values = new Map();
    values.set(`easyboost-ege-mock-written-v1:${owner}:0`, JSON.stringify({
      version: 1, owner: { username: owner, generation: 0 }, phase: 'written_submitted',
      formIdentity: EGE_MOCK_FORM_1_V1_PUBLIC.identity,
      catalogFingerprint: EGE_MOCK_FORM_1_V1_PUBLIC.fingerprint,
      attemptId: started.attempt.id,
      attemptOwnerGeneration: submitted.attempt.ownerGeneration,
      revision: submitted.attempt.revision, policyId: submitted.attempt.policyId,
      writtenStartedAt: submitted.attempt.writtenStartedAt,
      writtenDeadlineAt: submitted.attempt.writtenDeadlineAt,
      answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
      preflight: null, pendingStartId: null, saveStatus: 'queued', queue: [],
      compactedThrough: null, canceledSubmit: null,
      assessmentCommand: {
        action: 'run', idempotencyKey,
        createdAt: Date.parse('2026-08-13T06:03:00.000Z'),
        acknowledgePossibleProviderRepeat: false,
      },
      assessmentCommandThrough: null, assetBlockedAt: 0, assetReadyAt: 0,
      assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
      result: {
        kind: 'written_submission', state: submitted.attempt.state,
        writingAssessment: submitted.attempt.writingAssessment,
      },
    }));
    const runner = createEgeMockWrittenRunner({
      owner: { username: owner, generation: 0 },
      storage: {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
      },
      online: () => online,
      clock: () => Date.parse('2026-10-01T06:00:00.000Z'),
      uuid: () => { throw new Error('the exact offline UUID must be preserved'); },
      assets: {},
      transport: {
        async runAssessment(input) {
          const response = await request(owner,
            `/api/v1/ege-mocks/attempts/${input.attemptId}/assessment/run`, {
              method: 'POST', idempotencyKey: input.idempotencyKey, body: {},
            });
          assert.equal(response.status, 200);
          terminalRejection = await response.json();
          return terminalRejection;
        },
      },
    });
    assert.equal((await runner.dispatch({
      type: 'restore', form: EGE_MOCK_FORM_1_V1_PUBLIC,
    })).assessmentRunQueued, true);
    setNow(ownerSubscriptionExpiresAt + 1_000);
    online = true;
    const rejected = await runner.dispatch({ type: 'sync' });
    assert.equal(rejected.assessmentRunQueued, false);
    assert.equal(rejected.result.writingAssessment.runDisposition, 'subscription_required');
    assert.equal(rejected.result.writingAssessment.status, 'pending');
    assert.ok(rejected.result.writingAssessment.assessmentRevision
      > submitted.attempt.writingAssessment.assessmentRevision);
    assert.equal(dispatches, 0, 'an expired unclaimed command never reaches claim/provider dispatch');

    const attemptPath = `/api/v1/ege-mocks/attempts/${started.attempt.id}`;
    const current = await (await request(owner, '/api/v1/ege-mocks/attempts/current')).json();
    const observed = await (await request(owner, attemptPath)).json();
    const safeResult = await (await request(owner, `${attemptPath}/result`)).json();
    assert.equal(current.attempt.writingAssessment.runDisposition, 'subscription_required');
    assert.equal(observed.attempt.writingAssessment.runDisposition, 'subscription_required');
    assert.equal(safeResult.assessmentRunDisposition, 'subscription_required');
    assert.equal(safeResult.writingAssessment.assessmentRevision,
      rejected.result.writingAssessment.assessmentRevision);

    let entitlementRestored = false;
    let minted = 0;
    const renewedKey = '297cf4c6-104b-414d-ae71-5b718e0ba91e';
    const browserTransport = {
      async current() {
        return (await request(owner, '/api/v1/ege-mocks/attempts/current')).json();
      },
      async attempt(attemptId) {
        return (await request(owner, `/api/v1/ege-mocks/attempts/${attemptId}`)).json();
      },
      async runAssessment(input) {
        return (await request(owner,
          `/api/v1/ege-mocks/attempts/${input.attemptId}/assessment/run`, {
            method: 'POST', idempotencyKey: input.idempotencyKey,
            body: input.explicitRenewal === true ? { explicitRenewal: true } : {},
          })).json();
      },
    };
    const reloaded = createEgeMockWrittenRunner({
      owner: { username: owner, generation: 0 }, storage: {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
      },
      online: () => true, assets: {}, transport: browserTransport,
      uuid() {
        assert.equal(entitlementRestored, true,
          'reload and observational GETs must never mint a replacement command');
        minted += 1;
        return renewedKey;
      },
    });
    const restored = await reloaded.dispatch({
      type: 'restore', form: EGE_MOCK_FORM_1_V1_PUBLIC,
    });
    assert.equal(restored.assessmentRunQueued, false);
    assert.equal(restored.result.writingAssessment.runDisposition, 'subscription_required');
    assert.equal(minted, 0);
    assert.equal(dispatches, 0);

    const newDeviceValues = new Map();
    const newDevice = createEgeMockWrittenRunner({
      owner: { username: owner, generation: 0 }, storage: {
        getItem(key) { return newDeviceValues.get(key) ?? null; },
        setItem(key, value) { newDeviceValues.set(key, String(value)); },
      },
      online: () => true, assets: {}, transport: browserTransport,
      uuid() { throw new Error('a new device must adopt the durable subscription block'); },
    });
    const adopted = await newDevice.dispatch({
      type: 'restore', form: EGE_MOCK_FORM_1_V1_PUBLIC,
    });
    assert.equal(adopted.assessmentRunQueued, false);
    assert.equal(adopted.result.writingAssessment.runDisposition, 'subscription_required');
    assert.equal(dispatches, 0);

    const replay = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/assessment/run`, {
        method: 'POST', idempotencyKey, body: {},
      })).json();
    assert.equal(replay.applied, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.disposition, 'subscription_required');
    assert.deepEqual(replay.attempt, terminalRejection.attempt,
      'the same UUID replays the exact post-reconciliation rejection snapshot');
    assert.equal(dispatches, 0);

    await repository.grantDays(9_270_001, 40_000, 'Mock API owner renewed');
    entitlementRestored = true;

    const staleValues = new Map();
    const staleState = JSON.parse(values.get(`easyboost-ege-mock-written-v1:${owner}:0`));
    staleState.assessmentCommand = {
      action: 'run', idempotencyKey: staleKey,
      createdAt: Date.parse('2026-08-13T06:02:00.000Z'),
      acknowledgePossibleProviderRepeat: false,
    };
    staleState.assessmentCommandThrough = null;
    staleState.result.writingAssessment = submitted.attempt.writingAssessment;
    staleValues.set(`easyboost-ege-mock-written-v1:${owner}:0`, JSON.stringify(staleState));
    const staleDevice = createEgeMockWrittenRunner({
      owner: { username: owner, generation: 0 }, storage: {
        getItem(key) { return staleValues.get(key) ?? null; },
        setItem(key, value) { staleValues.set(key, String(value)); },
      },
      online: () => true, assets: {}, transport: browserTransport,
      uuid() { throw new Error('a stale device must not mint an automatic replacement'); },
    });
    const staleTerminal = await staleDevice.dispatch({
      type: 'restore', form: EGE_MOCK_FORM_1_V1_PUBLIC,
    });
    assert.equal(staleTerminal.assessmentRunQueued, false);
    assert.equal(staleTerminal.result.writingAssessment.runDisposition, 'subscription_required');
    assert.equal(dispatches, 0,
      'a stale pre-block UUID cannot dispatch after renewal without an explicit learner action');

    const resumed = await reloaded.dispatch({ type: 'runAssessmentAfterRenewal' });
    assert.equal(minted, 1, 'only the explicit post-renewal action creates a new command');
    assert.equal(dispatches, 1);
    assert.equal(resumed.assessmentRunQueued, true,
      'nonterminal provider work keeps the renewed command durable');
    assert.equal(resumed.result.writingAssessment.runDisposition, undefined);
    const cleared = await (await request(owner, attemptPath)).json();
    assert.equal(cleared.attempt.writingAssessment.runDisposition, undefined);
    assert.ok(cleared.attempt.writingAssessment.assessmentRevision
      > terminalRejection.attempt.writingAssessment.assessmentRevision);

    const lostResponseValues = new Map();
    const lostResponseState = JSON.parse(values.get(`easyboost-ege-mock-written-v1:${owner}:0`));
    lostResponseState.assessmentCommand = {
      action: 'run', idempotencyKey,
      createdAt: Date.parse('2026-08-13T06:03:00.000Z'),
      acknowledgePossibleProviderRepeat: false,
    };
    lostResponseState.assessmentCommandThrough = null;
    lostResponseState.result.writingAssessment = terminalRejection.attempt.writingAssessment;
    lostResponseValues.set(
      `easyboost-ege-mock-written-v1:${owner}:0`, JSON.stringify(lostResponseState),
    );
    let postReplayMinted = 0;
    const postReplayDevice = createEgeMockWrittenRunner({
      owner: { username: owner, generation: 0 }, storage: {
        getItem(key) { return lostResponseValues.get(key) ?? null; },
        setItem(key, value) { lostResponseValues.set(key, String(value)); },
      },
      online: () => true, assets: {}, transport: browserTransport,
      uuid() {
        postReplayMinted += 1;
        return 'f95fde05-0518-4016-829a-0c602c824c5e';
      },
    });
    const postReplay = await postReplayDevice.dispatch({
      type: 'restore', form: EGE_MOCK_FORM_1_V1_PUBLIC,
    });
    assert.equal(postReplay.result.writingAssessment.assessmentRevision,
      cleared.attempt.writingAssessment.assessmentRevision);
    assert.equal(postReplay.result.writingAssessment.runDisposition, undefined,
      'an old immutable terminal replay cannot regress the newer server projection');
    const postReplayDurable = JSON.parse(lostResponseValues.get(
      `easyboost-ege-mock-written-v1:${owner}:0`,
    ));
    assert.equal(postReplayDurable.assessmentCommandThrough.idempotencyKey, idempotencyKey,
      'the stale acknowledged UUID is retired even though its snapshot is older');
    assert.equal(postReplayMinted, 0,
      'retiring the stale run does not manufacture another command');
    assert.equal(dispatches, 1);
  }, {
    ownerDays: 1,
    writingAssessmentFactory: () => ({
      async dispatch() { dispatches += 1; throw new Error('provider must stay unused'); },
    }),
  });
});

test('automatic writing projections expose the canonical experimental approximate warning contract', () => {
  const projection = egeMockWritingResultPublicDto({ writing_assessment: null });
  assert.equal(projection.mode, 'experimental');
  assert.equal(projection.scoreKind, 'approximate');
  assert.equal(projection.warning,
    'Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.');
});

test('writing worker failures stay response-safe and log only sanitized operational fields', async () => {
  const logs = [];
  await withServer(async ({ owner, request }) => {
    const formResponse = await (await request(owner, '/api/v1/ege-mocks/forms')).json();
    const started = await (await request(owner, '/api/v1/ege-mocks/attempts', {
      method: 'POST', idempotencyKey: '10756522-a445-4e1e-ad4f-ae39d7fe5e04',
      body: {
        formId: formResponse.forms[0].id,
        formRevision: formResponse.forms[0].revision,
        catalogFingerprint: formResponse.forms[0].fingerprint,
      },
    })).json();
    const submitted = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/written/submit`, {
        method: 'POST', idempotencyKey: '7304d326-e803-4ac2-9726-9250373bb5ab',
        body: { expectedRevision: 0 },
    })).json();

    assert.equal(submitted.attempt.writingAssessment.status, 'pending');
    await request(owner, `/api/v1/ege-mocks/attempts/${started.attempt.id}/assessment/run`, {
      method: 'POST', idempotencyKey: 'a22ef9e7-5192-4869-ad59-acde0f6b00db', body: {},
    });
    assert.equal(logs.length, 1);
    assert.deepEqual(Object.keys(logs[0]).sort(), [
      'attemptId', 'errorCode', 'level', 'requestId', 'timestamp', 'type',
    ]);
    assert.equal(logs[0].type, 'ege_mock_writing_dispatch_failed');
    assert.equal(logs[0].errorCode, 'INTERNAL_ERROR');
    assert.equal(JSON.stringify(logs[0]).includes(owner), false);
    assert.equal(JSON.stringify(logs[0]).includes('private provider detail'), false);
  }, {
    writingAssessmentFactory: () => ({
      async dispatch() { throw new Error('private provider detail'); },
    }),
    routeLogger: { error(entry) { logs.push(entry); } },
  });
});

test('safe attempt/result GETs have zero provider/claim side effects while deadline reconciliation remains allowed', async () => {
  let dispatches = 0;
  await withServer(async ({ owner, repository, request }) => {
    const formResponse = await (await request(owner, '/api/v1/ege-mocks/forms')).json();
    const started = await (await request(owner, '/api/v1/ege-mocks/attempts', {
      method: 'POST', idempotencyKey: 'f29a91d8-0e70-42bc-9bb4-962fb361ca65',
      body: {
        formId: formResponse.forms[0].id,
        formRevision: formResponse.forms[0].revision,
        catalogFingerprint: formResponse.forms[0].fingerprint,
      },
    })).json();
    const written = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/written/submit`, {
        method: 'POST', idempotencyKey: '3ad3eb8d-5c6a-4f60-956c-bb7d1a675b31',
        body: { expectedRevision: 0 },
    })).json();
    assert.equal(written.attempt.writingAssessment.status, 'pending',
      'written submission records work but does not dispatch it');
    assert.equal(dispatches, 0);
    const runPath = `/api/v1/ege-mocks/attempts/${started.attempt.id}/assessment/run`;
    const runKey = '388d15bc-ae82-4d50-9243-e2491d55d105';
    const lost = await (await request(owner, runPath, {
      method: 'POST', idempotencyKey: runKey, body: {},
    })).json();
    assert.equal(lost.applied, false);
    assert.equal(lost.replayed, false);
    assert.equal(lost.attempt.writingAssessment.status, 'in_progress');
    assert.equal(dispatches, 1);
    assert.equal((await repository.getEgeMockAttempt(
      owner, started.attempt.id, { now: new Date('2026-08-13T06:02:00.000Z') },
    )).writingAssessment.status, 'in_progress');

    const current = await (await request(owner, '/api/v1/ege-mocks/attempts/current')).json();
    const restored = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}`)).json();
    assert.equal(current.attempt.writingAssessment.status, 'in_progress');
    assert.equal(restored.attempt.writingAssessment.status, 'in_progress');
    assert.equal(dispatches, 1, 'safe restore GETs never claim or call a provider');

    const oral = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/oral/start`, {
        method: 'POST', idempotencyKey: '869524b8-d383-4477-b61b-fe2d221aa757',
        body: { expectedRevision: written.attempt.revision },
      })).json();
    const completedOral = await completeEgeMockOralStageLedger(repository, owner, oral);
    await request(owner, `/api/v1/ege-mocks/attempts/${started.attempt.id}/oral/submit`, {
      method: 'POST', idempotencyKey: '6021394b-7564-4cc3-9f19-b0491c48688d',
      body: { expectedRevision: completedOral.attempt.revision },
    });

    const pendingResult = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/result`)).json();
    assert.equal(pendingResult.result.writing.status, 'in_progress');
    assert.equal(dispatches, 1, 'safe result GET never reclaims the expired lease');

    const localValues = new Map();
    localValues.set(`easyboost-ege-mock-written-v1:${owner}:0`, JSON.stringify({
      version: 1, owner: { username: owner, generation: 0 }, phase: 'written_submitted',
      formIdentity: EGE_MOCK_FORM_1_V1_PUBLIC.identity,
      catalogFingerprint: EGE_MOCK_FORM_1_V1_PUBLIC.fingerprint,
      attemptId: started.attempt.id, attemptOwnerGeneration: lost.attempt.ownerGeneration,
      revision: lost.attempt.revision, policyId: lost.attempt.policyId,
      writtenStartedAt: lost.attempt.writtenStartedAt,
      writtenDeadlineAt: lost.attempt.writtenDeadlineAt,
      answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
      preflight: null, pendingStartId: null, saveStatus: 'queued', queue: [],
      compactedThrough: null, canceledSubmit: null,
      assessmentRetry: {
        action: 'run', idempotencyKey: runKey,
        createdAt: Date.parse('2026-08-13T06:03:00.000Z'),
        acknowledgePossibleProviderRepeat: false,
      },
      assessmentRetryThrough: null, assetBlockedAt: 0, assetReadyAt: 0,
      assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
      result: {
        kind: 'written_submission', state: lost.attempt.state,
        writingAssessment: lost.attempt.writingAssessment,
      },
    }));
    let runnerOnline = false;
    let browserRunResponse = null;
    let browserRunDeliveries = 0;
    const browserRunner = createEgeMockWrittenRunner({
      owner: { username: owner, generation: 0 },
      storage: {
        getItem(key) { return localValues.get(key) ?? null; },
        setItem(key, value) { localValues.set(key, String(value)); },
      },
      online: () => runnerOnline,
      clock: () => Date.parse('2026-08-13T06:07:00.000Z'),
      assets: {},
      transport: {
        async attempt(attemptId) {
          return (await request(owner, `/api/v1/ege-mocks/attempts/${attemptId}`)).json();
        },
        async runAssessment(input) {
          browserRunResponse = await (await request(owner,
            `/api/v1/ege-mocks/attempts/${input.attemptId}/assessment/run`, {
              method: 'POST', idempotencyKey: input.idempotencyKey, body: {},
            })).json();
          browserRunDeliveries += 1;
          if (browserRunDeliveries === 1) {
            return { ...browserRunResponse, applied: false, replayed: false };
          }
          return browserRunResponse;
        },
      },
    });
    assert.equal((await browserRunner.dispatch({
      type: 'restore', form: EGE_MOCK_FORM_1_V1_PUBLIC,
    })).assessmentRunQueued, true);
    runnerOnline = true;
    await assert.rejects(browserRunner.dispatch({ type: 'sync' }), {
      code: 'EGE_MOCK_ASSESSMENT_RESPONSE_INVALID',
    });
    const preservedAfterMalformedHttp200 = browserRunner.snapshot();
    assert.equal(preservedAfterMalformedHttp200.assessmentRunQueued, true);
    assert.equal(preservedAfterMalformedHttp200.result.writingAssessment.status, 'in_progress');
    const browserRecovered = await browserRunner.dispatch({ type: 'sync' });
    assert.equal(browserRecovered.assessmentRunQueued, false,
      'the real terminal run acknowledgement retires the durable browser command');
    assert.equal(browserRecovered.result.writingAssessment.status, 'completed');
    const recovered = browserRunResponse;
    assert.equal(dispatches, 2);
    assert.equal(recovered.applied, true);
    assert.equal(recovered.replayed, true);
    assert.equal(recovered.attempt.writingAssessment.status, 'completed');
    const exactReplay = await (await request(owner, runPath, {
      method: 'POST', idempotencyKey: runKey, body: {},
    })).json();
    assert.equal(dispatches, 2, 'a terminal exact command replay cannot dispatch again');
    assert.equal(exactReplay.replayed, true);
    assert.deepEqual(exactReplay.attempt, recovered.attempt,
      'terminal replay returns the immutable command snapshot');
    const conflictingReuse = await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/draft`, {
        method: 'PUT', idempotencyKey: runKey,
        body: { expectedRevision: recovered.attempt.revision, answers: {} },
      });
    assert.equal(conflictingReuse.status, 409);
    assert.equal((await conflictingReuse.json()).error.code, 'EGE_MOCK_IDEMPOTENCY_CONFLICT');
    const result = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/result`)).json();
    assert.equal(dispatches, 2);
    assert.equal(result.result.writing.status, 'completed');
    assert.equal(result.result.writing.score, 0);
  }, {
    writingAssessmentFactory: (repository) => {
      const service = createEgeMockWritingAssessmentService({
        repository,
        evaluator: async () => { throw new Error('provider must stay unused'); },
        uuid: () => '1fde8374-7a2d-47cc-9c41-aa29e8b65461',
        now: () => new Date('2026-08-13T06:07:00.000Z'),
      });
      return {
        async dispatch(username, attemptId) {
          dispatches += 1;
          if (dispatches === 1) {
            await repository.claimEgeMockWritingAssessment(username, attemptId, {
              claimToken: '8b6193fe-780f-4a9f-bc80-cf54fe7cf43f',
              now: new Date('2026-08-13T06:01:00.000Z'),
            });
            throw new Error('lost submit worker');
          }
          return service.dispatch(username, attemptId);
        },
      };
    },
  });
});

test('missing text consent is retryable without provider work and retry completes only unfinished writing', async () => {
  const evaluated = [];
  await withServer(async ({ owner, repository, request }) => {
    const formResponse = await (await request(owner, '/api/v1/ege-mocks/forms')).json();
    const started = await (await request(owner, '/api/v1/ege-mocks/attempts', {
      method: 'POST', idempotencyKey: '3cf0dcf5-4407-4115-8c53-5c61a058a15d',
      body: {
        formId: formResponse.forms[0].id, formRevision: formResponse.forms[0].revision,
        catalogFingerprint: formResponse.forms[0].fingerprint,
      },
    })).json();
    const saved = await (await request(owner, `/api/v1/ege-mocks/attempts/${started.attempt.id}/draft`, {
      method: 'PUT', idempotencyKey: '10f2f346-e53f-4ca5-a027-62e121dff703',
      body: {
        expectedRevision: 0,
        answers: { 37: writingWords(110, 'letter'), 38: writingWords(210, 'report') },
      },
    })).json();
    const unavailable = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/written/submit`, {
        method: 'POST', idempotencyKey: 'aa9c074b-e3e8-44db-b652-6194662522f5',
        body: { expectedRevision: saved.attempt.revision },
      })).json();
    assert.equal(unavailable.attempt.writingAssessment.status, 'pending');
    const assessed = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/assessment/run`, {
        method: 'POST', idempotencyKey: 'b8f5587a-96ee-480f-b951-e35791c9c1fb', body: {},
      })).json();
    assert.equal(assessed.attempt.writingAssessment.status, 'retryable');
    assert.equal(assessed.attempt.writingAssessment.retryAllowed, true);
    assert.deepEqual(evaluated, []);

    await repository.setPrivacyConsent(owner, {
      text_processing: true, voice_processing: false, policy_version: 'test-v1',
    });
    const retried = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/assessment/retry`, {
        method: 'POST', idempotencyKey: 'b05d9b75-9b7a-4daa-bdab-7438f6d6f88a', body: {},
      })).json();
    assert.equal(retried.attempt.writingAssessment.status, 'completed');
    assert.deepEqual(evaluated, [37, 38]);
  }, {
    writingAssessmentFactory: (repository) => createEgeMockWritingAssessmentService({
      repository,
      consentAuthority: createEgeMockWritingConsentAuthority({
        getPrivacyConsent: (username) => repository.getPrivacyConsent(username),
        policyVersion: 'test-v1',
      }),
      evaluator: async (item) => {
        evaluated.push(item.position);
        return {
          provider: 'fake-provider', model: 'fake-model',
          review: {
            words: item.scope.fullWords, in_range: true,
            overall_got: item.maximum, overall_max: item.maximum,
            verdict: 'Checked provisionally.', sub: 'Review the criterion evidence.',
            criteria: item.criteriaSnapshot.map(({ name, maximum }) => ({ name, got: maximum, max: maximum })),
            errors: [],
          },
        };
      },
      uuid: (() => { let value = 0; return () => `71c154b5-f9aa-47e9-8000-${String(++value).padStart(12, '0')}`; })(),
      now: () => new Date('2026-08-13T06:02:00.000Z'),
    }),
  });
});

test('EGE mock HTTP lifecycle is answer-free, owner-bound and restores exact authority', async () => {
  await withServer(async ({ owner, other, repository, request }) => {
    const formsResponse = await request(owner, '/api/v1/ege-mocks/forms');
    assert.equal(formsResponse.status, 200);
    const forms = await formsResponse.json();
    assert.equal(forms.forms.length, 1);
    assert.equal(forms.forms[0].identity, 'ege-en-2026-form-1@1');
    assert.deepEqual(forms.forms[0].attemptPolicy, {
      id: 'ege-mock-attempt-policy-v1', writtenMinutes: 190,
      oralStartWindowDays: 30, oralMinutes: 17,
    });
    assert.deepEqual(
      objectKeys(forms).filter((key) => ['accepted', 'criteriaRef', 'contentRef', 'assessment'].includes(key)),
      [],
    );

    const startKey = '1ed47a04-75fc-4917-adcb-e6f65a534308';
    const startedResponse = await request(owner, '/api/v1/ege-mocks/attempts', {
      method: 'POST', idempotencyKey: startKey,
      body: { formId: forms.forms[0].id, formRevision: 1, catalogFingerprint: forms.forms[0].fingerprint },
    });
    assert.equal(startedResponse.status, 201);
    const started = await startedResponse.json();
    assert.equal(started.attempt.state, 'written_in_progress');
    assert.equal(started.attempt.policyId, forms.forms[0].attemptPolicy.id);
    assert.equal((await request(owner, `/api/v1/ege-mocks/attempts/${started.attempt.id}`, {
      expectedOwner: other,
    })).status, 409);
    assert.equal((await request(other, `/api/v1/ege-mocks/attempts/${started.attempt.id}`)).status, 404);
    const current = await (await request(owner, '/api/v1/ege-mocks/attempts/current')).json();
    assert.equal(current.attempt.id, started.attempt.id);

    const draftKey = 'e0f7c38c-1fea-4d7b-bcfb-e23b2662ab84';
    const savedResponse = await request(owner, `/api/v1/ege-mocks/attempts/${started.attempt.id}/draft`, {
      method: 'PUT', idempotencyKey: draftKey,
      body: { expectedRevision: 0, answers: { 19: 'went' } },
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json();
    assert.equal(saved.attempt.revision, 1);
    const stale = await request(owner, `/api/v1/ege-mocks/attempts/${started.attempt.id}/draft`, {
      method: 'PUT', idempotencyKey: 'd0fda69f-24c0-4085-b484-f669bd887a70',
      body: { expectedRevision: 0, answers: { 19: 'gone' } },
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'EGE_MOCK_REVISION_CONFLICT');

    const written = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/written/submit`, {
        method: 'POST', idempotencyKey: '59f04f66-11bc-41d3-a364-3196715e43b7',
        body: { expectedRevision: saved.attempt.revision },
      })).json();
    assert.equal(written.attempt.state, 'oral_ready');
    assert.deepEqual(written.receipt.orderedPositions, Array.from({ length: 38 }, (_, index) => index + 1));
    const oral = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/oral/start`, {
        method: 'POST', idempotencyKey: 'c58b11db-8b8a-4fbb-8706-c799cfd7b89e',
        body: { expectedRevision: written.attempt.revision },
      })).json();
    assert.equal(oral.attempt.state, 'oral_in_progress');
    assert.deepEqual(await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/result`)).json(), {
      available: false, state: 'oral_in_progress', keysRevealed: false,
      writingAssessment: oral.attempt.writingAssessment,
    });
    const completedOral = await completeEgeMockOralStageLedger(repository, owner, oral);
    const oralSubmit = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/oral/submit`, {
        method: 'POST', idempotencyKey: 'a54bb188-2489-4d6c-b8b4-d900102a6f86',
        body: { expectedRevision: completedOral.attempt.revision },
      })).json();
    assert.equal(oralSubmit.attempt.state, 'assessment_pending');
    const result = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/result`)).json();
    assert.equal(result.available, true);
    assert.equal(result.keysRevealed, true);
    assert.deepEqual(objectKeys(result).filter((key) => (
      ['accepted', 'criteriaRef', 'contentRef'].includes(key)
    )), []);
    assert.equal((await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/assessment/retry`, {
        method: 'POST', idempotencyKey: '9306517d-03a2-416c-85f1-3d3a4b3206af', body: {},
      })).status, 409);
    await repository.markEgeMockAssessmentRetryable(owner, started.attempt.id, {
      reason: 'provider_unavailable', now: new Date('2026-08-13T07:00:00.000Z'),
    });
    const retried = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/assessment/retry`, {
        method: 'POST', idempotencyKey: '5f066b94-a4f5-46e4-9631-cf5b938beb1d', body: {},
      })).json();
    assert.equal(retried.attempt.assessment.status, 'pending');
  });
});

test('EGE mock HTTP samples file timer authority after its queued owner boundary', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-queued-clock-'));
  const filePath = path.join(directory, 'data.json');
  const seed = createFileRepository(filePath);
  const { username } = await seed.grantDays(9_270_021, 30, 'Mock queued clock');
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const started = await seed.startEgeMockAttempt(username, {
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    idempotencyKey: '1a8dfb82-cc59-48a8-ac94-923515360719', requestHash: 'a'.repeat(64),
  }, { now: new Date('2026-08-13T06:00:00.000Z') });
  await seed.close();

  const originalReadFile = fs.readFile;
  let releaseRead;
  const readReleased = new Promise((resolve) => { releaseRead = resolve; });
  let announceBlocked;
  const readBlocked = new Promise((resolve) => { announceBlocked = resolve; });
  let blockedOnce = false;
  fs.readFile = async (target, ...args) => {
    if (!blockedOnce && path.resolve(String(target)) === path.resolve(filePath)) {
      blockedOnce = true;
      announceBlocked();
      await readReleased;
    }
    return originalReadFile.call(fs, target, ...args);
  };

  const repository = createFileRepository(filePath);
  let clock = new Date('2026-08-13T06:01:00.000Z');
  let announceDraft;
  const draftArrived = new Promise((resolve) => { announceDraft = resolve; });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.method === 'PUT' && req.path.endsWith('/draft')) announceDraft();
    next();
  });
  app.use(createEgeMockRoutes({
    authentication: { auth(req, _res, next) { req.user = req.get('x-test-user'); next(); } },
    access: { requireActiveSubscription(_req, _res, next) { next(); } },
    db: repository,
    now: () => clock,
  }));
  app.use((error, _req, res, _next) => res.status(500).json({ error: { code: error.code || 'ERROR' } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const headers = {
    'content-type': 'application/json',
    'x-test-user': username,
    'x-easyboost-expected-owner': username,
  };
  const base = `http://127.0.0.1:${server.address().port}/api/v1/ege-mocks`;
  try {
    const currentRequest = fetch(`${base}/attempts/current`, { headers });
    await readBlocked;
    const draftRequest = fetch(`${base}/attempts/${started.attempt.id}/draft`, {
      method: 'PUT',
      headers: { ...headers, 'idempotency-key': '939c5c4e-f8eb-4899-b35e-df9952743b98' },
      body: JSON.stringify({ expectedRevision: 0, answers: { 19: 'late in queue' } }),
    });
    await draftArrived;
    await new Promise((resolve) => setImmediate(resolve));
    clock = new Date(started.attempt.writtenDeadlineAt);
    releaseRead();

    assert.equal((await currentRequest).status, 200);
    const rejected = await draftRequest;
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error.code, 'EGE_MOCK_WRITTEN_CLOSED');
  } finally {
    releaseRead();
    fs.readFile = originalReadFile;
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('written browser queue reconciles real HTTP auto-submit after an offline deadline', async () => {
  await withServer(async ({ owner, request, setNow }) => {
    let online = true;
    let id = 0;
    async function payload(response) {
      const body = await response.json();
      if (response.ok) return body;
      throw Object.assign(new Error(body.error?.code || 'HTTP_ERROR'), {
        code: body.error?.code || 'HTTP_ERROR', status: response.status,
      });
    }
    const transport = {
      async attempt(attemptId) {
        return payload(await request(owner, `/api/v1/ege-mocks/attempts/${attemptId}`));
      },
      async current() { return payload(await request(owner, '/api/v1/ege-mocks/attempts/current')); },
      async start(input) {
        return payload(await request(owner, '/api/v1/ege-mocks/attempts', {
          method: 'POST', idempotencyKey: input.idempotencyKey,
          body: {
            formId: input.formId, formRevision: input.formRevision,
            catalogFingerprint: input.catalogFingerprint,
          },
        }));
      },
      async saveDraft(input) {
        return payload(await request(owner, `/api/v1/ege-mocks/attempts/${input.attemptId}/draft`, {
          method: 'PUT', idempotencyKey: input.idempotencyKey,
          body: { expectedRevision: input.expectedRevision, answers: input.answers },
        }));
      },
      async submitWritten(input) {
        return payload(await request(owner, `/api/v1/ege-mocks/attempts/${input.attemptId}/written/submit`, {
          method: 'POST', idempotencyKey: input.idempotencyKey,
          body: { expectedRevision: input.expectedRevision },
        }));
      },
    };
    const values = new Map();
    const runner = createEgeMockWrittenRunner({
      owner: { username: owner, generation: 0 },
      storage: {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
      },
      online: () => online,
      clock: () => Date.parse(online ? '2026-08-13T09:10:00.000Z' : '2026-08-13T08:50:00.000Z'),
      uuid: () => `c0000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      assets: { async preflight() { return {
        identity: EGE_MOCK_FORM_1_V1_PUBLIC.identity,
        fingerprint: EGE_MOCK_FORM_1_V1_PUBLIC.fingerprint,
        assetCount: 20,
      }; } },
      transport,
    });
    await runner.dispatch({ type: 'prepare', form: EGE_MOCK_FORM_1_V1_PUBLIC });
    await runner.dispatch({ type: 'start' });
    online = false;
    await runner.dispatch({ type: 'answer', position: 19, answer: 'went offline' });
    setNow(runner.snapshot().writtenDeadlineAt);
    online = true;

    await runner.dispatch({ type: 'sync' });
    const snapshot = runner.snapshot();
    assert.equal(snapshot.phase, 'written_submitted');
    assert.equal(snapshot.result.offlineChangesNotAccepted, true);
    assert.equal(snapshot.answers['19'], undefined);
    assert.equal(snapshot.blankPositions.length, 36);
    const current = await transport.current();
    assert.equal(current.attempt.state, 'oral_ready');
    setNow(current.attempt.oralAvailableUntil);
    assert.equal((await transport.current()).attempt, null);
    const afterOralWindow = createEgeMockWrittenRunner({
      owner: { username: owner, generation: 0 },
      storage: {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); },
      },
      online: () => true,
      assets: {},
      transport,
    });
    await afterOralWindow.dispatch({ type: 'restore', form: EGE_MOCK_FORM_1_V1_PUBLIC });
    assert.equal(afterOralWindow.snapshot().phase, 'written_submitted');
    assert.equal(afterOralWindow.snapshot().result.state, 'expired');
  });
});

test('EGE mock executable OpenAPI matches runtime forms, attempts and strict mutations', async () => {
  const specification = await fs.readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(specification, /type:\s*['"]?null['"]?/u,
    'OpenAPI 3.0 schemas must express null through nullable instead of type: null');
  for (const endpoint of [
    '/api/v1/ege-mocks/forms:', '/api/v1/ege-mocks/attempts:',
    '/api/v1/ege-mocks/attempts/current:', '/api/v1/ege-mocks/attempts/{attemptId}:',
    '/api/v1/ege-mocks/attempts/{attemptId}/draft:',
    '/api/v1/ege-mocks/attempts/{attemptId}/written/submit:',
    '/api/v1/ege-mocks/attempts/{attemptId}/oral/start:',
    '/api/v1/ege-mocks/attempts/{attemptId}/oral/submit:',
    '/api/v1/ege-mocks/attempts/{attemptId}/assessment/run:',
    '/api/v1/ege-mocks/attempts/{attemptId}/assessment/retry:',
    '/api/v1/ege-mocks/attempts/{attemptId}/result:',
  ]) assert.match(specification, new RegExp(endpoint.replace(/[{}]/gu, '\\$&'), 'u'));

  const start = compileOpenApiSchema(specification, 'EgeMockStartRequest');
  assert.equal(start({
    formId: 'ege-en-2026-form-1', formRevision: 1,
    catalogFingerprint: `sha256:${'a'.repeat(64)}`,
  }), true);
  assert.equal(start({
    formId: 'ege-en-2026-form-1', formRevision: 1,
    catalogFingerprint: `sha256:${'a'.repeat(64)}`, mode: 'training',
  }), false);
  const draft = compileOpenApiSchema(specification, 'EgeMockDraftRequest');
  assert.equal(draft({ expectedRevision: 0, answers: { 19: 'went' } }), true);
  assert.equal(draft({ expectedRevision: 0, answers: { 19: null } }), true,
    JSON.stringify(draft.errors));
  assert.equal(draft({ expectedRevision: 0, answers: { 19: false } }), false);
  assert.equal(draft({ expectedRevision: 0, answers: { 19: {} } }), false);
  assert.equal(draft({ expectedRevision: 0, answers: { 39: 'forbidden' } }), false);
  assert.equal(draft({ expectedRevision: 0, answers: { 37: ['not writing'] } }), false);
  assert.equal(draft({ expectedRevision: 0, answers: { 37: 'x'.repeat(12_001) } }), false);
  assert.equal(draft({ expectedRevision: 0, answers: { 38: 'x'.repeat(20_000) } }), true,
    JSON.stringify(draft.errors));
  const form = compileOpenApiSchema(specification, 'EgeMockPublicForm');
  const catalog = await import('../ege-mock/catalog.js');
  const { egeMockPublicFormWithPolicy } = await import('../ege-mock/policy.js');
  const runtimeForm = egeMockPublicFormWithPolicy(catalog.getEgeMockPublicForm(
    'ege-en-2026-form-1', 1,
  ));
  assert.equal(form(runtimeForm), true, JSON.stringify(form.errors));
  const attempt = egeMockAttemptPublicDto(createEgeMockAttempt({
    id: 'aab67ae4-c5a5-45d2-8536-0706339a38b1', username: 'owner',
    ownerGeneration: 'account:2026-08-13T06:00:00.000Z',
    form: catalog.getEgeMockForm('ege-en-2026-form-1', 1), mode: 'diagnostic',
    attemptNumber: 1, idempotencyKey: 'd2baad38-72b4-4c4e-814b-7020b03a8481',
    requestHash: 'a'.repeat(64), now: new Date('2026-08-13T06:00:00.000Z'),
  }));
  const attemptSchema = compileOpenApiSchema(specification, 'EgeMockAttempt');
  const oralSubmitSchema = compileOpenApiSchema(specification, 'EgeMockOralSubmitRequest');
  assert.equal(oralSubmitSchema({ expectedRevision: 12 }), true,
    JSON.stringify(oralSubmitSchema.errors));
  assert.equal(oralSubmitSchema({ expectedRevision: 12, recordings: {} }), false,
    'candidate recordings cannot bypass the server-owned oral stage ledger');
  const oralStageSchema = compileOpenApiSchema(specification, 'EgeMockOralStageRequest');
  assert.equal(oralStageSchema({
    action: 'advance', expectedRevision: 12, position: 39, responseNumber: 1,
  }), true, JSON.stringify(oralStageSchema.errors));
  assert.equal(oralStageSchema({
    action: 'advance', expectedRevision: 12, position: 39, responseNumber: 1,
    observedAt: '2026-08-15T06:00:10.000Z',
  }), false, 'client time is never accepted as oral deadline authority');
  assert.equal(oralStageSchema({
    action: 'complete', expectedRevision: 12, position: 39, responseNumber: 5,
    recording: {
      recordingId: '6d0e8916-ec2a-4a13-98f7-ad692d31acc8',
      status: 'completed', durationSeconds: 180, sha256: 'b'.repeat(64),
    },
  }), false, 'task 39 accepts only response 1 and its exact 90-second ceiling');
  const oralRecordingSchema = compileOpenApiSchema(
    specification, 'EgeMockBoundOralRecording',
  );
  const boundRecording = {
    schemaVersion: 'ege-mock-oral-recording-v1',
    recordingId: '6d0e8916-ec2a-4a13-98f7-ad692d31acc8',
    ownerGeneration: 'account:2026-08-15T00:00:00.000Z',
    attemptId: 'aab67ae4-c5a5-45d2-8536-0706339a38b1',
    formId: 'ege-en-2026-form-1', formRevision: 1,
    catalogFingerprint: `sha256:${'a'.repeat(64)}`,
    position: 39, taskType: 1, responseNumber: 1,
    status: 'completed', durationSeconds: 90, sha256: 'b'.repeat(64),
    stageStartedAt: '2026-08-15T06:01:40.000Z',
    stageDeadlineAt: '2026-08-15T06:03:10.000Z', completedAt: '2026-08-15T06:03:10.000Z',
  };
  assert.equal(oralRecordingSchema(boundRecording), true, JSON.stringify(oralRecordingSchema.errors));
  for (const invalidRecording of [
    { ...boundRecording, sha256: null },
    { ...boundRecording, technicalIssueCode: 'response_timeout' },
    { ...boundRecording, position: 40, taskType: 1 },
    { ...boundRecording, position: 39, responseNumber: 2 },
    { ...boundRecording, position: 40, taskType: 2, responseNumber: 1, durationSeconds: 21 },
    { ...boundRecording, status: 'technical_issue', durationSeconds: 0, sha256: null },
    { ...boundRecording, status: 'skipped', durationSeconds: 1, sha256: null },
  ]) assert.equal(oralRecordingSchema(invalidRecording), false,
    `OpenAPI accepted impossible oral recording ${JSON.stringify(invalidRecording)}`);
  assert.equal(oralRecordingSchema({
    ...boundRecording, status: 'technical_issue', durationSeconds: 0, sha256: null,
    technicalIssueCode: 'response_timeout',
  }), true, JSON.stringify(oralRecordingSchema.errors));
  const oralProgressSchema = compileOpenApiSchema(specification, 'EgeMockOralProgress');
  const completeLedger = {};
  for (const [position, responseCount] of [[39, 1], [40, 4], [41, 5], [42, 1]]) {
    for (let responseNumber = 1; responseNumber <= responseCount; responseNumber += 1) {
      completeLedger[`${position}:${responseNumber}`] = {
        ...boundRecording,
        recordingId: crypto.randomUUID(), position, taskType: position - 38, responseNumber,
        durationSeconds: { 39: 90, 40: 20, 41: 40, 42: 180 }[position],
      };
    }
  }
  assert.equal(oralProgressSchema({
    schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
    phase: 'ready_to_submit', stageStartedAt: null, stageDeadlineAt: null,
    recordings: completeLedger,
  }), true, JSON.stringify(oralProgressSchema.errors));
  assert.equal(oralProgressSchema({
    schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
    phase: 'ready_to_submit', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
  }), false, 'ready_to_submit requires the exact immutable eleven-response ledger');
  assert.equal(oralProgressSchema({
    schemaVersion: 'ege-mock-oral-progress-v1', position: 39, responseNumber: 5,
    phase: 'ready', stageStartedAt: null, stageDeadlineAt: null, recordings: {},
  }), false, 'the response cursor is bounded by its exact task');
  assert.equal(oralProgressSchema({
    schemaVersion: 'ege-mock-oral-progress-v1', position: 41, responseNumber: 1,
    phase: 'preparing', stageStartedAt: '2026-08-15T06:10:00.000Z',
    stageDeadlineAt: '2026-08-15T06:10:01.000Z', recordings: {},
  }), false, 'task 41 has no preparation stage');
  assert.equal(oralProgressSchema({
    schemaVersion: 'ege-mock-oral-progress-v1', position: 40, responseNumber: 1,
    phase: 'ready', stageStartedAt: '2026-08-15T06:10:00.000Z',
    stageDeadlineAt: null, recordings: {},
  }), false, 'ready has no active stage timestamps');
  assert.equal(oralProgressSchema({
    schemaVersion: 'ege-mock-oral-progress-v1', position: 40, responseNumber: 2,
    phase: 'ready', stageStartedAt: null, stageDeadlineAt: null,
    recordings: {
      '39:1': completeLedger['39:1'],
      '40:1': completeLedger['40:1'],
      '40:2': completeLedger['40:2'],
    },
  }), false, 'a nonterminal cursor cannot carry future response evidence');
  assert.equal(oralProgressSchema({
    schemaVersion: 'ege-mock-oral-progress-v1', position: 40, responseNumber: 2,
    phase: 'ready', stageStartedAt: null, stageDeadlineAt: null,
    recordings: { '39:1': completeLedger['39:1'] },
  }), false, 'a nonterminal cursor requires every exact prior response');
  assert.equal(oralProgressSchema({
    schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
    phase: 'ready_to_submit', stageStartedAt: null, stageDeadlineAt: null,
    recordings: {
      ...completeLedger,
      '39:1': { ...completeLedger['39:1'], position: 40, taskType: 2 },
    },
  }), false, 'each exact ledger key is bound to the same position, task and response');
  const automaticAssessment = compileOpenApiSchema(
    specification, 'SpeakingAutomaticAssessment',
  );
  assert.equal(automaticAssessment({
    mode: 'experimental', scoreKind: 'approximate', methodicallyValidated: false,
    warning: AUTOMATIC_ASSESSMENT_WARNING, scoringVersion: 'speaking-fipi-combiner-v2',
  }), true, JSON.stringify(automaticAssessment.errors));
  const fullAutomaticAssessment = compileOpenApiSchema(
    specification, 'SpeakingFullAutomaticAssessment',
  );
  assert.equal(fullAutomaticAssessment({
    available: true, status: 'needs_retry', mode: 'experimental', scoreKind: 'approximate',
    methodicallyValidated: false, scoringVersion: 'speaking-fipi-combiner-v2',
    warning: AUTOMATIC_ASSESSMENT_WARNING, reason: 'evidence_needs_retry',
    message: 'Запись недоступна для автоматической оценки.',
    evaluatedAt: '2026-08-15T06:17:00.000Z',
  }), true, JSON.stringify(fullAutomaticAssessment.errors));
  const fullProgressResponse = compileOpenApiSchema(
    specification, 'SpeakingFullProgressResponse',
  );
  assert.equal(fullProgressResponse({
    responseNumber: 1, status: 'technical_issue', recordingDurationSeconds: 0,
    micCheck: 'quiet', localPlayback: false, technicalIssueCode: 'oral_deadline_elapsed',
    completedAt: '2026-08-15T06:17:00.000Z',
  }), true, JSON.stringify(fullProgressResponse.errors));
  const speakingStateSchema = compileOpenApiSchema(
    specification, 'EgeMockSpeakingAssessmentState',
  );
  const speakingState = {
    status: 'completed', mode: 'experimental', scoreKind: 'approximate',
    warning: AUTOMATIC_ASSESSMENT_WARNING, label: 'Предварительная автоматическая оценка',
    retryAllowed: false, retryCount: 0,
    items: {
      39: { position: 39, maximum: 1, status: 'completed', score: 1, mode: 'experimental', scoreKind: 'approximate' },
      40: { position: 40, maximum: 4, status: 'completed', score: 4, mode: 'experimental', scoreKind: 'approximate' },
      41: { position: 41, maximum: 5, status: 'completed', score: 5, mode: 'experimental', scoreKind: 'approximate' },
      42: { position: 42, maximum: 10, status: 'completed', score: 10, mode: 'experimental', scoreKind: 'approximate' },
    },
  };
  assert.equal(speakingStateSchema(speakingState), true,
    JSON.stringify(speakingStateSchema.errors));
  assert.equal(speakingStateSchema({
    ...speakingState,
    items: { ...speakingState.items, 39: { ...speakingState.items[39], maximum: 10 } },
  }), false, 'task 39 is structurally capped at one point');
  assert.equal(speakingStateSchema({
    ...speakingState,
    items: { ...speakingState.items, 40: { ...speakingState.items[40], score: 5 } },
  }), false, 'task 40 cannot expose a score above its exact four-point maximum');
  assert.equal(speakingStateSchema({
    ...speakingState,
    items: { ...speakingState.items, 42: { ...speakingState.items[42], position: 41 } },
  }), false, 'each keyed oral assessment item carries the same exact position');
  const pendingSpeakingItems = Object.fromEntries(Object.entries(speakingState.items).map(
    ([position, item]) => [position, { ...item, status: 'pending', score: null }],
  ));
  const pendingSpeakingState = {
    ...speakingState, status: 'pending', retryAllowed: false, items: pendingSpeakingItems,
  };
  assert.equal(speakingStateSchema({
    ...speakingState, retryAllowed: true, items: pendingSpeakingItems,
  }), false, 'completed speaking assessment requires four completed scores and is never retryable');
  const writingStateSchema = compileOpenApiSchema(specification, 'EgeMockWritingAssessmentState');
  const completedWritingState = {
    status: 'completed', assessmentRevision: 7,
    mode: 'experimental', scoreKind: 'approximate',
    warning: AUTOMATIC_ASSESSMENT_WARNING, label: 'Предварительная автоматическая оценка',
    retryAllowed: false, retryCount: 0,
  };
  assert.equal(writingStateSchema(completedWritingState), true,
    JSON.stringify(writingStateSchema.errors));
  assert.equal(writingStateSchema({
    ...completedWritingState, assessmentRevision: undefined,
  }), false, 'every public writing-assessment state requires its monotonic revision');
  assert.equal(writingStateSchema({
    ...completedWritingState, assessmentRevision: Number.MAX_SAFE_INTEGER,
  }), true, JSON.stringify(writingStateSchema.errors));
  assert.equal(writingStateSchema({
    ...completedWritingState, assessmentRevision: Number.MAX_SAFE_INTEGER + 1,
  }), false, 'the public assessment revision cannot exceed JavaScript safe-integer authority');
  assert.equal(writingStateSchema({ ...completedWritingState, retryAllowed: true }), false,
    'a completed assessment is terminal and cannot advertise retry');
  assert.equal(writingStateSchema({ ...completedWritingState, retryWarning: 'stale warning' }), false,
    'a completed assessment cannot carry an ambiguous-retry warning');
  const ambiguousWritingState = {
    ...completedWritingState, status: 'ambiguous', retryAllowed: true, retryCount: 1,
    retryWarning: EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
  };
  assert.equal(writingStateSchema(ambiguousWritingState), true,
    JSON.stringify(writingStateSchema.errors));
  assert.equal(writingStateSchema({ ...ambiguousWritingState, retryWarning: 'invented warning' }), false,
    'the ambiguous state requires the exact runtime warning');
  assert.equal(writingStateSchema({
    ...ambiguousWritingState, retryWarning: undefined,
  }), false, 'the ambiguous state always carries the warning that explains manual acknowledgement');
  const subscriptionBlockedWritingState = {
    ...completedWritingState, status: 'pending',
    runDisposition: 'subscription_required',
  };
  assert.equal(writingStateSchema(subscriptionBlockedWritingState), true,
    JSON.stringify(writingStateSchema.errors));
  assert.equal(writingStateSchema({
    ...subscriptionBlockedWritingState, runDisposition: 'invented_disposition',
  }), false, 'only the canonical durable assessment-run disposition is public');
  const assessmentRunResponse = compileOpenApiSchema(
    specification, 'EgeMockAssessmentRunResponse',
  );
  const pendingRunAttempt = {
    ...attempt,
    state: 'oral_ready',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z',
    oralAvailableUntil: '2026-09-12T06:20:00.000Z',
    writingAssessment: { ...completedWritingState, status: 'in_progress' },
  };
  const completedRunAttempt = {
    ...pendingRunAttempt,
    writingAssessment: completedWritingState,
  };
  assert.equal(assessmentRunResponse({
    applied: false, replayed: false, attempt: pendingRunAttempt,
  }), true, JSON.stringify(assessmentRunResponse.errors));
  assert.equal(assessmentRunResponse({
    applied: true, replayed: false, attempt: pendingRunAttempt,
  }), false, 'a nonterminal command is never acknowledged as applied');
  assert.equal(assessmentRunResponse({
    applied: true, replayed: false, attempt: completedRunAttempt,
  }), true, JSON.stringify(assessmentRunResponse.errors));
  assert.equal(assessmentRunResponse({
    applied: true, replayed: true, attempt: completedRunAttempt,
  }), true, JSON.stringify(assessmentRunResponse.errors));
  assert.equal(assessmentRunResponse({
    applied: false, replayed: true, attempt: completedRunAttempt,
  }), false, 'an exact replay preserves the original applied=true acknowledgement');
  assert.equal(assessmentRunResponse({
    applied: false, replayed: false, attempt: completedRunAttempt,
  }), false, 'a terminal disposition must be applied or an exact replay');
  assert.equal(assessmentRunResponse({
    applied: true, replayed: false, disposition: 'subscription_required',
    attempt: { ...pendingRunAttempt, writingAssessment: subscriptionBlockedWritingState },
  }), true, JSON.stringify(assessmentRunResponse.errors));
  assert.equal(assessmentRunResponse({
    applied: true, replayed: true, disposition: 'subscription_required',
    attempt: { ...pendingRunAttempt, writingAssessment: subscriptionBlockedWritingState },
  }), true, JSON.stringify(assessmentRunResponse.errors));
  assert.equal(assessmentRunResponse({
    applied: false, replayed: true, disposition: 'subscription_required',
    attempt: { ...pendingRunAttempt, writingAssessment: subscriptionBlockedWritingState },
  }), false, 'a subscription replay also preserves its applied acknowledgement');
  assert.equal(assessmentRunResponse({
    applied: true, replayed: false, disposition: 'subscription_required',
    attempt: { ...pendingRunAttempt, writingAssessment: { ...completedWritingState, status: 'pending' } },
  }), false, 'the terminal subscription response must carry its authoritative attempt disposition');
  assert.equal(assessmentRunResponse({
    applied: false, replayed: false,
    attempt: { ...pendingRunAttempt, writingAssessment: subscriptionBlockedWritingState },
  }), false, 'a nonterminal response cannot hide a nested terminal subscription disposition');
  assert.equal(attemptSchema(attempt), true, JSON.stringify(attemptSchema.errors));
  assert.equal(attemptSchema({
    ...attempt, state: 'oral_in_progress',
    oralStartedAt: '2026-08-13T06:20:00.000Z', oralDeadlineAt: '2026-08-13T06:37:00.000Z',
  }), false, 'oral_in_progress always carries its authoritative oral progress projection');
  const completedAttempt = {
    ...attempt,
    state: 'completed',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z',
    oralAvailableUntil: '2026-09-12T06:20:00.000Z',
    oralStartedAt: '2026-08-13T06:20:00.000Z',
    oralDeadlineAt: '2026-08-13T06:37:00.000Z',
    oralSubmittedAt: '2026-08-13T06:37:00.000Z',
    oralProgress: {
      schemaVersion: 'ege-mock-oral-progress-v1', position: 42, responseNumber: 1,
      phase: 'ready_to_submit', stageStartedAt: null, stageDeadlineAt: null,
      recordings: completeLedger,
    },
    assessment: { status: 'completed', retryAllowed: false, retryCount: 0 },
    writingAssessment: completedWritingState,
    speakingAssessment: speakingState,
  };
  assert.equal(attemptSchema(completedAttempt), true, JSON.stringify(attemptSchema.errors));
  assert.equal(attemptSchema({
    ...completedAttempt, speakingAssessment: pendingSpeakingState,
  }), false, 'a completed attempt requires terminal writing and speaking assessments');
  const nullableAttemptSchema = compileOpenApiSchema(specification, 'EgeMockNullableAttempt');
  assert.equal(nullableAttemptSchema(null), true, JSON.stringify(nullableAttemptSchema.errors));
  assert.equal(nullableAttemptSchema(attempt), true, JSON.stringify(nullableAttemptSchema.errors));
  assert.equal(nullableAttemptSchema({}), false);
  const startResponse = compileOpenApiSchema(specification, 'EgeMockStartResponse');
  assert.equal(startResponse({ created: true, replayed: false, attempt }), true,
    JSON.stringify(startResponse.errors));
  const result = compileOpenApiSchema(specification, 'EgeMockResult');
  assert.equal(result({
    available: false, state: 'written_in_progress', keysRevealed: false,
    writingAssessment: { ...completedWritingState, status: 'not_started' },
  }), true,
    JSON.stringify(result.errors));
  assert.equal(result({
    available: false, state: 'oral_ready', keysRevealed: false,
    writingAssessment: subscriptionBlockedWritingState,
    assessmentRunDisposition: 'subscription_required',
  }), true, JSON.stringify(result.errors));
  assert.equal(result({
    available: false, state: 'oral_ready', keysRevealed: false,
    writingAssessment: subscriptionBlockedWritingState,
  }), false, 'a blocked unavailable result must expose its durable subscription disposition');
  assert.equal(result({
    available: false, state: 'oral_ready', keysRevealed: false,
    writingAssessment: { ...completedWritingState, status: 'not_started' },
    assessmentRunDisposition: 'subscription_required',
  }), false, 'an unblocked unavailable result must not invent a subscription disposition');
  assert.equal(result({
    available: false, state: 'oral_ready', keysRevealed: false,
    writingAssessment: subscriptionBlockedWritingState,
    assessmentRunDisposition: 'invented_disposition',
  }), false, 'safe result projection only exposes the canonical durable disposition');
  assert.equal(result({
    available: true, state: 'assessment_pending', keysRevealed: true,
    writingAssessment: { ...completedWritingState, status: 'not_started' },
    speakingAssessment: pendingSpeakingState,
    assessment: { status: 'pending', retryAllowed: false, retryCount: 0 }, result: null,
  }), true, JSON.stringify(result.errors));
  assert.equal(result({
    available: true, state: 'assessment_pending', keysRevealed: true,
    writingAssessment: { ...completedWritingState, status: 'not_started' },
    assessment: { status: 'not_started', retryAllowed: false, retryCount: 0 }, result: null,
  }), false, 'an available oral result always includes its provisional speaking state');
  assert.equal(result({
    available: true, state: 'assessment_pending', keysRevealed: true,
    writingAssessment: subscriptionBlockedWritingState,
    assessment: { status: 'pending', retryAllowed: false, retryCount: 0 }, result: null,
  }), false, 'a blocked available result must expose its durable subscription disposition');
  assert.equal(result({
    available: true, state: 'assessment_pending', keysRevealed: true,
    writingAssessment: { ...completedWritingState, status: 'not_started' },
    assessmentRunDisposition: 'subscription_required',
    assessment: { status: 'not_started', retryAllowed: false, retryCount: 0 }, result: null,
  }), false, 'an unblocked available result must not invent a subscription disposition');
  const writingResult = egeMockWritingResultPublicDto({
    writing_assessment: {
      status: 'completed', assessment_revision: 7,
      items: [
        {
          position: 37, status: 'completed', maximum: 6,
          criteria_ref: 'writing-ege-2026-task37-v1',
          criteria_fingerprint: 'sha256:a64921436b50ba9a9578cb73d7639ca3035f98174ffb2d2c616530de9da9b5f2',
          scope: { fullWords: 110, evaluatedWords: 110, truncated: false, evaluatedLimit: 140 },
          review: {
            overall_got: 6, verdict: 'Good', sub: 'Keep reviewing.', errors: [],
            criteria: [
              { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
              { name: 'Организация текста', got: 2, max: 2 },
              { name: 'Языковое оформление', got: 2, max: 2 },
            ],
          },
        },
        {
          position: 38, status: 'completed', maximum: 14,
          criteria_ref: 'writing-ege-2026-task38-v1',
          criteria_fingerprint: 'sha256:dac7eea22d6ec506444c764ac348fb9ddc982048d8b43d951f86bb7c986b0171',
          scope: { fullWords: 210, evaluatedWords: 210, truncated: false, evaluatedLimit: 250 },
          review: {
            overall_got: 14, verdict: 'Good', sub: 'Keep reviewing.', errors: [],
            criteria: [
              { name: 'Решение коммуникативной задачи', got: 3, max: 3 },
              { name: 'Организация текста', got: 3, max: 3 },
              { name: 'Лексика', got: 3, max: 3 },
              { name: 'Грамматика', got: 3, max: 3 },
              { name: 'Орфография и пунктуация', got: 2, max: 2 },
            ],
          },
        },
      ],
    },
  });
  assert.equal(writingResult.assessmentRevision, 7);
  assert.equal(result({
    available: true, state: 'assessment_pending', keysRevealed: true,
    writingAssessment: completedWritingState,
    speakingAssessment: pendingSpeakingState,
    assessment: { status: 'pending', retryAllowed: false, retryCount: 0 },
    result: {
      writing: writingResult,
      speaking: { ...pendingSpeakingState, score: null, maximum: 20 },
    },
  }), true, JSON.stringify(result.errors));
  const completedSpeakingResult = { ...speakingState, score: 20, maximum: 20 };
  assert.equal(result({
    available: true, state: 'completed', keysRevealed: true,
    writingAssessment: completedWritingState,
    speakingAssessment: speakingState,
    assessment: { status: 'completed', retryAllowed: false, retryCount: 0 },
    result: { writing: writingResult, speaking: completedSpeakingResult },
  }), true, JSON.stringify(result.errors));
  assert.equal(result({
    available: true, state: 'completed', keysRevealed: true,
    writingAssessment: completedWritingState,
    speakingAssessment: pendingSpeakingState,
    assessment: { status: 'completed', retryAllowed: false, retryCount: 0 },
    result: { writing: writingResult, speaking: completedSpeakingResult },
  }), false, 'a completed result cannot expose a pending provisional speaking state');
  const writingItem = compileOpenApiSchema(specification, 'EgeMockWritingResultItem');
  const writingResultSchema = compileOpenApiSchema(specification, 'EgeMockWritingResult');
  const standardSpecification = specification.replace(
    /^\s*x-easyboost-ege-writing-(?:rubric|total):.*$/gmu, '',
  );
  const standardWritingItem = compileOpenApiSchema(
    standardSpecification, 'EgeMockWritingResultItem',
  );
  const standardWritingResult = compileOpenApiSchema(
    standardSpecification, 'EgeMockWritingResult',
  );
  const writingScope = compileOpenApiSchema(specification, 'EgeMockWritingEvaluationScope');
  assert.equal(writingScope({
    fullWords: 275, evaluatedWords: 275, truncated: false, evaluatedLimit: 250,
  }), true, JSON.stringify(writingScope.errors));
  assert.equal(writingItem(writingResult.items[0]), true, JSON.stringify(writingItem.errors));
  assert.equal(writingResultSchema(writingResult), true, JSON.stringify(writingResultSchema.errors));
  assert.equal(writingResultSchema({
    ...writingResult, assessmentRevision: Number.MAX_SAFE_INTEGER,
  }), true, JSON.stringify(writingResultSchema.errors));
  assert.equal(writingResultSchema({
    ...writingResult, assessmentRevision: Number.MAX_SAFE_INTEGER + 1,
  }), false, 'the public writing result uses the same safe assessment-revision ceiling');
  assert.equal(writingResultSchema({ ...writingResult, score: 19 }), false,
    'completed overall writing score must equal the exact sum of both task scores');
  assert.equal(writingResultSchema({ ...writingResult, score: null }), false,
    'a completed overall result must carry its numeric score');
  assert.equal(writingResultSchema({ ...writingResult, items: [] }), false,
    'a completed overall result must carry both completed task results');
  assert.equal(writingResultSchema({ ...writingResult, status: 'retryable', score: 20 }), false,
    'an incomplete overall result must never expose a score');
  assert.equal(writingItem({ ...writingResult.items[0], maximum: 14, score: 14 }), false,
    'position 37 must be structurally bound to its exact 6-point maximum');
  assert.equal(writingItem({
    ...writingResult.items[0], criteriaRef: writingResult.items[1].criteriaRef,
  }), false, 'position 37 must be structurally bound to its exact criteria reference');
  assert.equal(writingItem({
    ...writingResult.items[0],
    scope: { fullWords: 275, evaluatedWords: 275, truncated: false, evaluatedLimit: 250 },
  }), false, 'position 37 must reject task-38 evaluation scope');
  assert.equal(writingItem(writingResult.items[1]), true, JSON.stringify(writingItem.errors));
  assert.equal(writingItem({
    ...writingResult.items[1],
    scope: { fullWords: 275, evaluatedWords: 275, truncated: false, evaluatedLimit: 250 },
  }), true, JSON.stringify(writingItem.errors));
  assert.equal(writingItem({ ...writingResult.items[1], position: 37 }), false,
    'a task 38 result cannot masquerade as task 37');
  assert.equal(writingItem({
    ...writingResult.items[1], criteriaRef: writingResult.items[0].criteriaRef,
  }), false, 'position 38 must be structurally bound to its exact criteria reference');
  assert.equal(writingResultSchema({
    ...writingResult, items: [writingResult.items[0], structuredClone(writingResult.items[0])],
  }), false, 'a completed overall result must contain exactly one task 37 and one task 38 item');
  assert.equal(writingItem({
    ...writingResult.items[0], criteria: [
      ...writingResult.items[0].criteria,
      { name: 'Invented fourth criterion', got: 1, max: 1 },
    ],
  }), false, 'completed task 37 must contain exactly three criteria');
  assert.equal(writingItem({
    ...writingResult.items[1], criteria: writingResult.items[1].criteria.slice(0, 4),
  }), false, 'completed task 38 must contain exactly five criteria');
  assert.equal(writingItem({
    ...writingResult.items[0], criteriaFingerprint: `sha256:${'f'.repeat(64)}`,
  }), false, 'task 37 must carry the exact pinned rubric fingerprint');
  assert.equal(writingItem({
    ...writingResult.items[0], criteria: [
      { ...writingResult.items[0].criteria[0], name: 'Invented criterion' },
      ...writingResult.items[0].criteria.slice(1),
    ],
  }), false, 'completed criteria must use the exact pinned names and maxima');
  assert.equal(writingItem({
    ...writingResult.items[0], criteria: [
      { ...writingResult.items[0].criteria[0], got: 3 },
      ...writingResult.items[0].criteria.slice(1),
    ], score: 7,
  }), false, 'a criterion score cannot exceed its pinned maximum');
  assert.equal(writingItem({ ...writingResult.items[0], score: 5 }), false,
    'item score must equal the exact sum of criterion scores');
  assert.equal(standardWritingItem({
    ...writingResult.items[0], criteria: [
      { ...writingResult.items[0].criteria[0], name: 'Invented criterion' },
      ...writingResult.items[0].criteria.slice(1),
    ],
  }), false, 'ordinary OpenAPI validators reject invented pinned-rubric tuples');
  assert.equal(standardWritingItem({
    ...writingResult.items[0], criteria: [
      structuredClone(writingResult.items[0].criteria[0]),
      structuredClone(writingResult.items[0].criteria[0]),
      structuredClone(writingResult.items[0].criteria[2]),
    ],
  }), false, 'ordinary OpenAPI validators reject duplicate ordered criteria');
  assert.equal(standardWritingItem({ ...writingResult.items[0], score: 5 }), false,
    'ordinary OpenAPI validators enforce the criterion-score sum');
  assert.equal(standardWritingItem({
    ...writingResult.items[0], score: 1,
    criteria: writingResult.items[0].criteria.map((criterion, index) => ({
      ...criterion, got: index === 1 ? 1 : 0,
    })),
  }), false, 'ordinary OpenAPI validators enforce the task 37 K1-zero cascade');
  assert.equal(standardWritingItem({
    ...writingResult.items[1], score: 1,
    criteria: writingResult.items[1].criteria.map((criterion, index) => ({
      ...criterion, got: index === 2 ? 1 : 0,
    })),
  }), false, 'ordinary OpenAPI validators enforce the task 38 K1-zero cascade');
  assert.equal(standardWritingItem({
    ...writingResult.items[1], criteria: [
      ...writingResult.items[1].criteria.slice(0, 4),
      { ...writingResult.items[1].criteria[4], got: 1 },
    ], score: 14,
  }), false, 'ordinary OpenAPI validators enforce the task 38 criterion-score sum');
  const zeroTask37 = {
    ...writingResult.items[0], score: 0,
    criteria: writingResult.items[0].criteria.map((criterion) => ({ ...criterion, got: 0 })),
    scope: { fullWords: 50, evaluatedWords: 50, truncated: false, evaluatedLimit: 140 },
  };
  assert.equal(standardWritingItem(zeroTask37), true, JSON.stringify(standardWritingItem.errors));
  assert.equal(standardWritingItem({
    ...writingResult.items[0],
    scope: { fullWords: 50, evaluatedWords: 50, truncated: false, evaluatedLimit: 140 },
  }), false, 'ordinary OpenAPI validators couple a below-shoulder task 37 scope to all-zero rubric');
  assert.equal(standardWritingItem({
    ...writingResult.items[0],
    scope: { fullWords: 110, evaluatedWords: 111, truncated: false, evaluatedLimit: 140 },
  }), false, 'ordinary OpenAPI validators reject evaluated words above full words');
  assert.equal(standardWritingItem({
    ...writingResult.items[0],
    scope: { fullWords: 155, evaluatedWords: 140, truncated: true, evaluatedLimit: 140 },
  }), true, JSON.stringify(standardWritingItem.errors));
  assert.equal(standardWritingItem({
    ...writingResult.items[0],
    scope: { fullWords: 155, evaluatedWords: 141, truncated: true, evaluatedLimit: 140 },
  }), false, 'ordinary OpenAPI validators enforce the official task 37 cutoff count');
  const zeroTask38 = {
    ...writingResult.items[1], score: 0,
    criteria: writingResult.items[1].criteria.map((criterion) => ({ ...criterion, got: 0 })),
    scope: { fullWords: 100, evaluatedWords: 100, truncated: false, evaluatedLimit: 250 },
  };
  assert.equal(standardWritingItem(zeroTask38), true, JSON.stringify(standardWritingItem.errors));
  assert.equal(standardWritingItem({
    ...writingResult.items[1],
    scope: { fullWords: 100, evaluatedWords: 100, truncated: false, evaluatedLimit: 250 },
  }), false, 'ordinary OpenAPI validators couple a below-shoulder task 38 scope to all-zero rubric');
  assert.equal(standardWritingItem({
    ...writingResult.items[1],
    scope: { fullWords: 276, evaluatedWords: 250, truncated: true, evaluatedLimit: 250 },
  }), true, JSON.stringify(standardWritingItem.errors));
  assert.equal(standardWritingItem({
    ...writingResult.items[1],
    scope: { fullWords: 276, evaluatedWords: 251, truncated: true, evaluatedLimit: 250 },
  }), false, 'ordinary OpenAPI validators enforce the official task 38 cutoff count');
  assert.equal(standardWritingResult({ ...writingResult, score: 19 }), false,
    'ordinary OpenAPI validators enforce the completed task-score sum');
  assert.equal(writingItem({
    ...writingResult.items[0], criteria: [
      { ...writingResult.items[0].criteria[0], name: 'x'.repeat(121) },
      ...writingResult.items[0].criteria.slice(1),
    ],
  }), false, 'criterion-name bounds must equal runtime');
  assert.equal(writingItem({
    ...writingResult.items[0], feedback: { ...writingResult.items[0].feedback, verdict: 'x'.repeat(161) },
  }), false, 'verdict bounds must equal runtime');
  assert.equal(writingItem({
    ...writingResult.items[0], feedback: { ...writingResult.items[0].feedback, nextStep: 'x'.repeat(501) },
  }), false, 'next-step bounds must equal runtime');
  const pendingTask37 = {
    ...writingResult.items[0], status: 'pending', score: null, criteria: null, feedback: null, evidence: [],
  };
  assert.equal(writingResultSchema({
    ...writingResult, status: 'retryable', score: null, items: [pendingTask37],
  }), true, JSON.stringify(writingResultSchema.errors));
  assert.equal(writingResultSchema({
    ...writingResult, status: 'retryable', score: null,
  }), false, 'an incomplete overall result must contain at least one unfinished item');
  assert.equal(writingItem(pendingTask37), true, JSON.stringify(writingItem.errors));
  assert.equal(writingItem({ ...pendingTask37, criteria: writingResult.items[0].criteria }), false,
    'an unfinished item cannot expose criterion scores');
  assert.equal(writingItem({ ...writingResult.items[0], criteria: null, feedback: null }), false,
    'a completed item cannot omit its validated review');
  const evidence = {
    title: 'Grammar', wrong: 'people is', right: 'people are', kind: 'err', note: 'Agreement.',
  };
  assert.equal(writingItem({ ...writingResult.items[0], evidence: Array(6).fill(evidence) }), false,
    'public evidence must preserve the runtime five-item bound');
  assert.equal(writingItem({
    ...writingResult.items[0], evidence: [{ ...evidence, kind: 'invented' }],
  }), false, 'public evidence kinds must equal the runtime enum');
  assert.equal(writingItem({
    ...writingResult.items[0], evidence: [{ ...evidence, title: '' }],
  }), false, 'public evidence titles must be non-empty');
  assert.equal(writingItem({
    ...writingResult.items[0], evidence: [{ ...evidence, wrong: 'x'.repeat(501) }],
  }), false, 'public evidence text bounds must equal runtime');
});
