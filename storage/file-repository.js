import fs from 'node:fs/promises';
import path from 'node:path';
import { hashAuthCode, normalizeUsername, subscriptionView } from './shared.js';

export function createFileRepository(filePath) {
  let loaded = false;
  let state = { users: {}, progress: {}, auth_codes: {} };
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

  return {
    getUser,
    createUser,
    getProgress,
    saveProgress,
    getUserByTelegram,
    createTelegramUser,
    ensureTelegramUser,
    grantDays,
    markTrialUsed,
    getSub,
    createTelegramAuthCode,
    confirmTelegramAuthCode,
    consumeTelegramAuthCode,
    async close() { await writeQueue; },
  };
}
