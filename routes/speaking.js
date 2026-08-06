import express from 'express';
import { z } from 'zod';

import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { speakingTask1PublicAssignment } from '../public/speaking-catalog-contract.js';
import { publicSpeakingTask1Session } from '../speaking/task1-session.js';

const emptyBodySchema = z.object({}).strict();
const sessionIdSchema = z.string().uuid();
const completionSchema = z.object({
  recordingDurationSeconds: z.number().finite().min(1).max(90),
  micCheck: z.enum(['passed', 'quiet', 'skipped']),
  localPlayback: z.boolean(),
  selfRating: z.enum(['weak', 'steady', 'strong']),
}).strict();

function validationError(req, res, message) {
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, requestId: req.requestId } });
}

function taskForSession(session) {
  return SPEAKING_TASK1_CATALOG.tasks.find((task) => task.id === session.task_id
    && task.revision === Number(session.task_revision));
}

function sessionResponse(session) {
  const task = taskForSession(session);
  if (!task) throw new Error('SPEAKING_TASK1_CATALOG_REVISION_MISMATCH');
  return publicSpeakingTask1Session(session, speakingTask1PublicAssignment(task));
}

export function createSpeakingRoutes({ authentication, access, db, now = () => new Date() }) {
  const router = express.Router();
  const { auth } = authentication;
  const { requireActiveSubscription } = access;

  router.post('/api/v1/speaking/task-1/sessions', auth, requireActiveSubscription, async (req, res, next) => {
    const parsed = emptyBodySchema.safeParse(req.body || {});
    if (!parsed.success) return validationError(req, res, 'Параметры задания выбирает сервер.');
    try {
      res.setHeader('Cache-Control', 'no-store');
      const session = await db.assignSpeakingTask1Session(req.user, {
        catalogId: SPEAKING_TASK1_CATALOG.id,
        catalogRevision: SPEAKING_TASK1_CATALOG.revision,
        tasks: SPEAKING_TASK1_CATALOG.tasks,
        now: now(),
      });
      return res.status(201).json(sessionResponse(session));
    } catch (error) { return next(error); }
  });

  router.get('/api/v1/speaking/task-1/sessions/:sessionId', auth, requireActiveSubscription, async (req, res, next) => {
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return validationError(req, res, 'Недопустимый идентификатор тренировки.');
    try {
      res.setHeader('Cache-Control', 'no-store');
      const session = await db.getSpeakingTask1Session(req.user, sessionId.data);
      if (!session) return res.status(404).json({ error: { code: 'SPEAKING_SESSION_NOT_FOUND', message: 'Тренировка не найдена.' } });
      return res.json(sessionResponse(session));
    } catch (error) { return next(error); }
  });

  router.post('/api/v1/speaking/task-1/sessions/:sessionId/complete', auth, requireActiveSubscription, async (req, res, next) => {
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return validationError(req, res, 'Недопустимый идентификатор тренировки.');
    const parsed = completionSchema.safeParse(req.body);
    if (!parsed.success) return validationError(req, res, 'Недопустимые метаданные тренировки.');
    try {
      res.setHeader('Cache-Control', 'no-store');
      const session = await db.completeSpeakingTask1Session(req.user, sessionId.data, parsed.data, { now: now() });
      if (!session) return res.status(404).json({ error: { code: 'SPEAKING_SESSION_NOT_FOUND', message: 'Тренировка не найдена.' } });
      return res.json(sessionResponse(session));
    } catch (error) { return next(error); }
  });

  return router;
}
