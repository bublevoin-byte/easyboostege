import crypto from 'node:crypto';
import express from 'express';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const PUBLIC_ERRORS = Object.freeze({
  VOICE_TUTOR_PREMIUM_REQUIRED: { status: 403, message: 'Голосовой разбор доступен в Premium.' },
  VOICE_TUTOR_SESSION_ACTIVE: { status: 409, message: 'Сначала завершите текущий голосовой разбор.' },
  VOICE_TUTOR_DAILY_QUOTA_EXHAUSTED: { status: 429, message: 'Голосовые минуты на сегодня закончились.' },
  VOICE_TUTOR_MONTHLY_QUOTA_EXHAUSTED: { status: 429, message: 'Голосовые минуты на этот месяц закончились.' },
  VOICE_TUTOR_SESSION_NOT_FOUND: { status: 404, message: 'Голосовой разбор не найден.' },
});

function sendVoiceTutorError(error, res, next) {
  const known = PUBLIC_ERRORS[error?.code];
  if (!known) return next(error);
  return res.status(known.status).json({ error: { code: error.code, message: known.message } });
}

export function createVoiceTutorRoutes({ authentication, db, limits, now = () => new Date(), newSessionId = () => crypto.randomUUID() }) {
  const router = express.Router();
  const { auth } = authentication;

  router.post('/api/v1/voice-tutor/sessions', auth, async (req, res, next) => {
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Передайте корректный Idempotency-Key.' } });
    }
    try {
      const result = await db.reserveVoiceTutorSession(req.user, {
        id: newSessionId(),
        idempotencyKey,
        limits,
        now: now(),
      });
      return res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      return sendVoiceTutorError(error, res, next);
    }
  });

  router.post('/api/v1/voice-tutor/sessions/:sessionId/finish', auth, async (req, res, next) => {
    if (!SESSION_ID.test(req.params.sessionId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный идентификатор голосового разбора.' } });
    }
    try {
      return res.json(await db.finishVoiceTutorSession(req.user, req.params.sessionId, { limits, now: now() }));
    } catch (error) {
      return sendVoiceTutorError(error, res, next);
    }
  });

  return router;
}
