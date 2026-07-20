import fs from 'node:fs/promises';
import path from 'node:path';
import { hashAuthCode, normalizeUsername, subscriptionView } from './shared.js';

export function createFileRepository(filePath) {
  let loaded = false;
  let state = { users: {}, progress: {}, auth_codes: {}, writing_attempts: [], ai_requests: [] };
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
          ai_requests: Array.isArray(parsed.ai_requests) ? parsed.ai_requests : [],
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
    state.users[username] = { hash, created: Date.now() };
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
    state.users[username] = { telegram_id: Number(telegramId), created: Date.now() };
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
    await persist();
    return { username, sub_until: user.sub_until };
  }

  async function markTrialUsed(telegramId, displayName) {
    await load();
    const username = await ensureTelegramUser(telegramId, displayName);
    state.users[username].trial_used = true;
    await persist();
    return username;
  }

  async function getSub(username) {
    return subscriptionView(await getUser(username));
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

  async function logAiRequest(entry) {
    await load();
    const id = (state.ai_requests.at(-1)?.id || 0) + 1;
    state.ai_requests.push({ id, ...structuredClone(entry), created_at: Date.now() });
    if (state.ai_requests.length > 5000) state.ai_requests = state.ai_requests.slice(-5000);
    await persist();
    return id;
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
        trial_used: Boolean(user.trial_used),
        subscription_until: user.sub_until ?? null,
        created_at: user.created ?? null,
      },
      progress: state.progress[username] || {},
      subscription_events: [],
      writing_attempts: state.writing_attempts.filter((item) => item.username === username),
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
    state.ai_requests = state.ai_requests.filter((item) => item.username !== username);
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
    markTrialUsed,
    getSub,
    createTelegramAuthCode,
    confirmTelegramAuthCode,
    consumeTelegramAuthCode,
    createWritingAttempt,
    finishWritingAttempt,
    logAiRequest,
    exportUserData,
    deleteUserData,
    healthCheck,
    async close() { await writeQueue; },
  };
}
