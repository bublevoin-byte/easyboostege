import crypto from 'node:crypto';
import express from 'express';
import { parseContentResponse } from '../ai/content.js';
import { buildVoiceTutorCapsule, buildWritingSpeakingCapsule, createGrammarLexiconErrorAttempt, createVoiceTutorContextResult, persistedVoiceTutorCapsule, publicVoiceTutorCapsule } from '../voice-tutor/capsule.js';
import { buildGeneratedVoiceTutorDefinitions, parseGeneratedVoiceTutorSetId } from '../voice-tutor/generated-items.js';
import { isContextVoiceTutorModule, isDirectVoiceTutorModule } from '../voice-tutor/modules.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NONCE = /^[A-Za-z0-9_-]{16,200}$/u;
const EVENT_TYPES = new Set(['diagnosis_complete', 'explanation_complete', 'check_answer', 'transfer_answer']);
const RULE_CARD_ID = SESSION_ID;
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{2,119}$/u;

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
  VOICE_TUTOR_CONTEXT_INVALID: { status: 422, message: 'Проверенный фрагмент для разбора недоступен.' },
  VOICE_TUTOR_CONTEXT_RESULT_INVALID: { status: 422, message: 'Завершённый результат не соответствует проверенному заданию.' },
  VOICE_TUTOR_CONTEXT_RESULT_CONFLICT: { status: 409, message: 'Этот результат уже сохранён с другими ответами.' },
  VOICE_TUTOR_REVIEW_INVALID: { status: 422, message: 'Сохранённый разбор не прошёл проверку и не может использоваться голосовым репетитором.' },
  VOICE_TUTOR_CRITERION_NOT_FOUND: { status: 422, message: 'Выбранный критерий не содержит потери баллов в этом разборе.' },
  VOICE_TUTOR_NONCE_REPLAYED: { status: 409, message: 'Команда этой сессии уже использована.' },
  VOICE_TUTOR_TRANSITION_INVALID: { status: 409, message: 'Этот шаг разбора сейчас недоступен.' },
  PRIVACY_CONSENT_REQUIRED: { status: 403, message: 'Подтвердите обработку голоса в настройках приватности.' },
  TRUSTED_RULE_DISCOVERY_UNAVAILABLE: { status: 503, message: 'Поиск доверенного правила временно недоступен.' },
  TRUSTED_RULE_REQUEST_INVALID: { status: 400, message: 'Некорректный запрос правила.' },
  TRUSTED_RULE_INSUFFICIENT_SOURCES: { status: 422, message: 'Недостаточно независимых доверенных источников.' },
  TRUSTED_RULE_SOURCE_CONFLICT: { status: 422, message: 'Доверенные источники противоречат друг другу.' },
  TRUSTED_RULE_SOURCE_BLOCKED: { status: 422, message: 'Источник не входит в белый список.' },
  TRUSTED_RULE_FETCH_FAILED: { status: 503, message: 'Не удалось безопасно получить доверенные источники.' },
  TRUSTED_RULE_RESPONSE_BLOCKED: { status: 422, message: 'Источник вернул неподдерживаемый материал.' },
  TRUSTED_RULE_RESPONSE_TOO_LARGE: { status: 422, message: 'Материал источника превышает безопасный размер.' },
  TRUSTED_RULE_EVIDENCE_INVALID: { status: 422, message: 'Материал источника не удалось подтвердить.' },
  TRUSTED_RULE_DISCOVERY_NOT_REQUIRED: { status: 409, message: 'Для текущего разбора уже есть проверенное правило.' },
  RULE_CARD_CANONICAL_EXISTS: { status: 409, message: 'Для этого навыка уже одобрено каноническое правило.' },
  RULE_CARD_NOT_FOUND: { status: 404, message: 'Карточка правила не найдена.' },
  RULE_CARD_REVIEW_CONFLICT: { status: 409, message: 'Карточка уже получила другое решение.' },
  VOICE_TUTOR_REPEAT_NOT_FOUND: { status: 404, message: 'Повтор навыка не найден.' },
  VOICE_TUTOR_REPEAT_NOT_DUE: { status: 409, message: 'Повтор навыка ещё не доступен.' },
  VOICE_TUTOR_REPEAT_EXPIRED: { status: 409, message: 'Этот повтор заменён более новым разбором.' },
  VOICE_TUTOR_REPEAT_OUT_OF_ORDER: { status: 409, message: 'Сначала пройдите повтор через один день.' },
  VOICE_TUTOR_REPEAT_TASK_MISMATCH: { status: 422, message: 'Задание повтора не соответствует серверной карте.' },
  VOICE_TUTOR_REPEAT_ALREADY_ATTEMPTED: { status: 409, message: 'Для этого повтора уже сохранена проверенная попытка.' },
  VOICE_TUTOR_REPEAT_ATTEMPT_CONFLICT: { status: 409, message: 'Идентификатор попытки уже использован.' },
  VOICE_TUTOR_REPEAT_ANSWER_INVALID: { status: 422, message: 'Ответ повтора некорректен.' },
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
  if (keys.length === 4 && keys.every((key) => ['source', 'attemptId', 'revision', 'criterionIndex'].includes(key))) {
    const source = value.source;
    const attemptId = value.attemptId;
    if (!['writing', 'speaking'].includes(source) || !Number.isSafeInteger(attemptId) || attemptId < 1
      || !Number.isInteger(value.revision) || value.revision < 1 || value.revision > 10_000
      || !Number.isInteger(value.criterionIndex) || value.criterionIndex < 0 || value.criterionIndex > 20) return false;
    return { source, attemptId, revision: value.revision, criterionIndex: value.criterionIndex };
  }
  if (keys.length !== 2 || !keys.includes('attemptId') || !keys.includes('revision')) return false;
  if (!ATTEMPT_ID.test(String(value.attemptId || '')) || !Number.isInteger(value.revision) || value.revision < 1 || value.revision > 10_000) return false;
  return { attemptId: String(value.attemptId), revision: value.revision };
}

function parseErrorRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 5 || keys.some((key) => !['attemptId', 'module', 'itemId', 'revision', 'learnerAnswer'].includes(key))) return null;
  if (!ATTEMPT_ID.test(String(body.attemptId || '')) || !isDirectVoiceTutorModule(body.module)
    || !/^[a-z0-9.-]{4,120}$/u.test(String(body.itemId || '')) || !Number.isInteger(body.revision)
    || typeof body.learnerAnswer !== 'string' || body.learnerAnswer.length > 200) return null;
  return body;
}

function parseContextAttemptRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 5 || keys.some((key) => !['attemptId', 'module', 'setId', 'revision', 'answers'].includes(key))) return null;
  if (!ATTEMPT_ID.test(String(body.attemptId || '')) || !isContextVoiceTutorModule(body.module)
    || !/^[a-z0-9.-]{4,120}$/u.test(String(body.setId || '')) || !Number.isInteger(body.revision)
    || !Array.isArray(body.answers) || body.answers.length < 1 || body.answers.length > 20
    || body.answers.some((answer) => typeof answer !== 'string' || answer.length < 1 || answer.length > 200)) return null;
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

function parseRuleDiscovery(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
    || !SESSION_ID.test(String(body.session_id || ''))) return null;
  return { sessionId: String(body.session_id) };
}

function parseRepeatAttempt(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 3
    || Object.keys(body).some((key) => !['attemptId', 'taskId', 'answer'].includes(key))) return null;
  if (!ATTEMPT_ID.test(String(body.attemptId || ''))
    || !/^[a-z0-9][a-z0-9._:-]{3,179}$/u.test(String(body.taskId || ''))
    || typeof body.answer !== 'string' || body.answer.length < 1 || body.answer.length > 200) return null;
  return { attemptId: String(body.attemptId), taskId: String(body.taskId), answer: body.answer };
}

function publicRuleCard(card) {
  return {
    id: card.id,
    status: card.status,
    skill: card.skill,
    exam_year: card.exam_year,
    rule: card.rule,
    sources: (card.sources || []).map((source) => source.url),
    reviewed_at: card.reviewed_at,
  };
}

function adminRuleCard(card) {
  const { created_for_username: creator, ...safe } = card;
  return safe;
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

async function generatedDefinitionsFor(db, username, setId, module) {
  const generated = parseGeneratedVoiceTutorSetId(setId, module);
  if (!generated) return null;
  const stored = await db.getGeneratedTask(username, generated.requestHash);
  if (!stored) throw Object.assign(new Error('VOICE_TUTOR_ITEM_NOT_FOUND'), { code: 'VOICE_TUTOR_ITEM_NOT_FOUND' });
  try {
    const data = parseContentResponse(generated.operation, JSON.stringify(stored.result));
    const definitions = buildGeneratedVoiceTutorDefinitions(generated.operation, generated.requestHash, data);
    if (!definitions || definitions.resultSet.id !== setId) throw new Error('generated definitions invalid');
    return definitions;
  } catch {
    throw Object.assign(new Error('VOICE_TUTOR_ITEM_NOT_FOUND'), { code: 'VOICE_TUTOR_ITEM_NOT_FOUND' });
  }
}

function approvedCardRule(card) {
  if (!card?.id || !card.rule || !Array.isArray(card.rule.examples)) return null;
  return {
    id: `trusted-rule:${card.id}`,
    revision: 1,
    title: card.rule.title,
    explanation: card.rule.explanation,
    examples: [...card.rule.examples],
    sources: (Array.isArray(card.sources) ? card.sources : []).map((source) => source.url),
  };
}

async function buildSourceCapsule(db, username, attempt, expectedRevision, referenceTime = new Date()) {
  const setId = attempt?.metadata?.context_set_id;
  const generated = setId ? await generatedDefinitionsFor(db, username, setId, attempt.module) : null;
  const capsule = buildVoiceTutorCapsule({
    attempt,
    expectedRevision,
    ...(generated ? { getItem: generated.getItem } : {}),
  });
  if (!capsule.rule?.discovery_required) return capsule;
  const examYear = new Date(referenceTime).getUTCFullYear();
  const approvedRule = approvedCardRule(await db.getApprovedRuleCard(capsule.skill.id, examYear));
  return approvedRule ? { ...capsule, rule: approvedRule } : capsule;
}

async function rebuildSourceCapsule(db, username, storedCapsule, referenceTime = new Date()) {
  const attemptId = storedCapsule?.source?.attempt_id;
  const revision = Number(storedCapsule?.source?.item_revision);
  const attemptType = storedCapsule?.source?.attempt_type;
  if (attemptType === 'writing' || attemptType === 'speaking') {
    const getter = attemptType === 'writing' ? db.getWritingAttempt : db.getSpeakingAttempt;
    const attempt = attemptId ? await getter(username, attemptId) : null;
    if (!attempt) throw Object.assign(new Error('VOICE_TUTOR_ATTEMPT_NOT_FOUND'), { code: 'VOICE_TUTOR_ATTEMPT_NOT_FOUND' });
    const capsule = buildWritingSpeakingCapsule({
      source: attemptType,
      attempt,
      expectedRevision: revision,
      criterionIndex: Number(storedCapsule.source.criterion_index),
    });
    if (capsule.id !== storedCapsule.id || capsule.version !== storedCapsule.version) {
      throw Object.assign(new Error('VOICE_TUTOR_REVISION_MISMATCH'), { code: 'VOICE_TUTOR_REVISION_MISMATCH' });
    }
    return capsule;
  }
  const attempt = attemptId ? await db.getModuleAttempt(username, attemptId) : null;
  if (!attempt) throw Object.assign(new Error('VOICE_TUTOR_ATTEMPT_NOT_FOUND'), { code: 'VOICE_TUTOR_ATTEMPT_NOT_FOUND' });
  const capsule = await buildSourceCapsule(db, username, attempt, revision, referenceTime);
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
  trustedRuleDiscovery = null,
  privacyPolicyVersion = '',
}) {
  const router = express.Router();
  const { auth } = authentication;

  router.get('/api/v1/voice-tutor/recovery-map', auth, async (req, res, next) => {
    try {
      return res.json(await db.getVoiceTutorRecoveryMap(req.user, { limits, now: now() }));
    } catch (error) {
      return sendVoiceTutorError(error, res, next);
    }
  });

  router.post('/api/v1/voice-tutor/repeats/:repeatId/attempts', auth, async (req, res, next) => {
    if (!ATTEMPT_ID.test(req.params.repeatId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный идентификатор повтора.' } });
    }
    const parsed = parseRepeatAttempt(req.body);
    if (!parsed) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректная попытка повтора.' } });
    try {
      const result = await db.submitVoiceTutorRepeat(req.user, req.params.repeatId, { ...parsed, now: now() });
      return res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      return sendVoiceTutorError(error, res, next);
    }
  });
  const requireAdmin = authentication.requireRole
    ? authentication.requireRole('admin')
    : (req, res) => res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав.' } });

  router.post('/api/v1/voice-tutor/rule-discoveries', auth, async (req, res, next) => {
    const parsed = parseRuleDiscovery(req.body);
    if (!parsed) return sendVoiceTutorError({ code: 'TRUSTED_RULE_REQUEST_INVALID' }, res, next);
    try {
      const access = await db.getVoiceTutorAccess(req.user, limits, now());
      if (!access.entitlements.voice_tutor) return sendVoiceTutorError({ code: 'VOICE_TUTOR_PREMIUM_REQUIRED' }, res, next);
      if (!trustedRuleDiscovery) return sendVoiceTutorError({ code: 'TRUSTED_RULE_DISCOVERY_UNAVAILABLE' }, res, next);
      const session = await db.getVoiceTutorSession(req.user, parsed.sessionId);
      if (!session?.capsule) return sendVoiceTutorError({ code: 'VOICE_TUTOR_SESSION_NOT_FOUND' }, res, next);
      const skillId = String(session.capsule.skill?.id || '');
      const skillTitle = String(session.capsule.skill?.label || session.capsule.skill?.title || '');
      if (!SKILL_ID.test(skillId) || !skillTitle || skillTitle.length > 160
        || session.capsule.rule?.discovery_required !== true) {
        return sendVoiceTutorError({ code: 'TRUSTED_RULE_DISCOVERY_NOT_REQUIRED' }, res, next);
      }
      const examYear = new Date(now()).getUTCFullYear();
      if (await db.getApprovedRuleCard(skillId, examYear)) {
        return sendVoiceTutorError({ code: 'RULE_CARD_CANONICAL_EXISTS' }, res, next);
      }
      const result = await trustedRuleDiscovery.discover({
        username: req.user, skill: { id: skillId, title: skillTitle }, examYear,
      });
      return res.status(201).json({ ...result, session_id: parsed.sessionId });
    } catch (error) { return sendVoiceTutorError(error, res, next); }
  });

  router.get('/api/v1/voice-tutor/rules/:skillId', auth, async (req, res, next) => {
    const skillId = String(req.params.skillId || '');
    const examYear = Number(req.query.exam_year);
    if (!SKILL_ID.test(skillId) || !Number.isInteger(examYear) || examYear < 2020 || examYear > 2100) {
      return sendVoiceTutorError({ code: 'TRUSTED_RULE_REQUEST_INVALID' }, res, next);
    }
    try {
      const card = await db.getApprovedRuleCard(skillId, examYear);
      if (!card) return sendVoiceTutorError({ code: 'RULE_CARD_NOT_FOUND' }, res, next);
      return res.json(publicRuleCard(card));
    } catch (error) { return sendVoiceTutorError(error, res, next); }
  });

  router.get('/api/v1/voice-tutor/rule-cards', auth, requireAdmin, async (req, res, next) => {
    const status = String(req.query.status || 'pending_review');
    if (!['pending_review', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный статус карточки.' } });
    }
    try { return res.json({ cards: (await db.listRuleCards({ status })).map(adminRuleCard) }); } catch (error) { return next(error); }
  });

  router.post('/api/v1/voice-tutor/rule-cards/:cardId/review', auth, requireAdmin, async (req, res, next) => {
    const decision = req.body?.decision;
    if (!RULE_CARD_ID.test(String(req.params.cardId || '')) || !req.body || typeof req.body !== 'object'
      || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректное решение по карточке.' } });
    }
    try {
      const result = await db.reviewRuleCard(req.params.cardId, { decision, reviewer: req.user, reviewedAt: now() });
      return res.json({ ...result, card: adminRuleCard(result.card) });
    } catch (error) { return sendVoiceTutorError(error, res, next); }
  });

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

  router.post('/api/v1/voice-tutor/context-attempts', auth, async (req, res, next) => {
    const parsed = parseContextAttemptRequest(req.body);
    if (!parsed) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный завершённый результат.' } });
    try {
      const access = await db.getVoiceTutorAccess(req.user, limits, now());
      if (!access.entitlements.voice_tutor) return sendVoiceTutorError({ code: 'VOICE_TUTOR_PREMIUM_REQUIRED' }, res, next);
      const generated = await generatedDefinitionsFor(db, req.user, parsed.setId, parsed.module);
      const result = createVoiceTutorContextResult({
        id: parsed.attemptId,
        module: parsed.module,
        setId: parsed.setId,
        revision: parsed.revision,
        answers: parsed.answers,
      }, generated ? {
        getItem: generated.getItem,
        getResultSet: (setId) => setId === generated.resultSet.id ? generated.resultSet : null,
      } : {});
      const recorded = await db.recordModuleAttempt(req.user, result.attempt);
      if (!recorded.created) {
        const existing = await db.getModuleAttempt(req.user, result.attempt.id);
        const expected = result.attempt.metadata;
        if (!existing || existing.activity !== result.attempt.activity || existing.module !== result.attempt.module
          || existing.metadata?.set_id !== expected.set_id || Number(existing.metadata?.set_revision) !== expected.set_revision
          || existing.metadata?.answers_hash !== expected.answers_hash) {
          return sendVoiceTutorError({ code: 'VOICE_TUTOR_CONTEXT_RESULT_CONFLICT' }, res, next);
        }
      }
      for (const errorAttempt of result.errors) await db.recordModuleAttempt(req.user, errorAttempt);
      return res.status(recorded.created ? 201 : 200).json({
        id: result.attempt.id,
        created: recorded.created,
        revision: parsed.revision,
        errors: result.errors.map((attempt) => ({
          attempt_id: attempt.id,
          item_id: attempt.metadata.item_id,
          revision: attempt.metadata.item_revision,
        })),
      });
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
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Передайте только server-issued pointer разбора.' } });
      }
      if (tracer) {
        const consent = await db.getPrivacyConsent(req.user);
        if (!consent?.voice_processing || (privacyPolicyVersion && consent.policy_version !== privacyPolicyVersion)) {
          return sendVoiceTutorError({ code: 'PRIVACY_CONSENT_REQUIRED' }, res, next);
        }
        const attempt = tracer.source === 'writing'
          ? await db.getWritingAttempt(req.user, tracer.attemptId)
          : tracer.source === 'speaking'
            ? await db.getSpeakingAttempt(req.user, tracer.attemptId)
            : await db.getModuleAttempt(req.user, tracer.attemptId);
        if (!attempt) return sendVoiceTutorError({ code: 'VOICE_TUTOR_ATTEMPT_NOT_FOUND' }, res, next);
        const capsule = tracer.source
          ? buildWritingSpeakingCapsule({
            source: tracer.source,
            attempt,
            expectedRevision: tracer.revision,
            criterionIndex: tracer.criterionIndex,
          })
          : await buildSourceCapsule(db, req.user, attempt, tracer.revision, now());
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
          return res.json(tracerResponse(result, existing.capsule, {
            mode: existing.delivery_mode || 'voice',
            ...(existing.capsule.rule?.discovery_required ? { discovery_required: true } : {}),
          }));
        }
        if (capsule.rule?.discovery_required) {
          const released = await db.finishVoiceTutorSession(req.user, result.session.id, {
            limits, now: now(), confirmedBillableSeconds: 0, preservePedagogicalState: true,
          });
          const delivered = await db.setVoiceTutorSessionDelivery(req.user, result.session.id, {
            mode: 'local', errorCode: 'TRUSTED_RULE_DISCOVERY_REQUIRED',
          });
          return res.status(201).json(tracerResponse({ ...released, created: true, session: delivered.session }, capsule, {
            mode: 'local', nonce, local_rule: capsule.rule, discovery_required: true,
          }));
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
        const capsule = await rebuildSourceCapsule(db, req.user, result.capsule, now());
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
      const capsule = await rebuildSourceCapsule(db, req.user, switched.capsule, now());
      if (textTutor && await hasCurrentTextConsent(db, req.user, privacyPolicyVersion)) {
        try {
          const textTurn = await textTutor.createTurn({ capsule, state: switched.session.state, username: req.user });
          return res.json(tracerResponse({ ...switched, created: false }, capsule, { mode: 'text', nonce, text_turn: textTurn }));
        } catch {}
      }
      await db.setVoiceTutorSessionDelivery(req.user, req.params.sessionId, { mode: 'local', errorCode: 'VOICE_TUTOR_TEXT_UNAVAILABLE' });
      return res.json(tracerResponse({ ...switched, created: false }, capsule, { mode: 'local', nonce, local_rule: capsule.rule }));
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
