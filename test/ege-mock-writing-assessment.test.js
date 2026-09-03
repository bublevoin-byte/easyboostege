import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getWritingRules } from '../ai/writing.js';
import { EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockForm } from '../ege-mock/catalog.js';
import {
  createEgeMockWritingAssessmentService,
  createEgeMockWritingConsentAuthority,
  createEgeMockWritingProviderEvaluator,
} from '../ege-mock/writing-assessment-service.js';
import {
  createEgeMockWritingAssessmentBinding,
  EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
} from '../ege-mock/writing-assessment.js';
import { createFileRepository } from '../storage/file-repository.js';
import { AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT } from '../public/automatic-assessment-contract.js';
import { completeEgeMockOralStageLedger } from './support/ege-mock-attempt-contract.js';

const words = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join(' ');

function outcomeBinding(item) {
  return createEgeMockWritingAssessmentBinding(item);
}

test('provider adapter uses the existing bounded fallback/repair seam with exact authored assignment', async () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const authored = form.positions[36];
  const assignment = authored.presentation;
  const criteriaSnapshot = getWritingRules('writing_37').criteria
    .map(([name, maximum]) => ({ name, maximum }));
  const copiedQuestion = assignment.stimulus.match(/[^.!?…]*\?/u)[0].trim();
  const answer = `${copiedQuestion}\n${words(110, 'mail')}`;
  const review = {
    words: 110, in_range: true, overall_got: 6, overall_max: 6,
    verdict: 'Provisionally checked.', sub: 'Review the evidence.',
    criteria: [
      { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
      { name: 'Организация текста', got: 2, max: 2 },
      { name: 'Языковое оформление', got: 2, max: 2 },
    ],
    errors: [],
  };
  const calls = [];
  const providerClient = {
    limitsFor(operation) {
      assert.equal(operation, 'writing_37');
      return { requestsPerHour: 12 };
    },
    aiProviders: () => [{ name: 'fake-provider', model: 'fake-model' }],
    async askWithFallback(system, user, operation) {
      calls.push({ system, user, operation });
      return {
        provider: 'fake-provider', model: 'fake-model', text: JSON.stringify(review),
        promptTokens: 30, completionTokens: 40,
      };
    },
    async parseWithOneRepair(input) {
      return { value: input.parse(input.text), repair: null };
    },
  };
  const evaluate = createEgeMockWritingProviderEvaluator({ providerClient });
  assert.deepEqual(evaluate.limitsFor('writing_37'), { requestsPerHour: 12 });
  const result = await evaluate({
    taskType: 'writing_37', assignment, fullAnswer: answer, evaluatedAnswer: answer,
    formRef: { id: form.id, revision: form.revision, fingerprint: form.fingerprint },
    contentRef: authored.contentRef,
    criteriaRef: authored.assessment.criteriaRef,
    criteriaFingerprint: authored.assessment.criteriaFingerprint,
    criteriaSnapshot,
    scope: { fullWords: 110, evaluatedWords: 110, truncated: false, evaluatedLimit: 140 },
  });
  assert.deepEqual(result.review, review);
  assert.deepEqual({ provider: result.provider, model: result.model }, {
    provider: 'fake-provider', model: 'fake-model',
  });
  assert.equal(calls[0].operation, 'writing_37');
  assert.match(calls[0].user, new RegExp(assignment.questionsTopic, 'u'));
  assert.match(calls[0].user, new RegExp(authored.contentRef.id, 'u'));
  assert.match(calls[0].user, new RegExp(authored.assessment.criteriaRef, 'u'));
  assert.match(calls[0].user, new RegExp(authored.assessment.criteriaFingerprint, 'u'));
  assert.match(calls[0].user, new RegExp(criteriaSnapshot[0].name, 'u'));
  assert.match(calls[0].system, /untrusted|\u043dедовер/iu);

  await assert.rejects(evaluate({
    taskType: 'writing_37', assignment, fullAnswer: answer, evaluatedAnswer: answer,
    formRef: { id: form.id, revision: form.revision, fingerprint: form.fingerprint },
    contentRef: authored.contentRef,
    criteriaRef: authored.assessment.criteriaRef,
    criteriaFingerprint: authored.assessment.criteriaFingerprint,
    criteriaSnapshot: [{ ...criteriaSnapshot[0], maximum: 1 }, ...criteriaSnapshot.slice(1)],
    scope: { fullWords: 110, evaluatedWords: 110, truncated: false, evaluatedLimit: 140 },
  }), /EGE_MOCK_WRITING_ASSESSMENT_CONTEXT_INVALID/u);
  assert.equal(calls.length, 1, 'pinned-rubric drift must fail before provider transport');
});

test('writing assessment denies provider work when no explicit consent authority is configured', async () => {
  let evaluatorCalls = 0;
  let failure = null;
  const item = {
    position: 37,
    taskType: 'writing_37',
    maximum: 6,
    promptVersion: 'writing-v3',
    fullAnswer: words(100, 'mail'),
    evaluatedAnswer: words(100, 'mail'),
    scope: { fullWords: 100, evaluatedWords: 100, truncated: false, evaluatedLimit: 140 },
    criteriaSnapshot: [],
  };
  const repository = {
    async claimEgeMockWritingAssessment() {
      return {
        claimed: true,
        work: {
          claimToken: 'cfb4d916-0ce5-4396-8b58-86120345c6e5',
          attemptId: 'f87d8306-f9c0-472d-8467-5dd40460fb72',
          items: [item],
        },
      };
    },
    async renewEgeMockWritingAssessmentClaim() { return { renewed: true }; },
    async completeEgeMockWritingAssessmentItem() {
      return { writingAssessment: { status: 'completed' } };
    },
    async failEgeMockWritingAssessment(_username, _attemptId, candidate) {
      failure = candidate.reason;
      return { status: 'retryable' };
    },
  };
  const service = createEgeMockWritingAssessmentService({
    repository,
    evaluator: async () => {
      evaluatorCalls += 1;
      return { review: {} };
    },
    uuid: () => 'cfb4d916-0ce5-4396-8b58-86120345c6e5',
  });

  assert.deepEqual(await service.dispatch('owner', item.attemptId), {
    status: 'retryable', dispatched: true,
  });
  assert.equal(evaluatorCalls, 0);
  assert.equal(failure, 'privacy_consent_required');
});

test('a durable result token prevents a paid evaluation from repeating after completion persistence fails', async () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const authored = form.positions[36];
  const item = {
    position: 37,
    taskType: 'writing_37',
    maximum: 6,
    promptVersion: 'writing-v3',
    formRef: { id: form.id, revision: form.revision, fingerprint: form.fingerprint },
    contentRef: structuredClone(authored.contentRef),
    assignment: structuredClone(authored.presentation),
    criteriaRef: authored.assessment.criteriaRef,
    criteriaFingerprint: authored.assessment.criteriaFingerprint,
    fullAnswer: words(100, 'mail'),
    evaluatedAnswer: words(100, 'mail'),
    scope: { fullWords: 100, evaluatedWords: 100, truncated: false, evaluatedLimit: 140 },
    criteriaSnapshot: [
      { name: 'Communicative task', maximum: 2 },
      { name: 'Organization', maximum: 2 },
      { name: 'Language', maximum: 2 },
    ],
    outcome: null,
  };
  let status = 'pending';
  let durableOutcome = null;
  let completionFailures = 1;
  let evaluatorCalls = 0;
  let outcomeRecords = 0;
  let aiClaims = 0;
  let renewalCalls = 0;
  const claimTokens = [
    'c170258c-94e2-418e-ac76-1fd226c814b6',
    'b4250c7a-34f7-471f-9b01-1d32c89eeff0',
  ];
  const outcomeToken = '91c05a6f-d87a-4eb2-9654-651d0765ac18';
  const repository = {
    async claimEgeMockWritingAssessment() {
      if (status !== 'pending') return { claimed: false, status };
      status = 'in_progress';
      return {
        claimed: true,
        work: {
          claimToken: claimTokens.shift(),
          attemptId: '6319c587-6ffc-44a6-a834-572d433d3d60',
          retryCount: 0,
          items: [{ ...item, outcome: durableOutcome && structuredClone(durableOutcome) }],
        },
      };
    },
    async renewEgeMockWritingAssessmentClaim() {
      renewalCalls += 1;
      return { renewed: true };
    },
    async prepareEgeMockWritingAssessmentItemOutcome(_username, _attemptId, candidate) {
      durableOutcome ||= { token: candidate.outcomeToken, status: 'prepared' };
      return { applied: true, outcome: structuredClone(durableOutcome) };
    },
    async recordEgeMockWritingAssessmentItemOutcome(_username, _attemptId, candidate) {
      outcomeRecords += 1;
      durableOutcome = {
        token: candidate.outcomeToken,
        status: 'recorded',
        review: structuredClone(candidate.review),
        provenance: structuredClone(candidate.provenance),
        calls: structuredClone(candidate.calls),
      };
      return { applied: true, outcome: structuredClone(durableOutcome) };
    },
    async completeEgeMockWritingAssessmentItem(_username, _attemptId, candidate) {
      assert.equal(candidate.outcomeToken, outcomeToken);
      if (completionFailures > 0) {
        completionFailures -= 1;
        throw Object.assign(new Error('PERSISTENCE_UNAVAILABLE'), { code: 'PERSISTENCE_UNAVAILABLE' });
      }
      status = 'completed';
      return { writingAssessment: { status } };
    },
    async failEgeMockWritingAssessment() {
      status = 'retryable';
      return { status };
    },
  };
  const review = {
    words: 100,
    in_range: true,
    overall_got: 6,
    overall_max: 6,
    verdict: 'Provisionally checked.',
    sub: 'Review the evidence.',
    criteria: item.criteriaSnapshot.map(({ name, maximum }) => ({ name, got: maximum, max: maximum })),
    errors: [],
  };
  const service = createEgeMockWritingAssessmentService({
    repository,
    evaluator: async () => {
      evaluatorCalls += 1;
      return { review, provider: 'fake-provider', model: 'fake-model', promptTokens: 10, completionTokens: 5 };
    },
    uuid: (() => {
      const values = [claimTokens[0], outcomeToken, claimTokens[1]];
      return () => values.shift();
    })(),
    consentAuthority: { canEvaluate: async () => true },
    claimAiOperation: async () => {
      aiClaims += 1;
      return { applied: true, status: 'in_progress' };
    },
    settleAiOperation: async () => ({ applied: true, status: 'completed' }),
    limitsFor: () => ({ requestsPerHour: 3 }),
    dailyLimit: 100,
  });

  assert.equal((await service.dispatch('owner', '6319c587-6ffc-44a6-a834-572d433d3d60')).status, 'retryable');
  status = 'pending';
  assert.equal((await service.dispatch('owner', '6319c587-6ffc-44a6-a834-572d433d3d60')).status, 'completed');
  assert.equal(evaluatorCalls, 1);
  assert.equal(outcomeRecords, 1);
  assert.equal(aiClaims, 1);
  assert.equal(renewalCalls >= 7, true,
    'the owner-fenced lease is renewed around provider, settlement and completion boundaries');
});

test('a duplicate durable AI claim preserves the prepared token for non-paying recovery', async () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const authored = form.positions[36];
  const criteriaSnapshot = getWritingRules('writing_37').criteria
    .map(([name, maximum]) => ({ name, maximum }));
  const item = {
    position: 37, taskType: 'writing_37', taskId: authored.contentRef.id, maximum: 6,
    promptVersion: 'writing-v9',
    formRef: { id: form.id, revision: form.revision, fingerprint: form.fingerprint },
    contentRef: structuredClone(authored.contentRef), assignment: structuredClone(authored.presentation),
    criteriaRef: authored.assessment.criteriaRef,
    criteriaFingerprint: authored.assessment.criteriaFingerprint,
    criteriaSnapshot, fullAnswer: words(100, 'mail'), evaluatedAnswer: words(100, 'mail'),
    scope: { fullWords: 100, evaluatedWords: 100, truncated: false, evaluatedLimit: 140 },
    outcome: null,
  };
  let prepared = null;
  let failure = null;
  let evaluatorCalls = 0;
  const repository = {
    async claimEgeMockWritingAssessment() {
      return {
        claimed: true,
        work: {
          claimToken: '20d07799-1a56-4440-8bf6-f6effa1d519c',
          authorization: { textProcessingConsent: true },
          items: [{ ...structuredClone(item), outcome: structuredClone(prepared) }],
        },
      };
    },
    async renewEgeMockWritingAssessmentClaim() { return { renewed: true }; },
    async prepareEgeMockWritingAssessmentItemOutcome(_owner, _attempt, candidate) {
      prepared = { token: candidate.outcomeToken, status: 'prepared' };
      return { applied: true, outcome: structuredClone(prepared) };
    },
    async failEgeMockWritingAssessment(_owner, _attempt, candidate) {
      failure = structuredClone(candidate);
      if (!candidate.discardPreparedOutcome && prepared?.status === 'prepared') {
        prepared.status = 'prepared_unknown';
      }
      return { status: candidate.reason === 'provider_result_recovery_pending' ? 'pending' : 'retryable' };
    },
  };
  const service = createEgeMockWritingAssessmentService({
    repository,
    evaluator: async () => { evaluatorCalls += 1; return {}; },
    uuid: (() => {
      const values = [
        '20d07799-1a56-4440-8bf6-f6effa1d519c',
        '4ff90dab-ad0f-433d-8034-301268bb15c0',
      ];
      return () => values.shift();
    })(),
    consentAuthority: { canEvaluate: async () => true },
    claimAiOperation: async () => ({ applied: false, status: 'in_progress' }),
    settleAiOperation: async () => ({ applied: false, status: 'in_progress' }),
    limitsFor: () => ({ requestsPerHour: 3 }), dailyLimit: 100,
  });

  assert.deepEqual(await service.dispatch('owner', 'd6d33fb3-6bf7-4ab8-a713-58a412dd1fd1'), {
    status: 'pending', dispatched: true,
  });
  assert.equal(evaluatorCalls, 0, 'a duplicate durable claim never enters provider evaluation');
  assert.equal(failure.reason, 'provider_result_recovery_pending');
  assert.equal(failure.discardPreparedOutcome, false,
    'the prepared token stays the sole idempotency key after an uncertain prior claim');
  assert.deepEqual(prepared, {
    token: '4ff90dab-ad0f-433d-8034-301268bb15c0', status: 'prepared_unknown',
  });
});

for (const rejection of [
  { code: 'AI_BUDGET_EXHAUSTED', reason: 'ai_budget_exhausted' },
  { code: 'RATE_LIMITED', reason: 'rate_limited' },
]) {
  test(`a deterministic ${rejection.code} claim rejection discards the unspent prepared token`, async () => {
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const authored = form.positions[36];
    const criteriaSnapshot = getWritingRules('writing_37').criteria
      .map(([name, maximum]) => ({ name, maximum }));
    const item = {
      position: 37, taskType: 'writing_37', taskId: authored.contentRef.id, maximum: 6,
      promptVersion: 'writing-v9',
      formRef: { id: form.id, revision: form.revision, fingerprint: form.fingerprint },
      contentRef: structuredClone(authored.contentRef), assignment: structuredClone(authored.presentation),
      criteriaRef: authored.assessment.criteriaRef,
      criteriaFingerprint: authored.assessment.criteriaFingerprint,
      criteriaSnapshot, fullAnswer: words(100, 'mail'), evaluatedAnswer: words(100, 'mail'),
      scope: {
        fullWords: 100, evaluatedWords: 100, excludedWords: 0, sourceOverlapPercent: 0,
        rangeState: 'in_range', evaluatedRangeState: 'in_range', minimumWords: 90,
        maximumWords: 154, lowerShoulderWords: 81, upperShoulderWords: 169,
        truncated: false, exclusionReasons: [],
      },
    };
    let prepared = null;
    let failure = null;
    let evaluatorCalls = 0;
    const repository = {
      async claimEgeMockWritingAssessment() {
        return {
          claimed: true, status: 'pending',
          work: {
            claimToken: 'a36b4fe1-571f-46bc-a7ca-a827dbd512c9',
            authorization: { textProcessingConsent: true },
            items: [{ ...structuredClone(item), outcome: structuredClone(prepared) }],
          },
        };
      },
      async renewEgeMockWritingAssessmentClaim() { return { renewed: true }; },
      async prepareEgeMockWritingAssessmentItemOutcome(_owner, _attempt, candidate) {
        prepared = { token: candidate.outcomeToken, status: 'prepared' };
        return { applied: true, outcome: structuredClone(prepared) };
      },
      async failEgeMockWritingAssessment(_owner, _attempt, candidate) {
        failure = structuredClone(candidate);
        if (candidate.discardPreparedOutcome) prepared = null;
        return { status: 'retryable' };
      },
    };
    const service = createEgeMockWritingAssessmentService({
      repository,
      evaluator: async () => { evaluatorCalls += 1; return {}; },
      uuid: (() => {
        const values = [
          'fbd52e74-5a32-45b3-8edc-115d676375c5',
          '8e0f4245-3f89-4874-ae6c-36bbd4e7c3c5',
        ];
        return () => values.shift();
      })(),
      consentAuthority: { canEvaluate: async () => true },
      claimAiOperation: async () => {
        throw Object.assign(new Error(rejection.code), { code: rejection.code });
      },
      settleAiOperation: async () => ({ applied: false }),
      limitsFor: () => ({ requestsPerHour: 3 }), dailyLimit: 100,
    });

    assert.deepEqual(await service.dispatch('owner', '4a716a41-0c04-4dd9-af08-a7b3d15c8bee'), {
      status: 'retryable', dispatched: true,
    });
    assert.equal(evaluatorCalls, 0, 'a deterministic claim rejection never enters provider evaluation');
    assert.equal(failure.reason, rejection.reason);
    assert.equal(failure.discardPreparedOutcome, true,
      'a proven pre-provider rejection must remain an ordinary retry');
    assert.equal(prepared, null, 'the unspent prepared token is discarded');
  });
}

test('provider success survives the first post-success lease-renewal failure as prepared unknown', async () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const authored = form.positions[36];
  const criteriaSnapshot = getWritingRules('writing_37').criteria
    .map(([name, maximum]) => ({ name, maximum }));
  const item = {
    position: 37, taskType: 'writing_37', taskId: authored.contentRef.id, maximum: 6,
      promptVersion: 'writing-v9',
    formRef: { id: form.id, revision: form.revision, fingerprint: form.fingerprint },
    contentRef: structuredClone(authored.contentRef), assignment: structuredClone(authored.presentation),
    criteriaRef: authored.assessment.criteriaRef,
    criteriaFingerprint: authored.assessment.criteriaFingerprint,
    criteriaSnapshot, fullAnswer: words(100, 'mail'), evaluatedAnswer: words(100, 'mail'),
    scope: { fullWords: 100, evaluatedWords: 100, truncated: false, evaluatedLimit: 140 },
    outcome: null,
  };
  const review = {
    words: 100, in_range: true, overall_got: 6, overall_max: 6,
    verdict: 'Provisionally checked.', sub: 'Review the evidence.',
    criteria: criteriaSnapshot.map(({ name, maximum }) => ({ name, got: maximum, max: maximum })),
    errors: [],
  };
  let prepared = null;
  let failure = null;
  let renewals = 0;
  const repository = {
    async claimEgeMockWritingAssessment() {
      return {
        claimed: true,
        work: {
          claimToken: 'b1aa9539-c69f-4fa9-a25e-088a31b85268',
          authorization: { textProcessingConsent: true },
          items: [{ ...structuredClone(item), outcome: structuredClone(prepared) }],
        },
      };
    },
    async renewEgeMockWritingAssessmentClaim() {
      renewals += 1;
      if (renewals === 3) throw new Error('lease storage temporarily unavailable');
      return { renewed: true };
    },
    async prepareEgeMockWritingAssessmentItemOutcome(_owner, _attempt, candidate) {
      prepared = { token: candidate.outcomeToken, status: 'prepared' };
      return { applied: true, outcome: structuredClone(prepared) };
    },
    async failEgeMockWritingAssessment(_owner, _attempt, candidate) {
      failure = structuredClone(candidate);
      if (!candidate.discardPreparedOutcome && prepared?.status === 'prepared') {
        prepared.status = 'prepared_unknown';
      }
      return { status: candidate.reason === 'provider_result_recovery_pending' ? 'pending' : 'retryable' };
    },
  };
  const service = createEgeMockWritingAssessmentService({
    repository,
    evaluator: async () => ({ review, provider: 'fake-provider', model: 'fake-model' }),
    uuid: (() => {
      const values = [
        'b1aa9539-c69f-4fa9-a25e-088a31b85268',
        'c7572b96-d6cd-407a-a07a-5eea67d2d3ef',
      ];
      return () => values.shift();
    })(),
    consentAuthority: { canEvaluate: async () => true },
  });

  assert.deepEqual(await service.dispatch('owner', '0bd0cc9e-04e6-459e-ae20-d66f27d0a817'), {
    status: 'pending', dispatched: true,
  });
  assert.equal(failure.discardPreparedOutcome, false,
    'a successful paid provider call is never made repeatable by a later lease failure');
  assert.equal(failure.reason, 'provider_result_recovery_pending');
  assert.equal(prepared.status, 'prepared_unknown');
});

test('automatic prepared-result recovery is non-paying and unresolved work becomes explicitly ambiguous', async () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const authored = form.positions[36];
  const outcomeToken = 'bd924676-1b20-4c40-a6af-a99aaef79843';
  const item = {
    position: 37,
    taskType: 'writing_37',
    taskId: authored.contentRef.id,
    maximum: 6,
      promptVersion: 'writing-v9',
    formRef: { id: form.id, revision: form.revision, fingerprint: form.fingerprint },
    contentRef: structuredClone(authored.contentRef),
    assignment: structuredClone(authored.presentation),
    criteriaRef: authored.assessment.criteriaRef,
    criteriaFingerprint: authored.assessment.criteriaFingerprint,
    criteriaSnapshot: getWritingRules('writing_37').criteria
      .map(([name, maximum]) => ({ name, maximum })),
    fullAnswer: words(100, 'mail'),
    evaluatedAnswer: words(100, 'mail'),
    scope: { fullWords: 100, evaluatedWords: 100, truncated: false, evaluatedLimit: 140 },
    outcome: { token: outcomeToken, status: 'prepared' },
  };
  const review = {
    words: 100, in_range: true, overall_got: 6, overall_max: 6,
    verdict: 'Recovered without another provider call.', sub: 'Review the evidence.',
    criteria: item.criteriaSnapshot.map(({ name, maximum }) => ({ name, got: maximum, max: maximum })),
    errors: [],
  };

  async function run(recovery) {
    let recorded = null;
    let failure = null;
    let evaluatorCalls = 0;
    let recoveryCalls = 0;
    const evaluator = async () => { evaluatorCalls += 1; throw new Error('must not pay automatically'); };
    evaluator.recoverByIdempotencyKey = async (candidate, context) => {
      recoveryCalls += 1;
      assert.equal(candidate.position, 37);
      assert.equal(context.idempotencyKey, outcomeToken);
      return recovery;
    };
    const repository = {
      async claimEgeMockWritingAssessment() {
        return {
          claimed: true,
          work: {
            claimToken: '45888371-d87d-4a1c-8501-9f93f7693089',
            formId: form.id, formRevision: form.revision,
            catalogFingerprint: form.fingerprint,
            items: [structuredClone(item)],
          },
        };
      },
      async renewEgeMockWritingAssessmentClaim() { return { renewed: true }; },
      async recordEgeMockWritingAssessmentItemOutcome(_owner, _attemptId, candidate) {
        recorded = structuredClone(candidate);
        return {
          applied: true,
          outcome: {
            token: candidate.outcomeToken, status: 'recorded', review: candidate.review,
            binding: candidate.binding, provenance: candidate.provenance, calls: candidate.calls,
          },
        };
      },
      async completeEgeMockWritingAssessmentItem() {
        return { writingAssessment: { status: 'completed' } };
      },
      async failEgeMockWritingAssessment(_owner, _attemptId, candidate) {
        failure = structuredClone(candidate);
        return { status: candidate.reason === 'provider_result_ambiguous' ? 'ambiguous' : 'retryable' };
      },
    };
    const service = createEgeMockWritingAssessmentService({
      repository, evaluator,
      uuid: () => 'c0ea28c0-8c6f-4f82-b0ea-a1c64705396b',
      consentAuthority: { canEvaluate: async () => true },
    });
    const result = await service.dispatch('owner', 'ef7a4595-a075-4021-9f79-fc3a98ca46c2');
    return { result, recorded, failure, evaluatorCalls, recoveryCalls };
  }

  const recovered = await run({
    status: 'completed', review, provider: 'fake-provider', model: 'fake-model', calls: [],
  });
  assert.equal(recovered.result.status, 'completed');
  assert.equal(recovered.recorded?.outcomeToken, outcomeToken);
  assert.equal(recovered.failure, null);
  assert.equal(recovered.evaluatorCalls, 0);
  assert.equal(recovered.recoveryCalls, 1);

  const ambiguous = await run({ status: 'not_found' });
  assert.equal(ambiguous.result.status, 'ambiguous');
  assert.equal(ambiguous.recorded, null);
  assert.equal(ambiguous.failure.reason, 'provider_result_ambiguous');
  assert.equal(ambiguous.failure.discardPreparedOutcome, false,
    'automatic recovery must retain the ambiguous reservation');
  assert.equal(ambiguous.evaluatorCalls, 0);
  assert.equal(ambiguous.recoveryCalls, 1);
});

test('a provider failure after its durable reservation retains prepared-unknown work for non-paying recovery', async () => {
  const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
  const authored = form.positions[36];
  const item = {
    position: 37, taskType: 'writing_37', taskId: authored.contentRef.id, maximum: 6,
      promptVersion: 'writing-v9',
    formRef: { id: form.id, revision: form.revision, fingerprint: form.fingerprint },
    contentRef: structuredClone(authored.contentRef), assignment: structuredClone(authored.presentation),
    criteriaRef: authored.assessment.criteriaRef,
    criteriaFingerprint: authored.assessment.criteriaFingerprint,
    criteriaSnapshot: getWritingRules('writing_37').criteria
      .map(([name, maximum]) => ({ name, maximum })),
    fullAnswer: words(100, 'mail'), evaluatedAnswer: words(100, 'mail'),
    scope: { fullWords: 100, evaluatedWords: 100, truncated: false, evaluatedLimit: 140 },
    outcome: null,
  };
  let prepared = null;
  let failure = null;
  let claims = 0;
  const evaluator = async () => {
    throw Object.assign(new Error('provider timeout after request acceptance'), { code: 'ETIMEDOUT' });
  };
  evaluator.recoverByIdempotencyKey = async () => ({ status: 'unsupported' });
  const repository = {
    async claimEgeMockWritingAssessment() {
      claims += 1;
      return {
        claimed: true,
        work: {
          claimToken: claims === 1
            ? '9d8eae46-b5dd-4f4d-94ab-2a0e6b664840'
            : '7a0c042a-1506-446a-b4e1-067169b48c40',
          authorization: { textProcessingConsent: true },
          items: [{ ...structuredClone(item), outcome: structuredClone(prepared) }],
        },
      };
    },
    async renewEgeMockWritingAssessmentClaim() { return { renewed: true }; },
    async prepareEgeMockWritingAssessmentItemOutcome(_owner, _attempt, candidate) {
      prepared = { token: candidate.outcomeToken, status: 'prepared' };
      return { applied: true, outcome: structuredClone(prepared) };
    },
    async failEgeMockWritingAssessment(_owner, _attempt, candidate) {
      failure = structuredClone(candidate);
      if (!candidate.discardPreparedOutcome && prepared?.status === 'prepared') {
        prepared.status = 'prepared_unknown';
      }
      return {
        status: candidate.reason === 'provider_result_ambiguous' ? 'ambiguous'
          : candidate.reason === 'provider_result_recovery_pending' ? 'pending' : 'retryable',
      };
    },
  };
  const service = createEgeMockWritingAssessmentService({
    repository, evaluator,
    uuid: (() => {
      const values = [
        '9d8eae46-b5dd-4f4d-94ab-2a0e6b664840',
        '1e32d7db-d30d-45c1-aeca-38487b7be87a',
        '7a0c042a-1506-446a-b4e1-067169b48c40',
      ];
      return () => values.shift();
    })(),
    consentAuthority: { canEvaluate: async () => true },
  });

  assert.deepEqual(await service.dispatch('owner', 'dfb23d7a-1c87-4a31-83fd-f355637bcc26'), {
    status: 'pending', dispatched: true,
  });
  assert.equal(failure.reason, 'provider_result_recovery_pending');
  assert.equal(failure.discardPreparedOutcome, false);
  assert.equal(prepared.status, 'prepared_unknown');
  assert.deepEqual(await service.dispatch('owner', 'dfb23d7a-1c87-4a31-83fd-f355637bcc26'), {
    status: 'ambiguous', dispatched: true,
  });
  assert.equal(failure.reason, 'provider_result_ambiguous');
});

test('an initial subscribed writing claim persists authorization and remains reclaimable after expiry', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-writing-authorization-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const granted = await repository.grantDays(9_260_449, 1, 'EGE writing authorization owner');
    const unclaimed = await repository.grantDays(9_260_450, 1, 'EGE writing unclaimed owner');
    const revoked = await repository.grantDays(9_260_451, 1, 'EGE writing revoked owner');
    await repository.setPrivacyConsent(granted.username, {
      text_processing: true, voice_processing: false, policy_version: 'privacy-v1',
    });
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(granted.username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: 'dd01fefc-73bd-4f42-babd-bdac43345d21', requestHash: '9'.repeat(64),
    });
    await repository.submitEgeMockWritten(granted.username, started.attempt.id, {
      expectedRevision: 0, idempotencyKey: '4a091e12-9d1e-49c9-b2e1-34bf4d83df7b',
      requestHash: 'a'.repeat(64),
    });
    const first = await repository.claimEgeMockWritingAssessment(granted.username, started.attempt.id, {
      claimToken: '7d5bef40-9e65-4f80-8452-ffb8521c95b8',
      authorization: { textProcessingConsent: true, consentPolicyVersion: 'privacy-v1' },
      now: new Date(),
    });
    assert.equal(first.claimed, true);
    assert.equal(first.work.authorization.textProcessingConsent, true);
    assert.equal(first.work.authorization.consentPolicyVersion, 'privacy-v1');
    assert.equal(Date.parse(first.work.authorization.subscriptionExpiresAt), granted.sub_until);

    const afterExpiry = new Date(granted.sub_until + 1_000);
    const reclaimed = await repository.claimEgeMockWritingAssessment(granted.username, started.attempt.id, {
      claimToken: 'e1083db7-c26e-408f-aecf-c16d535b0bf2',
      authorization: { textProcessingConsent: false, consentPolicyVersion: null },
      now: afterExpiry,
    });
    assert.equal(reclaimed.claimed, true,
      'the frozen initial authorization, not the current subscription, owns recovery');
    assert.deepEqual(reclaimed.work.authorization, first.work.authorization);

    const revokedStarted = await repository.startEgeMockAttempt(revoked.username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: 'adbd06fd-8950-44b7-bdf3-16e3577a3b74', requestHash: 'd'.repeat(64),
    });
    await repository.submitEgeMockWritten(revoked.username, revokedStarted.attempt.id, {
      expectedRevision: 0, idempotencyKey: '4520883e-2411-46bb-900f-3e4a2f8c803d',
      requestHash: 'e'.repeat(64),
    });
    await repository.setPrivacyConsent(revoked.username, {
      text_processing: false, voice_processing: false, policy_version: 'privacy-v1',
    });
    const staleCaller = await repository.claimEgeMockWritingAssessment(
      revoked.username, revokedStarted.attempt.id, {
        claimToken: '02fde4a9-10d2-4c99-b823-23f9d519e961',
        authorization: { textProcessingConsent: true, consentPolicyVersion: 'privacy-v1' },
        now: new Date(),
      },
    );
    assert.equal(staleCaller.work.authorization.textProcessingConsent, false,
      'revocation committed under the owner lock wins over a stale caller snapshot');

    const neverStarted = await repository.startEgeMockAttempt(unclaimed.username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: 'e435ee71-ce39-43f4-b237-b5047a137c3f', requestHash: 'b'.repeat(64),
    });
    await repository.submitEgeMockWritten(unclaimed.username, neverStarted.attempt.id, {
      expectedRevision: 0, idempotencyKey: 'bd4eb338-89f9-4a74-8c6f-a636b0a99cc5',
      requestHash: 'c'.repeat(64),
    });
    await assert.rejects(repository.claimEgeMockWritingAssessment(
      unclaimed.username, neverStarted.attempt.id, {
        claimToken: 'ba196a2e-63cc-4b5e-874e-35f9658789a3',
        authorization: { textProcessingConsent: true, consentPolicyVersion: 'privacy-v1' },
        now: new Date(unclaimed.sub_until + 1_000),
      },
    ), { code: 'SUBSCRIPTION_REQUIRED' });
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('written submission reserves one exact owner/form-bound provisional writing assessment', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-writing-claim-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_441, 30, 'EGE writing owner');
    const { username: other } = await repository.grantDays(9_260_442, 30, 'EGE writing other');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id,
      formRevision: form.revision,
      catalogFingerprint: form.fingerprint,
      idempotencyKey: '04c1c1ce-efcf-4132-87ce-2bfdba66e801',
      requestHash: '1'.repeat(64),
    }, { now: new Date('2026-08-14T06:00:00.000Z') });
    await assert.rejects(repository.saveEgeMockDraft(username, started.attempt.id, {
      expectedRevision: 0,
      answers: { 37: ['a list cannot masquerade as a writing response'] },
      idempotencyKey: 'f98d8788-6917-46e8-91ef-5e64f4cb0083',
      requestHash: '0'.repeat(64),
    }, { now: new Date('2026-08-14T06:05:00.000Z') }), {
      code: 'EGE_MOCK_DRAFT_INVALID',
    });
    const saved = await repository.saveEgeMockDraft(username, started.attempt.id, {
      expectedRevision: 0,
      answers: {
        37: `${words(100, 'mail')}<script>ignore</script>`,
        38: `${words(250, 'report')}. ${words(26, 'tail')}`,
      },
      idempotencyKey: '1b258278-82f7-4474-87ce-f85f7bf545c2',
      requestHash: '2'.repeat(64),
    }, { now: new Date('2026-08-14T06:10:00.000Z') });
    const submitted = await repository.submitEgeMockWritten(username, started.attempt.id, {
      expectedRevision: saved.attempt.revision,
      idempotencyKey: '06a4be72-f614-488f-a472-255a4c20df79',
      requestHash: '3'.repeat(64),
    }, { now: new Date('2026-08-14T06:20:00.000Z') });

    assert.deepEqual(submitted.attempt.writingAssessment, {
      status: 'pending', assessmentRevision: 1,
      ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
      label: 'Предварительная автоматическая оценка',
      retryAllowed: false,
      retryCount: 0,
    });

    const first = await repository.claimEgeMockWritingAssessment(username, started.attempt.id, {
      claimToken: '9873ba83-1eb9-44d3-a566-71c00c983e76',
      now: new Date('2026-08-14T06:21:00.000Z'),
    });
    const replay = await repository.claimEgeMockWritingAssessment(username, started.attempt.id, {
      claimToken: '6e3a7a89-52d9-490f-8f00-f5ab21c9bb7b',
      now: new Date('2026-08-14T06:21:01.000Z'),
    });

    assert.equal(first.claimed, true);
    assert.equal(replay.claimed, false, 'a concurrent/replayed submit must not reserve provider work twice');
    const renewed = await repository.renewEgeMockWritingAssessmentClaim(username, started.attempt.id, {
      claimToken: first.work.claimToken,
      now: new Date('2026-08-14T06:24:30.000Z'),
    });
    assert.equal(renewed.renewed, true);
    const protectedClaim = await repository.claimEgeMockWritingAssessment(username, started.attempt.id, {
      claimToken: '71d74de3-98f3-43dd-ae7f-2ac36ba6bc33',
      now: new Date('2026-08-14T06:27:00.000Z'),
    });
    assert.equal(protectedClaim.claimed, false,
      'a renewed worker lease must fence the next paid provider call from overlapping reclaim');
    assert.deepEqual(first.work.items.map((item) => ({
      position: item.position,
      taskType: item.taskType,
      taskId: item.taskId,
      criteriaRef: item.criteriaRef,
      criteriaFingerprint: item.criteriaFingerprint,
      maximum: item.maximum,
      fullWords: item.scope.fullWords,
      evaluatedWords: item.scope.evaluatedWords,
      truncated: item.scope.truncated,
    })), [
      {
        position: 37,
        taskType: 'writing_37',
        taskId: 'builtin:writing_37:emily-new-flat',
        criteriaRef: 'writing-ege-2026-task37-v1',
        criteriaFingerprint: 'sha256:a64921436b50ba9a9578cb73d7639ca3035f98174ffb2d2c616530de9da9b5f2',
        maximum: 6,
        fullWords: 101,
        evaluatedWords: 101,
        truncated: false,
      },
      {
        position: 38,
        taskType: 'writing_38',
        taskId: 'builtin:writing_38:teen-sport',
        criteriaRef: 'writing-ege-2026-task38-v1',
        criteriaFingerprint: 'sha256:dac7eea22d6ec506444c764ac348fb9ddc982048d8b43d951f86bb7c986b0171',
        maximum: 14,
        fullWords: 276,
        evaluatedWords: 250,
        truncated: true,
      },
    ]);
    assert.equal(first.work.items[0].fullAnswer.includes('<script>'), false);
    assert.equal(first.work.items[1].evaluatedAnswer.split(/\s+/u).length, 250);
    const reclaimed = await repository.claimEgeMockWritingAssessment(username, started.attempt.id, {
      claimToken: '4dbcb169-d1c3-4232-99c2-b18f5d824bdc',
      now: new Date('2026-08-14T06:30:00.000Z'),
    });
    assert.equal(reclaimed.claimed, true, 'an expired worker lease must make unfinished work recoverable');
    assert.deepEqual(reclaimed.work.items.map((item) => item.position), [37, 38]);
    const ambiguousToken = '17690295-c71a-4126-bbf5-bc31b54636d6';
    await repository.prepareEgeMockWritingAssessmentItemOutcome(username, started.attempt.id, {
      claimToken: reclaimed.work.claimToken, position: 37, outcomeToken: ambiguousToken,
      now: new Date('2026-08-14T06:30:10.000Z'),
    });
    const ambiguous = await repository.failEgeMockWritingAssessment(username, started.attempt.id, {
      claimToken: reclaimed.work.claimToken, reason: 'provider_result_ambiguous',
      discardPreparedOutcome: false, now: new Date('2026-08-14T06:30:20.000Z'),
    });
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.retryWarning, EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING);
    await assert.rejects(repository.retryEgeMockAssessment(username, started.attempt.id, {
      idempotencyKey: '67ffde91-50a6-4810-a13d-7f523f0765c8', requestHash: '7'.repeat(64),
    }, { now: new Date('2026-08-14T06:30:30.000Z') }), {
      code: 'EGE_MOCK_WRITING_AMBIGUOUS_RETRY_ACK_REQUIRED',
    });
    await repository.retryEgeMockAssessment(username, started.attempt.id, {
      acknowledgePossibleProviderRepeat: true,
      idempotencyKey: '7d579634-7ca4-4e21-873b-dac9cbc615d8', requestHash: '8'.repeat(64),
    }, { now: new Date('2026-08-14T06:30:40.000Z') });
    const replacement = await repository.claimEgeMockWritingAssessment(username, started.attempt.id, {
      claimToken: 'd25c75f7-7f21-42e1-b880-c8e954a311f6',
      now: new Date('2026-08-14T06:30:50.000Z'),
    });
    assert.equal(replacement.work.items.find((item) => item.position === 37).outcome, null,
      'manual acknowledgement tombstones the old reservation before a new idempotency key is issued');
    const exported = await repository.exportUserData(username);
    const abandoned = exported.ege_mock_attempts[0].writing_assessment.items[0].abandoned_outcomes;
    assert.deepEqual(abandoned.map(({ token, status }) => ({ token, status })), [
      { token: ambiguousToken, status: 'ambiguous' },
    ]);
    await assert.rejects(
      repository.claimEgeMockWritingAssessment(other, started.attempt.id, {
        claimToken: '0e77839e-accc-48d6-86bc-f8e422c3c22e',
        now: new Date('2026-08-14T06:22:00.000Z'),
      }),
      { code: 'EGE_MOCK_ATTEMPT_NOT_FOUND' },
    );
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('validated writing reviews become a private replay-safe provisional result only after both parts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-writing-result-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_443, 30, 'EGE writing result owner');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: '865d5d2c-d825-42b8-a4fb-daf9c8f2cb46', requestHash: '4'.repeat(64),
    }, { now: new Date('2026-08-14T07:00:00.000Z') });
    const saved = await repository.saveEgeMockDraft(username, started.attempt.id, {
      expectedRevision: 0,
      answers: {
        37: `${form.positions[36].presentation.stimulus.match(/[^.!?…]*\?/u)[0].trim()}\n${words(100, 'letter')}`,
        38: words(220, 'essay'),
      },
      idempotencyKey: 'fdd624c1-fd4a-41a5-a3e6-76865bcd916b', requestHash: '5'.repeat(64),
    }, { now: new Date('2026-08-14T07:05:00.000Z') });
    const submitted = await repository.submitEgeMockWritten(username, started.attempt.id, {
      expectedRevision: saved.attempt.revision,
      idempotencyKey: '5943794a-d462-4c11-9a2c-6f7d8968f12b', requestHash: '6'.repeat(64),
    }, { now: new Date('2026-08-14T07:10:00.000Z') });
    const claimToken = '83bd100c-2e50-4d88-8fea-bf23bc690825';
    const claim = await repository.claimEgeMockWritingAssessment(username, started.attempt.id, {
      claimToken, now: new Date('2026-08-14T07:11:00.000Z'),
    });
    const task37Item = claim.work.items.find((item) => item.position === 37);
    const task38Item = claim.work.items.find((item) => item.position === 38);
    const task37Review = {
      words: 100, in_range: true, overall_got: 5, overall_max: 6,
      verdict: 'Хорошая работа', sub: 'Проверьте языковое оформление.',
      criteria: [
        { name: 'Решение коммуникативной задачи', got: 2, max: 2 },
        { name: 'Организация текста', got: 2, max: 2 },
        { name: 'Языковое оформление', got: 1, max: 2 },
      ],
      errors: [{ title: 'Грамматика', wrong: 'letter1', right: 'letter2', kind: 'err', note: 'Нужна другая форма.', example: 'A separate corrected sentence.' }],
    };
    const task38Review = {
      words: 220, in_range: true, overall_got: 11, overall_max: 14,
      verdict: 'Структура соблюдена', sub: 'Уточните сравнения.',
      criteria: [
        { name: 'Решение коммуникативной задачи', got: 3, max: 3 },
        { name: 'Организация текста', got: 3, max: 3 },
        { name: 'Лексика', got: 2, max: 3 },
        { name: 'Грамматика', got: 2, max: 3 },
        { name: 'Орфография и пунктуация', got: 1, max: 2 },
      ],
      errors: [],
    };
    const task37OutcomeToken = '4d274347-e79e-4ddc-8776-a94a88925e65';
    await repository.prepareEgeMockWritingAssessmentItemOutcome(username, started.attempt.id, {
      claimToken, position: 37, outcomeToken: task37OutcomeToken,
      now: new Date('2026-08-14T07:11:30.000Z'),
    });
    await assert.rejects(
      repository.recordEgeMockWritingAssessmentItemOutcome(username, started.attempt.id, {
        claimToken, position: 37, outcomeToken: task37OutcomeToken, review: task37Review,
        binding: { ...outcomeBinding(task37Item), criteriaFingerprint: `sha256:${'0'.repeat(64)}` },
        provenance: { provider: 'fake-provider', model: 'fake-model' }, calls: [],
        now: new Date('2026-08-14T07:11:40.000Z'),
      }),
      { code: 'EGE_MOCK_WRITING_ASSESSMENT_CONTEXT_INVALID' },
    );
    const reorderedTask37Binding = outcomeBinding(task37Item);
    await repository.recordEgeMockWritingAssessmentItemOutcome(username, started.attempt.id, {
      claimToken, position: 37, outcomeToken: task37OutcomeToken, review: task37Review,
      binding: {
        formRef: Object.fromEntries(Object.entries(reorderedTask37Binding.formRef).reverse()),
        criteriaFingerprint: reorderedTask37Binding.criteriaFingerprint,
        criteriaRef: reorderedTask37Binding.criteriaRef,
        criteriaSnapshot: structuredClone(reorderedTask37Binding.criteriaSnapshot),
        contentRef: Object.fromEntries(Object.entries(reorderedTask37Binding.contentRef).reverse()),
        assignment: Object.fromEntries(Object.entries(reorderedTask37Binding.assignment).reverse()),
      },
      provenance: { provider: 'fake-provider', model: 'fake-model' }, calls: [],
      now: new Date('2026-08-14T07:11:45.000Z'),
    });
    const first = await repository.completeEgeMockWritingAssessmentItem(username, started.attempt.id, {
      claimToken, position: 37, outcomeToken: task37OutcomeToken,
      now: new Date('2026-08-14T07:12:00.000Z'),
    });
    const firstReplay = await repository.completeEgeMockWritingAssessmentItem(username, started.attempt.id, {
      claimToken, position: 37, outcomeToken: task37OutcomeToken,
      now: new Date('2026-08-14T07:12:01.000Z'),
    });
    const task38OutcomeToken = 'c4762098-2e30-43f3-ae50-5d5fc0d3cc7b';
    await repository.prepareEgeMockWritingAssessmentItemOutcome(username, started.attempt.id, {
      claimToken, position: 38, outcomeToken: task38OutcomeToken,
      now: new Date('2026-08-14T07:12:15.000Z'),
    });
    await repository.recordEgeMockWritingAssessmentItemOutcome(username, started.attempt.id, {
      claimToken, position: 38, outcomeToken: task38OutcomeToken, review: task38Review,
      binding: outcomeBinding(task38Item),
      provenance: { provider: 'fake-provider', model: 'fake-model' }, calls: [],
      now: new Date('2026-08-14T07:12:30.000Z'),
    });
    const completed = await repository.completeEgeMockWritingAssessmentItem(username, started.attempt.id, {
      claimToken, position: 38, outcomeToken: task38OutcomeToken,
      now: new Date('2026-08-14T07:13:00.000Z'),
    });

    assert.equal(first.applied, true);
    assert.equal(firstReplay.applied, false);
    assert.equal(completed.writingAssessment.status, 'completed');
    assert.equal((await repository.getEgeMockResult(username, started.attempt.id)).available, false);

    const oral = await repository.startEgeMockOral(username, started.attempt.id, {
      expectedRevision: submitted.attempt.revision,
      idempotencyKey: '6b4f2de5-bce1-4f71-8e39-8271d5f137d7', requestHash: '7'.repeat(64),
    }, { now: new Date('2026-08-14T08:00:00.000Z') });
    const completedOral = await completeEgeMockOralStageLedger(repository, username, oral);
    await repository.submitEgeMockOral(username, started.attempt.id, {
      expectedRevision: completedOral.attempt.revision,
      idempotencyKey: 'a03189eb-6a4f-4710-a411-a7dc0bc7894b', requestHash: '8'.repeat(64),
    }, { now: new Date('2026-08-14T08:05:00.000Z') });
    const result = await repository.getEgeMockResult(username, started.attempt.id);
    assert.equal(result.available, true);
    assert.deepEqual(result.result.writing, {
      status: 'completed', assessmentRevision: 8,
      ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT,
      label: 'Предварительная автоматическая оценка',
      score: 16,
      maximum: 20,
      items: [
        {
          position: 37, status: 'completed', score: 5, maximum: 6,
          criteriaRef: 'writing-ege-2026-task37-v1',
          criteriaFingerprint: 'sha256:a64921436b50ba9a9578cb73d7639ca3035f98174ffb2d2c616530de9da9b5f2',
          scope: { fullWords: 100, evaluatedWords: 100, truncated: false, evaluatedLimit: 140 },
          criteria: task37Review.criteria,
          feedback: { verdict: task37Review.verdict, nextStep: task37Review.sub },
          evidence: task37Review.errors,
        },
        {
          position: 38, status: 'completed', score: 11, maximum: 14,
          criteriaRef: 'writing-ege-2026-task38-v1',
          criteriaFingerprint: 'sha256:dac7eea22d6ec506444c764ac348fb9ddc982048d8b43d951f86bb7c986b0171',
          scope: { fullWords: 220, evaluatedWords: 220, truncated: false, evaluatedLimit: 250 },
          criteria: task38Review.criteria,
          feedback: { verdict: task38Review.verdict, nextStep: task38Review.sub },
          evidence: task38Review.errors,
        },
      ],
    });
    assert.equal(JSON.stringify(result).includes('letter1 letter2 letter3'), false,
      'full and evaluated student answers stay private');
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('server-owned writing dispatch requires acknowledgement before repeating unfinished paid work', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-writing-service-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const { username } = await repository.grantDays(9_260_444, 30, 'EGE writing service owner');
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: 'f046b387-718e-4875-b189-39bf3951034c', requestHash: '9'.repeat(64),
    }, { now: new Date('2026-08-14T09:00:00.000Z') });
    const saved = await repository.saveEgeMockDraft(username, started.attempt.id, {
      expectedRevision: 0,
      answers: { 37: words(100, 'mail'), 38: words(220, 'report') },
      idempotencyKey: '20a08ea2-aa29-4632-a4dd-c609428bd8bd', requestHash: 'a'.repeat(64),
    }, { now: new Date('2026-08-14T09:05:00.000Z') });
    await repository.submitEgeMockWritten(username, started.attempt.id, {
      expectedRevision: saved.attempt.revision,
      idempotencyKey: 'd418d9e0-bbfb-45dd-b62d-62f474e4fefa', requestHash: 'b'.repeat(64),
    }, { now: new Date('2026-08-14T09:10:00.000Z') });
    await repository.setPrivacyConsent(username, {
      text_processing: true, voice_processing: false, policy_version: 'privacy-v1',
    });

    const calls = [];
    const aiClaims = [];
    const aiSettlements = [];
    let failTask38 = true;
    const evaluator = async (item) => {
      calls.push(item.position);
      if (item.position === 38 && failTask38) throw Object.assign(new Error('AI_NOT_CONFIGURED'), {
        code: 'AI_NOT_CONFIGURED',
      });
      const criteria = item.criteriaSnapshot.map(({ name, maximum }, index) => ({
        name, got: index === 0 ? maximum : Math.max(0, maximum - 1), max: maximum,
      }));
      return {
        review: {
          words: item.scope.fullWords,
          in_range: true,
          overall_got: criteria.reduce((sum, criterion) => sum + criterion.got, 0),
          overall_max: item.maximum,
          verdict: 'Автоматическая проверка завершена',
          sub: 'Проверьте отмеченные критерии.',
          criteria,
          errors: [],
        },
        provider: 'fake-provider',
        model: 'fake-writing-model',
      };
    };
    const service = createEgeMockWritingAssessmentService({
      repository,
      evaluator,
      uuid: (() => {
        const values = [
          'd6673215-5d61-442b-a475-d35595b52520',
          '04535905-b122-4c2f-9aa9-bdf140209010',
          '21c78d51-56f0-4e7d-9b8a-9741364da72e',
          '54a0677b-92ac-4821-b389-769a8babf37d',
          '56a20566-e404-4b77-adbe-f7df529a6e3b',
          'bcd6288c-df6d-49e4-a2fc-d71f4b3a835b',
          '54c6dff1-4456-4f09-bff1-6b8b5c609f62',
          '491387b2-fd6b-476e-a599-34793ff858bd',
        ];
        return () => values.shift();
      })(),
      now: () => new Date('2026-08-14T09:11:00.000Z'),
      consentAuthority: createEgeMockWritingConsentAuthority({
        getPrivacyConsent: (candidate) => repository.getPrivacyConsent(candidate),
        policyVersion: 'privacy-v1',
      }),
      claimAiOperation: async (candidate, claim) => {
        aiClaims.push({ candidate, ...structuredClone(claim) });
        return { status: 'in_progress' };
      },
      settleAiOperation: async (candidate, claimId, settlement) => {
        aiSettlements.push({ candidate, claimId, ...structuredClone(settlement) });
        return { applied: true, status: settlement.status };
      },
      limitsFor(taskType) {
        assert.match(taskType, /^writing_(37|38)$/u);
        return { requestsPerHour: 12 };
      },
      dailyLimit: 100,
    });

    const failed = await service.dispatch(username, started.attempt.id);
    const replay = await service.dispatch(username, started.attempt.id);
    assert.equal(failed.status, 'pending');
    assert.equal(replay.status, 'ambiguous');
    assert.deepEqual(calls, [37, 38], 'ambiguous dispatch must not replay provider work by itself');
    const pendingResult = await repository.getEgeMockAttempt(username, started.attempt.id);
    assert.deepEqual(pendingResult.writingAssessment, {
      status: 'ambiguous', assessmentRevision: 17,
      ...AUTOMATIC_ASSESSMENT_PUBLIC_CONTRACT, label: 'Предварительная автоматическая оценка',
      retryAllowed: true, retryCount: 0,
      retryWarning: EGE_MOCK_WRITING_AMBIGUOUS_RETRY_WARNING,
    });

    failTask38 = false;
    const retried = await repository.retryEgeMockAssessment(username, started.attempt.id, {
      acknowledgePossibleProviderRepeat: true,
      idempotencyKey: '8e991010-bf03-4686-a362-7a4a3fdd13a0', requestHash: 'c'.repeat(64),
    }, { now: new Date('2026-08-14T09:12:00.000Z') });
    assert.equal(retried.attempt.writingAssessment.retryCount, 1);
    const completed = await service.dispatch(username, started.attempt.id);
    const completedReplay = await service.dispatch(username, started.attempt.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completedReplay.status, 'completed');
    assert.deepEqual(calls, [37, 38, 38], 'task 37 completion must survive the task 38 retry');
    assert.deepEqual(aiClaims.map((claim) => claim.operation), ['writing_37', 'writing_38', 'writing_38']);
    assert.deepEqual(aiClaims.map((claim) => claim.requestsPerHour), [12, 12, 12],
      'durable claims use the canonical task-specific provider ceiling');
    assert.deepEqual(aiSettlements.map((settlement) => settlement.status), ['completed', 'failed', 'completed']);
    assert.equal(aiClaims.every((claim) => /^[0-9a-f-]{36}$/u.test(claim.claimId)), true);
    assert.equal(aiClaims.every((claim) => /^sha256:[a-f0-9]{64}$/u.test(claim.contextFingerprint)), true,
      'every physical provider/repair budget row is bound before I/O to the immutable item context');
    assert.notEqual(aiClaims[0].contextFingerprint, aiClaims[1].contextFingerprint,
      'task 37 and task 38 cannot share one rubric/content budget identity');
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an assessment claimed while subscribed settles once after entitlement expiry without repeating provider work', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-ege-writing-expiry-'));
  const repository = createFileRepository(path.join(directory, 'data.json'));
  try {
    const granted = await repository.grantDays(9_260_445, 30, 'EGE writing expiry owner');
    const beforeExpiry = new Date(granted.sub_until - 60_000);
    const afterExpiry = new Date(granted.sub_until + 1);
    const form = getEgeMockForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION);
    const started = await repository.startEgeMockAttempt(granted.username, {
      formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
      idempotencyKey: '54b34ca4-4c85-4ee8-a0fe-d6ade118300c', requestHash: 'd'.repeat(64),
    }, { now: beforeExpiry });
    const saved = await repository.saveEgeMockDraft(granted.username, started.attempt.id, {
      expectedRevision: 0,
      answers: { 37: words(100, 'mail'), 38: words(200, 'report') },
      idempotencyKey: '7fd2384b-e32c-4a07-8c41-af665401519b', requestHash: 'e'.repeat(64),
    }, { now: beforeExpiry });
    await repository.submitEgeMockWritten(granted.username, started.attempt.id, {
      expectedRevision: saved.attempt.revision,
      idempotencyKey: 'dd73934b-e8ca-45a3-8206-88a5dd55fddd', requestHash: 'f'.repeat(64),
    }, { now: beforeExpiry });
    await repository.setPrivacyConsent(granted.username, {
      text_processing: true, voice_processing: false, policy_version: 'privacy-v1',
    });

    const evaluated = [];
    let clockReads = 0;
    const service = createEgeMockWritingAssessmentService({
      repository,
      uuid: () => '94a5bbb7-6779-4aca-b4ac-b724da8bed87',
      now: () => (clockReads++ === 0 ? beforeExpiry : afterExpiry),
      consentAuthority: createEgeMockWritingConsentAuthority({
        getPrivacyConsent: (candidate) => repository.getPrivacyConsent(candidate),
        policyVersion: 'privacy-v1',
      }),
      evaluator: async (item) => {
        evaluated.push(item.position);
        return {
          provider: 'fake-provider', model: 'fake-model',
          review: {
            words: item.scope.fullWords, in_range: true,
            overall_got: item.maximum, overall_max: item.maximum,
            verdict: 'Provisionally checked.', sub: 'Review the criterion evidence.',
            criteria: item.criteriaSnapshot.map(({ name, maximum }) => ({
              name, got: maximum, max: maximum,
            })),
            errors: [],
          },
        };
      },
    });

    assert.deepEqual(await service.dispatch(granted.username, started.attempt.id), {
      status: 'completed', dispatched: true,
    });
    assert.deepEqual(evaluated, [37, 38]);
    assert.equal((await repository.getEgeMockAttempt(
      granted.username, started.attempt.id, { now: afterExpiry },
    )).writingAssessment.status, 'completed');
  } finally {
    await repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
