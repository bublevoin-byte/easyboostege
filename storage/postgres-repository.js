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

  async function mergeProgress(username, modules) {
    const result = await pool.query(
      `INSERT INTO user_progress (username, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (username) DO UPDATE
       SET data = COALESCE(user_progress.data, '{}'::jsonb) || EXCLUDED.data,
           updated_at = NOW()
       RETURNING data`,
      [username, JSON.stringify(modules || {})],
    );
    return result.rows[0]?.data || {};
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

  async function getPrivacyConsent(username) {
    const result = await pool.query(
      'SELECT text_processing, voice_processing, policy_version, updated_at FROM privacy_consents WHERE username = $1',
      [username],
    );
    return result.rows[0] || { text_processing: false, voice_processing: false, policy_version: null, updated_at: null };
  }

  async function setPrivacyConsent(username, consent) {
    const result = await pool.query(
      `INSERT INTO privacy_consents
       (username, text_processing, voice_processing, policy_version, text_consented_at, voice_consented_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $2 THEN NOW() END, CASE WHEN $3 THEN NOW() END)
       ON CONFLICT (username) DO UPDATE SET
         text_processing = EXCLUDED.text_processing,
         voice_processing = EXCLUDED.voice_processing,
         policy_version = EXCLUDED.policy_version,
         text_consented_at = CASE WHEN EXCLUDED.text_processing THEN COALESCE(privacy_consents.text_consented_at, NOW()) END,
         voice_consented_at = CASE WHEN EXCLUDED.voice_processing THEN COALESCE(privacy_consents.voice_consented_at, NOW()) END,
         updated_at = NOW()
       RETURNING text_processing, voice_processing, policy_version, updated_at`,
      [username, consent.text_processing, consent.voice_processing, consent.policy_version],
    );
    return result.rows[0];
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

  async function createWritingAttempt(username, input, promptVersion) {
    const result = await pool.query(
      `INSERT INTO writing_attempts
       (username, task_type, assignment, answer, prompt_version, status)
       VALUES ($1, $2, $3::jsonb, $4, $5, 'pending')
       RETURNING id`,
      [username, input.taskType, JSON.stringify(input.assignment), input.answer, promptVersion],
    );
    return Number(result.rows[0].id);
  }

  async function finishWritingAttempt(id, result) {
    const updated = await pool.query(
      `UPDATE writing_attempts
       SET status = $2, review = $3::jsonb, provider = $4,
           error_code = $5, evaluated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [id, result.status, result.review ? JSON.stringify(result.review) : null, result.provider || null, result.errorCode || null],
    );
    if (!updated.rowCount) throw new Error('WRITING_ATTEMPT_NOT_FOUND');
  }

  async function logAiRequest(entry) {
    const result = await pool.query(
      `INSERT INTO ai_requests
       (username, operation, provider, model, prompt_version, status, duration_ms, error_code, prompt_tokens, completion_tokens, estimated_cost_microusd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [entry.username || null, entry.operation, entry.provider || null, entry.model || null,
        entry.promptVersion || null, entry.status, entry.durationMs || null, entry.errorCode || null,
        entry.promptTokens ?? null, entry.completionTokens ?? null, entry.estimatedCostMicrousd ?? null],
    );
    return Number(result.rows[0].id);
  }

  async function countAiRequestsSince(since) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ai_requests WHERE created_at >= $1', [since]);
    return Number(result.rows[0].count);
  }

  async function exportUserData(username) {
    const [account, progress, privacyConsent, subscriptionEvents, writingAttempts, aiRequests] = await Promise.all([
      pool.query('SELECT username, telegram_id, trial_used, subscription_until, created_at, updated_at FROM users WHERE username = $1', [username]),
      pool.query('SELECT data, updated_at FROM user_progress WHERE username = $1', [username]),
      pool.query('SELECT text_processing, voice_processing, policy_version, text_consented_at, voice_consented_at, updated_at FROM privacy_consents WHERE username = $1', [username]),
      pool.query('SELECT id, event_type, days, metadata, created_at FROM subscription_events WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, task_type, assignment, answer, review, provider, prompt_version, status, created_at, evaluated_at FROM writing_attempts WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, operation, provider, model, prompt_version, status, duration_ms, error_code, prompt_tokens, completion_tokens, estimated_cost_microusd, created_at FROM ai_requests WHERE username = $1 ORDER BY created_at', [username]),
    ]);
    if (!account.rowCount) return null;
    return {
      exported_at: new Date().toISOString(),
      account: account.rows[0],
      progress: progress.rows[0]?.data || {},
      privacy_consent: privacyConsent.rows[0] || null,
      subscription_events: subscriptionEvents.rows,
      writing_attempts: writingAttempts.rows,
      ai_requests: aiRequests.rows,
    };
  }

  async function deleteUserData(username) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM telegram_auth_codes WHERE telegram_id = (SELECT telegram_id FROM users WHERE username = $1)', [username]);
      await client.query('DELETE FROM ai_requests WHERE username = $1', [username]);
      const deleted = await client.query('DELETE FROM users WHERE username = $1 RETURNING username', [username]);
      await client.query('COMMIT');
      return Boolean(deleted.rowCount);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function healthCheck() {
    await pool.query('SELECT 1');
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
    getPrivacyConsent,
    setPrivacyConsent,
    createTelegramAuthCode,
    confirmTelegramAuthCode,
    consumeTelegramAuthCode,
    createWritingAttempt,
    finishWritingAttempt,
    logAiRequest,
    countAiRequestsSince,
    exportUserData,
    deleteUserData,
    healthCheck,
    close: () => pool.end(),
  };
}
