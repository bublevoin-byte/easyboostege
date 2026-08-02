import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashAuthCode, normalizeUsername, normalizeVoiceTutorDeliveryMetadata, subscriptionView, VoiceTutorError, voiceTutorAccessView, voiceTutorBillableSeconds, voiceTutorQuotaPeriods, voiceTutorReservationSeconds } from './shared.js';
import { transitionPedagogicalState } from '../voice-tutor/state-machine.js';
import { transitionRuleCardReview } from '../voice-tutor/rule-card.js';
import { createRecoveryLedger, planRecoveryFromTransfer, planRepeatAttempt, publicRepeatAttempt, recoveryMap, recoveryMetrics } from '../voice-tutor/recovery.js';

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

export function createFileRepository(filePath) {
  let loaded = false;
  let state = { users: {}, progress: {}, progress_summary: {}, auth_codes: {}, writing_attempts: [], speaking_attempts: [], generated_tasks: [], task_bank: [], task_deliveries: [], module_attempts: [], word_progress: {}, error_bank: [], ai_requests: [], audit_log: [], sessions: {}, subscriptions: {}, subscription_entitlements: {}, voice_tutor_sessions: [], voice_tutor_recoveries: [], voice_tutor_repeats: [], voice_tutor_repeat_attempts: [], voice_tutor_reports: [], rule_cards: [], payment_requests: {}, subscription_events: [] };
  let writeQueue = Promise.resolve();
  let voiceTutorQueue = Promise.resolve();
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
            };
          }) : [],
          voice_tutor_recoveries: Array.isArray(parsed.voice_tutor_recoveries) ? parsed.voice_tutor_recoveries : [],
          voice_tutor_repeats: Array.isArray(parsed.voice_tutor_repeats) ? parsed.voice_tutor_repeats : [],
          voice_tutor_repeat_attempts: Array.isArray(parsed.voice_tutor_repeat_attempts) ? parsed.voice_tutor_repeat_attempts : [],
          voice_tutor_reports: Array.isArray(parsed.voice_tutor_reports) ? parsed.voice_tutor_reports : [],
          rule_cards: Array.isArray(parsed.rule_cards) ? parsed.rule_cards : [],
          payment_requests: parsed.payment_requests && typeof parsed.payment_requests === 'object' ? parsed.payment_requests : {},
          subscription_events: Array.isArray(parsed.subscription_events) ? parsed.subscription_events : [],
        };
        if (minimizedLegacyCapsule) await persist();
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
      session.billable_seconds = voiceTutorBillableSeconds(session, session.expires_at);
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

  function serializeVoiceTutorMutation(run) {
    const result = voiceTutorQueue.then(run, run);
    voiceTutorQueue = result.then(() => undefined, () => undefined);
    return result;
  }

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

  async function reserveVoiceTutorSession(username, { id, idempotencyKey, limits, now = new Date(), context = null }) {
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
      const reservedSeconds = voiceTutorReservationSeconds(
        voiceTutorAccessView({ entitled: hasVoiceTutorEntitlement(username, new Date(now).getTime()), ...usage }, limits),
        limits.sessionSeconds,
      );
      const startedAt = new Date(now);
      const session = {
        id,
        username,
        idempotency_key: idempotencyKey,
        status: 'active',
        reserved_seconds: reservedSeconds,
        billable_seconds: null,
        started_at: startedAt.toISOString(),
        expires_at: new Date(startedAt.getTime() + reservedSeconds * 1000).toISOString(),
        ended_at: null,
        ...(context ? {
          capsule: structuredClone(context.capsule),
          capsule_id: context.capsule.id,
          nonce_hash: context.nonceHash,
          delivery_mode: 'voice',
          voice_activated_at: null,
          provider: null,
          model: null,
          prompt_version: null,
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
      return { created: true, session: publicVoiceTutorSession(session), ...await getVoiceTutorAccess(username, limits, now) };
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
        session.billable_seconds = voiceTutorBillableSeconds(session, now);
        session.ended_at = new Date(now).toISOString();
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
        session.billable_seconds = voiceTutorBillableSeconds(session, now, confirmedBillableSeconds);
        session.ended_at = new Date(now).toISOString();
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
      const card = state.rule_cards.find((item) => item.id === cardId);
      const transition = transitionRuleCardReview(card, { decision, reviewer, reviewedAt });
      if (!transition.applied) return { applied: false, card: structuredClone(card) };
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

  async function recordModuleAttempt(username, attempt) {
    await load();
    if (state.module_attempts.some((item) => item.id === attempt.id)) return { id: attempt.id, created: false };
    state.module_attempts.push({ id: attempt.id, username, module: attempt.module, activity: attempt.activity, score: attempt.score, max_score: attempt.maxScore, duration_ms: attempt.durationMs ?? null, metadata: structuredClone(attempt.metadata || {}), created_at: Date.now() });
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
        .map(({ username: owner, idempotency_key, nonce_hash, ...item }) => item),
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
