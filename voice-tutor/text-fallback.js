import crypto from 'node:crypto';
import { operationLimits } from '../ai/operations.js';
import { buildVoiceTutorInstructions, clarificationTurnRequest, textTurnRequest, VOICE_TUTOR_PROMPT_VERSION } from './prompt.js';

const OPERATION = 'voice_tutor_text';
const SAFE_TEXT_ERROR_CODES = new Set([
  'AI_BUDGET_EXHAUSTED', 'RATE_LIMITED', 'AI_QUEUE_TIMEOUT', 'AI_UNAVAILABLE',
  'AI_NOT_CONFIGURED', 'VOICE_TUTOR_TEXT_UNAVAILABLE',
]);

function safeTextErrorCode(error) {
  for (const candidate of [error?.code, error?.message]) {
    if (SAFE_TEXT_ERROR_CODES.has(candidate)) return candidate;
  }
  return 'VOICE_TUTOR_TEXT_UNAVAILABLE';
}

function boundedTutorMessage(value) {
  const message = String(value || '').trim();
  if (!message || message.length > 2_000 || /<\/?[A-Za-z][^>]*>/u.test(message)) {
    throw Object.assign(new Error('VOICE_TUTOR_TEXT_CONTRACT_INVALID'), { code: 'VOICE_TUTOR_TEXT_CONTRACT_INVALID' });
  }
  return message;
}

export function createAiTextTutor({
  providerClient,
  claimAiOperation,
  settleAiOperation,
  newId = () => crypto.randomUUID(),
  now = () => new Date(),
}) {
  if (!providerClient?.askWithFallback || typeof claimAiOperation !== 'function' || typeof settleAiOperation !== 'function') {
    throw new Error('VOICE_TUTOR_TEXT_CONFIG_INVALID');
  }
  const limits = operationLimits(OPERATION);
  async function run({ capsule, state, username, request, kind = null }) {
    const startedAt = Date.now();
    let claim = null;
    let settled = false;
    try {
      claim = await claimAiOperation({
        claimId: newId(), username, operation: OPERATION, promptVersion: VOICE_TUTOR_PROMPT_VERSION,
        requestsPerHour: limits.requestsPerHour, now: now(),
      });
      const response = await providerClient.askWithFallback(buildVoiceTutorInstructions(capsule), request, OPERATION);
      const message = boundedTutorMessage(response.text);
      await settleAiOperation(username, claim.claim_id, {
        status: 'completed', provider: response.provider, model: response.model, durationMs: Date.now() - startedAt,
        promptTokens: response.promptTokens, completionTokens: response.completionTokens,
      });
      settled = true;
      return { capsule_id: capsule.id, state, ...(kind ? { kind } : {}), message, prompt_version: VOICE_TUTOR_PROMPT_VERSION };
    } catch (error) {
      if (claim && !settled) await settleAiOperation(username, claim.claim_id, {
        status: 'failed', provider: error?.provider || null, model: error?.model || null,
        durationMs: Date.now() - startedAt, errorCode: safeTextErrorCode(error),
      }).catch(() => {});
      throw error;
    }
  }
  return Object.freeze({
    async createTurn({ capsule, state = 'diagnose', username, diagnosticReply = '' }) {
      return run({ capsule, state, username, request: textTurnRequest(capsule, state, { diagnosticReply }) });
    },
    async createClarification({ capsule, state = 'explain', username, kind, message = '' }) {
      return run({ capsule, state, username, kind, request: clarificationTurnRequest(capsule, state, kind, message) });
    },
  });
}
