import fs from 'node:fs/promises';
import path from 'node:path';
import { hashAuthCode, normalizeUsername, subscriptionView } from './shared.js';

export function createFileRepository(filePath) {
  let loaded = false;
  let state = { users: {}, progress: {}, auth_codes: {}, writing_attempts: [], speaking_attempts: [], generated_tasks: [], module_attempts: [], ai_requests: [], sessions: {}, subscriptions: {}, payment_requests: {}, subscription_events: [] };
  let writeQueue = Promise.resolve();

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        state = {
          users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
          progress: parsed.progress && typeof parsed.progress === 'object' ? parsed.progress : {},
          auth_codes: parsed.auth_codes && typeof parsed.auth_codes === 'object' ? parsed.auth_codes : {},
          writing_attempts: Array.isArray(parsed.writing_attempts) ? parsed.writing_attempts : [],
          speaking_attempts: Array.isArray(parsed.speaking_attempts) ? parsed.speaking_attempts : [],
          generated_tasks: Array.isArray(parsed.generated_tasks) ? parsed.generated_tasks : [],
          module_attempts: Array.isArray(parsed.module_attempts) ? parsed.module_attempts : [],
          ai_requests: Array.isArray(parsed.ai_requests) ? parsed.ai_requests : [],
          sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
          subscriptions: parsed.subscriptions && typeof parsed.subscriptions === 'object' ? parsed.subscriptions : {},
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
      prompt_version: promptVersion,
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
    attempt.error_code = result.errorCode || null;
    attempt.evaluated_at = Date.now();
    await persist();
  }

  async function createSpeakingAttempt(username, input, promptVersion) {
    await load();
    const id = (state.speaking_attempts.at(-1)?.id || 0) + 1;
    state.speaking_attempts.push({ id, username, task_type: input.taskType, assignment: structuredClone(input.assignment), transcript: input.transcript, prompt_version: promptVersion, status: 'pending', created_at: Date.now() });
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
    attempt.error_code = result.errorCode || null;
    attempt.evaluated_at = Date.now();
    await persist();
  }

  async function getGeneratedTask(username, requestHash) {
    await load();
    const task = state.generated_tasks.find((item) => item.username === username && item.request_hash === requestHash);
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

  async function recordModuleAttempt(username, attempt) {
    await load();
    if (state.module_attempts.some((item) => item.id === attempt.id)) return { id: attempt.id, created: false };
    state.module_attempts.push({ id: attempt.id, username, module: attempt.module, activity: attempt.activity, score: attempt.score, max_score: attempt.maxScore, duration_ms: attempt.durationMs ?? null, metadata: structuredClone(attempt.metadata || {}), created_at: Date.now() });
    await persist();
    return { id: attempt.id, created: true };
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
      payment_requests: Object.values(state.payment_requests).filter((item) => item.username === username),
      writing_attempts: state.writing_attempts.filter((item) => item.username === username),
      speaking_attempts: state.speaking_attempts.filter((item) => item.username === username),
      generated_tasks: state.generated_tasks.filter((item) => item.username === username).map(({ request_hash, username: owner, ...item }) => item),
      module_attempts: state.module_attempts.filter((item) => item.username === username),
      ai_requests: state.ai_requests.filter((item) => item.username === username),
    });
  }

  async function deleteUserData(username) {
    await load();
    const user = state.users[username];
    if (!user) return false;
    const telegramId = user.telegram_id == null ? null : String(user.telegram_id);
    delete state.users[username];
    delete state.progress[username];
    state.writing_attempts = state.writing_attempts.filter((item) => item.username !== username);
    state.speaking_attempts = state.speaking_attempts.filter((item) => item.username !== username);
    state.generated_tasks = state.generated_tasks.filter((item) => item.username !== username);
    state.module_attempts = state.module_attempts.filter((item) => item.username !== username);
    state.ai_requests = state.ai_requests.filter((item) => item.username !== username);
    delete state.subscriptions[username];
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
    saveGeneratedTask,
    recordModuleAttempt,
    logAiRequest,
    countAiRequestsSince,
    createSession,
    isSessionActive,
    revokeSession,
    exportUserData,
    deleteUserData,
    healthCheck,
    async close() { await writeQueue; },
  };
}
