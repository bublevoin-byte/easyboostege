import express from 'express';
import { z } from 'zod';

import { SPEAKING_TASK1_CATALOG } from '../public/content/speaking/task1-v1.js';
import { SPEAKING_TASK2_CATALOG } from '../public/content/speaking/task2-v1.js';
import { SPEAKING_TASK3_CATALOG } from '../public/content/speaking/task3-v1.js';
import { SPEAKING_TASK4_CATALOG } from '../public/content/speaking/task4-v1.js';
import {
  speakingTask1PublicAssignment,
  speakingTask2PublicAssignment,
  speakingTask3PublicAssignment,
  speakingTask4PublicAssignment,
} from '../public/speaking-catalog-contract.js';
import { publicSpeakingTask1Session } from '../speaking/task1-session.js';
import { publicSpeakingTask2Session } from '../speaking/task2-session.js';
import { publicSpeakingTask3Session } from '../speaking/task3-session.js';
import { publicSpeakingTask4Session } from '../speaking/task4-session.js';
import { publicFullSpeakingSession } from '../speaking/full-section-session.js';
import { parsePcm16Mono16kWav } from '../speaking/wav-audio.js';

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
const task4CompletionSchema = z.object({
  recordingDurationSeconds: z.number().finite().min(1).max(180),
  micCheck: z.enum(['passed', 'quiet', 'skipped']),
  localPlayback: z.boolean(),
  selfRating: z.enum(['weak', 'steady', 'strong']),
}).strict();
const fullResponseSchema = z.object({
  taskType: z.number().int().min(1).max(4),
  responseNumber: z.number().int().min(1).max(5),
  responseStatus: z.enum(['completed', 'skipped', 'technical_issue']),
  recordingDurationSeconds: z.number().finite().min(0).max(180),
  micCheck: z.enum(['passed', 'quiet', 'skipped']),
  localPlayback: z.literal(false),
  technicalIssueCode: z.enum([
    'microphone_denied', 'no_audio_track', 'recording_failed',
    'silence', 'noise', 'clipping', 'other',
  ]).optional(),
}).strict().superRefine((value, context) => {
  if (value.responseStatus === 'completed' && value.recordingDurationSeconds < 1) {
    context.addIssue({ code: 'custom', message: 'A completed response needs a duration.' });
  }
  if (value.responseStatus !== 'completed' && value.recordingDurationSeconds !== 0) {
    context.addIssue({ code: 'custom', message: 'An absent response has zero duration.' });
  }
  if ((value.responseStatus === 'technical_issue') !== Boolean(value.technicalIssueCode)) {
    context.addIssue({ code: 'custom', message: 'Technical issue metadata is inconsistent.' });
  }
});
const fullSubmissionSchema = z.object({
  idempotencyKey: z.string().uuid().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  ),
}).strict();
const pronunciationIdempotencySchema = z.string().uuid().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
);
const pronunciationLocaleSchema = z.enum(['en-GB', 'en-US']);
const pronunciationDurationSchema = z.coerce.number().finite().min(1).max(180);
const pronunciationMimeTypes = Object.freeze(['audio/wav']);

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
    'SPEAKING_TASK4_CATALOG_REVISION_MISMATCH',
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

export function createSpeakingRoutes({
  authentication, access, db, pronunciationAssessment = null,
  pronunciationMaxAudioBytes = 10 * 1024 * 1024,
  pronunciationMaxAudioSeconds = 180,
  now = () => new Date(),
}) {
  const router = express.Router();
  const { auth } = authentication;
  const { requireActiveSubscription } = access;
  const pronunciationLimiter = typeof access.sttLimiter === 'function'
    ? access.sttLimiter
    : (_req, _res, next) => next();
  const requireVoiceProcessingConsent = typeof access.requirePrivacyConsent === 'function'
    ? access.requirePrivacyConsent('voice_processing')
    : (_req, _res, next) => next();
  const pronunciationAudioSecondsLimit = Number.isFinite(Number(pronunciationMaxAudioSeconds))
    ? Math.max(1, Math.min(90, Number(pronunciationMaxAudioSeconds))) : 90;
  const pronunciationAudio = express.raw({
    type: pronunciationMimeTypes,
    limit: pronunciationMaxAudioBytes,
  });
  const parsePronunciationAudio = (req, res, next) => pronunciationAudio(req, res, (error) => {
    if (!error) return next();
    if (error.type === 'entity.too.large') return res.status(413).json({ error: {
      code: 'SPEAKING_AUDIO_TOO_LARGE',
      message: 'Запись превышает допустимый размер.',
      requestId: req.requestId,
    } });
    return next(error);
  });

  function unavailableProviderStatus() {
    return { available: false, provider: 'azure-speech', reason: 'provider_not_configured' };
  }

  router.get('/api/v1/speaking/pronunciation-assessments/status', auth, requireActiveSubscription, async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (pronunciationAssessment) return res.json(await pronunciationAssessment.status(req.user));
      const quota = db.getSpeakingAssessmentQuota
        ? await db.getSpeakingAssessmentQuota(req.user, { now: now() })
        : { tier: 'base', periodStart: null, limitSeconds: 3_600, usedSeconds: 0, heldSeconds: 0, remainingSeconds: 3_600 };
      return res.json({ provider: unavailableProviderStatus(), quota });
    } catch (error) {
      return next(error);
    }
  });

  router.post(
    '/api/v1/speaking/task-1/sessions/:sessionId/pronunciation-assessment',
    auth,
    requireActiveSubscription,
    pronunciationLimiter,
    requireVoiceProcessingConsent,
    parsePronunciationAudio,
    async (req, res, next) => {
      const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
      const idempotencyKey = pronunciationIdempotencySchema.safeParse(req.get('idempotency-key'));
      const locale = pronunciationLocaleSchema.safeParse(req.get('x-speech-locale'));
      const duration = pronunciationDurationSchema.safeParse(req.get('x-audio-duration-seconds'));
      const mimeType = String(req.get('content-type') || '').split(';', 1)[0].toLowerCase();
      if (!sessionId.success) return validationError(req, res, 'Недопустимый идентификатор тренировки.');
      if (!idempotencyKey.success) return validationError(req, res, 'Недопустимый ключ идемпотентности оценки.');
      if (!locale.success) return validationError(req, res, 'Поддерживаются только en-GB и en-US.');
      if (!duration.success) return validationError(req, res, 'Длительность записи должна быть от 1 до 180 секунд.');
      if (!pronunciationMimeTypes.includes(mimeType)) {
        return res.status(415).json({ error: {
          code: 'SPEAKING_AUDIO_TYPE_UNSUPPORTED',
          message: 'Формат записи не поддерживается.',
          requestId: req.requestId,
        } });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return validationError(req, res, 'Запись отсутствует.');
      }
      const wav = parsePcm16Mono16kWav(req.body);
      if (!wav) return validationError(req, res, 'Нужен корректный mono PCM WAV: 16 kHz, 16-bit.');
      if (duration.data > pronunciationAudioSecondsLimit || wav.durationSeconds < 1
        || wav.durationSeconds > pronunciationAudioSecondsLimit
        || Math.abs(duration.data - wav.durationSeconds) > 1) {
        return validationError(
          req,
          res,
          `Длительность записи не совпадает с WAV или превышает лимит ${pronunciationAudioSecondsLimit} секунд.`,
        );
      }
      try {
        const session = await db.getSpeakingTask1Session(req.user, sessionId.data);
        if (!session) return res.status(404).json({ error: {
          code: 'SPEAKING_SESSION_NOT_FOUND', message: 'Тренировка не найдена.', requestId: req.requestId,
        } });
        const task = SPEAKING_TASK1_CATALOG.tasks.find((candidate) => (
          candidate.id === session.task_id && candidate.revision === Number(session.task_revision)
        ));
        if (!task || session.catalog_id !== SPEAKING_TASK1_CATALOG.id
          || Number(session.catalog_revision) !== SPEAKING_TASK1_CATALOG.revision) {
          throw Object.assign(new Error('SPEAKING_TASK1_CATALOG_REVISION_MISMATCH'), {
            code: 'SPEAKING_TASK1_CATALOG_REVISION_MISMATCH',
          });
        }
        if (!pronunciationAssessment) {
          return res.status(503).json({ error: {
            code: 'SPEAKING_PRONUNCIATION_UNAVAILABLE',
            message: 'Оценка произношения пока не подключена.',
            requestId: req.requestId,
          } });
        }
        const result = await pronunciationAssessment.assess(req.user, {
          idempotencyKey: idempotencyKey.data,
          audio: req.body,
          mimeType,
          durationSeconds: duration.data,
          locale: locale.data,
          mode: 'scripted',
          referenceText: task.reference.script,
          contextId: `task1:${session.id}:${task.id}@${task.revision}`,
        });
        res.setHeader('Cache-Control', 'no-store');
        if (result.assessment?.status === 'unavailable'
          && result.billing?.assessmentId == null) {
          return res.status(503).json({ error: {
            code: 'SPEAKING_PRONUNCIATION_UNAVAILABLE',
            message: 'Оценка произношения пока не подключена.',
            requestId: req.requestId,
          } });
        }
        return res.json(result);
      } catch (error) {
        if (catalogMismatchResponse(req, res, error)) return undefined;
        if (error?.code === 'SPEAKING_ASSESSMENT_QUOTA_EXHAUSTED') {
          return res.status(429).json({ error: {
            code: error.code,
            message: 'Месячный лимит автоматической оценки исчерпан. Локальная запись остаётся доступной.',
            requestId: req.requestId,
          } });
        }
        if (error?.code === 'SPEAKING_ASSESSMENT_IDEMPOTENCY_CONFLICT') {
          return res.status(409).json({ error: {
            code: error.code,
            message: 'Этот ключ уже использован для другой записи.',
            requestId: req.requestId,
          } });
        }
        if (String(error?.code || '').startsWith('SPEAKING_')) {
          return validationError(req, res, 'Запись не прошла проверку безопасного контура оценки.');
        }
        return next(error);
      }
    },
  );

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
  const task4Response = (session) => publicCatalogSession(session, {
    catalog: SPEAKING_TASK4_CATALOG,
    publicAssignment: speakingTask4PublicAssignment,
    publicSession: publicSpeakingTask4Session,
    mismatchCode: 'SPEAKING_TASK4_CATALOG_REVISION_MISMATCH',
  });
  const fullCatalogs = [
    SPEAKING_TASK1_CATALOG, SPEAKING_TASK2_CATALOG,
    SPEAKING_TASK3_CATALOG, SPEAKING_TASK4_CATALOG,
  ];
  const fullResponse = (session) => publicFullSpeakingSession(session, fullCatalogs);

  function fullSessionError(req, res, error) {
    if (error?.code === 'SPEAKING_FULL_CATALOG_REVISION_MISMATCH') {
      res.status(409).json({ error: {
        code: error.code,
        message: 'Версии полного варианта больше не совместимы. Начни новый вариант.',
        requestId: req.requestId,
      } });
      return true;
    }
    if (['SPEAKING_FULL_RESPONSE_INVALID', 'SPEAKING_FULL_SUBMISSION_INVALID'].includes(error?.code)) {
      res.status(400).json({ error: {
        code: error.code,
        message: 'Метаданные полного устного раздела не прошли проверку.',
        requestId: req.requestId,
      } });
      return true;
    }
    if (['SPEAKING_FULL_STAGE_INVALID', 'SPEAKING_FULL_RESPONSE_OUT_OF_SEQUENCE',
      'SPEAKING_FULL_NOT_READY_TO_SUBMIT'].includes(error?.code)) {
      res.status(409).json({ error: {
        code: error.code,
        message: 'Этапы полного устного раздела выполняются только в официальном порядке.',
        requestId: req.requestId,
      } });
      return true;
    }
    return false;
  }

  router.post('/api/v1/speaking/full-sessions', auth, requireActiveSubscription, async (req, res, next) => {
    const parsed = emptyBodySchema.safeParse(req.body || {});
    if (!parsed.success) return validationError(req, res, 'Полный вариант назначает сервер.');
    try {
      res.setHeader('Cache-Control', 'no-store');
      const session = await db.assignFullSpeakingSession(req.user, { catalogs: fullCatalogs, now: now() });
      return res.status(201).json(fullResponse(session));
    } catch (error) {
      if (fullSessionError(req, res, error)) return undefined;
      return next(error);
    }
  });

  router.get('/api/v1/speaking/full-sessions/:sessionId', auth, requireActiveSubscription, async (req, res, next) => {
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return validationError(req, res, 'Недопустимый идентификатор полного варианта.');
    try {
      res.setHeader('Cache-Control', 'no-store');
      const session = await db.getFullSpeakingSession(req.user, sessionId.data);
      if (!session) return res.status(404).json({ error: { code: 'SPEAKING_FULL_SESSION_NOT_FOUND', message: 'Полный вариант не найден.' } });
      return res.json(fullResponse(session));
    } catch (error) {
      if (fullSessionError(req, res, error)) return undefined;
      return next(error);
    }
  });

  router.post('/api/v1/speaking/full-sessions/:sessionId/stage', auth, requireActiveSubscription, async (req, res, next) => {
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return validationError(req, res, 'Недопустимый идентификатор полного варианта.');
    if (!emptyBodySchema.safeParse(req.body || {}).success) return validationError(req, res, 'Этап выбирает сервер.');
    try {
      res.setHeader('Cache-Control', 'no-store');
      const session = await db.advanceFullSpeakingSessionStage(req.user, sessionId.data, { now: now() });
      if (!session) return res.status(404).json({ error: { code: 'SPEAKING_FULL_SESSION_NOT_FOUND', message: 'Полный вариант не найден.' } });
      return res.json(fullResponse(session));
    } catch (error) {
      if (fullSessionError(req, res, error)) return undefined;
      return next(error);
    }
  });

  router.post('/api/v1/speaking/full-sessions/:sessionId/responses', auth, requireActiveSubscription, async (req, res, next) => {
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return validationError(req, res, 'Недопустимый идентификатор полного варианта.');
    const parsed = fullResponseSchema.safeParse(req.body);
    if (!parsed.success) return validationError(req, res, 'Недопустимые метаданные ответа.');
    try {
      res.setHeader('Cache-Control', 'no-store');
      const session = await db.completeFullSpeakingSessionResponse(
        req.user, sessionId.data, parsed.data, { now: now() },
      );
      if (!session) return res.status(404).json({ error: { code: 'SPEAKING_FULL_SESSION_NOT_FOUND', message: 'Полный вариант не найден.' } });
      return res.json(fullResponse(session));
    } catch (error) {
      if (fullSessionError(req, res, error)) return undefined;
      return next(error);
    }
  });

  router.post('/api/v1/speaking/full-sessions/:sessionId/submit', auth, requireActiveSubscription, async (req, res, next) => {
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return validationError(req, res, 'Недопустимый идентификатор полного варианта.');
    const parsed = fullSubmissionSchema.safeParse(req.body);
    if (!parsed.success) return validationError(req, res, 'Недопустимый ключ сдачи.');
    try {
      res.setHeader('Cache-Control', 'no-store');
      const submitted = await db.submitFullSpeakingSessionResult(
        req.user, sessionId.data, parsed.data.idempotencyKey, { now: now() },
      );
      if (!submitted) return res.status(404).json({ error: { code: 'SPEAKING_FULL_SESSION_NOT_FOUND', message: 'Полный вариант не найден.' } });
      return res.json(submitted.result);
    } catch (error) {
      if (fullSessionError(req, res, error)) return undefined;
      return next(error);
    }
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

  registerAssignmentRoutes({
    basePath: '/api/v1/speaking/task-4/sessions',
    catalog: SPEAKING_TASK4_CATALOG,
    assign: (...args) => db.assignSpeakingTask4Session(...args),
    get: (...args) => db.getSpeakingTask4Session(...args),
    response: task4Response,
  });

  router.post('/api/v1/speaking/task-4/sessions/:sessionId/complete', auth, requireActiveSubscription, async (req, res, next) => {
    const sessionId = sessionIdSchema.safeParse(req.params.sessionId);
    if (!sessionId.success) return validationError(req, res, 'Invalid training session identifier.');
    const parsed = task4CompletionSchema.safeParse(req.body);
    if (!parsed.success) return validationError(req, res, 'Invalid task 4 practice metadata.');
    try {
      res.setHeader('Cache-Control', 'no-store');
      const session = await db.completeSpeakingTask4Session(
        req.user, sessionId.data, parsed.data, { now: now() },
      );
      if (!session) return res.status(404).json({ error: { code: 'SPEAKING_SESSION_NOT_FOUND', message: 'Training session not found.' } });
      return res.json(task4Response(session));
    } catch (error) {
      if (catalogMismatchResponse(req, res, error)) return undefined;
      return next(error);
    }
  });

  return router;
}
