import crypto from 'node:crypto';

import {
  buildWritingPrompt, getWritingRules, parseAndValidateWritingReview,
} from '../ai/writing.js';
import {
  createEgeMockWritingAssessmentBinding,
  egeMockWritingAssessmentContextFingerprint,
} from './writing-assessment.js';

function failureReason(error) {
  const code = String(error?.code || error?.message || 'provider_unavailable').toLocaleLowerCase('en');
  if (code === 'ai_not_configured') return 'provider_not_configured';
  if (code.startsWith('ai_response_')) return 'provider_response_invalid';
  if (code === 'ai_budget_exhausted' || code === 'rate_limited') return code;
  if (code === 'privacy_consent_required') return code;
  if (code === 'provider_result_ambiguous' || code === 'provider_result_unavailable') {
    return 'provider_result_ambiguous';
  }
  if (code === 'ai_operation_replay_unsafe') {
    return 'provider_result_unavailable';
  }
  if (code === 'result_persistence_unavailable') return code;
  return 'provider_unavailable';
}

function stableUuid(...parts) {
  const bytes = crypto.createHash('sha256').update(parts.join(':')).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function claimRejectionProvesNoProviderWork(error) {
  const code = String(error?.code || error?.message || '').toUpperCase();
  return code === 'AI_BUDGET_EXHAUSTED' || code === 'RATE_LIMITED';
}

function deterministicZero(item) {
  const rules = getWritingRules(item.taskType);
  return {
    words: item.scope.fullWords,
    in_range: false,
    overall_got: 0,
    overall_max: item.maximum,
    verdict: 'Объём ответа недостаточен для оценивания.',
    sub: 'Дополните ответ и соблюдайте требуемый объём.',
    criteria: item.criteriaSnapshot.map(({ name, maximum }) => ({ name, got: 0, max: maximum })),
    errors: [{
      title: 'Недостаточный объём', wrong: '', right: '', kind: 'err',
      note: `Для задания требуется не менее ${rules.minWords} слов.`,
    }],
  };
}

export function createEgeMockWritingConsentAuthority({ getPrivacyConsent, policyVersion }) {
  if (typeof getPrivacyConsent !== 'function' || typeof policyVersion !== 'string'
    || !policyVersion.trim()) {
    throw new TypeError('EGE_MOCK_WRITING_CONSENT_AUTHORITY_INVALID');
  }
  async function authorizationSnapshot(username) {
      const consent = await getPrivacyConsent(username);
      return Object.freeze({
        textProcessingConsent: consent?.text_processing === true
          && consent.policy_version === policyVersion,
        consentPolicyVersion: policyVersion,
      });
  }
  return Object.freeze({
    authorizationSnapshot,
    async canEvaluate(username) {
      return (await authorizationSnapshot(username)).textProcessingConsent;
    },
  });
}

export function createEgeMockWritingProviderEvaluator({ providerClient }) {
  if (!providerClient?.askWithFallback || !providerClient?.parseWithOneRepair
    || typeof providerClient.limitsFor !== 'function') {
    throw new TypeError('EGE_MOCK_WRITING_PROVIDER_INVALID');
  }
  const evaluate = async (item, { providerCalls = null } = {}) => {
    const binding = createEgeMockWritingAssessmentBinding(item);
    const prompt = buildWritingPrompt({
      taskType: item.taskType,
      assignment: item.assignment,
      answer: item.evaluatedAnswer,
      evaluationScope: item.scope,
      criteriaSnapshot: binding.criteriaSnapshot,
      assessmentContext: binding,
    });
    const result = await providerClient.askWithFallback(
      prompt.system,
      prompt.user,
      item.taskType,
      providerCalls?.controls('provider'),
    );
    const provider = providerClient.aiProviders().find((candidate) => candidate.name === result.provider);
    const outcome = await providerClient.parseWithOneRepair({
      provider,
      text: result.text,
      parse: (text) => parseAndValidateWritingReview(text, {
        taskType: item.taskType, assignment: item.assignment, answer: item.fullAnswer,
        criteriaSnapshot: binding.criteriaSnapshot,
      }),
      system: prompt.system,
      user: prompt.user,
      operation: item.taskType,
      callControls: providerCalls?.controls('repair'),
    });
    return {
      review: outcome.value,
      provider: outcome.repair?.provider?.name || result.provider,
      model: outcome.repair?.provider?.model || result.model,
    };
  };
  evaluate.recoverByIdempotencyKey = async (item, { idempotencyKey }) => {
    const binding = createEgeMockWritingAssessmentBinding(item);
    if (typeof providerClient.recoverByIdempotencyKey !== 'function') {
      return { status: 'unsupported' };
    }
    const recovered = await providerClient.recoverByIdempotencyKey({
      idempotencyKey,
      operation: item.taskType,
      contextFingerprint: egeMockWritingAssessmentContextFingerprint(item),
    });
    if (recovered?.status !== 'completed') return recovered || { status: 'not_found' };
    const review = recovered.review || parseAndValidateWritingReview(recovered.text, {
      taskType: item.taskType,
      assignment: item.assignment,
      answer: item.fullAnswer,
      criteriaSnapshot: binding.criteriaSnapshot,
    });
    return {
      status: 'completed',
      review,
      provider: recovered.provider || null,
      model: recovered.model || null,
      calls: Array.isArray(recovered.calls) ? recovered.calls : [],
    };
  };
  Object.defineProperty(evaluate, 'tracksProviderCalls', { value: true });
  Object.defineProperty(evaluate, 'limitsFor', {
    value: (taskType) => providerClient.limitsFor(taskType),
  });
  return evaluate;
}

function createProviderCallLedger({
  username, item, outcomeToken, metered, claimAiOperation,
  requestsPerHour, dailyLimit, clock, renewClaim,
}) {
  const calls = [];
  const contextFingerprint = egeMockWritingAssessmentContextFingerprint(item);
  let reservationCount = 0;

  async function reserve(phase, attempt, provider = null) {
    await renewClaim();
    const claimId = stableUuid(
      outcomeToken, item.position, phase, attempt, provider?.name || 'provider',
    );
    const ticket = {
      claimId,
      idempotencyKey: phase === 'provider' ? outcomeToken : stableUuid(outcomeToken, phase, attempt),
      provider: provider?.name || null,
      model: provider?.model || null,
      startedAt: Date.now(),
    };
    if (metered) {
      // A replay or uncertain acknowledgement may already represent paid work. Only an
      // authoritative pre-provider budget/rate rejection proves this claim was unspent.
      reservationCount += 1;
      try {
        const claim = await claimAiOperation(username, {
          claimId,
          operation: item.taskType,
          promptVersion: item.promptVersion,
          contextFingerprint,
          requestsPerHour,
          dailyLimit,
          now: clock(),
        });
        if (claim?.applied === false) {
          throw Object.assign(new Error('AI_OPERATION_REPLAY_UNSAFE'), {
            code: 'AI_OPERATION_REPLAY_UNSAFE',
          });
        }
      } catch (error) {
        if (claimRejectionProvesNoProviderWork(error)) reservationCount -= 1;
        throw error;
      }
    } else {
      reservationCount += 1;
    }
    return ticket;
  }

  function record(ticket, {
    status, value = null, error = null, provider = null, durationMs = null,
  }) {
    if (!metered || !ticket) return;
    calls.push({
      claimId: ticket.claimId,
      status,
      provider: provider?.name || ticket.provider,
      model: provider?.model || ticket.model,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs))
        : Math.max(0, Date.now() - ticket.startedAt),
      errorCode: status === 'failed' ? failureReason(error) : null,
      promptTokens: value?.promptTokens ?? null,
      completionTokens: value?.completionTokens ?? null,
    });
  }

  return Object.freeze({
    controls(phase) {
      return {
        beforeAttempt(provider, { attempt }) {
          return reserve(phase, attempt, provider);
        },
        afterAttempt(ticket, outcome) {
          record(ticket, outcome);
        },
      };
    },
    reserve,
    record,
    hasReservations() { return reservationCount > 0; },
    settlements() { return structuredClone(calls); },
  });
}

async function persistOutcome(repository, username, attemptId, candidate) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await repository.recordEgeMockWritingAssessmentItemOutcome(
        username, attemptId, candidate,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw Object.assign(new Error('RESULT_PERSISTENCE_UNAVAILABLE'), {
    code: 'RESULT_PERSISTENCE_UNAVAILABLE', cause: lastError,
  });
}

async function settleCalls(settleAiOperation, username, calls, clock) {
  for (const call of calls) {
    await settleAiOperation(username, call.claimId, {
      status: call.status,
      provider: call.provider,
      model: call.model,
      durationMs: call.durationMs,
      errorCode: call.errorCode,
      promptTokens: call.promptTokens,
      completionTokens: call.completionTokens,
      now: clock(),
    });
  }
}

export function createEgeMockWritingAssessmentService({
  repository, evaluator, uuid, now, consentAuthority,
  claimAiOperation, settleAiOperation, limitsFor, dailyLimit,
}) {
  if (!repository || typeof evaluator !== 'function'
    || typeof repository.renewEgeMockWritingAssessmentClaim !== 'function') {
    throw new TypeError('EGE_MOCK_WRITING_SERVICE_INVALID');
  }
  const newUuid = typeof uuid === 'function' ? uuid : () => crypto.randomUUID();
  const clock = typeof now === 'function' ? now : () => new Date();
  const privacyAllows = typeof consentAuthority?.canEvaluate === 'function'
    ? (username) => consentAuthority.canEvaluate(username) : async () => false;
  const authorizationSnapshot = typeof consentAuthority?.authorizationSnapshot === 'function'
    ? (username) => consentAuthority.authorizationSnapshot(username)
    : async (username) => ({
      textProcessingConsent: await privacyAllows(username), consentPolicyVersion: null,
    });
  const metered = typeof claimAiOperation === 'function' && typeof settleAiOperation === 'function';
  if (metered && (typeof limitsFor !== 'function'
    || !Number.isInteger(dailyLimit) || dailyLimit < 1)) {
    throw new TypeError('EGE_MOCK_WRITING_SERVICE_LIMIT_INVALID');
  }

  return Object.freeze({
    async dispatch(username, attemptId) {
      const observedAuthorization = await authorizationSnapshot(username);
      const claimed = await repository.claimEgeMockWritingAssessment(username, attemptId, {
        claimToken: newUuid(), authorization: observedAuthorization, now: clock(),
      });
      if (!claimed.claimed) return { status: claimed.status, dispatched: false };
      const { claimToken, items } = claimed.work;
      const durableAuthorization = claimed.work.authorization || observedAuthorization;
      const renewClaim = () => repository.renewEgeMockWritingAssessmentClaim(username, attemptId, {
        claimToken, now: clock(),
      });
      let discardPreparedOutcome = false;
      let preparedProviderUnknown = false;
      try {
        let latest = null;
        for (const item of items) {
          await renewClaim();
          let durableOutcome = item.outcome;
          if (['prepared', 'prepared_unknown'].includes(durableOutcome?.status)) {
            const recovery = typeof evaluator.recoverByIdempotencyKey === 'function'
              ? await evaluator.recoverByIdempotencyKey(item, {
                username, attemptId, idempotencyKey: durableOutcome.token,
              }) : { status: 'unsupported' };
            if (recovery?.status !== 'completed') {
              throw Object.assign(new Error('PROVIDER_RESULT_AMBIGUOUS'), {
                code: 'PROVIDER_RESULT_AMBIGUOUS',
              });
            }
            const recorded = await persistOutcome(repository, username, attemptId, {
              claimToken,
              position: item.position,
              outcomeToken: durableOutcome.token,
              review: recovery.review,
              binding: createEgeMockWritingAssessmentBinding(item),
              provenance: { provider: recovery.provider || null, model: recovery.model || null },
              calls: recovery.calls || [],
              now: clock(),
            });
            durableOutcome = recorded.outcome;
          }
          if (!durableOutcome) {
            const rules = getWritingRules(item.taskType);
            const zeroThreshold = Math.round(rules.minWords * 0.9);
            const deterministic = item.scope.fullWords < zeroThreshold;
            if (!deterministic && durableAuthorization.textProcessingConsent !== true) {
              throw Object.assign(new Error('PRIVACY_CONSENT_REQUIRED'), {
                code: 'PRIVACY_CONSENT_REQUIRED',
              });
            }

            const outcomeToken = newUuid();
            await repository.prepareEgeMockWritingAssessmentItemOutcome(username, attemptId, {
              claimToken, position: item.position, outcomeToken, now: clock(),
            });
            discardPreparedOutcome = true;
            const itemLimits = metered ? limitsFor(item.taskType) : null;
            const requestsPerHour = itemLimits?.requestsPerHour;
            if (metered && (!Number.isInteger(requestsPerHour) || requestsPerHour < 1)) {
              throw Object.assign(new Error('EGE_MOCK_WRITING_SERVICE_LIMIT_INVALID'), {
                code: 'EGE_MOCK_WRITING_SERVICE_LIMIT_INVALID',
              });
            }
            const providerCalls = createProviderCallLedger({
              username, item, outcomeToken, metered, claimAiOperation,
              requestsPerHour, dailyLimit, clock, renewClaim,
            });
            let outcome;
            try {
              if (deterministic) {
                outcome = { review: deterministicZero(item), provider: 'deterministic', model: null };
              } else if (evaluator.tracksProviderCalls) {
                outcome = await evaluator(item, { username, attemptId, outcomeToken, providerCalls });
              } else {
                const ticket = await providerCalls.reserve('provider', 1);
                try {
                  outcome = await evaluator(item, { username, attemptId, outcomeToken });
                  providerCalls.record(ticket, {
                    status: 'completed', value: outcome,
                    provider: { name: outcome.provider, model: outcome.model },
                  });
                } catch (error) {
                  providerCalls.record(ticket, { status: 'failed', error });
                  throw error;
                }
              }
            } catch (error) {
              if (providerCalls.hasReservations()) {
                discardPreparedOutcome = false;
                preparedProviderUnknown = true;
              }
              if (metered) {
                await settleCalls(
                  settleAiOperation, username, providerCalls.settlements(), clock,
                ).catch(() => {});
              }
              throw error;
            }
            if (!deterministic && providerCalls.hasReservations()) {
              // Paid work may now exist at the provider. No later lease, persistence or
              // settlement failure may make this outcome eligible for automatic re-evaluation.
              discardPreparedOutcome = false;
              preparedProviderUnknown = true;
            }
            await renewClaim();
            let recorded;
            try {
              recorded = await persistOutcome(repository, username, attemptId, {
                claimToken,
                position: item.position,
                outcomeToken,
                review: outcome.review,
                binding: createEgeMockWritingAssessmentBinding(item),
                provenance: { provider: outcome.provider || null, model: outcome.model || null },
                calls: providerCalls.settlements(),
                now: clock(),
              });
            } catch (error) {
              if (!deterministic) {
                discardPreparedOutcome = false;
                preparedProviderUnknown = true;
              }
              throw error;
            }
            discardPreparedOutcome = false;
            preparedProviderUnknown = false;
            durableOutcome = recorded.outcome;
          }

          if (metered) {
            await renewClaim();
            await settleCalls(settleAiOperation, username, durableOutcome.calls || [], clock);
          }
          await renewClaim();
          latest = await repository.completeEgeMockWritingAssessmentItem(username, attemptId, {
            claimToken,
            position: item.position,
            outcomeToken: durableOutcome.token,
            now: clock(),
          });
        }
        return { status: latest?.writingAssessment?.status || 'completed', dispatched: true };
      } catch (error) {
        const reason = failureReason(error);
        const failed = await repository.failEgeMockWritingAssessment(username, attemptId, {
          claimToken,
          reason: preparedProviderUnknown ? 'provider_result_recovery_pending'
            : reason === 'result_persistence_unavailable' && !discardPreparedOutcome
              ? 'provider_result_ambiguous' : reason,
          discardPreparedOutcome,
          now: clock(),
        });
        return { status: failed.status, dispatched: true };
      }
    },
  });
}
