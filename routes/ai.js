import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import express from 'express';

import { config } from '../config.js';
import { buildWritingPrompt, parseAndValidateWritingReview, WRITING_PROMPT_VERSION, writingRequestSchema } from '../ai/writing.js';
import { buildContentPrompt, CONTENT_PROMPT_VERSION, contentRequestSchema, parseContentResponse } from '../ai/content.js';
import { buildSpeakingPrompt, buildSpeakingSamplePrompt, parseSpeakingReview, parseSpeakingSample, SPEAKING_PROMPT_VERSION, speakingRequestSchema, speakingSampleRequestSchema } from '../ai/speaking.js';
import { estimateCostMicrousd, runProviderFallback, TtlCache } from '../ai/provider-control.js';
import { recordDependencyEvent } from '../observability/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A single line an operator can grep: which provider gave up, on what, and whether a spare was left.
function describeFallback(provider, code, error, index, total) {
  const reason = error?.message && error.message !== code ? `${code}: ${String(error.message).slice(0, 120)}` : code;
  return `${provider.name} → ${index + 1 < total ? 'switched to next provider' : 'no provider left'} (${reason})`;
}


const XAI_KEY = config.ai.xaiKey;
const XAI_MODEL = config.ai.xaiModel;
const GROQ_KEY = config.ai.groqKey;
const GROQ_MODEL = config.ai.groqModel;

// Server-side AI operations. The client never sends a system prompt: each operation has its own contract.
export function createAiRoutes({ authentication, access, db }) {
  const router = express.Router();
  const { auth } = authentication;
  const { chatLimiter, writingLimiter, requireAiBudget, requireActiveSubscription, requirePrivacyConsent, hasAiBudget } = access;
  const {
    createWritingAttempt, finishWritingAttempt, createSpeakingAttempt, finishSpeakingAttempt,
    getGeneratedTask, getSharedGeneratedTask, saveGeneratedTask, logAiRequest,
  } = db;

  async function askProvider({ url, key, model }, system, user) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ai.timeoutMs);
    let r;
    try {
      r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 1600,
        messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
      }),
    });
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

  function aiProviders() {
    const providers = [];
    if (config.ai.xaiEnabled && XAI_KEY) providers.push({ name: 'grok', url: config.ai.xaiUrl, key: XAI_KEY, model: XAI_MODEL, inputMicrousdPerMillion: config.ai.xaiInputMicrousdPerMillion, outputMicrousdPerMillion: config.ai.xaiOutputMicrousdPerMillion });
    if (config.ai.groqEnabled && GROQ_KEY) providers.push({ name: 'groq', url: config.ai.groqUrl, key: GROQ_KEY, model: GROQ_MODEL, inputMicrousdPerMillion: config.ai.groqInputMicrousdPerMillion, outputMicrousdPerMillion: config.ai.groqOutputMicrousdPerMillion });
    return providers;
  }

  async function askWithFallback(system, user) {
    const providers = aiProviders();
    return runProviderFallback(providers, (provider) => askProvider(provider, system, user));
  }

  function aiUsage(provider, response) {
    return { promptTokens: response.promptTokens, completionTokens: response.completionTokens, estimatedCostMicrousd: estimateCostMicrousd(response, provider) };
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

    const input = parsed.data;
    const startedAt = Date.now();
    let attemptId;
    let provider = null;
    let model = null;
    let promptTokens = null;
    let completionTokens = null;
    try {
      attemptId = await createWritingAttempt(req.user, input, WRITING_PROMPT_VERSION);
      const prompt = buildWritingPrompt(input);
      const result = await askWithFallback(prompt.system, prompt.user);
      recordDependencyEvent('ai', 'success');
      if (result.attempts > 1) recordDependencyEvent('ai', 'fallback');
      provider = result.provider;
      model = result.model;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      const review = parseAndValidateWritingReview(result.text, input);
      await finishWritingAttempt(attemptId, { status: 'completed', review, provider });
      await logAiRequest({
        username: req.user,
        operation: input.taskType,
        provider,
        model,
        promptVersion: WRITING_PROMPT_VERSION,
        status: 'completed',
        durationMs: Date.now() - startedAt,
        fallbackReason: result.fallbackReason,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        estimatedCostMicrousd: estimateCostMicrousd(result, aiProviders().find((item) => item.name === provider)),
      });
      res.json({ review, provider, attemptId });
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
      if (attemptId) writes.push(finishWritingAttempt(attemptId, { status: 'failed', provider, errorCode: code }));
      await Promise.allSettled(writes);
      const message = code === 'AI_NOT_CONFIGURED'
        ? 'ИИ не настроен на сервере.'
        : code === 'AI_RESPONSE_INVALID'
          ? 'ИИ вернул некорректный разбор. Попробуйте ещё раз.'
          : 'ИИ временно недоступен.';
      res.status(status).json({ error: { code, message } });
    }
  });

  router.post('/api/v1/ai/generate-content', auth, requireActiveSubscription, requirePrivacyConsent('text_processing'), chatLimiter, serveCachedDictionary, async (req, res) => {
    const parsed = contentRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные параметры генерации.' } });
    const input = parsed.data;
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({ promptVersion: CONTENT_PROMPT_VERSION, input })).digest('hex');
    // Own copy first, then anyone's: the same input always produces the same exercise, so a
    // second student must not cost a second paid call.
    const stored = await getGeneratedTask(req.user, requestHash) || await getSharedGeneratedTask(requestHash);
    if (stored) return res.json({ data: stored.result, provider: 'cache', sourceProvider: stored.provider, promptVersion: stored.prompt_version, cached: true });
    if (!await hasAiBudget()) return res.status(503).json({ error: { code: 'AI_BUDGET_EXHAUSTED', message: 'Дневной лимит ИИ исчерпан. Попробуйте завтра.' } });
    const prompt = buildContentPrompt(input);
    const startedAt = Date.now();
    const providers = aiProviders();
    if (!providers.length) return res.status(503).json({ error: { code: 'AI_NOT_CONFIGURED', message: 'ИИ не настроен на сервере.' } });
    let lastCode = 'AI_PROVIDER_UNAVAILABLE';
    let fallbackReason = null;
    for (const [providerIndex, provider] of providers.entries()) {
      let usage = {};
      try {
        const response = await askProvider(provider, prompt.system, prompt.user);
        usage = response;
        const data = parseContentResponse(input.operation, response.text);
        if (input.operation === 'vocabulary_cards' && data.length !== input.count) throw Object.assign(new Error('AI_RESPONSE_INVALID'), { code: 'AI_RESPONSE_INVALID' });
        if (input.operation === 'dictionary_lookup') dictionaryCache.set(input.word.toLocaleLowerCase('en'), data);
        await Promise.all([
          logAiRequest({ username: req.user, operation: input.operation, provider: provider.name, model: provider.model, promptVersion: CONTENT_PROMPT_VERSION, status: 'completed', durationMs: Date.now() - startedAt, fallbackReason, ...aiUsage(provider, usage) }),
          saveGeneratedTask(req.user, { operation: input.operation, requestHash, request: input, result: data, provider: provider.name, promptVersion: CONTENT_PROMPT_VERSION }),
        ]);
        recordDependencyEvent('ai', 'success');
        if (providerIndex > 0) recordDependencyEvent('ai', 'fallback');
        return res.json({ data, provider: provider.name, promptVersion: CONTENT_PROMPT_VERSION });
      } catch (error) {
        recordDependencyEvent('ai', 'error');
        fallbackReason = describeFallback(provider, lastCode, error, providerIndex, providers.length);
        lastCode = error.code === 'AI_RESPONSE_INVALID' ? error.code : 'AI_PROVIDER_UNAVAILABLE';
        await logAiRequest({ username: req.user, operation: input.operation, provider: provider.name, model: provider.model, promptVersion: CONTENT_PROMPT_VERSION, status: 'failed', durationMs: Date.now() - startedAt, errorCode: lastCode, fallbackReason: describeFallback(provider, lastCode, error, providerIndex, providers.length), ...aiUsage(provider, usage) });
      }
    }
    const status = lastCode === 'AI_RESPONSE_INVALID' ? 502 : 503;
    res.status(status).json({ error: { code: lastCode, message: 'Не удалось подготовить корректный учебный материал.' } });
  });

  router.post('/api/v1/ai/evaluate-speaking', auth, requireActiveSubscription, requirePrivacyConsent('voice_processing'), requireAiBudget, chatLimiter, async (req, res) => {
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
        const response = await askProvider(provider, prompt.system, prompt.user);
        usage = response;
        const review = parseSpeakingReview(input.taskType, response.text);
        await Promise.all([
          logAiRequest({ username: req.user, operation: `evaluate_speaking_${input.taskType}`, provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION, status: 'completed', durationMs: Date.now() - startedAt, fallbackReason, ...aiUsage(provider, usage) }),
          finishSpeakingAttempt(attemptId, { status: 'completed', review, provider: provider.name }),
        ]);
        recordDependencyEvent('ai', 'success');
        if (providerIndex > 0) recordDependencyEvent('ai', 'fallback');
        return res.json({ review, provider: provider.name, promptVersion: SPEAKING_PROMPT_VERSION });
      } catch (error) {
        recordDependencyEvent('ai', 'error');
        fallbackReason = describeFallback(provider, lastCode, error, providerIndex, providers.length);
        lastCode = error.code === 'AI_RESPONSE_INVALID' ? error.code : 'AI_PROVIDER_UNAVAILABLE';
        await logAiRequest({ username: req.user, operation: `evaluate_speaking_${input.taskType}`, provider: provider.name, model: provider.model, promptVersion: SPEAKING_PROMPT_VERSION, status: 'failed', durationMs: Date.now() - startedAt, errorCode: lastCode, fallbackReason: describeFallback(provider, lastCode, error, providerIndex, providers.length), ...aiUsage(provider, usage) });
      }
    }
    await finishSpeakingAttempt(attemptId, { status: 'failed', errorCode: lastCode });
    res.status(lastCode === 'AI_RESPONSE_INVALID' ? 502 : 503).json({ error: { code: lastCode, message: 'Не удалось корректно оценить устный ответ.' } });
  });

  router.post('/api/v1/ai/generate-speaking-sample', auth, requireActiveSubscription, requirePrivacyConsent('text_processing'), requireAiBudget, chatLimiter, async (req, res) => {
    const parsed = speakingSampleRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные параметры образцового ответа.' } });
    const input = parsed.data;
    const prompt = buildSpeakingSamplePrompt(input);
    const startedAt = Date.now();
    const providers = aiProviders();
    if (!providers.length) return res.status(503).json({ error: { code: 'AI_NOT_CONFIGURED', message: 'ИИ не настроен на сервере.' } });
    let lastCode = 'AI_PROVIDER_UNAVAILABLE';
    let fallbackReason = null;
    for (const [providerIndex, provider] of providers.entries()) {
      let usage = {};
      try {
        const response = await askProvider(provider, prompt.system, prompt.user);
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

  return router;
}
