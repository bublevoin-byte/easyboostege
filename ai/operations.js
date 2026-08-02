// Section 10.2: every AI operation carries its own budget instead of sharing one global setting.
// A dictionary lookup and a task-38 review have nothing in common in size, cost or patience.
//
// requestsPerHour is per user. fallback says what may happen when the primary provider fails:
//   'secondary' — try the next provider;
//   'none'      — fail immediately, because a retry would cost more than the answer is worth.

import { CONTENT_PROMPT_VERSION } from './content.js';
import { SPEAKING_PROMPT_VERSION } from './speaking.js';
import { WRITING_PROMPT_VERSION } from './writing.js';
import { VOICE_TUTOR_PROMPT_VERSION } from '../voice-tutor/prompt.js';

const GENERATION_DEFAULTS = { fallback: 'secondary', promptVersion: CONTENT_PROMPT_VERSION };

export const AI_OPERATIONS = Object.freeze({
  // Generation: short answers, cheap, cached by request hash.
  dictionary_lookup: { maxTokens: 300, timeoutMs: 12_000, requestsPerHour: 120, ...GENERATION_DEFAULTS },
  vocabulary_cards: { maxTokens: 1200, timeoutMs: 25_000, requestsPerHour: 30, ...GENERATION_DEFAULTS },
  grammar_quiz: { maxTokens: 1200, timeoutMs: 25_000, requestsPerHour: 30, ...GENERATION_DEFAULTS },
  grammar_topic_set: { maxTokens: 1600, timeoutMs: 30_000, requestsPerHour: 30, ...GENERATION_DEFAULTS },
  grammar_exam_19_24: { maxTokens: 1600, timeoutMs: 30_000, requestsPerHour: 20, ...GENERATION_DEFAULTS },
  listening_dialog: { maxTokens: 1600, timeoutMs: 30_000, requestsPerHour: 30, ...GENERATION_DEFAULTS },
  reading_text: { maxTokens: 1600, timeoutMs: 30_000, requestsPerHour: 30, ...GENERATION_DEFAULTS },
  writing_task_37: { maxTokens: 800, timeoutMs: 25_000, requestsPerHour: 20, ...GENERATION_DEFAULTS },
  writing_task_38: { maxTokens: 800, timeoutMs: 25_000, requestsPerHour: 20, ...GENERATION_DEFAULTS },
  speaking_task_1: { maxTokens: 800, timeoutMs: 25_000, requestsPerHour: 20, ...GENERATION_DEFAULTS },
  speaking_task_2: { maxTokens: 800, timeoutMs: 25_000, requestsPerHour: 20, ...GENERATION_DEFAULTS },
  speaking_task_3: { maxTokens: 800, timeoutMs: 25_000, requestsPerHour: 20, ...GENERATION_DEFAULTS },
  speaking_task_4: { maxTokens: 900, timeoutMs: 25_000, requestsPerHour: 20, ...GENERATION_DEFAULTS },

  // Evaluation: long input, structured output, the most expensive calls we make.
  writing_37: { maxTokens: 1800, timeoutMs: 45_000, requestsPerHour: 12, fallback: 'secondary', promptVersion: WRITING_PROMPT_VERSION },
  writing_38: { maxTokens: 2200, timeoutMs: 60_000, requestsPerHour: 12, fallback: 'secondary', promptVersion: WRITING_PROMPT_VERSION },
  evaluate_speaking: { maxTokens: 1600, timeoutMs: 45_000, requestsPerHour: 20, fallback: 'secondary', promptVersion: SPEAKING_PROMPT_VERSION },
  // A sample answer is a convenience, not a grade: one failed provider is enough to give up.
  speaking_sample: { maxTokens: 900, timeoutMs: 25_000, requestsPerHour: 20, fallback: 'none', promptVersion: SPEAKING_PROMPT_VERSION },
  voice_tutor_realtime: { maxTokens: 500, timeoutMs: 10_000, requestsPerHour: 20, fallback: 'none', promptVersion: VOICE_TUTOR_PROMPT_VERSION },
  voice_tutor_text: { maxTokens: 500, timeoutMs: 20_000, requestsPerHour: 20, fallback: 'secondary', promptVersion: VOICE_TUTOR_PROMPT_VERSION },
  voice_tutor_rule_extract: { maxTokens: 700, timeoutMs: 25_000, requestsPerHour: 10, fallback: 'secondary', promptVersion: 'voice-tutor-rule-discovery-v1' },
});

const FALLBACK_DEFAULT = Object.freeze({
  maxTokens: 1600, timeoutMs: 25_000, requestsPerHour: 20, fallback: 'secondary', promptVersion: 'unknown',
});

export function operationLimits(operation) {
  return AI_OPERATIONS[operation] || FALLBACK_DEFAULT;
}

// 'none' means the request never reaches a second provider, whatever the configuration offers.
export function providersFor(operation, providers) {
  return operationLimits(operation).fallback === 'none' ? providers.slice(0, 1) : providers;
}

export function operationNames() {
  return Object.keys(AI_OPERATIONS);
}
