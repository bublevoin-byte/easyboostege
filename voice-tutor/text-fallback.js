import { operationLimits } from '../ai/operations.js';
import { buildVoiceTutorInstructions, textTurnRequest, VOICE_TUTOR_PROMPT_VERSION } from './prompt.js';

const OPERATION = 'voice_tutor_text';

function boundedTutorMessage(value) {
  const message = String(value || '').trim();
  if (!message || message.length > 2_000 || /<\/?[A-Za-z][^>]*>/u.test(message)) {
    throw Object.assign(new Error('VOICE_TUTOR_TEXT_CONTRACT_INVALID'), { code: 'VOICE_TUTOR_TEXT_CONTRACT_INVALID' });
  }
  return message;
}

export function createAiTextTutor({ providerClient, hasAiBudget, countAiOperationRequestsSince, logAiRequest, now = () => new Date() }) {
  const limits = operationLimits(OPERATION);
  return Object.freeze({
    async createTurn({ capsule, state = 'diagnose', username }) {
      const startedAt = Date.now();
      try {
        if (!await hasAiBudget(now())) throw Object.assign(new Error('AI_BUDGET_EXHAUSTED'), { code: 'AI_BUDGET_EXHAUSTED' });
        const since = new Date(now().getTime() - 3_600_000);
        if (await countAiOperationRequestsSince(username, OPERATION, since) >= limits.requestsPerHour) {
          throw Object.assign(new Error('RATE_LIMITED'), { code: 'RATE_LIMITED' });
        }
        const response = await providerClient.askWithFallback(
          buildVoiceTutorInstructions(capsule),
          textTurnRequest(capsule, state),
          OPERATION,
        );
        const message = boundedTutorMessage(response.text);
        await logAiRequest({
          username, operation: OPERATION, provider: response.provider, model: response.model,
          promptVersion: VOICE_TUTOR_PROMPT_VERSION, status: 'completed', durationMs: Date.now() - startedAt,
          promptTokens: response.promptTokens, completionTokens: response.completionTokens,
          fallbackReason: response.fallbackReason || null,
        });
        return { capsule_id: capsule.id, state, message, prompt_version: VOICE_TUTOR_PROMPT_VERSION };
      } catch (error) {
        await logAiRequest({
          username, operation: OPERATION, provider: error?.provider || null, model: error?.model || null,
          promptVersion: VOICE_TUTOR_PROMPT_VERSION, status: 'failed', durationMs: Date.now() - startedAt,
          errorCode: error?.code || error?.message || 'VOICE_TUTOR_TEXT_UNAVAILABLE',
          fallbackReason: error?.fallbackReason || null,
        }).catch(() => {});
        throw error;
      }
    },
  });
}
