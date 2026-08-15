import assert from 'node:assert/strict';
import test from 'node:test';
import { EGE_MOCK_FORM_1_V1_PUBLIC as form } from '../public/ege-mock-form-1-v1.js';
import {
  createEgeMockWrittenRunner as createRawEgeMockWrittenRunner,
  egeMockLocalContinuation, normalizeEgeMockSelection,
} from '../public/ege-mock-written-runner.js';
import {
  AUTOMATIC_ASSESSMENT_WARNING,
  EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
  EGE_MOCK_WRITING_ASSESSMENT_LABEL,
} from '../public/automatic-assessment-contract.js';

const SERVER_OWNER_GENERATION = 'account:2026-08-13T06:00:00.000Z';

function createEgeMockWrittenRunner(options) {
  let fallbackAssessmentRevision = 0;
  let fallbackAssessmentProjection = null;
  const transport = Object.fromEntries(Object.entries(options.transport || {}).map(([name, method]) => [
    name, async (...args) => {
      const result = await method(...args);
      if (!result?.attempt) return result;
      const candidate = result.attempt.writingAssessment || { status: 'not_started' };
      let assessmentRevision = candidate.assessmentRevision;
      if (candidate.assessmentRevision == null) {
        const encoded = JSON.stringify(candidate);
        if (encoded !== fallbackAssessmentProjection) {
          fallbackAssessmentProjection = encoded;
          fallbackAssessmentRevision += 1;
        }
        assessmentRevision = fallbackAssessmentRevision;
      }
      const writingAssessment = assessmentState(
        candidate.status || 'not_started', assessmentRevision, candidate,
      );
      return {
        ...result,
        attempt: {
          ownerGeneration: SERVER_OWNER_GENERATION,
          ...result.attempt,
          writingAssessment,
        },
      };
    },
  ]));
  return createRawEgeMockWrittenRunner({ ...options, transport });
}

function assessmentState(status, assessmentRevision, extra = {}) {
  const retryCount = Number.isInteger(extra.retryCount) ? extra.retryCount : 0;
  return {
    status, assessmentRevision, mode: 'experimental', scoreKind: 'approximate',
    warning: AUTOMATIC_ASSESSMENT_WARNING, label: EGE_MOCK_WRITING_ASSESSMENT_LABEL,
    retryAllowed: ['retryable', 'ambiguous'].includes(status) && retryCount < 3,
    retryCount,
    ...(status === 'ambiguous'
      ? { retryWarning: EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING } : {}),
    ...extra,
  };
}

function durableSubmittedState({ owner, attemptId, writingAssessment, extra = {} }) {
  return {
    version: 1, owner, phase: 'written_submitted', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 2,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
    preflight: null, pendingStartId: null, saveStatus: 'saved', queue: [],
    compactedThrough: null, canceledSubmit: null, assessmentCommand: null,
    assessmentCommandThrough: null, assetBlockedAt: 0, assetReadyAt: 0,
    assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
    result: { kind: 'written_submission', state: 'oral_ready', writingAssessment },
    ...extra,
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) {
      let encoded = String(value);
      if (key.startsWith('easyboost-ege-mock-written-v1:')) {
        try {
          const parsed = JSON.parse(encoded);
          if (typeof parsed?.attemptId === 'string' && parsed.attemptOwnerGeneration == null) {
            parsed.attemptOwnerGeneration = SERVER_OWNER_GENERATION;
            encoded = JSON.stringify(parsed);
          }
        } catch (_) {}
      }
      values.set(key, encoded);
    },
    removeItem(key) { values.delete(key); },
  };
}

function serialLockManager() {
  let tail = Promise.resolve();
  let calls = 0;
  return {
    get calls() { return calls; },
    request(_name, options, callback) {
      calls += 1;
      const task = typeof options === 'function' ? options : callback;
      const result = tail.then(task, task);
      tail = result.catch(() => {});
      return result;
    },
  };
}

const ATTEMPT_POLICY_ID = 'ege-mock-attempt-policy-v1';
const wordsForRunner = (count, prefix) => (
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(' ')
);

test('shared unique-selection nulls normalize to durable empty slots', () => {
  assert.deepEqual(normalizeEgeMockSelection(['1', null, '3']), ['1', '', '3']);
});

test('pending automatic assessment run survives offline reload and uses the explicit POST transport', async () => {
  const storage = memoryStorage();
  let online = false;
  const owner = { username: 'learner', generation: 4 };
  const attemptId = '00500000-0000-4000-8000-000000000097';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const pending = {
    status: 'pending', assessmentRevision: 1,
    mode: 'experimental', scoreKind: 'approximate',
    warning: AUTOMATIC_ASSESSMENT_WARNING, label: EGE_MOCK_WRITING_ASSESSMENT_LABEL,
    retryAllowed: false, retryCount: 0,
  };
  const attempt = (writingAssessment) => ({
    id: attemptId, state: 'oral_ready', revision: 2, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z', writingAssessment,
  });
  storage.setItem(key, JSON.stringify({
    version: 1, owner, phase: 'written_submitted', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 2,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
    preflight: null, pendingStartId: null, saveStatus: 'saved', queue: [],
    compactedThrough: null, canceledSubmit: null, assetBlockedAt: 0, assetReadyAt: 0,
    assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
    result: { kind: 'written_submission', state: 'oral_ready', writingAssessment: pending },
  }));
  const runs = [];
  const dependencies = {
    owner, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'),
    uuid: () => '653d49bf-b1c0-4db2-8459-b276dc5f950d', assets: {},
    transport: {
      async runAssessment(candidate) {
        runs.push(structuredClone(candidate));
        if (runs.length === 1) {
          return {
            applied: false, replayed: false,
            attempt: attempt({ ...pending, status: 'in_progress', assessmentRevision: 2 }),
          };
        }
        return {
          applied: true, replayed: false,
          attempt: attempt({ ...pending, status: 'completed', assessmentRevision: 3 }),
        };
      },
    },
  };

  const first = createEgeMockWrittenRunner(dependencies);
  const queued = await first.dispatch({ type: 'restore', form });
  assert.equal(queued.assessmentRunQueued, true);
  assert.equal(runs.length, 0);

  const restored = createEgeMockWrittenRunner(dependencies);
  const offline = await restored.dispatch({ type: 'restore', form });
  assert.equal(offline.assessmentRunQueued, true);
  online = true;
  const stillPending = await restored.dispatch({ type: 'sync' });
  assert.equal(stillPending.assessmentRunQueued, true,
    'a nonterminal response keeps the exact durable run command');
  assert.equal(stillPending.saveStatus, 'queued');
  const completed = await restored.dispatch({ type: 'sync' });
  assert.deepEqual(runs, [{
    attemptId, idempotencyKey: '653d49bf-b1c0-4db2-8459-b276dc5f950d',
  }, {
    attemptId, idempotencyKey: '653d49bf-b1c0-4db2-8459-b276dc5f950d',
  }]);
  assert.equal(completed.assessmentRunQueued, false);
  assert.equal(completed.result.writingAssessment.status, 'completed');
});

test('malformed terminal assessment acknowledgement preserves the durable run command and local state', async () => {
  const storage = memoryStorage();
  let online = false;
  const owner = { username: 'learner', generation: 4 };
  const attemptId = '00500000-0000-4000-8000-000000000096';
  const idempotencyKey = '653d49bf-b1c0-4db2-8459-b276dc5f950c';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const pending = {
    status: 'pending', assessmentRevision: 1, mode: 'experimental', scoreKind: 'approximate',
    warning: AUTOMATIC_ASSESSMENT_WARNING, label: EGE_MOCK_WRITING_ASSESSMENT_LABEL,
    retryAllowed: false, retryCount: 0,
  };
  const attempt = (writingAssessment) => ({
    id: attemptId, state: 'oral_ready', revision: 2, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z', writingAssessment,
  });
  storage.setItem(key, JSON.stringify({
    version: 1, owner, phase: 'written_submitted', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 2,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
    preflight: null, pendingStartId: null, saveStatus: 'saved', queue: [],
    compactedThrough: null, canceledSubmit: null, assetBlockedAt: 0, assetReadyAt: 0,
    assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
    assessmentRetry: {
      action: 'run', idempotencyKey, createdAt: 1,
      acknowledgePossibleProviderRepeat: false,
    },
    assessmentRetryThrough: null,
    result: { kind: 'written_submission', state: 'oral_ready', writingAssessment: pending },
  }));
  const deliveries = [];
  const runner = createEgeMockWrittenRunner({
    owner, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'),
    uuid: () => { throw new Error('the durable command must keep its UUID'); }, assets: {},
    transport: {
      async runAssessment(candidate) {
        deliveries.push(structuredClone(candidate));
        if (deliveries.length === 1) {
          return {
            applied: false, replayed: false,
            attempt: attempt(assessmentState('completed', 2)),
          };
        }
        return {
          applied: true, replayed: true,
          attempt: attempt(assessmentState('completed', 2)),
        };
      },
    },
  });

  await runner.dispatch({ type: 'restore', form });
  online = true;
  await assert.rejects(runner.dispatch({ type: 'sync' }), {
    code: 'EGE_MOCK_ASSESSMENT_RESPONSE_INVALID',
  });
  const preserved = runner.snapshot();
  assert.equal(preserved.assessmentRunQueued, true);
  assert.equal(preserved.saveStatus, 'queued');
  assert.equal(preserved.result.writingAssessment.status, 'pending',
    'an unacknowledged terminal body cannot mutate the observational state');

  const completed = await runner.dispatch({ type: 'sync' });
  assert.deepEqual(deliveries, [
    { attemptId, idempotencyKey }, { attemptId, idempotencyKey },
  ]);
  assert.equal(completed.assessmentRunQueued, false);
  assert.equal(completed.result.writingAssessment.status, 'completed');
});

test('an acknowledged subscription rejection retires the exact automatic-run UUID without retrying it', async () => {
  const storage = memoryStorage();
  let online = false;
  const owner = { username: 'learner', generation: 4 };
  const attemptId = '00500000-0000-4000-8000-000000000095';
  const idempotencyKey = '653d49bf-b1c0-4db2-8459-b276dc5f950b';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const pending = {
    status: 'pending', assessmentRevision: 1,
    mode: 'experimental', scoreKind: 'approximate',
    warning: AUTOMATIC_ASSESSMENT_WARNING, label: EGE_MOCK_WRITING_ASSESSMENT_LABEL,
    retryAllowed: false, retryCount: 0,
  };
  const attempt = {
    id: attemptId, state: 'oral_ready', revision: 2, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z',
    writingAssessment: {
      ...pending, assessmentRevision: 2, runDisposition: 'subscription_required',
    },
  };
  storage.setItem(key, JSON.stringify({
    version: 1, owner, phase: 'written_submitted', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 2,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
    preflight: null, pendingStartId: null, saveStatus: 'queued', queue: [],
    compactedThrough: null, canceledSubmit: null, assetBlockedAt: 0, assetReadyAt: 0,
    assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
    assessmentCommand: {
      action: 'run', idempotencyKey, createdAt: 1,
      acknowledgePossibleProviderRepeat: false,
    },
    assessmentCommandThrough: null,
    result: { kind: 'written_submission', state: 'oral_ready', writingAssessment: pending },
  }));
  const deliveries = [];
  const runner = createEgeMockWrittenRunner({
    owner, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'),
    uuid: () => { throw new Error('the rejected command must not mint another UUID'); }, assets: {},
    transport: {
      async runAssessment(candidate) {
        deliveries.push(structuredClone(candidate));
        if (deliveries.length === 1) {
          return {
            applied: true, replayed: false, disposition: 'subscription_required',
            attempt: { ...attempt, writingAssessment: pending },
          };
        }
        return {
          applied: true, replayed: false, disposition: 'subscription_required', attempt,
        };
      },
    },
  });
  await runner.dispatch({ type: 'restore', form });
  online = true;
  await assert.rejects(runner.dispatch({ type: 'sync' }), {
    code: 'EGE_MOCK_ASSESSMENT_RESPONSE_INVALID',
  });
  assert.equal(runner.snapshot().assessmentRunQueued, true,
    'a subscription terminal without the authoritative attempt disposition is not acknowledged');
  assert.equal(runner.snapshot().result.writingAssessment.runDisposition, undefined);
  const rejected = await runner.dispatch({ type: 'sync' });
  assert.deepEqual(deliveries, [
    { attemptId, idempotencyKey }, { attemptId, idempotencyKey },
  ]);
  assert.equal(rejected.assessmentRunQueued, false);
  assert.equal(rejected.saveStatus, 'saved');
  assert.equal(rejected.result.writingAssessment.status, 'pending');
  assert.equal(rejected.result.writingAssessment.runDisposition, 'subscription_required');
  const durable = JSON.parse(storage.getItem(key));
  assert.equal(durable.assessmentCommand, null);
  assert.equal(durable.assessmentCommandThrough.idempotencyKey, idempotencyKey);

  const staleAutomaticKey = '1e9ac1ce-e78d-40fc-bf1a-79661c1ec8dd';
  const offlineRenewalKey = '12fe61dc-786b-4692-a7cc-9cd40fb89b1f';
  const offlineRenewalStorage = memoryStorage();
  offlineRenewalStorage.setItem(key, JSON.stringify({
    ...durable,
    assessmentCommand: {
      action: 'run', idempotencyKey: staleAutomaticKey, createdAt: 2,
      acknowledgePossibleProviderRepeat: false,
    },
    assessmentCommandThrough: null,
  }));
  let offlineMinted = 0;
  const offlineRenewal = createEgeMockWrittenRunner({
    owner, storage: offlineRenewalStorage, online: () => false, assets: {},
    uuid() { offlineMinted += 1; return offlineRenewalKey; },
    transport: { async runAssessment() { throw new Error('offline'); } },
  });
  await offlineRenewal.dispatch({ type: 'restore', form });
  const explicitlyRearmed = await offlineRenewal.dispatch({ type: 'runAssessmentAfterRenewal' });
  assert.equal(offlineMinted, 1, 'the explicit action replaces a stale automatic UUID with a new UUID');
  assert.equal(explicitlyRearmed.assessmentRunQueued, true);
  const explicitDurable = JSON.parse(offlineRenewalStorage.getItem(key));
  assert.equal(explicitDurable.assessmentCommand.idempotencyKey, offlineRenewalKey);
  assert.equal(explicitDurable.assessmentCommand.explicitRenewal, true);
  assert.equal(explicitDurable.assessmentCommandThrough.idempotencyKey, staleAutomaticKey);

  let entitlementRestored = false;
  let minted = 0;
  const renewalKey = '653d49bf-b1c0-4db2-8459-b276dc5f951c';
  const reloaded = createEgeMockWrittenRunner({
    owner, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:21:00.000Z'), assets: {},
    uuid() {
      assert.equal(entitlementRestored, true,
        'restore and observational GET must not mint a new automatic command');
      minted += 1;
      return renewalKey;
    },
    transport: {
      async attempt() { return { attempt }; },
      async runAssessment(candidate) {
        deliveries.push(structuredClone(candidate));
        return {
          applied: false, replayed: false,
          attempt: {
            ...attempt,
            writingAssessment: {
              ...pending, status: 'in_progress', assessmentRevision: 3,
            },
          },
        };
      },
    },
  });
  const restored = await reloaded.dispatch({ type: 'restore', form });
  assert.equal(minted, 0);
  assert.equal(restored.assessmentRunQueued, false);
  assert.equal(restored.result.writingAssessment.runDisposition, 'subscription_required');
  assert.equal(deliveries.length, 2);

  entitlementRestored = true;
  const resumed = await reloaded.dispatch({ type: 'runAssessmentAfterRenewal' });
  assert.equal(minted, 1, 'only the explicit post-renewal action mints a new UUID');
  assert.deepEqual(deliveries.at(-1), {
    attemptId, idempotencyKey: renewalKey, explicitRenewal: true,
  });
  assert.equal(resumed.assessmentRunQueued, true);
  assert.equal(resumed.result.writingAssessment.runDisposition, undefined);
});

test('an older terminal replay retires its UUID without regressing a newer attempt or assessment projection', async () => {
  const storage = memoryStorage();
  const owner = { username: 'learner', generation: 4 };
  const attemptId = '00500000-0000-4000-8000-000000000094';
  const oldKey = '653d49bf-b1c0-4db2-8459-b276dc5f950a';
  const nextKey = '653d49bf-b1c0-4db2-8459-b276dc5f951a';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const attempt = (writingAssessment, overrides = {}) => ({
    id: attemptId, state: 'oral_ready', revision: 2, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z', writingAssessment,
    ...overrides,
  });
  const blocked = assessmentState('pending', 4, { runDisposition: 'subscription_required' });
  const current = assessmentState('in_progress', 5);
  storage.setItem(key, JSON.stringify({
    version: 1, owner, phase: 'written_submitted', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 2,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
    preflight: null, pendingStartId: null, saveStatus: 'queued', queue: [],
    compactedThrough: null, canceledSubmit: null, assetBlockedAt: 0, assetReadyAt: 0,
    assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
    assessmentCommand: {
      action: 'run', idempotencyKey: oldKey, createdAt: 1,
      acknowledgePossibleProviderRepeat: false,
    },
    assessmentCommandThrough: null,
    result: { kind: 'written_submission', state: 'oral_ready', writingAssessment: blocked },
  }));
  let minted = 0;
  let staleReplayCalls = 0;
  const runner = createEgeMockWrittenRunner({
    owner, storage, online: () => true, assets: {},
    uuid() { minted += 1; return nextKey; },
    transport: {
      async attempt() {
        return {
          attempt: attempt(current, {
            state: 'oral_in_progress', revision: 3, draft: { 37: 'Current server draft.' },
          }),
        };
      },
      async runAssessment(candidate) {
        staleReplayCalls += 1;
        assert.equal(candidate.idempotencyKey, oldKey);
        return {
          applied: true, replayed: true, disposition: 'subscription_required',
          attempt: attempt(blocked),
        };
      },
    },
  });

  const restored = await runner.dispatch({ type: 'restore', form });
  assert.equal(staleReplayCalls, 1, 'the regression exercises the immutable stale response');
  assert.equal(restored.revision, 3,
    'an immutable response cannot roll back the newer attempt lifecycle revision');
  assert.equal(restored.result.state, 'oral_in_progress',
    'an immutable response cannot restore an older lifecycle state');
  assert.deepEqual(restored.answers, { 37: 'Current server draft.' },
    'an immutable response cannot restore an older server draft');
  assert.equal(restored.result.writingAssessment.assessmentRevision, 5);
  assert.equal(restored.result.writingAssessment.status, 'in_progress');
  assert.equal(restored.result.writingAssessment.runDisposition, undefined,
    'the immutable older replay cannot overwrite the newer GET projection');
  const durable = JSON.parse(storage.getItem(key));
  assert.equal(durable.assessmentCommandThrough.idempotencyKey, oldKey,
    'the acknowledged stale command is still durably retired');
  assert.equal(durable.assessmentCommand, null,
    'retiring the stale run does not manufacture another command');
  assert.equal(minted, 0);
});

test('decimal revision rollover cannot let a stale assessment replay replace newer server answers', async () => {
  for (const [staleRevision, currentRevision] of [[9, 10], [99, 100]]) {
    const storage = memoryStorage();
    const owner = { username: `rollover-${currentRevision}`, generation: 4 };
    const attemptId = `00500000-0000-4000-8000-${String(currentRevision).padStart(12, '0')}`;
    const oldKey = `653d49bf-b1c0-4db2-8459-${String(currentRevision).padStart(12, '0')}`;
    const currentAssessment = assessmentState('in_progress', 5);
    const staleAssessment = assessmentState('pending', 4, {
      runDisposition: 'subscription_required',
    });
    const attempt = (revision, draft, writingAssessment) => ({
      id: attemptId, state: revision === currentRevision ? 'oral_in_progress' : 'oral_ready',
      revision, draft,
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z',
      writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      writtenSubmittedAt: '2026-08-13T06:20:00.000Z', writingAssessment,
    });
    storage.setItem(`easyboost-ege-mock-written-v1:${owner.username}:4`, JSON.stringify(
      durableSubmittedState({
        owner, attemptId, writingAssessment: staleAssessment,
        extra: {
          assessmentCommand: {
            action: 'run', idempotencyKey: oldKey, createdAt: 1,
            acknowledgePossibleProviderRepeat: false,
          },
          result: {
            kind: 'written_submission', state: 'oral_ready', writingAssessment: staleAssessment,
          },
        },
      }),
    ));
    const runner = createEgeMockWrittenRunner({
      owner, storage, online: () => true, assets: {},
      transport: {
        async attempt() {
          return { attempt: attempt(currentRevision, { 37: `Current revision ${currentRevision}.` }, currentAssessment) };
        },
        async runAssessment() {
          return {
            applied: true, replayed: true, disposition: 'subscription_required',
            attempt: attempt(staleRevision, { 37: `Stale revision ${staleRevision}.` }, staleAssessment),
          };
        },
      },
    });

    const restored = await runner.dispatch({ type: 'restore', form });
    assert.deepEqual(restored.answers, { 37: `Current revision ${currentRevision}.` },
      `server revision ${staleRevision} must not replace revision ${currentRevision}`);
  }
});

test('a same-revision assessment replay with different content is rejected without retiring its UUID', async () => {
  const storage = memoryStorage();
  const owner = { username: 'learner', generation: 4 };
  const attemptId = '00500000-0000-4000-8000-000000000093';
  const idempotencyKey = '653d49bf-b1c0-4db2-8459-b276dc5f9509';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const current = assessmentState('completed', 7);
  const conflicting = assessmentState('pending', 7, { runDisposition: 'subscription_required' });
  const attempt = (writingAssessment) => ({
    id: attemptId, state: 'oral_ready', revision: 2, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z', writingAssessment,
  });
  storage.setItem(key, JSON.stringify({
    version: 1, owner, phase: 'written_submitted', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 2,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z', answers: {}, answerVersions: {},
    audioPlays: {}, currentPosition: 38, preflight: null, pendingStartId: null,
    saveStatus: 'queued', queue: [], compactedThrough: null, canceledSubmit: null,
    assetBlockedAt: 0, assetReadyAt: 0, assetResumePhase: null,
    audioLease: null, audioLeaseThrough: null,
    assessmentCommand: {
      action: 'run', idempotencyKey, createdAt: 1,
      acknowledgePossibleProviderRepeat: false,
    },
    assessmentCommandThrough: null,
    result: { kind: 'written_submission', state: 'oral_ready', writingAssessment: current },
  }));
  const runner = createEgeMockWrittenRunner({
    owner, storage, online: () => true, assets: {},
    uuid: () => { throw new Error('no replacement is allowed'); },
    transport: {
      async attempt() { return { attempt: attempt(current) }; },
      async runAssessment() {
        return {
          applied: true, replayed: true, disposition: 'subscription_required',
          attempt: attempt(conflicting),
        };
      },
    },
  });

  await assert.rejects(runner.dispatch({ type: 'restore', form }), {
    code: 'EGE_MOCK_ASSESSMENT_RESPONSE_INVALID',
  });
  assert.equal(runner.snapshot().result.writingAssessment.status, 'completed');
  assert.equal(runner.snapshot().assessmentRunQueued, true);
});

test('ambiguous writing-assessment retry requires acknowledgement and survives offline reload', async () => {
  const storage = memoryStorage();
  let online = false;
  const owner = { username: 'learner', generation: 4 };
  const attemptId = '00500000-0000-4000-8000-000000000099';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const writingAssessment = {
    status: 'ambiguous', assessmentRevision: 0,
    mode: 'experimental', scoreKind: 'approximate',
    warning: AUTOMATIC_ASSESSMENT_WARNING, label: EGE_MOCK_WRITING_ASSESSMENT_LABEL,
    retryAllowed: true, retryCount: 0,
    retryWarning: EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
  };
  storage.setItem(key, JSON.stringify({
    version: 1, owner, phase: 'written_submitted', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 2,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
    preflight: null, pendingStartId: null, saveStatus: 'saved', queue: [],
    compactedThrough: null, canceledSubmit: null, assetBlockedAt: 0, assetReadyAt: 0,
    assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
    result: { kind: 'written_submission', state: 'oral_ready', writingAssessment },
  }));
  const retries = [];
  const dependencies = {
    owner, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'),
    uuid: () => '653d49bf-b1c0-4db2-8459-b276dc5f950e',
    assets: {},
    transport: {
      async retryAssessment(candidate) {
        retries.push(structuredClone(candidate));
        return { applied: true, replayed: false, attempt: {
          id: attemptId, state: 'oral_ready', revision: 2, draft: {},
          formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
          ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
          writtenStartedAt: '2026-08-13T06:00:00.000Z',
          writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
          writtenSubmittedAt: '2026-08-13T06:20:00.000Z',
          writingAssessment: assessmentState('pending', 1, { retryCount: 1 }),
        } };
      },
    },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'restore', form });
  await assert.rejects(first.dispatch({ type: 'retryAssessment' }),
    /EGE_MOCK_WRITING_AMBIGUOUS_RETRY_ACK_REQUIRED/u);
  const queued = await first.dispatch({
    type: 'retryAssessment', acknowledgePossibleProviderRepeat: true,
  });
  assert.equal(queued.assessmentRetryQueued, true);
  assert.equal(retries.length, 0);

  const restored = createEgeMockWrittenRunner(dependencies);
  const offline = await restored.dispatch({ type: 'restore', form });
  assert.equal(offline.assessmentRetryQueued, true);
  online = true;
  const replayed = await restored.dispatch({ type: 'sync' });
  assert.equal(retries.length, 1);
  assert.deepEqual(retries[0], {
    attemptId, idempotencyKey: '653d49bf-b1c0-4db2-8459-b276dc5f950e',
    acknowledgePossibleProviderRepeat: true,
  });
  assert.equal(replayed.assessmentRetryQueued, false);
  assert.equal(replayed.result.writingAssessment.status, 'pending');
});

test('retry acknowledgement keeps a descending-UUID automatic run durable after server answer restore', async () => {
  const storage = memoryStorage();
  const owner = { username: 'logical-clock-rollover', generation: 4 };
  const attemptId = '00500000-0000-4000-8000-000000000096';
  const key = 'easyboost-ege-mock-written-v1:logical-clock-rollover:4';
  const ambiguous = assessmentState('ambiguous', 7, {
    retryAllowed: true, retryWarning: EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
  });
  const pending = assessmentState('pending', 8);
  storage.setItem(key, JSON.stringify(durableSubmittedState({
    owner, attemptId, writingAssessment: ambiguous,
  })));
  const attempt = (writingAssessment) => ({
    id: attemptId, state: 'oral_ready', revision: 10, draft: { 37: 'Current server draft.' },
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z', writingAssessment,
  });
  const ids = [
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    '00000000-0000-4000-8000-000000000001',
  ];
  let retryCalls = 0;
  let runCalls = 0;
  const runner = createEgeMockWrittenRunner({
    owner, storage, online: () => true, assets: {}, uuid: () => ids.shift(),
    transport: {
      async attempt() { return { attempt: attempt(ambiguous) }; },
      async retryAssessment() {
        retryCalls += 1;
        return { applied: true, replayed: false, attempt: attempt(pending) };
      },
      async runAssessment() {
        runCalls += 1;
        return { applied: false, replayed: false, attempt: attempt(pending) };
      },
    },
  });

  await runner.dispatch({ type: 'restore', form });
  const acknowledged = await runner.dispatch({
    type: 'retryAssessment', acknowledgePossibleProviderRepeat: true,
  });
  assert.equal(retryCalls, 1);
  assert.equal(acknowledged.assessmentRunQueued, true,
    'the automatic run must survive normalization even when its UUID sorts below the retry UUID');
  await runner.dispatch({ type: 'sync' });
  assert.equal(runCalls, 1);
});

test('observational terminal reconciliation preserves the retry UUID until an acknowledged replay', async () => {
  const storage = memoryStorage();
  let online = false;
  const owner = { username: 'learner', generation: 4 };
  const attemptId = '00500000-0000-4000-8000-000000000098';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const ambiguous = {
    status: 'ambiguous', assessmentRevision: 0,
    mode: 'experimental', scoreKind: 'approximate',
    warning: AUTOMATIC_ASSESSMENT_WARNING, label: EGE_MOCK_WRITING_ASSESSMENT_LABEL,
    retryAllowed: true, retryCount: 2,
    retryWarning: EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
  };
  storage.setItem(key, JSON.stringify({
    version: 1, owner, phase: 'written_submitted', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 2,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
    preflight: null, pendingStartId: null, saveStatus: 'saved', queue: [],
    compactedThrough: null, canceledSubmit: null, assetBlockedAt: 0, assetReadyAt: 0,
    assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
    result: { kind: 'written_submission', state: 'oral_ready', writingAssessment: ambiguous },
  }));
  const terminal = {
    ...ambiguous, assessmentRevision: 1, retryAllowed: false, retryCount: 3,
  };
  const attempt = {
    id: attemptId, state: 'oral_ready', revision: 2, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z', writingAssessment: terminal,
  };
  let retryCalls = 0;
  const runner = createEgeMockWrittenRunner({
    owner, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'),
    uuid: () => '653d49bf-b1c0-4db2-8459-b276dc5f950f', assets: {},
    transport: {
      async retryAssessment() {
        retryCalls += 1;
        if (retryCalls === 1) throw Object.assign(new Error('retry limit reached'), { status: 409 });
        return { applied: true, replayed: true, attempt };
      },
      async attempt() { return { attempt }; },
    },
  });
  await runner.dispatch({ type: 'restore', form });
  const queued = await runner.dispatch({
    type: 'retryAssessment', acknowledgePossibleProviderRepeat: true,
  });
  assert.equal(queued.assessmentRetryQueued, true);
  online = true;
  await assert.rejects(runner.dispatch({ type: 'sync' }), /retry limit reached/u);
  const observed = runner.snapshot();
  assert.equal(observed.assessmentRetryQueued, true,
    'a safe GET cannot acknowledge or retire the exact durable POST command');
  assert.equal(observed.saveStatus, 'queued');
  assert.deepEqual(observed.result.writingAssessment, terminal);
  const pendingDurable = JSON.parse(storage.getItem(key));
  assert.equal(pendingDurable.assessmentCommand.idempotencyKey,
    '653d49bf-b1c0-4db2-8459-b276dc5f950f');

  const acknowledged = await runner.dispatch({ type: 'sync' });
  assert.equal(acknowledged.assessmentRetryQueued, false);
  assert.equal(acknowledged.saveStatus, 'saved');
  assert.deepEqual(acknowledged.result.writingAssessment, terminal);
  const settledDurable = JSON.parse(storage.getItem(key));
  assert.equal(settledDurable.assessmentCommand, null);
});

test('manual 1–36 completion checkpoints the exact draft without submitting positions 37–38', async () => {
  const storage = memoryStorage();
  let saves = 0;
  let submits = 0;
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: (() => { let index = 0; return () => `01000000-0000-4000-8000-${String(++index).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: {
        id: '02000000-0000-4000-8000-000000000002', state: 'written_in_progress', revision: 0, draft: {},
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } }; },
      async saveDraft(input) {
        saves += 1;
        return { attempt: {
          id: input.attemptId, state: 'written_in_progress', revision: 1, draft: input.answers,
          formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
          policyId: ATTEMPT_POLICY_ID,
          writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
        } };
      },
      async submitWritten() { submits += 1; throw new Error('whole written submit is outside manual objective completion'); },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'answer', position: 19, answer: 'went' });

  const checkpoint = await runner.dispatch({ type: 'completeObjective' });

  assert.equal(saves, 1);
  assert.equal(submits, 0);
  assert.equal(checkpoint.phase, 'objective_completed');
  assert.equal(checkpoint.result.kind, 'objective_written_checkpoint');
  assert.equal(checkpoint.result.state, 'written_in_progress');
  assert.equal(checkpoint.result.blankPositions.length, 35);
  assert.equal(checkpoint.remainingSeconds, 180 * 60);
});

test('the same strict written attempt continues through 37–38 and submits only after explicit completion', async () => {
  const storage = memoryStorage();
  const saves = [];
  const submits = [];
  let revision = 0;
  let serverDraft = {};
  const base = {
    id: '02500000-0000-4000-8000-000000000002', state: 'written_in_progress',
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writingAssessment: assessmentState('not_started', 0),
  };
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'),
    uuid: (() => { let index = 0; return () => `01500000-0000-4000-8000-${String(++index).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: { ...base, revision, draft: serverDraft } }; },
      async saveDraft(input) {
        saves.push(structuredClone(input));
        revision += 1;
        serverDraft = structuredClone(input.answers);
        return { attempt: { ...base, revision, draft: serverDraft } };
      },
      async submitWritten(input) {
        submits.push(structuredClone(input));
        revision += 1;
        return { attempt: {
          ...base, state: 'oral_ready', revision, draft: serverDraft,
          writtenSubmittedAt: '2026-08-13T06:20:00.000Z',
          writingAssessment: {
            status: 'pending', mode: 'experimental', scoreKind: 'approximate',
            label: 'Предварительная автоматическая оценка', retryAllowed: false, retryCount: 0,
          },
        } };
      },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'answer', position: 19, answer: 'went' });
  await runner.dispatch({ type: 'completeObjective' });
  const writing = await runner.dispatch({ type: 'continueWriting' });
  assert.equal(writing.phase, 'writing');
  assert.equal(writing.currentPosition, 37);

  await assert.rejects(
    runner.dispatch({ type: 'answer', position: 37, answer: ['legacy', 'array'] }),
    /EGE_MOCK_WRITTEN_ANSWER_INVALID/u,
  );
  assert.equal(Object.hasOwn(runner.snapshot().answers, '37'), false);

  const answer37 = wordsForRunner(88, 'letter');
  const rawAnswer37 = `<b> ${answer37} </b>`;
  const answer38 = wordsForRunner(230, 'report');
  await runner.dispatch({ type: 'answer', position: 37, answer: rawAnswer37 });
  assert.equal(runner.snapshot().answers['37'], answer37,
    'the browser runner stores the same sanitized writing string the server assesses');
  await runner.dispatch({ type: 'answer', position: 38, answer: answer38 });
  const submitted = await runner.dispatch({ type: 'completeWritten' });

  assert.equal(saves.length, 2, 'objective checkpoint and final writing draft share the CAS seam');
  assert.equal(saves.at(-1).answers['37'], answer37);
  assert.equal(saves.at(-1).answers['38'], answer38);
  assert.equal(submits.length, 1);
  assert.equal(submits[0].expectedRevision, 2);
  assert.equal(submitted.phase, 'written_submitted');
  assert.equal(submitted.result.kind, 'written_submission');
  assert.deepEqual(submitted.result.submittedPositions, Array.from({ length: 38 }, (_, index) => index + 1));
  assert.equal(submitted.result.writingAssessment.status, 'pending');
  assert.equal(Object.hasOwn(submitted.result, 'score'), false);
});

test('offline restore converts a legacy writing array into one reviewable string before persistence', async () => {
  const storage = memoryStorage();
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const saved = {
    version: 1, owner: { username: 'learner', generation: 4 }, phase: 'writing',
    formIdentity: form.identity, catalogFingerprint: form.fingerprint,
    attemptId: '02500000-0000-4000-8000-000000000099',
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 1,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    answers: { 37: ['Dear Sam,', 'This draft must survive.'] },
    answerVersions: {
      37: { id: 'legacy-writing-array', recordedAt: 1, value: ['Dear Sam,', 'This draft must survive.'] },
    },
    audioPlays: {}, currentPosition: 37,
    preflight: { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 },
    pendingStartId: null, saveStatus: 'queued', compactedThrough: null, canceledSubmit: null,
    assetBlockedAt: 0, assetReadyAt: 1, audioLease: null, audioLeaseThrough: null,
    queue: [{
      type: 'draft', idempotencyKey: '02500000-0000-4000-8000-000000000098',
      expectedRevision: 1, answers: { 37: ['Dear Sam,', 'This draft must survive.'] },
      createdAt: 1, attempted: false, dirtyPositions: [37],
      dirtyVersions: { 37: 'legacy-writing-array' },
    }],
  };
  storage.setItem(key, JSON.stringify(saved));
  const restored = createEgeMockWrittenRunner({
    owner: saved.owner, storage, online: () => false,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'),
    assets: { async isReady() { return true; } }, transport: {},
  });

  const snapshot = await restored.dispatch({ type: 'restore', form });
  assert.equal(snapshot.answers['37'], 'Dear Sam,\nThis draft must survive.');
  assert.deepEqual(snapshot.writingDraftRecovery, { positions: [37], kind: 'legacy_array' });
  const durable = JSON.parse(storage.getItem(key));
  assert.equal(durable.answers['37'], 'Dear Sam,\nThis draft must survive.');
  assert.equal(durable.answerVersions['37'].value, 'Dear Sam,\nThis draft must survive.');
  assert.equal(durable.queue[0].answers['37'], 'Dear Sam,\nThis draft must survive.');
});

test('the strict 190-minute deadline queues the whole written submit while the editor is on task 37', async () => {
  const storage = memoryStorage();
  let online = true;
  let now = Date.parse('2026-08-13T06:20:00.000Z');
  let revision = 0;
  const attempt = (draft = {}) => ({
    id: '02500000-0000-4000-8000-000000000003', state: 'written_in_progress',
    revision, draft, formId: form.id, formRevision: form.revision,
    catalogFingerprint: form.fingerprint, ownerGeneration: SERVER_OWNER_GENERATION,
    policyId: ATTEMPT_POLICY_ID, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  });
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage,
    online: () => online, clock: () => now,
    uuid: (() => { let index = 0; return () => `01700000-0000-4000-8000-${String(++index).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: attempt() }; },
      async saveDraft(input) { revision += 1; return { attempt: attempt(input.answers) }; },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'completeObjective' });
  assert.equal((await runner.dispatch({ type: 'continueWriting' })).phase, 'writing');

  online = false;
  now = Date.parse('2026-08-13T09:10:00.000Z');
  const expired = await runner.dispatch({ type: 'tick' });
  assert.equal(expired.phase, 'submit_queued');
  assert.equal(expired.remainingSeconds, 0);
  assert.equal(expired.saveStatus, 'queued');
});

test('offline writing completion reloads exactly and replays the same final submit UUID', async () => {
  const storage = memoryStorage();
  let online = true;
  let revision = 0;
  let serverDraft = {};
  let submitApplied = false;
  const submits = [];
  const ids = [
    '01600000-0000-4000-8000-000000000001',
    '01600000-0000-4000-8000-000000000002',
    '01600000-0000-4000-8000-000000000003',
    '01600000-0000-4000-8000-000000000004',
    '01600000-0000-4000-8000-000000000005',
    '01600000-0000-4000-8000-000000000006',
  ];
  let idIndex = 0;
  const base = {
    id: '02600000-0000-4000-8000-000000000002', formId: form.id, formRevision: form.revision,
    catalogFingerprint: form.fingerprint, ownerGeneration: SERVER_OWNER_GENERATION,
    policyId: ATTEMPT_POLICY_ID, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const currentAttempt = () => ({
    ...base, revision, draft: structuredClone(serverDraft),
    state: submitApplied ? 'oral_ready' : 'written_in_progress',
    ...(submitApplied ? {
      writtenSubmittedAt: '2026-08-13T06:20:00.000Z',
      writingAssessment: assessmentState('pending', 1),
    } : {}),
  });
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'), uuid: () => ids[idIndex++],
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: {
      async start() { return { attempt: currentAttempt() }; },
      async attempt() { return { attempt: currentAttempt() }; },
      async saveDraft(input) {
        revision += 1;
        serverDraft = structuredClone(input.answers);
        return { attempt: currentAttempt() };
      },
      async submitWritten(input) {
        submits.push(structuredClone(input));
        if (!submitApplied) {
          submitApplied = true;
          revision += 1;
          throw Object.assign(new Error('connection dropped after submit'), { code: 'NETWORK_ERROR', status: 0 });
        }
        assert.equal(input.idempotencyKey, submits[0].idempotencyKey);
        return { replayed: true, attempt: currentAttempt() };
      },
    },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  await first.dispatch({ type: 'completeObjective' });
  await first.dispatch({ type: 'continueWriting' });
  const answer37 = wordsForRunner(120, 'letter');
  const answer38 = wordsForRunner(230, 'report');
  await first.dispatch({ type: 'answer', position: 37, answer: answer37 });
  await first.dispatch({ type: 'answer', position: 38, answer: answer38 });
  online = false;
  assert.equal((await first.dispatch({ type: 'completeWritten' })).phase, 'submit_queued');

  const restored = createEgeMockWrittenRunner(dependencies);
  await restored.dispatch({ type: 'restore', form });
  assert.equal(restored.snapshot().phase, 'submit_queued');
  assert.equal(restored.snapshot().answers['37'], answer37);
  assert.equal(restored.snapshot().answers['38'], answer38);
  online = true;
  const ambiguous = await restored.dispatch({ type: 'sync' });
  assert.equal(ambiguous.phase, 'submit_queued');
  const completed = await restored.dispatch({ type: 'sync' });
  assert.equal(completed.phase, 'written_submitted');
  assert.equal(completed.result.kind, 'written_submission');
  assert.equal(submits.length, 2);
});

test('manual final submission remains manual after a revision-conflict rebase', async () => {
  const storage = memoryStorage();
  let revision = 0;
  let serverDraft = {};
  let conflicted = false;
  let submitCalls = 0;
  const base = {
    id: '02700000-0000-4000-8000-000000000002', state: 'written_in_progress',
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writingAssessment: assessmentState('not_started', 0),
  };
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'),
    uuid: (() => { let index = 0; return () => `01700000-0000-4000-8000-${String(++index).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: { ...base, revision, draft: serverDraft } }; },
      async attempt() { return { attempt: { ...base, revision, draft: serverDraft } }; },
      async saveDraft(input) {
        revision += 1;
        serverDraft = structuredClone(input.answers);
        return { attempt: { ...base, revision, draft: serverDraft } };
      },
      async submitWritten() {
        submitCalls += 1;
        if (!conflicted) {
          conflicted = true;
          revision += 1;
          throw Object.assign(new Error('stale'), { code: 'EGE_MOCK_REVISION_CONFLICT', status: 409 });
        }
        revision += 1;
        return { attempt: {
          ...base, state: 'oral_ready', revision, draft: serverDraft,
          writtenSubmittedAt: '2026-08-13T06:20:00.000Z',
          writingAssessment: assessmentState('pending', 1),
        } };
      },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'completeObjective' });
  await runner.dispatch({ type: 'continueWriting' });
  await runner.dispatch({ type: 'answer', position: 37, answer: wordsForRunner(120, 'letter') });
  await runner.dispatch({ type: 'answer', position: 38, answer: wordsForRunner(230, 'report') });
  const submitted = await runner.dispatch({ type: 'completeWritten' });

  assert.equal(submitCalls, 2);
  assert.equal(submitted.phase, 'written_submitted');
  assert.equal(submitted.result.kind, 'written_submission');
});

test('temporary asset loss restores the writing editor phase instead of objective running', async () => {
  const storage = memoryStorage();
  let online = true;
  let assetsReady = true;
  let revision = 0;
  let serverDraft = {};
  const base = {
    id: '02800000-0000-4000-8000-000000000002', state: 'written_in_progress',
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writingAssessment: assessmentState('not_started', 0),
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'),
    uuid: (() => { let index = 0; return () => `01800000-0000-4000-8000-${String(++index).padStart(12, '0')}`; })(),
    assets: {
      async preflight() { assetsReady = true; return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return assetsReady; },
    },
    transport: {
      async start() { return { attempt: { ...base, revision, draft: serverDraft } }; },
      async saveDraft(input) {
        revision += 1;
        serverDraft = structuredClone(input.answers);
        return { attempt: { ...base, revision, draft: serverDraft } };
      },
      async attempt() { return { attempt: { ...base, revision, draft: serverDraft } }; },
    },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  await first.dispatch({ type: 'completeObjective' });
  await first.dispatch({ type: 'continueWriting' });
  assetsReady = false;
  online = false;
  const blocked = createEgeMockWrittenRunner(dependencies);
  await blocked.dispatch({ type: 'restore', form });
  assert.equal(blocked.snapshot().phase, 'asset_blocked');
  online = true;
  const recovered = createEgeMockWrittenRunner(dependencies);
  await recovered.dispatch({ type: 'restore', form });
  assert.equal(recovered.snapshot().phase, 'writing');
  assert.equal(recovered.snapshot().currentPosition, 37);
});

test('failed exact-asset preflight never asks the server to start a timer', async () => {
  let starts = 0;
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 },
    storage: memoryStorage(),
    online: () => true,
    assets: { async preflight() { throw Object.assign(new Error('digest mismatch'), { code: 'ASSET_DIGEST_MISMATCH' }); } },
    transport: { async start() { starts += 1; } },
  });

  await assert.rejects(runner.dispatch({ type: 'prepare', form }), { code: 'ASSET_DIGEST_MISMATCH' });
  assert.equal(runner.snapshot().phase, 'error');
  await assert.rejects(runner.dispatch({ type: 'start' }), /PREFLIGHT_REQUIRED/u);
  assert.equal(starts, 0);
});

test('asset preflight completes before the server starts the immutable written attempt', async () => {
  const calls = [];
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 },
    storage: memoryStorage(),
    online: () => true,
    clock: () => Date.parse('2026-08-13T06:00:00.000Z'),
    uuid: () => '10000000-0000-4000-8000-000000000001',
    assets: {
      async preflight(candidate) {
        calls.push(`preflight:${candidate.identity}`);
        return { identity: candidate.identity, fingerprint: candidate.fingerprint, assetCount: 20 };
      },
    },
    transport: {
      async start(input) {
        calls.push(`start:${input.formId}@${input.formRevision}`);
        return {
          attempt: {
            id: '20000000-0000-4000-8000-000000000002',
            state: 'written_in_progress', revision: 0, draft: {},
            formId: form.id, formRevision: form.revision,
            catalogFingerprint: form.fingerprint,
            policyId: ATTEMPT_POLICY_ID,
            writtenStartedAt: '2026-08-13T06:00:00.000Z',
            writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
          },
        };
      },
    },
  });

  await runner.dispatch({ type: 'prepare', form });
  assert.equal(runner.snapshot().phase, 'ready');
  await runner.dispatch({ type: 'start' });

  assert.deepEqual(calls, [
    'preflight:ege-en-2026-form-1@1',
    'start:ege-en-2026-form-1@1',
  ]);
  assert.equal(runner.snapshot().phase, 'running');
  assert.equal(runner.snapshot().remainingSeconds, 190 * 60);
  assert.equal(runner.snapshot().attemptId, '20000000-0000-4000-8000-000000000002');
  assert.equal(Object.hasOwn(runner.snapshot(), 'keys'), false);
  assert.equal(Object.hasOwn(runner.snapshot(), 'score'), false);
});

test('answers and navigation survive an offline reload for the exact owner attempt', async () => {
  const storage = memoryStorage();
  let online = true;
  let currentCalls = 0;
  const dependencies = {
    owner: { username: 'learner', generation: 4 },
    storage,
    online: () => online,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => '30000000-0000-4000-8000-000000000003',
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: {
      async start() {
        return { attempt: {
          id: '20000000-0000-4000-8000-000000000002', state: 'written_in_progress', revision: 0, draft: {},
          formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
          policyId: ATTEMPT_POLICY_ID,
          writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
        } };
      },
      async current() { currentCalls += 1; throw new Error('offline restore must not call the server'); },
    },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  online = false;
  await first.dispatch({ type: 'answer', position: 19, answer: 'went' });
  await first.dispatch({ type: 'answer', position: 1, answer: ['d', 'a', 'f', 'c', 'b', 'e'] });
  await first.dispatch({ type: 'navigate', position: 36 });

  const restored = createEgeMockWrittenRunner(dependencies);
  await restored.dispatch({ type: 'restore', form });
  const snapshot = restored.snapshot();
  assert.equal(snapshot.phase, 'running');
  assert.equal(snapshot.currentPosition, 36);
  assert.equal(snapshot.remainingSeconds, 180 * 60);
  assert.equal(snapshot.answers['19'], 'went');
  assert.deepEqual(snapshot.answers['1'], ['d', 'a', 'f', 'c', 'b', 'e']);
  assert.equal(snapshot.answeredCount, 2);
  assert.equal(snapshot.blankPositions.length, 34);
  assert.equal(currentCalls, 0);
});

test('CAS autosave replays one durable UUID after an ambiguous network failure', async () => {
  const storage = memoryStorage();
  let online = true;
  let uuidIndex = 0;
  const uuids = [
    '40000000-0000-4000-8000-000000000004',
    '50000000-0000-4000-8000-000000000005',
  ];
  const saves = [];
  let accepted = null;
  let failAfterApply = true;
  const transport = {
    async start() {
      return { attempt: {
        id: '20000000-0000-4000-8000-000000000002', state: 'written_in_progress', revision: 0, draft: {},
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } };
    },
    async saveDraft(input) {
      saves.push(JSON.parse(JSON.stringify(input)));
      if (!accepted) accepted = JSON.parse(JSON.stringify(input));
      else assert.deepEqual(input, accepted, 'an ambiguous save must replay exact material');
      if (failAfterApply) {
        failAfterApply = false;
        throw Object.assign(new Error('connection dropped after apply'), { code: 'NETWORK_ERROR', status: 0 });
      }
      return { replayed: true, attempt: {
        id: input.attemptId, state: 'written_in_progress', revision: 1,
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
        draft: input.answers,
      } };
    },
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => uuids[uuidIndex++],
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    }, transport,
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  await first.dispatch({ type: 'answer', position: 19, answer: 'went' });
  await first.dispatch({ type: 'sync' });
  assert.equal(first.snapshot().saveStatus, 'queued');
  assert.equal(saves.length, 1);

  const restored = createEgeMockWrittenRunner(dependencies);
  await restored.dispatch({ type: 'restore', form });
  await restored.dispatch({ type: 'sync' });
  assert.equal(saves.length, 2);
  assert.equal(restored.snapshot().revision, 1);
  assert.equal(restored.snapshot().saveStatus, 'saved');
});

test('strict deadline waits for authoritative current reconciliation and never trusts local early expiry', async () => {
  const storage = memoryStorage();
  let online = true;
  let now = Date.parse('2026-08-13T06:00:00.000Z');
  let serverExpired = false;
  let loseFirstTerminalResponse = true;
  let uuidIndex = 0;
  const uuids = [
    '60000000-0000-4000-8000-000000000006',
    '70000000-0000-4000-8000-000000000007',
    '80000000-0000-4000-8000-000000000008',
    '81000000-0000-4000-8000-000000000009',
    '82000000-0000-4000-8000-000000000010',
  ];
  let serverRevision = 0;
  let serverDraft = {};
  let submits = 0;
  const transport = {
    async start() {
      return { attempt: {
        id: '20000000-0000-4000-8000-000000000002', state: 'written_in_progress', revision: 0, draft: {},
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } };
    },
    async saveDraft(input) {
      serverRevision += 1;
      serverDraft = structuredClone(input.answers);
      return { attempt: {
        id: input.attemptId, state: 'written_in_progress', revision: serverRevision, draft: serverDraft,
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } };
    },
    async current() {
      if (!serverExpired) return { attempt: {
        id: '20000000-0000-4000-8000-000000000002', state: 'written_in_progress', revision: serverRevision,
        draft: serverDraft, formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } };
      serverRevision += 1;
      if (loseFirstTerminalResponse) {
        loseFirstTerminalResponse = false;
        throw Object.assign(new Error('authoritative deadline reconciled before disconnect'), {
          code: 'NETWORK_ERROR', status: 0,
        });
      }
      return { attempt: {
        id: '20000000-0000-4000-8000-000000000002', state: 'oral_ready', revision: serverRevision,
        draft: serverDraft,
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } };
    },
    async submitWritten() { submits += 1; throw new Error('deadline authority is reconciled by current'); },
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage,
    online: () => online, clock: () => now, uuid: () => uuids[uuidIndex++],
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    }, transport,
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  await first.dispatch({ type: 'answer', position: 19, answer: 'went' });
  await first.dispatch({ type: 'completeObjective' });
  assert.equal(first.snapshot().phase, 'objective_completed');
  online = false;
  now = Date.parse('2026-08-13T09:10:00.000Z');
  await first.dispatch({ type: 'tick' });
  assert.equal(first.snapshot().phase, 'submit_queued');
  assert.equal(first.snapshot().remainingSeconds, 0);

  online = true;
  await first.dispatch({ type: 'sync' });
  assert.equal(submits, 0);
  assert.equal(first.snapshot().phase, 'objective_completed');
  serverExpired = true;
  await first.dispatch({ type: 'tick' });
  assert.equal(first.snapshot().phase, 'submit_queued', 'ambiguous terminal reconciliation stays durable');

  const restored = createEgeMockWrittenRunner(dependencies);
  await restored.dispatch({ type: 'restore', form });
  const completed = restored.snapshot();
  assert.equal(submits, 0);
  assert.equal(completed.phase, 'written_submitted');
  assert.equal(completed.result.kind, 'objective_written_submission');
  assert.deepEqual(completed.result.submittedPositions, Array.from({ length: 38 }, (_, index) => index + 1));
  assert.equal(completed.result.blankPositions.length, 37);
  assert.equal(Object.hasOwn(completed.result, 'score'), false);
  assert.equal(Object.hasOwn(completed.result, 'keys'), false);
});

test('online reload reconciles the local shell with the exact current server attempt', async () => {
  const storage = memoryStorage();
  let currentCalls = 0;
  let online = true;
  const baseAttempt = {
    id: '90000000-0000-4000-8000-000000000009', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T08:00:00.000Z'),
    uuid: () => 'a0000000-0000-4000-8000-00000000000a',
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: {
      async start() {
        return { serverTimeMs: Date.parse('2026-08-13T06:00:00.000Z'), attempt: baseAttempt };
      },
      async current() {
        currentCalls += 1;
        return {
          serverTimeMs: Date.parse('2026-08-13T07:00:00.000Z'),
          attempt: { ...baseAttempt, revision: 3, draft: { 10: ['3', '2', '6', '8', '5', '1', '7'] } },
        };
      },
    },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });

  const restored = createEgeMockWrittenRunner(dependencies);
  await restored.dispatch({ type: 'restore', form });
  assert.equal(currentCalls, 1);
  assert.equal(restored.snapshot().revision, 3);
  assert.deepEqual(restored.snapshot().answers['10'], ['3', '2', '6', '8', '5', '1', '7']);
  assert.equal(restored.snapshot().remainingSeconds, 130 * 60);

  online = false;
  const offlineRestored = createEgeMockWrittenRunner(dependencies);
  await offlineRestored.dispatch({ type: 'restore', form });
  assert.equal(offlineRestored.snapshot().remainingSeconds, 130 * 60,
    'the signed response-boundary offset remains pinned through an offline restore');
});

test('offline continuation discovery is exact-owner and form bound', async () => {
  const storage = memoryStorage();
  const owner = { username: 'learner', generation: 4 };
  const runner = createEgeMockWrittenRunner({
    owner, storage, online: () => true,
    uuid: () => 'b0000000-0000-4000-8000-00000000000b',
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: { async start() { return { attempt: {
      id: 'c0000000-0000-4000-8000-00000000000c', state: 'written_in_progress', revision: 0, draft: {},
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    } }; } },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });

  assert.deepEqual(egeMockLocalContinuation(storage, owner, form), {
    attemptId: 'c0000000-0000-4000-8000-00000000000c', phase: 'running',
  });
  const storageKey = 'easyboost-ege-mock-written-v1:learner:4';
  const writing = JSON.parse(storage.getItem(storageKey));
  writing.phase = 'writing';
  writing.currentPosition = 37;
  storage.setItem(storageKey, JSON.stringify(writing));
  assert.deepEqual(egeMockLocalContinuation(storage, owner, form), {
    attemptId: 'c0000000-0000-4000-8000-00000000000c', phase: 'writing',
  });
  assert.equal(egeMockLocalContinuation(storage, { username: 'learner', generation: 5 }, form), null);
  assert.equal(egeMockLocalContinuation(storage, owner, { ...form, fingerprint: `sha256:${'f'.repeat(64)}` }), null);
});

test('omission review keeps a partially filled multi-answer position incomplete', async () => {
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage: memoryStorage(), online: () => true,
    uuid: (() => { let index = 0; return () => `d0000000-0000-4000-8000-${String(++index).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: { async start() { return { attempt: {
      id: 'e0000000-0000-4000-8000-00000000000e', state: 'written_in_progress', revision: 0, draft: {},
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    } }; } },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'answer', position: 1, answer: ['1'] });
  assert.equal(runner.snapshot().answeredCount, 0);
  assert.equal(runner.snapshot().blankPositions.includes(1), true);
  await runner.dispatch({ type: 'answer', position: 1, answer: ['1', '2', '3', '4', '5', '6'] });
  assert.equal(runner.snapshot().answeredCount, 1);
  assert.equal(runner.snapshot().blankPositions.includes(1), false);
});

test('all exact positions 1–36 round-trip through durable local continuation', async () => {
  const storage = memoryStorage();
  let online = true;
  let id = 0;
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:20:00.000Z'),
    uuid: () => `f0000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: { async start() { return { attempt: {
      id: 'a1000000-0000-4000-8000-000000000001', state: 'written_in_progress', revision: 0, draft: {},
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    } }; } },
  };
  const answers = {};
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  online = false;
  for (const item of form.positions.slice(0, 36)) {
    const presentation = item.presentation;
    let answer = `answer-${item.position}`;
    if (presentation.kind === 'listening_matching') answer = Array.from({ length: item.assetIds.length }, (_, index) => String(index + 1));
    if (presentation.kind === 'listening_true_false') answer = presentation.statements.map(() => 'true');
    if (presentation.kind === 'reading_headings') answer = presentation.texts.map((_, index) => String(index + 1));
    if (presentation.kind === 'reading_gaps') answer = presentation.segments.slice(0, -1).map((_, index) => String(index + 1));
    answers[String(item.position)] = answer;
    await first.dispatch({ type: 'answer', position: item.position, answer });
  }
  assert.equal(first.snapshot().answeredCount, 36);
  assert.deepEqual(first.snapshot().blankPositions, []);

  const restored = createEgeMockWrittenRunner(dependencies);
  await restored.dispatch({ type: 'restore', form });
  assert.deepEqual(restored.snapshot().answers, answers);
  assert.equal(restored.snapshot().answeredCount, 36);
});

test('server deadline exposes only the 30, 10, 5 and 1 minute warning bands', async () => {
  let now = Date.parse('2026-08-13T06:00:00.000Z');
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage: memoryStorage(), online: () => true,
    clock: () => now, uuid: () => 'a2000000-0000-4000-8000-000000000002',
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: { async start() { return { attempt: {
      id: 'a3000000-0000-4000-8000-000000000003', state: 'written_in_progress', revision: 0, draft: {},
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    } }; } },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  now = Date.parse('2026-08-13T08:39:00.000Z');
  assert.equal(runner.snapshot().timerWarningMinutes, null);
  now = Date.parse('2026-08-13T08:40:00.000Z');
  assert.equal(runner.snapshot().timerWarningMinutes, 30);
  now = Date.parse('2026-08-13T09:00:00.000Z');
  assert.equal(runner.snapshot().timerWarningMinutes, 10);
  now = Date.parse('2026-08-13T09:05:00.000Z');
  assert.equal(runner.snapshot().timerWarningMinutes, 5);
  now = Date.parse('2026-08-13T09:09:00.000Z');
  assert.equal(runner.snapshot().timerWarningMinutes, 1);
});

test('reload after an ambiguous start replays the persisted start UUID before creating another', async () => {
  const storage = memoryStorage();
  let starts = 0;
  let accepted = null;
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:00:00.000Z'),
    uuid: () => 'a4000000-0000-4000-8000-000000000004',
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: {
      async start(input) {
        starts += 1;
        if (!accepted) accepted = JSON.parse(JSON.stringify(input));
        else assert.deepEqual(input, accepted);
        if (starts === 1) throw Object.assign(new Error('applied then disconnected'), { code: 'NETWORK_ERROR', status: 0 });
        return { replayed: true, attempt: {
          id: 'a5000000-0000-4000-8000-000000000005', state: 'written_in_progress', revision: 0, draft: {},
          formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
          policyId: ATTEMPT_POLICY_ID,
          writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
        } };
      },
    },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await assert.rejects(first.dispatch({ type: 'start' }), { code: 'NETWORK_ERROR' });

  const restored = createEgeMockWrittenRunner(dependencies);
  await restored.dispatch({ type: 'restore', form });
  assert.equal(starts, 2);
  assert.equal(restored.snapshot().phase, 'running');
  assert.equal(restored.snapshot().attemptId, 'a5000000-0000-4000-8000-000000000005');
});

test('submit is never sent unless its replay material was durably stored first', async () => {
  const durable = memoryStorage();
  let rejectWrites = false;
  let submits = 0;
  const storage = {
    getItem(key) { return durable.getItem(key); },
    setItem(key, value) {
      if (rejectWrites) throw new DOMException('quota exceeded', 'QuotaExceededError');
      durable.setItem(key, value);
    },
  };
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:00:00.000Z'),
    uuid: () => 'a6000000-0000-4000-8000-000000000006',
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: {
        id: 'a7000000-0000-4000-8000-000000000007', state: 'written_in_progress', revision: 0, draft: {},
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } }; },
      async submitWritten() { submits += 1; throw new Error('must remain unreachable'); },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  rejectWrites = true;

  await assert.rejects(runner.dispatch({ type: 'submit' }), { code: 'EGE_MOCK_LOCAL_STORAGE_FAILED' });
  assert.equal(submits, 0);
  assert.equal(runner.snapshot().phase, 'running');
});

test('an invalid server revision or deadline cannot become timer authority', async () => {
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage: memoryStorage(), online: () => true,
    uuid: () => 'a8000000-0000-4000-8000-000000000008',
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: { async start() { return { attempt: {
      id: 'a9000000-0000-4000-8000-000000000009', state: 'written_in_progress', revision: -1, draft: {},
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: 'not-a-deadline',
    } }; } },
  });
  await runner.dispatch({ type: 'prepare', form });

  await assert.rejects(runner.dispatch({ type: 'start' }), /START_RESPONSE_INVALID/u);
  assert.equal(runner.snapshot().phase, 'ready');
  assert.equal(runner.snapshot().attemptId, null);
});

test('two offline tabs merge different durable answers before reconnect', async () => {
  const storage = memoryStorage();
  let online = true;
  let id = 0;
  let serverRevision = 0;
  let serverDraft = {};
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => `b0000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: {
      async start() { return { attempt: {
        id: 'b1000000-0000-4000-8000-000000000001', state: 'written_in_progress', revision: 0, draft: {},
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } }; },
      async saveDraft(input) {
        assert.equal(input.expectedRevision, serverRevision);
        serverDraft = JSON.parse(JSON.stringify(input.answers));
        serverRevision += 1;
        return { attempt: {
          id: input.attemptId, state: 'written_in_progress', revision: serverRevision, draft: serverDraft,
          formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
          policyId: ATTEMPT_POLICY_ID,
          writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
        } };
      },
    },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  online = false;
  const second = createEgeMockWrittenRunner(dependencies);
  await second.dispatch({ type: 'restore', form });

  await first.dispatch({ type: 'answer', position: 19, answer: 'went' });
  await second.dispatch({ type: 'answer', position: 20, answer: 'had gone' });
  const restored = createEgeMockWrittenRunner(dependencies);
  await restored.dispatch({ type: 'restore', form });
  assert.equal(restored.snapshot().answers['19'], 'went');
  assert.equal(restored.snapshot().answers['20'], 'had gone');
  online = true;
  await restored.dispatch({ type: 'sync' });
  assert.deepEqual(serverDraft, { 19: 'went', 20: 'had gone' });
  assert.equal(restored.snapshot().saveStatus, 'saved');
});

test('listening playback uses a persisted two-play contract', async () => {
  const storage = memoryStorage();
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: (() => { let id = 0; return () => `b2000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: { async start() { return { attempt: {
      id: 'b3000000-0000-4000-8000-000000000003', state: 'written_in_progress', revision: 0, draft: {},
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    } }; } },
  };
  const runner = createEgeMockWrittenRunner(dependencies);
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  let playing = await runner.dispatch({ type: 'audioStart', group: 'matching' });
  await runner.dispatch({ type: 'audioFinish', token: playing.audioInFlight.token });
  playing = await runner.dispatch({ type: 'audioStart', group: 'matching' });
  await runner.dispatch({ type: 'audioFinish', token: playing.audioInFlight.token });
  await assert.rejects(runner.dispatch({ type: 'audioStart', group: 'matching' }), /PLAYBACK_LIMIT/u);

  const restored = createEgeMockWrittenRunner(dependencies);
  await restored.dispatch({ type: 'restore', form });
  assert.equal(restored.snapshot().audioPlays.matching, 2);
});

test('repeated edits across reloads compact the durable queue and tombstones to a bounded envelope', async () => {
  const durable = memoryStorage();
  let latest = '';
  let online = true;
  let id = 0;
  const storage = {
    getItem(key) { return durable.getItem(key); },
    setItem(key, value) { latest = String(value); durable.setItem(key, value); },
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => online,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => `b6000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: { async start() { return { attempt: {
      id: 'b7000000-0000-4000-8000-000000000007', state: 'written_in_progress', revision: 0, draft: {},
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    } }; } },
  };
  let runner = createEgeMockWrittenRunner(dependencies);
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  online = false;
  for (let index = 0; index < 250; index += 1) {
    runner = createEgeMockWrittenRunner(dependencies);
    await runner.dispatch({ type: 'restore', form });
    await runner.dispatch({ type: 'answer', position: 19, answer: `answer-${index}` });
  }

  const saved = JSON.parse(latest);
  assert.equal(saved.queue.length, 1);
  assert.ok(!saved.acknowledgedIds || saved.acknowledgedIds.length <= 8);
  assert.ok(latest.length < 20_000, `durable state unexpectedly grew to ${latest.length} bytes`);
  assert.equal(runner.snapshot().answers['19'], 'answer-249');
});

test('terminal server state restores before an evicted audio cache is consulted', async () => {
  const storage = memoryStorage();
  const baseAttempt = {
    id: 'b8000000-0000-4000-8000-000000000008', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const first = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => 'b9000000-0000-4000-8000-000000000009',
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: { async start() { return { attempt: baseAttempt }; } },
  });
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  let cacheChecks = 0;
  const restored = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    assets: {
      async isReady() { cacheChecks += 1; return false; },
      async preflight() { throw new Error('terminal restore must not redownload audio'); },
    },
    transport: { async current() { return { attempt: {
      ...baseAttempt, state: 'oral_ready', revision: 1, draft: {},
    } }; } },
  });

  await restored.dispatch({ type: 'restore', form });
  assert.equal(restored.snapshot().phase, 'written_submitted');
  assert.equal(cacheChecks, 0);
});

test('an active online restore repairs an evicted exact audio cache without starting a second attempt', async () => {
  const storage = memoryStorage();
  const baseAttempt = {
    id: 'ba000000-0000-4000-8000-00000000000a', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const first = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => 'bb000000-0000-4000-8000-00000000000b',
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: { async start() { return { attempt: baseAttempt }; } },
  });
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  let preflights = 0;
  let starts = 0;
  const restored = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    assets: {
      async isReady() { return false; },
      async preflight() {
        preflights += 1;
        return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 };
      },
    },
    transport: {
      async current() { return { attempt: baseAttempt }; },
      async start() { starts += 1; throw new Error('must not restart'); },
    },
  });

  await restored.dispatch({ type: 'restore', form });
  assert.equal(restored.snapshot().phase, 'running');
  assert.equal(preflights, 1);
  assert.equal(starts, 0);
});

test('malformed terminal reconciliation cannot retire the durable deadline event', async () => {
  const storage = memoryStorage();
  let online = true;
  let now = Date.parse('2026-08-13T06:00:00.000Z');
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => online, clock: () => now,
    uuid: (() => { let id = 0; return () => `bc000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: {
        id: 'bd000000-0000-4000-8000-00000000000d', state: 'written_in_progress', revision: 0, draft: {},
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } }; },
      async current() { return { attempt: {
        id: 'bd000000-0000-4000-8000-00000000000d', state: 'oral_ready', revision: 1,
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      } }; },
      async submitWritten() { throw new Error('must not bypass authoritative current validation'); },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  online = false;
  now = Date.parse('2026-08-13T09:10:00.000Z');
  await runner.dispatch({ type: 'tick' });
  online = true;

  await assert.rejects(runner.dispatch({ type: 'sync' }), /RESTORE_RESPONSE_INVALID/u);
  assert.equal(runner.snapshot().phase, 'submit_queued');
  const durable = JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4'));
  assert.equal(durable.queue.some((event) => event.type === 'submit'), true);
});

test('objective checkpoint keeps its semantic marker across a definitive CAS rebase', async () => {
  let id = 0;
  let saves = 0;
  const base = {
    id: 'be000000-0000-4000-8000-00000000000e', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage: memoryStorage(), online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => `bf000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: base }; },
      async current() { return { attempt: { ...base, revision: 1, draft: { 20: 'had gone' } } }; },
      async saveDraft(input) {
        saves += 1;
        if (saves === 1) throw Object.assign(new Error('stale'), {
          code: 'EGE_MOCK_REVISION_CONFLICT', status: 409,
        });
        return { attempt: { ...base, revision: 2, draft: input.answers } };
      },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'answer', position: 19, answer: 'went' });

  await runner.dispatch({ type: 'completeObjective' });

  assert.equal(saves, 2);
  assert.equal(runner.snapshot().phase, 'objective_completed');
  assert.deepEqual(runner.snapshot().answers, { 19: 'went', 20: 'had gone' });
});

test('a locally terminal envelope restores offline without an audio cache', async () => {
  const storage = memoryStorage();
  const base = {
    id: 'c1000000-0000-4000-8000-000000000001', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const first = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T09:10:00.000Z'),
    uuid: (() => { let id = 0; return () => `c2000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: base }; },
      async current() { return { attempt: { ...base, state: 'oral_ready', revision: 1 } }; },
    },
  });
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  await first.dispatch({ type: 'tick' });
  assert.equal(first.snapshot().phase, 'written_submitted');
  assert.deepEqual(egeMockLocalContinuation(storage, { username: 'learner', generation: 4 }, form), {
    attemptId: base.id, phase: 'written_submitted',
  });
  let cacheChecks = 0;
  const restored = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => false,
    assets: { async isReady() { cacheChecks += 1; return false; } }, transport: {},
  });

  await restored.dispatch({ type: 'restore', form });
  assert.equal(restored.snapshot().phase, 'written_submitted');
  assert.equal(cacheChecks, 0);
});

test('definitive cross-tab CAS conflict rebases merged answers under a fresh UUID', async () => {
  const saves = [];
  let id = 0;
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage: memoryStorage(), online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => `b4000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: {
        id: 'b5000000-0000-4000-8000-000000000005', state: 'written_in_progress', revision: 0, draft: {},
        formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
        policyId: ATTEMPT_POLICY_ID,
        writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } }; },
      async current() { return { attempt: {
        id: 'b5000000-0000-4000-8000-000000000005', state: 'written_in_progress', revision: 1,
        draft: { 20: 'had gone' }, formId: form.id, formRevision: form.revision,
        policyId: ATTEMPT_POLICY_ID,
        catalogFingerprint: form.fingerprint, writtenStartedAt: '2026-08-13T06:00:00.000Z',
        writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      } }; },
      async saveDraft(input) {
        saves.push(JSON.parse(JSON.stringify(input)));
        if (saves.length === 1) throw Object.assign(new Error('stale'), {
          code: 'EGE_MOCK_REVISION_CONFLICT', status: 409,
        });
        return { attempt: {
          id: input.attemptId, state: 'written_in_progress', revision: 2, draft: input.answers,
          formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
          policyId: ATTEMPT_POLICY_ID,
          writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
        } };
      },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'answer', position: 19, answer: 'went' });
  await runner.dispatch({ type: 'sync' });

  assert.equal(saves.length, 2);
  assert.notEqual(saves[0].idempotencyKey, saves[1].idempotencyKey);
  assert.equal(saves[1].expectedRevision, 1);
  assert.deepEqual(saves[1].answers, { 19: 'went', 20: 'had gone' });
  assert.equal(runner.snapshot().revision, 2);
});

test('a draft event remains durable until the server proves the exact revision and applied answers', async () => {
  const storage = memoryStorage();
  const base = {
    id: 'c3000000-0000-4000-8000-000000000003', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: (() => { let id = 0; return () => `c4000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: base }; },
      async saveDraft() { return { attempt: { ...base, draft: { 19: 'different' } } }; },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'answer', position: 19, answer: 'went' });

  await assert.rejects(runner.dispatch({ type: 'sync' }), /DRAFT_RESPONSE_INVALID/u);
  const durable = JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4'));
  assert.equal(durable.queue.length, 1);
  assert.equal(durable.queue[0].attempted, true);
  assert.equal(runner.snapshot().saveStatus, 'queued');
});

test('authoritative active state releases a client-local early deadline lock', async () => {
  const storage = memoryStorage();
  const base = {
    id: 'c5000000-0000-4000-8000-000000000005', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T09:10:00.000Z'),
    uuid: (() => { let id = 0; return () => `c6000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: base }; },
      async current() { return { attempt: base }; },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });

  await runner.dispatch({ type: 'tick' });

  assert.equal(runner.snapshot().phase, 'running');
  const durable = JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4'));
  assert.equal(durable.queue.some((event) => event.type === 'submit'), false);
  await runner.dispatch({ type: 'tick' });
  assert.equal(runner.snapshot().phase, 'running');
  const repeated = JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4'));
  assert.equal(repeated.queue.some((event) => event.type === 'submit'), false);
});

test('an offline restore with a missing exact cache is durably blocked until online preflight', async () => {
  const storage = memoryStorage();
  let online = true;
  let preflights = 0;
  let failOnlinePreflight = true;
  let cacheReady = true;
  let now = Date.parse('2026-08-13T06:10:00.000Z');
  const base = {
    id: 'c7000000-0000-4000-8000-000000000007', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => online,
    clock: () => now,
    uuid: () => 'c8000000-0000-4000-8000-000000000008',
    assets: {
      async isReady() { return cacheReady; },
      async preflight() {
        preflights += 1;
        if (preflights > 1 && failOnlinePreflight) throw new Error('digest mismatch');
        return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 };
      },
    },
    transport: {
      async start() { return { attempt: base }; },
      async current() { return { attempt: base }; },
    },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  cacheReady = false;
  online = false;
  const blocked = createEgeMockWrittenRunner(dependencies);

  await blocked.dispatch({ type: 'restore', form });

  assert.equal(blocked.snapshot().phase, 'asset_blocked');
  assert.deepEqual(egeMockLocalContinuation(storage, { username: 'learner', generation: 4 }, form), {
    attemptId: base.id, phase: 'asset_blocked',
  });
  await assert.rejects(blocked.dispatch({ type: 'answer', position: 19, answer: 'went' }), /NOT_RUNNING/u);
  await assert.rejects(blocked.dispatch({ type: 'navigate', position: 2 }), /NOT_RUNNING/u);
  await assert.rejects(blocked.dispatch({ type: 'audioStart', group: 'matching' }), /NOT_RUNNING/u);
  online = true;
  await assert.rejects(blocked.dispatch({ type: 'restore', form }), /digest mismatch/u);
  assert.equal(blocked.snapshot().phase, 'asset_blocked');
  await assert.rejects(blocked.dispatch({ type: 'answer', position: 19, answer: 'went' }), /NOT_RUNNING/u);
  now = Date.parse(base.writtenDeadlineAt);
  await blocked.dispatch({ type: 'tick' });
  assert.equal(blocked.snapshot().phase, 'asset_blocked');
  now = Date.parse('2026-08-13T06:10:00.000Z');
  failOnlinePreflight = false;
  await blocked.dispatch({ type: 'restore', form });
  assert.equal(blocked.snapshot().phase, 'running');
  assert.equal(preflights, 3);
});

test('a first reconnect after the oral window adopts expired as a written terminal envelope', async () => {
  const storage = memoryStorage();
  let online = true;
  const base = {
    id: 'c9000000-0000-4000-8000-000000000009', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-01-01T06:00:00.000Z', writtenDeadlineAt: '2026-01-01T09:10:00.000Z',
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => online,
    clock: () => Date.parse('2026-01-01T09:10:00.000Z'),
    uuid: (() => { let id = 0; return () => `ca000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: base }; },
      async current() { return { attempt: null }; },
      async attempt(attemptId) {
        assert.equal(attemptId, base.id);
        return { attempt: { ...base, state: 'expired', revision: 2, draft: { 19: 'server' } } };
      },
    },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  online = false;
  await first.dispatch({ type: 'answer', position: 19, answer: 'offline' });
  await first.dispatch({ type: 'tick' });
  online = true;
  const restored = createEgeMockWrittenRunner(dependencies);

  await restored.dispatch({ type: 'restore', form });

  assert.equal(restored.snapshot().phase, 'written_submitted');
  assert.equal(restored.snapshot().result.state, 'expired');
  assert.equal(restored.snapshot().result.offlineChangesNotAccepted, true);
  assert.equal(restored.snapshot().answers['19'], 'server');
  const durable = JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4'));
  assert.equal(durable.queue.length, 0);
});

test('an online restore revalidates a locally terminal envelope through the exact attempt endpoint', async () => {
  const storage = memoryStorage();
  const base = {
    id: 'cb000000-0000-4000-8000-00000000000b', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-01-01T06:00:00.000Z', writtenDeadlineAt: '2026-01-01T09:10:00.000Z',
  };
  let exactCalls = 0;
  const first = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse(base.writtenDeadlineAt),
    uuid: (() => { let id = 0; return () => `cc000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: base }; },
      async current() { return { attempt: { ...base, state: 'oral_ready', revision: 1 } }; },
    },
  });
  await first.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  await first.dispatch({ type: 'tick' });
  assert.equal(first.snapshot().phase, 'written_submitted');

  const restored = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    assets: {},
    transport: {
      async current() { throw new Error('current projection must not replace exact continuation'); },
      async attempt(attemptId) {
        exactCalls += 1;
        assert.equal(attemptId, base.id);
        return { attempt: { ...base, state: 'expired', revision: 2 } };
      },
    },
  });

  await restored.dispatch({ type: 'restore', form });

  assert.equal(exactCalls, 1);
  assert.equal(restored.snapshot().phase, 'written_submitted');
  assert.equal(restored.snapshot().result.state, 'expired');
});

test('objective completion intent survives a conflict from an older attempted autosave', async () => {
  const storage = memoryStorage();
  let saveCalls = 0;
  let releaseSave;
  let markSaveStarted;
  const saveStarted = new Promise((resolve) => { markSaveStarted = resolve; });
  const saveRelease = new Promise((resolve) => { releaseSave = resolve; });
  let id = 0;
  const base = {
    id: 'cd000000-0000-4000-8000-00000000000d', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => `ce000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: base }; },
      async current() { return { attempt: { ...base, revision: 1, draft: { 20: 'server' } } }; },
      async saveDraft(input) {
        saveCalls += 1;
        if (saveCalls === 1) {
          markSaveStarted();
          await saveRelease;
          throw Object.assign(new Error('stale'), { code: 'EGE_MOCK_REVISION_CONFLICT', status: 409 });
        }
        return { attempt: { ...base, revision: 2, draft: input.answers } };
      },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'answer', position: 19, answer: 'local' });
  const syncing = runner.dispatch({ type: 'sync' });
  await saveStarted;
  const completing = runner.dispatch({ type: 'completeObjective' });
  releaseSave();
  await Promise.all([syncing, completing]);

  assert.equal(runner.snapshot().phase, 'objective_completed');
  assert.equal(runner.snapshot().saveStatus, 'saved');
  assert.deepEqual(runner.snapshot().answers, { 19: 'local', 20: 'server' });
});

test('a newer terminal envelope atomically replaces an older terminal result across tabs', async () => {
  const storage = memoryStorage();
  const base = {
    id: 'cf000000-0000-4000-8000-00000000000f', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-01-01T06:00:00.000Z', writtenDeadlineAt: '2026-01-01T09:10:00.000Z',
  };
  let serverState = 'oral_ready';
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse(base.writtenDeadlineAt),
    uuid: (() => { let id = 0; return () => `d0000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: base }; },
      async attempt() { return { attempt: { ...base, state: serverState, revision: serverState === 'expired' ? 2 : 1 } }; },
    },
  };
  const older = createEgeMockWrittenRunner(dependencies);
  await older.dispatch({ type: 'prepare', form });
  await older.dispatch({ type: 'start' });
  await older.dispatch({ type: 'tick' });
  assert.equal(older.snapshot().result.state, 'oral_ready');
  serverState = 'expired';
  const newer = createEgeMockWrittenRunner(dependencies);
  await newer.dispatch({ type: 'restore', form });
  assert.equal(newer.snapshot().result.state, 'expired');

  await older.dispatch({ type: 'refreshLocal' });

  assert.equal(older.snapshot().revision, 2);
  assert.equal(older.snapshot().result.state, 'expired');
});

test('a focused stale tab atomically adopts a higher assessment revision from shared storage', async () => {
  const storage = memoryStorage();
  const owner = { username: 'learner', generation: 4 };
  const attemptId = 'cf000000-0000-4000-8000-000000000010';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const blocked = assessmentState('pending', 4, { runDisposition: 'subscription_required' });
  const renewed = assessmentState('in_progress', 5);
  const attempt = (writingAssessment) => ({
    id: attemptId, state: 'oral_ready', revision: 2, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z', writingAssessment,
  });
  storage.setItem(key, JSON.stringify({
    version: 1, owner, phase: 'written_submitted', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 2,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
    preflight: null, pendingStartId: null, saveStatus: 'saved', queue: [],
    compactedThrough: null, canceledSubmit: null, assessmentCommand: null,
    assessmentCommandThrough: null, assetBlockedAt: 0, assetReadyAt: 0,
    assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
    result: { kind: 'written_submission', state: 'oral_ready', writingAssessment: blocked },
  }));
  let online = false;
  const dependencies = {
    owner, storage, online: () => online, assets: {},
    transport: { async attempt() { return { attempt: attempt(renewed) }; } },
  };
  const focused = createEgeMockWrittenRunner(dependencies);
  await focused.dispatch({ type: 'restore', form });
  const focusedBefore = focused.snapshot();
  assert.equal(focusedBefore.result.writingAssessment.assessmentRevision, 4);

  online = true;
  const background = createEgeMockWrittenRunner(dependencies);
  const advanced = await background.dispatch({ type: 'restore', form });
  assert.equal(advanced.result.writingAssessment.assessmentRevision, 5);
  assert.equal(advanced.result.writingAssessment.runDisposition, undefined);

  const refreshed = await focused.dispatch({ type: 'refreshLocal' });
  assert.equal(refreshed.phase, focusedBefore.phase,
    'a storage/focus refresh does not replace the active screen phase');
  assert.equal(refreshed.currentPosition, focusedBefore.currentPosition,
    'a storage/focus refresh preserves the learner focus position');
  assert.deepEqual(refreshed.result, advanced.result,
    'the higher assessment revision wins as one complete result projection');
});

test('a divergent equal assessment revision fails closed during a cross-tab refresh', async () => {
  const storage = memoryStorage();
  const owner = { username: 'learner', generation: 4 };
  const attemptId = 'cf000000-0000-4000-8000-000000000011';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const current = assessmentState('in_progress', 5);
  const base = {
    version: 1, owner, phase: 'written_submitted', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 2,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 38,
    preflight: null, pendingStartId: null, saveStatus: 'saved', queue: [],
    compactedThrough: null, canceledSubmit: null, assessmentCommand: null,
    assessmentCommandThrough: null, assetBlockedAt: 0, assetReadyAt: 0,
    assetResumePhase: null, audioLease: null, audioLeaseThrough: null,
    result: { kind: 'written_submission', state: 'oral_ready', writingAssessment: current },
  };
  storage.setItem(key, JSON.stringify(base));
  const focused = createEgeMockWrittenRunner({ owner, storage, online: () => false, assets: {} });
  await focused.dispatch({ type: 'restore', form });
  const before = focused.snapshot();
  storage.setItem(key, JSON.stringify({
    ...base,
    result: {
      ...base.result,
      writingAssessment: assessmentState('retryable', 5, { retryAllowed: true }),
    },
  }));

  await assert.rejects(focused.dispatch({ type: 'refreshLocal' }), {
    code: 'EGE_MOCK_ASSESSMENT_RESPONSE_INVALID',
  });
  assert.deepEqual(focused.snapshot(), before,
    'equal-version disagreement cannot partially overwrite the focused tab');
  assert.equal(JSON.parse(storage.getItem(key)).result.writingAssessment.status, 'retryable',
    'the failing tab does not overwrite the conflicting durable projection');
});

test('a rejected equal-revision cross-tab merge leaves every live runner clock byte unchanged', async () => {
  const storage = memoryStorage();
  const owner = { username: 'learner', generation: 4 };
  const attemptId = 'cf000000-0000-4000-8000-000000000012';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const current = assessmentState('ambiguous', 5, {
    retryAllowed: true, retryWarning: EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
  });
  const base = durableSubmittedState({ owner, attemptId, writingAssessment: current });
  storage.setItem(key, JSON.stringify(base));
  const runner = createEgeMockWrittenRunner({
    owner, storage, online: () => false, localNow: () => 1, assets: {},
    uuid: () => 'cf000000-0000-4000-8000-000000000013',
  });
  await runner.dispatch({ type: 'restore', form });
  const before = runner.snapshot();

  storage.setItem(key, JSON.stringify({
    ...base,
    queue: [{
      type: 'draft', idempotencyKey: 'cf000000-0000-4000-8000-000000000014',
      createdAt: 9_000, expectedRevision: 2, answers: {}, dirtyPositions: [],
      dirtyVersions: {},
    }],
    result: {
      ...base.result,
      writingAssessment: assessmentState('retryable', 5, { retryAllowed: true }),
    },
  }));
  await assert.rejects(runner.dispatch({ type: 'refreshLocal' }), {
    code: 'EGE_MOCK_ASSESSMENT_RESPONSE_INVALID',
  });
  assert.deepEqual(runner.snapshot(), before);

  storage.setItem(key, JSON.stringify(base));
  await runner.dispatch({
    type: 'retryAssessment', acknowledgePossibleProviderRepeat: true,
  });
  const durable = JSON.parse(storage.getItem(key));
  assert.equal(durable.assessmentCommand.createdAt, 1,
    'normalizing a rejected detached candidate cannot advance the live logical clock');
});

test('durable assessment commands accept only the known action enum and one legacy missing-action shape', async () => {
  const owner = { username: 'learner', generation: 4 };
  const attemptId = 'cf000000-0000-4000-8000-000000000015';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const retryable = assessmentState('retryable', 2, { retryAllowed: true });
  const invalidStorage = memoryStorage();
  invalidStorage.setItem(key, JSON.stringify(durableSubmittedState({
    owner, attemptId, writingAssessment: retryable,
    extra: {
      assessmentCommand: {
        action: 'unknown_future_action',
        idempotencyKey: 'cf000000-0000-4000-8000-000000000016', createdAt: 1,
        acknowledgePossibleProviderRepeat: false,
      },
    },
  })));
  const invalid = createEgeMockWrittenRunner({
    owner, storage: invalidStorage, online: () => false, assets: {},
  });
  await assert.rejects(invalid.dispatch({ type: 'restore', form }), {
    code: 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID',
  });

  const legacyStorage = memoryStorage();
  const legacyState = durableSubmittedState({
    owner, attemptId, writingAssessment: retryable,
    extra: {
      assessmentRetry: {
        idempotencyKey: 'cf000000-0000-4000-8000-000000000017', createdAt: 1,
        acknowledgePossibleProviderRepeat: false,
      },
    },
  });
  delete legacyState.assessmentCommand;
  legacyStorage.setItem(key, JSON.stringify(legacyState));
  const legacy = createEgeMockWrittenRunner({
    owner, storage: legacyStorage, online: () => false, assets: {},
  });
  const restored = await legacy.dispatch({ type: 'restore', form });
  assert.equal(restored.assessmentRetryQueued, true,
    'only the unreleased assessmentRetry shape without action migrates to retry');
  await legacy.dispatch({ type: 'retryAssessment' });
  assert.equal(JSON.parse(legacyStorage.getItem(key)).assessmentCommand.action, 'retry');
});

test('restore fails closed for every malformed recognized durable assessment command', async () => {
  const owner = { username: 'learner', generation: 4 };
  const attemptId = 'cf000000-0000-4000-8000-000000000024';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const pending = assessmentState('pending', 1);
  const validRun = {
    action: 'run', idempotencyKey: 'cf000000-0000-4000-8000-000000000025',
    createdAt: 2, acknowledgePossibleProviderRepeat: false,
  };
  const cases = [
    ['missing UUID', { ...validRun, idempotencyKey: undefined }],
    ['invalid UUID', { ...validRun, idempotencyKey: 'not-a-uuid' }],
    ['negative ordering', { ...validRun, createdAt: -1 }],
    ['fractional ordering', { ...validRun, createdAt: 1.5 }],
    ['unsafe ordering', { ...validRun, createdAt: Number.MAX_SAFE_INTEGER + 1 }],
    ['missing acknowledgement flag', (() => {
      const command = { ...validRun };
      delete command.acknowledgePossibleProviderRepeat;
      return command;
    })()],
    ['run acknowledgement is not false', {
      ...validRun, acknowledgePossibleProviderRepeat: true,
    }],
    ['invalid explicit renewal marker', { ...validRun, explicitRenewal: 'yes' }],
    ['not after the durable watermark', validRun, {
      createdAt: 2, idempotencyKey: validRun.idempotencyKey,
    }],
  ];

  for (const [label, assessmentCommand, assessmentCommandThrough = null] of cases) {
    const storage = memoryStorage();
    storage.setItem(key, JSON.stringify(durableSubmittedState({
      owner, attemptId, writingAssessment: pending,
      extra: { assessmentCommand, assessmentCommandThrough },
    })));
    const before = storage.getItem(key);
    let minted = 0;
    let transported = 0;
    const runner = createRawEgeMockWrittenRunner({
      owner, storage, online: () => false, assets: {},
      uuid() {
        minted += 1;
        return 'cf000000-0000-4000-8000-000000000026';
      },
      transport: {
        async runAssessment() {
          transported += 1;
          throw new Error('must not run');
        },
      },
    });

    await assert.rejects(runner.dispatch({ type: 'restore', form }), {
      code: 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID',
    }, label);
    assert.equal(minted, 0, `${label}: restore cannot replace the paid-call UUID`);
    assert.equal(transported, 0, `${label}: restore cannot dispatch provider work`);
    assert.equal(storage.getItem(key), before, `${label}: durable bytes remain unchanged`);
  }
});

test('a malformed higher-revision assessment response preserves the prior projection and UUID', async () => {
  const owner = { username: 'learner', generation: 4 };
  const attemptId = 'cf000000-0000-4000-8000-000000000027';
  const commandId = 'cf000000-0000-4000-8000-000000000028';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const pending = assessmentState('pending', 1);
  const storage = memoryStorage();
  let online = false;
  storage.setItem(key, JSON.stringify(durableSubmittedState({
    owner, attemptId, writingAssessment: pending,
    extra: {
      saveStatus: 'queued',
      assessmentCommand: {
        action: 'run', idempotencyKey: commandId, createdAt: 1,
        acknowledgePossibleProviderRepeat: false,
      },
    },
  })));
  const invalidAssessment = {
    status: 'retryable', assessmentRevision: 2, mode: 'official', scoreKind: 'final',
    warning: '', label: 'Final assessment', retryAllowed: false, retryCount: 0,
  };
  const runner = createRawEgeMockWrittenRunner({
    owner, storage, online: () => online, assets: {},
    transport: {
      async runAssessment() {
        return {
          applied: true, replayed: false,
          attempt: {
            id: attemptId, state: 'oral_ready', revision: 2, draft: {},
            formId: form.id, formRevision: form.revision,
            catalogFingerprint: form.fingerprint,
            ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
            writtenStartedAt: '2026-08-13T06:00:00.000Z',
            writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
            writtenSubmittedAt: '2026-08-13T06:20:00.000Z',
            writingAssessment: invalidAssessment,
          },
        };
      },
    },
  });

  await runner.dispatch({ type: 'restore', form });
  online = true;
  await assert.rejects(runner.dispatch({ type: 'sync' }), {
    code: 'EGE_MOCK_ASSESSMENT_RESPONSE_INVALID',
  });
  assert.deepEqual(runner.snapshot().result.writingAssessment, pending);
  assert.equal(runner.snapshot().assessmentRunQueued, true);
  assert.equal(JSON.parse(storage.getItem(key)).assessmentCommand.idempotencyKey, commandId,
    'an invalid body cannot acknowledge or replace the durable command UUID');
});

test('assessment acknowledgements preserve applied on exact replay and reject replay without apply', async () => {
  const owner = { username: 'learner', generation: 4 };
  const attemptId = 'cf000000-0000-4000-8000-000000000018';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const pending = assessmentState('pending', 1);
  const completed = assessmentState('completed', 2);
  const attempt = {
    id: attemptId, state: 'oral_ready', revision: 2, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    ownerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    writtenSubmittedAt: '2026-08-13T06:20:00.000Z', writingAssessment: completed,
  };

  async function deliver(flags, suffix) {
    const storage = memoryStorage();
    let online = false;
    storage.setItem(key, JSON.stringify(durableSubmittedState({
      owner, attemptId, writingAssessment: pending,
      extra: {
        saveStatus: 'queued',
        assessmentCommand: {
          action: 'run', idempotencyKey: `cf000000-0000-4000-8000-0000000000${suffix}`,
          createdAt: 1, acknowledgePossibleProviderRepeat: false,
        },
      },
    })));
    const runner = createEgeMockWrittenRunner({
      owner, storage, online: () => online, assets: {},
      transport: { async runAssessment() { return { ...flags, attempt }; } },
    });
    await runner.dispatch({ type: 'restore', form });
    online = true;
    return { runner, storage, delivered: runner.dispatch({ type: 'sync' }) };
  }

  const first = await deliver({ applied: true, replayed: false }, '19');
  assert.equal((await first.delivered).assessmentRunQueued, false);

  const replay = await deliver({ applied: true, replayed: true }, '20');
  assert.equal((await replay.delivered).assessmentRunQueued, false,
    'an exact replay retains applied=true and retires the matching durable UUID');

  const invalid = await deliver({ applied: false, replayed: true }, '21');
  await assert.rejects(invalid.delivered, { code: 'EGE_MOCK_ASSESSMENT_RESPONSE_INVALID' });
  assert.equal(invalid.runner.snapshot().assessmentRunQueued, true,
    'a replay flag without applied cannot retire the durable UUID');

  const exhaustedStorage = memoryStorage();
  let exhaustedOnline = false;
  const assessmentRequestIds = [];
  exhaustedStorage.setItem(key, JSON.stringify(durableSubmittedState({
    owner, attemptId, writingAssessment: {
      ...pending, assessmentRevision: 4,
    },
    extra: {
      saveStatus: 'queued',
      assessmentCommand: {
        action: 'run', idempotencyKey: 'cf000000-0000-4000-8000-000000000022',
        createdAt: 1, acknowledgePossibleProviderRepeat: false,
      },
    },
  })));
  const exhausted = createEgeMockWrittenRunner({
    owner, storage: exhaustedStorage, online: () => exhaustedOnline, assets: {},
    transport: {
      async runAssessment({ idempotencyKey }) {
        assessmentRequestIds.push(idempotencyKey);
        throw Object.assign(new Error('ASSESSMENT_REVISION_EXHAUSTED'), {
          code: 'ASSESSMENT_REVISION_EXHAUSTED', status: 409,
        });
      },
    },
  });
  await exhausted.dispatch({ type: 'restore', form });
  exhaustedOnline = true;
  const blocked = await exhausted.dispatch({ type: 'sync' });
  assert.equal(blocked.assessmentRunQueued, false);
  assert.equal(blocked.assessmentRunBlocked, true,
    'a bounded nonretryable exhaustion retires and durably blocks the automatic UUID');
  const maximumAttempt = {
    ...attempt,
    writingAssessment: { ...pending, assessmentRevision: Number.MAX_SAFE_INTEGER },
  };
  const reloaded = createEgeMockWrittenRunner({
    owner, storage: exhaustedStorage, online: () => true, assets: {},
    uuid: () => 'cf000000-0000-4000-8000-000000000023',
    transport: {
      async attempt() { return { attempt: maximumAttempt }; },
      async runAssessment({ idempotencyKey }) {
        assessmentRequestIds.push(idempotencyKey);
        throw Object.assign(new Error('ASSESSMENT_REVISION_EXHAUSTED'), {
          code: 'ASSESSMENT_REVISION_EXHAUSTED', status: 409,
        });
      },
    },
  });
  const restoredBlock = await reloaded.dispatch({ type: 'restore', form });
  assert.equal(restoredBlock.assessmentRunBlocked, true);
  assert.equal(restoredBlock.assessmentRunQueued, false,
    'MAX reconciliation cannot manufacture another exhausted assessment command');
  assert.deepEqual(assessmentRequestIds, ['cf000000-0000-4000-8000-000000000022'],
    'stale-device reconciliation keeps the original exhausted UUID as the only POST');
});

test('durable assessment exhaustion atomically retires pending commands across restore and merge', async () => {
  const owner = { username: 'learner', generation: 4 };
  const attemptId = 'cf000000-0000-4000-8000-000000000018';
  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const pending = assessmentState('pending', 5);

  async function restoreBlockedCommand(blockedRevision, commandId) {
    const storage = memoryStorage();
    let calls = 0;
    storage.setItem(key, JSON.stringify(durableSubmittedState({
      owner, attemptId, writingAssessment: pending,
      extra: {
        saveStatus: 'queued', assessmentCommandBlockedRevision: blockedRevision,
        assessmentCommand: {
          action: 'run', idempotencyKey: commandId, createdAt: 2,
          acknowledgePossibleProviderRepeat: false,
        },
      },
    })));
    const runner = createEgeMockWrittenRunner({
      owner, storage, online: () => true, assets: {},
      transport: {
        async runAssessment() {
          calls += 1;
          throw Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR', status: 503 });
        },
      },
    });
    const restored = await runner.dispatch({ type: 'restore', form });
    const durable = JSON.parse(storage.getItem(key));
    return {
      blocked: restored.assessmentRunBlocked, queued: restored.assessmentRunQueued, calls,
      command: durable.assessmentCommand,
      through: durable.assessmentCommandThrough?.idempotencyKey,
    };
  }

  const currentCommandId = 'cf000000-0000-4000-8000-000000000024';
  const legacyCommandId = 'cf000000-0000-4000-8000-000000000025';
  const current = await restoreBlockedCommand(Number.MAX_SAFE_INTEGER, currentCommandId);
  const legacy = await restoreBlockedCommand(4, legacyCommandId);

  const crossTabStorage = memoryStorage();
  const crossTabCommandId = 'cf000000-0000-4000-8000-000000000027';
  let online = false;
  let calls = 0;
  crossTabStorage.setItem(key, JSON.stringify(durableSubmittedState({
    owner, attemptId, writingAssessment: pending,
    extra: {
      saveStatus: 'queued', assessmentCommand: {
        action: 'run', idempotencyKey: crossTabCommandId, createdAt: 2,
        acknowledgePossibleProviderRepeat: false,
      },
    },
  })));
  const crossTab = createEgeMockWrittenRunner({
    owner, storage: crossTabStorage, online: () => online, assets: {},
    transport: {
      async runAssessment() {
        calls += 1;
        throw Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR', status: 503 });
      },
    },
  });
  await crossTab.dispatch({ type: 'restore', form });
  crossTabStorage.setItem(key, JSON.stringify(durableSubmittedState({
    owner, attemptId, writingAssessment: pending,
    extra: {
      assessmentCommandBlockedRevision: Number.MAX_SAFE_INTEGER,
      assessmentCommandThrough: {
        createdAt: 1, idempotencyKey: 'cf000000-0000-4000-8000-000000000026',
      },
    },
  })));
  online = true;
  const merged = await crossTab.dispatch({ type: 'sync' });
  const mergedDurable = JSON.parse(crossTabStorage.getItem(key));
  const crossTabResult = {
    blocked: merged.assessmentRunBlocked, queued: merged.assessmentRunQueued, calls,
    command: mergedDurable.assessmentCommand,
    through: mergedDurable.assessmentCommandThrough?.idempotencyKey,
  };

  assert.deepEqual([current, legacy, crossTabResult], [
    { blocked: true, queued: false, calls: 0, command: null, through: currentCommandId },
    { blocked: true, queued: false, calls: 0, command: null, through: legacyCommandId },
    { blocked: true, queued: false, calls: 0, command: null, through: crossTabCommandId },
  ]);
});

test('a CAS rebase keeps newer server answers at positions untouched by the local draft', async () => {
  const storage = memoryStorage();
  const base = {
    id: 'd1000000-0000-4000-8000-000000000001', state: 'written_in_progress', revision: 0,
    draft: { 19: 'old' },
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  let saves = 0;
  let rebasedPayload;
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: (() => { let id = 0; return () => `d2000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: base }; },
      async attempt() { return { attempt: { ...base, revision: 1, draft: { 19: 'new-from-other-tab' } } }; },
      async saveDraft(input) {
        saves += 1;
        if (saves === 1) throw Object.assign(new Error('stale'), { code: 'EGE_MOCK_REVISION_CONFLICT', status: 409 });
        rebasedPayload = input.answers;
        return { attempt: { ...base, revision: 2, draft: input.answers } };
      },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'answer', position: 20, answer: 'local-edit' });
  await runner.dispatch({ type: 'sync' });

  assert.deepEqual(rebasedPayload, { 19: 'new-from-other-tab', 20: 'local-edit' });
  assert.deepEqual(runner.snapshot().answers, rebasedPayload);
});

test('a durable cross-tab asset block overrides a stale running tab until exact recovery', async () => {
  const storage = memoryStorage();
  const lockManager = serialLockManager();
  let online = true;
  let cacheReady = true;
  const base = {
    id: 'd3000000-0000-4000-8000-000000000003', state: 'written_in_progress', revision: 0,
    draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, lockManager, online: () => online,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: (() => { let id = 0; return () => `d4000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: {
      async isReady() { return cacheReady; },
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
    },
    transport: { async start() { return { attempt: base }; }, async attempt() { return { attempt: base }; } },
  };
  const stale = createEgeMockWrittenRunner(dependencies);
  await stale.dispatch({ type: 'prepare', form });
  await stale.dispatch({ type: 'start' });
  const blocker = createEgeMockWrittenRunner(dependencies);
  online = false;
  cacheReady = false;
  await blocker.dispatch({ type: 'restore', form });
  assert.equal(blocker.snapshot().phase, 'asset_blocked');

  await stale.dispatch({ type: 'refreshLocal' });
  assert.equal(stale.snapshot().phase, 'asset_blocked');
  await assert.rejects(stale.dispatch({ type: 'answer', position: 19, answer: 'must-not-save' }), /NOT_RUNNING/u);
  assert.equal(JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4')).phase, 'asset_blocked');

  online = true;
  cacheReady = true;
  await stale.dispatch({ type: 'restore', form });
  assert.equal(stale.snapshot().phase, 'running');
});

test('cross-tab merge keeps the resume phase bound to the winning asset timestamp', async () => {
  const storage = memoryStorage();
  let online = true;
  let cacheReady = true;
  const base = {
    id: 'd6000000-0000-4000-8000-000000000006', state: 'written_in_progress', revision: 0,
    draft: {}, formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  let localNow = Date.parse('2026-08-13T06:10:00.000Z');
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => online,
    clock: () => localNow, localNow: () => localNow,
    assets: {
      async isReady() { return cacheReady; },
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
    },
    transport: { async start() { return { attempt: base }; }, async attempt() { return { attempt: base }; } },
  };
  const stale = createEgeMockWrittenRunner(dependencies);
  await stale.dispatch({ type: 'prepare', form });
  await stale.dispatch({ type: 'start' });
  online = false;
  cacheReady = false;
  await stale.dispatch({ type: 'restore', form });
  assert.equal(stale.snapshot().phase, 'asset_blocked');

  const key = 'easyboost-ege-mock-written-v1:learner:4';
  const newer = JSON.parse(storage.getItem(key));
  newer.phase = 'asset_blocked';
  newer.assetBlockedAt += 100;
  newer.assetResumePhase = 'writing';
  storage.setItem(key, JSON.stringify(newer));

  await stale.dispatch({ type: 'refreshLocal' });
  localNow += 1_000;
  await stale.dispatch({ type: 'tick' });
  assert.equal(JSON.parse(storage.getItem(key)).assetResumePhase, 'writing');

  online = true;
  cacheReady = true;
  const recovered = createEgeMockWrittenRunner(dependencies);
  await recovered.dispatch({ type: 'restore', form });
  assert.equal(recovered.snapshot().phase, 'writing');
});

test('failed cache revalidation makes an ambiguous pending start non-startable', async () => {
  const storage = memoryStorage();
  let starts = 0;
  let cacheReady = true;
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    uuid: () => 'd5000000-0000-4000-8000-000000000005',
    assets: {
      async isReady() { return cacheReady; },
      async preflight() {
        if (starts) throw new Error('DIGEST_FAIL');
        return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 };
      },
    },
    transport: { async start() { starts += 1; cacheReady = false; throw Object.assign(new Error('ambiguous'), { code: 'NETWORK_ERROR', status: 0 }); } },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await assert.rejects(first.dispatch({ type: 'start' }), /ambiguous/u);
  const restored = createEgeMockWrittenRunner(dependencies);
  await assert.rejects(restored.dispatch({ type: 'restore', form }), /DIGEST_FAIL/u);
  assert.equal(restored.snapshot().phase, 'error');
  await assert.rejects(restored.dispatch({ type: 'start' }), /PREFLIGHT_REQUIRED/u);
  assert.equal(starts, 1);
});

test('server timing authority requires the exact immutable 190-minute policy', async () => {
  const attempt = {
    id: 'd6000000-0000-4000-8000-000000000006', state: 'written_in_progress', revision: 0, draft: {},
    policyId: 'different-policy', formId: form.id, formRevision: form.revision,
    catalogFingerprint: form.fingerprint, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T10:00:00.000Z',
  };
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage: memoryStorage(), online: () => true,
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: { async start() { return { attempt }; } },
  });
  await runner.dispatch({ type: 'prepare', form });
  await assert.rejects(runner.dispatch({ type: 'start' }), /START_RESPONSE_INVALID/u);
});

test('server owner generation is required, persisted and immutable for the exact attempt', async () => {
  const storage = memoryStorage();
  const baseAttempt = {
    id: 'd6100000-0000-4000-8000-000000000016', state: 'written_in_progress', revision: 0, draft: {},
    policyId: ATTEMPT_POLICY_ID, formId: form.id, formRevision: form.revision,
    catalogFingerprint: form.fingerprint, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    assets: {
      async isReady() { return true; },
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
    },
  };
  const missing = createRawEgeMockWrittenRunner({
    ...dependencies, transport: { async start() { return { attempt: baseAttempt }; } },
  });
  await missing.dispatch({ type: 'prepare', form });
  await assert.rejects(missing.dispatch({ type: 'start' }), /START_RESPONSE_INVALID/u);

  const exact = createRawEgeMockWrittenRunner({
    ...dependencies,
    transport: {
      async start() { return { attempt: { ...baseAttempt, ownerGeneration: SERVER_OWNER_GENERATION } }; },
      async attempt() {
        return { attempt: { ...baseAttempt, ownerGeneration: 'account:2026-08-14T06:00:00.000Z' } };
      },
    },
  });
  await exact.dispatch({ type: 'prepare', form });
  await exact.dispatch({ type: 'start' });
  const saved = JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4'));
  assert.equal(saved.attemptOwnerGeneration, SERVER_OWNER_GENERATION);

  const restored = createRawEgeMockWrittenRunner({ ...dependencies, transport: {
    async attempt() {
      return { attempt: { ...baseAttempt, ownerGeneration: 'account:2026-08-14T06:00:00.000Z' } };
    },
  } });
  await assert.rejects(restored.dispatch({ type: 'restore', form }), /ATTEMPT_OWNER_CHANGED/u);
});

test('restored submit watermarks survive wall-clock rollback and cannot create an empty queued phase', async () => {
  const storage = memoryStorage();
  let serverState = 'written_in_progress';
  let attemptCalls = 0;
  const base = {
    id: 'd7000000-0000-4000-8000-000000000007', state: 'written_in_progress', revision: 0, draft: {},
    policyId: ATTEMPT_POLICY_ID, formId: form.id, formRevision: form.revision,
    catalogFingerprint: form.fingerprint, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const common = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse(base.writtenDeadlineAt),
    assets: {
      async isReady() { return true; },
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
    },
    transport: {
      async start() { return { attempt: base }; },
      async attempt() { attemptCalls += 1; return { attempt: { ...base, state: serverState } }; },
    },
  };
  const early = createEgeMockWrittenRunner({ ...common, localNow: () => 100_000, uuid: () => 'd8000000-0000-4000-8000-000000000008' });
  await early.dispatch({ type: 'prepare', form });
  await early.dispatch({ type: 'start' });
  await early.dispatch({ type: 'tick' });
  assert.equal(early.snapshot().phase, 'running');
  const restored = createEgeMockWrittenRunner({ ...common, localNow: () => 1, uuid: () => 'd9000000-0000-4000-8000-000000000009' });
  await restored.dispatch({ type: 'restore', form });
  assert.notEqual(restored.snapshot().phase, 'submit_queued');
  serverState = 'oral_ready';
  await restored.dispatch({ type: 'tick' });
  assert.equal(restored.snapshot().phase, 'written_submitted');
  assert.ok(attemptCalls >= 3);
});

test('a stale prepared tab adopts the durable active attempt without erasing its draft', async () => {
  const storage = memoryStorage();
  const lockManager = serialLockManager();
  let starts = 0;
  const base = {
    id: 'da000000-0000-4000-8000-00000000000a', state: 'written_in_progress', revision: 0, draft: {},
    policyId: ATTEMPT_POLICY_ID, formId: form.id, formRevision: form.revision,
    catalogFingerprint: form.fingerprint, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, lockManager, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: (() => { let id = 0; return () => `db000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: { async isReady() { return true; }, async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { starts += 1; return { attempt: base }; },
      async attempt() { const saved = JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4')); return { attempt: { ...base, draft: saved.answers } }; },
      async saveDraft(input) { return { attempt: { ...base, revision: input.expectedRevision + 1, draft: input.answers } }; },
    },
  };
  const first = createEgeMockWrittenRunner(dependencies);
  const stale = createEgeMockWrittenRunner(dependencies);
  await first.dispatch({ type: 'prepare', form });
  await stale.dispatch({ type: 'prepare', form });
  await first.dispatch({ type: 'start' });
  await first.dispatch({ type: 'answer', position: 19, answer: 'unsynced-A' });
  await stale.dispatch({ type: 'start' });
  const third = createEgeMockWrittenRunner(dependencies);
  await third.dispatch({ type: 'restore', form });
  assert.equal(starts, 1);
  assert.equal(third.snapshot().answers[19], 'unsynced-A');
});

test('every durable mutation uses one shared owner/form lock and preserves concurrent edits', async () => {
  const storage = memoryStorage();
  const lockManager = serialLockManager();
  const base = {
    id: 'dc000000-0000-4000-8000-00000000000c', state: 'written_in_progress', revision: 0, draft: {},
    policyId: ATTEMPT_POLICY_ID, formId: form.id, formRevision: form.revision,
    catalogFingerprint: form.fingerprint, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, lockManager, online: () => false,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: (() => { let id = 0; return () => `dd000000-0000-4000-8000-${String(++id).padStart(12, '0')}`; })(),
    assets: { async isReady() { return true; } }, transport: {},
  };
  storage.setItem('easyboost-ege-mock-written-v1:learner:4', JSON.stringify({
    version: 1, owner: dependencies.owner, phase: 'running', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId: base.id, revision: 0,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: base.writtenStartedAt, writtenDeadlineAt: base.writtenDeadlineAt,
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 1, preflight: {},
    pendingStartId: null, saveStatus: 'saved', queue: [], compactedThrough: null, canceledSubmit: null,
  }));
  const a = createEgeMockWrittenRunner(dependencies);
  const b = createEgeMockWrittenRunner(dependencies);
  await Promise.all([a.dispatch({ type: 'restore', form }), b.dispatch({ type: 'restore', form })]);
  const before = lockManager.calls;
  await Promise.all([
    a.dispatch({ type: 'answer', position: 19, answer: 'A' }),
    b.dispatch({ type: 'answer', position: 20, answer: 'B' }),
  ]);
  const restored = createEgeMockWrittenRunner(dependencies);
  await restored.dispatch({ type: 'restore', form });
  assert.ok(lockManager.calls >= before + 2);
  assert.deepEqual(restored.snapshot().answers, { 19: 'A', 20: 'B' });
});

test('audio playback is an atomic cross-tab lease held until explicit completion', async () => {
  const storage = memoryStorage();
  const lockManager = serialLockManager();
  const base = {
    id: 'de000000-0000-4000-8000-00000000000e', state: 'written_in_progress', revision: 0, draft: {},
    policyId: ATTEMPT_POLICY_ID, formId: form.id, formRevision: form.revision,
    catalogFingerprint: form.fingerprint, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  let id = 0;
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, lockManager, online: () => false,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'), localNow: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => `df000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    assets: { async isReady() { return true; } }, transport: {},
  };
  storage.setItem('easyboost-ege-mock-written-v1:learner:4', JSON.stringify({
    version: 1, owner: dependencies.owner, phase: 'running', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId: base.id, revision: 0,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: base.writtenStartedAt, writtenDeadlineAt: base.writtenDeadlineAt,
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 1, preflight: {},
    pendingStartId: null, saveStatus: 'saved', queue: [], compactedThrough: null, canceledSubmit: null,
  }));
  const a = createEgeMockWrittenRunner(dependencies);
  const b = createEgeMockWrittenRunner(dependencies);
  await Promise.all([a.dispatch({ type: 'restore', form }), b.dispatch({ type: 'restore', form })]);
  const attempts = await Promise.allSettled([
    a.dispatch({ type: 'audioStart', group: 'matching' }),
    b.dispatch({ type: 'audioStart', group: 'matching' }),
  ]);
  assert.deepEqual(attempts.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  const acquired = attempts.find((result) => result.status === 'fulfilled').value;
  assert.equal(acquired.audioInFlight.group, 'matching');
  assert.equal(acquired.audioPlays.matching, 1);
  const holder = attempts[0].status === 'fulfilled' ? a : b;
  await holder.dispatch({ type: 'audioFinish', token: acquired.audioInFlight.token });
  const second = attempts[0].status === 'fulfilled' ? b : a;
  const next = await second.dispatch({ type: 'audioStart', group: 'matching' });
  assert.equal(next.audioPlays.matching, 2);
});

test('a transient exact-attempt failure keeps deadline replay retryable', async () => {
  const storage = memoryStorage();
  let calls = 0;
  const base = {
    id: 'e0000000-0000-4000-8000-000000000000', state: 'written_in_progress', revision: 0, draft: {},
    policyId: ATTEMPT_POLICY_ID, formId: form.id, formRevision: form.revision,
    catalogFingerprint: form.fingerprint, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse(base.writtenDeadlineAt), uuid: () => 'e1000000-0000-4000-8000-000000000001',
    assets: { async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; } },
    transport: {
      async start() { return { attempt: base }; },
      async attempt() {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('temporary'), { status: 503 });
        return { attempt: { ...base, state: 'oral_ready' } };
      },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'tick' });
  assert.equal(runner.snapshot().phase, 'submit_queued');
  await runner.dispatch({ type: 'sync' });
  assert.equal(runner.snapshot().phase, 'written_submitted');
});

test('a transient current 503 still fails closed when exact assets were evicted', async () => {
  const storage = memoryStorage();
  let cacheReady = true;
  const base = {
    id: 'ea000000-0000-4000-8000-00000000000a', state: 'written_in_progress', revision: 0, draft: {},
    policyId: ATTEMPT_POLICY_ID, formId: form.id, formRevision: form.revision,
    catalogFingerprint: form.fingerprint, writtenStartedAt: '2026-08-13T06:00:00.000Z',
    writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const dependencies = {
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    assets: {
      async isReady() { return cacheReady; },
      async preflight() { throw new Error('exact cache unavailable'); },
    },
    transport: {
      async start() { return { attempt: base }; },
      async attempt() { throw Object.assign(new Error('temporary'), { status: 503 }); },
    },
  };
  const started = createEgeMockWrittenRunner(dependencies);
  await started.dispatch({ type: 'prepare', form }).catch(() => {});
  cacheReady = true;
  started.snapshot();
  // Start from an exact valid active envelope, then simulate eviction before restore.
  storage.setItem('easyboost-ege-mock-written-v1:learner:4', JSON.stringify({
    version: 1, owner: dependencies.owner, phase: 'running', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId: base.id, revision: 0,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: base.writtenStartedAt, writtenDeadlineAt: base.writtenDeadlineAt,
    timerAuthority: { policyId: ATTEMPT_POLICY_ID, writtenStartedAt: base.writtenStartedAt,
      writtenDeadlineAt: base.writtenDeadlineAt, serverOffsetMs: 0, observedNowMs: Date.parse(base.writtenStartedAt) },
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 1, preflight: {},
    pendingStartId: null, saveStatus: 'saved', queue: [], compactedThrough: null, canceledSubmit: null,
  }));
  cacheReady = false;
  const restored = createEgeMockWrittenRunner(dependencies);
  await assert.rejects(restored.dispatch({ type: 'restore', form }), /exact cache unavailable/u);
  assert.equal(restored.snapshot().phase, 'asset_blocked');
});

test('an empty browser adopts the exact active server attempt before offering a new start', async () => {
  const base = {
    id: 'eb000000-0000-4000-8000-00000000000b', ownerGeneration: SERVER_OWNER_GENERATION,
    state: 'written_in_progress', revision: 2, draft: { 19: 'went' }, policyId: ATTEMPT_POLICY_ID,
    writingAssessment: assessmentState('not_started', 0),
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  let preflights = 0;
  const runner = createRawEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage: memoryStorage(), online: () => true,
    clock: () => Date.parse('2026-08-13T07:00:00.000Z'),
    assets: {
      async isReady() { return false; },
      async preflight() { preflights += 1; return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
    },
    transport: { async current() { return { serverTimeMs: Date.parse('2026-08-13T07:00:00.000Z'), attempt: base }; } },
  });
  const restored = await runner.dispatch({ type: 'restore', form });
  assert.equal(restored.phase, 'running');
  assert.equal(restored.attemptId, base.id);
  assert.equal(restored.answers[19], 'went');
  assert.equal(restored.remainingSeconds, 130 * 60);
  assert.equal(preflights, 1);
});

test('status-less exact-attempt integrity failures are never treated as transient transport errors', async () => {
  const storage = memoryStorage();
  const base = {
    id: 'ec000000-0000-4000-8000-00000000000c', ownerGeneration: SERVER_OWNER_GENERATION,
    state: 'written_in_progress', revision: 0, draft: {}, policyId: ATTEMPT_POLICY_ID,
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  storage.setItem('easyboost-ege-mock-written-v1:learner:4', JSON.stringify({
    version: 1, owner: { username: 'learner', generation: 4 }, phase: 'running',
    formIdentity: form.identity, catalogFingerprint: form.fingerprint, attemptId: base.id,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 0, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: base.writtenStartedAt, writtenDeadlineAt: base.writtenDeadlineAt,
    timerAuthority: { policyId: ATTEMPT_POLICY_ID, writtenStartedAt: base.writtenStartedAt,
      writtenDeadlineAt: base.writtenDeadlineAt, serverOffsetMs: 0, observedNowMs: Date.parse(base.writtenStartedAt) },
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 1, preflight: {},
    pendingStartId: null, saveStatus: 'saved', queue: [], compactedThrough: null, canceledSubmit: null,
  }));
  const runner = createRawEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T07:00:00.000Z'),
    assets: { async isReady() { return true; } },
    transport: { async attempt() { return { attempt: { ...base, ownerGeneration: 'wrong-owner' } }; } },
  });
  await assert.rejects(runner.dispatch({ type: 'restore', form }), { code: 'EGE_MOCK_ATTEMPT_OWNER_CHANGED' });
});

test('a definitive invalidation watermark prevents stale persistence or deletion of its replacement', async () => {
  const storage = memoryStorage();
  const formLock = serialLockManager();
  const ownerLock = serialLockManager();
  const owner = { username: 'learner', generation: 4 };
  const base = {
    id: 'ec100000-0000-4000-8000-00000000000c', ownerGeneration: SERVER_OWNER_GENERATION,
    state: 'written_in_progress', revision: 0, draft: {}, policyId: ATTEMPT_POLICY_ID,
    writingAssessment: assessmentState('not_started', 0),
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const dependencies = {
    owner, storage, lockManager: formLock, online: () => false,
    clock: () => Date.parse('2026-08-13T07:00:00.000Z'),
    assets: { async isReady() { return true; } }, transport: {},
    authority: { commit: (action) => ownerLock.request('owner', { mode: 'exclusive' }, action) },
  };
  storage.setItem('easyboost-ege-mock-written-v1:learner:4', JSON.stringify({
    version: 1, owner, phase: 'running', formIdentity: form.identity,
    catalogFingerprint: form.fingerprint, attemptId: base.id, attemptOwnerGeneration: SERVER_OWNER_GENERATION,
    revision: 0, policyId: ATTEMPT_POLICY_ID, writtenStartedAt: base.writtenStartedAt,
    writtenDeadlineAt: base.writtenDeadlineAt, timerAuthority: {
      policyId: ATTEMPT_POLICY_ID, writtenStartedAt: base.writtenStartedAt,
      writtenDeadlineAt: base.writtenDeadlineAt, serverOffsetMs: 0,
      observedNowMs: Date.parse(base.writtenStartedAt),
    },
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 1, preflight: {},
    pendingStartId: null, saveStatus: 'saved', queue: [], compactedThrough: null, canceledSubmit: null,
  }));
  const invalidatingTab = createRawEgeMockWrittenRunner(dependencies);
  const staleTab = createRawEgeMockWrittenRunner(dependencies);
  const delayedInvalidator = createRawEgeMockWrittenRunner(dependencies);
  await invalidatingTab.dispatch({ type: 'restore', form });
  await staleTab.dispatch({ type: 'restore', form });
  await delayedInvalidator.dispatch({ type: 'restore', form });

  await invalidatingTab.dispatch({ type: 'invalidate' });
  assert.equal(storage.getItem('easyboost-ege-mock-written-v1:learner:4'), null);
  const replacementId = 'ec200000-0000-4000-8000-00000000000c';
  const replacement = createRawEgeMockWrittenRunner({
    ...dependencies, online: () => true,
    transport: { async current() { return {
      serverTimeMs: Date.parse('2026-08-13T07:00:00.000Z'),
      attempt: { ...base, id: replacementId },
    }; } },
  });
  await replacement.dispatch({ type: 'restore', form });
  await assert.rejects(delayedInvalidator.dispatch({ type: 'invalidate' }), {
    code: 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED',
  });
  assert.equal(JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4')).attemptId, replacementId);
  await assert.rejects(staleTab.dispatch({ type: 'answer', position: 19, answer: 'resurrected' }), {
    code: 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED',
  });
  await assert.rejects(staleTab.dispatch({ type: 'refreshLocal' }), {
    code: 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED',
  });
  assert.equal(JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4')).attemptId, replacementId);
  assert.equal(formLock.calls > 0, true);
  assert.equal(ownerLock.calls > 0, true);
});

test('failed invalidation preserves the attempt envelope and never reports durable success', async () => {
  for (const failure of ['storage', 'owner-lock']) {
    const durable = memoryStorage();
    const storage = {
      getItem: (key) => durable.getItem(key),
      removeItem: (key) => durable.removeItem(key),
      setItem(key, value) {
        if (failure === 'storage' && key.endsWith(':invalidation')) throw new Error('quota');
        durable.setItem(key, value);
      },
    };
    const owner = { username: 'learner', generation: 4 };
    const storageKey = 'easyboost-ege-mock-written-v1:learner:4';
    const encoded = JSON.stringify({
      version: 1, owner, phase: 'running', formIdentity: form.identity,
      catalogFingerprint: form.fingerprint, attemptId: `ec300000-0000-4000-8000-00000000000${failure === 'storage' ? 1 : 2}`,
      attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 0, policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      timerAuthority: { policyId: ATTEMPT_POLICY_ID, writtenStartedAt: '2026-08-13T06:00:00.000Z',
        writtenDeadlineAt: '2026-08-13T09:10:00.000Z', serverOffsetMs: 0,
        observedNowMs: Date.parse('2026-08-13T06:00:00.000Z') },
      answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 1, preflight: {},
      pendingStartId: null, saveStatus: 'saved', queue: [], compactedThrough: null, canceledSubmit: null,
    });
    durable.setItem(storageKey, encoded);
    const runner = createRawEgeMockWrittenRunner({
      owner, storage, online: () => false, assets: { async isReady() { return true; } }, transport: {},
      clock: () => Date.parse('2026-08-13T07:00:00.000Z'),
      authority: { async commit(action) {
        if (failure === 'owner-lock') throw new Error('lock unavailable');
        return action();
      } },
    });
    await runner.dispatch({ type: 'restore', form });
    const beforeInvalidation = durable.getItem(storageKey);
    await assert.rejects(runner.dispatch({ type: 'invalidate' }));
    assert.equal(durable.getItem(storageKey), beforeInvalidation, `${failure} must preserve the resumable envelope`);
    assert.equal(durable.getItem(`${storageKey}:invalidation`), null);
  }
});

test('owner deletion during an awaited restore cannot recreate the purged exact continuation', async () => {
  const storage = memoryStorage();
  const base = {
    id: 'ed000000-0000-4000-8000-00000000000d', ownerGeneration: SERVER_OWNER_GENERATION,
    state: 'written_in_progress', revision: 0, draft: { 19: 'went' }, policyId: ATTEMPT_POLICY_ID,
    writingAssessment: assessmentState('not_started', 0),
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  const storageKey = 'easyboost-ege-mock-written-v1:learner:4';
  storage.setItem(storageKey, JSON.stringify({
    version: 1, owner: { username: 'learner', generation: 4 }, phase: 'running',
    formIdentity: form.identity, catalogFingerprint: form.fingerprint, attemptId: base.id,
    attemptOwnerGeneration: SERVER_OWNER_GENERATION, revision: 0, policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: base.writtenStartedAt, writtenDeadlineAt: base.writtenDeadlineAt,
    timerAuthority: { policyId: ATTEMPT_POLICY_ID, writtenStartedAt: base.writtenStartedAt,
      writtenDeadlineAt: base.writtenDeadlineAt, serverOffsetMs: 0, observedNowMs: Date.parse(base.writtenStartedAt) },
    answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 1, preflight: {},
    pendingStartId: null, saveStatus: 'saved', queue: [], compactedThrough: null, canceledSubmit: null,
  }));
  let resolveAttempt;
  const attemptPending = new Promise((resolve) => { resolveAttempt = resolve; });
  let authorityCurrent = true;
  const runner = createRawEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    assets: { async isReady() { return true; } },
    authority: {
      async commit(action) {
        if (!authorityCurrent) throw Object.assign(new Error('EGE_MOCK_OWNER_AUTHORITY_CHANGED'), {
          code: 'EGE_MOCK_OWNER_AUTHORITY_CHANGED',
        });
        return action();
      },
    },
    transport: { async attempt() { return attemptPending; } },
  });
  const restoring = runner.dispatch({ type: 'restore', form });
  await new Promise((resolve) => setImmediate(resolve));
  authorityCurrent = false;
  storage.removeItem(storageKey);
  resolveAttempt({ attempt: base, serverTimeMs: Date.parse('2026-08-13T07:00:00.000Z') });
  await assert.rejects(restoring, { code: 'EGE_MOCK_OWNER_AUTHORITY_CHANGED' });
  assert.equal(storage.getItem(storageKey), null);
});

test('owner deletion during an awaited autosave cannot recreate the purged draft', async () => {
  const storage = memoryStorage();
  const base = {
    id: 'ee000000-0000-4000-8000-00000000000e', ownerGeneration: SERVER_OWNER_GENERATION,
    state: 'written_in_progress', revision: 0, draft: {}, policyId: ATTEMPT_POLICY_ID,
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  let resolveSave;
  const savePending = new Promise((resolve) => { resolveSave = resolve; });
  let authorityCurrent = true;
  const runner = createRawEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T07:00:00.000Z'),
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    authority: {
      async commit(action) {
        if (!authorityCurrent) throw Object.assign(new Error('EGE_MOCK_OWNER_AUTHORITY_CHANGED'), {
          code: 'EGE_MOCK_OWNER_AUTHORITY_CHANGED',
        });
        return action();
      },
    },
    transport: {
      async start() { return { attempt: base, serverTimeMs: Date.parse('2026-08-13T07:00:00.000Z') }; },
      async saveDraft() { return savePending; },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'answer', position: 19, answer: 'went' });
  const syncing = runner.dispatch({ type: 'sync' });
  await new Promise((resolve) => setImmediate(resolve));
  authorityCurrent = false;
  storage.removeItem('easyboost-ege-mock-written-v1:learner:4');
  resolveSave({ attempt: { ...base, revision: 1, draft: { 19: 'went' } } });
  await assert.rejects(syncing, { code: 'EGE_MOCK_OWNER_AUTHORITY_CHANGED' });
  assert.equal(storage.getItem('easyboost-ege-mock-written-v1:learner:4'), null);
});

test('start revalidates exact assets inside the durable lock and fails closed before transport', async () => {
  for (const readiness of ['false', 'throw']) {
    const storage = memoryStorage();
    let insideLock = false;
    let starts = 0;
    let readyChecks = 0;
    const lockManager = {
      request(_name, _options, callback) {
        insideLock = true;
        return Promise.resolve(callback()).finally(() => { insideLock = false; });
      },
    };
    const runner = createEgeMockWrittenRunner({
      owner: { username: 'learner', generation: 4 }, storage, lockManager, online: () => true,
      uuid: () => `e2000000-0000-4000-8000-00000000000${readiness === 'false' ? 2 : 3}`,
      assets: {
        async preflight() {
          return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 };
        },
        async isReady() {
          readyChecks += 1;
          assert.equal(insideLock, true, 'the final readiness decision must share the start lock');
          if (readiness === 'throw') throw new Error('EGE_MOCK_ASSET_CACHE_READ_FAILED');
          return false;
        },
      },
      transport: {
        async start() {
          starts += 1;
          throw new Error('transport must not see an unready form');
        },
      },
    });

    await runner.dispatch({ type: 'prepare', form });
    await assert.rejects(runner.dispatch({ type: 'start' }), /EGE_MOCK_ASSET/u);
    assert.equal(readyChecks, 1);
    assert.equal(starts, 0);
    assert.equal(runner.snapshot().phase, 'error');
    const durable = JSON.parse(storage.getItem('easyboost-ege-mock-written-v1:learner:4'));
    assert.equal(durable.phase, 'error');
    assert.equal(durable.preflight, null);
    assert.equal(typeof durable.pendingStartId, 'string');
    await assert.rejects(runner.dispatch({ type: 'start' }), /PREFLIGHT_REQUIRED/u);
  }
});

test('offline restore rejects a local attempt whose policy or exact 190-minute pair drifted', async () => {
  for (const override of [
    { policyId: 'ege-mock-attempt-policy-v0' },
    { writtenDeadlineAt: '2026-08-13T09:11:00.000Z' },
  ]) {
    const storage = memoryStorage();
    const saved = {
      version: 1, owner: { username: 'learner', generation: 4 }, phase: 'running',
      formIdentity: form.identity, catalogFingerprint: form.fingerprint,
      attemptId: 'e3000000-0000-4000-8000-000000000003', revision: 0,
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
      answers: {}, answerVersions: {}, audioPlays: {}, currentPosition: 1, preflight: {
        identity: form.identity, fingerprint: form.fingerprint, assetCount: 20,
      },
      pendingStartId: null, saveStatus: 'saved', queue: [], compactedThrough: null,
      canceledSubmit: null, ...override,
    };
    storage.setItem('easyboost-ege-mock-written-v1:learner:4', JSON.stringify(saved));
    assert.equal(egeMockLocalContinuation(storage, saved.owner, form), null);
    const restored = createEgeMockWrittenRunner({
      owner: saved.owner, storage, online: () => false,
      assets: { async isReady() { return true; } }, transport: {},
    });
    await assert.rejects(restored.dispatch({ type: 'restore', form }), /LOCAL_STATE_INVALID/u);
  }
});

test('a pinned monotonic deadline cannot be extended by a slow or rolled-back wall clock', async () => {
  let wall = Date.parse('2026-08-13T05:50:00.000Z');
  let monotonic = 1_000;
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage: memoryStorage(), online: () => true,
    clock: () => wall, monotonicNow: () => monotonic,
    uuid: () => 'e4000000-0000-4000-8000-000000000004',
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: { async start() { return { serverTimeMs: Date.parse('2026-08-13T06:00:00.000Z'), attempt: {
      id: 'e5000000-0000-4000-8000-000000000005', state: 'written_in_progress', revision: 0, draft: {},
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    } }; } },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  assert.equal(runner.snapshot().remainingSeconds, 190 * 60,
    'a client clock behind the server start must not add ten minutes');

  wall = Date.parse('2026-08-13T08:00:00.000Z');
  monotonic += 60 * 1000;
  assert.equal(runner.snapshot().remainingSeconds, 189 * 60,
    'a forward wall-clock jump after the authoritative anchor must not consume exam time');

  wall = Date.parse('2026-08-13T04:50:00.000Z');
  monotonic += 29 * 60 * 1000;
  await runner.dispatch({ type: 'tick' });
  assert.equal(runner.snapshot().remainingSeconds, 160 * 60,
    'monotonic elapsed time must continue despite wall-clock rollback');

  const fastRunner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage: memoryStorage(), online: () => true,
    clock: () => Date.parse('2026-08-13T08:00:00.000Z'), monotonicNow: () => 10_000,
    uuid: () => 'e4000000-0000-4000-8000-000000000014',
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: { async start() { return { serverTimeMs: Date.parse('2026-08-13T06:00:00.000Z'), attempt: {
      id: 'e5000000-0000-4000-8000-000000000015', state: 'written_in_progress', revision: 0, draft: {},
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      policyId: ATTEMPT_POLICY_ID,
      writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
    } }; } },
  });
  await fastRunner.dispatch({ type: 'prepare', form });
  await fastRunner.dispatch({ type: 'start' });
  assert.equal(fastRunner.snapshot().remainingSeconds, 190 * 60,
    'a client clock ahead of the server must not shorten the exact 190-minute attempt');
});

test('an overlapping autosave acknowledgement retires only its dirty versions before CAS rebase', async () => {
  const storage = memoryStorage();
  let saveCalls = 0;
  let releaseFirst;
  let firstStarted;
  const firstSaveStarted = new Promise((resolve) => { firstStarted = resolve; });
  const firstSaveRelease = new Promise((resolve) => { releaseFirst = resolve; });
  let finalPayload = null;
  const base = {
    id: 'e6000000-0000-4000-8000-000000000006', state: 'written_in_progress', revision: 0, draft: {},
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
    policyId: ATTEMPT_POLICY_ID,
    writtenStartedAt: '2026-08-13T06:00:00.000Z', writtenDeadlineAt: '2026-08-13T09:10:00.000Z',
  };
  let id = 0;
  const runner = createEgeMockWrittenRunner({
    owner: { username: 'learner', generation: 4 }, storage, online: () => true,
    clock: () => Date.parse('2026-08-13T06:10:00.000Z'),
    uuid: () => `e7000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    assets: {
      async preflight() { return { identity: form.identity, fingerprint: form.fingerprint, assetCount: 20 }; },
      async isReady() { return true; },
    },
    transport: {
      async start() { return { attempt: base }; },
      async attempt() { return { attempt: { ...base, revision: 2, draft: { 19: 'other-tab-newer' } } }; },
      async saveDraft(input) {
        saveCalls += 1;
        if (saveCalls === 1) {
          firstStarted();
          await firstSaveRelease;
          return { attempt: { ...base, revision: 1, draft: input.answers } };
        }
        if (saveCalls === 2) {
          throw Object.assign(new Error('stale'), { code: 'EGE_MOCK_REVISION_CONFLICT', status: 409 });
        }
        finalPayload = input.answers;
        return { attempt: { ...base, revision: 3, draft: input.answers } };
      },
    },
  });
  await runner.dispatch({ type: 'prepare', form });
  await runner.dispatch({ type: 'start' });
  await runner.dispatch({ type: 'answer', position: 19, answer: 'first-local' });
  const syncing = runner.dispatch({ type: 'sync' });
  await firstSaveStarted;
  await runner.dispatch({ type: 'answer', position: 20, answer: 'second-local' });
  releaseFirst();
  await syncing;

  assert.deepEqual(finalPayload, { 19: 'other-tab-newer', 20: 'second-local' });
  assert.deepEqual(runner.snapshot().answers, finalPayload);
});
