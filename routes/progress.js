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

const MAX_MODULES_PER_REQUEST = 64;

function parseStructuredProgressModules(progress) {
  const data = { ...(progress || {}) };
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
    try { res.json(await db.getProgress(req.user)); } catch (error) { next(error); }
  });

  router.post('/api/v1/progress', auth, async (req, res, next) => {
    try {
      const parsed = validateProgress(req.body);
      const structured = parsed.ok ? parseStructuredProgressModules(parsed.data) : { ok: false };
      if (!parsed.ok || !structured.ok) {
        return res.status(400).json({ error: { code: 'INVALID_PROGRESS', message: 'Некорректные данные прогресса.', reason: parsed.code || structured.code } });
      }
      await db.saveProgress(req.user, structured.data);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  // Module-level merge: a partial update must never replace the whole progress object.
  router.post('/api/v1/progress/modules', auth, async (req, res, next) => {
    try {
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

  router.post('/api/v1/module-attempts', auth, perUserLimiter(240, 'Слишком много результатов за короткое время.'), async (req, res, next) => {
    try {
      const parsed = moduleAttemptSchema.safeParse(req.body);
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
      const parsed = wordProgressBatchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный прогресс слов.' } });
      res.json(await db.upsertWordProgress(req.user, parsed.data.words));
    } catch (error) { next(error); }
  });

  router.get('/api/v1/word-progress', auth, async (req, res, next) => {
    try { res.json({ words: await db.getWordProgress(req.user) }); } catch (error) { next(error); }
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
