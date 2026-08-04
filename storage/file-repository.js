import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashAuthCode, normalizeUsername, normalizeVoiceTutorDeliveryMetadata, normalizeVoiceTutorProxyHash, subscriptionView, VoiceTutorError, voiceTutorAccessView, voiceTutorBillableSeconds, voiceTutorProxyUsage, voiceTutorQuotaPeriods, voiceTutorReservationSeconds } from './shared.js';
import { transitionPedagogicalState } from '../voice-tutor/state-machine.js';
import { transitionRuleCardReview } from '../voice-tutor/rule-card.js';
import { createRecoveryLedger, planRecoveryFromTransfer, planRepeatAttempt, publicRepeatAttempt, recoveryMap, recoveryMetrics } from '../voice-tutor/recovery.js';
import { requireModuleAttemptEvidenceQuality } from '../adaptive-learning/evidence-quality.js';
import { compareAdaptiveEvidenceWatermarks } from '../adaptive-learning/evidence-watermark.js';
import { adaptiveLearningGoalRepositoryDto } from '../adaptive-learning/goal-dto.js';
import {
  adaptiveLearningProfileExportDto,
  adaptiveLearningProfileRepositoryDto,
} from '../adaptive-learning/repository-dto.js';
import {
  adaptiveDiagnosticAnswerClaimRepositoryDto,
  adaptiveDiagnosticCompletionSnapshotDto,
  adaptiveDiagnosticExportDto,
  adaptiveDiagnosticRepositoryDto,
  adaptiveDiagnosticResponseExportDto,
  adaptiveDiagnosticStartClaimRepositoryDto,
} from '../adaptive-learning/diagnostic-dto.js';
import {
  ADAPTIVE_DIAGNOSTIC_START_CLAIM_LIMIT,
  adaptiveDiagnosticClaimExpiresAt,
} from '../adaptive-learning/diagnostic-claims.js';
import { adaptiveLearningPlanRepositoryDto } from '../adaptive-learning/plan-dto.js';
import {
  assertAdaptivePlanAuthoritativeCandidate,
  assertAdaptivePlanDuplicateReplay,
  assertAdaptivePlanPersistenceCandidate,
  assertAdaptivePlanStabilityTransition,
  compareAdaptivePlanInputs,
} from '../adaptive-learning/plan.js';

function normalizeAttemptModels(attempts) {
  return attempts.map((attempt) => ({ ...attempt, model: attempt.model ?? null }));
}

function normalizeWritingAttempts(attempts) {
  return normalizeAttemptModels(attempts).map((attempt) => ({
    ...attempt,
    evaluated_answer: attempt.evaluated_answer ?? attempt.answer ?? null,
  }));
}

function minimizeLegacyVoiceTutorCapsule(capsule) {
  if (!capsule || typeof capsule !== 'object' || Array.isArray(capsule)) return capsule;
  const referenceSchema = ['voice-tutor-reference-v1', 'voice-tutor-reference-legacy-v1'].includes(capsule.schema)
    ? capsule.schema
    : 'voice-tutor-reference-legacy-v1';
  const ruleId = capsule.rule_id ?? capsule.rule?.id;
  return {
    schema: referenceSchema,
    id: capsule.id,
    version: capsule.version,
    source: structuredClone(capsule.source),
    module: capsule.module,
    skill_id: capsule.skill_id ?? capsule.skill?.id,
    ...(ruleId ? { rule_id: ruleId } : {}),
    ...(capsule.rule_card_id ? { rule_card_id: capsule.rule_card_id } : {}),
  };
}

function reconcileLegacyApprovedRuleCards(cards) {
  const groups = new Map();
  for (const card of cards) {
    if (card?.status !== 'approved' || !card.skill?.id || !Number.isInteger(Number(card.exam_year))) continue;
    const key = `${card.skill.id}\u0000${Number(card.exam_year)}`;
    const group = groups.get(key) || [];
    group.push(card);
    groups.set(key, group);
  }
  let changed = false;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((first, second) => {
      const reviewed = String(second.reviewed_at || '').localeCompare(String(first.reviewed_at || ''));
      if (reviewed) return reviewed;
      const created = String(second.created_at || '').localeCompare(String(first.created_at || ''));
      return created || String(second.id || '').localeCompare(String(first.id || ''));
    });
    for (const duplicate of group.slice(1)) {
      duplicate.status = 'rejected';
      duplicate.review_audit = [...(Array.isArray(duplicate.review_audit) ? duplicate.review_audit : []), {
        reviewer: null,
        decision: 'rejected',
        reviewed_at: duplicate.reviewed_at || duplicate.created_at,
        reason: 'canonical_deduplicated_by_migration_029',
      }];
      changed = true;
    }
  }
  return changed;
}

export function createFileRepository(filePath) {
  let loaded = false;
  let state = { users: {}, progress: {}, progress_summary: {}, auth_codes: {}, writing_attempts: [], speaking_attempts: [], generated_tasks: [], task_bank: [], task_deliveries: [], module_attempts: [], word_progress: {}, error_bank: [], ai_requests: [], audit_log: [], sessions: {}, subscriptions: {}, subscription_entitlements: {}, voice_tutor_sessions: [], voice_tutor_recoveries: [], voice_tutor_repeats: [], voice_tutor_repeat_attempts: [], voice_tutor_reports: [], rule_cards: [], payment_requests: {}, subscription_events: [], adaptive_learning_goals: [], adaptive_learning_profiles: {}, adaptive_learning_skill_estimates: {}, adaptive_learning_plan_revisions: [], adaptive_diagnostic_sessions: [], adaptive_diagnostic_start_claims: [], adaptive_diagnostic_responses: [] };
  let writeQueue = Promise.resolve();
  let coordinatedMutationQueue = Promise.resolve();
  let paymentQueue = Promise.resolve();
  let ruleCardQueue = Promise.resolve();

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        let minimizedLegacyCapsule = false;
        state = {
          users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
          progress: parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {},
          progress_summary: parsed.progress_summary && typeof parsed.progress_summary === 'object' ? parsed.progress_summary : {},
          auth_codes: parsed.auth_codes && typeof parsed.auth_codes === 'object' ? parsed.auth_codes : {},
          writing_attempts: Array.isArray(parsed.writing_attempts) ? normalizeWritingAttempts(parsed.writing_attempts) : [],
          speaking_attempts: Array.isArray(parsed.speaking_attempts) ? normalizeAttemptModels(parsed.speaking_attempts) : [],
          generated_tasks: Array.isArray(parsed.generated_tasks) ? parsed.generated_tasks : [],
          task_bank: Array.isArray(parsed.task_bank) ? parsed.task_bank : [],
          task_deliveries: Array.isArray(parsed.task_deliveries) ? parsed.task_deliveries : [],
          module_attempts: Array.isArray(parsed.module_attempts) ? parsed.module_attempts : [],
          word_progress: parsed.word_progress && typeof parsed.word_progress === 'object' ? parsed.word_progress : {},
          error_bank: Array.isArray(parsed.error_bank) ? parsed.error_bank : [],
          ai_requests: Array.isArray(parsed.ai_requests) ? parsed.ai_requests : [],
          audit_log: Array.isArray(parsed.audit_log) ? parsed.audit_log : [],
          sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
          subscriptions: parsed.subscriptions && typeof parsed.subscriptions === 'object' ? parsed.subscriptions : {},
          subscription_entitlements: parsed.subscription_entitlements && typeof parsed.subscription_entitlements === 'object' ? parsed.subscription_entitlements : {},
          voice_tutor_sessions: Array.isArray(parsed.voice_tutor_sessions) ? parsed.voice_tutor_sessions.map((session) => {
            const capsule = minimizeLegacyVoiceTutorCapsule(session.capsule);
            if (capsule !== session.capsule) minimizedLegacyCapsule = true;
            return {
              ...session, capsule,
              voice_activated_at: session.voice_activated_at ?? null,
              micro_check_attempts: Number(session.micro_check_attempts || 0),
              micro_check_passes: Number(session.micro_check_passes || 0),
              clarification_turns: Number(session.clarification_turns || 0),
              discovery_status: session.discovery_status ?? null,
              discovery_claim_id: session.discovery_claim_id ?? null,
              discovery_error_code: session.discovery_error_code ?? null,
              proxy_ticket_reissue_count: Number(session.proxy_ticket_reissue_count || 0),
            };
          }) : [],
          voice_tutor_recoveries: Array.isArray(parsed.voice_tutor_recoveries) ? parsed.voice_tutor_recoveries : [],
          voice_tutor_repeats: Array.isArray(parsed.voice_tutor_repeats) ? parsed.voice_tutor_repeats : [],
          voice_tutor_repeat_attempts: Array.isArray(parsed.voice_tutor_repeat_attempts) ? parsed.voice_tutor_repeat_attempts : [],
          voice_tutor_reports: Array.isArray(parsed.voice_tutor_reports) ? parsed.voice_tutor_reports : [],
          rule_cards: Array.isArray(parsed.rule_cards) ? parsed.rule_cards : [],
          payment_requests: parsed.payment_requests && typeof parsed.payment_requests === 'object' ? parsed.payment_requests : {},
          subscription_events: Array.isArray(parsed.subscription_events) ? parsed.subscription_events : [],
          adaptive_learning_goals: Array.isArray(parsed.adaptive_learning_goals) ? parsed.adaptive_learning_goals : [],
          adaptive_learning_profiles: parsed.adaptive_learning_profiles && typeof parsed.adaptive_learning_profiles === 'object' ? parsed.adaptive_learning_profiles : {},
          adaptive_learning_skill_estimates: parsed.adaptive_learning_skill_estimates && typeof parsed.adaptive_learning_skill_estimates === 'object' ? parsed.adaptive_learning_skill_estimates : {},
          adaptive_learning_plan_revisions: Array.isArray(parsed.adaptive_learning_plan_revisions) ? parsed.adaptive_learning_plan_revisions : [],
          adaptive_diagnostic_sessions: Array.isArray(parsed.adaptive_diagnostic_sessions) ? parsed.adaptive_diagnostic_sessions : [],
          adaptive_diagnostic_start_claims: Array.isArray(parsed.adaptive_diagnostic_start_claims) ? parsed.adaptive_diagnostic_start_claims : [],
          adaptive_diagnostic_responses: Array.isArray(parsed.adaptive_diagnostic_responses) ? parsed.adaptive_diagnostic_responses : [],
        };
        const reconciledLegacyCanonical = reconcileLegacyApprovedRuleCards(state.rule_cards);
        if (minimizedLegacyCapsule || reconciledLegacyCanonical) await persist();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    writeQueue = writeQueue.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${process.pid}.tmp`;
      await fs.writeFile(temporary, snapshot, 'utf8');
      await fs.rename(temporary, filePath);
    });
    return writeQueue;
  }

  async function getUser(username) {
    await load();
    return state.users[username] ? { username, ...state.users[username] } : null;
  }

  async function createUser(username, hash) {
    await load();
    if (state.users[username]) throw new Error('USER_EXISTS');
    state.users[username] = { hash, role: 'student', created: Date.now() };
    state.progress[username] ||= {};
    await persist();
    return { username, ...state.users[username] };
  }

  async function getProgress(username) {
    await load();
    return structuredClone(state.progress[username] || {});
  }

  async function saveProgress(username, data) {
    await load();
    state.progress[username] = structuredClone(data || {});
    await persist();
  }

  async function mergeProgress(username, modules) {
    await load();
    state.progress[username] = { ...(state.progress[username] || {}), ...structuredClone(modules || {}) };
    await persist();
    return structuredClone(state.progress[username]);
  }

  async function getUserByTelegram(telegramId) {
    await load();
    const id = String(telegramId);
    for (const [username, user] of Object.entries(state.users)) {
      if (String(user.telegram_id) === id) return { username, ...user };
    }
    return null;
  }

  async function createTelegramUser(telegramId, displayName) {
    await load();
    const existing = await getUserByTelegram(telegramId);
    if (existing) return existing.username;
    const base = normalizeUsername(displayName, telegramId);
    let username = base;
    let suffix = 1;
    while (state.users[username]) username = `${base.slice(0, 16)}_${suffix++}`;
    state.users[username] = { telegram_id: Number(telegramId), role: 'student', created: Date.now() };
    state.progress[username] ||= {};
    await persist();
    return username;
  }

  async function ensureTelegramUser(telegramId, displayName) {
    const existing = await getUserByTelegram(telegramId);
    return existing ? existing.username : createTelegramUser(telegramId, displayName);
  }

  async function grantDays(telegramId, days, displayName) {
    await load();
    const username = await ensureTelegramUser(telegramId, displayName);
    const user = state.users[username];
    const now = Date.now();
    user.sub_until = Math.max(now, Number(user.sub_until || 0)) + Number(days) * 86_400_000;
    state.subscriptions[username] = { status: 'active', source: displayName ? 'trial' : 'manual', starts_at: now, ends_at: user.sub_until, updated_at: now };
    await persist();
    return { username, sub_until: user.sub_until };
  }

  function serializePaymentMutation(run) {
    const result = paymentQueue.then(run, run);
    paymentQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function paymentRequestView(request) {
    return request ? { ...structuredClone(request), product: request.product || 'base' } : null;
  }

  async function createPaymentRequestForUser(id, username, product = 'base', { now = new Date() } = {}) {
    return serializePaymentMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      if (!['base', 'premium_voice'].includes(product)) throw new Error('INVALID_PAYMENT_PRODUCT');
      const existing = Object.values(state.payment_requests).find((request) => request.username === username
        && (request.product || 'base') === product && request.status === 'new');
      if (existing) return paymentRequestView(existing);
      if (state.payment_requests[id]) throw new Error('PAYMENT_REQUEST_ID_CONFLICT');
      const request = { id, username, product, status: 'new', created_at: new Date(now).getTime() };
      state.payment_requests[id] = request;
      await persist();
      return paymentRequestView(request);
    });
  }

  async function createPaymentRequest(id, telegramId, displayName, options = {}) {
    const username = await ensureTelegramUser(telegramId, displayName);
    return createPaymentRequestForUser(id, username, options.product || 'base', options);
  }

  async function getPaymentRequestForUser(username, product = 'premium_voice') {
    await load();
    const requests = Object.values(state.payment_requests).filter((request) => request.username === username
      && (request.product || 'base') === product);
    return paymentRequestView(requests.at(-1));
  }

  async function listPaymentRequests({ product = 'premium_voice', status = 'new' } = {}) {
    await load();
    if (!['base', 'premium_voice'].includes(product) || !['new', 'approved', 'rejected', 'cancelled'].includes(status)) {
      throw new Error('INVALID_PAYMENT_FILTER');
    }
    return Object.values(state.payment_requests)
      .filter((request) => (request.product || 'base') === product && request.status === status)
      .sort((left, right) => Number(left.created_at) - Number(right.created_at))
      .map(paymentRequestView);
  }

  async function resolvePaymentRequest(id, decision, actorTelegramId, days, { now = new Date() } = {}) {
    return serializePaymentMutation(async () => {
      await load();
      if (!['approved', 'rejected', 'cancelled'].includes(decision)) throw new Error('INVALID_PAYMENT_DECISION');
      const requestedDays = Number(days);
      if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 365) throw new Error('INVALID_SUBSCRIPTION_PERIOD');
      const request = state.payment_requests[id];
      if (!request) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
      const user = state.users[request.username];
      const product = request.product || 'base';
      if (request.status !== 'new') return { applied: false, status: request.status, product, username: request.username, telegram_id: user.telegram_id, sub_until: user.sub_until || 0 };
      if (decision === 'approved' && Number(actorTelegramId) === Number(user.telegram_id)) {
        throw new Error('PAYMENT_SELF_APPROVAL_FORBIDDEN');
      }
      const instant = new Date(now).getTime();
      if (!Number.isFinite(instant)) throw new Error('INVALID_PAYMENT_TIME');
      if (decision === 'approved') {
        user.sub_until = Math.max(instant, Number(user.sub_until || 0)) + requestedDays * 86_400_000;
        state.subscriptions[request.username] = { status: 'active', source: 'manual', starts_at: instant, ends_at: user.sub_until, updated_at: instant };
        if (product === 'premium_voice') {
          const existing = state.subscription_entitlements[request.username]?.voice_tutor;
          state.subscription_entitlements[request.username] ||= {};
          state.subscription_entitlements[request.username].voice_tutor = {
            starts_at: existing?.starts_at && new Date(existing.starts_at).getTime() < instant
              ? existing.starts_at
              : new Date(instant).toISOString(),
            ends_at: new Date(user.sub_until).toISOString(),
          };
        }
        state.subscription_events.push({
          username: request.username,
          event_type: product === 'premium_voice' ? 'premium_payment_approved' : 'payment_approved',
          days: requestedDays,
          actor_telegram_id: Number(actorTelegramId),
          metadata: { payment_request_id: id, ...(product === 'premium_voice' ? { product } : {}) },
          created_at: instant,
        });
      }
      request.product = product;
      request.status = decision;
      request.actor_telegram_id = Number(actorTelegramId);
      request.result = decision;
      request.resolved_at = instant;
      state.audit_log.push({ id: (state.audit_log.at(-1)?.id || 0) + 1, actor_telegram_id: Number(actorTelegramId), action: 'payment.resolve', target_type: 'payment_request', target_id: id, result: decision, metadata: { username: request.username, product, days: decision === 'approved' ? requestedDays : 0 }, created_at: instant });
      await persist();
      return { applied: true, status: decision, product, username: request.username, telegram_id: user.telegram_id, sub_until: user.sub_until || 0 };
    });
  }

  async function revokeEntitlement(username, entitlement, actorTelegramId, { now = new Date() } = {}) {
    return serializePaymentMutation(async () => {
      await load();
      if (entitlement !== 'voice_tutor') throw new Error('INVALID_ENTITLEMENT');
      const period = state.subscription_entitlements[username]?.[entitlement];
      const instant = new Date(now).getTime();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const active = period && new Date(period.starts_at).getTime() < instant
        && (period.ends_at == null || new Date(period.ends_at).getTime() > instant);
      if (!active) return false;
      period.ends_at = new Date(instant).toISOString();
      state.subscription_events.push({ username, event_type: 'premium_revoked', days: 0, actor_telegram_id: Number(actorTelegramId), metadata: { entitlement }, created_at: instant });
      state.audit_log.push({ id: (state.audit_log.at(-1)?.id || 0) + 1, actor_telegram_id: Number(actorTelegramId), action: 'entitlement.revoke', target_type: 'subscription_entitlement', target_id: entitlement, result: 'revoked', metadata: { username }, created_at: instant });
      await persist();
      return true;
    });
  }

  async function markTrialUsed(telegramId, displayName) {
    await load();
    const username = await ensureTelegramUser(telegramId, displayName);
    state.users[username].trial_used = true;
    await persist();
    return username;
  }

  async function activateTrial(telegramId, days, displayName) {
    await load();
    const username = await ensureTelegramUser(telegramId, displayName);
    const user = state.users[username];
    if (user.trial_used) return { applied: false, username, sub_until: user.sub_until || 0 };
    const now = Date.now();
    user.trial_used = true;
    user.sub_until = Math.max(now, Number(user.sub_until || 0)) + Number(days) * 86_400_000;
    state.subscriptions[username] = { status: 'active', source: 'trial', starts_at: now, ends_at: user.sub_until, updated_at: now };
    state.subscription_events.push({ username, event_type: 'trial_activated', days: Number(days), actor_telegram_id: Number(telegramId), metadata: {}, created_at: now });
    await persist();
    return { applied: true, username, sub_until: user.sub_until };
  }

  async function getSub(username) {
    return subscriptionView(await getUser(username));
  }

  async function setEntitlement(username, entitlement, { startsAt = new Date(), endsAt = null } = {}) {
    await load();
    if (!state.users[username]) throw new Error('USER_NOT_FOUND');
    if (!/^[a-z0-9_]{1,64}$/u.test(entitlement)) throw new Error('INVALID_ENTITLEMENT');
    const startsAtMs = new Date(startsAt).getTime();
    const endsAtMs = endsAt == null ? null : new Date(endsAt).getTime();
    if (!Number.isFinite(startsAtMs) || (endsAtMs != null && (!Number.isFinite(endsAtMs) || endsAtMs <= startsAtMs))) {
      throw new Error('INVALID_ENTITLEMENT_PERIOD');
    }
    state.subscription_entitlements[username] ||= {};
    state.subscription_entitlements[username][entitlement] = {
      starts_at: new Date(startsAtMs).toISOString(),
      ends_at: endsAtMs == null ? null : new Date(endsAtMs).toISOString(),
    };
    await persist();
  }

  function hasVoiceTutorEntitlement(username, nowMs) {
    const entitlement = state.subscription_entitlements[username]?.voice_tutor;
    return Number(state.users[username]?.sub_until || 0) > nowMs
      && Boolean(entitlement)
      && new Date(entitlement.starts_at).getTime() <= nowMs
      && (entitlement.ends_at == null || new Date(entitlement.ends_at).getTime() > nowMs);
  }

  function voiceTutorUsage(username, now) {
    const nowMs = new Date(now).getTime();
    const { dayStart, monthStart } = voiceTutorQuotaPeriods(now);
    const sessions = state.voice_tutor_sessions.filter((session) => session.username === username);
    const billableSeconds = (session) => Number(session.billable_seconds ?? session.reserved_seconds ?? 0);
    return {
      dailyUsedSeconds: sessions
        .filter((session) => new Date(session.started_at).getTime() >= dayStart.getTime())
        .reduce((total, session) => total + billableSeconds(session), 0),
      monthlyUsedSeconds: sessions
        .filter((session) => new Date(session.started_at).getTime() >= monthStart.getTime())
        .reduce((total, session) => total + billableSeconds(session), 0),
      activeSession: sessions.some((session) => session.status === 'active' && new Date(session.expires_at).getTime() > nowMs),
    };
  }

  function expireVoiceTutorSessions(username, now) {
    const nowMs = new Date(now).getTime();
    let changed = false;
    for (const session of state.voice_tutor_sessions) {
      if (session.username !== username || session.status !== 'active' || new Date(session.expires_at).getTime() > nowMs) continue;
      session.status = 'expired';
      if (session.proxy_ticket_consumed_at && !session.proxy_finalized_at) {
        const usage = voiceTutorProxyUsage(session, {
          inputAudioBytes: Number(session.proxy_input_audio_bytes || 0),
          outputAudioBytes: Number(session.proxy_output_audio_bytes || 0),
          confirmed: false,
          reason: 'timeout',
          now: session.expires_at,
        });
        session.billable_seconds = usage.billable_seconds;
        session.proxy_input_audio_bytes = usage.input_audio_bytes;
        session.proxy_output_audio_bytes = usage.output_audio_bytes;
        session.proxy_usage_confirmed = usage.confirmed;
        session.proxy_finalization_reason = usage.reason;
        session.proxy_finalized_at = usage.finalized_at;
      } else {
        session.billable_seconds = voiceTutorBillableSeconds(session, session.expires_at);
      }
      session.ended_at = session.expires_at;
      if (session.capsule) {
        if (!['resolved', 'fallback', 'ended'].includes(session.pedagogical_state)) {
          session.pedagogical_state = 'ended';
          session.outcome = 'ended';
        }
        session.nonce_hash = null;
      }
      changed = true;
    }
    return changed;
  }

  function serializeCoordinatedMutation(run) {
    const result = coordinatedMutationQueue.then(run, run);
    coordinatedMutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function serializeVoiceTutorMutation(run) { return serializeCoordinatedMutation(run); }

  function publicVoiceTutorSession(session) {
    return {
      id: session.id,
      status: session.status,
      state: session.pedagogical_state || null,
      micro_check_passed: session.micro_check_passed ?? null,
      transfer_passed: session.transfer_passed ?? null,
      outcome: session.outcome ?? null,
      started_at: session.started_at,
      expires_at: session.expires_at,
      ended_at: session.ended_at,
    };
  }

  async function getVoiceTutorAccess(username, limits, now = new Date()) {
    await load();
    const nowMs = new Date(now).getTime();
    return voiceTutorAccessView({ entitled: hasVoiceTutorEntitlement(username, nowMs), ...voiceTutorUsage(username, now) }, limits);
  }

  async function reserveVoiceTutorSession(username, {
    id, idempotencyKey, limits, now = new Date(), context = null, allowFallbackOnly = false,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const expired = expireVoiceTutorSessions(username, now);
      const existing = state.voice_tutor_sessions.find((session) => session.username === username && session.idempotency_key === idempotencyKey);
      if (existing) {
        if (expired) await persist();
        return { created: false, session: publicVoiceTutorSession(existing), ...await getVoiceTutorAccess(username, limits, now) };
      }
      const usage = voiceTutorUsage(username, now);
      const access = voiceTutorAccessView({ entitled: hasVoiceTutorEntitlement(username, new Date(now).getTime()), ...usage }, limits);
      let reservedSeconds;
      let fallbackOnly = false;
      try {
        reservedSeconds = voiceTutorReservationSeconds(access, limits.sessionSeconds);
      } catch (error) {
        if (!context || !allowFallbackOnly || !['VOICE_TUTOR_DAILY_QUOTA_EXHAUSTED', 'VOICE_TUTOR_MONTHLY_QUOTA_EXHAUSTED'].includes(error?.code)) throw error;
        reservedSeconds = 0;
        fallbackOnly = true;
      }
      const startedAt = new Date(now);
      const session = {
        id,
        username,
        idempotency_key: idempotencyKey,
        status: 'active',
        reserved_seconds: reservedSeconds,
        billable_seconds: null,
        started_at: startedAt.toISOString(),
        expires_at: new Date(startedAt.getTime() + (fallbackOnly ? limits.sessionSeconds : reservedSeconds) * 1000).toISOString(),
        ended_at: null,
        ...(context ? {
          capsule: structuredClone(context.capsule),
          capsule_id: context.capsule.id,
          nonce_hash: context.nonceHash,
          delivery_mode: fallbackOnly ? 'local' : 'voice',
          voice_activated_at: null,
          provider: null,
          model: null,
          prompt_version: null,
          proxy_ticket_reissue_count: 0,
          pedagogical_state: 'diagnose',
          micro_check_passed: null,
          micro_check_attempts: 0,
          micro_check_passes: 0,
          clarification_turns: 0,
          transfer_passed: null,
          outcome: null,
        } : {}),
      };
      state.voice_tutor_sessions.push(session);
      await persist();
      return {
        created: true, fallback_only: fallbackOnly,
        session: publicVoiceTutorSession(session), ...await getVoiceTutorAccess(username, limits, now),
      };
    });
  }

  async function getVoiceTutorSession(username, sessionId) {
    await load();
    const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
    return session ? structuredClone(session) : null;
  }

  async function activateVoiceTutorSession(username, sessionId, { nonceHash, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session || !session.capsule || session.delivery_mode !== 'voice' || session.status !== 'active') {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      }
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      const nowMs = new Date(now).getTime();
      if (nowMs < new Date(session.started_at).getTime() || new Date(session.expires_at).getTime() <= nowMs) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      if (!session.voice_activated_at) {
        session.voice_activated_at = new Date(now).toISOString();
        session.updated_at = session.voice_activated_at;
        await persist();
      }
      return { session: publicVoiceTutorSession(session), capsule: structuredClone(session.capsule) };
    });
  }

  function proxyTicketView(session) {
    return {
      session_id: session.id,
      expires_at: session.proxy_ticket_expires_at,
      consumed_at: session.proxy_ticket_consumed_at || null,
    };
  }

  async function issueVoiceTutorProxyTicket(username, sessionId, {
    ticketHash, idempotencyKey, expiresAt, now = new Date(), reissue = false, nextNonceHash,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const instant = new Date(now);
      const ticketExpiresAt = new Date(expiresAt);
      const hash = normalizeVoiceTutorProxyHash(ticketHash);
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (session.idempotency_key !== idempotencyKey) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      if (session.status !== 'active' || !Number.isFinite(instant.getTime())
        || new Date(session.expires_at).getTime() <= instant.getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      if (!Number.isFinite(ticketExpiresAt.getTime()) || ticketExpiresAt.getTime() <= instant.getTime()
        || ticketExpiresAt.getTime() > new Date(session.expires_at).getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      }
      if (session.proxy_ticket_hash === hash) {
        return { issued: false, reissued: false, ticket: proxyTicketView(session) };
      }
      const replacing = Boolean(session.proxy_ticket_hash);
      const rotatingNonce = nextNonceHash != null;
      if (replacing && !reissue) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_ALREADY_ISSUED');
      if (replacing && session.proxy_ticket_consumed_at) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REPLAYED');
      if ((replacing || rotatingNonce) && Number(session.proxy_ticket_reissue_count || 0) >= 1) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT');
      }
      if (state.voice_tutor_sessions.some((entry) => entry.id !== session.id && entry.proxy_ticket_hash === hash)) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      }
      if (rotatingNonce) session.nonce_hash = normalizeVoiceTutorProxyHash(nextNonceHash);
      if (replacing || rotatingNonce) session.proxy_ticket_reissue_count = Number(session.proxy_ticket_reissue_count || 0) + 1;
      session.proxy_ticket_hash = hash;
      session.proxy_ticket_issued_at = instant.toISOString();
      session.proxy_ticket_expires_at = ticketExpiresAt.toISOString();
      session.proxy_ticket_consumed_at = null;
      session.updated_at = instant.toISOString();
      await persist();
      return { issued: true, reissued: replacing, ticket: proxyTicketView(session) };
    });
  }

  async function reissueVoiceTutorFallbackNonce(username, sessionId, {
    idempotencyKey, nextNonceHash, now = new Date(), recoverLostRealtime = false,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      const provisionalVoice = session?.delivery_mode === 'voice' && !session.proxy_ticket_hash && !session.voice_activated_at;
      const lostRealtime = recoverLostRealtime && session?.delivery_mode === 'voice'
        && Boolean(session.proxy_ticket_hash) && !session.proxy_ticket_consumed_at && !session.voice_activated_at
        && Number(session.proxy_ticket_reissue_count || 0) === 1 && session.status === 'active';
      if (!session?.capsule || (!provisionalVoice && !lostRealtime
        && ![null, undefined, 'text', 'local'].includes(session.delivery_mode))) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      }
      if (session.idempotency_key !== idempotencyKey) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      if (!lostRealtime && Number(session.proxy_ticket_reissue_count || 0) >= 1) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT');
      }
      session.nonce_hash = normalizeVoiceTutorProxyHash(nextNonceHash);
      if (!lostRealtime) session.proxy_ticket_reissue_count = Number(session.proxy_ticket_reissue_count || 0) + 1;
      const recoveredAt = new Date(now).toISOString();
      if (session.delivery_mode == null || provisionalVoice || lostRealtime) {
        session.delivery_mode = 'local';
        session.status = 'completed';
        session.billable_seconds = 0;
        session.ended_at = recoveredAt;
        session.error_code = 'VOICE_TUTOR_PROVIDER_UNAVAILABLE';
      }
      if (lostRealtime) {
        session.proxy_ticket_hash = null;
        session.proxy_ticket_issued_at = null;
        session.proxy_ticket_expires_at = null;
        session.proxy_ticket_consumed_at = null;
      }
      session.updated_at = recoveredAt;
      await persist();
      return { reissued: true, session: publicVoiceTutorSession(session) };
    });
  }

  async function consumeVoiceTutorProxyTicket(username, input, options = {}) {
    const { ticketHash, now = new Date(), provider, model, promptVersion } = { ...input, ...options };
    return serializeVoiceTutorMutation(async () => {
      await load();
      const hash = normalizeVoiceTutorProxyHash(ticketHash);
      const instant = new Date(now);
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username
        && entry.proxy_ticket_hash === hash);
      if (!session) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      if (session.proxy_ticket_consumed_at) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REPLAYED');
      if (!Number.isFinite(instant.getTime()) || new Date(session.proxy_ticket_expires_at).getTime() <= instant.getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_EXPIRED');
      }
      if (session.status !== 'active' || new Date(session.expires_at).getTime() <= instant.getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      const metadata = normalizeVoiceTutorDeliveryMetadata({ provider, model, promptVersion });
      session.proxy_ticket_consumed_at = instant.toISOString();
      session.provider = metadata.provider;
      session.model = metadata.model;
      session.prompt_version = metadata.prompt_version;
      session.updated_at = instant.toISOString();
      await persist();
      return {
        session: { id: session.id, reserved_seconds: session.reserved_seconds, expires_at: session.expires_at },
        capsule: structuredClone(session.capsule),
      };
    });
  }

  async function activateVoiceTutorProxySession(username, sessionId, { now = new Date() } = {}) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const instant = new Date(now);
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (!session.proxy_ticket_consumed_at || session.proxy_finalized_at) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      }
      if (session.status !== 'active' || !Number.isFinite(instant.getTime())
        || instant.getTime() < new Date(session.started_at).getTime()
        || new Date(session.expires_at).getTime() <= instant.getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      const activated = !session.voice_activated_at;
      if (activated) {
        session.voice_activated_at = instant.toISOString();
        session.updated_at = instant.toISOString();
        await persist();
      }
      return {
        activated,
        session: { id: session.id, reserved_seconds: session.reserved_seconds, expires_at: session.expires_at },
        capsule: structuredClone(session.capsule),
      };
    });
  }

  function proxyUsageView(session) {
    return {
      input_audio_bytes: Number(session.proxy_input_audio_bytes || 0),
      output_audio_bytes: Number(session.proxy_output_audio_bytes || 0),
      confirmed: Boolean(session.proxy_usage_confirmed),
      exact: Boolean(session.proxy_usage_confirmed) && session.proxy_finalization_reason === 'completed',
      billable_seconds: Number(session.billable_seconds),
      reason: session.proxy_finalization_reason,
      finalized_at: session.proxy_finalized_at,
    };
  }

  async function finalizeVoiceTutorProxySession(username, sessionId, {
    inputAudioBytes, outputAudioBytes, confirmed, reason, now = new Date(), limits,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (!session.proxy_ticket_consumed_at) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      if (session.proxy_finalized_at) {
        return {
          finalized: false, session: publicVoiceTutorSession(session), usage: proxyUsageView(session),
          ...await getVoiceTutorAccess(username, limits, now),
        };
      }
      const usage = voiceTutorProxyUsage(session, { inputAudioBytes, outputAudioBytes, confirmed, reason, now });
      session.status = 'completed';
      session.billable_seconds = usage.billable_seconds;
      session.ended_at = usage.finalized_at;
      session.proxy_input_audio_bytes = usage.input_audio_bytes;
      session.proxy_output_audio_bytes = usage.output_audio_bytes;
      session.proxy_usage_confirmed = usage.confirmed;
      session.proxy_finalization_reason = usage.reason;
      session.proxy_finalized_at = usage.finalized_at;
      session.updated_at = usage.finalized_at;
      await persist();
      return {
        finalized: true, session: publicVoiceTutorSession(session), usage,
        ...await getVoiceTutorAccess(username, limits, now),
      };
    });
  }

  async function advanceVoiceTutorSession(username, sessionId, { nonceHash, nextNonceHash, event, capsule = null, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session || !session.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (session.delivery_mode === 'voice' && new Date(session.expires_at).getTime() <= new Date(now).getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      const transientCapsule = capsule || session.capsule;
      if (transientCapsule.id !== session.capsule_id || transientCapsule.version !== session.capsule.version) {
        throw new VoiceTutorError('VOICE_TUTOR_REVISION_MISMATCH');
      }
      const evaluatedMicroCheck = session.pedagogical_state === 'micro_check' && event?.type === 'check_answer';
      const next = transitionPedagogicalState({
        state: session.pedagogical_state,
        micro_check_passed: session.micro_check_passed,
        transfer_passed: session.transfer_passed,
        outcome: session.outcome,
      }, event, transientCapsule);
      session.pedagogical_state = next.state;
      session.micro_check_passed = next.micro_check_passed;
      session.transfer_passed = next.transfer_passed;
      session.outcome = next.outcome;
      if (evaluatedMicroCheck) {
        const attempts = Number(session.micro_check_attempts || 0);
        if (attempts < 100) {
          session.micro_check_attempts = attempts + 1;
          if (next.micro_check_passed) session.micro_check_passes = Number(session.micro_check_passes || 0) + 1;
        }
      }
      session.nonce_hash = nextNonceHash;
      session.updated_at = new Date(now).toISOString();
      if (event?.type === 'transfer_answer') {
        const plan = planRecoveryFromTransfer({
          ledger: createRecoveryLedger({
            recoveries: state.voice_tutor_recoveries,
            repeats: state.voice_tutor_repeats,
            attempts: state.voice_tutor_repeat_attempts,
          }),
          username,
          sessionId: session.id,
          capsule: transientCapsule,
          pedagogicalState: next,
          observedAt: now,
        });
        if (plan) {
          const superseded = new Set(plan.supersededRepeatIds);
          for (const repeat of state.voice_tutor_repeats) {
            if (superseded.has(repeat.id)) repeat.superseded_at = new Date(now).toISOString();
          }
          state.voice_tutor_recoveries.push({ ...plan.recovery });
          state.voice_tutor_repeats.push(...plan.repeats.map((repeat) => ({ ...repeat })));
        }
      }
      await persist();
      return { session: publicVoiceTutorSession(session), capsule: structuredClone(session.capsule) };
    });
  }

  async function clarifyVoiceTutorSession(username, sessionId, { nonceHash, nextNonceHash, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (session.delivery_mode !== 'text' || !['diagnose', 'explain'].includes(session.pedagogical_state)) {
        throw new VoiceTutorError('VOICE_TUTOR_TRANSITION_INVALID');
      }
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      if (Number(session.clarification_turns || 0) >= 3) throw new VoiceTutorError('VOICE_TUTOR_CLARIFICATION_LIMIT');
      session.clarification_turns = Number(session.clarification_turns || 0) + 1;
      session.nonce_hash = nextNonceHash;
      session.updated_at = new Date(now).toISOString();
      await persist();
      return { session: publicVoiceTutorSession(session), capsule: structuredClone(session.capsule), clarification_turns: session.clarification_turns };
    });
  }

  async function submitVoiceTutorRepeat(username, repeatId, { attemptId, taskId, answer, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const plan = planRepeatAttempt({
        ledger: createRecoveryLedger({
          recoveries: state.voice_tutor_recoveries,
          repeats: state.voice_tutor_repeats,
          attempts: state.voice_tutor_repeat_attempts,
        }),
        username, repeatId, attemptId, taskId, answer, now,
      });
      if (!plan.created) return { created: false, attempt: publicRepeatAttempt(plan.attempt) };
      state.voice_tutor_repeat_attempts.push({ ...plan.attempt });
      if (plan.daySevenReschedule) {
        const daySeven = state.voice_tutor_repeats.find((entry) => entry.id === plan.daySevenReschedule.repeatId);
        daySeven.due_at = plan.daySevenReschedule.dueAt;
        daySeven.window_ends_at = plan.daySevenReschedule.windowEndsAt;
      }
      await persist();
      return { created: true, attempt: publicRepeatAttempt(plan.attempt) };
    });
  }

  async function getVoiceTutorRecoveryMap(username, { limits, now = new Date() }) {
    await load();
    const recoveries = state.voice_tutor_recoveries.filter((entry) => entry.username === username);
    const recoveryIds = new Set(recoveries.map((entry) => entry.id));
    const repeats = state.voice_tutor_repeats.filter((entry) => recoveryIds.has(entry.recovery_id));
    const repeatIds = new Set(repeats.map((entry) => entry.id));
    const attempts = state.voice_tutor_repeat_attempts.filter((entry) => repeatIds.has(entry.repeat_id));
    const usage = voiceTutorUsage(username, now);
    const access = await getVoiceTutorAccess(username, limits, now);
    return recoveryMap({
      ledger: createRecoveryLedger({ recoveries, repeats, attempts }),
      access,
      monthlyUsedSeconds: usage.monthlyUsedSeconds,
      now,
    });
  }

  async function getVoiceTutorRecoveryMetrics(now = new Date(), { costMicrousdPerMinute = 0 } = {}) {
    await load();
    const delivery = { voice: 0, text: 0, local: 0 };
    for (const session of state.voice_tutor_sessions) {
      if (Object.hasOwn(delivery, session.delivery_mode)) delivery[session.delivery_mode] += 1;
    }
    return recoveryMetrics({
      ledger: createRecoveryLedger({
        recoveries: state.voice_tutor_recoveries,
        repeats: state.voice_tutor_repeats,
        attempts: state.voice_tutor_repeat_attempts,
      }),
      billableSeconds: state.voice_tutor_sessions.reduce((sum, session) => (
        session.delivery_mode === 'voice' || session.provider
          ? sum + Number(session.billable_seconds || 0)
          : sum
      ), 0),
      sessionCount: state.voice_tutor_sessions.length,
      microCheckPasses: state.voice_tutor_sessions.reduce((sum, session) => sum + Number(session.micro_check_passes || 0), 0),
      microCheckAttempts: state.voice_tutor_sessions.reduce((sum, session) => sum + Number(session.micro_check_attempts || 0), 0),
      delivery,
      providerErrors: state.voice_tutor_sessions.filter((session) => (
        session.error_code === 'VOICE_TUTOR_PROVIDER_UNAVAILABLE'
        || session.error_code === 'VOICE_TUTOR_PROVIDER_CONTRACT_INVALID'
      )).length,
      costMicrousdPerMinute,
      now,
    });
  }

  async function setVoiceTutorSessionDelivery(username, sessionId, {
    mode, errorCode = null, provider, model, promptVersion,
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!['voice', 'text', 'local'].includes(mode)) throw new VoiceTutorError('VOICE_TUTOR_DELIVERY_INVALID');
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session || !session.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      const metadataProvided = provider !== undefined || model !== undefined || promptVersion !== undefined;
      const metadata = metadataProvided ? normalizeVoiceTutorDeliveryMetadata({ provider, model, promptVersion }) : null;
      session.delivery_mode = mode;
      session.error_code = errorCode;
      if (metadata) {
        session.provider = metadata.provider;
        session.model = metadata.model;
        session.prompt_version = metadata.prompt_version;
      }
      await persist();
      return { session: publicVoiceTutorSession(session), capsule: structuredClone(session.capsule) };
    });
  }

  async function switchVoiceTutorSessionDelivery(username, sessionId, { nonceHash, nextNonceHash, mode, limits, now = new Date(), errorCode = null }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!['text', 'local'].includes(mode)) throw new VoiceTutorError('VOICE_TUTOR_DELIVERY_INVALID');
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session || !session.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      if (session.status === 'active') {
        session.status = 'completed';
        if (session.proxy_ticket_consumed_at && !session.proxy_finalized_at) {
          const usage = voiceTutorProxyUsage(session, {
            inputAudioBytes: Number(session.proxy_input_audio_bytes || 0),
            outputAudioBytes: Number(session.proxy_output_audio_bytes || 0),
            confirmed: false,
            reason: 'runtime_fallback',
            now,
          });
          session.billable_seconds = usage.billable_seconds;
          session.proxy_input_audio_bytes = usage.input_audio_bytes;
          session.proxy_output_audio_bytes = usage.output_audio_bytes;
          session.proxy_usage_confirmed = usage.confirmed;
          session.proxy_finalization_reason = usage.reason;
          session.proxy_finalized_at = usage.finalized_at;
          session.ended_at = usage.finalized_at;
        } else {
          session.billable_seconds = voiceTutorBillableSeconds(session, now);
          session.ended_at = new Date(now).toISOString();
        }
      }
      session.delivery_mode = mode;
      session.error_code = errorCode;
      session.nonce_hash = nextNonceHash;
      await persist();
      const access = await getVoiceTutorAccess(username, limits, now);
      return { session: publicVoiceTutorSession(session), capsule: structuredClone(session.capsule), ...access };
    });
  }

  async function finishVoiceTutorSession(username, sessionId, { limits, now = new Date(), confirmedBillableSeconds = null, preservePedagogicalState = false }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const expired = expireVoiceTutorSessions(username, now);
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      const finished = session.status === 'active';
      let pedagogicalEnded = false;
      if (finished) {
        session.status = 'completed';
        if (session.proxy_ticket_consumed_at && !session.proxy_finalized_at) {
          const usage = voiceTutorProxyUsage(session, {
            inputAudioBytes: Number(session.proxy_input_audio_bytes || 0),
            outputAudioBytes: Number(session.proxy_output_audio_bytes || 0),
            confirmed: false,
            reason: 'server_finish',
            now,
          });
          session.billable_seconds = usage.billable_seconds;
          session.proxy_input_audio_bytes = usage.input_audio_bytes;
          session.proxy_output_audio_bytes = usage.output_audio_bytes;
          session.proxy_usage_confirmed = usage.confirmed;
          session.proxy_finalization_reason = usage.reason;
          session.proxy_finalized_at = usage.finalized_at;
          session.ended_at = usage.finalized_at;
        } else {
          session.billable_seconds = voiceTutorBillableSeconds(session, now, confirmedBillableSeconds);
          session.ended_at = new Date(now).toISOString();
        }
      }
      if (session.capsule && !preservePedagogicalState) {
        if (!['resolved', 'fallback', 'ended'].includes(session.pedagogical_state)) {
          session.pedagogical_state = 'ended';
          session.outcome = 'ended';
          pedagogicalEnded = true;
        }
        if (session.nonce_hash) pedagogicalEnded = true;
        session.nonce_hash = null;
      }
      if (finished || expired || pedagogicalEnded) await persist();
      return { finished, session: publicVoiceTutorSession(session), ...await getVoiceTutorAccess(username, limits, now) };
    });
  }

  async function setUserRole(username, role) {
    await load();
    if (!['student', 'admin'].includes(role)) throw new Error('INVALID_ROLE');
    if (!state.users[username]) throw new Error('USER_NOT_FOUND');
    state.users[username].role = role;
    await persist();
    return role;
  }

  function withRuleCardLock(operation) {
    const result = ruleCardQueue.then(operation, operation);
    ruleCardQueue = result.catch(() => {});
    return result;
  }

  async function createRuleCard(card) {
    return withRuleCardLock(async () => {
      await load();
      if (state.rule_cards.some((item) => item.id === card.id)) throw new Error('RULE_CARD_EXISTS');
      if (card.createdForUsername && !state.users[card.createdForUsername]) throw new Error('USER_NOT_FOUND');
      const stored = {
        id: card.id,
        created_for_username: card.createdForUsername || null,
        status: 'pending_review',
        skill: structuredClone(card.skill),
        exam_year: Number(card.examYear),
        rule: structuredClone(card.rule),
        agreement_hash: card.agreementHash,
        sources: structuredClone(card.sources),
        discrepancies: structuredClone(card.discrepancies || []),
        review_audit: [],
        created_at: new Date(card.createdAt).toISOString(),
        reviewed_at: null,
      };
      state.rule_cards.push(stored);
      await persist();
      return structuredClone(stored);
    });
  }

  async function claimVoiceTutorRuleDiscovery(username, sessionId, { claimId, nonceHash, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (session.discovery_status === 'in_progress') throw new VoiceTutorError('TRUSTED_RULE_DISCOVERY_IN_PROGRESS');
      if (session.status !== 'active' || ['resolved', 'fallback', 'ended'].includes(session.pedagogical_state)
        || session.pedagogical_state !== 'diagnose' || new Date(session.expires_at).getTime() <= new Date(now).getTime()
        || session.capsule.rule_card_id) throw new VoiceTutorError('TRUSTED_RULE_DISCOVERY_NOT_REQUIRED');
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      session.discovery_status = 'in_progress';
      session.discovery_claim_id = claimId;
      session.discovery_error_code = null;
      session.updated_at = new Date(now).toISOString();
      await persist();
      return { claim_id: claimId, capsule: structuredClone(session.capsule), state: session.pedagogical_state };
    });
  }

  async function failVoiceTutorRuleDiscovery(username, sessionId, { claimId, errorCode, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule || session.discovery_status !== 'in_progress' || session.discovery_claim_id !== claimId) return false;
      session.discovery_status = 'failed';
      session.discovery_claim_id = null;
      session.discovery_error_code = String(errorCode || 'TRUSTED_RULE_SEARCH_FAILED').slice(0, 80);
      session.updated_at = new Date(now).toISOString();
      await persist();
      return true;
    });
  }

  async function createRuleCardForVoiceTutorSession(username, sessionId, expectedCapsuleId, card, {
    claimId, expectedNonceHash, nextNonceHash,
  } = {}) {
    return serializeVoiceTutorMutation(() => withRuleCardLock(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session?.capsule || session.status !== 'active' || session.pedagogical_state !== 'diagnose'
        || session.capsule_id !== expectedCapsuleId || session.capsule.rule_card_id
        || session.capsule.skill_id !== card.skill?.id || session.discovery_status !== 'in_progress'
        || session.discovery_claim_id !== claimId || !session.nonce_hash || session.nonce_hash !== expectedNonceHash) {
        throw new VoiceTutorError('TRUSTED_RULE_DISCOVERY_NOT_REQUIRED');
      }
      if (state.rule_cards.some((item) => item.id === card.id)) throw new Error('RULE_CARD_EXISTS');
      const stored = {
        id: card.id, created_for_username: username, status: 'pending_review',
        skill: structuredClone(card.skill), exam_year: Number(card.examYear), rule: structuredClone(card.rule),
        agreement_hash: card.agreementHash, sources: structuredClone(card.sources),
        discrepancies: structuredClone(card.discrepancies || []), review_audit: [],
        created_at: new Date(card.createdAt).toISOString(), reviewed_at: null,
      };
      state.rule_cards.push(stored);
      session.capsule.rule_card_id = stored.id;
      session.pedagogical_state = 'explain';
      session.nonce_hash = nextNonceHash;
      session.discovery_status = 'completed';
      session.discovery_claim_id = null;
      session.discovery_error_code = null;
      session.updated_at = new Date(card.createdAt).toISOString();
      await persist();
      return structuredClone(stored);
    }));
  }

  async function getRuleCard(cardId) {
    await load();
    const card = state.rule_cards.find((entry) => entry.id === cardId);
    return card ? structuredClone(card) : null;
  }

  async function createVoiceTutorReport(username, report) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === report.sessionId);
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      const existing = state.voice_tutor_reports.find((entry) => entry.username === username
        && entry.session_id === report.sessionId && entry.reason === report.reason);
      if (existing) return { created: false, report: structuredClone(existing) };
      const stored = {
        id: report.id, username, session_id: report.sessionId, rule_card_id: session.capsule.rule_card_id || null,
        reason: report.reason, status: 'pending', review_audit: [],
        created_at: new Date(report.createdAt).toISOString(), reviewed_at: null,
      };
      state.voice_tutor_reports.push(stored);
      await persist();
      return { created: true, report: structuredClone(stored) };
    });
  }

  async function listVoiceTutorReports({ status = 'pending' } = {}) {
    await load();
    return state.voice_tutor_reports.filter((entry) => !status || entry.status === status)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).slice(0, 100)
      .map((entry) => structuredClone(entry));
  }

  async function reviewVoiceTutorReport(reportId, { decision, reviewer, reviewedAt }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!state.users[reviewer]) throw new Error('USER_NOT_FOUND');
      const report = state.voice_tutor_reports.find((entry) => entry.id === reportId);
      if (!report) throw new VoiceTutorError('VOICE_TUTOR_REPORT_NOT_FOUND');
      if (report.status !== 'pending') {
        if (report.status !== decision) throw new VoiceTutorError('VOICE_TUTOR_REPORT_REVIEW_CONFLICT');
        return { applied: false, report: structuredClone(report) };
      }
      report.status = decision;
      report.reviewed_at = new Date(reviewedAt).toISOString();
      report.review_audit.push({ decision, reviewer, reviewed_at: report.reviewed_at });
      state.audit_log.push({ action: 'voice_tutor.report.review', at: report.reviewed_at, metadata: { report_id: report.id, username: report.username, reviewer } });
      await persist();
      return { applied: true, report: structuredClone(report) };
    });
  }

  async function listRuleCards({ status = 'pending_review' } = {}) {
    await load();
    return state.rule_cards
      .filter((card) => !status || card.status === status)
      .sort((first, second) => String(first.created_at).localeCompare(String(second.created_at)))
      .slice(0, 100)
      .map((card) => structuredClone(card));
  }

  async function reviewRuleCard(cardId, { decision, reviewer, reviewedAt }) {
    return withRuleCardLock(async () => {
      await load();
      if (!state.users[reviewer]) throw new Error('USER_NOT_FOUND');
      const card = state.rule_cards.find((item) => item.id === cardId);
      const transition = transitionRuleCardReview(card, { decision, reviewer, reviewedAt });
      if (!transition.applied) return { applied: false, card: structuredClone(card) };
      if (decision === 'approved' && state.rule_cards.some((item) => item.id !== cardId
        && item.status === 'approved' && item.skill?.id === card.skill?.id
        && Number(item.exam_year) === Number(card.exam_year))) {
        throw new VoiceTutorError('RULE_CARD_CANONICAL_EXISTS');
      }
      Object.assign(card, transition.card);
      await persist();
      return { applied: true, card: structuredClone(card) };
    });
  }

  async function getApprovedRuleCard(skillId, examYear) {
    await load();
    const cards = state.rule_cards.filter((card) => card.status === 'approved'
      && card.skill?.id === skillId && card.exam_year === Number(examYear));
    const card = cards.sort((first, second) => String(second.reviewed_at).localeCompare(String(first.reviewed_at)))[0];
    return card ? structuredClone(card) : null;
  }

  async function getPrivacyConsent(username) {
    await load();
    const consent = state.users[username]?.privacy_consent || {};
    return {
      text_processing: Boolean(consent.text_processing),
      voice_processing: Boolean(consent.voice_processing),
      policy_version: consent.policy_version || null,
      updated_at: consent.updated_at || null,
    };
  }

  async function setPrivacyConsent(username, consent) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const previous = state.users[username].privacy_consent || {};
      const now = new Date().toISOString();
      state.users[username].privacy_consent = {
        text_processing: Boolean(consent.text_processing),
        voice_processing: Boolean(consent.voice_processing),
        policy_version: consent.policy_version,
        text_consented_at: consent.text_processing ? (previous.text_consented_at || now) : null,
        voice_consented_at: consent.voice_processing ? (previous.voice_consented_at || now) : null,
        updated_at: now,
      };
      await persist();
      return getPrivacyConsent(username);
    });
  }

  function removeExpiredAuthCodes(now = Date.now()) {
    let changed = false;
    for (const [codeHash, entry] of Object.entries(state.auth_codes)) {
      if (Number(entry.expires_at) <= now) {
        delete state.auth_codes[codeHash];
        changed = true;
      }
    }
    return changed;
  }

  async function createTelegramAuthCode(code, expiresAt) {
    await load();
    removeExpiredAuthCodes();
    const codeHash = hashAuthCode(code);
    state.auth_codes[codeHash] = {
      status: 'pending',
      expires_at: Number(expiresAt),
      created_at: Date.now(),
    };
    await persist();
  }

  async function confirmTelegramAuthCode(code, telegramId, displayName) {
    await load();
    const codeHash = hashAuthCode(code);
    const entry = state.auth_codes[codeHash];
    if (!entry || Number(entry.expires_at) <= Date.now() || entry.status !== 'pending') {
      if (entry) {
        delete state.auth_codes[codeHash];
        await persist();
      }
      return false;
    }
    entry.status = 'ready';
    entry.telegram_id = Number(telegramId);
    entry.display_name = String(displayName || '').slice(0, 160);
    entry.confirmed_at = Date.now();
    await persist();
    return true;
  }

  async function consumeTelegramAuthCode(code) {
    await load();
    const codeHash = hashAuthCode(code);
    const entry = state.auth_codes[codeHash];
    if (!entry || Number(entry.expires_at) <= Date.now() || entry.status !== 'ready') {
      if (entry && Number(entry.expires_at) <= Date.now()) {
        delete state.auth_codes[codeHash];
        await persist();
      }
      return null;
    }
    delete state.auth_codes[codeHash];
    await persist();
    return { telegram_id: entry.telegram_id, name: entry.display_name };
  }

  async function createWritingAttempt(username, input, promptVersion) {
    await load();
    const id = (state.writing_attempts.at(-1)?.id || 0) + 1;
    state.writing_attempts.push({
      id,
      username,
      task_type: input.taskType,
      assignment: structuredClone(input.assignment),
      answer: input.answer,
      evaluated_answer: input.evaluatedAnswer ?? input.answer,
      prompt_version: promptVersion,
      model: null,
      status: 'pending',
      created_at: Date.now(),
    });
    await persist();
    return id;
  }

  async function finishWritingAttempt(id, result) {
    await load();
    const attempt = state.writing_attempts.find((item) => item.id === Number(id));
    if (!attempt) throw new Error('WRITING_ATTEMPT_NOT_FOUND');
    attempt.status = result.status;
    attempt.review = result.review ? structuredClone(result.review) : null;
    attempt.provider = result.provider || null;
    attempt.model = result.model || null;
    attempt.error_code = result.errorCode || null;
    attempt.evaluated_at = Date.now();
    await persist();
  }

  async function getWritingAttempt(username, id) {
    await load();
    const attempt = state.writing_attempts.find((item) => item.username === username && item.id === Number(id));
    return attempt ? structuredClone(attempt) : null;
  }

  async function createSpeakingAttempt(username, input, promptVersion) {
    await load();
    const id = (state.speaking_attempts.at(-1)?.id || 0) + 1;
    state.speaking_attempts.push({ id, username, task_type: input.taskType, assignment: structuredClone(input.assignment), transcript: input.transcript, prompt_version: promptVersion, model: null, status: 'pending', created_at: Date.now() });
    await persist();
    return id;
  }

  async function finishSpeakingAttempt(id, result) {
    await load();
    const attempt = state.speaking_attempts.find((item) => item.id === Number(id));
    if (!attempt) throw new Error('SPEAKING_ATTEMPT_NOT_FOUND');
    attempt.status = result.status;
    attempt.review = result.review ? structuredClone(result.review) : null;
    attempt.provider = result.provider || null;
    attempt.model = result.model || null;
    attempt.error_code = result.errorCode || null;
    attempt.evaluated_at = Date.now();
    await persist();
  }

  async function getSpeakingAttempt(username, id) {
    await load();
    const attempt = state.speaking_attempts.find((item) => item.username === username && item.id === Number(id));
    return attempt ? structuredClone(attempt) : null;
  }

  async function getGeneratedTask(username, requestHash) {
    await load();
    const task = state.generated_tasks.find((item) => item.username === username && item.request_hash === requestHash);
    return task ? structuredClone({ operation: task.operation, request: task.request, result: task.result, provider: task.provider, prompt_version: task.prompt_version, created_at: task.created_at }) : null;
  }

  // Section 10.8: an identical task is reused whoever generated it first.
  async function getSharedGeneratedTask(requestHash) {
    await load();
    const tasks = state.generated_tasks.filter((item) => item.request_hash === requestHash);
    const task = tasks.at(-1);
    return task ? structuredClone({ result: task.result, provider: task.provider, prompt_version: task.prompt_version, created_at: task.created_at }) : null;
  }

  async function saveGeneratedTask(username, entry) {
    await load();
    const existing = state.generated_tasks.find((item) => item.username === username && item.request_hash === entry.requestHash);
    if (existing) return existing.id;
    const id = (state.generated_tasks.at(-1)?.id || 0) + 1;
    state.generated_tasks.push({ id, username, operation: entry.operation, request_hash: entry.requestHash, request: structuredClone(entry.request), result: structuredClone(entry.result), provider: entry.provider, prompt_version: entry.promptVersion, created_at: Date.now() });
    await persist();
    return id;
  }

  /* ---------- Section 10.1: the shared task bank ---------- */

  async function upsertBankTask(task) {
    await load();
    const existing = state.task_bank.find((item) => item.operation === task.operation && item.content_hash === task.contentHash);
    if (existing) return existing.id;
    const id = (state.task_bank.at(-1)?.id || 0) + 1;
    state.task_bank.push({
      id,
      operation: task.operation,
      external_id: task.externalId || null,
      content_hash: task.contentHash,
      content: structuredClone(task.content),
      source: task.source || 'generated',
      provider: task.provider || '',
      prompt_version: task.promptVersion || '',
      retired_at: null,
      created_at: Date.now(),
    });
    await persist();
    return id;
  }

  function viewBankTask(row) {
    return row
      ? structuredClone({ id: row.id, operation: row.operation, externalId: row.external_id, content: row.content, source: row.source })
      : null;
  }

  async function getBankTask(taskId) {
    await load();
    return viewBankTask(state.task_bank.find((item) => item.id === Number(taskId)));
  }

  async function getBankTaskByExternalId(externalId) {
    await load();
    return viewBankTask(state.task_bank.find((item) => item.external_id === externalId));
  }

  async function claimUnseenBankTask(username, operation) {
    await load();
    const delivered = new Set(state.task_deliveries.filter((item) => item.username === username).map((item) => item.task_id));
    const row = state.task_bank
      .filter((item) => item.operation === operation && !item.retired_at && !delivered.has(item.id))
      .sort((first, second) => first.created_at - second.created_at || first.id - second.id)[0];
    if (!row) return null;
    state.task_deliveries.push({ username, task_id: row.id, delivered_at: Date.now() });
    await persist();
    return viewBankTask(row);
  }

  async function recordTaskDelivery(username, taskId) {
    await load();
    const id = Number(taskId);
    if (state.task_deliveries.some((item) => item.username === username && item.task_id === id)) return;
    state.task_deliveries.push({ username, task_id: id, delivered_at: Date.now() });
    await persist();
  }

  async function listBankTaskContents(operation, limit = 60) {
    await load();
    return state.task_bank
      .filter((item) => item.operation === operation && !item.retired_at)
      .sort((first, second) => second.created_at - first.created_at)
      .slice(0, limit)
      .map((item) => structuredClone(item.content));
  }

  async function saveAdaptiveLearningGoal(username, goal) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const duplicate = state.adaptive_learning_goals.find((entry) => (
        entry.username === username && entry.idempotency_key === goal.idempotencyKey
      ));
      if (duplicate) {
        if (duplicate.request_hash !== goal.requestHash) throw new Error('ADAPTIVE_GOAL_IDEMPOTENCY_CONFLICT');
        return { created: false, goal: adaptiveLearningGoalRepositoryDto(duplicate) };
      }
      const current = state.adaptive_learning_goals.filter((entry) => entry.username === username && entry.current);
      for (const entry of current) entry.current = false;
      const stored = {
        id: goal.id,
        username,
        target_exam: goal.targetExam,
        target_score: goal.targetScore,
        exam_date: goal.examDate,
        weekly_minutes: goal.weeklyMinutes,
        revision: Math.max(0, ...state.adaptive_learning_goals
          .filter((entry) => entry.username === username)
          .map((entry) => Number(entry.revision) || 0)) + 1,
        idempotency_key: goal.idempotencyKey,
        request_hash: goal.requestHash,
        current: true,
        created_at: new Date(goal.now).getTime(),
        updated_at: new Date(goal.now).getTime(),
      };
      state.adaptive_learning_goals.push(stored);
      await persist();
      return { created: true, goal: adaptiveLearningGoalRepositoryDto(stored) };
    });
  }

  async function getAdaptiveLearningGoal(username) {
    await load();
    const goals = state.adaptive_learning_goals
      .filter((entry) => entry.username === username && entry.current)
      .sort((first, second) => Number(second.revision) - Number(first.revision));
    return adaptiveLearningGoalRepositoryDto(goals[0]);
  }

  async function getAdaptiveLearningEvidenceSources(username) {
    await load();
    const recoveries = state.voice_tutor_recoveries.filter((entry) => entry.username === username);
    const recoveryById = new Map(recoveries.map((entry) => [entry.id, entry]));
    const repeatById = new Map(state.voice_tutor_repeats
      .filter((entry) => recoveryById.has(entry.recovery_id))
      .map((entry) => [entry.id, entry]));
    const diagnostics = state.adaptive_diagnostic_sessions.filter((entry) => entry.username === username);
    const diagnosticById = new Map(diagnostics.map((entry) => [entry.id, entry]));
    const completedDiagnosticIds = new Set(diagnostics
      .filter((entry) => entry.status === 'completed')
      .map((entry) => entry.id));
    const diagnosticCompletions = diagnostics
      .filter((entry) => entry.status === 'completed' && entry.completed_at)
      .map((entry) => ({ catalog_version: entry.catalog_version, completed_at: entry.completed_at }));
    return structuredClone({
      attempts: state.module_attempts
        .filter((entry) => entry.username === username)
        .map((entry) => ({ ...entry, evidence_quality: entry.evidence_quality || 'client_reported' })),
      recoveries,
      repeatAttempts: state.voice_tutor_repeat_attempts
        .filter((entry) => repeatById.has(entry.repeat_id))
        .map((entry) => {
          const recovery = recoveryById.get(repeatById.get(entry.repeat_id).recovery_id);
          return { ...entry, skill_id: recovery.skill_id, module: recovery.module };
        }),
      diagnosticResponses: state.adaptive_diagnostic_responses
        .filter((entry) => completedDiagnosticIds.has(entry.diagnostic_id))
        .map((entry) => ({
          id: entry.id,
          diagnostic_id: entry.diagnostic_id,
          item_id: entry.item_id,
          catalog_version: diagnosticById.get(entry.diagnostic_id).catalog_version,
          skill_id: entry.skill_id,
          module: entry.module,
          evidence_quality: entry.evidence_quality,
          correct: Boolean(entry.correct),
          answered_at: entry.answered_at,
        })),
      diagnosticCompletions,
    });
  }

  async function saveAdaptiveLearningProfile(username, profile, { now = new Date() } = {}) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const persistedProfile = state.adaptive_learning_profiles[username];
      if (persistedProfile && compareAdaptiveEvidenceWatermarks(profile, persistedProfile) <= 0) {
        return adaptiveLearningProfileRepositoryDto(
          persistedProfile,
          state.adaptive_learning_skill_estimates[username] || [],
        );
      }
      const updatedAt = new Date(now).getTime();
      state.adaptive_learning_profiles[username] = {
        taxonomy_version: profile.taxonomyVersion,
        weighting_version: profile.weightingVersion,
        status: profile.status,
        preliminary: Boolean(profile.preliminary),
        confidence: profile.confidence,
        evidence_count: profile.evidenceCount,
        independent_evidence_count: profile.independentEvidenceCount,
        assisted_evidence_count: profile.assistedEvidenceCount,
        client_reported_evidence_count: profile.clientReportedEvidenceCount,
        independent_module_count: profile.independentModuleCount,
        established_skill_count: profile.establishedSkillCount,
        profile_calculation_revision: profile.profileCalculationRevision,
        evidence_watermark_version: profile.evidenceWatermarkVersion,
        evidence_observed_at: profile.evidenceObservedAt,
        evidence_source_count: profile.evidenceSourceCount,
        needs_diagnostic: Boolean(profile.needsDiagnostic),
        explanation_codes: structuredClone(profile.explanationCodes),
        updated_at: updatedAt,
      };
      state.adaptive_learning_skill_estimates[username] = profile.skills.map((skill) => ({
        username,
        taxonomy_version: profile.taxonomyVersion,
        skill_id: skill.id,
        module: skill.module,
        mastery: skill.mastery,
        uncertainty: skill.uncertainty,
        evidence_count: skill.evidenceCount,
        effective_evidence_count: skill.effectiveEvidenceCount,
        independent_evidence_count: skill.independentEvidenceCount,
        evidence_quality: skill.evidenceQuality,
        status: skill.status,
        last_observed_at: skill.lastObservedAt,
        due_state: skill.dueState,
        explanation_code: skill.explanationCode,
        updated_at: updatedAt,
      }));
      await persist();
      return adaptiveLearningProfileRepositoryDto(
        state.adaptive_learning_profiles[username],
        state.adaptive_learning_skill_estimates[username],
      );
    });
  }

  async function getAdaptiveLearningProfile(username) {
    await load();
    const profile = state.adaptive_learning_profiles[username];
    if (!profile) return null;
    return adaptiveLearningProfileRepositoryDto(
      profile,
      state.adaptive_learning_skill_estimates[username] || [],
    );
  }

  async function saveAdaptiveLearningPlan(username, candidate) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const current = state.adaptive_learning_plan_revisions
        .filter((entry) => entry.username === username && entry.current)
        .sort((left, right) => Number(right.revision) - Number(left.revision))[0];
      assertAdaptivePlanPersistenceCandidate(candidate);
      const duplicate = state.adaptive_learning_plan_revisions.find((entry) => (
        entry.username === username && entry.input_fingerprint === candidate.inputFingerprint
      ));
      if (duplicate) {
        assertAdaptivePlanDuplicateReplay(candidate, duplicate);
        const historical = Boolean(current) && duplicate.id !== current.id;
        return {
          created: false,
          stale: historical,
          replayed: true,
          conflict: false,
          reason: historical ? 'historical_fingerprint' : 'current_fingerprint',
          plan: adaptiveLearningPlanRepositoryDto(current || duplicate),
        };
      }
      const goal = state.adaptive_learning_goals.find((entry) => entry.username === username && entry.current);
      if (!goal || goal.id !== candidate.goalId || Number(goal.revision) !== Number(candidate.goalRevision)) {
        throw new Error('ADAPTIVE_PLAN_GOAL_STALE');
      }
      const authoritativeProfile = adaptiveLearningProfileRepositoryDto(
        state.adaptive_learning_profiles[username] || null,
        state.adaptive_learning_skill_estimates[username] || [],
      );
      assertAdaptivePlanPersistenceCandidate(candidate, {
        authoritativeProfile,
      });
      const currentRevision = current ? Number(current.revision) : null;
      const basePlanRevision = candidate.basePlanRevision == null ? null : Number(candidate.basePlanRevision);
      if (basePlanRevision !== currentRevision) {
        return {
          created: false,
          stale: true,
          replayed: false,
          conflict: true,
          reason: 'base_plan_revision_mismatch',
          plan: adaptiveLearningPlanRepositoryDto(current),
        };
      }
      if (current && compareAdaptivePlanInputs(candidate, current) <= 0) {
        return {
          created: false,
          stale: true,
          replayed: false,
          conflict: false,
          reason: 'evidence_or_bucket_stale',
          plan: adaptiveLearningPlanRepositoryDto(current),
        };
      }
      assertAdaptivePlanAuthoritativeCandidate(candidate, {
        authoritativeGoal: adaptiveLearningGoalRepositoryDto(goal),
        authoritativeProfile,
        currentPlan: adaptiveLearningPlanRepositoryDto(current),
      });
      if (Number(candidate.plan?.goalRevision) !== Number(candidate.goalRevision)) {
        throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
      }
      assertAdaptivePlanStabilityTransition(current, candidate.plan);
      for (const entry of state.adaptive_learning_plan_revisions) {
        if (entry.username === username && entry.current) entry.current = false;
      }
      const instant = new Date(candidate.now).getTime();
      const stored = {
        id: candidate.id,
        username,
        plan_version: candidate.plan.version,
        revision: Math.max(0, ...state.adaptive_learning_plan_revisions
          .filter((entry) => entry.username === username)
          .map((entry) => Number(entry.revision) || 0)) + 1,
        base_plan_revision: basePlanRevision,
        goal_id: candidate.goalId,
        goal_revision: candidate.goalRevision,
        taxonomy_version: candidate.taxonomyVersion,
        profile_calculation_revision: candidate.profileCalculationRevision,
        profile_evidence_watermark_version: candidate.profileEvidenceWatermarkVersion,
        profile_evidence_observed_at: candidate.profileEvidenceObservedAt,
        profile_evidence_source_count: candidate.profileEvidenceSourceCount,
        recalculation_bucket: candidate.recalculationBucket,
        input_fingerprint: candidate.inputFingerprint,
        forecast: structuredClone(candidate.plan.forecast),
        allocation: structuredClone(candidate.plan.allocation),
        stability: structuredClone(candidate.plan.stability),
        current: true,
        created_at: instant,
        updated_at: instant,
      };
      state.adaptive_learning_plan_revisions.push(stored);
      await persist();
      return {
        created: true,
        stale: false,
        replayed: false,
        conflict: false,
        reason: null,
        plan: adaptiveLearningPlanRepositoryDto(stored),
      };
    });
  }

  async function getCurrentAdaptiveLearningPlan(username) {
    await load();
    const plan = state.adaptive_learning_plan_revisions
      .filter((entry) => entry.username === username && entry.current)
      .sort((left, right) => Number(right.revision) - Number(left.revision))[0];
    return adaptiveLearningPlanRepositoryDto(plan);
  }

  async function startAdaptiveDiagnostic(username, diagnostic) {
    return serializeCoordinatedMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const instant = new Date(diagnostic.now).getTime();
      state.adaptive_diagnostic_start_claims = state.adaptive_diagnostic_start_claims
        .filter((entry) => Number(entry.claim_expires_at) > instant);
      const duplicate = state.adaptive_diagnostic_start_claims.find((entry) => (
        entry.username === username && entry.idempotency_key === diagnostic.idempotencyKey
      ));
      if (duplicate) {
        if (duplicate.request_hash !== diagnostic.requestHash) throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
        return { created: false, diagnostic: adaptiveDiagnosticStartClaimRepositoryDto(duplicate) };
      }
      const ownerClaimCount = state.adaptive_diagnostic_start_claims
        .filter((entry) => entry.username === username).length;
      if (ownerClaimCount >= ADAPTIVE_DIAGNOSTIC_START_CLAIM_LIMIT) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_START_LIMIT');
      }
      for (const entry of state.adaptive_diagnostic_sessions) {
        if (entry.username === username && ['in_progress', 'ready'].includes(entry.status)
          && Number(entry.expires_at) <= instant) {
          entry.status = 'expired';
          entry.current_item_id = null;
          entry.stop_reason = 'maximum_time';
          entry.updated_at = instant;
        }
      }
      let active = state.adaptive_diagnostic_sessions.find((entry) => (
        entry.username === username && ['in_progress', 'ready'].includes(entry.status)
      ));
      const created = !active;
      if (!active) {
        active = {
          id: diagnostic.id,
          username,
          catalog_version: diagnostic.catalogVersion,
          status: 'in_progress',
          current_item_id: diagnostic.currentItemId,
          answered_items: 0,
          correct_items: 0,
          stop_reason: null,
          idempotency_key: diagnostic.idempotencyKey,
          request_hash: diagnostic.requestHash,
          started_at: instant,
          expires_at: new Date(diagnostic.expiresAt).getTime(),
          completed_at: null,
          updated_at: instant,
        };
        state.adaptive_diagnostic_sessions.push(active);
      }
      const claim = {
        username,
        idempotency_key: diagnostic.idempotencyKey,
        request_hash: diagnostic.requestHash,
        diagnostic_id: active.id,
        catalog_version: active.catalog_version,
        status: active.status,
        current_item_id: active.current_item_id,
        answered_items: active.answered_items,
        correct_items: active.correct_items,
        stop_reason: active.stop_reason,
        started_at: active.started_at,
        expires_at: active.expires_at,
        completed_at: active.completed_at,
        updated_at: active.updated_at,
        claimed_at: instant,
        claim_expires_at: adaptiveDiagnosticClaimExpiresAt(diagnostic.now).getTime(),
      };
      state.adaptive_diagnostic_start_claims.push(claim);
      await persist();
      return { created, diagnostic: adaptiveDiagnosticStartClaimRepositoryDto(claim) };
    });
  }

  async function getAdaptiveDiagnosticStartClaim(username, claim) {
    await load();
    const instant = new Date(claim.now ?? Date.now()).getTime();
    const stored = state.adaptive_diagnostic_start_claims.find((entry) => (
      entry.username === username && entry.idempotency_key === claim.idempotencyKey
        && Number(entry.claim_expires_at) > instant
    ));
    if (!stored) return null;
    if (stored.request_hash !== claim.requestHash) throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
    return adaptiveDiagnosticStartClaimRepositoryDto(stored);
  }

  async function getCurrentAdaptiveDiagnostic(username) {
    await load();
    const session = state.adaptive_diagnostic_sessions
      .filter((entry) => entry.username === username)
      .sort((left, right) => Number(right.started_at) - Number(left.started_at))[0];
    if (!session || session.status === 'completed') return null;
    const responses = state.adaptive_diagnostic_responses.filter((entry) => entry.diagnostic_id === session.id);
    return adaptiveDiagnosticRepositoryDto(session, responses);
  }

  async function getAdaptiveDiagnostic(username, diagnosticId) {
    await load();
    const session = state.adaptive_diagnostic_sessions.find((entry) => (
      entry.username === username && entry.id === diagnosticId
    ));
    if (!session) return null;
    const responses = state.adaptive_diagnostic_responses.filter((entry) => entry.diagnostic_id === session.id);
    return adaptiveDiagnosticRepositoryDto(session, responses);
  }

  async function getAdaptiveDiagnosticCompletionReplay(username, completion) {
    await load();
    const session = state.adaptive_diagnostic_sessions.find((entry) => (
      entry.id === completion.diagnosticId && entry.username === username
    ));
    if (!session || session.status !== 'completed') return null;
    if (session.completion_idempotency_key === completion.idempotencyKey
      && session.completion_request_hash !== completion.requestHash) {
      throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
    }
    const responseSnapshot = adaptiveDiagnosticCompletionSnapshotDto(
      session.completion_response_snapshot,
    );
    if (!responseSnapshot) throw new Error('ADAPTIVE_DIAGNOSTIC_COMPLETION_SNAPSHOT_MISSING');
    return responseSnapshot;
  }

  async function answerAdaptiveDiagnostic(username, answer) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const session = state.adaptive_diagnostic_sessions.find((entry) => (
        entry.id === answer.diagnosticId && entry.username === username
      ));
      if (!session) throw new Error('ADAPTIVE_DIAGNOSTIC_NOT_FOUND');
      const responses = state.adaptive_diagnostic_responses.filter((entry) => entry.diagnostic_id === session.id);
      const duplicate = responses.find((entry) => entry.idempotency_key === answer.idempotencyKey);
      if (duplicate) {
        if (duplicate.request_hash !== answer.requestHash) throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
        return { created: false, diagnostic: adaptiveDiagnosticAnswerClaimRepositoryDto(duplicate) };
      }
      if (session.status === 'expired' && session.stop_reason === 'maximum_time') {
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      if (['in_progress', 'ready'].includes(session.status)
        && Number(session.expires_at) <= new Date(answer.now).getTime()) {
        session.status = 'expired';
        session.current_item_id = null;
        session.stop_reason = 'maximum_time';
        session.updated_at = new Date(answer.now).getTime();
        await persist();
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      if (responses.some((entry) => entry.item_id === answer.itemId)) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_ITEM_ALREADY_ANSWERED');
      }
      if (session.status !== 'in_progress' || session.current_item_id !== answer.itemId) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_ITEM_NOT_CURRENT');
      }
      const stored = {
        id: answer.id,
        diagnostic_id: session.id,
        item_id: answer.itemId,
        skill_id: answer.skillId,
        module: answer.module,
        evidence_quality: answer.evidenceQuality,
        choice_id: answer.choiceId,
        correct: Boolean(answer.correct),
        response_ms: answer.responseMs,
        idempotency_key: answer.idempotencyKey,
        request_hash: answer.requestHash,
        answered_at: new Date(answer.now).getTime(),
      };
      state.adaptive_diagnostic_responses.push(stored);
      const updatedResponses = [...responses, stored];
      session.current_item_id = answer.nextItemId;
      session.status = answer.status || 'in_progress';
      session.stop_reason = answer.stopReason || null;
      session.answered_items = updatedResponses.length;
      session.correct_items = updatedResponses.filter((entry) => entry.correct).length;
      session.updated_at = new Date(answer.now).getTime();
      Object.assign(stored, {
        replay_catalog_version: session.catalog_version,
        replay_status: session.status,
        replay_current_item_id: session.current_item_id,
        replay_answered_items: session.answered_items,
        replay_correct_items: session.correct_items,
        replay_stop_reason: session.stop_reason,
        replay_started_at: session.started_at,
        replay_expires_at: session.expires_at,
        replay_completed_at: session.completed_at,
        replay_updated_at: session.updated_at,
      });
      await persist();
      return { created: true, diagnostic: adaptiveDiagnosticRepositoryDto(session, updatedResponses) };
    });
  }

  async function completeAdaptiveDiagnostic(username, completion) {
    return serializeCoordinatedMutation(async () => {
      await load();
      const session = state.adaptive_diagnostic_sessions.find((entry) => (
        entry.id === completion.diagnosticId && entry.username === username
      ));
      if (!session) throw new Error('ADAPTIVE_DIAGNOSTIC_NOT_FOUND');
      const responses = state.adaptive_diagnostic_responses.filter((entry) => entry.diagnostic_id === session.id);
      if (session.status === 'completed') {
        if (session.completion_idempotency_key === completion.idempotencyKey
          && session.completion_request_hash !== completion.requestHash) {
          throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
        }
        const responseSnapshot = adaptiveDiagnosticCompletionSnapshotDto(
          session.completion_response_snapshot,
        );
        if (!responseSnapshot) throw new Error('ADAPTIVE_DIAGNOSTIC_COMPLETION_SNAPSHOT_MISSING');
        return {
          created: false,
          diagnostic: adaptiveDiagnosticRepositoryDto(session, responses),
          responseSnapshot,
        };
      }
      if (session.status === 'expired' && session.stop_reason === 'maximum_time') {
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      if (session.status === 'ready'
        && Number(session.expires_at) <= new Date(completion.now).getTime()) {
        session.status = 'expired';
        session.current_item_id = null;
        session.stop_reason = 'maximum_time';
        session.updated_at = new Date(completion.now).getTime();
        await persist();
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      if (session.status !== 'ready') throw new Error('ADAPTIVE_DIAGNOSTIC_NOT_READY');
      const responseSnapshot = adaptiveDiagnosticCompletionSnapshotDto(completion.responseSnapshot);
      if (!responseSnapshot
        || responseSnapshot.diagnostic.id !== session.id
        || responseSnapshot.diagnostic.catalogVersion !== session.catalog_version
        || responseSnapshot.diagnostic.status !== 'completed'
        || responseSnapshot.diagnostic.answeredItems !== Number(session.answered_items)
        || responseSnapshot.result.correctItems !== Number(session.correct_items)) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_COMPLETION_SNAPSHOT_INVALID');
      }
      session.status = 'completed';
      session.current_item_id = null;
      session.completion_idempotency_key = completion.idempotencyKey;
      session.completion_request_hash = completion.requestHash;
      session.completion_response_snapshot = responseSnapshot;
      session.completed_at = new Date(completion.now).getTime();
      session.updated_at = session.completed_at;
      await persist();
      return {
        created: true,
        diagnostic: adaptiveDiagnosticRepositoryDto(session, responses),
        responseSnapshot: structuredClone(responseSnapshot),
      };
    });
  }

  async function recordModuleAttempt(username, attempt, { evidenceQuality = 'client_reported' } = {}) {
    await load();
    const trustedEvidenceQuality = requireModuleAttemptEvidenceQuality(evidenceQuality);
    if (state.module_attempts.some((item) => item.id === attempt.id)) return { id: attempt.id, created: false };
    state.module_attempts.push({ id: attempt.id, username, module: attempt.module, activity: attempt.activity, score: attempt.score, max_score: attempt.maxScore, duration_ms: attempt.durationMs ?? null, metadata: structuredClone(attempt.metadata || {}), evidence_quality: trustedEvidenceQuality, created_at: Date.now() });
    state.progress_summary[username] ||= {};
    const summary = state.progress_summary[username][attempt.module] ||= { module: attempt.module, attempt_count: 0, best_score: 0, best_max_score: 1, total_duration_ms: 0, last_attempt_at: null, updated_at: null };
    summary.attempt_count += 1;
    if (attempt.score / attempt.maxScore > summary.best_score / summary.best_max_score) {
      summary.best_score = attempt.score;
      summary.best_max_score = attempt.maxScore;
    }
    summary.total_duration_ms += attempt.durationMs ?? 0;
    summary.last_attempt_at = Date.now();
    summary.updated_at = summary.last_attempt_at;
    await persist();
    return { id: attempt.id, created: true };
  }

  async function getModuleAttempt(username, attemptId) {
    await load();
    const attempt = state.module_attempts.find((item) => item.username === username && item.id === attemptId);
    return attempt ? structuredClone(attempt) : null;
  }

  async function upsertWordProgress(username, words) {
    await load();
    state.word_progress[username] ||= {};
    const now = Date.now();
    for (const item of words) state.word_progress[username][item.word.toLocaleLowerCase('en')] = { word: item.word.toLocaleLowerCase('en'), stage: item.stage, error_count: item.errorCount, review_count: item.reviewCount, due_at: item.dueAt, updated_at: now };
    await persist();
    return { updated: words.length };
  }

  async function upsertErrorBank(username, errors) {
    await load();
    const now = Date.now();
    for (const item of errors) {
      const existing = state.error_bank.find((entry) => entry.username === username && entry.module === item.module && entry.item_key === item.itemKey && entry.error_type === item.errorType);
      if (existing) {
        existing.details = structuredClone(item.details || {});
        existing.occurrence_count += 1;
        existing.last_seen_at = now;
        existing.resolved_at = null;
      } else {
        state.error_bank.push({ id: (state.error_bank.at(-1)?.id || 0) + 1, username, module: item.module, item_key: item.itemKey, error_type: item.errorType, details: structuredClone(item.details || {}), occurrence_count: 1, first_seen_at: now, last_seen_at: now, resolved_at: null });
      }
    }
    await persist();
    return { updated: errors.length };
  }

  async function logAiRequest(entry) {
    await load();
    const id = (state.ai_requests.at(-1)?.id || 0) + 1;
    state.ai_requests.push({ id, ...structuredClone(entry), created_at: Date.now() });
    if (state.ai_requests.length > 5000) state.ai_requests = state.ai_requests.slice(-5000);
    await persist();
    return id;
  }

  async function claimAiOperationSlot(username, {
    claimId, operation, promptVersion, requestsPerHour, dailyLimit, now = new Date(),
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!state.users[username]) throw new Error('USER_NOT_FOUND');
      const existing = state.ai_requests.find((entry) => entry.claim_key === claimId);
      if (existing) {
        if (existing.username !== username || existing.operation !== operation) throw new VoiceTutorError('AI_OPERATION_CLAIM_CONFLICT');
        return { claim_id: claimId, id: existing.id, status: existing.status };
      }
      const instant = new Date(now);
      const startOfDay = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
      const startOfHour = instant.getTime() - 3_600_000;
      if (!Number.isInteger(dailyLimit) || dailyLimit < 1
        || state.ai_requests.filter((entry) => Number(entry.created_at) >= startOfDay).length >= dailyLimit) {
        throw new VoiceTutorError('AI_BUDGET_EXHAUSTED');
      }
      if (!Number.isInteger(requestsPerHour) || requestsPerHour < 1
        || state.ai_requests.filter((entry) => entry.username === username && entry.operation === operation
          && Number(entry.created_at) >= startOfHour).length >= requestsPerHour) {
        throw new VoiceTutorError('RATE_LIMITED');
      }
      const id = (state.ai_requests.at(-1)?.id || 0) + 1;
      state.ai_requests.push({
        id, username, operation, provider: null, model: null, promptVersion: promptVersion || null,
        status: 'in_progress', durationMs: null, errorCode: null, promptTokens: null,
        completionTokens: null, claim_key: claimId, created_at: instant.getTime(), settled_at: null,
      });
      await persist();
      return { claim_id: claimId, id, status: 'in_progress' };
    });
  }

  async function settleAiOperationSlot(username, claimId, {
    status, provider = null, model = null, durationMs = null, errorCode = null,
    promptTokens = null, completionTokens = null, now = new Date(),
  }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!['completed', 'failed'].includes(status)) throw new VoiceTutorError('AI_OPERATION_SETTLEMENT_INVALID');
      const entry = state.ai_requests.find((item) => item.claim_key === claimId && item.username === username);
      if (!entry) throw new VoiceTutorError('AI_OPERATION_CLAIM_NOT_FOUND');
      if (entry.status !== 'in_progress') return { applied: false, status: entry.status };
      entry.status = status;
      entry.provider = provider;
      entry.model = model;
      entry.durationMs = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null;
      entry.errorCode = errorCode;
      entry.promptTokens = Number.isFinite(promptTokens) ? Math.max(0, Math.round(promptTokens)) : null;
      entry.completionTokens = Number.isFinite(completionTokens) ? Math.max(0, Math.round(completionTokens)) : null;
      entry.settled_at = new Date(now).getTime();
      await persist();
      return { applied: true, status: entry.status };
    });
  }

  async function countAiRequestsSince(since) {
    await load();
    const timestamp = since instanceof Date ? since.getTime() : Number(since);
    return state.ai_requests.filter((item) => Number(item.created_at) >= timestamp).length;
  }

  async function countAiOperationRequestsSince(username, operation, since) {
    await load();
    const timestamp = since instanceof Date ? since.getTime() : Number(since);
    return state.ai_requests.filter((item) => item.username === username && item.operation === operation && Number(item.created_at) >= timestamp).length;
  }

  async function getAiUsageMetrics(hours = 24) {
    await load();
    const safeHours = Math.max(1, Math.min(Number(hours) || 24, 168));
    const since = Date.now() - safeHours * 3_600_000;
    const entries = state.ai_requests.filter((item) => Number(item.created_at) >= since);
    return {
      windowHours: safeHours,
      requests: entries.length,
      promptTokens: entries.reduce((sum, item) => sum + (Number(item.promptTokens) || 0), 0),
      completionTokens: entries.reduce((sum, item) => sum + (Number(item.completionTokens) || 0), 0),
      estimatedCostMicrousd: entries.reduce((sum, item) => sum + (Number(item.estimatedCostMicrousd) || 0), 0),
    };
  }

  function removeExpiredSessions(now = Date.now()) {
    for (const [id, session] of Object.entries(state.sessions)) {
      if (Number(session.expires_at) <= now) delete state.sessions[id];
    }
  }

  async function createSession(id, username, expiresAt) {
    await load();
    if (!state.users[username]) throw new Error('USER_NOT_FOUND');
    removeExpiredSessions();
    state.sessions[id] = { username, expires_at: Number(expiresAt), created_at: Date.now(), last_seen_at: Date.now(), revoked_at: null };
    await persist();
  }

  async function isSessionActive(id, username) {
    await load();
    const session = state.sessions[id];
    if (!session || session.username !== username || session.revoked_at || Number(session.expires_at) <= Date.now()) return false;
    return true;
  }

  async function revokeSession(id, username) {
    await load();
    const session = state.sessions[id];
    if (!session || session.username !== username || session.revoked_at) return false;
    session.revoked_at = Date.now();
    await persist();
    return true;
  }

  async function exportUserData(username) {
    await load();
    const user = state.users[username];
    if (!user) return null;
    const adaptiveExport = adaptiveLearningProfileExportDto(
      state.adaptive_learning_profiles[username] || null,
      state.adaptive_learning_skill_estimates[username] || [],
    );
    return structuredClone({
      exported_at: new Date().toISOString(),
      account: {
        username,
        telegram_id: user.telegram_id ?? null,
        role: user.role || 'student',
        trial_used: Boolean(user.trial_used),
        subscription_until: user.sub_until ?? null,
        created_at: user.created ?? null,
      },
      progress: state.progress[username] || {},
      privacy_consent: await getPrivacyConsent(username),
      subscription_events: state.subscription_events.filter((item) => item.username === username),
      subscription_entitlements: Object.entries(state.subscription_entitlements[username] || {}).map(([entitlement, period]) => ({ entitlement, ...period })),
      voice_tutor_sessions: state.voice_tutor_sessions
        .filter((item) => item.username === username)
        .map(({
          username: owner, idempotency_key, nonce_hash, proxy_ticket_hash,
          proxy_ticket_issued_at, proxy_ticket_expires_at, proxy_ticket_consumed_at,
          proxy_ticket_reissue_count,
          ...item
        }) => item),
      voice_tutor_recoveries: state.voice_tutor_recoveries
        .filter((item) => item.username === username)
        .map(({ username: owner, ...item }) => item),
      voice_tutor_repeats: state.voice_tutor_repeats.filter((item) => (
        state.voice_tutor_recoveries.some((recovery) => recovery.username === username && recovery.id === item.recovery_id)
      )),
      voice_tutor_repeat_attempts: state.voice_tutor_repeat_attempts
        .filter((item) => state.voice_tutor_repeats.some((repeat) => repeat.id === item.repeat_id
          && state.voice_tutor_recoveries.some((recovery) => recovery.username === username && recovery.id === repeat.recovery_id)))
        .map(({ fingerprint, ...item }) => item),
      voice_tutor_reports: state.voice_tutor_reports.filter((item) => item.username === username)
        .map(({ username: owner, ...item }) => item),
      rule_cards: state.rule_cards.filter((item) => item.created_for_username === username),
      payment_requests: Object.values(state.payment_requests).filter((item) => item.username === username),
      writing_attempts: state.writing_attempts.filter((item) => item.username === username),
      speaking_attempts: state.speaking_attempts.filter((item) => item.username === username),
      generated_tasks: state.generated_tasks.filter((item) => item.username === username).map(({ request_hash, username: owner, ...item }) => item),
      module_attempts: state.module_attempts.filter((item) => item.username === username),
      progress_summary: Object.values(state.progress_summary[username] || {}),
      word_progress: Object.values(state.word_progress[username] || {}),
      error_bank: state.error_bank.filter((item) => item.username === username),
      ai_requests: state.ai_requests.filter((item) => item.username === username),
      audit_log: state.audit_log.filter((item) => item.metadata?.username === username),
      adaptive_learning_goals: state.adaptive_learning_goals
        .filter((item) => item.username === username)
        .map(adaptiveLearningGoalRepositoryDto),
      adaptive_learning_profile: adaptiveExport.profile,
      adaptive_learning_skill_estimates: adaptiveExport.estimates,
      adaptive_learning_plan_revisions: state.adaptive_learning_plan_revisions
        .filter((item) => item.username === username)
        .sort((left, right) => Number(left.revision) - Number(right.revision))
        .map(adaptiveLearningPlanRepositoryDto),
      adaptive_diagnostic_sessions: state.adaptive_diagnostic_sessions
        .filter((item) => item.username === username)
        .map(adaptiveDiagnosticExportDto),
      adaptive_diagnostic_responses: state.adaptive_diagnostic_responses
        .filter((item) => state.adaptive_diagnostic_sessions.some((session) => (
          session.username === username && session.id === item.diagnostic_id
        )))
        .map(adaptiveDiagnosticResponseExportDto),
    });
  }

  async function deleteUserData(username) {
    return serializeVoiceTutorMutation(() => withRuleCardLock(async () => {
      await load();
      const user = state.users[username];
      if (!user) return false;
      const telegramId = user.telegram_id == null ? null : String(user.telegram_id);
      for (const entry of state.audit_log) {
        if (entry.metadata?.username === username) {
          delete entry.metadata.username;
          entry.metadata.account_deleted = true;
        }
        if (entry.metadata?.reviewer === username) {
          delete entry.metadata.reviewer;
          entry.metadata.reviewer_account_deleted = true;
        }
      }
      delete state.users[username];
      delete state.progress[username];
      state.writing_attempts = state.writing_attempts.filter((item) => item.username !== username);
      state.speaking_attempts = state.speaking_attempts.filter((item) => item.username !== username);
      state.generated_tasks = state.generated_tasks.filter((item) => item.username !== username);
      state.module_attempts = state.module_attempts.filter((item) => item.username !== username);
      delete state.progress_summary[username];
      delete state.word_progress[username];
      state.error_bank = state.error_bank.filter((item) => item.username !== username);
      state.ai_requests = state.ai_requests.filter((item) => item.username !== username);
      delete state.subscriptions[username];
      delete state.subscription_entitlements[username];
      state.adaptive_learning_goals = state.adaptive_learning_goals.filter((item) => item.username !== username);
      delete state.adaptive_learning_profiles[username];
      delete state.adaptive_learning_skill_estimates[username];
      state.adaptive_learning_plan_revisions = state.adaptive_learning_plan_revisions
        .filter((item) => item.username !== username);
      const diagnosticIds = new Set(state.adaptive_diagnostic_sessions
        .filter((item) => item.username === username).map((item) => item.id));
      state.adaptive_diagnostic_responses = state.adaptive_diagnostic_responses
        .filter((item) => !diagnosticIds.has(item.diagnostic_id));
      state.adaptive_diagnostic_start_claims = state.adaptive_diagnostic_start_claims
        .filter((item) => item.username !== username);
      state.adaptive_diagnostic_sessions = state.adaptive_diagnostic_sessions
        .filter((item) => item.username !== username);
      state.voice_tutor_sessions = state.voice_tutor_sessions.filter((item) => item.username !== username);
      const recoveryIds = new Set(state.voice_tutor_recoveries.filter((item) => item.username === username).map((item) => item.id));
      const repeatIds = new Set(state.voice_tutor_repeats.filter((item) => recoveryIds.has(item.recovery_id)).map((item) => item.id));
      state.voice_tutor_repeat_attempts = state.voice_tutor_repeat_attempts.filter((item) => !repeatIds.has(item.repeat_id));
      state.voice_tutor_repeats = state.voice_tutor_repeats.filter((item) => !recoveryIds.has(item.recovery_id));
      state.voice_tutor_recoveries = state.voice_tutor_recoveries.filter((item) => item.username !== username);
      state.voice_tutor_reports = state.voice_tutor_reports.filter((item) => item.username !== username);
      for (const report of state.voice_tutor_reports) {
        for (const audit of report.review_audit || []) {
          if (audit.reviewer === username) {
            audit.reviewer = null;
            audit.account_deleted = true;
          }
        }
      }
      state.rule_cards = state.rule_cards.filter((card) => card.created_for_username !== username || card.status === 'approved');
      for (const card of state.rule_cards) {
        if (card.created_for_username === username) card.created_for_username = null;
        for (const audit of card.review_audit || []) {
          if (audit.reviewer === username) {
            audit.reviewer = null;
            audit.account_deleted = true;
          }
        }
      }
      state.subscription_events = state.subscription_events.filter((item) => item.username !== username);
      for (const [id, request] of Object.entries(state.payment_requests)) if (request.username === username) delete state.payment_requests[id];
      for (const [id, session] of Object.entries(state.sessions)) {
        if (session.username === username) delete state.sessions[id];
      }
      if (telegramId) {
        for (const [codeHash, entry] of Object.entries(state.auth_codes)) {
          if (String(entry.telegram_id) === telegramId) delete state.auth_codes[codeHash];
        }
      }
      await persist();
      return true;
    }));
  }

  async function healthCheck() {
    await load();
    await writeQueue;
    return true;
  }

  return {
    getUser,
    createUser,
    getProgress,
    saveProgress,
    mergeProgress,
    getUserByTelegram,
    createTelegramUser,
    ensureTelegramUser,
    grantDays,
    createPaymentRequest,
    createPaymentRequestForUser,
    getPaymentRequestForUser,
    listPaymentRequests,
    resolvePaymentRequest,
    revokeEntitlement,
    markTrialUsed,
    activateTrial,
    getSub,
    setEntitlement,
    getVoiceTutorAccess,
    reserveVoiceTutorSession,
    issueVoiceTutorProxyTicket,
    reissueVoiceTutorFallbackNonce,
    consumeVoiceTutorProxyTicket,
    activateVoiceTutorProxySession,
    finalizeVoiceTutorProxySession,
    finishVoiceTutorSession,
    getVoiceTutorSession,
    activateVoiceTutorSession,
    advanceVoiceTutorSession,
    clarifyVoiceTutorSession,
    setVoiceTutorSessionDelivery,
    switchVoiceTutorSessionDelivery,
    submitVoiceTutorRepeat,
    getVoiceTutorRecoveryMap,
    getVoiceTutorRecoveryMetrics,
    createRuleCard,
    claimVoiceTutorRuleDiscovery,
    failVoiceTutorRuleDiscovery,
    createRuleCardForVoiceTutorSession,
    getRuleCard,
    listRuleCards,
    reviewRuleCard,
    getApprovedRuleCard,
    createVoiceTutorReport,
    listVoiceTutorReports,
    reviewVoiceTutorReport,
    setUserRole,
    getPrivacyConsent,
    setPrivacyConsent,
    createTelegramAuthCode,
    confirmTelegramAuthCode,
    consumeTelegramAuthCode,
    createWritingAttempt,
    finishWritingAttempt,
    getWritingAttempt,
    createSpeakingAttempt,
    finishSpeakingAttempt,
    getSpeakingAttempt,
    getGeneratedTask,
    getSharedGeneratedTask,
    saveGeneratedTask,
    upsertBankTask,
    getBankTask,
    getBankTaskByExternalId,
    claimUnseenBankTask,
    recordTaskDelivery,
    listBankTaskContents,
    saveAdaptiveLearningGoal,
    getAdaptiveLearningGoal,
    getAdaptiveLearningEvidenceSources,
    saveAdaptiveLearningProfile,
    getAdaptiveLearningProfile,
    saveAdaptiveLearningPlan,
    getCurrentAdaptiveLearningPlan,
    startAdaptiveDiagnostic,
    getAdaptiveDiagnosticStartClaim,
    getCurrentAdaptiveDiagnostic,
    getAdaptiveDiagnostic,
    getAdaptiveDiagnosticCompletionReplay,
    answerAdaptiveDiagnostic,
    completeAdaptiveDiagnostic,
    recordModuleAttempt,
    getModuleAttempt,
    upsertWordProgress,
    upsertErrorBank,
    logAiRequest,
    claimAiOperationSlot,
    settleAiOperationSlot,
    countAiRequestsSince,
    countAiOperationRequestsSince,
    getAiUsageMetrics,
    createSession,
    isSessionActive,
    revokeSession,
    exportUserData,
    deleteUserData,
    healthCheck,
    async close() { await writeQueue; },
  };
}
