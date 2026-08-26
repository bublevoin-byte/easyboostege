import crypto from 'node:crypto';
import express from 'express';
import { bindResponseOwner, requireExpectedOwner } from '../middleware/expected-owner.js';
import { parseContentResponse } from '../ai/content.js';
import { buildVoiceTutorCapsule, buildWritingSpeakingCapsule, createGrammarLexiconErrorAttempt, createVoiceTutorContextResult, persistedVoiceTutorCapsule, publicVoiceTutorCapsule } from '../voice-tutor/capsule.js';
import { buildGeneratedVoiceTutorDefinitions, parseGeneratedVoiceTutorItemId, parseGeneratedVoiceTutorSetId } from '../voice-tutor/generated-items.js';
import { isContextVoiceTutorModule, isDirectVoiceTutorModule } from '../voice-tutor/modules.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NONCE = /^[A-Za-z0-9_-]{16,200}$/u;
const PROVIDER_CALL_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const EVENT_TYPES = new Set(['diagnosis_complete', 'explanation_complete', 'check_answer', 'transfer_answer']);
const RULE_CARD_ID = SESSION_ID;
const SKILL_ID = /^[a-z0-9][a-z0-9._-]{2,119}$/u;

const PUBLIC_ERRORS = Object.freeze({
  SUBSCRIPTION_REQUIRED: { status: 403, message: 'Для голосового разбора нужна активная подписка.' },
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
  VOICE_TUTOR_PRONUNCIATION_POINTER_STALE: { status: 409, message: 'Ошибка произношения изменилась. Обновите результат и повторите.' },
  VOICE_TUTOR_PRONUNCIATION_POINTER_EXPIRED: { status: 409, message: 'Срок точного разбора произношения истёк. Выполните новую запись.' },
  VOICE_TUTOR_NONCE_REPLAYED: { status: 409, message: 'Команда этой сессии уже использована.' },
  VOICE_TUTOR_TRANSITION_INVALID: { status: 409, message: 'Этот шаг разбора сейчас недоступен.' },
  VOICE_TUTOR_DISABLED: { status: 503, message: 'Голосовой режим временно отключён. Продолжите разбор текстом.' },
  VOICE_TUTOR_COST_KILL_SWITCH: { status: 503, message: 'Новые голосовые подключения временно остановлены. Продолжите разбор текстом.' },
  VOICE_TUTOR_ZDR_NOT_CONFIRMED: { status: 503, message: 'Безопасный режим хранения провайдера не подтверждён. Голос не передан.' },
  VOICE_TUTOR_PROVIDER_NOT_CONFIGURED: { status: 503, message: 'Голосовой режим пока не настроен. Продолжите разбор текстом.' },
  VOICE_TUTOR_PROVIDER_CONTRACT_INVALID: { status: 503, message: 'Голосовой провайдер вернул неподдерживаемый ответ. Продолжите текстом.' },
  VOICE_TUTOR_PROVIDER_UNAVAILABLE: { status: 503, message: 'Голосовой провайдер временно недоступен. Продолжите текстом.' },
  VOICE_TUTOR_QUOTA_EXHAUSTED: { status: 429, message: 'Голосовые минуты закончились. Продолжайте разбор текстом.' },
  VOICE_TUTOR_PROXY_TICKET_REPLAYED: { status: 409, message: 'Одноразовый голосовой билет уже использован.' },
  VOICE_TUTOR_PROXY_TICKET_INVALID: { status: 409, message: 'Голосовой билет не соответствует текущей сессии.' },
  VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT: { status: 409, message: 'Билет подключения уже перевыпущен. Начните новый разбор.' },
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
  TRUSTED_RULE_DISCOVERY_IN_PROGRESS: { status: 409, message: 'Поиск правила для этого разбора уже выполняется.' },
  AI_BUDGET_EXHAUSTED: { status: 503, message: 'Дневной лимит поиска правил исчерпан. Попробуйте позже.' },
  RATE_LIMITED: { status: 429, message: 'Слишком много запросов поиска правила. Попробуйте позже.' },
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
  ADAPTIVE_EXECUTION_CLAIM_INVALID: { status: 409, message: 'Персональный блок больше не активен.' },
  ADAPTIVE_EXECUTION_CLAIM_EXPIRED: { status: 410, message: 'Время персонального блока истекло.' },
  ADAPTIVE_EXECUTION_CLAIM_CONSUMED: { status: 409, message: 'Персональный блок уже получил другую попытку.' },
  ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH: { status: 409, message: 'Повтор не соответствует персональному блоку.' },
});

const TICKET_09_PUBLIC_ERRORS = Object.freeze({
  VOICE_TUTOR_CLARIFICATION_INVALID: { status: 400, message: 'Некорректное короткое уточнение.' },
  VOICE_TUTOR_CLARIFICATION_LIMIT: { status: 429, message: 'Лимит уточнений для этого разбора исчерпан.' },
  TRUSTED_RULE_SEARCH_FAILED: { status: 503, message: 'Поиск доверенных источников временно недоступен.' },
  TRUSTED_RULE_SEARCH_TIMEOUT: { status: 503, message: 'Поиск доверенных источников превысил лимит времени.' },
  VOICE_TUTOR_REPORT_NOT_FOUND: { status: 404, message: 'Сообщение о проблеме не найдено.' },
  VOICE_TUTOR_REPORT_REVIEW_CONFLICT: { status: 409, message: 'Сообщение уже проверено с другим решением.' },
});

function sendVoiceTutorError(error, res, next) {
  const code = error?.code || error?.message;
  const known = PUBLIC_ERRORS[code] || TICKET_09_PUBLIC_ERRORS[code];
  if (!known) return next(error);
  return res.status(known.status).json({ error: { code, message: known.message } });
}

const SAFE_REALTIME_ERROR_CODES = new Set([
  'VOICE_TUTOR_DISABLED',
  'VOICE_TUTOR_COST_KILL_SWITCH',
  'VOICE_TUTOR_ZDR_NOT_CONFIRMED',
  'VOICE_TUTOR_PROVIDER_NOT_CONFIGURED',
  'VOICE_TUTOR_PROVIDER_CONTRACT_INVALID',
  'VOICE_TUTOR_PROVIDER_UNAVAILABLE',
  'VOICE_TUTOR_QUOTA_EXHAUSTED',
]);

function safeRealtimeErrorCode(value) {
  const code = String(value || '');
  return SAFE_REALTIME_ERROR_CODES.has(code) ? code : 'VOICE_TUTOR_PROVIDER_UNAVAILABLE';
}

function canFallbackFromFreshRealtimeError(error) {
  return error?.code === 'VOICE_TUTOR_PROVIDER_UNAVAILABLE';
}

function realtimePolicyBlock(policy = {}) {
  if (policy.enabled === false) return 'VOICE_TUTOR_DISABLED';
  if (policy.costKillSwitch === true) return 'VOICE_TUTOR_COST_KILL_SWITCH';
  if (policy.requireZdr === true && policy.zdrAttested !== true) return 'VOICE_TUTOR_ZDR_NOT_CONFIRMED';
  return null;
}

function publicVoiceUnavailable(code) {
  const safeCode = safeRealtimeErrorCode(code);
  return { code: safeCode, message: PUBLIC_ERRORS[safeCode].message };
}

function nonceHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function proxyTicketResponse(ticket, issued, sessionId, proxyPath) {
  if (issued?.issued) {
    return {
      ticket,
      expires_at: new Date(issued.ticket.expires_at).toISOString(),
      proxy_url: proxyPath,
    };
  }
  return {
    status: issued?.status || 'reissue_required',
    reissue_url: `/api/v1/voice-tutor/sessions/${sessionId}/realtime-ticket`,
  };
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
  if (keys.length === 4 && keys.every((key) => (
    ['source', 'attemptId', 'revision', 'pronunciationErrorRef'].includes(key)
  ))) {
    const attemptId = value.attemptId;
    const ref = String(value.pronunciationErrorRef || '');
    if (value.source !== 'speaking' || !Number.isSafeInteger(attemptId) || attemptId < 1
      || !Number.isInteger(value.revision) || value.revision < 1 || value.revision > 10_000
      || !/^(?:word|phoneme)\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u.test(ref)
      || !ref.startsWith(`word.${attemptId}.`) && !ref.startsWith(`phoneme.${attemptId}.`)) return false;
    return {
      source: 'speaking', attemptId, revision: value.revision, pronunciationErrorRef: ref,
    };
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
    || !/^[a-z0-9._-]{4,120}$/u.test(String(body.setId || '')) || !Number.isInteger(body.revision)
    || !Array.isArray(body.answers) || body.answers.length < 1 || body.answers.length > 20
    || body.answers.some((answer) => typeof answer !== 'string' || answer.length < 1 || answer.length > 200)) return null;
  return body;
}

function parsePedagogicalEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['nonce', 'event', 'provider_call_id'].includes(key))) return null;
  if (!NONCE.test(String(body.nonce || '')) || !body.event || typeof body.event !== 'object' || Array.isArray(body.event)) return null;
  const providerCallId = body.provider_call_id == null ? null : String(body.provider_call_id);
  if (providerCallId != null && !PROVIDER_CALL_ID.test(providerCallId)) return null;
  const type = String(body.event.type || '');
  if (!EVENT_TYPES.has(type)) return null;
  const keys = Object.keys(body.event);
  const needsAnswer = type === 'check_answer' || type === 'transfer_answer';
  const diagnosticReply = type === 'diagnosis_complete' && keys.includes('answer')
    ? String(body.event.answer || '').replace(/\s+/gu, ' ').trim()
    : null;
  const permitsAnswer = needsAnswer || type === 'diagnosis_complete';
  if (keys.some((key) => !['type', 'answer'].includes(key))
    || (needsAnswer && !keys.includes('answer')) || (!permitsAnswer && keys.includes('answer'))) return null;
  if (needsAnswer && (typeof body.event.answer !== 'string' || body.event.answer.length > 200)) return null;
  if (diagnosticReply != null && (typeof body.event.answer !== 'string'
    || !diagnosticReply || diagnosticReply.length > 200 || /[<>]/u.test(diagnosticReply))) return null;
  return {
    nonce: String(body.nonce),
    event: { type, ...(needsAnswer ? { answer: body.event.answer } : {}) },
    providerCallId,
    diagnosticReply,
  };
}

function parseRuleDiscovery(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
    || !SESSION_ID.test(String(body.session_id || '')) || !NONCE.test(String(body.nonce || ''))) return null;
  return { sessionId: String(body.session_id), nonce: String(body.nonce) };
}

function parseClarification(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['nonce', 'kind', 'message'].includes(key))) return null;
  const kind = String(body.kind || '');
  const message = String(body.message || '').replace(/\s+/gu, ' ').trim();
  if (!NONCE.test(String(body.nonce || '')) || !['clarify', 'explain_differently'].includes(kind)
    || (kind === 'clarify' && !message) || message.length > 200 || /[<>]/u.test(message)) return null;
  return { nonce: String(body.nonce), kind, message };
}

const REPORT_REASONS = new Set(['incorrect_rule', 'unclear_explanation', 'bad_example', 'technical_issue']);

function parseReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
    || !SESSION_ID.test(String(body.session_id || '')) || !REPORT_REASONS.has(body.reason)) return null;
  return { sessionId: String(body.session_id), reason: body.reason };
}

function parseRepeatAttempt(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || ![3, 5].includes(Object.keys(body).length)
    || Object.keys(body).some((key) => ![
      'attemptId', 'taskId', 'answer', 'adaptiveExecutionClaim', 'adaptiveSessionId',
    ].includes(key))) return null;
  const hasAdaptiveClaim = Object.hasOwn(body, 'adaptiveExecutionClaim')
    || Object.hasOwn(body, 'adaptiveSessionId');
  if (!ATTEMPT_ID.test(String(body.attemptId || ''))
    || !/^[a-z0-9][a-z0-9._:-]{3,179}$/u.test(String(body.taskId || ''))
    || typeof body.answer !== 'string' || body.answer.length < 1 || body.answer.length > 200
    || (hasAdaptiveClaim && (!NONCE.test(String(body.adaptiveExecutionClaim || ''))
      || !SESSION_ID.test(String(body.adaptiveSessionId || ''))))) return null;
  return {
    attemptId: String(body.attemptId), taskId: String(body.taskId), answer: body.answer,
    ...(hasAdaptiveClaim ? {
      adaptiveExecutionClaim: String(body.adaptiveExecutionClaim),
      adaptiveSessionId: String(body.adaptiveSessionId),
    } : {}),
  };
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

function publicStoredSession(session) {
  return {
    id: session.id, status: session.status, state: session.pedagogical_state || null,
    micro_check_passed: session.micro_check_passed ?? null,
    transfer_passed: session.transfer_passed ?? null, outcome: session.outcome ?? null,
    started_at: session.started_at, expires_at: session.expires_at, ended_at: session.ended_at,
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

async function generatedDefinitionsForItem(db, username, itemId, module) {
  const generated = parseGeneratedVoiceTutorItemId(itemId, module);
  if (!generated) return null;
  const stored = await db.getGeneratedTask(username, generated.requestHash);
  if (!stored || stored.operation !== generated.operation) {
    throw Object.assign(new Error('VOICE_TUTOR_ITEM_NOT_FOUND'), { code: 'VOICE_TUTOR_ITEM_NOT_FOUND' });
  }
  try {
    const data = parseContentResponse(generated.operation, JSON.stringify(stored.result));
    const definitions = buildGeneratedVoiceTutorDefinitions(generated.operation, generated.requestHash, data);
    if (!definitions?.getItem(itemId)) throw new Error('generated item invalid');
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
  const generatedItem = !setId
    ? await generatedDefinitionsForItem(db, username, attempt?.metadata?.item_id, attempt?.module)
    : null;
  const capsule = buildVoiceTutorCapsule({
    attempt,
    expectedRevision,
    ...(generated || generatedItem ? { getItem: (generated || generatedItem).getItem } : {}),
  });
  if (!capsule.rule?.discovery_required) return capsule;
  const examYear = new Date(referenceTime).getUTCFullYear();
  const approvedCard = await db.getApprovedRuleCard(capsule.skill.id, examYear);
  const approvedRule = approvedCardRule(approvedCard);
  return approvedRule ? { ...capsule, rule_card_id: approvedCard.id, rule: approvedRule } : capsule;
}

export async function rebuildSourceCapsule(db, username, storedCapsule, referenceTime = new Date()) {
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
      ...(storedCapsule.source.pronunciation_error_ref ? {
        pronunciationErrorRef: storedCapsule.source.pronunciation_error_ref,
        referenceTime,
      } : { criterionIndex: Number(storedCapsule.source.criterion_index) }),
    });
    if (capsule.id !== storedCapsule.id || capsule.version !== storedCapsule.version) {
      throw Object.assign(new Error('VOICE_TUTOR_REVISION_MISMATCH'), { code: 'VOICE_TUTOR_REVISION_MISMATCH' });
    }
    return applySessionRuleCard(db, username, storedCapsule, capsule);
  }
  const attempt = attemptId ? await db.getModuleAttempt(username, attemptId) : null;
  if (!attempt) throw Object.assign(new Error('VOICE_TUTOR_ATTEMPT_NOT_FOUND'), { code: 'VOICE_TUTOR_ATTEMPT_NOT_FOUND' });
  const capsule = await buildSourceCapsule(db, username, attempt, revision, referenceTime);
  if (capsule.id !== storedCapsule.id || capsule.version !== storedCapsule.version) {
    throw Object.assign(new Error('VOICE_TUTOR_REVISION_MISMATCH'), { code: 'VOICE_TUTOR_REVISION_MISMATCH' });
  }
  return applySessionRuleCard(db, username, storedCapsule, capsule);
}

async function applySessionRuleCard(db, username, storedCapsule, capsule) {
  const cardId = storedCapsule?.rule_card_id;
  if (!cardId || typeof db.getRuleCard !== 'function') return capsule;
  const card = await db.getRuleCard(cardId);
  if (!card || card.skill?.id !== capsule.skill.id
    || (card.status === 'pending_review' && card.created_for_username !== username)
    || !['pending_review', 'approved'].includes(card.status)) return capsule;
  const rule = approvedCardRule(card);
  if (!rule) return capsule;
  return {
    ...capsule,
    rule_card_id: card.id,
    rule: { ...rule, provisional: card.status === 'pending_review' },
  };
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
  realtimeProxy = null,
  textTutor = null,
  trustedRuleDiscovery = null,
  privacyPolicyVersion = '',
  realtimePolicy = null,
  sessionStartLimiter = (_req, _res, next) => next(),
}) {
  const router = express.Router();
  const { auth } = authentication;

  async function issueProxyTicket(username, sessionId, idempotencyKey, {
    reissue = false, nextNonceHash = null, sessionExpiresAt = null,
  } = {}) {
    const ticket = crypto.randomBytes(32).toString('base64url');
    const observedAt = new Date(now());
    const ttlSeconds = Math.max(5, Math.min(60, Number(realtimeProxy?.ticketTtlSeconds || 30)));
    const configuredExpiry = observedAt.getTime() + ttlSeconds * 1_000;
    const sessionDeadline = new Date(sessionExpiresAt).getTime();
    const expiresAt = new Date(Number.isFinite(sessionDeadline)
      ? Math.min(configuredExpiry, sessionDeadline)
      : configuredExpiry);
    let issued;
    try {
      issued = await db.issueVoiceTutorProxyTicket(username, sessionId, {
        ticketHash: nonceHash(ticket),
        idempotencyKey,
        expiresAt,
        now: observedAt,
        reissue,
        nextNonceHash,
      });
    } catch (error) {
      if (!reissue && error?.code === 'VOICE_TUTOR_PROXY_TICKET_ALREADY_ISSUED') {
        issued = { issued: false, status: 'reissue_required' };
      } else {
        throw error;
      }
    }
    return proxyTicketResponse(ticket, issued, sessionId, realtimeProxy.proxyPath);
  }

  async function deliverWithoutRealtime({ username, result, capsule, nonce, code }) {
    const safeCode = safeRealtimeErrorCode(code);
    const released = await db.finishVoiceTutorSession(username, result.session.id, {
      limits, now: now(), confirmedBillableSeconds: 0, preservePedagogicalState: true,
    });
    if (textTutor && await hasCurrentTextConsent(db, username, privacyPolicyVersion)) {
      try {
        const textTurn = await textTutor.createTurn({ capsule, state: result.session.state, username });
        const delivered = await db.setVoiceTutorSessionDelivery(username, result.session.id, {
          mode: 'text', errorCode: safeCode,
        });
        return tracerResponse({ ...released, created: true, session: delivered.session }, capsule, {
          mode: 'text', nonce, text_turn: textTurn, voice_unavailable: publicVoiceUnavailable(safeCode),
        });
      } catch {}
    }
    const delivered = await db.setVoiceTutorSessionDelivery(username, result.session.id, {
      mode: 'local', errorCode: safeCode,
    });
    return tracerResponse({ ...released, created: true, session: delivered.session }, capsule, {
      mode: 'local', nonce, local_rule: capsule.rule, voice_unavailable: publicVoiceUnavailable(safeCode),
    });
  }

  router.get('/api/v1/voice-tutor/recovery-map', auth, async (req, res, next) => {
    if (!requireExpectedOwner(req, res)) return;
    try {
      res.setHeader('Cache-Control', 'no-store');
      bindResponseOwner(res, req.user);
      return res.json(await db.getVoiceTutorRecoveryMap(req.user, { limits, now: now() }));
    } catch (error) {
      return sendVoiceTutorError(error, res, next);
    }
  });

  router.post('/api/v1/voice-tutor/repeats/:repeatId/attempts', auth, async (req, res, next) => {
    if (!requireExpectedOwner(req, res)) return;
    bindResponseOwner(res, req.user);
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
    const claimId = crypto.randomUUID();
    const nextNonce = newNonce();
    let claimed = false;
    try {
      const access = await db.getVoiceTutorAccess(req.user, limits, now());
      if (!access.entitlements.voice_tutor) return sendVoiceTutorError({ code: 'VOICE_TUTOR_PREMIUM_REQUIRED' }, res, next);
      if (!trustedRuleDiscovery) return sendVoiceTutorError({ code: 'TRUSTED_RULE_DISCOVERY_UNAVAILABLE' }, res, next);
      const session = await db.getVoiceTutorSession(req.user, parsed.sessionId);
      if (!session?.capsule) return sendVoiceTutorError({ code: 'VOICE_TUTOR_SESSION_NOT_FOUND' }, res, next);
      const capsule = await rebuildSourceCapsule(db, req.user, session.capsule, now());
      const skillId = String(capsule.skill?.id || '');
      const skillTitle = String(capsule.skill?.label || capsule.skill?.title || '');
      if (!SKILL_ID.test(skillId) || !skillTitle || skillTitle.length > 160) {
        return sendVoiceTutorError({ code: 'TRUSTED_RULE_DISCOVERY_NOT_REQUIRED' }, res, next);
      }
      const examYear = new Date(now()).getUTCFullYear();
      if (await db.getApprovedRuleCard(skillId, examYear)) {
        return sendVoiceTutorError({ code: 'RULE_CARD_CANONICAL_EXISTS' }, res, next);
      }
      if (capsule.rule?.discovery_required !== true) {
        return sendVoiceTutorError({ code: 'TRUSTED_RULE_DISCOVERY_NOT_REQUIRED' }, res, next);
      }
      await db.claimVoiceTutorRuleDiscovery(req.user, parsed.sessionId, {
        claimId, nonceHash: nonceHash(parsed.nonce), now: now(),
      });
      claimed = true;
      const result = await trustedRuleDiscovery.discover({
        username: req.user, sessionId: parsed.sessionId, capsuleId: capsule.id,
        skill: { id: skillId, title: skillTitle }, examYear,
        discovery: {
          claimId, expectedNonceHash: nonceHash(parsed.nonce), nextNonceHash: nonceHash(nextNonce),
        },
      });
      const updated = await db.getVoiceTutorSession(req.user, parsed.sessionId);
      const provisionalCapsule = await rebuildSourceCapsule(db, req.user, updated.capsule, now());
      return res.status(201).json({
        ...result, session_id: parsed.sessionId, nonce: nextNonce, capsule: publicVoiceTutorCapsule(provisionalCapsule),
        session: publicStoredSession(updated), next_step: 'explain',
      });
    } catch (error) {
      if (claimed) {
        await db.failVoiceTutorRuleDiscovery(req.user, parsed.sessionId, {
          claimId, errorCode: error?.code || 'TRUSTED_RULE_SEARCH_FAILED', now: now(),
        }).catch(() => {});
      }
      return sendVoiceTutorError(error, res, next);
    }
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
    if (!requireExpectedOwner(req, res)) return;
    bindResponseOwner(res, req.user);
    const parsed = parseErrorRequest(req.body);
    if (!parsed) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные исходной ошибки.' } });
    try {
      const access = await db.getVoiceTutorAccess(req.user, limits, now());
      if (!access.entitlements.voice_tutor) return sendVoiceTutorError({ code: 'VOICE_TUTOR_PREMIUM_REQUIRED' }, res, next);
      const generated = await generatedDefinitionsForItem(db, req.user, parsed.itemId, parsed.module);
      const attempt = createGrammarLexiconErrorAttempt({
        id: parsed.attemptId,
        module: parsed.module,
        itemId: parsed.itemId,
        revision: parsed.revision,
        learnerAnswer: parsed.learnerAnswer,
      }, generated?.getItem);
      const result = await db.recordModuleAttempt(req.user, attempt, { evidenceQuality: 'server_verified_assisted' });
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
      const recorded = await db.recordModuleAttempt(req.user, result.attempt, { evidenceQuality: 'server_verified_assisted' });
      if (!recorded.created) {
        const existing = await db.getModuleAttempt(req.user, result.attempt.id);
        const expected = result.attempt.metadata;
        if (!existing || existing.activity !== result.attempt.activity || existing.module !== result.attempt.module
          || existing.metadata?.set_id !== expected.set_id || Number(existing.metadata?.set_revision) !== expected.set_revision
          || existing.metadata?.answers_hash !== expected.answers_hash) {
          return sendVoiceTutorError({ code: 'VOICE_TUTOR_CONTEXT_RESULT_CONFLICT' }, res, next);
        }
      }
      for (const errorAttempt of result.errors) {
        await db.recordModuleAttempt(req.user, errorAttempt, { evidenceQuality: 'server_verified_assisted' });
      }
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

  router.post('/api/v1/voice-tutor/sessions', auth, sessionStartLimiter, async (req, res, next) => {
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
            ...(tracer.pronunciationErrorRef ? {
              pronunciationErrorRef: tracer.pronunciationErrorRef,
              referenceTime: now(),
            } : { criterionIndex: tracer.criterionIndex }),
          })
          : await buildSourceCapsule(db, req.user, attempt, tracer.revision, now());
        const nonce = newNonce();
        const result = await db.reserveVoiceTutorSession(req.user, {
          id: newSessionId(),
          idempotencyKey,
          limits,
          now: now(),
          context: { capsule: persistedVoiceTutorCapsule(capsule), nonceHash: nonceHash(nonce) },
          allowFallbackOnly: true,
        });
        if (!result.created) {
          const existing = await db.getVoiceTutorSession(req.user, result.session.id);
          if (!existing?.capsule || existing.capsule.id !== capsule.id) {
            return res.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Idempotency-Key уже связан с другим разбором.' } });
          }
          const existingCapsule = result.capsule
            || await rebuildSourceCapsule(db, req.user, existing.capsule, now());
          const provisionalVoice = existing.delivery_mode === 'voice'
            && !existing.proxy_ticket_hash && !existing.voice_activated_at;
          const existingPolicyBlock = realtimePolicyBlock(
            (typeof realtimePolicy === 'function' ? realtimePolicy() : realtimePolicy) || {},
          );
          let recoveredMode = existing.delivery_mode || 'local';
          let realtime;
          let recoveredSession;
          if (provisionalVoice && existing.status === 'active' && realtimeProxy && !existingPolicyBlock) {
            realtime = await issueProxyTicket(req.user, existing.id, idempotencyKey, {
              nextNonceHash: nonceHash(nonce),
              sessionExpiresAt: existing.expires_at,
            });
          } else if (existing.delivery_mode === 'voice' && !provisionalVoice && realtimeProxy) {
            realtime = await issueProxyTicket(req.user, existing.id, idempotencyKey, {
              sessionExpiresAt: existing.expires_at,
            });
          } else if (existing.delivery_mode !== 'voice' || provisionalVoice) {
            const recovered = await db.reissueVoiceTutorFallbackNonce(req.user, existing.id, {
              idempotencyKey, nextNonceHash: nonceHash(nonce), now: now(),
            });
            recoveredSession = recovered.session;
            if (provisionalVoice) recoveredMode = 'local';
          }
          return res.json(tracerResponse({
            ...result,
            ...(recoveredSession ? { session: recoveredSession } : {}),
          }, existingCapsule, {
            mode: recoveredMode,
            ...(realtime ? { realtime } : {}),
            ...(existing.delivery_mode !== 'voice' || provisionalVoice ? { nonce } : {}),
            ...(recoveredMode === 'local' ? { local_rule: existingCapsule.rule } : {}),
            ...(existingCapsule.rule?.discovery_required ? { discovery_required: true } : {}),
          }));
        }
        const reservedCapsule = result.capsule || capsule;
        if (reservedCapsule.rule?.discovery_required) {
          const delivered = await db.setVoiceTutorSessionDelivery(req.user, result.session.id, {
            mode: 'local', errorCode: 'TRUSTED_RULE_DISCOVERY_REQUIRED',
          });
          return res.status(201).json(tracerResponse({ ...result, created: true, session: delivered.session }, reservedCapsule, {
            mode: 'local', nonce, local_rule: reservedCapsule.rule, discovery_required: true,
          }));
        }
        const resolvedPolicy = typeof realtimePolicy === 'function' ? realtimePolicy() : realtimePolicy;
        const policyBlock = realtimePolicyBlock(resolvedPolicy || {});
        if (result.fallback_only || policyBlock || !realtimeProxy) {
          return res.status(201).json(await deliverWithoutRealtime({
            username: req.user,
            result,
            capsule: reservedCapsule,
            nonce,
            code: result.fallback_only ? 'VOICE_TUTOR_QUOTA_EXHAUSTED' : policyBlock || 'VOICE_TUTOR_PROVIDER_NOT_CONFIGURED',
          }));
        }
        try {
          const realtime = await issueProxyTicket(req.user, result.session.id, idempotencyKey, {
            sessionExpiresAt: result.session.expires_at,
          });
          const delivered = await db.setVoiceTutorSessionDelivery(req.user, result.session.id, {
            mode: 'voice',
          });
          return res.status(201).json(tracerResponse({ ...result, session: delivered.session }, reservedCapsule, { mode: 'voice', nonce, realtime }));
        } catch (providerError) {
          if (!canFallbackFromFreshRealtimeError(providerError)) throw providerError;
          return res.status(201).json(await deliverWithoutRealtime({
            username: req.user,
            result,
            capsule: reservedCapsule,
            nonce,
            code: safeRealtimeErrorCode(providerError?.code),
          }));
        }
      }
      const policyBlock = realtimePolicyBlock((typeof realtimePolicy === 'function' ? realtimePolicy() : realtimePolicy) || {});
      if (policyBlock) return sendVoiceTutorError({ code: policyBlock }, res, next);
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

  router.post('/api/v1/voice-tutor/sessions/:sessionId/realtime-ticket', auth, async (req, res, next) => {
    if (!SESSION_ID.test(req.params.sessionId)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    const idempotencyKey = String(req.headers['idempotency-key'] || '');
    if (!IDEMPOTENCY_KEY.test(idempotencyKey) || !req.body || typeof req.body !== 'object'
      || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    }
    try {
      const resolvedPolicy = typeof realtimePolicy === 'function' ? realtimePolicy() : realtimePolicy;
      const policyBlock = realtimePolicyBlock(resolvedPolicy || {});
      if (policyBlock || !realtimeProxy) return sendVoiceTutorError({ code: policyBlock || 'VOICE_TUTOR_PROVIDER_NOT_CONFIGURED' }, res, next);
      const [consent, access, stored] = await Promise.all([
        db.getPrivacyConsent(req.user),
        db.getVoiceTutorAccess(req.user, limits, now()),
        db.getVoiceTutorSession(req.user, req.params.sessionId),
      ]);
      if (!consent?.voice_processing || (privacyPolicyVersion && consent.policy_version !== privacyPolicyVersion)) {
        return sendVoiceTutorError({ code: 'PRIVACY_CONSENT_REQUIRED' }, res, next);
      }
      if (!access.entitlements.voice_tutor) return sendVoiceTutorError({ code: 'VOICE_TUTOR_PREMIUM_REQUIRED' }, res, next);
      const nonce = newNonce();
      let realtime;
      try {
        realtime = await issueProxyTicket(req.user, req.params.sessionId, idempotencyKey, {
          reissue: true,
          nextNonceHash: nonceHash(nonce),
          sessionExpiresAt: stored?.expires_at,
        });
      } catch (error) {
        if (error?.code !== 'VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT') throw error;
        const recovered = await db.reissueVoiceTutorFallbackNonce(req.user, req.params.sessionId, {
          idempotencyKey, nextNonceHash: nonceHash(nonce), now: now(), recoverLostRealtime: true,
        });
        const recoveredAccess = await db.getVoiceTutorAccess(req.user, limits, now());
        return res.json({
          mode: 'local', nonce, session: recovered.session,
          voice_tutor: recoveredAccess.voice_tutor,
          voice_unavailable: publicVoiceUnavailable('VOICE_TUTOR_PROVIDER_UNAVAILABLE'),
        });
      }
      if (!realtime.ticket) return sendVoiceTutorError({ code: 'VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT' }, res, next);
      return res.status(201).json({ nonce, realtime });
    } catch (error) { return sendVoiceTutorError(error, res, next); }
  });

  router.post('/api/v1/voice-tutor/sessions/:sessionId/events', auth, async (req, res, next) => {
    if (!SESSION_ID.test(req.params.sessionId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный идентификатор голосового разбора.' } });
    }
    const parsed = parsePedagogicalEvent(req.body);
    if (!parsed) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректное событие голосового разбора.' } });
    const nonce = newNonce();
    try {
      const storedBefore = await db.getVoiceTutorSession(req.user, req.params.sessionId);
      if (!storedBefore?.capsule) return sendVoiceTutorError({ code: 'VOICE_TUTOR_SESSION_NOT_FOUND' }, res, next);
      if (storedBefore.delivery_mode === 'text' && parsed.event.type === 'diagnosis_complete' && !parsed.diagnosticReply) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Коротко объясните выбор ответа.' } });
      }
      if (storedBefore.delivery_mode === 'voice' && parsed.diagnosticReply != null) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
      }
      if (storedBefore.delivery_mode === 'voice' && !parsed.providerCallId) {
        return sendVoiceTutorError({ code: 'VOICE_TUTOR_PROVIDER_CONTRACT_INVALID' }, res, next);
      }
      const capsule = await rebuildSourceCapsule(db, req.user, storedBefore.capsule, now());
      let providerCallClaimed = false;
      if (parsed.providerCallId) {
        providerCallClaimed = Boolean(realtimeProxy?.claimPedagogyCall?.(
          req.user, req.params.sessionId, parsed.providerCallId, parsed.event,
        ));
        if (!providerCallClaimed) {
          return sendVoiceTutorError({ code: 'VOICE_TUTOR_PROVIDER_CONTRACT_INVALID' }, res, next);
        }
      }
      let result;
      try {
        result = await db.advanceVoiceTutorSession(req.user, req.params.sessionId, {
          nonceHash: nonceHash(parsed.nonce),
          nextNonceHash: nonceHash(nonce),
          event: parsed.event,
          capsule,
          now: now(),
        });
      } catch (error) {
        if (providerCallClaimed) {
          realtimeProxy?.failPedagogyCall?.(req.user, req.params.sessionId, parsed.providerCallId);
        }
        throw error;
      }
      if (providerCallClaimed) {
        realtimeProxy.completePedagogyCall(
          req.user, req.params.sessionId, parsed.providerCallId, { state: result.session.state },
        );
      }
      const stored = await db.getVoiceTutorSession(req.user, req.params.sessionId);
      if (stored?.delivery_mode === 'text') {
        if (textTutor && await hasCurrentTextConsent(db, req.user, privacyPolicyVersion)) {
          try {
            const textTurn = await textTutor.createTurn({
              capsule, state: result.session.state, username: req.user,
              ...(parsed.diagnosticReply ? { diagnosticReply: parsed.diagnosticReply } : {}),
            });
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
        return res.json(tracerResponse({ ...result, created: false }, capsule, {
          mode: 'local', nonce, local_rule: capsule.rule,
        }));
      }
      return res.json(tracerResponse({ ...result, created: false }, capsule, { mode: 'voice', nonce }));
    } catch (error) {
      return sendVoiceTutorError(error, res, next);
    }
  });

  router.post('/api/v1/voice-tutor/sessions/:sessionId/clarifications', auth, async (req, res, next) => {
    if (!SESSION_ID.test(req.params.sessionId)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    const parsed = parseClarification(req.body);
    if (!parsed) return sendVoiceTutorError({ code: 'VOICE_TUTOR_CLARIFICATION_INVALID' }, res, next);
    const nonce = newNonce();
    try {
      if (!textTutor || !await hasCurrentTextConsent(db, req.user, privacyPolicyVersion)) {
        return sendVoiceTutorError({ code: 'PRIVACY_CONSENT_REQUIRED' }, res, next);
      }
      const stored = await db.getVoiceTutorSession(req.user, req.params.sessionId);
      if (!stored?.capsule) return sendVoiceTutorError({ code: 'VOICE_TUTOR_SESSION_NOT_FOUND' }, res, next);
      if (stored.delivery_mode !== 'text' || !['diagnose', 'explain'].includes(stored.pedagogical_state)) {
        return sendVoiceTutorError({ code: 'VOICE_TUTOR_TRANSITION_INVALID' }, res, next);
      }
      const capsule = await rebuildSourceCapsule(db, req.user, stored.capsule, now());
      const recorded = await db.clarifyVoiceTutorSession(req.user, req.params.sessionId, {
        nonceHash: nonceHash(parsed.nonce), nextNonceHash: nonceHash(nonce), now: now(),
      });
      try {
        const textTurn = await textTutor.createClarification({
          capsule, state: stored.pedagogical_state, username: req.user, kind: parsed.kind, message: parsed.message,
        });
        return res.json(tracerResponse({ ...recorded, created: false }, capsule, {
          mode: 'text', nonce, text_turn: textTurn, clarification_turns: recorded.clarification_turns,
        }));
      } catch (textError) {
        const delivered = await db.setVoiceTutorSessionDelivery(req.user, req.params.sessionId, {
          mode: 'local', errorCode: textError?.code || 'VOICE_TUTOR_TEXT_UNAVAILABLE',
        });
        return res.json(tracerResponse({ ...recorded, session: delivered.session, created: false }, capsule, {
          mode: 'local', nonce, local_rule: capsule.rule, clarification_turns: recorded.clarification_turns,
        }));
      }
    } catch (error) { return sendVoiceTutorError(error, res, next); }
  });

  router.post('/api/v1/voice-tutor/reports', auth, async (req, res, next) => {
    const parsed = parseReport(req.body);
    if (!parsed) return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    try {
      const result = await db.createVoiceTutorReport(req.user, {
        id: newSessionId(), sessionId: parsed.sessionId, reason: parsed.reason, createdAt: now(),
      });
      const report = structuredClone(result.report);
      delete report.username;
      return res.status(result.created ? 201 : 200).json({ created: result.created, report });
    } catch (error) { return sendVoiceTutorError(error, res, next); }
  });

  router.get('/api/v1/voice-tutor/reports', auth, requireAdmin, async (req, res, next) => {
    const status = String(req.query.status || 'pending');
    if (!['pending', 'confirmed', 'dismissed'].includes(status)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    try { return res.json({ reports: await db.listVoiceTutorReports({ status }) }); } catch (error) { return next(error); }
  });

  router.post('/api/v1/voice-tutor/reports/:reportId/review', auth, requireAdmin, async (req, res, next) => {
    const decision = req.body?.decision;
    if (!SESSION_ID.test(String(req.params.reportId || '')) || !req.body || typeof req.body !== 'object'
      || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !['confirmed', 'dismissed'].includes(decision)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR' } });
    }
    try {
      return res.json(await db.reviewVoiceTutorReport(req.params.reportId, { decision, reviewer: req.user, reviewedAt: now() }));
    } catch (error) { return sendVoiceTutorError(error, res, next); }
  });

  router.post('/api/v1/voice-tutor/sessions/:sessionId/fallback', auth, async (req, res, next) => {
    if (!SESSION_ID.test(req.params.sessionId)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный идентификатор голосового разбора.' } });
    }
    const fallbackReasons = new Set(['microphone_unavailable', 'provider_unavailable', 'session_timeout']);
    const keys = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? Object.keys(req.body) : [];
    const reason = req.body?.reason == null ? 'microphone_unavailable' : String(req.body.reason);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || keys.some((key) => !['nonce', 'reason'].includes(key)) || keys.length < 1 || keys.length > 2
      || !NONCE.test(String(req.body.nonce || '')) || !fallbackReasons.has(reason)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Передайте одноразовый nonce голосового разбора.' } });
    }
    const fallbackErrorCodes = {
      microphone_unavailable: 'VOICE_TUTOR_MICROPHONE_UNAVAILABLE',
      provider_unavailable: 'VOICE_TUTOR_PROVIDER_UNAVAILABLE',
      session_timeout: 'VOICE_TUTOR_SESSION_LIMIT_REACHED',
    };
    const nonce = newNonce();
    try {
      await realtimeProxy?.waitForSettlement?.(req.user, req.params.sessionId);
      const switched = await db.switchVoiceTutorSessionDelivery(req.user, req.params.sessionId, {
        nonceHash: nonceHash(String(req.body.nonce)),
        nextNonceHash: nonceHash(nonce),
        mode: 'text',
        limits,
        now: now(),
        errorCode: fallbackErrorCodes[reason],
      });
      const capsule = switched.capsule?.item
        ? switched.capsule
        : await rebuildSourceCapsule(db, req.user, switched.capsule, now());
      if (textTutor && await hasCurrentTextConsent(db, req.user, privacyPolicyVersion)) {
        try {
          const textTurn = await textTutor.createTurn({ capsule, state: switched.session.state, username: req.user });
          return res.json(tracerResponse({ ...switched, created: false }, capsule, { mode: 'text', nonce, text_turn: textTurn }));
        } catch {}
      }
      await db.setVoiceTutorSessionDelivery(req.user, req.params.sessionId, {
        mode: 'local',
        errorCode: reason === 'provider_unavailable' ? fallbackErrorCodes[reason] : 'VOICE_TUTOR_TEXT_UNAVAILABLE',
      });
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
