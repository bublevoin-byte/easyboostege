import crypto from 'node:crypto';
import express from 'express';

import { buildAdaptiveLearningProfile } from '../adaptive-learning/profile.js';
import { adaptiveLearningGoalPublicDto } from '../adaptive-learning/goal-dto.js';
import { adaptiveLearningProfilePublicDto } from '../adaptive-learning/repository-dto.js';
import { adaptiveGoalSchema, isFutureExamDate } from '../validation/adaptive-learning.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,119}$/u;

function requestHash(goal) {
  return crypto.createHash('sha256').update(JSON.stringify([
    goal.targetExam, goal.targetScore, goal.examDate, goal.weeklyMinutes,
  ])).digest('hex');
}

export function createAdaptiveLearningRoutes({ authentication, db, now = () => new Date(), enabled = false }) {
  const router = express.Router();
  if (!enabled) return router;
  const { auth } = authentication;

  async function overview(username) {
    const [goal, sources] = await Promise.all([
      db.getAdaptiveLearningGoal(username),
      db.getAdaptiveLearningEvidenceSources(username),
    ]);
    const profile = buildAdaptiveLearningProfile(sources);
    const authoritativeProfile = await db.saveAdaptiveLearningProfile(username, profile, { now: now() });
    return {
      goal: adaptiveLearningGoalPublicDto(goal),
      profile: adaptiveLearningProfilePublicDto(authoritativeProfile),
    };
  }

  router.get('/api/v1/adaptive-learning/goal', auth, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ goal: adaptiveLearningGoalPublicDto(await db.getAdaptiveLearningGoal(req.user)) });
    } catch (error) { next(error); }
  });

  router.put('/api/v1/adaptive-learning/goal', auth, async (req, res, next) => {
    const parsed = adaptiveGoalSchema.safeParse(req.body);
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!parsed.success || !IDEMPOTENCY_KEY.test(idempotencyKey)
      || !isFutureExamDate(parsed.data?.examDate, now())) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Проверьте цель, дату экзамена и доступное время.' },
      });
    }
    try {
      const saved = await db.saveAdaptiveLearningGoal(req.user, {
        id: crypto.randomUUID(),
        idempotencyKey,
        requestHash: requestHash(parsed.data),
        targetExam: parsed.data.targetExam,
        targetScore: parsed.data.targetScore,
        examDate: parsed.data.examDate,
        weeklyMinutes: parsed.data.weeklyMinutes,
        now: now(),
      });
      const result = await overview(req.user);
      return res.status(saved.created ? 201 : 200).json({
        created: saved.created,
        goal: adaptiveLearningGoalPublicDto(saved.goal),
        profile: result.profile,
      });
    } catch (error) {
      if (error?.message === 'ADAPTIVE_GOAL_IDEMPOTENCY_CONFLICT') {
        return res.status(409).json({
          error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Этот ключ уже использован для другой цели.' },
        });
      }
      return next(error);
    }
  });

  router.get('/api/v1/adaptive-learning/overview', auth, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await overview(req.user));
    } catch (error) { next(error); }
  });

  return router;
}
