import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';

import { config } from '../config.js';
import {
  parseAndValidateWritingReview, prepareWritingPrompt, WRITING_PROMPT_VERSION, writingRequestSchema,
} from '../ai/writing.js';
import { buildContentPrompt, CONTENT_PROMPT_VERSION, contentRequestSchema, parseContentResponse } from '../ai/content.js';
import { buildSpeakingPrompt, buildSpeakingSamplePrompt, parseSpeakingReview, parseSpeakingSample, SPEAKING_PROMPT_VERSION, speakingRequestSchema, speakingSampleRequestSchema } from '../ai/speaking.js';
import { assignmentFor, OPERATION_FOR_TASK_TYPE } from '../ai/task-bank.js';
import { estimateCostMicrousd, TtlCache } from '../ai/provider-control.js';
import { createProviderClient } from '../ai/provider-client.js';
import { providersFor } from '../ai/operations.js';
import { recordDependencyEvent } from '../observability/metrics.js';
import { decorateGeneratedVoiceTutorContent } from '../voice-tutor/generated-items.js';
import { reviewVoiceTutorCriterionChoices } from '../voice-tutor/capsule.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXPERIMENTAL_ASSESSMENT = Object.freeze({
  mode: 'experimental',
  scoreKind: 'approximate',
  warning: 'Экспериментальная ИИ-оценка. Балл ориентировочный, может содержать ошибки и не является экспертным заключением.',
});

function isExperimentalSpeakingTask(taskType) {
  return taskType === 3 || taskType === 4;
}

// A single line an operator can grep: which provider gave up, on what, and whether a spare was left.
function describeFallback(provider, code, error, index, total) {
  const reason = error?.message && error.message !== code ? `${code}: ${String(error.message).slice(0, 120)}` : code;
  return `${provider.name} → ${index + 1 < total ? 'switched to next provider' : 'no provider left'} (${reason})`;
}


// The web server takes the standard chain: both providers, fallback allowed. Pinning exists for
// the quality runner of section 11.2 and has no business in a student's request.
const { askProvider, aiProviders, askWithFallback, limitsFor, parseWithOneRepair } = createProviderClient();

// Server-side AI operations. The client never sends a system prompt: each operation has its own contract.
export function createAiRoutes({ authentication, access, db }) {
  const router = express.Router();
  const { auth } = authentication;
  const { createOperationLimiter, requireAiBudget, requireActiveSubscription, requirePrivacyConsent, hasAiBudget } = access;
  const perOperation = (resolve) => createOperationLimiter(resolve, (operation) => limitsFor(operation).requestsPerHour);
  // Each endpoint is rationed by the operation actually requested, not by a shared category quota.
  const writingLimiter = perOperation((req) => (typeof req.body?.taskType === 'string' ? req.body.taskType : 'writing_37'));
  const contentLimiter = perOperation((req) => (typeof req.body?.operation === 'string' ? req.body.operation : 'grammar_quiz'));
  const speakingEvalLimiter = perOperation(() => 'evaluate_speaking');
  const speakingSampleLimiter = perOperation(() => 'speaking_sample');
  const {
    createWritingAttempt, finishWritingAttempt, createSpeakingAttempt, finishSpeakingAttempt,
    getGeneratedTask, getSharedGeneratedTask, saveGeneratedTask, logAiRequest,
    getBankTask, getBankTaskByExternalId,
  } = db;

  function aiUsage(provider, response) {
    return { promptTokens: response.promptTokens, completionTokens: response.completionTokens, estimatedCostMicrousd: estimateCostMicrousd(response, provider) };
  }

  /* The rejected first call is a real event: it consumed tokens and it explains the latency. */
  function logRepairedAttempt({ username, operation, promptVersion, repair, model }) {
    return logAiRequest({
      username,
      operation,
      provider: repair.provider.name,
      model,
      promptVersion,
      status: 'failed',
      durationMs: repair.durationMs,
      errorCode: repair.reason,
      fallbackReason: `${repair.provider.name} → format repair requested (${repair.reason})`,
      ...aiUsage(repair.provider, repair.usage),
    });
  }

  const dictionaryCache = new TtlCache(config.ai.dictionaryCacheTtlMs, 5000);
  function serveCachedDictionary(req, res, next) {
    if (req.body?.operation !== 'dictionary_lookup') return next();
    const parsed = contentRequestSchema.safeParse(req.body);
    if (!parsed.success) return next();
    const cached = dictionaryCache.get(parsed.data.word.toLocaleLowerCase('en'));
    if (!cached) return next();
    return res.json({ data: cached, provider: 'cache', promptVersion: CONTENT_PROMPT_VERSION, cached: true });
  }

  /*
   * Turn the identifier the client sent into the assignment the server holds. A built-in task may
   * be named by its stable external id, a generated one by its numeric bank id; anything that does
   * not resolve to a task of the right type is refused before a paid call is made.
   */
  async function resolveWritingTask({ taskType, taskId, answer }) {
    const operation = OPERATION_FOR_TASK_TYPE[taskType];
    const record = /^\d+$/u.test(taskId)
      ? await getBankTask(taskId)
      : await getBankTaskByExternalId(taskId);

    if (!record) {
      throw Object.assign(new Error('Задание не найдено.'), { status: 404, code: 'UNKNOWN_TASK' });
    }
    if (record.operation !== operation) {
      throw Object.assign(new Error('Идентификатор задания не соответствует типу работы.'), { status: 400, code: 'TASK_TYPE_MISMATCH' });
    }
    return { taskType, answer, taskId: String(record.id), assignment: assignmentFor(operation, record.content) };
  }

  router.post('/api/v1/ai/evaluate-writing', auth, requireActiveSubscription, requirePrivacyConsent('text_processing'), requireAiBudget, writingLimiter, async (req, res, next) => {
    const parsed = writingRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Некорректные данные письменного задания.',
          fields: parsed.error.issues.map((issue) => issue.path.join('.')),
        },
      });
    }

    /* Section 10.1: the assignment comes from the bank, never from the request body. */
    let input;
    try {
      input = await resolveWritingTask(parsed.data);
    } catch (error) {
      return res.status(error.status || 400).json({
        error: { code: error.code || 'UNKNOWN_TASK', message: error.message, requestId: req.requestId },
      });
    }

    const startedAt = Date.now();
    let attemptId;
    let provider = null;
    let model = null;
    let promptTokens = null;
    let completionTokens = null;
    try {
      const evaluation = prepareWritingPrompt(input);
      attemptId = await createWritingAttempt(req.user, {
        ...input,
        evaluatedAnswer: evaluation.evaluatedAnswer,
      }, WRITING_PROMPT_VERSION);
      const { prompt } = evaluation;
      const result = await askWithFallback(prompt.system, prompt.user, input.taskType);
      recordDependencyEvent('ai', 'success');
      if (result.attempts > 1) recordDependencyEvent('ai', 'fallback');
      provider = result.provider;
      model = result.model;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      const outcome = await parseWithOneRepair({
        provider: aiProviders().find((item) => item.name === result.provider),
        text: result.text,
        parse: (text) => parseAndValidateWritingReview(text, input),
        system: prompt.system,
        user: prompt.user,
        operation: input.taskType,
      });
      const review = outcome.value;
      if (outcome.repair) {
        /* The rejected call is logged separately; the accepted answer came from the repair. */
        await logRepairedAttempt({
          username: req.user, operation: input.taskType, promptVersion: WRITING_PROMPT_VERSION, repair: outcome.repair, model,
        });
        promptTokens = outcome.repair.usage.promptTokens;
        completionTokens = outcome.repair.usage.completionTokens;
      }
      const accepted = outcome.repair ? outcome.repair.usage : result;
      await finishWritingAttempt(attemptId, { status: 'completed', review, provider, model });
      await logAiRequest({
        username: req.user,
        operation: input.taskType,
        provider,
        model,
        promptVersion: WRITING_PROMPT_VERSION,
        status: 'completed',
        durationMs: Date.now() - startedAt,
        fallbackReason: result.fallbackReason,
        promptTokens: accepted.promptTokens,
        completionTokens: accepted.completionTokens,
        estimatedCostMicrousd: estimateCostMicrousd(accepted, aiProviders().find((item) => item.name === provider)),
      });
      res.json({
        review,
        provider,
        attemptId,
        voiceTutor: { source: 'writing', attemptId, revision: 1, criterionChoices: reviewVoiceTutorCriterionChoices(review) },
        assessment: EXPERIMENTAL_ASSESSMENT,
        evaluationScope: evaluation.scope,
      });
    } catch (error) {
      recordDependencyEvent('ai', 'error');
      if (!attemptId) return next(error);
      provider ||= error.provider || error.cause?.provider || null;
      model ||= error.model || error.cause?.model || null;
      const invalidResponse = String(error.message).startsWith('AI_RESPONSE_');
      const code = invalidResponse
        ? 'AI_RESPONSE_INVALID'
        : error.message === 'AI_NOT_CONFIGURED' ? 'AI_NOT_CONFIGURED' : 'AI_UNAVAILABLE';
      const status = invalidResponse ? 502 : (error.status || 502);
      const writes = [logAiRequest({
        username: req.user,
        operation: input.taskType,
        provider,
        model,
        promptVersion: WRITING_PROMPT_VERSION,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorCode: code,
        fallbackReason: error.fallbackReason || error.cause?.fallbackReason || null,
        promptTokens,
        completionTokens,
        estimatedCostMicrousd: estimateCostMicrousd({ promptTokens, completionTokens }, aiProviders().find((item) => item.name === provider)),
      })];
      if (attemptId) writes.push(finishWritingAttempt(attemptId, {
        status: 'failed', provider, model, errorCode: code,
      }));
      await Promise.allSettled(writes);
      const message = code === 'AI_NOT_CONFIGURED'
        ? 'ИИ не настроен на сервере.'
        : code === 'AI_RESPONSE_INVALID'
          ? 'ИИ вернул некорректный разбор. Попробуйте ещё раз.'
          : 'ИИ временно недоступен.';
      res.status(status).json({ error: { code, message } });
    }
  });

  /*
   * The generation core, separate from the endpoint, because the task bank of section 10.1 needs
   * the same work without an HTTP request in front of it. Failures come back as errors carrying a
   * status and a public code, so both callers can answer without re-deriving them.
   */
  async function runContentGeneration({ username, input }) {
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({ promptVersion: CONTENT_PROMPT_VERSION, input })).digest('hex');
    // Own copy first, then anyone's: the same input always produces the same exercise, so a
    // second student must not cost a second paid call.
    const stored = await getGeneratedTask(username, requestHash);
    const shared = stored ? null : await getSharedGeneratedTask(requestHash);
    if (shared) {
      await saveGeneratedTask(username, {
        operation: input.operation,
        requestHash,
        request: input,
        result: shared.result,
        provider: shared.provider,
        promptVersion: shared.prompt_version,
      });
    }
    const reusable = stored || (shared ? await getGeneratedTask(username, requestHash) : null);
    if (reusable) return { data: decorateGeneratedVoiceTutorContent(input.operation, requestHash, reusable.result), provider: 'cache', sourceProvider: reusable.provider, promptVersion: reusable.prompt_version, cached: true };
    if (!await hasAiBudget()) throw Object.assign(new Error('Дневной лимит ИИ исчерпан. Попробуйте завтра.'), { status: 503, code: 'AI_BUDGET_EXHAUSTED' });
    const prompt = buildContentPrompt(input);
    const startedAt = Date.now();
    const providers = aiProviders();
    if (!providers.length) throw Object.assign(new Error('ИИ не настроен на сервере.'), { status: 503, code: 'AI_NOT_CONFIGURED' });
    let lastCode = 'AI_PROVIDER_UNAVAILABLE';
    let fallbackReason = null;
    for (const [providerIndex, provider] of providers.entries()) {
      let usage = {};
      try {
        const response = await askProvider(provider, prompt.system, prompt.user, input.operation);
        usage = response;
        const outcome = await parseWithOneRepair({
          provider,
          text: response.text,
          parse: (text) => {
            const candidate = parseContentResponse(input.operation, text);
            /* A short vocabulary set is a contract violation like any other, so it is repairable. */
            if (input.operation === 'vocabulary_cards' && candidate.length !== input.count) {
              throw Object.assign(new Error('AI_RESPONSE_INVALID'), { code: 'AI_RESPONSE_INVALID' });
            }
            return candidate;
          },
          system: prompt.system,
          user: prompt.user,
          operation: input.operation,
        });
        const data = outcome.value;
        if (outcome.repair) {
          usage = outcome.repair.usage;
          await logRepairedAttempt({
            username, operation: input.operation, promptVersion: CONTENT_PROMPT_VERSION, repair: outcome.repair, model: provider.model,
          });
        }
        if (input.operation === 'dictionary_lookup') dictionaryCache.set(input.word.toLocaleLowerCase('en'), data);
        await Promise.all([
          logAiRequest({ username, operation: input.operation, provider: provider.name, model: provider.model, promptVersion: CONTENT_PROMPT_VERSION, status: 'completed', durationMs: Date.now() - startedAt, fallbackReason, ...aiUsage(provider, usage) }),
          saveGeneratedTask(username, { operation: input.operation, requestHash, request: input, result: data, provider: provider.name, promptVersion: CONTENT_PROMPT_VERSION }),
        ]);
        recordDependencyEvent('ai', 'success');
        if (providerIndex > 0) recordDependencyEvent('ai', 'fallback');
        return { data: decorateGeneratedVoiceTutorContent(input.operation, requestHash, data), provider: provider.name, promptVersion: CONTENT_PROMPT_VERSION, cached: false };
      } catch (error) {
        if (error.status && error.code) throw error;
        recordDependencyEvent('ai', 'error');
        fallbackReason = describeFallback(provider, lastCode, error, providerIndex, providers.length);
        lastCode = error.code === 'AI_RESPONSE_INVALID' ? error.code : 'AI_PROVIDER_UNAVAILABLE';
        await logAiRequest({ username, operation: input.operation, provider: provider.name, model: provider.model, promptVersion: CONTENT_PROMPT_VERSION, status: 'failed', durationMs: Date.now() - startedAt, errorCode: lastCode, fallbackReason: describeFallback(provider, lastCode, error, providerIndex, providers.length), ...aiUsage(provider, usage) });
      }
    }
    throw Object.assign(new Error('Не удалось подготовить корректный учебный материал.'), {
      status: lastCode === 'AI_RESPONSE_INVALID' ? 502 : 503,
      code: lastCode,
    });
  }

  router.post('/api/v1/ai/generate-content', auth, requireActiveSubscription, requirePrivacyConsent('text_processing'), contentLimiter, serveCachedDictionary, async (req, res) => {
    const parsed = contentRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные параметры генерации.' } });
    try {
      const result = await runContentGeneration({ username: req.user, input: parsed.data });
      return res.json(result);
    } catch (error) {
      if (!error.status || !error.code) throw error;
      return res.status(error.status).json({ error: { code: error.code, message: error.message, requestId: req.requestId } });
    }
  });

  router.post('/api/v1/ai/evaluate-speaking', auth, requireActiveSubscription, requirePrivacyConsent('voice_processing'), requireAiBudget, speakingEvalLimiter, async (req, res) => {
    const parsed = speakingRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные устного ответа.' } });
    const input = parsed.data;
    const prompt = buildSpeakingPrompt(input);
    const attemptId = await createSpeakingAttempt(req.user, input, SPEAKING_PROMPT_VERSION);
    const startedAt = Date.now();
    const providers = aiProviders();
    if (!providers.length) {
      await finishSpeakingAttempt(attemptId, { status: 'failed', errorCode: 'AI_NOT_CONFIGURED' });
      return res.status(503).json({ error: { code: 'AI_NOT_CONFIGURED', message: 'ИИ не настроен на сервере.' } });
    }
    let lastCode = 'AI_PROVIDER_UNAVAILABLE';
    let fallbackReason = null;
    for (const [providerIndex, provider] of providers.entries()) {
      let usage = {};
      try {
        const response = await askProvider(provider, prompt.system, prompt.user, 'evaluate_speaking');
        usage = response;
        const outcome = await parseWithOneRepair({
          provider,
          text: response.text,
          parse: (text) => parseSpeakingReview(input.taskType, text),
          system: prompt.system,
          user: prompt.user,
          operation: 'evaluate_speaking',
        });
        const review = outcome.value;
        if (outcome.repair) {
          usage = outcome.repair.usage;
          await logRepairedAttempt({
            username: req.user, operation: `evaluate_speaking_${input.taskType}`, promptVersion: SPEAKING_PROMPT_VERSION, repair: outcome.repair, model: provider.model,
          });
        }
        await Promise.all([
          logAiRequest({ username: req.user, operation: `evaluate_speaking_${input.taskType}`, provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION, status: 'completed', durationMs: Date.now() - startedAt, fallbackReason, ...aiUsage(provider, usage) }),
          finishSpeakingAttempt(attemptId, {
            status: 'completed', review, provider: provider.name, model: provider.model,
          }),
        ]);
        recordDependencyEvent('ai', 'success');
        if (providerIndex > 0) recordDependencyEvent('ai', 'fallback');
        const payload = {
          review,
          provider: provider.name,
          promptVersion: SPEAKING_PROMPT_VERSION,
          attemptId,
          voiceTutor: { source: 'speaking', attemptId, revision: 1, criterionChoices: reviewVoiceTutorCriterionChoices(review) },
        };
        if (isExperimentalSpeakingTask(input.taskType)) payload.assessment = EXPERIMENTAL_ASSESSMENT;
        return res.json(payload);
      } catch (error) {
        recordDependencyEvent('ai', 'error');
        fallbackReason = describeFallback(provider, lastCode, error, providerIndex, providers.length);
        lastCode = error.code === 'AI_RESPONSE_INVALID' ? error.code : 'AI_PROVIDER_UNAVAILABLE';
        await logAiRequest({ username: req.user, operation: `evaluate_speaking_${input.taskType}`, provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION, status: 'failed', durationMs: Date.now() - startedAt, errorCode: lastCode, fallbackReason: describeFallback(provider, lastCode, error, providerIndex, providers.length), ...aiUsage(provider, usage) });
      }
    }
    const lastProvider = providers.at(-1);
    await finishSpeakingAttempt(attemptId, {
      status: 'failed',
      provider: lastProvider?.name,
      model: lastProvider?.model,
      errorCode: lastCode,
    });
    res.status(lastCode === 'AI_RESPONSE_INVALID' ? 502 : 503).json({ error: { code: lastCode, message: 'Не удалось корректно оценить устный ответ.' } });
  });

  router.post('/api/v1/ai/generate-speaking-sample', auth, requireActiveSubscription, requirePrivacyConsent('text_processing'), requireAiBudget, speakingSampleLimiter, async (req, res) => {
    const parsed = speakingSampleRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные параметры образцового ответа.' } });
    const input = parsed.data;
    const prompt = buildSpeakingSamplePrompt(input);
    const startedAt = Date.now();
    // A sample answer is a convenience: its registry entry forbids a second provider.
    const providers = providersFor('speaking_sample', aiProviders());
    if (!providers.length) return res.status(503).json({ error: { code: 'AI_NOT_CONFIGURED', message: 'ИИ не настроен на сервере.' } });
    let lastCode = 'AI_PROVIDER_UNAVAILABLE';
    let fallbackReason = null;
    for (const [providerIndex, provider] of providers.entries()) {
      let usage = {};
      try {
        const response = await askProvider(provider, prompt.system, prompt.user, 'speaking_sample');
        usage = response;
        const data = parseSpeakingSample(input.taskType, response.text);
        await logAiRequest({ username: req.user, operation: `speaking_sample_${input.taskType}`, provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION, status: 'completed', durationMs: Date.now() - startedAt, fallbackReason, ...aiUsage(provider, usage) });
        recordDependencyEvent('ai', 'success');
        if (providerIndex > 0) recordDependencyEvent('ai', 'fallback');
        return res.json({ data, provider: provider.name, promptVersion: SPEAKING_PROMPT_VERSION });
      } catch (error) {
        recordDependencyEvent('ai', 'error');
        fallbackReason = describeFallback(provider, lastCode, error, providerIndex, providers.length);
        lastCode = error.code === 'AI_RESPONSE_INVALID' ? error.code : 'AI_PROVIDER_UNAVAILABLE';
        await logAiRequest({ username: req.user, operation: `speaking_sample_${input.taskType}`, provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION, status: 'failed', durationMs: Date.now() - startedAt, errorCode: lastCode, fallbackReason: describeFallback(provider, lastCode, error, providerIndex, providers.length), ...aiUsage(provider, usage) });
      }
    }
    res.status(lastCode === 'AI_RESPONSE_INVALID' ? 502 : 503).json({ error: { code: lastCode, message: 'Не удалось подготовить образцовый ответ.' } });
  });

  // ---- нейро-озвучка: Grok TTS (основной) + Edge TTS (запасной и для медленного) ----

  return { router, runContentGeneration };
}
