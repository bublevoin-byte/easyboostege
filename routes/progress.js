import express from 'express';
import { rateLimit } from 'express-rate-limit';

import { validateProgress } from '../validation/api-input.js';
import { moduleAttemptSchema } from '../validation/module-attempt.js';
import { requiresServerAssessment } from '../adaptive-learning/evidence-policy.js';
import { wordProgressBatchSchema } from '../validation/word-progress.js';
import { errorBankBatchSchema } from '../validation/error-bank.js';
import {
  personalVocabularyCardsSchema,
  personalVocabularyTombstonesSchema,
} from '../validation/personal-words.js';
import { learnerPreferencesSchema } from '../validation/learner-preferences.js';
import { grammarMasteryBatchSchema, grammarMasteryEventSchema } from '../validation/grammar-mastery.js';
import { grammarRecommendationResolveSchema } from '../validation/grammar-recommendation.js';
import { bindResponseOwner, requireExpectedOwner } from '../middleware/expected-owner.js';
import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';
import { EasyBoostGrammar } from '../public/modules/grammar.js';
import {
  buildGrammarRecommendation,
  createGrammarRecommendationCompletionToken,
  resolveGrammarRecommendation,
  verifyGrammarRecommendationCompletionToken,
} from '../services/grammar-recommendation.js';

const MAX_MODULES_PER_REQUEST = 64;

function requireIntendedOwner(req, res) {
  const owner = typeof req.body?.owner === 'string' ? req.body.owner : '';
  if (!owner || owner !== owner.trim() || owner.length > 128) {
    res.status(400).json({ error: { code: 'INVALID_OWNER', message: 'Некорректный владелец результата.' } });
    return false;
  }
  if (owner !== req.user) {
    res.status(409).json({ error: {
      code: 'OWNER_CHANGED',
      message: 'Аккаунт изменился. Войдите снова и повторите синхронизацию.',
    } });
    return false;
  }
  return true;
}

function parseStructuredProgressModules(progress) {
  const data = { ...(progress || {}) };
  if (Object.hasOwn(data, 'grammarMastery')) {
    return { ok: false, code: 'SERVER_OWNED_GRAMMAR_MASTERY' };
  }
  delete data.grammarRunner;
  for (const [key, schema, code] of [
    ['personalWords', personalVocabularyCardsSchema, 'INVALID_PERSONAL_WORDS'],
    ['personalWordTombstones', personalVocabularyTombstonesSchema, 'INVALID_PERSONAL_WORDS'],
    ['learnerPreferences', learnerPreferencesSchema, 'INVALID_LEARNER_PREFERENCES'],
  ]) {
    if (!Object.hasOwn(data, key)) continue;
    const parsed = schema.safeParse(data[key]);
    if (!parsed.success) return { ok: false, code };
    data[key] = parsed.data;
  }
  return { ok: true, data };
}

function perUserLimiter(limit, message) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => req.user,
    message: { error: { code: 'RATE_LIMITED', message } },
  });
}

// Progress, module attempts, word cards and the error bank — everything a student generates.
export function createProgressRoutes({
  authentication, db, now = () => new Date(), recommendationSecret = null,
}) {
  const router = express.Router();
  const { auth } = authentication;

  router.get('/api/v1/progress', auth, async (req, res, next) => {
    try {
      if (!requireExpectedOwner(req, res)) return;
      const progress = await db.getProgress(req.user); bindResponseOwner(res, req.user); res.json(progress);
    } catch (error) { next(error); }
  });

  router.post('/api/v1/progress', auth, async (req, res, next) => {
    try {
      if (!requireExpectedOwner(req, res)) return;
      const parsed = validateProgress(req.body);
      const structured = parsed.ok ? parseStructuredProgressModules(parsed.data) : { ok: false };
      if (!parsed.ok || !structured.ok) {
        return res.status(400).json({ error: { code: 'INVALID_PROGRESS', message: 'Некорректные данные прогресса.', reason: parsed.code || structured.code } });
      }
      await db.saveProgress(req.user, structured.data);
      bindResponseOwner(res, req.user);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  // Module-level merge: a partial update must never replace the whole progress object.
  router.post('/api/v1/progress/modules', auth, async (req, res, next) => {
    try {
      if (!requireIntendedOwner(req, res)) return;
      const modules = req.body?.modules;
      const parsed = validateProgress(modules);
      const count = Object.keys(parsed.data || {}).length;
      const structured = parsed.ok ? parseStructuredProgressModules(parsed.data) : { ok: false };
      if (!parsed.ok || count === 0 || count > MAX_MODULES_PER_REQUEST || !structured.ok) {
        return res.status(400).json({ error: { code: 'INVALID_PROGRESS_MODULES', message: 'Некорректные модули прогресса.', reason: parsed.code || structured.code || 'INVALID_MODULE_COUNT' } });
      }
      const progress = await db.mergeProgress(req.user, structured.data);
      res.json({ ok: true, progress });
    } catch (error) { next(error); }
  });

  async function grammarRecommendationContext(username) {
    const [mastery, goal] = await Promise.all([
      db.migrateGrammarMastery(username),
      typeof db.getAdaptiveLearningGoal === 'function'
        ? db.getAdaptiveLearningGoal(username) : null,
    ]);
    return {
      mastery,
      catalog: GRAMMAR_CATALOG,
      examDate: goal?.examDate ?? goal?.exam_date ?? null,
      now: now(),
    };
  }

  function targetedCompletionIsAuthorized(username, event) {
    if (event?.type !== 'session_completed' || event.session?.mode !== 'targeted_practice') return true;
    const binding = event.session.recommendation;
    return binding?.pointer?.masteryRevision === event.expectedRevision
      && verifyGrammarRecommendationCompletionToken({
      owner: username,
      pointer: binding?.pointer,
      itemIds: binding?.itemIds,
    }, recommendationSecret, binding?.completionToken);
  }

  function masteryPersistenceEntries(entry) {
    if (entry.event?.type !== 'session_completed'
      || !['mixed_practice', 'exam_19_24'].includes(entry.event.session?.mode)) {
      return [{ ...entry, multiTopic: false }];
    }
    return entry.event.session.topicExpectations.map((expectation) => ({
      topicId: expectation.topicId,
      event: {
        ...entry.event,
        expectedRevision: expectation.expectedRevision,
        expectedStage: expectation.expectedStage,
        expectedReviewStep: expectation.expectedReviewStep,
      },
      multiTopic: true,
    }));
  }

  function publicMasteryResults(entries, results) {
    return results.map((result, index) => entries[index]?.multiTopic
      ? { ...result, topicId: entries[index].topicId }
      : result);
  }

  function rejectUnauthorizedTargetedCompletion(res) {
    return res.status(409).json({ error: {
      code: 'GRAMMAR_RECOMMENDATION_COMPLETION_INVALID',
      message: 'Точная рекомендация устарела или была изменена. Начните новый подход.',
    } });
  }

  router.get('/api/v1/grammar/recommendation', auth, async (req, res, next) => {
    try {
      if (!requireExpectedOwner(req, res)) return;
      const recommendation = buildGrammarRecommendation(
        await grammarRecommendationContext(req.user),
      );
      res.setHeader('Cache-Control', 'no-store');
      bindResponseOwner(res, req.user);
      return res.json({ recommendation });
    } catch (error) { return next(error); }
  });

  router.post('/api/v1/grammar/recommendation/resolve', auth, perUserLimiter(120, 'Слишком много запросов точной практики.'), async (req, res, next) => {
    try {
      if (!requireExpectedOwner(req, res)) return;
      const parsed = grammarRecommendationResolveSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный указатель точной практики.' } });
      }
      const context = await grammarRecommendationContext(req.user);
      const recommendation = resolveGrammarRecommendation(parsed.data.pointer, context);
      if (!recommendation) {
        return res.status(409).json({ error: {
          code: 'GRAMMAR_RECOMMENDATION_STALE',
          message: 'Приоритет изменился. Обновите рекомендацию и начните новый подход.',
        } });
      }
      const queue = EasyBoostGrammar.buildTargetedPracticeQueue(
        GRAMMAR_CATALOG.bank, recommendation.pointer, { seed: recommendation.pointer.ref },
      );
      if (queue.length !== 8) {
        return res.status(409).json({ error: {
          code: 'GRAMMAR_RECOMMENDATION_UNAVAILABLE',
          message: 'Для этой точной слабости пока недостаточно независимых заданий.',
        } });
      }
      const itemIds = queue.map((item) => item.q.id);
      const completionToken = createGrammarRecommendationCompletionToken({
        owner: req.user, pointer: recommendation.pointer, itemIds,
      }, recommendationSecret);
      res.setHeader('Cache-Control', 'no-store');
      bindResponseOwner(res, req.user);
      return res.json({
        recommendation,
        catalog: { version: GRAMMAR_CATALOG.version, revision: GRAMMAR_CATALOG.revision },
        itemIds,
        completionToken,
      });
    } catch (error) { return next(error); }
  });

  router.post('/api/v1/grammar/mastery-events', auth, perUserLimiter(240, 'Слишком много результатов грамматики за короткое время.'), async (req, res, next) => {
    try {
      if (!requireExpectedOwner(req, res)) return;
      const parsed = grammarMasteryEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректное событие освоения грамматики.' } });
      }
      if (!targetedCompletionIsAuthorized(req.user, parsed.data.event)) {
        return rejectUnauthorizedTargetedCompletion(res);
      }
      const entries = masteryPersistenceEntries(parsed.data);
      const results = entries.length === 1 && !entries[0].multiTopic
        ? [await db.applyGrammarMasteryEvent(req.user, entries[0].topicId, entries[0].event)]
        : await db.applyGrammarMasteryEvents(req.user,
          entries.map(({ topicId, event }) => ({ topicId, event })));
      const publicResults = publicMasteryResults(entries, results);
      const result = entries.length === 1 ? publicResults[0] : {
        eventId: parsed.data.event.id,
        applied: publicResults.every((item) => item.applied),
        conflict: publicResults.some((item) => item.conflict),
        replay: publicResults.every((item) => item.replay),
        record: publicResults[0]?.record,
        results: publicResults,
      };
      bindResponseOwner(res, req.user);
      return res.status(result.applied ? 201 : 200).json(result);
    } catch (error) {
      if (error?.code === 'INVALID_GENERATED_GRAMMAR_REFERENCE') {
        return res.status(400).json({ error: { code: error.code, message: 'Сгенерированное задание больше не принадлежит активному каталогу ученика.' } });
      }
      return next(error);
    }
  });

  router.post('/api/v1/grammar/mastery-events/batch', auth, perUserLimiter(240, 'Слишком много результатов грамматики за короткое время.'), async (req, res, next) => {
    try {
      const parsed = grammarMasteryBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректная группа событий освоения грамматики.' } });
      }
      if (parsed.data.owner !== req.user) {
        return res.status(409).json({ error: {
          code: 'GRAMMAR_MASTERY_OWNER_CHANGED',
          message: 'Аккаунт изменился. Войдите снова и повторите синхронизацию.',
        } });
      }
      if (parsed.data.events.some((entry) => !targetedCompletionIsAuthorized(req.user, entry.event))) {
        return rejectUnauthorizedTargetedCompletion(res);
      }
      const entries = parsed.data.events.flatMap(masteryPersistenceEntries);
      const results = await db.applyGrammarMasteryEvents(req.user,
        entries.map(({ topicId, event }) => ({ topicId, event })));
      const publicResults = publicMasteryResults(entries, results);
      bindResponseOwner(res, req.user);
      return res.status(publicResults.every((result) => result.applied) ? 201 : 200)
        .json({ batchId: parsed.data.batchId, results: publicResults });
    } catch (error) {
      if (error?.code === 'INVALID_GENERATED_GRAMMAR_REFERENCE') {
        return res.status(400).json({ error: { code: error.code, message: 'Сгенерированное задание больше не принадлежит активному каталогу ученика.' } });
      }
      return next(error);
    }
  });

  router.post('/api/v1/module-attempts', auth, perUserLimiter(240, 'Слишком много результатов за короткое время.'), async (req, res, next) => {
    try {
      if (!requireIntendedOwner(req, res)) return;
      const { owner: _intendedOwner, ...attemptBody } = req.body || {};
      const parsed = moduleAttemptSchema.safeParse(attemptBody);
      if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные попытки.' } });
      if (requiresServerAssessment(parsed.data.module)) {
        return res.status(400).json({ error: {
          code: 'SERVER_ASSESSMENT_REQUIRED',
          message: 'Письмо и говорение учитываются только после завершённой серверной проверки.',
        } });
      }
      if (['voice_tutor_error', 'voice_tutor_context_result'].includes(parsed.data.activity)) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Voice Tutor error создаётся только проверенным серверным маршрутом.' } });
      }
      const { adaptiveExecutionClaim, ...attempt } = parsed.data;
      const result = adaptiveExecutionClaim
        ? await db.recordModuleAttemptWithAdaptiveClaim(req.user, attempt, {
          executionClaim: adaptiveExecutionClaim, now: now(),
        })
        : await db.recordModuleAttempt(req.user, attempt);
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      const known = {
        ADAPTIVE_EXECUTION_CLAIM_INVALID: [409, 'ADAPTIVE_EXECUTION_CLAIM_INVALID'],
        ADAPTIVE_EXECUTION_CLAIM_EXPIRED: [410, 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED'],
        ADAPTIVE_EXECUTION_CLAIM_CONSUMED: [409, 'ADAPTIVE_EXECUTION_CLAIM_CONSUMED'],
        ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH: [409, 'ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH'],
      }[error?.message];
      if (known) return res.status(known[0]).json({ error: { code: known[1] } });
      return next(error);
    }
  });

  router.put('/api/v1/word-progress', auth, perUserLimiter(120, 'Слишком много обновлений словаря.'), async (req, res, next) => {
    try {
      if (!requireExpectedOwner(req, res)) return;
      const parsed = wordProgressBatchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный прогресс слов.' } });
      const result = await db.upsertWordProgress(req.user, parsed.data.words);
      bindResponseOwner(res, req.user); res.json(result);
    } catch (error) { next(error); }
  });

  router.get('/api/v1/word-progress', auth, async (req, res, next) => {
    try {
      if (!requireExpectedOwner(req, res)) return;
      const words = await db.getWordProgress(req.user);
      bindResponseOwner(res, req.user); res.json({ words });
    } catch (error) { next(error); }
  });

  router.post('/api/v1/error-bank', auth, perUserLimiter(120, 'Слишком много обновлений банка ошибок.'), async (req, res, next) => {
    try {
      const parsed = errorBankBatchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные банка ошибок.' } });
      res.json(await db.upsertErrorBank(req.user, parsed.data.errors));
    } catch (error) { next(error); }
  });

  return router;
}
