import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import express from 'express';

import { createAiRoutes } from '../routes/ai.js';

const writingPayload = {
  taskType: 'writing_37', taskId: 'builtin:writing_37:test',
  answer: Array.from({ length: 110 }, (_, index) => `word${index}`).join(' '),
};
const writingReview = JSON.stringify({
  words: 110, in_range: true, overall_got: 4, overall_max: 6, verdict: 'Готово', sub: 'Test',
  criteria: [
    { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
    { name: 'Организация текста', got: 1, max: 2 },
    { name: 'Языковое оформление', got: 1, max: 2 },
  ],
  errors: [],
});

function writingRequestFingerprint(payload) {
  return crypto.createHash('sha256').update(JSON.stringify({
    contractVersion: 'writing-evaluation-v1',
    taskType: payload.taskType, taskId: '7', answer: payload.answer,
  })).digest('hex');
}

async function withWritingApp({
  existingAttempt = null, finishWritingAttempt, askWithFallback, owner = 'owner-a', attemptId = 91,
  accessOverrides = {}, writingPromptPreparer, claimAiOperationSlot, settleAiOperationSlot,
  getWritingProgressSummary, parseWithOneRepair, requestPayload = writingPayload,
} = {}, run) {
  const pass = (_req, _res, next) => next();
  let storedAttempt = existingAttempt ? structuredClone(existingAttempt) : null;
  let providerCalls = 0;
  let finishCalls = 0;
  const providerKeys = [];
  const operationClaims = [];
  const operationSettlements = [];
  const app = express();
  app.use(express.json());
  app.use(createAiRoutes({
    authentication: { auth(req, _res, next) { req.user = owner; next(); } },
    access: {
      privacyPolicyVersion: 'writing-test-v1', createOperationLimiter: () => pass,
      requireAiBudget: pass, requireActiveSubscription: pass, requirePrivacyConsent: () => pass,
      hasAiBudget: async () => true,
      ...accessOverrides,
    },
    db: {
      async getBankTask() { return null; },
      async getBankTaskByExternalId() {
        return { id: 7, externalId: requestPayload.taskId, operation: 'writing_task_37', content: {
          from: 'Emily', stim: 'How are you? What do you study? What do you enjoy?', ask: 'her new flat',
        } };
      },
      async getWritingEvaluationClaim(_owner, key) {
        return storedAttempt?.idempotency_key === String(key).toLowerCase() ? structuredClone(storedAttempt) : null;
      },
      async claimWritingEvaluation(_owner, input, promptVersion, fingerprint, key, options = {}) {
        if (storedAttempt) {
          const normalizedKey = String(key).toLowerCase();
          const acknowledged = options.acknowledgePossibleProviderRepeatKey;
          if (storedAttempt.idempotency_key === normalizedKey) {
            return { created: false, attempt: structuredClone(storedAttempt) };
          }
          if (acknowledged) {
            if (acknowledged !== storedAttempt.idempotency_key
              || storedAttempt.status !== 'pending') throw new Error('WRITING_EVALUATION_REPEAT_ACK_INVALID');
            if (!storedAttempt.provider_result_ambiguous_at) {
              throw new Error('WRITING_EVALUATION_REPEAT_ACK_NOT_READY');
            }
            storedAttempt = {
              id: Number(storedAttempt.id) + 1, username: owner, task_type: input.taskType,
              assignment: input.assignment, answer: input.answer, evaluated_answer: input.evaluatedAnswer,
              prompt_version: promptVersion, request_fingerprint: fingerprint,
              idempotency_key: normalizedKey, status: 'pending', created_at: Date.now(),
            };
            const prepared = await options.prepareEvaluation?.();
            storedAttempt.evaluated_answer = prepared?.evaluatedAnswer ?? input.evaluatedAnswer ?? input.answer;
            return { created: true, attempt: structuredClone(storedAttempt), prepared };
          }
          return { created: false, attempt: structuredClone(storedAttempt) };
        }
        storedAttempt = {
          id: attemptId, username: owner, task_type: input.taskType, assignment: input.assignment,
          answer: input.answer, evaluated_answer: input.evaluatedAnswer, prompt_version: promptVersion,
          request_fingerprint: fingerprint, idempotency_key: String(key).toLowerCase(), status: 'pending',
          created_at: Date.now(),
        };
        const prepared = await options.prepareEvaluation?.();
        storedAttempt.evaluated_answer = prepared?.evaluatedAnswer ?? input.evaluatedAnswer ?? input.answer;
        return { created: true, attempt: structuredClone(storedAttempt), prepared };
      },
      async markWritingEvaluationAmbiguous(id) {
        if (storedAttempt?.id !== Number(id) || storedAttempt.status !== 'pending') return false;
        storedAttempt.provider_result_ambiguous_at ||= Date.now();
        return true;
      },
      async finishWritingAttempt(id, result) {
        finishCalls += 1;
        if (finishWritingAttempt) return finishWritingAttempt({ id, result, get: () => storedAttempt, set: (value) => { storedAttempt = value; }, finishCalls });
        storedAttempt = { ...storedAttempt, ...{
          status: result.status, review: result.review || null, provider: result.provider || null,
          model: result.model || null, error_code: result.errorCode || null,
          response_snapshot: result.responseSnapshot || null, evaluated_at: Date.now(),
        } };
        return true;
      },
      async getWritingProgressSummary() {
        if (getWritingProgressSummary) {
          return getWritingProgressSummary({ get: () => structuredClone(storedAttempt) });
        }
        if (storedAttempt?.status !== 'completed') return {
          version: 'writing-progress-v1', attemptCount: 0, average: 0, works: [],
        };
        const review = storedAttempt.review;
        return {
          version: 'writing-progress-v1', attemptCount: 1,
          average: Math.round(Number(review.overall_got) / Number(review.overall_max) * 100),
          works: [{
            attemptId: Number(storedAttempt.id), t: storedAttempt.task_type === 'writing_37' ? 37 : 38,
            taskId: storedAttempt.source_task_ref || null, g: Number(review.overall_got),
            m: Number(review.overall_max), n: Number(review.words) || 0,
            ts: Number(storedAttempt.evaluated_at || storedAttempt.created_at),
          }],
        };
      },
      async claimAiOperationSlot(username, claim) {
        operationClaims.push({ username, ...claim });
        if (claimAiOperationSlot) return claimAiOperationSlot(username, claim);
        return { applied: true, claim_id: claim.claimId, status: 'in_progress' };
      },
      async settleAiOperationSlot(username, claimId, settlement) {
        operationSettlements.push({ username, claimId, ...settlement });
        if (settleAiOperationSlot) return settleAiOperationSlot(username, claimId, settlement);
        return { applied: true, status: settlement.status };
      },
      async logAiRequest() {},
    },
    providerClient: {
      limitsFor: () => ({ requestsPerHour: 5 }), aiProviders: () => [{ name: 'test', model: 'test' }],
      async askWithFallback(_system, _user, _operation, controls = {}) {
        const provider = { name: 'test', model: 'test' };
        const context = await controls.beforeAttempt?.(provider, { attempt: 1 });
        providerCalls += 1;
        if (context?.idempotencyKey) providerKeys.push(context.idempotencyKey);
        let value;
        try {
          value = askWithFallback ? await askWithFallback() : {
            text: writingReview, provider: 'test', model: 'test', attempts: 1,
            promptTokens: 10, completionTokens: 10,
          };
        } catch (error) {
          await controls.afterAttempt?.(context, { status: 'failed', error, provider, attempt: 1, durationMs: 1 });
          throw error;
        }
        await controls.afterAttempt?.(context, { status: 'completed', value, provider, attempt: 1, durationMs: 1 });
        return value;
      },
      async parseWithOneRepair(options) {
        if (parseWithOneRepair) return parseWithOneRepair(options);
        return { value: options.parse(options.text), repair: null };
      },
    },
    ...(writingPromptPreparer ? { writingPromptPreparer } : {}),
  }).router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run({
      async evaluate(key = crypto.randomUUID(), extraHeaders = {}) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ai/evaluate-writing`, {
          method: 'POST', headers: {
            'content-type': 'application/json', 'idempotency-key': key,
            'x-easyboost-expected-owner': owner,
            ...extraHeaders,
          }, body: JSON.stringify(requestPayload),
        });
        return { status: response.status, body: await response.json() };
      },
      providerCalls: () => providerCalls, finishCalls: () => finishCalls,
      providerKeys: () => [...providerKeys],
      operationClaims: () => structuredClone(operationClaims),
      operationSettlements: () => structuredClone(operationSettlements),
      ageAttempt(milliseconds) { if (storedAttempt) storedAttempt.created_at = Date.now() - milliseconds; },
    });
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('AI content owner mismatch short-circuits before subscription and privacy gates', async () => {
  let subscriptionChecks = 0;
  let consentChecks = 0;
  const pass = (_req, _res, next) => next();
  const app = express();
  app.use(express.json());
  app.use(createAiRoutes({
    authentication: {
      auth(req, res, next) {
        const owner = req.get('x-test-user');
        if (!owner) return res.status(401).json({ error: { code: 'UNAUTHORIZED' } });
        req.user = owner;
        return next();
      },
    },
    access: {
      privacyPolicyVersion: 'owner-boundary-test-v1',
      createOperationLimiter: () => pass,
      requireAiBudget: pass,
      requireActiveSubscription(_req, res) {
        subscriptionChecks += 1;
        return res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED' } });
      },
      requirePrivacyConsent: () => (_req, res) => {
        consentChecks += 1;
        return res.status(403).json({ error: { code: 'PRIVACY_CONSENT_REQUIRED' } });
      },
      hasAiBudget: async () => true,
    },
    db: {},
    providerClient: {
      limitsFor: () => ({ requestsPerHour: 1 }),
    },
  }).router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ai/generate-content`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'owner-b',
        'x-easyboost-expected-owner': 'owner-a',
      },
      body: JSON.stringify({ operation: 'grammar_quiz' }),
    });

    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'OWNER_CHANGED');
    assert.equal(subscriptionChecks, 0);
    assert.equal(consentChecks, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Writing settlement recovers when the first commit fails before persistence', async () => {
  await withWritingApp({
    finishWritingAttempt({ result, get, set, finishCalls }) {
      if (finishCalls === 1) throw new Error('pre-commit failure');
      set({ ...get(), status: result.status, review: result.review, provider: result.provider,
        model: result.model, response_snapshot: result.responseSnapshot });
      return true;
    },
  }, async ({ evaluate, providerCalls, finishCalls }) => {
    const response = await evaluate();
    assert.equal(response.status, 200);
    assert.equal(response.body.attemptId, 91);
    assert.equal(providerCalls(), 1);
    assert.equal(finishCalls(), 2);
  });
});

test('Writing settlement replays committed state when commit acknowledgement is lost', async () => {
  await withWritingApp({
    finishWritingAttempt({ result, get, set }) {
      set({ ...get(), status: result.status, review: result.review, provider: result.provider,
        model: result.model, response_snapshot: result.responseSnapshot });
      throw new Error('commit acknowledgement lost');
    },
  }, async ({ evaluate, providerCalls, finishCalls }) => {
    const response = await evaluate();
    assert.equal(response.status, 200);
    assert.equal(response.body.attemptId, 91);
    assert.equal(providerCalls(), 1);
    assert.equal(finishCalls(), 1);
  });
});

test('Writing exact replay canonically upcasts an old stored review instead of relabelling its snapshot', async () => {
  const key = crypto.randomUUID();
  const oldReview = JSON.parse(writingReview);
  const oldSnapshot = { review: oldReview, provider: 'old-provider', attemptId: 91,
    voiceTutor: null, assessment: { version: 'old' }, evaluationScope: { version: 'old' } };
  await withWritingApp({ existingAttempt: {
    id: 91, username: 'owner-a', task_type: writingPayload.taskType,
    assignment: { from: 'Emily', stimulus: 'How are you? What do you study? What do you enjoy?', questionsTopic: 'her new flat' },
    answer: writingPayload.answer,
    prompt_version: 'writing-v1', request_fingerprint: writingRequestFingerprint(writingPayload),
    idempotency_key: key, status: 'completed', review: oldReview, provider: 'old-provider',
    response_snapshot: oldSnapshot, created_at: Date.now() - 86_400_000,
  } }, async ({ evaluate, providerCalls }) => {
    const response = await evaluate(key);
    assert.equal(response.status, 200);
    assert.equal(response.body.contractVersion, 'writing-evaluation-response-v1');
    assert.deepEqual(response.body.review, oldReview);
    assert.equal(response.body.provider, 'old-provider');
    assert.equal(response.body.attemptId, 91);
    assert.deepEqual(response.body.assessment, {
      mode: 'experimental', scoreKind: 'approximate',
      warning: 'Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.',
    });
    assert.equal(response.body.voiceTutor.source, 'writing');
    assert.equal(response.body.voiceTutor.attemptId, 91);
    assert.equal(response.body.evaluationScope.fullWords, 110);
    assert.equal(response.body.evaluationScope.version, undefined,
      'arbitrary archived response metadata is never relabelled as the current contract');
    assert.equal(response.body.writingProgress.attemptCount, 1);
    assert.equal(response.body.writingProgress.confirmedAttempt.attemptId, 91);
    assert.equal(providerCalls(), 0);
  });
});

test('Writing completed replay without a stored response snapshot rebuilds the current public DTO', async () => {
  const key = crypto.randomUUID();
  const review = JSON.parse(writingReview);
  await withWritingApp({ existingAttempt: {
    id: 91, username: 'owner-a', task_type: writingPayload.taskType,
    assignment: { from: 'Emily', stimulus: 'How are you? What do you study? What do you enjoy?', questionsTopic: 'her new flat' },
    answer: writingPayload.answer, prompt_version: 'writing-v1',
    request_fingerprint: writingRequestFingerprint(writingPayload), idempotency_key: key,
    status: 'completed', review, provider: 'old-provider', response_snapshot: null,
    created_at: Date.now() - 86_400_000,
  } }, async ({ evaluate, providerCalls }) => {
    const response = await evaluate(key);
    assert.equal(response.status, 200);
    assert.equal(response.body.contractVersion, 'writing-evaluation-response-v1');
    assert.deepEqual(response.body.review, review);
    assert.equal(response.body.writingProgress.confirmedAttempt.attemptId, 91);
    assert.equal(providerCalls(), 0);
  });
});

test('Writing v5-v8 replay reconstructs the official overlength fragment without a stored snapshot', async () => {
  const key = crypto.randomUUID();
  const requestPayload = {
    ...writingPayload,
    answer: Array.from({ length: 160 }, (_, index) => `word${index}`).join(' '),
  };
  const review = {
    ...JSON.parse(writingReview), words: 155, in_range: false,
  };
  await withWritingApp({ requestPayload, existingAttempt: {
    id: 91, username: 'owner-a', task_type: requestPayload.taskType, source_task_ref: '7',
    assignment: { from: 'Emily', stimulus: 'How are you? What do you study? What do you enjoy?', questionsTopic: 'her new flat' },
    answer: requestPayload.answer,
    evaluated_answer: requestPayload.answer.split(' ').slice(0, 140).join(' '),
    prompt_version: 'writing-v5', request_fingerprint: writingRequestFingerprint(requestPayload),
    idempotency_key: key, status: 'completed', review, provider: 'old-provider',
    response_snapshot: null, created_at: Date.now() - 86_400_000,
  } }, async ({ evaluate, providerCalls }) => {
    const response = await evaluate(key);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.evaluationScope, {
      fullWords: 155, evaluatedWords: 140, truncated: true, evaluatedLimit: 140,
    });
    assert.equal(providerCalls(), 0);
  });
});

test('Writing corrupt or unsupported archived review fails closed without a provider call', async () => {
  const key = crypto.randomUUID();
  await withWritingApp({ existingAttempt: {
    id: 91, username: 'owner-a', task_type: writingPayload.taskType,
    assignment: { from: 'Emily', stimulus: 'How are you? What do you study? What do you enjoy?', questionsTopic: 'her new flat' },
    answer: writingPayload.answer, prompt_version: 'writing-v10',
    request_fingerprint: writingRequestFingerprint(writingPayload), idempotency_key: key,
    status: 'completed', review: JSON.parse(writingReview), provider: 'old-provider',
    response_snapshot: { contractVersion: 'made-up-contract', review: JSON.parse(writingReview) },
    created_at: Date.now() - 86_400_000,
  } }, async ({ evaluate, providerCalls }) => {
    const response = await evaluate(key);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'WRITING_REPLAY_CONTRACT_UNAVAILABLE');
    assert.equal(providerCalls(), 0);
  });
});

test('Writing unversioned archived review fails closed without guessing a replay contract', async () => {
  const key = crypto.randomUUID();
  await withWritingApp({ existingAttempt: {
    id: 91, username: 'owner-a', task_type: writingPayload.taskType,
    assignment: { from: 'Emily', stimulus: 'How are you? What do you study? What do you enjoy?', questionsTopic: 'her new flat' },
    answer: writingPayload.answer, prompt_version: null,
    request_fingerprint: writingRequestFingerprint(writingPayload), idempotency_key: key,
    status: 'completed', review: JSON.parse(writingReview), provider: 'old-provider',
    response_snapshot: null, created_at: Date.now() - 86_400_000,
  } }, async ({ evaluate, providerCalls }) => {
    const response = await evaluate(key);
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'WRITING_REPLAY_CONTRACT_UNAVAILABLE');
    assert.equal(providerCalls(), 0);
  });
});

test('Writing progress-summary outage is status-only and recovers with the same paid attempt', async () => {
  const key = crypto.randomUUID();
  let summaryReads = 0;
  await withWritingApp({
    getWritingProgressSummary({ get }) {
      summaryReads += 1;
      if (summaryReads === 1) throw new Error('summary store temporarily unavailable');
      const attempt = get();
      return {
        version: 'writing-progress-v1', attemptCount: 1, average: 67,
        works: [{ attemptId: attempt.id, t: 37, taskId: null, g: 4, m: 6, n: 110,
          ts: Number(attempt.created_at) }],
      };
    },
  }, async ({ evaluate, providerCalls, finishCalls }) => {
    const first = await evaluate(key);
    assert.equal(first.status, 503);
    assert.equal(first.body.error.code, 'WRITING_PROGRESS_UNAVAILABLE');
    assert.equal(providerCalls(), 1);
    assert.equal(finishCalls(), 1);

    const status = await evaluate(key);
    assert.equal(status.status, 200);
    assert.equal(status.body.attemptId, 91);
    assert.equal(status.body.writingProgress.confirmedAttempt.attemptId, 91);
    assert.equal(providerCalls(), 1, 'summary recovery never dispatches a second provider call');
    assert.equal(finishCalls(), 1);
  });
});

test('Writing replay older than the recent-30 window carries a separate exact confirmation', async () => {
  const key = crypto.randomUUID();
  const review = JSON.parse(writingReview);
  await withWritingApp({ existingAttempt: {
    id: 91, username: 'owner-a', task_type: writingPayload.taskType, source_task_ref: 'old-task',
    assignment: { from: 'Emily', stimulus: 'How are you? What do you study? What do you enjoy?', questionsTopic: 'her new flat' },
    answer: writingPayload.answer, prompt_version: 'writing-v1',
    request_fingerprint: writingRequestFingerprint(writingPayload), idempotency_key: key,
    status: 'completed', review, provider: 'old-provider', response_snapshot: null,
    created_at: 1,
  }, getWritingProgressSummary() {
    return {
      version: 'writing-progress-v1', attemptCount: 31, average: 67,
      works: Array.from({ length: 30 }, (_, index) => ({
        attemptId: 100 + index, t: 37, taskId: `later-${index}`, g: 4, m: 6, n: 110, ts: index + 2,
      })),
    };
  } }, async ({ evaluate, providerCalls }) => {
    const response = await evaluate(key);
    assert.equal(response.status, 200);
    assert.equal(response.body.writingProgress.works.some((work) => work.attemptId === 91), false);
    assert.deepEqual(response.body.writingProgress.confirmedAttempt,
      { attemptId: 91, t: 37, taskId: 'old-task', g: 4, m: 6, n: 110, ts: 1 });
    assert.equal(providerCalls(), 0);
  });
});

test('Writing exact completed and pending status replay stays readable after access or consent is revoked', async () => {
  for (const status of ['completed', 'pending']) {
    const key = crypto.randomUUID();
    const oldReview = JSON.parse(writingReview);
    const oldSnapshot = { review: oldReview, provider: 'old-provider', attemptId: 91,
      voiceTutor: null, assessment: { version: 'old' }, evaluationScope: { version: 'old' } };
    let accessChecks = 0;
    const deny = (_req, res) => {
      accessChecks += 1;
      return res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED' } });
    };
    await withWritingApp({ existingAttempt: {
      id: 91, username: 'owner-a', task_type: writingPayload.taskType,
      assignment: { from: 'Emily', stimulus: 'How are you? What do you study? What do you enjoy?', questionsTopic: 'her new flat' },
      answer: writingPayload.answer,
      prompt_version: 'writing-v1', request_fingerprint: writingRequestFingerprint(writingPayload),
      idempotency_key: key, status, review: status === 'completed' ? oldReview : null,
      provider: status === 'completed' ? 'old-provider' : null,
      response_snapshot: status === 'completed' ? oldSnapshot : null, created_at: Date.now(),
    }, accessOverrides: { requireActiveSubscription: deny, requirePrivacyConsent: () => deny } }, async ({ evaluate, providerCalls }) => {
      const response = await evaluate(key);
      assert.equal(response.status, status === 'completed' ? 200 : 409);
      if (status === 'completed') {
        assert.equal(response.body.contractVersion, 'writing-evaluation-response-v1');
        assert.deepEqual(response.body.review, oldReview);
        assert.equal(response.body.writingProgress.attemptCount, 1);
        assert.equal(response.body.writingProgress.confirmedAttempt.attemptId, 91);
      }
      else assert.equal(response.body.error.code, 'WRITING_EVALUATION_IN_PROGRESS');
      assert.equal(accessChecks, 0, 'read-only exact status replay must run before current access gates');
      assert.equal(providerCalls(), 0);
    });
  }
});

test('Writing does not prepare a learner prompt before subscription, consent or rate gates', async () => {
  const denials = [
    { accessOverrides: { requireActiveSubscription: (_req, res) => res.status(403).json({ error: { code: 'SUBSCRIPTION_REQUIRED' } }) }, status: 403 },
    { accessOverrides: { requirePrivacyConsent: () => (_req, res) => res.status(403).json({ error: { code: 'PRIVACY_CONSENT_REQUIRED' } }) }, status: 403 },
    { accessOverrides: { createOperationLimiter: () => (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED' } }) }, status: 429 },
  ];
  for (const denial of denials) {
    let preparationCalls = 0;
    await withWritingApp({
      ...denial,
      writingPromptPreparer() { preparationCalls += 1; throw new Error('PROMPT_PREPARATION_MUST_NOT_RUN'); },
    }, async ({ evaluate, providerCalls }) => {
      const response = await evaluate();
      assert.equal(response.status, denial.status);
      assert.equal(preparationCalls, 0);
      assert.equal(providerCalls(), 0);
    });
  }
});

test('Writing predecessor tombstone is a truthful non-paying 409 replay', async () => {
  const key = crypto.randomUUID();
  await withWritingApp({ existingAttempt: {
    id: 91, username: 'owner-a', task_type: writingPayload.taskType, assignment: {}, answer: writingPayload.answer,
    prompt_version: 'writing-v9', request_fingerprint: writingRequestFingerprint(writingPayload),
    idempotency_key: key, status: 'failed', error_code: 'WRITING_EVALUATION_REPEAT_ACKNOWLEDGED', created_at: Date.now(),
  } }, async ({ evaluate, providerCalls }) => {
    const response = await evaluate(key);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'WRITING_EVALUATION_REPEAT_ACKNOWLEDGED');
    assert.equal(providerCalls(), 0);
  });
});

test('Writing accepted-but-unacknowledged provider transport stays ambiguous on the exact claim', async () => {
  const key = crypto.randomUUID();
  await withWritingApp({
    async askWithFallback() { throw new TypeError('provider response acknowledgement lost'); },
  }, async ({ evaluate, providerCalls, finishCalls }) => {
    const first = await evaluate(key);
    assert.equal(first.status, 503);
    assert.equal(first.body.error.code, 'WRITING_EVALUATION_SETTLEMENT_UNKNOWN');
    assert.equal(providerCalls(), 1);
    assert.equal(finishCalls(), 0);

    const status = await evaluate(key);
    assert.equal(status.status, 409);
    assert.equal(status.body.error.code, 'WRITING_EVALUATION_SETTLEMENT_UNKNOWN');
    assert.equal(providerCalls(), 1, 'status polling cannot repeat possibly paid work');
    assert.equal(finishCalls(), 0);
  });
});

for (const [failure, makeError] of [
  ['hanging successful body timeout', () => Object.assign(new Error('provider body timeout'), { name: 'AbortError' })],
  ['aborted successful body read', () => new DOMException('provider body aborted', 'AbortError')],
  ['invalid successful JSON body', () => new SyntaxError('Unexpected end of JSON input')],
]) {
  test(`Writing ${failure} requires explicit acknowledgement before another paid call`, async () => {
    const originalKey = crypto.randomUUID();
    let physicalCalls = 0;
    await withWritingApp({
      async askWithFallback() {
        physicalCalls += 1;
        if (physicalCalls === 1) {
          const error = makeError();
          error.providerDispatch = 'possibly_dispatched';
          throw error;
        }
        return {
          text: writingReview, provider: 'test', model: 'test', attempts: 1,
          promptTokens: 10, completionTokens: 10,
        };
      },
    }, async ({ evaluate, providerCalls, finishCalls }) => {
      const first = await evaluate(originalKey);
      assert.equal(first.status, 503);
      assert.equal(first.body.error.code, 'WRITING_EVALUATION_SETTLEMENT_UNKNOWN');
      assert.equal(providerCalls(), 1);
      assert.equal(finishCalls(), 0);

      const exactStatus = await evaluate(originalKey);
      assert.equal(exactStatus.status, 409);
      assert.equal(exactStatus.body.error.code, 'WRITING_EVALUATION_SETTLEMENT_UNKNOWN');
      assert.equal(providerCalls(), 1, 'exact status polling cannot repeat possibly paid work');

      const acknowledged = await evaluate(crypto.randomUUID(), {
        'x-easyboost-acknowledge-provider-repeat': originalKey,
      });
      assert.equal(acknowledged.status, 200);
      assert.equal(acknowledged.body.attemptId, 92);
      assert.equal(providerCalls(), 2, 'a second paid call starts only after explicit acknowledgement');
      assert.equal(finishCalls(), 1);
    });
  });
}

test('Writing settlement failure is marked ambiguous and permits one immediate acknowledged retry', async () => {
  const originalKey = crypto.randomUUID();
  let allowSettlement = false;
  await withWritingApp({
    finishWritingAttempt({ result, get, set }) {
      if (!allowSettlement) throw new Error('durable store unavailable');
      set({ ...get(), status: result.status, review: result.review, provider: result.provider,
        model: result.model, response_snapshot: result.responseSnapshot });
      return true;
    },
  }, async ({ evaluate, providerCalls, finishCalls }) => {
    const first = await evaluate(originalKey);
    assert.equal(first.status, 503);
    assert.equal(first.body.error.code, 'WRITING_EVALUATION_SETTLEMENT_UNKNOWN');
    assert.equal(finishCalls(), 2);

    allowSettlement = true;
    const repeated = await evaluate(crypto.randomUUID(), {
      'x-easyboost-acknowledge-provider-repeat': originalKey,
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.attemptId, 92);
    assert.equal(providerCalls(), 2, 'the second paid call occurs only after explicit acknowledgement');
    assert.equal(finishCalls(), 3);
  });
});

test('Writing early repeat acknowledgement maps to a deterministic 409', async () => {
  const originalKey = crypto.randomUUID();
  await withWritingApp({ existingAttempt: {
    id: 91, username: 'owner-a', task_type: writingPayload.taskType, assignment: {}, answer: writingPayload.answer,
    prompt_version: 'writing-v9', request_fingerprint: writingRequestFingerprint(writingPayload),
    idempotency_key: originalKey, status: 'pending', created_at: Date.now(),
  } }, async ({ evaluate, providerCalls }) => {
    const response = await evaluate(crypto.randomUUID(), {
      'x-easyboost-acknowledge-provider-repeat': originalKey,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'WRITING_EVALUATION_REPEAT_ACK_NOT_READY');
    assert.equal(providerCalls(), 0);
  });
});

test('Writing physical provider keys isolate owners that reuse the same client UUID', async () => {
  const clientKey = crypto.randomUUID();
  const observed = [];
  for (const [owner, attemptId] of [['owner-a', 91], ['owner-b', 92]]) {
    await withWritingApp({ owner, attemptId }, async ({ evaluate, providerKeys }) => {
      const response = await evaluate(clientKey);
      assert.equal(response.status, 200);
      observed.push(providerKeys()[0]);
    });
  }
  assert.equal(observed.length, 2);
  assert.notEqual(observed[0], observed[1]);
  assert.ok(observed.every((key) => /^writing:[a-f0-9]{64}$/u.test(key)));
  assert.ok(observed.every((key) => !key.includes(clientKey)), 'provider key never exposes the owner-local client UUID');
});

test('Writing atomically reserves the final daily AI slot before any provider transport', async () => {
  let slotTaken = false;
  const claimLastSlot = async (_username, claim) => {
    if (slotTaken) throw Object.assign(new Error('AI_BUDGET_EXHAUSTED'), {
      code: 'AI_BUDGET_EXHAUSTED', status: 503,
    });
    slotTaken = true;
    return { applied: true, claim_id: claim.claimId, status: 'in_progress' };
  };
  const settle = async (_username, _claimId, settlement) => ({
    applied: true, status: settlement.status,
  });

  await withWritingApp({ owner: 'budget-owner-a', attemptId: 191,
    claimAiOperationSlot: claimLastSlot, settleAiOperationSlot: settle }, async (left) => {
    await withWritingApp({ owner: 'budget-owner-b', attemptId: 192,
      claimAiOperationSlot: claimLastSlot, settleAiOperationSlot: settle }, async (right) => {
      const responses = await Promise.all([left.evaluate(), right.evaluate()]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 503]);
      assert.equal(responses.find((response) => response.status === 503).body.error.code,
        'AI_BUDGET_EXHAUSTED');
      assert.equal(left.providerCalls() + right.providerCalls(), 1,
        'the rejected last-slot contender never reaches a paid provider');
      assert.equal(left.operationClaims().length + right.operationClaims().length, 2);
      assert.equal(left.operationSettlements().length + right.operationSettlements().length, 1);
    });
  });
});

test('Writing meter settlement failure leaves one paid call ambiguous and never auto-repeats it', async () => {
  const key = crypto.randomUUID();
  await withWritingApp({
    async settleAiOperationSlot() { throw new Error('durable AI meter unavailable'); },
  }, async ({ evaluate, providerCalls, finishCalls, operationClaims, operationSettlements }) => {
    const first = await evaluate(key);
    assert.equal(first.status, 503);
    assert.equal(first.body.error.code, 'WRITING_EVALUATION_SETTLEMENT_UNKNOWN');
    assert.equal(providerCalls(), 1);
    assert.equal(finishCalls(), 0);
    assert.equal(operationClaims().length, 1);
    assert.equal(operationSettlements().length, 1);

    const replay = await evaluate(key);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, 'WRITING_EVALUATION_SETTLEMENT_UNKNOWN');
    assert.equal(providerCalls(), 1, 'status replay cannot dispatch after meter settlement loss');
  });
});

test('Writing AI operation journal never persists raw provider error text', async () => {
  const canary = 'learner-answer-canary-should-never-persist';
  await withWritingApp({
    async askWithFallback() {
      const error = new Error(`provider rejected ${canary}`);
      error.providerDispatch = 'definitive_response';
      throw error;
    },
  }, async ({ evaluate, operationSettlements }) => {
    const response = await evaluate();
    assert.equal(response.status, 502);
    const journal = operationSettlements();
    assert.equal(journal.length, 1);
    assert.equal(journal[0].errorCode, 'AI_PROVIDER_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(journal), new RegExp(canary, 'u'));
  });
});

test('Writing successful fallback settlement cannot persist a provider-body canary', async () => {
  const canary = 'learner-answer-canary-from-primary-5xx';
  await withWritingApp({
    async askWithFallback() {
      return { text: writingReview, provider: 'test', model: 'test', attempts: 2,
        promptTokens: 10, completionTokens: 10,
        fallbackReason: `primary: 503 echoed ${canary}` };
    },
  }, async ({ evaluate, operationSettlements }) => {
    const response = await evaluate();
    assert.equal(response.status, 200);
    const journal = operationSettlements();
    assert.equal(journal.length, 1);
    assert.equal(journal[0].status, 'completed');
    assert.equal(journal[0].fallbackReason,
      'provider fallback used; failed attempts are recorded separately');
    assert.doesNotMatch(JSON.stringify(journal), new RegExp(canary, 'u'));
  });
});

test('Writing denied repair slot records the consumed primary as a contract failure', async () => {
  await withWritingApp({
    async askWithFallback() {
      return { text: '{ invalid json', provider: 'test', model: 'test', attempts: 1,
        promptTokens: 10, completionTokens: 10 };
    },
    async parseWithOneRepair({ text, parse }) {
      try { parse(text); } catch (firstError) {
        throw Object.assign(new Error('AI_BUDGET_EXHAUSTED'), {
          code: 'AI_BUDGET_EXHAUSTED', status: 503, repairOf: firstError.message,
        });
      }
      throw new Error('expected invalid provider response');
    },
  }, async ({ evaluate, operationSettlements }) => {
    const response = await evaluate();
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'AI_BUDGET_EXHAUSTED');
    const journal = operationSettlements();
    assert.equal(journal.length, 1);
    assert.equal(journal[0].status, 'failed');
    assert.equal(journal[0].errorCode, 'AI_RESPONSE_INVALID_JSON');
    assert.match(journal[0].fallbackReason, /AI_RESPONSE_INVALID_JSON/u);
  });
});

test('Writing stale observation cannot fence out the original paid worker', async () => {
  const key = crypto.randomUUID();
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  await withWritingApp({
    async askWithFallback() {
      await providerGate;
      return { text: writingReview, provider: 'test', model: 'test', attempts: 1,
        promptTokens: 10, completionTokens: 10 };
    },
  }, async ({ evaluate, providerCalls, finishCalls, ageAttempt }) => {
    const originalWorker = evaluate(key);
    while (providerCalls() !== 1) await new Promise((resolve) => setTimeout(resolve, 0));
    ageAttempt(10 * 60 * 1000);

    const staleObserver = await evaluate(key);
    assert.equal(staleObserver.status, 409);
    assert.equal(staleObserver.body.error.code, 'WRITING_EVALUATION_SETTLEMENT_UNKNOWN');
    assert.equal(providerCalls(), 1);
    assert.equal(finishCalls(), 0);

    releaseProvider();
    const completed = await originalWorker;
    assert.equal(completed.status, 200);
    assert.equal(completed.body.attemptId, 91);
    const replay = await evaluate(key);
    assert.equal(replay.status, 200);
    const withoutConfirmationTime = (body) => ({ ...body, writingProgress: {
      ...body.writingProgress,
      confirmedAttempt: { ...body.writingProgress.confirmedAttempt, ts: 0 },
    } });
    assert.deepEqual(withoutConfirmationTime(replay.body), withoutConfirmationTime(completed.body));
    assert.ok(Number.isFinite(replay.body.writingProgress.confirmedAttempt.ts));
    assert.ok(Number.isFinite(completed.body.writingProgress.confirmedAttempt.ts));
    assert.equal(providerCalls(), 1);
    assert.equal(finishCalls(), 1);
  });
});
