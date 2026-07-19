import pg from 'pg';
import { hashAuthCode, normalizeUsername, subscriptionView } from './shared.js';

const { Pool } = pg;

function mapUser(row) {
  if (!row) return null;
  return {
    username: row.username,
    hash: row.password_hash || undefined,
    telegram_id: row.telegram_id == null ? undefined : Number(row.telegram_id),
    created: new Date(row.created_at).getTime(),
    sub_until: row.subscription_until ? new Date(row.subscription_until).getTime() : 0,
    trial_used: row.trial_used,
  };
}

export function createPostgresRepository(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL storage');
  const pool = new Pool({ connectionString });

  async function getUser(username) {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return mapUser(result.rows[0]);
  }

  async function createUser(username, hash) {
    try {
      const result = await pool.query(
        'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING *',
        [username, hash],
      );
      return mapUser(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') throw new Error('USER_EXISTS');
      throw error;
    }
  }

  async function getProgress(username) {
    const result = await pool.query('SELECT data FROM user_progress WHERE username = $1', [username]);
    return result.rows[0]?.data || {};
  }

  async function saveProgress(username, data) {
    await pool.query(
      `INSERT INTO user_progress (username, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (username) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [username, JSON.stringify(data || {})],
    );
  }

  async function getUserByTelegram(telegramId) {
    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [String(telegramId)]);
    return mapUser(result.rows[0]);
  }

  async function createTelegramUser(telegramId, displayName) {
    const existing = await getUserByTelegram(telegramId);
    if (existing) return existing.username;
    const base = normalizeUsername(displayName, telegramId);
    for (let suffix = 0; suffix < 1000; suffix++) {
      const username = suffix === 0 ? base : `${base.slice(0, 16)}_${suffix}`;
      try {
        await pool.query(
          'INSERT INTO users (username, telegram_id) VALUES ($1, $2)',
          [username, String(telegramId)],
        );
        return username;
      } catch (error) {
        if (error.code !== '23505') throw error;
        const concurrent = await getUserByTelegram(telegramId);
        if (concurrent) return concurrent.username;
      }
    }
    throw new Error('USERNAME_GENERATION_FAILED');
  }

  async function ensureTelegramUser(telegramId, displayName) {
    const existing = await getUserByTelegram(telegramId);
    return existing ? existing.username : createTelegramUser(telegramId, displayName);
  }

  async function grantDays(telegramId, days, displayName) {
    const username = await ensureTelegramUser(telegramId, displayName);
    const result = await pool.query(
      `UPDATE users
       SET subscription_until = GREATEST(COALESCE(subscription_until, NOW()), NOW()) + ($2 * INTERVAL '1 day'),
           updated_at = NOW()
       WHERE username = $1
       RETURNING subscription_until`,
      [username, Number(days)],
    );
    return { username, sub_until: new Date(result.rows[0].subscription_until).getTime() };
  }

  async function markTrialUsed(telegramId, displayName) {
    const username = await ensureTelegramUser(telegramId, displayName);
    await pool.query('UPDATE users SET trial_used = TRUE, updated_at = NOW() WHERE username = $1', [username]);
    return username;
  }

  async function getSub(username) {
    return subscriptionView(await getUser(username));
  }

  async function createTelegramAuthCode(code, expiresAt) {
    await pool.query('DELETE FROM telegram_auth_codes WHERE expires_at <= NOW()');
    await pool.query(
      `INSERT INTO telegram_auth_codes (code_hash, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (code_hash) DO UPDATE SET
         status = 'pending', telegram_id = NULL, display_name = NULL,
         expires_at = EXCLUDED.expires_at, confirmed_at = NULL, created_at = NOW()`,
      [hashAuthCode(code), new Date(Number(expiresAt))],
    );
  }

  async function confirmTelegramAuthCode(code, telegramId, displayName) {
    const result = await pool.query(
      `UPDATE telegram_auth_codes
       SET status = 'ready', telegram_id = $2, display_name = $3, confirmed_at = NOW()
       WHERE code_hash = $1 AND status = 'pending' AND expires_at > NOW()
       RETURNING code_hash`,
      [hashAuthCode(code), String(telegramId), String(displayName || '').slice(0, 160)],
    );
    return result.rowCount === 1;
  }

  async function consumeTelegramAuthCode(code) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `DELETE FROM telegram_auth_codes
         WHERE code_hash = $1 AND status = 'ready' AND expires_at > NOW()
         RETURNING telegram_id, display_name`,
        [hashAuthCode(code)],
      );
      await client.query('COMMIT');
      if (!result.rowCount) return null;
      return { telegram_id: Number(result.rows[0].telegram_id), name: result.rows[0].display_name || '' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    close: () => pool.end(),
  };
}
