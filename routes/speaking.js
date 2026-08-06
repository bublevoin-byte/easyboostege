import express from 'express';
import { z } from 'zod';

import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import {
  speakingTask1PublicAssignment,
  speakingTask2PublicAssignment,
  speakingTask3PublicAssignment,
} from '../public/speaking-catalog-contract.js';
import { publicSpeakingTask1Session } from '../speaking/task1-session.js';
import { publicSpeakingTask2Session } from '../speaking/task2-session.js';
import { publicSpeakingTask3Session } from '../speaking/task3-session.js';

const emptyBodySchema = z.object({}).strict();
const sessionIdSchema = z.string().uuid();
const questionNumberSchema = z.coerce.number().int().min(1).max(4);
const interviewQuestionNumberSchema = z.coerce.number().int().min(1).max(5);
const completionSchema = z.object({
  recordingDurationSeconds: z.number().finite().min(1).max(90),
  micCheck: z.enum(['passed', 'quiet', 'skipped']),
  localPlayback: z.boolean(),
  selfRating: z.enum(['weak', 'steady', 'strong']),
}).strict();
const task2QuestionCompletionSchema = z.object({
  recordingDurationSeconds: z.number().finite().min(1).max(20),
  localPlayback: z.boolean(),
  selfRating: z.enum(['weak', 'steady', 'strong']),
}).strict();
const task3AnswerCompletionSchema = z.object({
  recordingDurationSeconds: z.number().finite().min(1).max(40),
  localPlayback: z.boolean(),
  selfRating: z.enum(['weak', 'steady', 'strong']),
}).strict();

function validationError(req, res, message) {
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message, requestId: req.requestId } });
}

function publicCatalogSession(session, { catalog, publicAssignment, publicSession, mismatchCode }) {
  if (session.catalog_id !== catalog.id || Number(session.catalog_revision) !== catalog.revision) {
    throw Object.assign(new Error(mismatchCode), { code: mismatchCode });
  }
  const task = catalog.tasks.find((candidate) => candidate.id === session.task_id
    && candidate.revision === Number(session.task_revision));
  if (!task) throw Object.assign(new Error(mismatchCode), { code: mismatchCode });
  return publicSession(session, publicAssignment(task));
}

function catalogMismatchResponse(req, res, error) {
  const code = String(error?.code || '');
  if (![
    'SPEAKING_TASK1_CATALOG_REVISION_MISMATCH',
    'SPEAKING_TASK2_CATALOG_REVISION_MISMATCH',
    'SPEAKING_TASK3_CATALOG_REVISION_MISMATCH',
  ].includes(code)) {
    return false;
  }
  res.status(409).json({ error: {
    code,
    message: 'Версия каталога этой тренировки больше не поддерживается. Начни новую тренировку.',
    requestId: req.requestId,
  } });
  return true;
}

export function createSpeakingRoutes({ authentication, access, db, now = () => new Date() }) {
  const router = express.Router();
  const { auth } = authentication;
  const { requireActiveSubscription } = access;

  function registerAssignmentRoutes({ basePath, catalog, assign, get, response }) {
    router.post(basePath, auth, requireActiveSubscription, async (req, res, next) => {
      const parsed = emptyBodySchema.safeParse(req.body || {});
      if (!parsed.success) return validationError(req, res, 'Параметры задания выбирает сервер.');
      try {
        res.setHeader('Cache-Control', 'no-store');
        const session = await assign(req.user, {
          catalogId: catalog.id,
          catalogRevision: catalog.revision,
          tasks: catalog.tasks,
          now: now(),
        });
        return res.status(201).json(response(session));
      } catch (error) {
        if (catalogMismatchResponse(req, res, error)) return undefined;
        return next(error);
      }
    });

    router.get(`${basePath}/:sessionId`, auth, requireActiveSubscription, async (req, res, next) => {
      const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
      if (!sessionId.success) return validationError(req, res, 'Недопустимый идентификатор тренировки.');
      try {
        res.setHeader('Cache-Control', 'no-store');
        const session = await get(req.user, sessionId.data);
        if (!session) return res.status(404).json({ error: { code: 'SPEAKING_SESSION_NOT_FOUND', message: 'Тренировка не найдена.' } });
        return res.json(response(session));
      } catch (error) {
        if (catalogMismatchResponse(req, res, error)) return undefined;
        return next(error);
      }
    });
  }

  function registerSequentialCompletionRoute({
    path, positionSchema, bodySchema, complete, response, outOfSequenceCode,
    invalidPositionMessage, invalidBodyMessage, sequenceMessage,
  }) {
    router.post(path, auth, requireActiveSubscription, async (req, res, next) => {
      const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
      if (!sessionId.success) return validationError(req, res, 'Недопустимый идентификатор тренировки.');
      const positionNumber = positionSchema.safeParse(req.params.positionNumber);
      if (!positionNumber.success) return validationError(req, res, invalidPositionMessage);
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) return validationError(req, res, invalidBodyMessage);
      try {
        res.setHeader('Cache-Control', 'no-store');
        const session = await complete(
          req.user, sessionId.data, positionNumber.data, parsed.data, { now: now() },
        );
        if (!session) return res.status(404).json({ error: { code: 'SPEAKING_SESSION_NOT_FOUND', message: 'Тренировка не найдена.' } });
        return res.json(response(session));
      } catch (error) {
        if (catalogMismatchResponse(req, res, error)) return undefined;
        if (error?.code === outOfSequenceCode) {
          return res.status(409).json({ error: {
            code: error.code,
            message: sequenceMessage,
            requestId: req.requestId,
          } });
        }
        return next(error);
      }
    });
  }

  const task1Response = (session) => publicCatalogSession(session, {
    catalog: SPEAKING_TASK1_CATALOG,
    publicAssignment: speakingTask1PublicAssignment,
    publicSession: publicSpeakingTask1Session,
    mismatchCode: 'SPEAKING_TASK1_CATALOG_REVISION_MISMATCH',
  });
  const task2Response = (session) => publicCatalogSession(session, {
    catalog: SPEAKING_TASK2_CATALOG,
    publicAssignment: speakingTask2PublicAssignment,
    publicSession: publicSpeakingTask2Session,
    mismatchCode: 'SPEAKING_TASK2_CATALOG_REVISION_MISMATCH',
  });
  const task3Response = (session) => publicCatalogSession(session, {
    catalog: SPEAKING_TASK3_CATALOG,
    publicAssignment: speakingTask3PublicAssignment,
    publicSession: publicSpeakingTask3Session,
    mismatchCode: 'SPEAKING_TASK3_CATALOG_REVISION_MISMATCH',
  });

  registerAssignmentRoutes({
    basePath: '/api/v1/speaking/task-1/sessions',
    catalog: SPEAKING_TASK1_CATALOG,
    assign: (...args) => db.assignSpeakingTask1Session(...args),
    get: (...args) => db.getSpeakingTask1Session(...args),
    response: task1Response,
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
      return res.json(task1Response(session));
    } catch (error) {
      if (catalogMismatchResponse(req, res, error)) return undefined;
      return next(error);
    }
  });

  registerAssignmentRoutes({
    basePath: '/api/v1/speaking/task-2/sessions',
    catalog: SPEAKING_TASK2_CATALOG,
    assign: (...args) => db.assignSpeakingTask2Session(...args),
    get: (...args) => db.getSpeakingTask2Session(...args),
    response: task2Response,
  });

  registerSequentialCompletionRoute({
    path: '/api/v1/speaking/task-2/sessions/:sessionId/questions/:positionNumber/complete',
    positionSchema: questionNumberSchema,
    bodySchema: task2QuestionCompletionSchema,
    complete: (...args) => db.completeSpeakingTask2Question(...args),
    response: task2Response,
    outOfSequenceCode: 'SPEAKING_TASK2_QUESTION_OUT_OF_SEQUENCE',
    invalidPositionMessage: 'Номер вопроса должен быть от 1 до 4.',
    invalidBodyMessage: 'Недопустимые метаданные записи вопроса.',
    sequenceMessage: 'Записывай четыре вопроса по порядку.',
  });

  registerAssignmentRoutes({
    basePath: '/api/v1/speaking/task-3/sessions',
    catalog: SPEAKING_TASK3_CATALOG,
    assign: (...args) => db.assignSpeakingTask3Session(...args),
    get: (...args) => db.getSpeakingTask3Session(...args),
    response: task3Response,
  });

  registerSequentialCompletionRoute({
    path: '/api/v1/speaking/task-3/sessions/:sessionId/answers/:positionNumber/complete',
    positionSchema: interviewQuestionNumberSchema,
    bodySchema: task3AnswerCompletionSchema,
    complete: (...args) => db.completeSpeakingTask3Answer(...args),
    response: task3Response,
    outOfSequenceCode: 'SPEAKING_TASK3_ANSWER_OUT_OF_SEQUENCE',
    invalidPositionMessage: 'Номер вопроса должен быть от 1 до 5.',
    invalidBodyMessage: 'Недопустимые метаданные записи ответа.',
    sequenceMessage: 'Записывай пять ответов по порядку.',
  });

  return router;
}
