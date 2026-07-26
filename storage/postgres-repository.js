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
    role: row.role || 'student',
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
    await pool.query(
      `INSERT INTO subscriptions (username, status, source, starts_at, ends_at)
       VALUES ($1, 'active', $3, NOW(), $2)
       ON CONFLICT (username) DO UPDATE SET status = 'active', source = EXCLUDED.source,
         ends_at = EXCLUDED.ends_at, updated_at = NOW()`,
      [username, result.rows[0].subscription_until, displayName ? 'trial' : 'manual'],
    );
    return { username, sub_until: new Date(result.rows[0].subscription_until).getTime() };
  }

  async function createPaymentRequest(id, telegramId, displayName) {
    const username = await ensureTelegramUser(telegramId, displayName);
    try {
      const result = await pool.query(
        `INSERT INTO payment_requests (id, username) VALUES ($1, $2)
         RETURNING id, username, status`, [id, username],
      );
      return result.rows[0];
    } catch (error) {
      if (error.code !== '23505') throw error;
      const existing = await pool.query(
        `SELECT id, username, status FROM payment_requests
         WHERE username = $1 AND status = 'new' ORDER BY created_at DESC LIMIT 1`, [username],
      );
      if (existing.rowCount) return existing.rows[0];
      throw error;
    }
  }

  async function resolvePaymentRequest(id, decision, actorTelegramId, days) {
    if (!['approved', 'rejected', 'cancelled'].includes(decision)) throw new Error('INVALID_PAYMENT_DECISION');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT pr.id, pr.username, pr.status, u.telegram_id, u.subscription_until
         FROM payment_requests pr JOIN users u ON u.username = pr.username
         WHERE pr.id = $1 FOR UPDATE`, [id],
      );
      if (!locked.rowCount) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
      const request = locked.rows[0];
      if (request.status !== 'new') {
        await client.query('COMMIT');
        return { applied: false, status: request.status, username: request.username, telegram_id: Number(request.telegram_id), sub_until: request.subscription_until ? new Date(request.subscription_until).getTime() : 0 };
      }
      let subUntil = request.subscription_until;
      if (decision === 'approved') {
        const updated = await client.query(
          `UPDATE users SET subscription_until = GREATEST(COALESCE(subscription_until, NOW()), NOW()) + ($2 * INTERVAL '1 day'), updated_at = NOW()
           WHERE username = $1 RETURNING subscription_until`, [request.username, Number(days)],
        );
        subUntil = updated.rows[0].subscription_until;
        await client.query(
          `INSERT INTO subscriptions (username, status, source, starts_at, ends_at)
           VALUES ($1, 'active', 'manual', NOW(), $2)
           ON CONFLICT (username) DO UPDATE SET status = 'active', source = 'manual', ends_at = EXCLUDED.ends_at, updated_at = NOW()`,
          [request.username, subUntil],
        );
        await client.query(
          `INSERT INTO subscription_events (username, event_type, days, actor_telegram_id, metadata)
           VALUES ($1, 'payment_approved', $2, $3, $4::jsonb)`,
          [request.username, Number(days), String(actorTelegramId), JSON.stringify({ payment_request_id: id })],
        );
      }
      await client.query(
        `UPDATE payment_requests SET status = $2, actor_telegram_id = $3, result = $2, resolved_at = NOW() WHERE id = $1`,
        [id, decision, String(actorTelegramId)],
      );
      await client.query(
        `INSERT INTO audit_log (actor_telegram_id, action, target_type, target_id, result, metadata)
         VALUES ($1, 'payment.resolve', 'payment_request', $2, $3, $4::jsonb)`,
        [String(actorTelegramId), id, decision, JSON.stringify({ username: request.username, days: decision === 'approved' ? Number(days) : 0 })],
      );
      await client.query('COMMIT');
      return { applied: true, status: decision, username: request.username, telegram_id: Number(request.telegram_id), sub_until: subUntil ? new Date(subUntil).getTime() : 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function markTrialUsed(telegramId, displayName) {
    const username = await ensureTelegramUser(telegramId, displayName);
    await pool.query('UPDATE users SET trial_used = TRUE, updated_at = NOW() WHERE username = $1', [username]);
    return username;
  }

  async function activateTrial(telegramId, days, displayName) {
    const username = await ensureTelegramUser(telegramId, displayName);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT trial_used, subscription_until FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (user.rows[0].trial_used) {
        await client.query('COMMIT');
        return { applied: false, username, sub_until: user.rows[0].subscription_until ? new Date(user.rows[0].subscription_until).getTime() : 0 };
      }
      const updated = await client.query(
        `UPDATE users SET trial_used = TRUE,
           subscription_until = GREATEST(COALESCE(subscription_until, NOW()), NOW()) + ($2 * INTERVAL '1 day'), updated_at = NOW()
         WHERE username = $1 RETURNING subscription_until`, [username, Number(days)],
      );
      await client.query(
        `INSERT INTO subscriptions (username, status, source, starts_at, ends_at)
         VALUES ($1, 'active', 'trial', NOW(), $2)
         ON CONFLICT (username) DO UPDATE SET status = 'active', source = 'trial', ends_at = EXCLUDED.ends_at, updated_at = NOW()`,
        [username, updated.rows[0].subscription_until],
      );
      await client.query(
        `INSERT INTO subscription_events (username, event_type, days, actor_telegram_id)
         VALUES ($1, 'trial_activated', $2, $3)`, [username, Number(days), String(telegramId)],
      );
      await client.query('COMMIT');
      return { applied: true, username, sub_until: new Date(updated.rows[0].subscription_until).getTime() };
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async function getSub(username) {
    return subscriptionView(await getUser(username));
  }

  async function setUserRole(username, role) {
    if (!['student', 'admin'].includes(role)) throw new Error('INVALID_ROLE');
    const result = await pool.query(
      'UPDATE users SET role = $2, updated_at = NOW() WHERE username = $1 RETURNING role',
      [username, role],
    );
    if (!result.rowCount) throw new Error('USER_NOT_FOUND');
    return result.rows[0].role;
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

  async function createSpeakingAttempt(username, input, promptVersion) {
    const result = await pool.query(
      `INSERT INTO speaking_attempts (username, task_type, assignment, transcript, prompt_version, status)
       VALUES ($1, $2, $3::jsonb, $4, $5, 'pending') RETURNING id`,
      [username, input.taskType, JSON.stringify(input.assignment), input.transcript, promptVersion],
    );
    return Number(result.rows[0].id);
  }

  async function finishSpeakingAttempt(id, result) {
    const updated = await pool.query(
      `UPDATE speaking_attempts SET status = $2, review = $3::jsonb, provider = $4,
         error_code = $5, evaluated_at = NOW() WHERE id = $1 RETURNING id`,
      [id, result.status, result.review ? JSON.stringify(result.review) : null,
        result.provider || null, result.errorCode || null],
    );
    if (!updated.rowCount) throw new Error('SPEAKING_ATTEMPT_NOT_FOUND');
  }

  async function getGeneratedTask(username, requestHash) {
    const result = await pool.query(
      `SELECT result, provider, prompt_version, created_at FROM generated_tasks
       WHERE username = $1 AND request_hash = $2`, [username, requestHash],
    );
    return result.rows[0] || null;
  }

  // Section 10.8: an identical task is reused whoever generated it first.
  async function getSharedGeneratedTask(requestHash) {
    const result = await pool.query(
      `SELECT result, provider, prompt_version, created_at FROM generated_tasks
       WHERE request_hash = $1 ORDER BY created_at DESC LIMIT 1`, [requestHash],
    );
    return result.rows[0] || null;
  }

  async function saveGeneratedTask(username, entry) {
    const result = await pool.query(
      `INSERT INTO generated_tasks (username, operation, request_hash, request, result, provider, prompt_version)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       ON CONFLICT (username, request_hash) DO UPDATE SET request_hash = EXCLUDED.request_hash
       RETURNING id`,
      [username, entry.operation, entry.requestHash, JSON.stringify(entry.request), JSON.stringify(entry.result), entry.provider, entry.promptVersion],
    );
    return Number(result.rows[0].id);
  }

  async function recordModuleAttempt(username, attempt) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO module_attempts (id, username, module, activity, score, max_score, duration_ms, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO NOTHING RETURNING id, created_at`,
        [attempt.id, username, attempt.module, attempt.activity, attempt.score, attempt.maxScore,
          attempt.durationMs ?? null, JSON.stringify(attempt.metadata || {})],
      );
      if (result.rowCount === 1) {
        await client.query(
          `INSERT INTO progress_summary
           (username, module, attempt_count, best_score, best_max_score, total_duration_ms, last_attempt_at)
           VALUES ($1, $2, 1, $3, $4, $5, $6)
           ON CONFLICT (username, module) DO UPDATE SET
             attempt_count = progress_summary.attempt_count + 1,
             best_score = CASE
               WHEN EXCLUDED.best_score::numeric / EXCLUDED.best_max_score >
                    progress_summary.best_score::numeric / progress_summary.best_max_score
               THEN EXCLUDED.best_score ELSE progress_summary.best_score END,
             best_max_score = CASE
               WHEN EXCLUDED.best_score::numeric / EXCLUDED.best_max_score >
                    progress_summary.best_score::numeric / progress_summary.best_max_score
               THEN EXCLUDED.best_max_score ELSE progress_summary.best_max_score END,
             total_duration_ms = progress_summary.total_duration_ms + EXCLUDED.total_duration_ms,
             last_attempt_at = EXCLUDED.last_attempt_at,
             updated_at = NOW()`,
          [username, attempt.module, attempt.score, attempt.maxScore, attempt.durationMs ?? 0, result.rows[0].created_at],
        );
      }
      await client.query('COMMIT');
      return { id: attempt.id, created: result.rowCount === 1 };
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async function upsertWordProgress(username, words) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of words) {
        await client.query(
          `INSERT INTO word_progress (username, word, stage, error_count, review_count, due_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (username, word) DO UPDATE SET stage = EXCLUDED.stage,
             error_count = EXCLUDED.error_count, review_count = EXCLUDED.review_count,
             due_at = EXCLUDED.due_at, updated_at = NOW()`,
          [username, item.word.toLocaleLowerCase('en'), item.stage, item.errorCount, item.reviewCount, item.dueAt == null ? null : new Date(item.dueAt)],
        );
      }
      await client.query('COMMIT');
      return { updated: words.length };
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async function upsertErrorBank(username, errors) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of errors) {
        await client.query(
          `INSERT INTO error_bank (username, module, item_key, error_type, details)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (username, module, item_key, error_type) DO UPDATE SET
             details = EXCLUDED.details,
             occurrence_count = error_bank.occurrence_count + 1,
             last_seen_at = NOW(),
             resolved_at = NULL`,
          [username, item.module, item.itemKey, item.errorType, JSON.stringify(item.details || {})],
        );
      }
      await client.query('COMMIT');
      return { updated: errors.length };
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async function logAiRequest(entry) {
    const result = await pool.query(
      `INSERT INTO ai_requests
       (username, operation, provider, model, prompt_version, status, duration_ms, error_code, prompt_tokens, completion_tokens, estimated_cost_microusd, fallback_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [entry.username || null, entry.operation, entry.provider || null, entry.model || null,
        entry.promptVersion || null, entry.status, entry.durationMs || null, entry.errorCode || null,
        entry.promptTokens ?? null, entry.completionTokens ?? null, entry.estimatedCostMicrousd ?? null,
        entry.fallbackReason || null],
    );
    return Number(result.rows[0].id);
  }

  async function countAiRequestsSince(since) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ai_requests WHERE created_at >= $1', [since]);
    return Number(result.rows[0].count);
  }

  async function getAiUsageMetrics(hours = 24) {
    const safeHours = Math.max(1, Math.min(Number(hours) || 24, 168));
    const result = await pool.query(
      `SELECT COUNT(*)::int AS requests,
              COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
              COALESCE(SUM(estimated_cost_microusd), 0)::bigint AS estimated_cost_microusd
       FROM ai_requests WHERE created_at >= NOW() - ($1 * INTERVAL '1 hour')`,
      [safeHours],
    );
    const row = result.rows[0];
    return {
      windowHours: safeHours,
      requests: Number(row.requests),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      estimatedCostMicrousd: Number(row.estimated_cost_microusd),
    };
  }

  async function createSession(id, username, expiresAt) {
    await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
    await pool.query(
      'INSERT INTO sessions (id, username, expires_at) VALUES ($1, $2, $3)',
      [id, username, new Date(Number(expiresAt))],
    );
  }

  async function isSessionActive(id, username) {
    const result = await pool.query(
      `SELECT id FROM sessions
       WHERE id = $1 AND username = $2 AND revoked_at IS NULL AND expires_at > NOW()`,
      [id, username],
    );
    return result.rowCount === 1;
  }

  async function revokeSession(id, username) {
    const result = await pool.query(
      `UPDATE sessions SET revoked_at = NOW()
       WHERE id = $1 AND username = $2 AND revoked_at IS NULL
       RETURNING id`,
      [id, username],
    );
    return result.rowCount === 1;
  }

  async function exportUserData(username) {
    const [account, progress, privacyConsent, subscriptionEvents, paymentRequests, writingAttempts, speakingAttempts, generatedTasks, moduleAttempts, progressSummary, wordProgress, errorBank, aiRequests, auditLog] = await Promise.all([
      pool.query('SELECT username, telegram_id, role, trial_used, subscription_until, created_at, updated_at FROM users WHERE username = $1', [username]),
      pool.query('SELECT data, updated_at FROM user_progress WHERE username = $1', [username]),
      pool.query('SELECT text_processing, voice_processing, policy_version, text_consented_at, voice_consented_at, updated_at FROM privacy_consents WHERE username = $1', [username]),
      pool.query('SELECT id, event_type, days, metadata, created_at FROM subscription_events WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, status, actor_telegram_id, result, created_at, resolved_at FROM payment_requests WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, task_type, assignment, answer, review, provider, prompt_version, status, created_at, evaluated_at FROM writing_attempts WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, task_type, assignment, transcript, review, provider, prompt_version, status, error_code, created_at, evaluated_at FROM speaking_attempts WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, operation, request, result, provider, prompt_version, created_at FROM generated_tasks WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, module, activity, score, max_score, duration_ms, metadata, created_at FROM module_attempts WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT module, attempt_count, best_score, best_max_score, total_duration_ms, last_attempt_at, updated_at FROM progress_summary WHERE username = $1 ORDER BY module', [username]),
      pool.query('SELECT word, stage, error_count, review_count, due_at, updated_at FROM word_progress WHERE username = $1 ORDER BY word', [username]),
      pool.query('SELECT id, module, item_key, error_type, details, occurrence_count, first_seen_at, last_seen_at, resolved_at FROM error_bank WHERE username = $1 ORDER BY last_seen_at DESC', [username]),
      pool.query('SELECT id, operation, provider, model, prompt_version, status, duration_ms, error_code, prompt_tokens, completion_tokens, estimated_cost_microusd, created_at FROM ai_requests WHERE username = $1 ORDER BY created_at', [username]),
      pool.query("SELECT id, actor_telegram_id, action, target_type, target_id, result, metadata, created_at FROM audit_log WHERE metadata->>'username' = $1 ORDER BY created_at", [username]),
    ]);
    if (!account.rowCount) return null;
    return {
      exported_at: new Date().toISOString(),
      account: account.rows[0],
      progress: progress.rows[0]?.data || {},
      privacy_consent: privacyConsent.rows[0] || null,
      subscription_events: subscriptionEvents.rows,
      payment_requests: paymentRequests.rows,
      writing_attempts: writingAttempts.rows,
      speaking_attempts: speakingAttempts.rows,
      generated_tasks: generatedTasks.rows,
      module_attempts: moduleAttempts.rows,
      progress_summary: progressSummary.rows,
      word_progress: wordProgress.rows,
      error_bank: errorBank.rows,
      ai_requests: aiRequests.rows,
      audit_log: auditLog.rows,
    };
  }

  async function deleteUserData(username) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM telegram_auth_codes WHERE telegram_id = (SELECT telegram_id FROM users WHERE username = $1)', [username]);
      await client.query('DELETE FROM ai_requests WHERE username = $1', [username]);
      await client.query(
        `UPDATE audit_log
         SET metadata = (metadata - 'username') || '{"account_deleted":true}'::jsonb
         WHERE metadata->>'username' = $1`,
        [username],
      );
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
    getSharedGeneratedTask,
    saveGeneratedTask,
    recordModuleAttempt,
    upsertWordProgress,
    upsertErrorBank,
    logAiRequest,
    countAiRequestsSince,
    getAiUsageMetrics,
    createSession,
    isSessionActive,
    revokeSession,
    exportUserData,
    deleteUserData,
    healthCheck,
    close: () => pool.end(),
  };
}
