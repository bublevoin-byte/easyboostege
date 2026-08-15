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

// The limits arrive resolved rather than looked up here: the client is what decides them, and it is
// the client — not the operation registry — that a quality run may give a longer timeout.
async function askProvider({ url, key, model, name }, system, user, limits, {
  responseFormat = null, idempotencyKey = null,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  let r;
  try {
    r = await gate.run(() => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer ' + key,
      ...(typeof idempotencyKey === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/u.test(idempotencyKey)
        ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: limits.maxTokens,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
      ...(name === 'grok' && responseFormat ? { response_format: responseFormat } : {}),
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
 *
 * `model` replaces the model id the environment gives that provider, for this client only. It
 * exists because section 11.2 has to compare two models of the same provider, and the alternative
 * — editing XAI_MODEL in .env between two paid runs — makes the model an invisible property of the
 * machine rather than of the run. The application passes nothing here either and keeps the models
 * from the environment; prices stay the provider's, since the configuration prices a provider and
 * not a model, so the cost estimate of an overridden run is an estimate of the provider's tariff.
 *
 * `timeoutMs` gives the calls of this client — and of no other — more time than the operation
 * budget allows. It exists because a reasoning model that never finishes inside 45 seconds cannot
 * be measured at all: every call is cut off and section 11.2 gets a journal of refusals instead of
 * grades. What such a run measures is a model beyond the budget the application gives it, which is
 * not what students get, so the runner says so in its own header and `ai/operations.js` keeps the
 * budgets that stand behind the button. The application passes nothing here and stays clamped by
 * `config.ai.maxTimeoutMs` exactly as before; the override is deliberately outside that ceiling,
 * because the ceiling protects a waiting student and there is no student in a run.
 */
export function createProviderClient({ provider: pinned = null, model = null, timeoutMs = null } = {}) {
  const overrideTimeoutMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;

  // What this client actually applies; `appLimitsFor` stays the budget the application would apply,
  // so a caller that raises the timeout can still see — and report — what it raised it above.
  const clientLimitsFor = (operation) => (
    overrideTimeoutMs ? { ...limitsFor(operation), timeoutMs: overrideTimeoutMs } : limitsFor(operation)
  );

  const ask = (item, system, user, operation, options = {}) => (
    askProvider(item, system, user, clientLimitsFor(operation), options)
  );

  function aiProviders() {
    const providers = configuredProviders();
    const chosen = pinned ? providers.filter((item) => item.name === pinned) : providers;
    return model ? chosen.map((item) => ({ ...item, model })) : chosen;
  }

  async function askWithFallback(system, user, operation, callControls = {}) {
    const providers = providersFor(operation, aiProviders());
    return runProviderFallback(
      providers,
      (item, context) => ask(item, system, user, operation, {
        idempotencyKey: context?.idempotencyKey || null,
      }),
      callControls,
    );
  }

  /*
   * Section 10.3: parse the answer; on a contract violation give the model exactly one corrected
   * attempt, then validate again. The retry goes back to the same provider on purpose — the
   * complaint is about shape, and the provider that produced the content is the one that can fix
   * it. Both calls are reported so the budget and the cost metrics stay truthful: a repaired
   * request really did cost two calls.
   */
  async function parseWithOneRepair({
    provider, text, parse, system, user, operation, responseFormat = null, callControls = {},
  }) {
    try {
      return { value: parse(text), repair: null };
    } catch (firstError) {
      if (!isFormatFailure(firstError)) throw firstError;
      if (!provider) throw firstError;

      const startedAt = Date.now();
      const context = typeof callControls.beforeAttempt === 'function'
        ? await callControls.beforeAttempt(provider, { attempt: 1 }) : null;
      let retry;
      try {
        retry = await ask(
          provider,
          system,
          buildRepairRequest(user, text, firstError),
          operation,
          { responseFormat, idempotencyKey: context?.idempotencyKey || null },
        );
      } catch (retryError) {
        if (typeof callControls.afterAttempt === 'function') {
          await callControls.afterAttempt(context, {
            status: 'failed', error: retryError, provider, attempt: 1,
            durationMs: Date.now() - startedAt,
          });
        }
        /* The repair call itself failed; the original contract violation is the honest answer. */
        retryError.repairOf = firstError.message;
        throw firstError;
      }
      if (typeof callControls.afterAttempt === 'function') {
        await callControls.afterAttempt(context, {
          status: 'completed', value: retry, provider, attempt: 1,
          durationMs: Date.now() - startedAt,
        });
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

  async function recoverByIdempotencyKey() {
    return { status: 'unsupported' };
  }

  return {
    askProvider: ask, aiProviders, askWithFallback, parseWithOneRepair,
    recoverByIdempotencyKey,
    limitsFor: clientLimitsFor, appLimitsFor: limitsFor,
  };
}
