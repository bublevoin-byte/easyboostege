/*
 * The one path by which this project talks to a language model: the call itself, the switch to a
 * spare provider, and the single format-repair attempt of section 10.3.
 *
 * It lives outside routes/ai.js because section 11.2 asks for a measurement of the AI the students
 * actually get. A command-line runner cannot reach into a closure built around an HTTP router, and
 * a runner calling a second copy of this chain would be measuring the copy.
 */

import { config } from '../config.js';
import { buildRepairRequest, isFormatFailure } from './format-repair.js';
import { operationLimits, providersFor } from './operations.js';
import { createConcurrencyGate, runProviderFallback } from './provider-control.js';

// Section 10.8: bound how many provider calls run at once; the rest wait their turn. One gate per
// process, so a runner started alongside nothing still obeys the ceiling the deployment set.
const gate = createConcurrencyGate(config.ai.maxConcurrentRequests);

// The registry states what an operation needs; the environment states what the deployment allows.
// The stricter of the two wins, so an operator can still clamp everything down in one place.
function limitsFor(operation) {
  const base = operationLimits(operation);
  return {
    ...base,
    requestsPerHour: Math.min(base.requestsPerHour, config.ai.maxRequestsPerHour),
    timeoutMs: Math.min(base.timeoutMs, config.ai.maxTimeoutMs),
  };
}

const XAI_KEY = config.ai.xaiKey;
const XAI_MODEL = config.ai.xaiModel;
const GROQ_KEY = config.ai.groqKey;
const GROQ_MODEL = config.ai.groqModel;

async function askProvider({ url, key, model }, system, user, operation) {
  const limits = limitsFor(operation);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  let r;
  try {
    r = await gate.run(() => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: limits.maxTokens,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
    }),
  }));
  } finally {
    clearTimeout(timeout);
  }
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return {
    text: j.choices?.[0]?.message?.content || '',
    promptTokens: Number.isInteger(j.usage?.prompt_tokens) ? j.usage.prompt_tokens : null,
    completionTokens: Number.isInteger(j.usage?.completion_tokens) ? j.usage.completion_tokens : null,
  };
}

function configuredProviders() {
  const providers = [];
  if (config.ai.xaiEnabled && XAI_KEY) providers.push({ name: 'grok', url: config.ai.xaiUrl, key: XAI_KEY, model: XAI_MODEL, inputMicrousdPerMillion: config.ai.xaiInputMicrousdPerMillion, outputMicrousdPerMillion: config.ai.xaiOutputMicrousdPerMillion });
  if (config.ai.groqEnabled && GROQ_KEY) providers.push({ name: 'groq', url: config.ai.groqUrl, key: GROQ_KEY, model: GROQ_MODEL, inputMicrousdPerMillion: config.ai.groqInputMicrousdPerMillion, outputMicrousdPerMillion: config.ai.groqOutputMicrousdPerMillion });
  return providers;
}

/*
 * `provider` pins the chain to a single configured provider and, by leaving nothing to switch to,
 * disables the fallback. Section 11.3 compares repeated runs of the same works, and a run that
 * silently changed provider halfway would make the stability figure unreadable. The application
 * passes nothing and keeps both providers.
 */
export function createProviderClient({ provider: pinned = null } = {}) {
  function aiProviders() {
    const providers = configuredProviders();
    return pinned ? providers.filter((item) => item.name === pinned) : providers;
  }

  async function askWithFallback(system, user, operation) {
    const providers = providersFor(operation, aiProviders());
    return runProviderFallback(providers, (item) => askProvider(item, system, user, operation));
  }

  /*
   * Section 10.3: parse the answer; on a contract violation give the model exactly one corrected
   * attempt, then validate again. The retry goes back to the same provider on purpose — the
   * complaint is about shape, and the provider that produced the content is the one that can fix
   * it. Both calls are reported so the budget and the cost metrics stay truthful: a repaired
   * request really did cost two calls.
   */
  async function parseWithOneRepair({ provider, text, parse, system, user, operation }) {
    try {
      return { value: parse(text), repair: null };
    } catch (firstError) {
      if (!isFormatFailure(firstError)) throw firstError;
      if (!provider) throw firstError;

      const startedAt = Date.now();
      let retry;
      try {
        retry = await askProvider(provider, system, buildRepairRequest(user, text, firstError), operation);
      } catch (retryError) {
        /* The repair call itself failed; the original contract violation is the honest answer. */
        retryError.repairOf = firstError.message;
        throw firstError;
      }

      const value = parse(retry.text);
      return {
        value,
        repair: {
          provider,
          usage: retry,
          durationMs: Date.now() - startedAt,
          reason: firstError.message,
        },
      };
    }
  }

  return { askProvider, aiProviders, askWithFallback, parseWithOneRepair, limitsFor };
}
