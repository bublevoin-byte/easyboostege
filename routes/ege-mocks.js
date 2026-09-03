import crypto from 'node:crypto';
import express from 'express';

import { EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION, getEgeMockPublicForm } from '../ege-mock/catalog.js';
import { egeMockPublicFormWithPolicy } from '../ege-mock/policy.js';
import { bindResponseOwner, requireExpectedOwner } from '../middleware/expected-owner.js';
import {
  egeMockAssessmentRunSchema,
  egeMockAttemptIdSchema,
  egeMockDraftSchema,
  egeMockIdempotencyKeySchema,
  egeMockMutationSchema,
  egeMockOralStageSchema,
  egeMockOralSubmitSchema,
  egeMockRetrySchema,
  egeMockStartSchema,
} from '../validation/ege-mock.js';

function requestHash(operation, attemptId, body) {
  return crypto.createHash('sha256').update(JSON.stringify({ operation, attemptId, body })).digest('hex');
}

function validationError(res) {
  return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный запрос пробного ЕГЭ.' } });
}

function mutationInput(req, schema) {
  const body = schema.safeParse(req.body);
  const key = egeMockIdempotencyKeySchema.safeParse(req.get('idempotency-key'));
  return body.success && key.success ? { body: body.data, idempotencyKey: key.data } : null;
}

function sendAttemptError(error, res, next) {
  const code = error?.code || error?.message;
  if (code === 'SUBSCRIPTION_REQUIRED') {
    return res.status(403).json({ error: { code, message: 'Для этой функции требуется активный доступ.' } });
  }
  if (code === 'EGE_MOCK_ATTEMPT_NOT_FOUND') {
    return res.status(404).json({ error: { code, message: 'Попытка не найдена.' } });
  }
  if (code === 'EGE_MOCK_DRAFT_INVALID' || code === 'EGE_MOCK_ORAL_PAYLOAD_INVALID'
    || code === 'EGE_MOCK_TIME_INVALID') return validationError(res);
  if (typeof code === 'string' && (code.startsWith('EGE_MOCK_')
    || code === 'OWNER_CHANGED' || code === 'ASSESSMENT_REVISION_EXHAUSTED')) {
    return res.status(409).json({ error: { code, message: 'Состояние попытки изменилось.' } });
  }
  return next(error);
}

export function createEgeMockRoutes({
  authentication, access, db, writingAssessment = null, logger = null, now = null,
}) {
  const router = express.Router();
  const { auth } = authentication;
  const { requireActiveSubscription } = access;
  const repositoryOptions = typeof now === 'function' ? { now } : undefined;
  const applicationNow = typeof now === 'function' ? now : () => new Date();

  function ownerBoundary(req, res, next) {
    if (!requireExpectedOwner(req, res)) return undefined;
    bindResponseOwner(res, req.user);
    return next();
  }

  async function dispatchPendingWriting(username, attempt, requestId = null) {
    if (!writingAssessment || !attempt?.id
      || !['pending', 'in_progress'].includes(attempt.writingAssessment?.status)) return attempt;
    try {
      await writingAssessment.dispatch(username, attempt.id);
      return await db.getEgeMockAttempt(username, attempt.id, repositoryOptions);
    } catch (error) {
      const code = error?.code || error?.message;
      const expected = typeof code === 'string'
        && (code.startsWith('EGE_MOCK_') || ['OWNER_CHANGED', 'SUBSCRIPTION_REQUIRED'].includes(code));
      if (!expected && typeof logger?.error === 'function') {
        logger.error({
          timestamp: new Date(applicationNow()).toISOString(),
          level: 'error',
          type: 'ege_mock_writing_dispatch_failed',
          requestId: typeof requestId === 'string' && requestId.length <= 120 ? requestId : 'unavailable',
          attemptId: /^[0-9a-f-]{36}$/iu.test(attempt.id) ? attempt.id : 'unavailable',
          errorCode: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
            ? code : 'INTERNAL_ERROR',
        });
      }
      try {
        return await db.getEgeMockAttempt(username, attempt.id, repositoryOptions);
      } catch (_) {}
      return attempt;
    }
  }

  async function syncReconciledSpeaking(username, attempt) {
    if (!attempt?.oralSubmittedAt || !['assessment_pending', 'completed'].includes(attempt.state)
      || typeof db.syncEgeMockSpeakingBridge !== 'function') return attempt;
    await db.syncEgeMockSpeakingBridge(username, attempt.id, repositoryOptions);
    return attempt;
  }

  router.get('/api/v1/ege-mocks/forms', auth, ownerBoundary, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    bindResponseOwner(res, req.user);
    return res.json({
      forms: [egeMockPublicFormWithPolicy(
        getEgeMockPublicForm(EGE_MOCK_FORM_ID, EGE_MOCK_FORM_REVISION),
      )],
    });
  });

  router.post('/api/v1/ege-mocks/attempts', auth, ownerBoundary, requireActiveSubscription,
    async (req, res, next) => {
      const input = mutationInput(req, egeMockStartSchema);
      if (!input) return validationError(res);
      try {
        const result = await db.startEgeMockAttempt(req.user, {
          ...input.body,
          idempotencyKey: input.idempotencyKey,
          requestHash: requestHash('start', null, input.body),
        }, repositoryOptions);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(result.created ? 201 : 200).json(result);
      } catch (error) { return sendAttemptError(error, res, next); }
    });

  router.get('/api/v1/ege-mocks/attempts/current', auth, ownerBoundary, async (req, res, next) => {
    try {
      bindResponseOwner(res, req.user);
      res.setHeader('Cache-Control', 'no-store');
      const attempt = await syncReconciledSpeaking(
        req.user, await db.getCurrentEgeMockAttempt(req.user, repositoryOptions),
      );
      return res.json({ attempt });
    } catch (error) { return sendAttemptError(error, res, next); }
  });

  router.get('/api/v1/ege-mocks/attempts/history', auth, ownerBoundary, async (req, res, next) => {
    const includeAttemptId = req.query.attemptId;
    if (includeAttemptId != null
      && (typeof includeAttemptId !== 'string'
        || !egeMockAttemptIdSchema.safeParse(includeAttemptId).success)) return validationError(res);
    try {
      bindResponseOwner(res, req.user);
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await db.getEgeMockHistory(req.user, {
        ...repositoryOptions,
        ...(includeAttemptId ? { includeAttemptId } : {}),
      }));
    } catch (error) { return sendAttemptError(error, res, next); }
  });

  router.get('/api/v1/ege-mocks/attempts/:attemptId', auth, ownerBoundary, async (req, res, next) => {
    if (!egeMockAttemptIdSchema.safeParse(req.params.attemptId).success) return validationError(res);
    try {
      const attempt = await syncReconciledSpeaking(
        req.user, await db.getEgeMockAttempt(req.user, req.params.attemptId, repositoryOptions),
      );
      if (!attempt) return res.status(404).json({ error: { code: 'EGE_MOCK_ATTEMPT_NOT_FOUND', message: 'Попытка не найдена.' } });
      bindResponseOwner(res, req.user);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ attempt });
    } catch (error) { return sendAttemptError(error, res, next); }
  });

  function mutationRoute(path, method, operation, schema, repositoryMethod, {
    dispatchWriting = false, syncSpeaking = false,
  } = {}) {
    router[method](path, auth, ownerBoundary, requireActiveSubscription, async (req, res, next) => {
      if (!egeMockAttemptIdSchema.safeParse(req.params.attemptId).success) return validationError(res);
      const input = mutationInput(req, schema);
      if (!input) return validationError(res);
      try {
        let result = await db[repositoryMethod](req.user, req.params.attemptId, {
          ...input.body,
          idempotencyKey: input.idempotencyKey,
          requestHash: requestHash(operation, req.params.attemptId, input.body),
        }, repositoryOptions);
        if (dispatchWriting && result?.attempt) {
          result = {
            ...result,
            attempt: await dispatchPendingWriting(req.user, result.attempt, req.requestId),
          };
        }
        if (syncSpeaking && result?.attempt && typeof db.syncEgeMockSpeakingBridge === 'function') {
          await db.syncEgeMockSpeakingBridge(req.user, req.params.attemptId, repositoryOptions);
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.json(result);
      } catch (error) { return sendAttemptError(error, res, next); }
    });
  }

  mutationRoute('/api/v1/ege-mocks/attempts/:attemptId/draft', 'put', 'draft', egeMockDraftSchema, 'saveEgeMockDraft');
  mutationRoute('/api/v1/ege-mocks/attempts/:attemptId/written/submit', 'post', 'written_submit', egeMockMutationSchema, 'submitEgeMockWritten');
  mutationRoute('/api/v1/ege-mocks/attempts/:attemptId/oral/start', 'post', 'oral_start', egeMockMutationSchema, 'startEgeMockOral', { syncSpeaking: true });
  mutationRoute('/api/v1/ege-mocks/attempts/:attemptId/oral/stage', 'post', 'oral_stage', egeMockOralStageSchema, 'advanceEgeMockOralStage', { syncSpeaking: true });
  mutationRoute('/api/v1/ege-mocks/attempts/:attemptId/oral/submit', 'post', 'oral_submit', egeMockOralSubmitSchema, 'submitEgeMockOral', { syncSpeaking: true });
  mutationRoute('/api/v1/ege-mocks/attempts/:attemptId/assessment/retry', 'post', 'assessment_retry', egeMockRetrySchema, 'retryEgeMockAssessment', { dispatchWriting: true });

  // Assessment execution is an explicit unsafe operation. Safe restore/result GETs never call
  // this seam; the browser durably replays this owner-bound POST after written submission.
  router.post('/api/v1/ege-mocks/attempts/:attemptId/assessment/run', auth, ownerBoundary,
    async (req, res, next) => {
      if (!egeMockAttemptIdSchema.safeParse(req.params.attemptId).success) return validationError(res);
      const input = mutationInput(req, egeMockAssessmentRunSchema);
      if (!input) return validationError(res);
      try {
        const candidate = {
          idempotencyKey: input.idempotencyKey,
          requestHash: requestHash('assessment_run', req.params.attemptId, input.body),
          explicitRenewal: input.body.explicitRenewal === true,
        };
        const command = await db.beginEgeMockAssessmentRun(
          req.user, req.params.attemptId, candidate, repositoryOptions,
        );
        if (command.finalized) {
          res.setHeader('Cache-Control', 'no-store');
          return res.json(command.response);
        }
        const attempt = await db.getEgeMockAttempt(req.user, req.params.attemptId, repositoryOptions);
        if (!attempt) return res.status(404).json({ error: { code: 'EGE_MOCK_ATTEMPT_NOT_FOUND', message: 'Попытка не найдена.' } });
        await dispatchPendingWriting(req.user, attempt, req.requestId);
        const result = await db.settleEgeMockAssessmentRun(
          req.user, req.params.attemptId, candidate, repositoryOptions,
        );
        res.setHeader('Cache-Control', 'no-store');
        return res.json(result);
      } catch (error) {
        if (process.env.NODE_ENV === 'test') console.error(error?.stack || error);
        return sendAttemptError(error, res, next);
      }
    });

  router.get('/api/v1/ege-mocks/attempts/:attemptId/result', auth, ownerBoundary,
    async (req, res, next) => {
      if (!egeMockAttemptIdSchema.safeParse(req.params.attemptId).success) return validationError(res);
      try {
        const attempt = await db.getEgeMockAttempt(req.user, req.params.attemptId, repositoryOptions);
        if (!attempt) return res.status(404).json({ error: { code: 'EGE_MOCK_ATTEMPT_NOT_FOUND', message: 'Попытка не найдена.' } });
        const result = await db.getEgeMockResult(req.user, req.params.attemptId, repositoryOptions);
        if (!result) return res.status(404).json({ error: { code: 'EGE_MOCK_ATTEMPT_NOT_FOUND', message: 'Попытка не найдена.' } });
        bindResponseOwner(res, req.user);
        res.setHeader('Cache-Control', 'no-store');
        return res.json(result);
      } catch (error) { return sendAttemptError(error, res, next); }
    });

  return router;
}
