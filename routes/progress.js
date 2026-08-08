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
import { bindResponseOwner, requireExpectedOwner } from '../middleware/expected-owner.js';

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
export function createProgressRoutes({ authentication, db, now = () => new Date() }) {
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

  router.post('/api/v1/grammar/mastery-events', auth, perUserLimiter(240, 'Слишком много результатов грамматики за короткое время.'), async (req, res, next) => {
    try {
      if (!requireExpectedOwner(req, res)) return;
      const parsed = grammarMasteryEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректное событие освоения грамматики.' } });
      }
      const result = await db.applyGrammarMasteryEvent(
        req.user, parsed.data.topicId, parsed.data.event,
      );
      bindResponseOwner(res, req.user);
      return res.status(result.applied ? 201 : 200).json(result);
    } catch (error) { return next(error); }
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
      const results = await db.applyGrammarMasteryEvents(req.user, parsed.data.events);
      return res.status(results.every((result) => result.applied) ? 201 : 200).json({ batchId: parsed.data.batchId, results });
    } catch (error) { return next(error); }
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
