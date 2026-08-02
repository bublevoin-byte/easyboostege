import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureVoiceTutorReservationAllowed, hashAuthCode, normalizeUsername, subscriptionView, VoiceTutorError, voiceTutorAccessView, voiceTutorBillableSeconds, voiceTutorQuotaPeriods } from './shared.js';
import { transitionPedagogicalState } from '../voice-tutor/state-machine.js';

function normalizeAttemptModels(attempts) {
  return attempts.map((attempt) => ({ ...attempt, model: attempt.model ?? null }));
}

function normalizeWritingAttempts(attempts) {
  return normalizeAttemptModels(attempts).map((attempt) => ({
    ...attempt,
    evaluated_answer: attempt.evaluated_answer ?? attempt.answer ?? null,
  }));
}

export function createFileRepository(filePath) {
  let loaded = false;
  let state = { users: {}, progress: {}, progress_summary: {}, auth_codes: {}, writing_attempts: [], speaking_attempts: [], generated_tasks: [], task_bank: [], task_deliveries: [], module_attempts: [], word_progress: {}, error_bank: [], ai_requests: [], audit_log: [], sessions: {}, subscriptions: {}, subscription_entitlements: {}, voice_tutor_sessions: [], payment_requests: {}, subscription_events: [] };
  let writeQueue = Promise.resolve();
  let voiceTutorQueue = Promise.resolve();

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
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
          voice_tutor_sessions: Array.isArray(parsed.voice_tutor_sessions) ? parsed.voice_tutor_sessions : [],
          payment_requests: parsed.payment_requests && typeof parsed.payment_requests === 'object' ? parsed.payment_requests : {},
          subscription_events: Array.isArray(parsed.subscription_events) ? parsed.subscription_events : [],
        };
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

  async function createPaymentRequest(id, telegramId, displayName) {
    await load();
    const username = await ensureTelegramUser(telegramId, displayName);
    const existing = Object.values(state.payment_requests).find((request) => request.username === username && request.status === 'new');
    if (existing) return structuredClone(existing);
    const request = { id, username, status: 'new', created_at: Date.now() };
    state.payment_requests[id] = request;
    await persist();
    return structuredClone(request);
  }

  async function resolvePaymentRequest(id, decision, actorTelegramId, days) {
    await load();
    if (!['approved', 'rejected', 'cancelled'].includes(decision)) throw new Error('INVALID_PAYMENT_DECISION');
    const request = state.payment_requests[id];
    if (!request) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
    const user = state.users[request.username];
    if (request.status !== 'new') return { applied: false, status: request.status, username: request.username, telegram_id: user.telegram_id, sub_until: user.sub_until || 0 };
    if (decision === 'approved') {
      const now = Date.now();
      user.sub_until = Math.max(now, Number(user.sub_until || 0)) + Number(days) * 86_400_000;
      state.subscriptions[request.username] = { status: 'active', source: 'manual', starts_at: now, ends_at: user.sub_until, updated_at: now };
      state.subscription_events.push({ username: request.username, event_type: 'payment_approved', days: Number(days), actor_telegram_id: Number(actorTelegramId), metadata: { payment_request_id: id }, created_at: now });
    }
    request.status = decision;
    request.actor_telegram_id = Number(actorTelegramId);
    request.result = decision;
    request.resolved_at = Date.now();
    state.audit_log.push({ id: (state.audit_log.at(-1)?.id || 0) + 1, actor_telegram_id: Number(actorTelegramId), action: 'payment.resolve', target_type: 'payment_request', target_id: id, result: decision, metadata: { username: request.username, days: decision === 'approved' ? Number(days) : 0 }, created_at: Date.now() });
    await persist();
    return { applied: true, status: decision, username: request.username, telegram_id: user.telegram_id, sub_until: user.sub_until || 0 };
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
      session.billable_seconds = session.reserved_seconds;
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
      const reservedSeconds = Number(limits.sessionSeconds);
      ensureVoiceTutorReservationAllowed(
        voiceTutorAccessView({ entitled: hasVoiceTutorEntitlement(username, new Date(now).getTime()), ...usage }, limits),
        reservedSeconds,
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
          pedagogical_state: 'diagnose',
          micro_check_passed: null,
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

  async function advanceVoiceTutorSession(username, sessionId, { nonceHash, nextNonceHash, event, now = new Date() }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session || !session.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (session.delivery_mode === 'voice' && new Date(session.expires_at).getTime() <= new Date(now).getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      const next = transitionPedagogicalState({
        state: session.pedagogical_state,
        micro_check_passed: session.micro_check_passed,
        transfer_passed: session.transfer_passed,
        outcome: session.outcome,
      }, event, session.capsule);
      session.pedagogical_state = next.state;
      session.micro_check_passed = next.micro_check_passed;
      session.transfer_passed = next.transfer_passed;
      session.outcome = next.outcome;
      session.nonce_hash = nextNonceHash;
      session.updated_at = new Date(now).toISOString();
      await persist();
      return { session: publicVoiceTutorSession(session), capsule: structuredClone(session.capsule) };
    });
  }

  async function setVoiceTutorSessionDelivery(username, sessionId, { mode, errorCode = null }) {
    return serializeVoiceTutorMutation(async () => {
      await load();
      if (!['voice', 'text', 'local'].includes(mode)) throw new VoiceTutorError('VOICE_TUTOR_DELIVERY_INVALID');
      const session = state.voice_tutor_sessions.find((entry) => entry.username === username && entry.id === sessionId);
      if (!session || !session.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      session.delivery_mode = mode;
      session.error_code = errorCode;
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
        session.billable_seconds = 0;
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

  async function getGeneratedTask(username, requestHash) {
    await load();
    const task = state.generated_tasks.find((item) => item.username === username && item.request_hash === requestHash);
    return task ? structuredClone({ result: task.result, provider: task.provider, prompt_version: task.prompt_version, created_at: task.created_at }) : null;
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
    await load();
    const user = state.users[username];
    if (!user) return false;
    const telegramId = user.telegram_id == null ? null : String(user.telegram_id);
    for (const entry of state.audit_log) {
      if (entry.metadata?.username === username) {
        delete entry.metadata.username;
        entry.metadata.account_deleted = true;
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
    resolvePaymentRequest,
    markTrialUsed,
    activateTrial,
    getSub,
    setEntitlement,
    getVoiceTutorAccess,
    reserveVoiceTutorSession,
    finishVoiceTutorSession,
    getVoiceTutorSession,
    advanceVoiceTutorSession,
    setVoiceTutorSessionDelivery,
    switchVoiceTutorSessionDelivery,
    setUserRole,
    getPrivacyConsent,
    setPrivacyConsent,
    createTelegramAuthCode,
    confirmTelegramAuthCode,
    consumeTelegramAuthCode,
    createWritingAttempt,
    finishWritingAttempt,
    createSpeakingAttempt,
    finishSpeakingAttempt,
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
