import assert from 'node:assert/strict';
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

function objectKeys(value) {
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  if (!value || typeof value !== 'object') return [];
  return [...Object.keys(value), ...Object.values(value).flatMap(objectKeys)];
}

async function withServer(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-mock-api-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  const { username: owner } = await repository.grantDays(9_270_001, 30, 'Mock API owner');
  const { username: other } = await repository.grantDays(9_270_002, 30, 'Mock API other');
  let now = new Date('2026-08-13T06:00:00.000Z');
  const app = express();
  app.use(express.json());
  app.use(createEgeMockRoutes({
    authentication: { auth(req, _res, next) { req.user = req.get('x-test-user'); next(); } },
    access: { requireActiveSubscription(_req, _res, next) { next(); } },
    db: repository,
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
  try { await run({ owner, other, repository, request, setNow(value) { now = new Date(value); } }); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

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
    });
    const oralSubmit = await (await request(owner,
      `/api/v1/ege-mocks/attempts/${started.attempt.id}/oral/submit`, {
        method: 'POST', idempotencyKey: 'a54bb188-2489-4d6c-b8b4-d900102a6f86',
        body: {
          expectedRevision: oral.attempt.revision,
          recordings: { 39: { recordingId: 'owner-bound-39', durationSeconds: 72 } },
        },
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
  assert.equal(attemptSchema(attempt), true, JSON.stringify(attemptSchema.errors));
  const nullableAttemptSchema = compileOpenApiSchema(specification, 'EgeMockNullableAttempt');
  assert.equal(nullableAttemptSchema(null), true, JSON.stringify(nullableAttemptSchema.errors));
  assert.equal(nullableAttemptSchema(attempt), true, JSON.stringify(nullableAttemptSchema.errors));
  assert.equal(nullableAttemptSchema({}), false);
  const startResponse = compileOpenApiSchema(specification, 'EgeMockStartResponse');
  assert.equal(startResponse({ created: true, replayed: false, attempt }), true,
    JSON.stringify(startResponse.errors));
  const result = compileOpenApiSchema(specification, 'EgeMockResult');
  assert.equal(result({ available: false, state: 'written_in_progress', keysRevealed: false }), true,
    JSON.stringify(result.errors));
  assert.equal(result({
    available: true, state: 'assessment_pending', keysRevealed: true,
    assessment: { status: 'not_started', retryAllowed: false, retryCount: 0 }, result: null,
  }), true, JSON.stringify(result.errors));
});
