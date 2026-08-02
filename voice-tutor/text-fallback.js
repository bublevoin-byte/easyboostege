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

export function createAiTextTutor({ providerClient, hasAiBudget, countAiOperationRequestsSince, logAiRequest, now = () => new Date() }) {
  const limits = operationLimits(OPERATION);
  async function run({ capsule, state, username, request, kind = null }) {
    const startedAt = Date.now();
    try {
      if (!await hasAiBudget(now())) throw Object.assign(new Error('AI_BUDGET_EXHAUSTED'), { code: 'AI_BUDGET_EXHAUSTED' });
      const since = new Date(now().getTime() - 3_600_000);
      if (await countAiOperationRequestsSince(username, OPERATION, since) >= limits.requestsPerHour) {
        throw Object.assign(new Error('RATE_LIMITED'), { code: 'RATE_LIMITED' });
      }
      const response = await providerClient.askWithFallback(buildVoiceTutorInstructions(capsule), request, OPERATION);
      const message = boundedTutorMessage(response.text);
      await logAiRequest({
        username, operation: OPERATION, provider: response.provider, model: response.model,
        promptVersion: VOICE_TUTOR_PROMPT_VERSION, status: 'completed', durationMs: Date.now() - startedAt,
        promptTokens: response.promptTokens, completionTokens: response.completionTokens,
        fallbackReason: null,
      });
      return { capsule_id: capsule.id, state, ...(kind ? { kind } : {}), message, prompt_version: VOICE_TUTOR_PROMPT_VERSION };
    } catch (error) {
      await logAiRequest({
        username, operation: OPERATION, provider: error?.provider || null, model: error?.model || null,
        promptVersion: VOICE_TUTOR_PROMPT_VERSION, status: 'failed', durationMs: Date.now() - startedAt,
        errorCode: safeTextErrorCode(error),
        fallbackReason: null,
      }).catch(() => {});
      throw error;
    }
  }
  return Object.freeze({
    async createTurn({ capsule, state = 'diagnose', username }) {
      return run({ capsule, state, username, request: textTurnRequest(capsule, state) });
    },
    async createClarification({ capsule, state = 'explain', username, kind, message = '' }) {
      return run({ capsule, state, username, kind, request: clarificationTurnRequest(capsule, state, kind, message) });
    },
  });
}
