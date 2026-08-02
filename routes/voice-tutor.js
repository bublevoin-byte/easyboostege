import crypto from 'node:crypto';
import express from 'express';
import { buildGrammarLexiconCapsule, createGrammarLexiconErrorAttempt, persistedVoiceTutorCapsule, publicVoiceTutorCapsule } from '../voice-tutor/capsule.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NONCE = /^[A-Za-z0-9_-]{16,200}$/u;
const EVENT_TYPES = new Set(['diagnosis_complete', 'explanation_complete', 'check_answer', 'transfer_answer']);

const PUBLIC_ERRORS = Object.freeze({
  VOICE_TUTOR_PREMIUM_REQUIRED: { status: 403, message: 'Голосовой разбор доступен в Premium.' },
  VOICE_TUTOR_SESSION_ACTIVE: { status: 409, message: 'Сначала завершите текущий голосовой разбор.' },
  VOICE_TUTOR_DAILY_QUOTA_EXHAUSTED: { status: 429, message: 'Голосовые минуты на сегодня закончились.' },
  VOICE_TUTOR_MONTHLY_QUOTA_EXHAUSTED: { status: 429, message: 'Голосовые минуты на этот месяц закончились.' },
  VOICE_TUTOR_SESSION_NOT_FOUND: { status: 404, message: 'Голосовой разбор не найден.' },
  VOICE_TUTOR_SESSION_EXPIRED: { status: 409, message: 'Время голосового разбора закончилось. Продолжите текстом.' },
  VOICE_TUTOR_ATTEMPT_NOT_FOUND: { status: 404, message: 'Исходная попытка не найдена.' },
  VOICE_TUTOR_ATTEMPT_NOT_SUPPORTED: { status: 422, message: 'Для этой попытки голосовой разбор пока недоступен.' },
  VOICE_TUTOR_ITEM_NOT_FOUND: { status: 422, message: 'Проверенное правило для этого задания не найдено.' },
  VOICE_TUTOR_REVISION_MISMATCH: { status: 409, message: 'Задание изменилось. Обновите результат и повторите.' },
  VOICE_TUTOR_LEARNER_ANSWER_INVALID: { status: 422, message: 'В попытке нет ответа для разбора.' },
  VOICE_TUTOR_ANSWER_NOT_INCORRECT: { status: 422, message: 'Этот ответ не является ошибкой для выбранной ревизии задания.' },
  VOICE_TUTOR_CAPSULE_TOO_LARGE: { status: 422, message: 'Контекст разбора превышает безопасный размер.' },
  VOICE_TUTOR_NONCE_REPLAYED: { status: 409, message: 'Команда этой сессии уже использована.' },
  VOICE_TUTOR_TRANSITION_INVALID: { status: 409, message: 'Этот шаг разбора сейчас недоступен.' },
  PRIVACY_CONSENT_REQUIRED: { status: 403, message: 'Подтвердите обработку голоса в настройках приватности.' },
});

function sendVoiceTutorError(error, res, next) {
  const known = PUBLIC_ERRORS[error?.code];
  if (!known) return next(error);
  return res.status(known.status).json({ error: { code: error.code, message: known.message } });
}

function nonceHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseTracerRequest(body) {
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const keys = Object.keys(value);
  if (keys.length === 0) return null;
  if (keys.length !== 2 || !keys.includes('attemptId') || !keys.includes('revision')) return false;
  if (!ATTEMPT_ID.test(String(value.attemptId || '')) || !Number.isInteger(value.revision) || value.revision < 1 || value.revision > 10_000) return false;
  return { attemptId: String(value.attemptId), revision: value.revision };
}

function parseErrorRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 5 || keys.some((key) => !['attemptId', 'module', 'itemId', 'revision', 'learnerAnswer'].includes(key))) return null;
  if (!ATTEMPT_ID.test(String(body.attemptId || '')) || !['grammar', 'vocabulary'].includes(body.module)
    || !/^[a-z0-9.-]{4,120}$/u.test(String(body.itemId || '')) || !Number.isInteger(body.revision)
    || typeof body.learnerAnswer !== 'string' || body.learnerAnswer.length > 200) return null;
  return body;
}

function parsePedagogicalEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['nonce', 'event'].includes(key))) return null;
  if (!NONCE.test(String(body.nonce || '')) || !body.event || typeof body.event !== 'object' || Array.isArray(body.event)) return null;
  const type = String(body.event.type || '');
  if (!EVENT_TYPES.has(type)) return null;
  const keys = Object.keys(body.event);
  const needsAnswer = type === 'check_answer' || type === 'transfer_answer';
  if (keys.some((key) => !['type', 'answer'].includes(key)) || (needsAnswer !== keys.includes('answer'))) return null;
  if (needsAnswer && (typeof body.event.answer !== 'string' || body.event.answer.length > 200)) return null;
  return { nonce: String(body.nonce), event: { type, ...(needsAnswer ? { answer: body.event.answer } : {}) } };
}

function tracerResponse(result, capsule, extra = {}) {
  return {
    created: result.created,
    session: result.session,
    capsule: publicVoiceTutorCapsule(capsule),
    entitlements: result.entitlements,
    voice_tutor: result.voice_tutor,
    ...extra,
  };
}

async function rebuildSourceCapsule(db, username, storedCapsule) {
  const attemptId = storedCapsule?.source?.attempt_id;
  const revision = Number(storedCapsule?.source?.item_revision);
  const attempt = attemptId ? await db.getModuleAttempt(username, attemptId) : null;
  if (!attempt) throw Object.assign(new Error('VOICE_TUTOR_ATTEMPT_NOT_FOUND'), { code: 'VOICE_TUTOR_ATTEMPT_NOT_FOUND' });
  const capsule = buildGrammarLexiconCapsule({ attempt, expectedRevision: revision });
  if (capsule.id !== storedCapsule.id || capsule.version !== storedCapsule.version) {
    throw Object.assign(new Error('VOICE_TUTOR_REVISION_MISMATCH'), { code: 'VOICE_TUTOR_REVISION_MISMATCH' });
  }
  return capsule;
}

async function hasCurrentTextConsent(db, username, privacyPolicyVersion) {
  const consent = await db.getPrivacyConsent(username);
  return Boolean(consent?.text_processing)
    && (!privacyPolicyVersion || consent.policy_version === privacyPolicyVersion);
}

export function createVoiceTutorRoutes({
  authentication,
  db,
  limits,
  now = () => new Date(),
  newSessionId = () => crypto.randomUUID(),
  newNonce = () => crypto.randomBytes(24).toString('base64url'),
  credentialProvider = null,
  textTutor = null,
  privacyPolicyVersion = '',
}) {
  const router = express.Router();
  const { auth } = authentication;

  router.post('/api/v1/voice-tutor/errors', auth, async (req, res, next) => {
    const parsed = parseErrorRequest(req.body);
    if (!parsed) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные исходной ошибки.' } });
    try {
      const access = await db.getVoiceTutorAccess(req.user, limits, now());
      if (!access.entitlements.voice_tutor) return sendVoiceTutorError({ code: 'VOICE_TUTOR_PREMIUM_REQUIRED' }, res, next);
      const attempt = createGrammarLexiconErrorAttempt({
        id: parsed.attemptId,
        module: parsed.module,
        itemId: parsed.itemId,
        revision: parsed.revision,
        learnerAnswer: parsed.learnerAnswer,
      });
      const result = await db.recordModuleAttempt(req.user, attempt);
      return res.status(result.created ? 201 : 200).json({ ...result, revision: parsed.revision });
    } catch (error) {
      return sendVoiceTutorError(error, res, next);
    }
  });

  router.post('/api/v1/voice-tutor/sessions', auth, async (req, res, next) => {
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Передайте корректный Idempotency-Key.' } });
    }
    try {
      const tracer = parseTracerRequest(req.body);
      if (tracer === false) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Передайте только attemptId и revision.' } });
      }
      if (tracer) {
        const consent = await db.getPrivacyConsent(req.user);
        if (!consent?.voice_processing || (privacyPolicyVersion && consent.policy_version !== privacyPolicyVersion)) {
          return sendVoiceTutorError({ code: 'PRIVACY_CONSENT_REQUIRED' }, res, next);
        }
        const attempt = await db.getModuleAttempt(req.user, tracer.attemptId);
        if (!attempt) return sendVoiceTutorError({ code: 'VOICE_TUTOR_ATTEMPT_NOT_FOUND' }, res, next);
        const capsule = buildGrammarLexiconCapsule({ attempt, expectedRevision: tracer.revision });
        const nonce = newNonce();
        const result = await db.reserveVoiceTutorSession(req.user, {
          id: newSessionId(),
          idempotencyKey,
          limits,
          now: now(),
          context: { capsule: persistedVoiceTutorCapsule(capsule), nonceHash: nonceHash(nonce) },
        });
        if (!result.created) {
          const existing = await db.getVoiceTutorSession(req.user, result.session.id);
          if (!existing?.capsule || existing.capsule.id !== capsule.id) {
            return res.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency-Key уже связан с другим разбором.' } });
          }
          return res.json(tracerResponse(result, existing.capsule, { mode: existing.delivery_mode || 'voice' }));
        }
        if (!credentialProvider) {
          const released = await db.finishVoiceTutorSession(req.user, result.session.id, { limits, now: now(), confirmedBillableSeconds: 0, preservePedagogicalState: true });
          const delivered = await db.setVoiceTutorSessionDelivery(req.user, result.session.id, { mode: 'local', errorCode: 'VOICE_TUTOR_PROVIDER_NOT_CONFIGURED' });
          return res.status(201).json(tracerResponse({ ...released, created: true, session: delivered.session }, capsule, { mode: 'local', nonce, local_rule: capsule.rule }));
        }
        try {
          const realtime = await credentialProvider.createCredential({ sessionId: result.session.id, capsule });
          return res.status(201).json(tracerResponse(result, capsule, { mode: 'voice', nonce, realtime }));
        } catch (providerError) {
          const released = await db.finishVoiceTutorSession(req.user, result.session.id, { limits, now: now(), confirmedBillableSeconds: 0, preservePedagogicalState: true });
          if (textTutor && await hasCurrentTextConsent(db, req.user, privacyPolicyVersion)) {
            try {
              const textTurn = await textTutor.createTurn({ capsule, state: result.session.state, username: req.user });
              const delivered = await db.setVoiceTutorSessionDelivery(req.user, result.session.id, { mode: 'text', errorCode: providerError?.code || 'VOICE_TUTOR_PROVIDER_UNAVAILABLE' });
              return res.status(201).json(tracerResponse({ ...released, created: true, session: delivered.session }, capsule, { mode: 'text', nonce, text_turn: textTurn }));
            } catch {}
          }
          const delivered = await db.setVoiceTutorSessionDelivery(req.user, result.session.id, { mode: 'local', errorCode: providerError?.code || 'VOICE_TUTOR_PROVIDER_UNAVAILABLE' });
          return res.status(201).json(tracerResponse({ ...released, created: true, session: delivered.session }, capsule, { mode: 'local', nonce, local_rule: capsule.rule }));
        }
      }
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

  router.post('/api/v1/voice-tutor/sessions/:sessionId/events', auth, async (req, res, next) => {
    if (!SESSION_ID.test(req.params.sessionId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный идентификатор голосового разбора.' } });
    }
    const parsed = parsePedagogicalEvent(req.body);
    if (!parsed) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректное событие голосового разбора.' } });
    const nonce = newNonce();
    try {
      const result = await db.advanceVoiceTutorSession(req.user, req.params.sessionId, {
        nonceHash: nonceHash(parsed.nonce),
        nextNonceHash: nonceHash(nonce),
        event: parsed.event,
        now: now(),
      });
      const stored = await db.getVoiceTutorSession(req.user, req.params.sessionId);
      if (stored?.delivery_mode === 'text') {
        const capsule = await rebuildSourceCapsule(db, req.user, result.capsule);
        if (textTutor && await hasCurrentTextConsent(db, req.user, privacyPolicyVersion)) {
          try {
            const textTurn = await textTutor.createTurn({ capsule, state: result.session.state, username: req.user });
            return res.json(tracerResponse({ ...result, created: false }, capsule, { mode: 'text', nonce, text_turn: textTurn }));
          } catch (textError) {
            const delivered = await db.setVoiceTutorSessionDelivery(req.user, req.params.sessionId, {
              mode: 'local', errorCode: textError?.code || 'VOICE_TUTOR_TEXT_UNAVAILABLE',
            });
            return res.json(tracerResponse({ ...result, session: delivered.session, created: false }, capsule, {
              mode: 'local', nonce, local_rule: capsule.rule,
            }));
          }
        }
        const delivered = await db.setVoiceTutorSessionDelivery(req.user, req.params.sessionId, {
          mode: 'local', errorCode: 'VOICE_TUTOR_TEXT_UNAVAILABLE',
        });
        return res.json(tracerResponse({ ...result, session: delivered.session, created: false }, capsule, {
          mode: 'local', nonce, local_rule: capsule.rule,
        }));
      }
      if (stored?.delivery_mode === 'local') {
        return res.json(tracerResponse({ ...result, created: false }, result.capsule, {
          mode: 'local', nonce, local_rule: result.capsule.rule,
        }));
      }
      return res.json(tracerResponse({ ...result, created: false }, result.capsule, { mode: 'voice', nonce }));
    } catch (error) {
      return sendVoiceTutorError(error, res, next);
    }
  });

  router.post('/api/v1/voice-tutor/sessions/:sessionId/fallback', auth, async (req, res, next) => {
    if (!SESSION_ID.test(req.params.sessionId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный идентификатор голосового разбора.' } });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !NONCE.test(String(req.body.nonce || ''))) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Передайте одноразовый nonce голосового разбора.' } });
    }
    const nonce = newNonce();
    try {
      const switched = await db.switchVoiceTutorSessionDelivery(req.user, req.params.sessionId, {
        nonceHash: nonceHash(String(req.body.nonce)),
        nextNonceHash: nonceHash(nonce),
        mode: 'text',
        limits,
        now: now(),
        errorCode: 'VOICE_TUTOR_MICROPHONE_UNAVAILABLE',
      });
      if (textTutor && await hasCurrentTextConsent(db, req.user, privacyPolicyVersion)) {
        try {
          const textTurn = await textTutor.createTurn({ capsule: switched.capsule, state: switched.session.state, username: req.user });
          return res.json(tracerResponse({ ...switched, created: false }, switched.capsule, { mode: 'text', nonce, text_turn: textTurn }));
        } catch {}
      }
      await db.setVoiceTutorSessionDelivery(req.user, req.params.sessionId, { mode: 'local', errorCode: 'VOICE_TUTOR_TEXT_UNAVAILABLE' });
      return res.json(tracerResponse({ ...switched, created: false }, switched.capsule, { mode: 'local', nonce, local_rule: switched.capsule.rule }));
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
