import pg from 'pg';
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
  adaptiveLearningSessionPublicDto,
  adaptiveLearningSessionRepositoryDto,
} from '../adaptive-learning/session-dto.js';
import {
  assertAdaptiveSessionCreateCandidate,
  assertAdaptiveSessionReplacementTransition,
} from '../adaptive-learning/session.js';
import {
  adaptiveExecutionEventExportDto,
  adaptiveExecutionSummary,
  adaptiveExecutionTokenHash,
  adaptiveExecutionView,
  adaptiveLaunchFingerprint,
} from '../adaptive-learning/session-execution.js';
import {
  assertAdaptivePlanAuthoritativeCandidate,
  assertAdaptivePlanDuplicateReplay,
  assertAdaptivePlanPersistenceCandidate,
  assertAdaptivePlanStabilityTransition,
  compareAdaptivePlanInputs,
} from '../adaptive-learning/plan.js';
import { hashAuthCode, normalizeUsername, normalizeVoiceTutorDeliveryMetadata, normalizeVoiceTutorProxyHash, subscriptionView, VoiceTutorError, voiceTutorAccessView, voiceTutorBillableSeconds, voiceTutorProxyUsage, voiceTutorQuotaPeriods, voiceTutorReservationSeconds } from './shared.js';
import { transitionPedagogicalState } from '../voice-tutor/state-machine.js';
import { transitionRuleCardReview } from '../voice-tutor/rule-card.js';
import { createRecoveryLedger, planRecoveryFromTransfer, planRepeatAttempt, publicRepeatAttempt, recoveryMap, recoveryMetrics } from '../voice-tutor/recovery.js';

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

function mapRuleCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_for_username: row.created_for_username || null,
    status: row.status,
    skill: { id: row.skill_id, title: row.skill_title },
    exam_year: Number(row.exam_year),
    rule: row.rule_content,
    agreement_hash: row.agreement_hash,
    sources: row.sources,
    discrepancies: row.discrepancies,
    review_audit: row.review_audit,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
  };
}

function mapVoiceTutorReport(row) {
  if (!row) return null;
  return {
    id: row.id, username: row.username, session_id: row.session_id, rule_card_id: row.rule_card_id || null,
    reason: row.reason, status: row.status, review_audit: row.review_audit || [],
    created_at: row.created_at, reviewed_at: row.reviewed_at,
  };
}

export function createPostgresRepository(connectionString, {
  onOperationalError = (event) => console.error(JSON.stringify({
    timestamp: new Date().toISOString(), level: 'error', type: 'postgres_pool_error', ...event,
  })),
  onAdaptiveProfileSnapshot = async () => {},
  onAdaptiveEvidenceSnapshot = async () => {},
} = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL storage');
  const pool = new Pool({ connectionString, application_name: 'easyboost_repository' });
  const finalizationPool = new Pool({
    connectionString, application_name: 'easyboost_voice_finalization', max: 4, connectionTimeoutMillis: 1_000,
  });
  const reportIdleClientError = (poolName) => {
    try { onOperationalError({ code: 'POSTGRES_IDLE_CLIENT_ERROR', pool: poolName }); } catch {}
  };
  pool.on('error', () => reportIdleClientError('primary'));
  finalizationPool.on('error', () => reportIdleClientError('voice_finalization'));

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

  async function createPaymentRequestForUser(id, username, product = 'base', { now = new Date() } = {}) {
    if (!['base', 'premium_voice'].includes(product)) throw new Error('INVALID_PAYMENT_PRODUCT');
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw new Error('INVALID_PAYMENT_TIME');
    try {
      const result = await pool.query(
        `INSERT INTO payment_requests (id, username, product, created_at) VALUES ($1, $2, $3, $4)
         RETURNING id, username, product, status`, [id, username, product, instant],
      );
      return result.rows[0];
    } catch (error) {
      if (error.code !== '23505') throw error;
      const existing = await pool.query(
        `SELECT id, username, product, status FROM payment_requests
         WHERE username = $1 AND product = $2 AND status = 'new' ORDER BY created_at DESC LIMIT 1`, [username, product],
      );
      if (existing.rowCount) return existing.rows[0];
      throw error;
    }
  }

  async function createPaymentRequest(id, telegramId, displayName, options = {}) {
    const username = await ensureTelegramUser(telegramId, displayName);
    return createPaymentRequestForUser(id, username, options.product || 'base', options);
  }

  async function getPaymentRequestForUser(username, product = 'premium_voice') {
    const result = await pool.query(
      `SELECT id, username, product, status, created_at, resolved_at
       FROM payment_requests WHERE username = $1 AND product = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [username, product],
    );
    return result.rows[0] || null;
  }

  async function listPaymentRequests({ product = 'premium_voice', status = 'new' } = {}) {
    if (!['base', 'premium_voice'].includes(product) || !['new', 'approved', 'rejected', 'cancelled'].includes(status)) {
      throw new Error('INVALID_PAYMENT_FILTER');
    }
    const result = await pool.query(
      `SELECT id, username, product, status, created_at, resolved_at
       FROM payment_requests WHERE product = $1 AND status = $2
       ORDER BY created_at, id`,
      [product, status],
    );
    return result.rows;
  }

  async function resolvePaymentRequest(id, decision, actorTelegramId, days, { now = new Date() } = {}) {
    if (!['approved', 'rejected', 'cancelled'].includes(decision)) throw new Error('INVALID_PAYMENT_DECISION');
    const requestedDays = Number(days);
    if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 365) throw new Error('INVALID_SUBSCRIPTION_PERIOD');
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw new Error('INVALID_PAYMENT_TIME');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT pr.id, pr.username, pr.product, pr.status, u.telegram_id, u.subscription_until
         FROM payment_requests pr JOIN users u ON u.username = pr.username
         WHERE pr.id = $1 FOR UPDATE`, [id],
      );
      if (!locked.rowCount) throw new Error('PAYMENT_REQUEST_NOT_FOUND');
      const request = locked.rows[0];
      if (request.status !== 'new') {
        await client.query('COMMIT');
        return { applied: false, status: request.status, product: request.product || 'base', username: request.username, telegram_id: Number(request.telegram_id), sub_until: request.subscription_until ? new Date(request.subscription_until).getTime() : 0 };
      }
      if (decision === 'approved' && Number(actorTelegramId) === Number(request.telegram_id)) {
        throw new Error('PAYMENT_SELF_APPROVAL_FORBIDDEN');
      }
      let subUntil = request.subscription_until;
      if (decision === 'approved') {
        const updated = await client.query(
          `UPDATE users SET subscription_until = GREATEST(COALESCE(subscription_until, $3), $3) + ($2 * INTERVAL '1 day'), updated_at = $3
           WHERE username = $1 RETURNING subscription_until`, [request.username, requestedDays, instant],
        );
        subUntil = updated.rows[0].subscription_until;
        await client.query(
          `INSERT INTO subscriptions (username, status, source, starts_at, ends_at)
           VALUES ($1, 'active', 'manual', $3, $2)
           ON CONFLICT (username) DO UPDATE SET status = 'active', source = 'manual', ends_at = EXCLUDED.ends_at, updated_at = NOW()`,
          [request.username, subUntil, instant],
        );
        if ((request.product || 'base') === 'premium_voice') {
          await client.query(
            `INSERT INTO subscription_entitlements (username, entitlement, starts_at, ends_at)
             VALUES ($1, 'voice_tutor', $2, $3)
             ON CONFLICT (username, entitlement) DO UPDATE SET
               starts_at = LEAST(subscription_entitlements.starts_at, EXCLUDED.starts_at),
               ends_at = EXCLUDED.ends_at, updated_at = $2`,
            [request.username, instant, subUntil],
          );
        }
        await client.query(
          `INSERT INTO subscription_events (username, event_type, days, actor_telegram_id, metadata)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [request.username, (request.product || 'base') === 'premium_voice' ? 'premium_payment_approved' : 'payment_approved',
            requestedDays, String(actorTelegramId), JSON.stringify({ payment_request_id: id, ...((request.product || 'base') === 'premium_voice' ? { product: 'premium_voice' } : {}) })],
        );
      }
      await client.query(
        `UPDATE payment_requests SET status = $2, actor_telegram_id = $3, result = $2, resolved_at = $4 WHERE id = $1`,
        [id, decision, String(actorTelegramId), instant],
      );
      await client.query(
        `INSERT INTO audit_log (actor_telegram_id, action, target_type, target_id, result, metadata)
         VALUES ($1, 'payment.resolve', 'payment_request', $2, $3, $4::jsonb)`,
        [String(actorTelegramId), id, decision, JSON.stringify({ username: request.username, product: request.product || 'base', days: decision === 'approved' ? requestedDays : 0 })],
      );
      await client.query('COMMIT');
      return { applied: true, status: decision, product: request.product || 'base', username: request.username, telegram_id: Number(request.telegram_id), sub_until: subUntil ? new Date(subUntil).getTime() : 0 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function revokeEntitlement(username, entitlement, actorTelegramId, { now = new Date() } = {}) {
    if (entitlement !== 'voice_tutor') throw new Error('INVALID_ENTITLEMENT');
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw new Error('INVALID_PAYMENT_TIME');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!user.rowCount) throw new Error('USER_NOT_FOUND');
      const updated = await client.query(
        `UPDATE subscription_entitlements SET ends_at = $3, updated_at = $3
         WHERE username = $1 AND entitlement = $2 AND starts_at < $3 AND (ends_at IS NULL OR ends_at > $3)
         RETURNING entitlement`,
        [username, entitlement, instant],
      );
      if (updated.rowCount) {
        await client.query(
          `INSERT INTO subscription_events (username, event_type, days, actor_telegram_id, metadata, created_at)
           VALUES ($1, 'premium_revoked', 0, $2, $3::jsonb, $4)`,
          [username, String(actorTelegramId), JSON.stringify({ entitlement }), instant],
        );
        await client.query(
          `INSERT INTO audit_log (actor_telegram_id, action, target_type, target_id, result, metadata, created_at)
           VALUES ($1, 'entitlement.revoke', 'subscription_entitlement', $2, 'revoked', $3::jsonb, $4)`,
          [String(actorTelegramId), entitlement, JSON.stringify({ username }), instant],
        );
      }
      await client.query('COMMIT');
      return Boolean(updated.rowCount);
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

  async function setEntitlement(username, entitlement, { startsAt = new Date(), endsAt = null } = {}) {
    if (!/^[a-z0-9_]{1,64}$/u.test(entitlement)) throw new Error('INVALID_ENTITLEMENT');
    const startsAtDate = new Date(startsAt);
    const endsAtDate = endsAt == null ? null : new Date(endsAt);
    if (!Number.isFinite(startsAtDate.getTime()) || (endsAtDate && (!Number.isFinite(endsAtDate.getTime()) || endsAtDate <= startsAtDate))) {
      throw new Error('INVALID_ENTITLEMENT_PERIOD');
    }
    const result = await pool.query(
      `INSERT INTO subscription_entitlements (username, entitlement, starts_at, ends_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username, entitlement) DO UPDATE SET
         starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, updated_at = NOW()
       RETURNING entitlement`,
      [username, entitlement, startsAtDate, endsAtDate],
    );
    return result.rows[0].entitlement;
  }

  async function readVoiceTutorAccessState(queryable, username, limits, now = new Date()) {
    const instant = new Date(now);
    const { dayStart, monthStart } = voiceTutorQuotaPeriods(instant);
    const [entitlement, usage] = await Promise.all([
      queryable.query(
        `SELECT EXISTS (
           SELECT 1 FROM subscription_entitlements e
           JOIN users u ON u.username = e.username
           WHERE e.username = $1 AND e.entitlement = 'voice_tutor'
             AND u.subscription_until > $2
             AND e.starts_at <= $2 AND (e.ends_at IS NULL OR e.ends_at > $2)
         ) AS entitled`,
        [username, instant],
      ),
      queryable.query(
        `SELECT
           COALESCE(SUM(COALESCE(billable_seconds, reserved_seconds)) FILTER (WHERE started_at >= $2), 0) AS daily_used_seconds,
           COALESCE(SUM(COALESCE(billable_seconds, reserved_seconds)) FILTER (WHERE started_at >= $3), 0) AS monthly_used_seconds,
           COALESCE(BOOL_OR(status = 'active' AND expires_at > $4), FALSE) AS active_session
         FROM voice_tutor_sessions WHERE username = $1`,
        [username, dayStart, monthStart, instant],
      ),
    ]);
    const usageState = {
      entitled: entitlement.rows[0].entitled,
      dailyUsedSeconds: Number(usage.rows[0].daily_used_seconds),
      monthlyUsedSeconds: Number(usage.rows[0].monthly_used_seconds),
      activeSession: usage.rows[0].active_session,
    };
    return { access: voiceTutorAccessView(usageState, limits), usage: usageState };
  }

  async function readVoiceTutorAccess(queryable, username, limits, now = new Date()) {
    return (await readVoiceTutorAccessState(queryable, username, limits, now)).access;
  }

  async function getVoiceTutorAccess(username, limits, now = new Date()) {
    return readVoiceTutorAccess(pool, username, limits, now);
  }

  function mapVoiceTutorSession(row) {
    return {
      id: row.id,
      status: row.status,
      state: row.pedagogical_state || null,
      micro_check_passed: row.micro_check_passed ?? null,
      transfer_passed: row.transfer_passed ?? null,
      outcome: row.outcome ?? null,
      started_at: row.started_at,
      expires_at: row.expires_at,
      ended_at: row.ended_at,
    };
  }

  async function reserveVoiceTutorSession(username, {
    id, idempotencyKey, limits, now = new Date(), context = null, allowFallbackOnly = false,
  }) {
    const client = await pool.connect();
    const instant = new Date(now);
    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!user.rowCount) throw new Error('USER_NOT_FOUND');
      await client.query(
        `UPDATE voice_tutor_sessions SET status = 'expired',
           billable_seconds = CASE
             WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN reserved_seconds
             WHEN capsule_id IS NOT NULL AND voice_activated_at IS NULL THEN 0
             WHEN capsule_id IS NOT NULL THEN LEAST(reserved_seconds, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - voice_activated_at)))::int))
             ELSE reserved_seconds
           END,
           proxy_input_audio_bytes = CASE WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN COALESCE(proxy_input_audio_bytes, 0) ELSE proxy_input_audio_bytes END,
           proxy_output_audio_bytes = CASE WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN COALESCE(proxy_output_audio_bytes, 0) ELSE proxy_output_audio_bytes END,
           proxy_usage_confirmed = CASE WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN FALSE ELSE proxy_usage_confirmed END,
           proxy_finalization_reason = CASE WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN 'timeout' ELSE proxy_finalization_reason END,
           proxy_finalized_at = CASE WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN expires_at ELSE proxy_finalized_at END,
           ended_at = expires_at,
           pedagogical_state = CASE WHEN capsule_id IS NOT NULL AND pedagogical_state NOT IN ('resolved', 'fallback', 'ended') THEN 'ended' ELSE pedagogical_state END,
           outcome = CASE WHEN capsule_id IS NOT NULL AND pedagogical_state NOT IN ('resolved', 'fallback', 'ended') THEN 'ended' ELSE outcome END,
           nonce_hash = CASE WHEN capsule_id IS NOT NULL THEN NULL ELSE nonce_hash END
         WHERE username = $1 AND status = 'active' AND expires_at <= $2`,
        [username, instant],
      );
      const existing = await client.query(
        `SELECT id, status, pedagogical_state, micro_check_passed, transfer_passed, outcome, started_at, voice_activated_at, expires_at, ended_at FROM voice_tutor_sessions
         WHERE username = $1 AND idempotency_key = $2`,
        [username, idempotencyKey],
      );
      if (existing.rowCount) {
        const access = await readVoiceTutorAccess(client, username, limits, instant);
        await client.query('COMMIT');
        return { created: false, session: mapVoiceTutorSession(existing.rows[0]), ...access };
      }
      const access = await readVoiceTutorAccess(client, username, limits, instant);
      let reservedSeconds;
      let fallbackOnly = false;
      try {
        reservedSeconds = voiceTutorReservationSeconds(access, limits.sessionSeconds);
      } catch (error) {
        if (!context || !allowFallbackOnly || !['VOICE_TUTOR_DAILY_QUOTA_EXHAUSTED', 'VOICE_TUTOR_MONTHLY_QUOTA_EXHAUSTED'].includes(error?.code)) throw error;
        reservedSeconds = 0;
        fallbackOnly = true;
      }
      const inserted = await client.query(
        `INSERT INTO voice_tutor_sessions
         (id, username, idempotency_key, status, reserved_seconds, started_at, expires_at,
          capsule_id, capsule, nonce_hash, delivery_mode, pedagogical_state, micro_check_passed, transfer_passed, outcome)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)
         RETURNING id, status, pedagogical_state, micro_check_passed, transfer_passed, outcome, started_at, voice_activated_at, expires_at, ended_at`,
        [id, username, idempotencyKey, reservedSeconds, instant,
          new Date(instant.getTime() + (fallbackOnly ? limits.sessionSeconds : reservedSeconds) * 1000),
          context?.capsule?.id || null, context?.capsule ? JSON.stringify(context.capsule) : null, context?.nonceHash || null,
          context ? (fallbackOnly ? 'local' : 'voice') : null, context ? 'diagnose' : null, null, null, null],
      );
      const updatedAccess = await readVoiceTutorAccess(client, username, limits, instant);
      await client.query('COMMIT');
      return { created: true, fallback_only: fallbackOnly, session: mapVoiceTutorSession(inserted.rows[0]), ...updatedAccess };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function finishVoiceTutorSession(username, sessionId, { limits, now = new Date(), confirmedBillableSeconds = null, preservePedagogicalState = false }) {
    const client = await pool.connect();
    const instant = new Date(now);
    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!user.rowCount) throw new Error('USER_NOT_FOUND');
      await client.query(
        `UPDATE voice_tutor_sessions SET status = 'expired',
           billable_seconds = CASE
             WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN reserved_seconds
             WHEN capsule_id IS NOT NULL AND voice_activated_at IS NULL THEN 0
             WHEN capsule_id IS NOT NULL THEN LEAST(reserved_seconds, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - voice_activated_at)))::int))
             ELSE reserved_seconds
           END,
           proxy_input_audio_bytes = CASE WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN COALESCE(proxy_input_audio_bytes, 0) ELSE proxy_input_audio_bytes END,
           proxy_output_audio_bytes = CASE WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN COALESCE(proxy_output_audio_bytes, 0) ELSE proxy_output_audio_bytes END,
           proxy_usage_confirmed = CASE WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN FALSE ELSE proxy_usage_confirmed END,
           proxy_finalization_reason = CASE WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN 'timeout' ELSE proxy_finalization_reason END,
           proxy_finalized_at = CASE WHEN proxy_ticket_consumed_at IS NOT NULL AND proxy_finalized_at IS NULL THEN expires_at ELSE proxy_finalized_at END,
           ended_at = expires_at,
           pedagogical_state = CASE WHEN capsule_id IS NOT NULL AND pedagogical_state NOT IN ('resolved', 'fallback', 'ended') THEN 'ended' ELSE pedagogical_state END,
           outcome = CASE WHEN capsule_id IS NOT NULL AND pedagogical_state NOT IN ('resolved', 'fallback', 'ended') THEN 'ended' ELSE outcome END,
           nonce_hash = CASE WHEN capsule_id IS NOT NULL THEN NULL ELSE nonce_hash END
         WHERE username = $1 AND status = 'active' AND expires_at <= $2`,
        [username, instant],
      );
      const selected = await client.query(
        `SELECT id, status, reserved_seconds, capsule_id, nonce_hash, pedagogical_state, micro_check_passed, transfer_passed, outcome,
                started_at, voice_activated_at, expires_at, ended_at,
                proxy_ticket_consumed_at, proxy_input_audio_bytes, proxy_output_audio_bytes,
                proxy_usage_confirmed, proxy_finalization_reason, proxy_finalized_at
         FROM voice_tutor_sessions
         WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      if (!selected.rowCount) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      const finished = selected.rows[0].status === 'active';
      const current = selected.rows[0];
      let row = current;
      const pedagogicalEnded = !preservePedagogicalState && current.capsule_id && !['resolved', 'fallback', 'ended'].includes(current.pedagogical_state);
      if (finished || pedagogicalEnded || (!preservePedagogicalState && current.capsule_id && current.nonce_hash)) {
        const proxyUsage = finished && current.proxy_ticket_consumed_at && !current.proxy_finalized_at
          ? voiceTutorProxyUsage(current, {
            inputAudioBytes: Number(current.proxy_input_audio_bytes || 0),
            outputAudioBytes: Number(current.proxy_output_audio_bytes || 0),
            confirmed: false,
            reason: 'server_finish',
            now: instant,
          })
          : null;
        const billableSeconds = finished
          ? proxyUsage?.billable_seconds ?? voiceTutorBillableSeconds(current, instant, confirmedBillableSeconds)
          : null;
        const updated = await client.query(
          `UPDATE voice_tutor_sessions
           SET status = CASE WHEN status = 'active' THEN 'completed' ELSE status END,
               billable_seconds = CASE WHEN status = 'active' THEN $4 ELSE billable_seconds END,
               ended_at = CASE WHEN status = 'active' THEN $3 ELSE ended_at END,
               pedagogical_state = CASE WHEN capsule_id IS NOT NULL AND NOT $5 AND pedagogical_state NOT IN ('resolved', 'fallback', 'ended') THEN 'ended' ELSE pedagogical_state END,
               outcome = CASE WHEN capsule_id IS NOT NULL AND NOT $5 AND pedagogical_state NOT IN ('resolved', 'fallback', 'ended') THEN 'ended' ELSE outcome END,
               nonce_hash = CASE WHEN capsule_id IS NOT NULL AND NOT $5 THEN NULL ELSE nonce_hash END,
               proxy_input_audio_bytes = CASE WHEN $6 THEN $7 ELSE proxy_input_audio_bytes END,
               proxy_output_audio_bytes = CASE WHEN $6 THEN $8 ELSE proxy_output_audio_bytes END,
               proxy_usage_confirmed = CASE WHEN $6 THEN FALSE ELSE proxy_usage_confirmed END,
               proxy_finalization_reason = CASE WHEN $6 THEN 'server_finish' ELSE proxy_finalization_reason END,
               proxy_finalized_at = CASE WHEN $6 THEN $3 ELSE proxy_finalized_at END,
               updated_at = CASE WHEN capsule_id IS NOT NULL THEN $3 ELSE updated_at END
           WHERE username = $1 AND id = $2
           RETURNING id, status, pedagogical_state, micro_check_passed, transfer_passed, outcome,
                     started_at, voice_activated_at, expires_at, ended_at`,
          [username, sessionId, instant, billableSeconds, preservePedagogicalState, Boolean(proxyUsage),
            proxyUsage?.input_audio_bytes ?? null, proxyUsage?.output_audio_bytes ?? null],
        );
        row = updated.rows[0];
      }
      const access = await readVoiceTutorAccess(client, username, limits, instant);
      await client.query('COMMIT');
      return { finished, session: mapVoiceTutorSession(row), ...access };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function getVoiceTutorSession(username, sessionId) {
    const result = await pool.query(
      `SELECT id, username, status, reserved_seconds, billable_seconds, capsule_id, capsule, nonce_hash,
              delivery_mode, pedagogical_state, micro_check_passed, micro_check_attempts, micro_check_passes,
              transfer_passed, outcome, clarification_turns, error_code, provider, model, prompt_version,
              discovery_status, discovery_claim_id, discovery_error_code,
              proxy_ticket_hash, proxy_ticket_issued_at, proxy_ticket_expires_at, proxy_ticket_consumed_at,
              proxy_ticket_reissue_count,
              proxy_input_audio_bytes, proxy_output_audio_bytes, proxy_usage_confirmed,
              proxy_finalization_reason, proxy_finalized_at,
              started_at, voice_activated_at, expires_at, ended_at
       FROM voice_tutor_sessions WHERE username = $1 AND id = $2`,
      [username, sessionId],
    );
    return result.rows[0] || null;
  }

  async function activateVoiceTutorSession(username, sessionId, { nonceHash, now = new Date() }) {
    const client = await pool.connect();
    const instant = new Date(now);
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT capsule, nonce_hash, delivery_mode, status, started_at, expires_at, voice_activated_at
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const row = selected.rows[0];
      if (!row?.capsule || row.delivery_mode !== 'voice' || row.status !== 'active') {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      }
      if (!row.nonce_hash || row.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      if (instant.getTime() < new Date(row.started_at).getTime()
        || new Date(row.expires_at).getTime() <= instant.getTime()) throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      const updated = await client.query(
        `UPDATE voice_tutor_sessions
         SET voice_activated_at = COALESCE(voice_activated_at, $3),
             updated_at = CASE WHEN voice_activated_at IS NULL THEN $3 ELSE updated_at END
         WHERE username = $1 AND id = $2
         RETURNING id, status, pedagogical_state, micro_check_passed, transfer_passed, outcome,
                   started_at, voice_activated_at, expires_at, ended_at`,
        [username, sessionId, instant],
      );
      await client.query('COMMIT');
      return { session: mapVoiceTutorSession(updated.rows[0]), capsule: row.capsule };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  function proxyTicketView(row) {
    return {
      session_id: row.id,
      expires_at: new Date(row.proxy_ticket_expires_at).toISOString(),
      consumed_at: row.proxy_ticket_consumed_at ? new Date(row.proxy_ticket_consumed_at).toISOString() : null,
    };
  }

  async function issueVoiceTutorProxyTicket(username, sessionId, {
    ticketHash, idempotencyKey, expiresAt, now = new Date(), reissue = false, nextNonceHash,
  }) {
    const client = await pool.connect();
    const instant = new Date(now);
    const ticketExpiresAt = new Date(expiresAt);
    const hash = normalizeVoiceTutorProxyHash(ticketHash);
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const selected = await client.query(
        `SELECT id, idempotency_key, status, capsule, nonce_hash, expires_at,
                proxy_ticket_hash, proxy_ticket_expires_at, proxy_ticket_consumed_at,
                proxy_ticket_reissue_count
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const session = selected.rows[0];
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
        await client.query('COMMIT');
        return { issued: false, reissued: false, ticket: proxyTicketView(session) };
      }
      const replacing = Boolean(session.proxy_ticket_hash);
      const rotatingNonce = nextNonceHash != null;
      if (replacing && !reissue) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_ALREADY_ISSUED');
      if (replacing && session.proxy_ticket_consumed_at) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REPLAYED');
      if ((replacing || rotatingNonce) && Number(session.proxy_ticket_reissue_count) >= 1) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT');
      }
      const nonceHash = rotatingNonce
        ? normalizeVoiceTutorProxyHash(nextNonceHash)
        : session.nonce_hash;
      const updated = await client.query(
        `UPDATE voice_tutor_sessions
         SET proxy_ticket_hash = $3, proxy_ticket_issued_at = $4, proxy_ticket_expires_at = $5,
             proxy_ticket_consumed_at = NULL, nonce_hash = $6,
             proxy_ticket_reissue_count = proxy_ticket_reissue_count + $7, updated_at = $4
         WHERE username = $1 AND id = $2
         RETURNING id, proxy_ticket_expires_at, proxy_ticket_consumed_at`,
        [username, sessionId, hash, instant, ticketExpiresAt, nonceHash, replacing || rotatingNonce ? 1 : 0],
      );
      await client.query('COMMIT');
      return { issued: true, reissued: replacing, ticket: proxyTicketView(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      throw error;
    } finally { client.release(); }
  }

  async function reissueVoiceTutorFallbackNonce(username, sessionId, {
    idempotencyKey, nextNonceHash, now = new Date(), recoverLostRealtime = false,
  }) {
    const client = await pool.connect();
    const instant = new Date(now);
    const nonceHash = normalizeVoiceTutorProxyHash(nextNonceHash);
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT id, capsule, idempotency_key, delivery_mode, status, voice_activated_at,
                proxy_ticket_hash, proxy_ticket_consumed_at, proxy_ticket_reissue_count
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const session = selected.rows[0];
      const provisionalVoice = session?.delivery_mode === 'voice' && !session.proxy_ticket_hash && !session.voice_activated_at;
      const lostRealtime = recoverLostRealtime && session?.delivery_mode === 'voice'
        && Boolean(session.proxy_ticket_hash) && !session.proxy_ticket_consumed_at && !session.voice_activated_at
        && Number(session.proxy_ticket_reissue_count) === 1 && session.status === 'active';
      if (!session?.capsule || (!provisionalVoice && !lostRealtime && ![null, 'text', 'local'].includes(session.delivery_mode))) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      }
      if (session.idempotency_key !== idempotencyKey) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      if (!lostRealtime && Number(session.proxy_ticket_reissue_count) >= 1) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REISSUE_LIMIT');
      }
      const updated = await client.query(
        `UPDATE voice_tutor_sessions
         SET nonce_hash = $3,
             proxy_ticket_reissue_count = proxy_ticket_reissue_count + CASE WHEN $6 THEN 0 ELSE 1 END,
             proxy_ticket_hash = CASE WHEN $6 THEN NULL ELSE proxy_ticket_hash END,
             proxy_ticket_issued_at = CASE WHEN $6 THEN NULL ELSE proxy_ticket_issued_at END,
             proxy_ticket_expires_at = CASE WHEN $6 THEN NULL ELSE proxy_ticket_expires_at END,
             proxy_ticket_consumed_at = CASE WHEN $6 THEN NULL ELSE proxy_ticket_consumed_at END,
             delivery_mode = CASE WHEN $5 OR $6 THEN 'local' ELSE delivery_mode END,
             status = CASE WHEN $5 OR $6 THEN 'completed' ELSE status END,
             billable_seconds = CASE WHEN $5 OR $6 THEN 0 ELSE billable_seconds END,
             ended_at = CASE WHEN $5 OR $6 THEN $4 ELSE ended_at END,
             error_code = CASE WHEN $5 OR $6 THEN 'VOICE_TUTOR_PROVIDER_UNAVAILABLE' ELSE error_code END,
             updated_at = $4
         WHERE username = $1 AND id = $2
         RETURNING id, status, pedagogical_state, micro_check_passed, transfer_passed, outcome,
                   started_at, voice_activated_at, expires_at, ended_at`,
        [username, sessionId, nonceHash, instant, session.delivery_mode == null || provisionalVoice, lostRealtime],
      );
      await client.query('COMMIT');
      return { reissued: true, session: mapVoiceTutorSession(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function consumeVoiceTutorProxyTicket(username, input, options = {}) {
    const { ticketHash, now = new Date(), provider, model, promptVersion } = { ...input, ...options };
    const client = await pool.connect();
    const instant = new Date(now);
    const hash = normalizeVoiceTutorProxyHash(ticketHash);
    const metadata = normalizeVoiceTutorDeliveryMetadata({ provider, model, promptVersion });
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      const selected = await client.query(
        `SELECT id, status, reserved_seconds, capsule, expires_at,
                proxy_ticket_expires_at, proxy_ticket_consumed_at
         FROM voice_tutor_sessions
         WHERE username = $1 AND proxy_ticket_hash = $2 FOR UPDATE`,
        [username, hash],
      );
      const session = selected.rows[0];
      if (!session) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
      if (session.proxy_ticket_consumed_at) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_REPLAYED');
      if (!Number.isFinite(instant.getTime())
        || new Date(session.proxy_ticket_expires_at).getTime() <= instant.getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_EXPIRED');
      }
      if (session.status !== 'active' || new Date(session.expires_at).getTime() <= instant.getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      await client.query(
        `UPDATE voice_tutor_sessions
         SET proxy_ticket_consumed_at = $3, provider = $4, model = $5, prompt_version = $6, updated_at = $3
         WHERE username = $1 AND id = $2`,
        [username, session.id, instant, metadata.provider, metadata.model, metadata.prompt_version],
      );
      await client.query('COMMIT');
      return {
        session: {
          id: session.id,
          reserved_seconds: Number(session.reserved_seconds),
          expires_at: new Date(session.expires_at).toISOString(),
        },
        capsule: session.capsule,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function activateVoiceTutorProxySession(username, sessionId, { now = new Date() } = {}) {
    const client = await pool.connect();
    const instant = new Date(now);
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const selected = await client.query(
        `SELECT id, status, reserved_seconds, capsule, started_at, expires_at, voice_activated_at,
                proxy_ticket_consumed_at, proxy_finalized_at
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const session = selected.rows[0];
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
        await client.query(
          `UPDATE voice_tutor_sessions SET voice_activated_at = $3, updated_at = $3
           WHERE username = $1 AND id = $2`,
          [username, sessionId, instant],
        );
      }
      await client.query('COMMIT');
      return {
        activated,
        session: {
          id: session.id,
          reserved_seconds: Number(session.reserved_seconds),
          expires_at: new Date(session.expires_at).toISOString(),
        },
        capsule: session.capsule,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  function proxyUsageView(row) {
    return {
      input_audio_bytes: Number(row.proxy_input_audio_bytes || 0),
      output_audio_bytes: Number(row.proxy_output_audio_bytes || 0),
      confirmed: Boolean(row.proxy_usage_confirmed),
      exact: Boolean(row.proxy_usage_confirmed) && row.proxy_finalization_reason === 'completed',
      billable_seconds: Number(row.billable_seconds),
      reason: row.proxy_finalization_reason,
      finalized_at: new Date(row.proxy_finalized_at).toISOString(),
    };
  }

  async function finalizeVoiceTutorProxySession(username, sessionId, {
    inputAudioBytes, outputAudioBytes, confirmed, reason, now = new Date(), limits,
    attemptTimeoutMs = 1_000,
  }) {
    const attemptTimeout = Math.max(25, Math.min(5_000, Number(attemptTimeoutMs) || 1_000));
    const client = await finalizationPool.connect();
    const instant = new Date(now);
    const timeoutError = Object.assign(new Error('Voice Tutor finalization attempt timeout'), {
      code: 'VOICE_TUTOR_PROXY_FINALIZATION_TIMEOUT',
    });
    let released = false;
    let transactionStarted = false;
    let timedOut = false;
    let resolveTermination;
    const terminated = new Promise((resolve) => { resolveTermination = resolve; });
    const onClientEnd = () => resolveTermination();
    client.once('end', onClientEnd);
    let deadlineTimer;
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        if (!released) {
          released = true;
          client.release(timeoutError);
        }
        void terminated.then(() => reject(timeoutError));
      }, attemptTimeout);
      deadlineTimer.unref?.();
    });
    const transaction = (async () => {
      try {
        await client.query('BEGIN');
        transactionStarted = true;
        await client.query(
          "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)",
          [`${attemptTimeout}ms`],
        );
        const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
        if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
        const selected = await client.query(
          `SELECT id, status, reserved_seconds, pedagogical_state, micro_check_passed, transfer_passed, outcome,
                  started_at, expires_at, ended_at, proxy_ticket_consumed_at,
                  proxy_input_audio_bytes, proxy_output_audio_bytes, proxy_usage_confirmed,
                  proxy_finalization_reason, proxy_finalized_at, billable_seconds
           FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
          [username, sessionId],
        );
        const session = selected.rows[0];
        if (!session) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
        if (!session.proxy_ticket_consumed_at) throw new VoiceTutorError('VOICE_TUTOR_PROXY_TICKET_INVALID');
        if (session.proxy_finalized_at) {
          const access = await readVoiceTutorAccess(client, username, limits, instant);
          await client.query('COMMIT');
          transactionStarted = false;
          return { finalized: false, session: mapVoiceTutorSession(session), usage: proxyUsageView(session), ...access };
        }
        const usage = voiceTutorProxyUsage(session, { inputAudioBytes, outputAudioBytes, confirmed, reason, now: instant });
        const updated = await client.query(
          `UPDATE voice_tutor_sessions
           SET status = 'completed', billable_seconds = $3, ended_at = $4,
               proxy_input_audio_bytes = $5, proxy_output_audio_bytes = $6,
               proxy_usage_confirmed = $7, proxy_finalization_reason = $8,
               proxy_finalized_at = $4, updated_at = $4
           WHERE username = $1 AND id = $2
           RETURNING id, status, reserved_seconds, billable_seconds, pedagogical_state,
                     micro_check_passed, transfer_passed, outcome, started_at, expires_at, ended_at,
                     proxy_input_audio_bytes, proxy_output_audio_bytes, proxy_usage_confirmed,
                     proxy_finalization_reason, proxy_finalized_at`,
          [username, sessionId, usage.billable_seconds, instant, usage.input_audio_bytes,
            usage.output_audio_bytes, usage.confirmed, usage.reason],
        );
        const access = await readVoiceTutorAccess(client, username, limits, instant);
        await client.query('COMMIT');
        transactionStarted = false;
        return { finalized: true, session: mapVoiceTutorSession(updated.rows[0]), usage, ...access };
      } catch (error) {
        if (timedOut) {
          await terminated;
          throw timeoutError;
        }
        const databaseDeadline = error?.code === '57014' || error?.code === '55P03';
        if (transactionStarted) await client.query('ROLLBACK');
        transactionStarted = false;
        if (databaseDeadline) throw timeoutError;
        throw error;
      }
    })();
    try {
      return await Promise.race([transaction, deadline]);
    } finally {
      clearTimeout(deadlineTimer);
      if (!released) {
        client.off('end', onClientEnd);
        released = true;
        client.release();
      }
    }
  }

  async function advanceVoiceTutorSession(username, sessionId, { nonceHash, nextNonceHash, event, capsule = null, now = new Date() }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT capsule, nonce_hash, delivery_mode, expires_at, pedagogical_state, micro_check_passed, transfer_passed, outcome
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const row = selected.rows[0];
      if (!row?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (row.delivery_mode === 'voice' && new Date(row.expires_at).getTime() <= new Date(now).getTime()) {
        throw new VoiceTutorError('VOICE_TUTOR_SESSION_EXPIRED');
      }
      if (!row.nonce_hash || row.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      const transientCapsule = capsule || row.capsule;
      if (transientCapsule.id !== row.capsule.id || transientCapsule.version !== row.capsule.version) {
        throw new VoiceTutorError('VOICE_TUTOR_REVISION_MISMATCH');
      }
      const next = transitionPedagogicalState({
        state: row.pedagogical_state,
        micro_check_passed: row.micro_check_passed,
        transfer_passed: row.transfer_passed,
        outcome: row.outcome,
      }, event, transientCapsule);
      const updated = await client.query(
        `UPDATE voice_tutor_sessions SET pedagogical_state = $3, micro_check_passed = $4,
           transfer_passed = $5, outcome = $6, nonce_hash = $7, updated_at = $8,
           micro_check_attempts = micro_check_attempts + CASE WHEN $9 AND micro_check_attempts < 100 THEN 1 ELSE 0 END,
           micro_check_passes = micro_check_passes + CASE WHEN $9 AND $4 AND micro_check_attempts < 100 THEN 1 ELSE 0 END
         WHERE username = $1 AND id = $2
         RETURNING id, status, pedagogical_state, micro_check_passed, transfer_passed, outcome, started_at, expires_at, ended_at`,
        [username, sessionId, next.state, next.micro_check_passed, next.transfer_passed, next.outcome, nextNonceHash,
          new Date(now), row.pedagogical_state === 'micro_check' && event?.type === 'check_answer'],
      );
      if (event?.type === 'transfer_answer') {
        const plan = planRecoveryFromTransfer({
          ledger: createRecoveryLedger(await readRecoveryRows(client, username)),
          username,
          sessionId,
          capsule: transientCapsule,
          pedagogicalState: next,
          observedAt: now,
        });
        if (plan) {
          const recovery = plan.recovery;
          await client.query(
          `INSERT INTO voice_tutor_recoveries
           (id, username, session_id, skill_id, skill_label, module, rule_id, origin_item_id,
            origin_transfer_task_id, initial_micro_check_passed, initial_transfer_passed,
            terminal_outcome, potential_ege_points, repeat_tasks, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
           ON CONFLICT (session_id) DO NOTHING`,
          [recovery.id, username, recovery.session_id, recovery.skill_id, recovery.skill_label, recovery.module,
            recovery.rule_id, recovery.origin_item_id, recovery.origin_transfer_task_id,
            recovery.initial_micro_check_passed, recovery.initial_transfer_passed, recovery.terminal_outcome,
            recovery.potential_ege_points, JSON.stringify(recovery.repeat_tasks), recovery.observed_at],
        );
          if (plan.supersededRepeatIds.length) {
            await client.query(
              'UPDATE voice_tutor_repeats SET superseded_at = $2 WHERE id = ANY($1::uuid[])',
              [plan.supersededRepeatIds, new Date(now)],
            );
          }
          for (const repeat of plan.repeats) {
            await client.query(
              `INSERT INTO voice_tutor_repeats
               (id, recovery_id, stage, task_id, due_at, window_ends_at, superseded_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [repeat.id, repeat.recovery_id, repeat.stage, repeat.task_id, repeat.due_at, repeat.window_ends_at, repeat.superseded_at],
            );
          }
        }
      }
      await client.query('COMMIT');
      return { session: mapVoiceTutorSession(updated.rows[0]), capsule: row.capsule };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function clarifyVoiceTutorSession(username, sessionId, { nonceHash, nextNonceHash, now = new Date() }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT capsule, nonce_hash, clarification_turns, delivery_mode, pedagogical_state
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const row = selected.rows[0];
      if (!row?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (row.delivery_mode !== 'text' || !['diagnose', 'explain'].includes(row.pedagogical_state)) {
        throw new VoiceTutorError('VOICE_TUTOR_TRANSITION_INVALID');
      }
      if (!row.nonce_hash || row.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      if (Number(row.clarification_turns || 0) >= 3) throw new VoiceTutorError('VOICE_TUTOR_CLARIFICATION_LIMIT');
      const updated = await client.query(
        `UPDATE voice_tutor_sessions SET clarification_turns = clarification_turns + 1,
           nonce_hash = $3, updated_at = $4
         WHERE username = $1 AND id = $2
         RETURNING id, status, pedagogical_state, micro_check_passed, transfer_passed, outcome,
                   clarification_turns, started_at, expires_at, ended_at`,
        [username, sessionId, nextNonceHash, new Date(now)],
      );
      await client.query('COMMIT');
      return {
        session: mapVoiceTutorSession(updated.rows[0]), capsule: row.capsule,
        clarification_turns: Number(updated.rows[0].clarification_turns),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  function mapRecovery(row) {
    return {
      ...row,
      potential_ege_points: Number(row.potential_ege_points),
      observed_at: new Date(row.observed_at).toISOString(),
    };
  }

  function mapRepeat(row) {
    return {
      ...row,
      due_at: new Date(row.due_at).toISOString(),
      window_ends_at: new Date(row.window_ends_at).toISOString(),
      superseded_at: row.superseded_at ? new Date(row.superseded_at).toISOString() : null,
    };
  }

  function mapRepeatAttempt(row) {
    return {
      ...row,
      passed: Boolean(row.passed),
      observed_at: new Date(row.observed_at).toISOString(),
    };
  }

  async function submitVoiceTutorRepeat(username, repeatId, { attemptId, taskId, answer, now = new Date() }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM voice_tutor_repeats WHERE id = $1 FOR UPDATE', [repeatId]);
      const plan = planRepeatAttempt({
        ledger: createRecoveryLedger(await readRecoveryRows(client, username)),
        username, repeatId, attemptId, taskId, answer, now,
      });
      if (!plan.created) {
        await client.query('COMMIT');
        return { created: false, attempt: publicRepeatAttempt(plan.attempt) };
      }
      const inserted = await client.query(
        `INSERT INTO voice_tutor_repeat_attempts (id, repeat_id, task_id, passed, fingerprint, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [plan.attempt.id, plan.attempt.repeat_id, plan.attempt.task_id, plan.attempt.passed,
          plan.attempt.fingerprint, new Date(plan.attempt.observed_at)],
      );
      if (plan.daySevenReschedule) {
        await client.query(
          `UPDATE voice_tutor_repeats
           SET due_at = $2, window_ends_at = $3 WHERE id = $1`,
          [plan.daySevenReschedule.repeatId, new Date(plan.daySevenReschedule.dueAt), new Date(plan.daySevenReschedule.windowEndsAt)],
        );
      }
      await client.query('COMMIT');
      return { created: true, attempt: publicRepeatAttempt(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function readRecoveryRows(client, username = null) {
    const where = username == null ? '' : 'WHERE username = $1';
    const params = username == null ? [] : [username];
    const recoveriesResult = await client.query(`SELECT * FROM voice_tutor_recoveries ${where} ORDER BY observed_at, id`, params);
    const recoveries = recoveriesResult.rows.map(mapRecovery);
    if (!recoveries.length) return { recoveries, repeats: [], attempts: [] };
    const recoveryIds = recoveries.map((entry) => entry.id);
    const repeatsResult = await client.query('SELECT * FROM voice_tutor_repeats WHERE recovery_id = ANY($1::uuid[]) ORDER BY due_at, id', [recoveryIds]);
    const repeats = repeatsResult.rows.map(mapRepeat);
    const attemptsResult = repeats.length
      ? await client.query('SELECT * FROM voice_tutor_repeat_attempts WHERE repeat_id = ANY($1::uuid[]) ORDER BY observed_at, id', [repeats.map((entry) => entry.id)])
      : { rows: [] };
    return { recoveries, repeats, attempts: attemptsResult.rows.map(mapRepeatAttempt) };
  }

  async function getVoiceTutorRecoveryMap(username, { limits, now = new Date() }) {
    const rows = await readRecoveryRows(pool, username);
    const { access, usage } = await readVoiceTutorAccessState(pool, username, limits, now);
    return recoveryMap({ ledger: createRecoveryLedger(rows), access, monthlyUsedSeconds: usage.monthlyUsedSeconds, now });
  }

  async function getVoiceTutorRecoveryMetrics(now = new Date(), { costMicrousdPerMinute = 0 } = {}) {
    const usage = await pool.query(
      `SELECT COUNT(*)::int AS sessions,
              COALESCE(SUM(billable_seconds) FILTER (WHERE delivery_mode = 'voice' OR provider IS NOT NULL), 0)::bigint AS billable_seconds,
              COALESCE(SUM(micro_check_passes), 0)::bigint AS micro_check_passes,
              COALESCE(SUM(micro_check_attempts), 0)::bigint AS micro_check_attempts,
              COUNT(*) FILTER (WHERE delivery_mode = 'voice')::int AS delivery_voice,
              COUNT(*) FILTER (WHERE delivery_mode = 'text')::int AS delivery_text,
              COUNT(*) FILTER (WHERE delivery_mode = 'local')::int AS delivery_local,
              COUNT(*) FILTER (WHERE error_code IN ('VOICE_TUTOR_PROVIDER_UNAVAILABLE', 'VOICE_TUTOR_PROVIDER_CONTRACT_INVALID'))::int AS provider_errors
       FROM voice_tutor_sessions`,
    );
    return recoveryMetrics({
      ledger: createRecoveryLedger(await readRecoveryRows(pool)),
      now,
      sessionCount: Number(usage.rows[0].sessions),
      billableSeconds: Number(usage.rows[0].billable_seconds),
      microCheckPasses: Number(usage.rows[0].micro_check_passes),
      microCheckAttempts: Number(usage.rows[0].micro_check_attempts),
      delivery: {
        voice: Number(usage.rows[0].delivery_voice),
        text: Number(usage.rows[0].delivery_text),
        local: Number(usage.rows[0].delivery_local),
      },
      providerErrors: Number(usage.rows[0].provider_errors),
      costMicrousdPerMinute,
    });
  }

  async function setVoiceTutorSessionDelivery(username, sessionId, {
    mode, errorCode = null, provider, model, promptVersion,
  }) {
    if (!['voice', 'text', 'local'].includes(mode)) throw new VoiceTutorError('VOICE_TUTOR_DELIVERY_INVALID');
    const metadataProvided = provider !== undefined || model !== undefined || promptVersion !== undefined;
    const metadata = metadataProvided ? normalizeVoiceTutorDeliveryMetadata({ provider, model, promptVersion }) : null;
    const result = await pool.query(
      `UPDATE voice_tutor_sessions SET delivery_mode = $3, error_code = $4,
         provider = CASE WHEN $8 THEN $5 ELSE provider END,
         model = CASE WHEN $8 THEN $6 ELSE model END,
         prompt_version = CASE WHEN $8 THEN $7 ELSE prompt_version END,
         updated_at = NOW()
       WHERE username = $1 AND id = $2 AND capsule IS NOT NULL
       RETURNING id, status, pedagogical_state, micro_check_passed, transfer_passed, outcome, started_at, expires_at, ended_at, capsule`,
      [username, sessionId, mode, errorCode, metadata?.provider ?? null, metadata?.model ?? null, metadata?.prompt_version ?? null, metadataProvided],
    );
    if (!result.rowCount) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
    return { session: mapVoiceTutorSession(result.rows[0]), capsule: result.rows[0].capsule };
  }

  async function switchVoiceTutorSessionDelivery(username, sessionId, { nonceHash, nextNonceHash, mode, limits, now = new Date(), errorCode = null }) {
    if (!['text', 'local'].includes(mode)) throw new VoiceTutorError('VOICE_TUTOR_DELIVERY_INVALID');
    const client = await pool.connect();
    const instant = new Date(now);
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT status, reserved_seconds, started_at, voice_activated_at, expires_at, capsule_id, capsule, nonce_hash,
                proxy_ticket_consumed_at, proxy_input_audio_bytes, proxy_output_audio_bytes, proxy_finalized_at
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const row = selected.rows[0];
      if (!row?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (!row.nonce_hash || row.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      const proxyUsage = row.status === 'active' && row.proxy_ticket_consumed_at && !row.proxy_finalized_at
        ? voiceTutorProxyUsage(row, {
          inputAudioBytes: Number(row.proxy_input_audio_bytes || 0),
          outputAudioBytes: Number(row.proxy_output_audio_bytes || 0),
          confirmed: false,
          reason: 'runtime_fallback',
          now: instant,
        })
        : null;
      const billableSeconds = row.status === 'active'
        ? proxyUsage?.billable_seconds ?? voiceTutorBillableSeconds(row, instant)
        : null;
      const updated = await client.query(
        `UPDATE voice_tutor_sessions SET delivery_mode = $3, error_code = $4, nonce_hash = $5,
           status = CASE WHEN status = 'active' THEN 'completed' ELSE status END,
           billable_seconds = CASE WHEN status = 'active' THEN $7 ELSE billable_seconds END,
           ended_at = CASE WHEN status = 'active' THEN $6 ELSE ended_at END,
           proxy_input_audio_bytes = CASE WHEN $8 THEN $9 ELSE proxy_input_audio_bytes END,
           proxy_output_audio_bytes = CASE WHEN $8 THEN $10 ELSE proxy_output_audio_bytes END,
           proxy_usage_confirmed = CASE WHEN $8 THEN FALSE ELSE proxy_usage_confirmed END,
           proxy_finalization_reason = CASE WHEN $8 THEN 'runtime_fallback' ELSE proxy_finalization_reason END,
           proxy_finalized_at = CASE WHEN $8 THEN $6 ELSE proxy_finalized_at END,
           updated_at = $6
         WHERE username = $1 AND id = $2
         RETURNING id, status, pedagogical_state, micro_check_passed, transfer_passed, outcome, started_at, expires_at, ended_at`,
        [username, sessionId, mode, errorCode, nextNonceHash, instant, billableSeconds, Boolean(proxyUsage),
          proxyUsage?.input_audio_bytes ?? null, proxyUsage?.output_audio_bytes ?? null],
      );
      const access = await readVoiceTutorAccess(client, username, limits, instant);
      await client.query('COMMIT');
      return { session: mapVoiceTutorSession(updated.rows[0]), capsule: row.capsule, ...access };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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

  async function createRuleCard(card) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (card.createdForUsername) {
        const owner = await client.query(
          'SELECT username FROM users WHERE username = $1 FOR KEY SHARE',
          [card.createdForUsername],
        );
        if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      }
      const result = await client.query(
        `INSERT INTO trusted_rule_cards
         (id, created_for_username, status, skill_id, skill_title, exam_year, rule_content,
          agreement_hash, sources, discrepancies, created_at)
         VALUES ($1, $2, 'pending_review', $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10)
         RETURNING *`,
        [card.id, card.createdForUsername || null, card.skill.id, card.skill.title, card.examYear,
          JSON.stringify(card.rule), card.agreementHash, JSON.stringify(card.sources),
          JSON.stringify(card.discrepancies || []), card.createdAt],
      );
      await client.query('COMMIT');
      return mapRuleCard(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function claimVoiceTutorRuleDiscovery(username, sessionId, { claimId, nonceHash, now = new Date() }) {
    const client = await pool.connect();
    const instant = new Date(now);
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const selected = await client.query(
        `SELECT status, pedagogical_state, expires_at, capsule, nonce_hash,
                discovery_status, discovery_claim_id
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const session = selected.rows[0];
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      if (session.discovery_status === 'in_progress') throw new VoiceTutorError('TRUSTED_RULE_DISCOVERY_IN_PROGRESS');
      if (session.status !== 'active' || session.pedagogical_state !== 'diagnose'
        || new Date(session.expires_at).getTime() <= instant.getTime() || session.capsule.rule_card_id) {
        throw new VoiceTutorError('TRUSTED_RULE_DISCOVERY_NOT_REQUIRED');
      }
      if (!session.nonce_hash || session.nonce_hash !== nonceHash) throw new VoiceTutorError('VOICE_TUTOR_NONCE_REPLAYED');
      await client.query(
        `UPDATE voice_tutor_sessions
         SET discovery_status = 'in_progress', discovery_claim_id = $3,
             discovery_error_code = NULL, updated_at = $4
         WHERE username = $1 AND id = $2`,
        [username, sessionId, claimId, instant],
      );
      await client.query('COMMIT');
      return { claim_id: claimId, capsule: session.capsule, state: session.pedagogical_state };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function failVoiceTutorRuleDiscovery(username, sessionId, { claimId, errorCode, now = new Date() }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      const updated = await client.query(
        `UPDATE voice_tutor_sessions
         SET discovery_status = 'failed', discovery_claim_id = NULL,
             discovery_error_code = $4, updated_at = $5
         WHERE username = $1 AND id = $2
           AND discovery_status = 'in_progress' AND discovery_claim_id = $3`,
        [username, sessionId, claimId, String(errorCode || 'TRUSTED_RULE_SEARCH_FAILED').slice(0, 80), new Date(now)],
      );
      await client.query('COMMIT');
      return Boolean(updated.rowCount);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function createRuleCardForVoiceTutorSession(username, sessionId, expectedCapsuleId, card, {
    claimId, expectedNonceHash, nextNonceHash,
  } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const session = await client.query(
        `SELECT status, pedagogical_state, capsule_id, capsule, nonce_hash,
                discovery_status, discovery_claim_id
         FROM voice_tutor_sessions
         WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const stored = session.rows[0];
      if (!stored?.capsule || stored.status !== 'active' || stored.pedagogical_state !== 'diagnose'
        || stored.capsule_id !== expectedCapsuleId || stored.capsule.rule_card_id
        || stored.capsule.skill_id !== card.skill.id || stored.discovery_status !== 'in_progress'
        || stored.discovery_claim_id !== claimId || !stored.nonce_hash || stored.nonce_hash !== expectedNonceHash) {
        throw new VoiceTutorError('TRUSTED_RULE_DISCOVERY_NOT_REQUIRED');
      }
      const result = await client.query(
        `INSERT INTO trusted_rule_cards
         (id, created_for_username, status, skill_id, skill_title, exam_year, rule_content,
          agreement_hash, sources, discrepancies, created_at)
         VALUES ($1, $2, 'pending_review', $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10)
         RETURNING *`,
        [card.id, username, card.skill.id, card.skill.title, card.examYear, JSON.stringify(card.rule),
          card.agreementHash, JSON.stringify(card.sources), JSON.stringify(card.discrepancies || []), card.createdAt],
      );
      await client.query(
        `UPDATE voice_tutor_sessions
         SET capsule = capsule || jsonb_build_object('rule_card_id', $3::text),
             pedagogical_state = 'explain', nonce_hash = $4,
             discovery_status = 'completed', discovery_claim_id = NULL,
             discovery_error_code = NULL, updated_at = $5
         WHERE username = $1 AND id = $2`,
        [username, sessionId, card.id, nextNonceHash, card.createdAt],
      );
      await client.query('COMMIT');
      return mapRuleCard(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getRuleCard(cardId) {
    const result = await pool.query('SELECT * FROM trusted_rule_cards WHERE id = $1', [cardId]);
    return mapRuleCard(result.rows[0]);
  }

  async function listRuleCards({ status = 'pending_review' } = {}) {
    const result = status
      ? await pool.query('SELECT * FROM trusted_rule_cards WHERE status = $1 ORDER BY created_at LIMIT 100', [status])
      : await pool.query('SELECT * FROM trusted_rule_cards ORDER BY created_at LIMIT 100');
    return result.rows.map(mapRuleCard);
  }

  async function reviewRuleCard(cardId, { decision, reviewer, reviewedAt }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reviewerAccount = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [reviewer]);
      if (!reviewerAccount.rowCount) throw new Error('USER_NOT_FOUND');
      const found = await client.query('SELECT * FROM trusted_rule_cards WHERE id = $1 FOR UPDATE', [cardId]);
      const transition = transitionRuleCardReview(mapRuleCard(found.rows[0]), { decision, reviewer, reviewedAt });
      if (!transition.applied) {
        await client.query('COMMIT');
        return transition;
      }
      const updated = await client.query(
        `UPDATE trusted_rule_cards SET status = $2, reviewed_at = $3, review_audit = $4::jsonb
         WHERE id = $1 RETURNING *`,
        [cardId, transition.card.status, transition.card.reviewed_at, JSON.stringify(transition.card.review_audit)],
      );
      await client.query('COMMIT');
      return { applied: true, card: mapRuleCard(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505' && error.constraint === 'trusted_rule_cards_one_approved_per_skill_year') {
        throw new VoiceTutorError('RULE_CARD_CANONICAL_EXISTS');
      }
      throw error;
    } finally { client.release(); }
  }

  async function getApprovedRuleCard(skillId, examYear) {
    const result = await pool.query(
      `SELECT * FROM trusted_rule_cards
       WHERE skill_id = $1 AND exam_year = $2 AND status = 'approved'
       ORDER BY reviewed_at DESC, created_at DESC LIMIT 1`,
      [skillId, Number(examYear)],
    );
    return mapRuleCard(result.rows[0]);
  }

  async function createVoiceTutorReport(username, report) {
    const result = await pool.query(
      `INSERT INTO voice_tutor_reports (id, username, session_id, rule_card_id, reason, created_at)
       SELECT $1, session.username, session.id, NULLIF(session.capsule->>'rule_card_id', '')::uuid, $4, $5
       FROM voice_tutor_sessions session
       WHERE session.username = $2 AND session.id = $3 AND session.capsule IS NOT NULL
       ON CONFLICT (username, session_id, reason) DO NOTHING
       RETURNING *`,
      [report.id, username, report.sessionId, report.reason, report.createdAt],
    );
    if (result.rowCount) return { created: true, report: mapVoiceTutorReport(result.rows[0]) };
    const existing = await pool.query(
      'SELECT * FROM voice_tutor_reports WHERE username = $1 AND session_id = $2 AND reason = $3',
      [username, report.sessionId, report.reason],
    );
    if (!existing.rowCount) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
    return { created: false, report: mapVoiceTutorReport(existing.rows[0]) };
  }

  async function listVoiceTutorReports({ status = 'pending' } = {}) {
    const result = status
      ? await pool.query('SELECT * FROM voice_tutor_reports WHERE status = $1 ORDER BY created_at LIMIT 100', [status])
      : await pool.query('SELECT * FROM voice_tutor_reports ORDER BY created_at LIMIT 100');
    return result.rows.map(mapVoiceTutorReport);
  }

  async function reviewVoiceTutorReport(reportId, { decision, reviewer, reviewedAt }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reviewerAccount = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [reviewer]);
      if (!reviewerAccount.rowCount) throw new Error('USER_NOT_FOUND');
      const selected = await client.query('SELECT * FROM voice_tutor_reports WHERE id = $1 FOR UPDATE', [reportId]);
      const report = mapVoiceTutorReport(selected.rows[0]);
      if (!report) throw new VoiceTutorError('VOICE_TUTOR_REPORT_NOT_FOUND');
      if (report.status !== 'pending') {
        if (report.status !== decision) throw new VoiceTutorError('VOICE_TUTOR_REPORT_REVIEW_CONFLICT');
        await client.query('COMMIT');
        return { applied: false, report };
      }
      const audit = [...report.review_audit, { decision, reviewer, reviewed_at: new Date(reviewedAt).toISOString() }];
      const updated = await client.query(
        `UPDATE voice_tutor_reports SET status = $2, reviewed_at = $3, review_audit = $4::jsonb
         WHERE id = $1 RETURNING *`,
        [reportId, decision, reviewedAt, JSON.stringify(audit)],
      );
      await client.query(
        `INSERT INTO audit_log (actor_telegram_id, action, target_type, target_id, result, metadata)
         SELECT COALESCE(telegram_id::text, 'system'), 'voice_tutor.report.review',
                'voice_tutor_report', $1, 'success', $2::jsonb
         FROM users WHERE username = $3`,
        [reportId, JSON.stringify({ reviewer, username: report.username }), reviewer],
      );
      await client.query('COMMIT');
      return { applied: true, report: mapVoiceTutorReport(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getPrivacyConsent(username) {
    const result = await pool.query(
      'SELECT text_processing, voice_processing, policy_version, updated_at FROM privacy_consents WHERE username = $1',
      [username],
    );
    return result.rows[0] || { text_processing: false, voice_processing: false, policy_version: null, updated_at: null };
  }

  async function setPrivacyConsent(username, consent) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const result = await client.query(
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
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
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
       (username, task_type, assignment, answer, evaluated_answer, prompt_version, status)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'pending')
       RETURNING id`,
      [username, input.taskType, JSON.stringify(input.assignment), input.answer,
        input.evaluatedAnswer ?? input.answer, promptVersion],
    );
    return Number(result.rows[0].id);
  }

  async function finishWritingAttempt(id, result) {
    const updated = await pool.query(
      `UPDATE writing_attempts
       SET status = $2, review = $3::jsonb, provider = $4, model = $5,
           error_code = $6, evaluated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [id, result.status, result.review ? JSON.stringify(result.review) : null, result.provider || null,
        result.model || null, result.errorCode || null],
    );
    if (!updated.rowCount) throw new Error('WRITING_ATTEMPT_NOT_FOUND');
  }

  async function getWritingAttempt(username, id) {
    const result = await pool.query(
      `SELECT id, username, task_type, assignment, answer, evaluated_answer, review, provider, model,
              prompt_version, status, error_code, created_at, evaluated_at
       FROM writing_attempts WHERE username = $1 AND id = $2`,
      [username, id],
    );
    return result.rows[0] || null;
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
      `UPDATE speaking_attempts SET status = $2, review = $3::jsonb, provider = $4, model = $5,
         error_code = $6, evaluated_at = NOW() WHERE id = $1 RETURNING id`,
      [id, result.status, result.review ? JSON.stringify(result.review) : null,
        result.provider || null, result.model || null, result.errorCode || null],
    );
    if (!updated.rowCount) throw new Error('SPEAKING_ATTEMPT_NOT_FOUND');
  }

  async function getSpeakingAttempt(username, id) {
    const result = await pool.query(
      `SELECT id, username, task_type, assignment, transcript, review, provider, model,
              prompt_version, status, error_code, created_at, evaluated_at
       FROM speaking_attempts WHERE username = $1 AND id = $2`,
      [username, id],
    );
    return result.rows[0] || null;
  }

  async function getGeneratedTask(username, requestHash) {
    const result = await pool.query(
      `SELECT operation, request, result, provider, prompt_version, created_at FROM generated_tasks
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

  /* ---------- Section 10.1: the shared task bank ---------- */

  async function upsertBankTask(task) {
    const result = await pool.query(
      `INSERT INTO task_bank (operation, external_id, content_hash, content, source, provider, prompt_version)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (operation, content_hash) DO UPDATE SET operation = EXCLUDED.operation
       RETURNING id`,
      [task.operation, task.externalId || null, task.contentHash, JSON.stringify(task.content),
        task.source || 'generated', task.provider || '', task.promptVersion || ''],
    );
    return Number(result.rows[0].id);
  }

  async function getBankTask(taskId) {
    const result = await pool.query(
      'SELECT id, operation, external_id, content, source FROM task_bank WHERE id = $1', [Number(taskId)],
    );
    const row = result.rows[0];
    return row ? { id: Number(row.id), operation: row.operation, externalId: row.external_id, content: row.content, source: row.source } : null;
  }

  async function getBankTaskByExternalId(externalId) {
    const result = await pool.query(
      'SELECT id, operation, external_id, content, source FROM task_bank WHERE external_id = $1', [externalId],
    );
    const row = result.rows[0];
    return row ? { id: Number(row.id), operation: row.operation, externalId: row.external_id, content: row.content, source: row.source } : null;
  }

  /*
   * Hand the student the oldest task they have not been given yet and mark it as delivered in the
   * same transaction. Doing both at once is what stops two parallel requests from spending two paid
   * generations, or from handing out the same task twice.
   */
  async function claimUnseenBankTask(username, operation) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT b.id, b.operation, b.external_id, b.content, b.source FROM task_bank b
         WHERE b.operation = $2 AND b.retired_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM task_deliveries d WHERE d.task_id = b.id AND d.username = $1)
         ORDER BY b.created_at, b.id
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
        [username, operation],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      await client.query(
        'INSERT INTO task_deliveries (username, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [username, row.id],
      );
      await client.query('COMMIT');
      return { id: Number(row.id), operation: row.operation, externalId: row.external_id, content: row.content, source: row.source };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function recordTaskDelivery(username, taskId) {
    await pool.query(
      'INSERT INTO task_deliveries (username, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [username, Number(taskId)],
    );
  }

  async function listBankTaskContents(operation, limit = 60) {
    const result = await pool.query(
      `SELECT content FROM task_bank WHERE operation = $1 AND retired_at IS NULL
       ORDER BY created_at DESC LIMIT $2`, [operation, limit],
    );
    return result.rows.map((row) => row.content);
  }

  async function saveAdaptiveLearningGoal(username, goal) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const duplicate = await client.query(
        'SELECT * FROM adaptive_learning_goals WHERE username = $1 AND idempotency_key = $2',
        [username, goal.idempotencyKey],
      );
      if (duplicate.rowCount) {
        if (duplicate.rows[0].request_hash !== goal.requestHash) throw new Error('ADAPTIVE_GOAL_IDEMPOTENCY_CONFLICT');
        await client.query('COMMIT');
        return { created: false, goal: adaptiveLearningGoalRepositoryDto(duplicate.rows[0]) };
      }
      const revision = await client.query(
        'SELECT COALESCE(MAX(revision), 0)::integer + 1 AS revision FROM adaptive_learning_goals WHERE username = $1',
        [username],
      );
      await client.query('UPDATE adaptive_learning_goals SET current = FALSE WHERE username = $1 AND current', [username]);
      const inserted = await client.query(
        `INSERT INTO adaptive_learning_goals
         (id, username, target_exam, target_score, exam_date, weekly_minutes, revision,
          idempotency_key, request_hash, current, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, TRUE, $10, $10)
         RETURNING *`,
        [goal.id, username, goal.targetExam, goal.targetScore, goal.examDate, goal.weeklyMinutes,
          revision.rows[0].revision, goal.idempotencyKey, goal.requestHash, goal.now],
      );
      await client.query('COMMIT');
      return { created: true, goal: adaptiveLearningGoalRepositoryDto(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getAdaptiveLearningGoal(username) {
    const result = await pool.query(
      'SELECT * FROM adaptive_learning_goals WHERE username = $1 AND current ORDER BY revision DESC LIMIT 1',
      [username],
    );
    return adaptiveLearningGoalRepositoryDto(result.rows[0]);
  }

  async function getAdaptiveLearningEvidenceSources(username) {
    const result = await pool.query(
      `SELECT
         COALESCE((
           SELECT jsonb_agg(to_jsonb(source_attempt) ORDER BY source_attempt.created_at, source_attempt.id)
           FROM (
             SELECT id::text AS id, module, activity, score, max_score, duration_ms,
                    metadata, evidence_quality, created_at
             FROM module_attempts WHERE username = $1
             UNION ALL
             SELECT 'writing:' || id::text, 'writing', task_type,
                    GREATEST(0, LEAST((review->>'overall_max')::numeric, (review->>'overall_got')::numeric)),
                    (review->>'overall_max')::numeric, NULL::integer, '{}'::jsonb,
                    'server_verified_assisted', COALESCE(evaluated_at, created_at)
             FROM writing_attempts
             WHERE username = $1 AND status = 'completed'
               AND jsonb_typeof(review->'overall_got') = 'number'
               AND jsonb_typeof(review->'overall_max') = 'number'
               AND (review->>'overall_max')::numeric > 0
             UNION ALL
             SELECT 'speaking:' || id::text, 'speaking', 'speaking_' || task_type::text,
                    GREATEST(0, LEAST((review->>'max')::numeric, (review->>'got')::numeric)),
                    (review->>'max')::numeric, NULL::integer, '{}'::jsonb,
                    'server_verified_assisted', COALESCE(evaluated_at, created_at)
             FROM speaking_attempts
             WHERE username = $1 AND status = 'completed'
               AND jsonb_typeof(review->'got') = 'number'
               AND jsonb_typeof(review->'max') = 'number'
               AND (review->>'max')::numeric > 0
           ) source_attempt
         ), '[]'::jsonb) AS attempts,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(source_recovery) ORDER BY source_recovery.observed_at, source_recovery.id)
           FROM (
             SELECT id, skill_id, module, initial_micro_check_passed, initial_transfer_passed,
                    terminal_outcome, observed_at
             FROM voice_tutor_recoveries WHERE username = $1
           ) source_recovery
         ), '[]'::jsonb) AS recoveries,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(source_repeat) ORDER BY source_repeat.observed_at, source_repeat.id)
           FROM (
             SELECT attempt.id, attempt.passed, attempt.observed_at, recovery.skill_id, recovery.module
             FROM voice_tutor_repeat_attempts attempt
             JOIN voice_tutor_repeats repeat ON repeat.id = attempt.repeat_id
             JOIN voice_tutor_recoveries recovery ON recovery.id = repeat.recovery_id
             WHERE recovery.username = $1
           ) source_repeat
         ), '[]'::jsonb) AS repeat_attempts,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(source_response) ORDER BY source_response.answered_at, source_response.id)
           FROM (
             SELECT response.id, response.diagnostic_id, diagnostic.catalog_version,
                    response.item_id, response.skill_id, response.module, response.evidence_quality,
                    response.correct, response.answered_at
             FROM adaptive_diagnostic_responses response
             JOIN adaptive_diagnostic_sessions diagnostic ON diagnostic.id = response.diagnostic_id
             WHERE diagnostic.username = $1 AND diagnostic.status = 'completed'
           ) source_response
         ), '[]'::jsonb) AS diagnostic_responses,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
             'catalog_version', catalog_version,
             'completed_at', completed_at
           ) ORDER BY completed_at)
           FROM adaptive_diagnostic_sessions
           WHERE username = $1 AND status = 'completed'
         ), '[]'::jsonb) AS diagnostic_completions`,
      [username],
    );
    const sources = {
      attempts: result.rows[0].attempts,
      recoveries: result.rows[0].recoveries,
      repeatAttempts: result.rows[0].repeat_attempts,
      diagnosticResponses: result.rows[0].diagnostic_responses,
      diagnosticCompletions: result.rows[0].diagnostic_completions,
    };
    await onAdaptiveEvidenceSnapshot({ username, sources });
    return sources;
  }

  async function saveAdaptiveLearningProfile(username, profile, { now = new Date() } = {}) {
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const persisted = await client.query(
        `SELECT profile_calculation_revision, evidence_watermark_version,
                evidence_observed_at, evidence_source_count
         FROM adaptive_learning_profiles WHERE username = $1`,
        [username],
      );
      if (persisted.rowCount && compareAdaptiveEvidenceWatermarks(profile, persisted.rows[0]) <= 0) {
        const currentSnapshot = await readAdaptiveLearningProfile(client, username, { onAdaptiveProfileSnapshot });
        await client.query('COMMIT');
        inTransaction = false;
        return currentSnapshot;
      }
      await client.query(
        `INSERT INTO adaptive_learning_profiles
         (username, taxonomy_version, weighting_version, status, preliminary, confidence, evidence_count,
          independent_evidence_count, assisted_evidence_count, client_reported_evidence_count,
          independent_module_count, established_skill_count, profile_calculation_revision,
          evidence_watermark_version, evidence_observed_at, evidence_source_count,
          needs_diagnostic, explanation_codes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19)
         ON CONFLICT (username) DO UPDATE SET
           taxonomy_version = EXCLUDED.taxonomy_version,
           weighting_version = EXCLUDED.weighting_version,
           status = EXCLUDED.status,
           preliminary = EXCLUDED.preliminary,
           confidence = EXCLUDED.confidence,
           evidence_count = EXCLUDED.evidence_count,
           independent_evidence_count = EXCLUDED.independent_evidence_count,
           assisted_evidence_count = EXCLUDED.assisted_evidence_count,
           client_reported_evidence_count = EXCLUDED.client_reported_evidence_count,
           independent_module_count = EXCLUDED.independent_module_count,
           established_skill_count = EXCLUDED.established_skill_count,
           profile_calculation_revision = EXCLUDED.profile_calculation_revision,
           evidence_watermark_version = EXCLUDED.evidence_watermark_version,
           evidence_observed_at = EXCLUDED.evidence_observed_at,
           evidence_source_count = EXCLUDED.evidence_source_count,
           needs_diagnostic = EXCLUDED.needs_diagnostic,
           explanation_codes = EXCLUDED.explanation_codes,
           updated_at = EXCLUDED.updated_at`,
        [username, profile.taxonomyVersion, profile.weightingVersion, profile.status, profile.preliminary,
          profile.confidence, profile.evidenceCount, profile.independentEvidenceCount,
          profile.assistedEvidenceCount, profile.clientReportedEvidenceCount, profile.independentModuleCount,
          profile.establishedSkillCount, profile.profileCalculationRevision, profile.evidenceWatermarkVersion,
          profile.evidenceObservedAt, profile.evidenceSourceCount, profile.needsDiagnostic,
          JSON.stringify(profile.explanationCodes), now],
      );
      await client.query('DELETE FROM adaptive_learning_skill_estimates WHERE username = $1', [username]);
      for (const skill of profile.skills) {
        await client.query(
          `INSERT INTO adaptive_learning_skill_estimates
           (username, taxonomy_version, skill_id, module, mastery, uncertainty, evidence_count,
            effective_evidence_count, independent_evidence_count, evidence_quality, status,
            last_observed_at, due_state, explanation_code, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [username, profile.taxonomyVersion, skill.id, skill.module, skill.mastery, skill.uncertainty,
            skill.evidenceCount, skill.effectiveEvidenceCount, skill.independentEvidenceCount,
            skill.evidenceQuality, skill.status, skill.lastObservedAt, skill.dueState, skill.explanationCode, now],
        );
      }
      const savedSnapshot = await readAdaptiveLearningProfile(client, username, { onAdaptiveProfileSnapshot });
      await client.query('COMMIT');
      inTransaction = false;
      return savedSnapshot;
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function readAdaptiveLearningProfile(queryable, username, { onAdaptiveProfileSnapshot: afterProfileRead } = {}) {
    const snapshot = await queryable.query(
      `SELECT profile.*,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(estimate) - 'username' ORDER BY estimate.skill_id)
                FROM adaptive_learning_skill_estimates estimate
                WHERE estimate.username = profile.username
              ), '[]'::jsonb) AS estimates
       FROM adaptive_learning_profiles profile
       WHERE profile.username = $1`,
      [username],
    );
    if (snapshot.rowCount && afterProfileRead) {
      await afterProfileRead({ username, profile: snapshot.rows[0] });
    }
    return snapshot.rowCount
      ? adaptiveLearningProfileRepositoryDto(snapshot.rows[0], snapshot.rows[0].estimates)
      : null;
  }

  async function getAdaptiveLearningProfile(username) {
    return readAdaptiveLearningProfile(pool, username, { onAdaptiveProfileSnapshot });
  }

  async function saveAdaptiveLearningPlan(username, candidate) {
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const currentResult = await client.query(
        `SELECT * FROM adaptive_learning_plan_revisions
         WHERE username = $1 AND current ORDER BY revision DESC LIMIT 1`, [username],
      );
      const current = currentResult.rows[0] || null;
      assertAdaptivePlanPersistenceCandidate(candidate);
      const duplicate = await client.query(
        'SELECT * FROM adaptive_learning_plan_revisions WHERE username = $1 AND input_fingerprint = $2',
        [username, candidate.inputFingerprint],
      );
      if (duplicate.rowCount) {
        assertAdaptivePlanDuplicateReplay(candidate, duplicate.rows[0]);
        const historical = Boolean(current) && duplicate.rows[0].id !== current.id;
        await client.query('COMMIT');
        inTransaction = false;
        return {
          created: false,
          stale: historical,
          replayed: true,
          conflict: false,
          reason: historical ? 'historical_fingerprint' : 'current_fingerprint',
          plan: adaptiveLearningPlanRepositoryDto(current || duplicate.rows[0]),
        };
      }
      const goal = await client.query(
        'SELECT * FROM adaptive_learning_goals WHERE username = $1 AND current', [username],
      );
      if (!goal.rowCount || goal.rows[0].id !== candidate.goalId
        || Number(goal.rows[0].revision) !== Number(candidate.goalRevision)) {
        throw new Error('ADAPTIVE_PLAN_GOAL_STALE');
      }
      const authoritativeProfile = await readAdaptiveLearningProfile(client, username);
      assertAdaptivePlanPersistenceCandidate(candidate, {
        authoritativeProfile,
      });
      const currentRevision = current ? Number(current.revision) : null;
      const basePlanRevision = candidate.basePlanRevision == null ? null : Number(candidate.basePlanRevision);
      if (basePlanRevision !== currentRevision) {
        await client.query('COMMIT');
        inTransaction = false;
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
        await client.query('COMMIT');
        inTransaction = false;
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
        authoritativeGoal: adaptiveLearningGoalRepositoryDto(goal.rows[0]),
        authoritativeProfile,
        currentPlan: adaptiveLearningPlanRepositoryDto(current),
      });
      if (Number(candidate.plan?.goalRevision) !== Number(candidate.goalRevision)) {
        throw new Error('ADAPTIVE_PLAN_STABILITY_VIOLATION');
      }
      assertAdaptivePlanStabilityTransition(current, candidate.plan);
      const revisionResult = await client.query(
        `SELECT COALESCE(MAX(revision), 0)::integer + 1 AS revision
         FROM adaptive_learning_plan_revisions WHERE username = $1`, [username],
      );
      await client.query(
        'UPDATE adaptive_learning_plan_revisions SET current = FALSE WHERE username = $1 AND current',
        [username],
      );
      const inserted = await client.query(
        `INSERT INTO adaptive_learning_plan_revisions
         (id, username, plan_version, revision, base_plan_revision, goal_id, goal_revision, taxonomy_version,
          profile_calculation_revision, profile_evidence_watermark_version,
          profile_evidence_observed_at, profile_evidence_source_count, recalculation_bucket,
          input_fingerprint, forecast, allocation, stability, current, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::date, $14,
                 $15::jsonb, $16::jsonb, $17::jsonb, TRUE, $18, $18)
         RETURNING *`,
        [candidate.id, username, candidate.plan.version, revisionResult.rows[0].revision,
          basePlanRevision, candidate.goalId, candidate.goalRevision, candidate.taxonomyVersion,
          candidate.profileCalculationRevision, candidate.profileEvidenceWatermarkVersion,
          candidate.profileEvidenceObservedAt, candidate.profileEvidenceSourceCount,
          candidate.recalculationBucket, candidate.inputFingerprint,
          JSON.stringify(candidate.plan.forecast), JSON.stringify(candidate.plan.allocation),
          JSON.stringify(candidate.plan.stability), candidate.now],
      );
      await client.query('COMMIT');
      inTransaction = false;
      return {
        created: true,
        stale: false,
        replayed: false,
        conflict: false,
        reason: null,
        plan: adaptiveLearningPlanRepositoryDto(inserted.rows[0]),
      };
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getCurrentAdaptiveLearningPlan(username) {
    const result = await pool.query(
      `SELECT * FROM adaptive_learning_plan_revisions
       WHERE username = $1 AND current ORDER BY revision DESC LIMIT 1`, [username],
    );
    return adaptiveLearningPlanRepositoryDto(result.rows[0]);
  }

  async function getAdaptiveLearningPlanRevision(username, revision) {
    const result = await pool.query(
      `SELECT * FROM adaptive_learning_plan_revisions
       WHERE username = $1 AND revision = $2`, [username, revision],
    );
    return adaptiveLearningPlanRepositoryDto(result.rows[0]);
  }

  async function getAdaptiveLearningSessionCreateReplay(username, candidate) {
    const result = await pool.query(
      `SELECT create_request_hash, created_response_snapshot
       FROM adaptive_learning_sessions WHERE username = $1 AND create_idempotency_key = $2`,
      [username, candidate.idempotencyKey],
    );
    if (!result.rowCount) return null;
    if (result.rows[0].create_request_hash !== candidate.requestHash) {
      throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
    }
    return adaptiveLearningSessionPublicDto(result.rows[0].created_response_snapshot);
  }

  async function createAdaptiveLearningSession(username, candidate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      assertAdaptiveSessionCreateCandidate(candidate);
      const duplicate = await client.query(
        `SELECT create_request_hash, created_response_snapshot
         FROM adaptive_learning_sessions WHERE username = $1 AND create_idempotency_key = $2`,
        [username, candidate.idempotencyKey],
      );
      if (duplicate.rowCount) {
        if (duplicate.rows[0].create_request_hash !== candidate.requestHash) {
          throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
        }
        await client.query('COMMIT');
        return {
          created: false, replayed: true,
          session: adaptiveLearningSessionPublicDto(duplicate.rows[0].created_response_snapshot),
        };
      }
      const currentPlan = await client.query(
        `SELECT id, revision FROM adaptive_learning_plan_revisions
         WHERE username = $1 AND current`, [username],
      );
      if (!currentPlan.rowCount || currentPlan.rows[0].id !== candidate.planId
        || Number(currentPlan.rows[0].revision) !== Number(candidate.planRevision)) {
        throw new Error('ADAPTIVE_SESSION_PLAN_STALE');
      }
      const active = await client.query(
        `SELECT id FROM adaptive_learning_sessions
         WHERE username = $1 AND status IN ('created', 'in_progress')`, [username],
      );
      if (active.rowCount) throw new Error('ADAPTIVE_SESSION_ALREADY_CURRENT');
      const session = adaptiveLearningSessionRepositoryDto(candidate.session);
      const inserted = await client.query(
        `INSERT INTO adaptive_learning_sessions
         (id, username, session_version, revision, plan_id, plan_revision, preview_fingerprint,
          composer_policy_version, content_registry_version, taxonomy_version, week_start,
          duration_minutes, learning_minutes, break_minutes, weekly_budget_snapshot, blocks,
          status, current_block_id, completed_learning_minutes, replacement,
          create_idempotency_key, create_request_hash, created_response_snapshot,
          created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15::jsonb, $16::jsonb, $17, $18, $19, $20::jsonb, $21, $22,
                 $23::jsonb, $24, $25)
         RETURNING *`,
        [session.id, username, session.session_version, session.revision, session.plan_id,
          session.plan_revision, session.preview_fingerprint, session.composer_policy_version,
          session.content_registry_version, session.taxonomy_version, session.week_start,
          session.duration_minutes, session.learning_minutes, session.break_minutes,
          JSON.stringify(session.weekly_budget_snapshot), JSON.stringify(session.blocks), session.status,
          session.current_block_id, session.completed_learning_minutes,
          session.replacement == null ? null : JSON.stringify(session.replacement),
          candidate.idempotencyKey, candidate.requestHash, JSON.stringify(candidate.session),
          session.created_at, session.updated_at],
      );
      await client.query('COMMIT');
      return { created: true, replayed: false, session: adaptiveLearningSessionPublicDto(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getCurrentAdaptiveLearningSession(username) {
    const result = await pool.query(
      `SELECT * FROM adaptive_learning_sessions
       WHERE username = $1 AND status IN ('created', 'in_progress')
       ORDER BY created_at DESC LIMIT 1`, [username],
    );
    return adaptiveLearningSessionPublicDto(result.rows[0]);
  }

  async function getAdaptiveLearningSessionReplacementReplay(username, sessionId, candidate) {
    const result = await pool.query(
      `SELECT id, replacement_request_hash, replacement_response_snapshot
       FROM adaptive_learning_sessions WHERE username = $1 AND replacement_idempotency_key = $2`,
      [username, candidate.idempotencyKey],
    );
    if (!result.rowCount) return null;
    if (result.rows[0].id !== sessionId
      || result.rows[0].replacement_request_hash !== candidate.requestHash) {
      throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
    }
    return adaptiveLearningSessionPublicDto(result.rows[0].replacement_response_snapshot);
  }

  async function replaceAdaptiveLearningSessionBlock(username, candidate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const replay = await client.query(
        `SELECT id, replacement_request_hash, replacement_response_snapshot
         FROM adaptive_learning_sessions
         WHERE username = $1 AND replacement_idempotency_key = $2 FOR UPDATE`,
        [username, candidate.idempotencyKey],
      );
      if (replay.rowCount) {
        if (replay.rows[0].id !== candidate.sessionId
          || replay.rows[0].replacement_request_hash !== candidate.requestHash) {
          throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
        }
        await client.query('COMMIT');
        return {
          replaced: false, replayed: true,
          session: adaptiveLearningSessionPublicDto(replay.rows[0].replacement_response_snapshot),
        };
      }
      const existing = await client.query(
        'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, candidate.sessionId],
      );
      if (!existing.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const row = existing.rows[0];
      if (row.replacement_idempotency_key || row.replacement) {
        throw new Error('ADAPTIVE_SESSION_REPLACEMENT_ALREADY_USED');
      }
      if (Number(row.revision) !== Number(candidate.expectedRevision)) {
        throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
      }
      assertAdaptiveSessionReplacementTransition(adaptiveLearningSessionPublicDto(row), candidate);
      const session = adaptiveLearningSessionRepositoryDto(candidate.session);
      const updated = await client.query(
        `UPDATE adaptive_learning_sessions
         SET revision = $3, weekly_budget_snapshot = $4::jsonb, blocks = $5::jsonb,
             replacement = $6::jsonb, replacement_idempotency_key = $7,
             replacement_request_hash = $8, replacement_response_snapshot = $9::jsonb,
             updated_at = $10
         WHERE username = $1 AND id = $2
         RETURNING *`,
        [username, candidate.sessionId, session.revision,
          JSON.stringify(session.weekly_budget_snapshot), JSON.stringify(session.blocks),
          JSON.stringify(session.replacement), candidate.idempotencyKey, candidate.requestHash,
          JSON.stringify(candidate.session), session.updated_at],
      );
      await client.query('COMMIT');
      return { replaced: true, replayed: false, session: adaptiveLearningSessionPublicDto(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function adaptiveMutationReplay(queryable, username, candidate, lock = false) {
    const result = await queryable.query(
      `SELECT operation, session_id, request_hash, response_snapshot
       FROM adaptive_learning_session_mutations
       WHERE username = $1 AND idempotency_key = $2${lock ? ' FOR UPDATE' : ''}`,
      [username, candidate.idempotencyKey],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (row.operation !== candidate.operation || row.session_id !== candidate.sessionId
      || row.request_hash !== candidate.requestHash) {
      throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
    }
    return structuredClone(row.response_snapshot);
  }

  async function adaptiveSessionEvents(queryable, username, sessionId) {
    const result = await queryable.query(
      `SELECT * FROM adaptive_learning_session_events
       WHERE username = $1 AND session_id = $2 ORDER BY sequence`,
      [username, sessionId],
    );
    return result.rows;
  }

  async function getAdaptiveLearningSessionMutationReplay(username, candidate) {
    return adaptiveMutationReplay(pool, username, candidate);
  }

  async function startAdaptiveLearningSessionBlock(username, candidate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const replay = await adaptiveMutationReplay(client, username, { ...candidate, operation: 'start' }, true);
      if (replay) {
        await client.query('COMMIT');
        return { created: false, replayed: true, responseSnapshot: replay };
      }
      const existing = await client.query(
        'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, candidate.sessionId],
      );
      if (!existing.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const row = existing.rows[0];
      if (!['created', 'in_progress'].includes(row.status)) throw new Error('ADAPTIVE_SESSION_STATE_CONFLICT');
      if (Number(row.execution_revision) !== Number(candidate.expectedRevision)) {
        throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
      }
      if (row.current_block_id !== candidate.blockId) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
      const block = row.blocks.find((item) => item.id === candidate.blockId);
      if (!block || block.kind !== 'learning') throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_LAUNCHABLE');
      const active = await client.query(
        `SELECT id, expires_at FROM adaptive_learning_execution_claims
         WHERE username = $1 AND session_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
        [username, row.id],
      );
      if (active.rows.some((claim) => new Date(claim.expires_at) > new Date(candidate.now))) {
        throw new Error('ADAPTIVE_SESSION_BLOCK_ALREADY_STARTED');
      }
      await client.query(
        `UPDATE adaptive_learning_execution_claims SET revoked_at = $3
         WHERE username = $1 AND session_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [username, row.id, candidate.now],
      );
      const nextRevision = Number(row.execution_revision) + 1;
      if (candidate.responseSnapshot?.execution?.revision !== nextRevision
        || candidate.responseSnapshot?.block?.id !== block.id
        || candidate.responseSnapshot?.executionClaim !== candidate.token
        || adaptiveExecutionTokenHash(candidate.token) !== candidate.tokenHash
        || candidate.responseSnapshot?.claimExpiresAt !== new Date(candidate.expiresAt).toISOString()) {
        throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
      }
      await client.query(
        `INSERT INTO adaptive_learning_execution_claims
         (id, username, session_id, block_id, session_execution_revision, token_hash,
          launch_fingerprint, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [candidate.claimId, username, row.id, block.id, nextRevision, candidate.tokenHash,
          adaptiveLaunchFingerprint(block), candidate.now, candidate.expiresAt],
      );
      await client.query(
        `UPDATE adaptive_learning_sessions
         SET execution_revision = $3, status = 'in_progress', started_at = COALESCE(started_at, $4), updated_at = $4
         WHERE username = $1 AND id = $2`,
        [username, row.id, nextRevision, candidate.now],
      );
      await client.query(
        `INSERT INTO adaptive_learning_session_mutations
         (username, idempotency_key, operation, session_id, request_hash, response_snapshot, created_at)
         VALUES ($1, $2, 'start', $3, $4, $5::jsonb, $6)`,
        [username, candidate.idempotencyKey, row.id, candidate.requestHash,
          JSON.stringify(candidate.responseSnapshot), candidate.now],
      );
      await client.query('COMMIT');
      return { created: true, replayed: false, responseSnapshot: structuredClone(candidate.responseSnapshot) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getAdaptiveLearningSessionExecution(username, sessionId) {
    const result = await pool.query(
      'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2',
      [username, sessionId],
    );
    if (!result.rowCount) return null;
    const events = await adaptiveSessionEvents(pool, username, sessionId);
    return {
      session: adaptiveLearningSessionPublicDto(result.rows[0]),
      execution: adaptiveExecutionView(result.rows[0], events),
      events: events.map(adaptiveExecutionEventExportDto),
      summary: result.rows[0].completion_summary || null,
    };
  }

  async function adaptiveAdvanceSource(queryable, username, row, block, attempt) {
    if (block.kind === 'break') {
      if (attempt != null) throw new Error('ADAPTIVE_SESSION_BREAK_ATTEMPT_FORBIDDEN');
      return { source_type: null, source_ref: null, evidence_quality: null, actual_minutes: null };
    }
    if (!attempt) throw new Error('ADAPTIVE_SESSION_ATTEMPT_REQUIRED');
    const claimResult = await queryable.query(
      `SELECT * FROM adaptive_learning_execution_claims
       WHERE username = $1 AND session_id = $2 AND block_id = $3
         AND attempt_type = $4 AND attempt_ref = $5 AND consumed_at IS NOT NULL AND revoked_at IS NULL`,
      [username, row.id, block.id, attempt.type, String(attempt.id)],
    );
    if (!claimResult.rowCount) throw new Error('ADAPTIVE_SESSION_ATTEMPT_NOT_BOUND');
    const claim = claimResult.rows[0];
    if (claim.launch_fingerprint !== adaptiveLaunchFingerprint(block)) {
      throw new Error('ADAPTIVE_SESSION_ATTEMPT_MISMATCH');
    }
    if (attempt.type === 'module') {
      const source = await queryable.query(
        `SELECT * FROM module_attempts WHERE username = $1 AND id = $2
         AND module = $3 AND activity = $4
         AND metadata->>'adaptive_session_id' = $5 AND metadata->>'adaptive_block_id' = $6`,
        [username, attempt.id, block.module, block.activityId, row.id, block.id],
      );
      if (!source.rowCount || new Date(source.rows[0].created_at) < new Date(claim.issued_at)) {
        throw new Error('ADAPTIVE_SESSION_ATTEMPT_MISMATCH');
      }
      return {
        source_type: 'module', source_ref: source.rows[0].id,
        evidence_quality: source.rows[0].evidence_quality,
        actual_minutes: source.rows[0].duration_ms == null
          ? null : Math.max(0, Math.round(Number(source.rows[0].duration_ms) / 60_000)),
      };
    }
    const table = attempt.type === 'writing' ? 'writing_attempts' : 'speaking_attempts';
    const source = await queryable.query(
      `SELECT id, status, created_at FROM ${table} WHERE username = $1 AND id = $2`,
      [username, attempt.id],
    );
    if (!source.rowCount || source.rows[0].status !== 'completed'
      || new Date(source.rows[0].created_at) < new Date(claim.issued_at)) {
      throw new Error('ADAPTIVE_SESSION_ATTEMPT_MISMATCH');
    }
    return {
      source_type: attempt.type, source_ref: String(source.rows[0].id),
      evidence_quality: 'server_verified_assisted', actual_minutes: null,
    };
  }

  async function getAdaptiveLearningSessionAdvanceContext(username, candidate) {
    const result = await pool.query(
      'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2',
      [username, candidate.sessionId],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (Number(row.execution_revision) !== Number(candidate.expectedRevision)) {
      throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
    }
    if (row.current_block_id !== candidate.blockId) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
    const block = row.blocks.find((item) => item.id === candidate.blockId);
    if (!block) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
    const source = await adaptiveAdvanceSource(pool, username, row, block, candidate.attempt);
    const events = await adaptiveSessionEvents(pool, username, row.id);
    const nextBlock = row.blocks.find((item) => item.position === block.position + 1) || null;
    return {
      session: adaptiveLearningSessionPublicDto(row), execution: adaptiveExecutionView(row, events),
      block: structuredClone(block), source, nextBlock: nextBlock ? structuredClone(nextBlock) : null,
    };
  }

  async function advanceAdaptiveLearningSession(username, candidate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      const replay = await adaptiveMutationReplay(client, username, { ...candidate, operation: 'advance' }, true);
      if (replay) {
        await client.query('COMMIT');
        return { advanced: false, replayed: true, responseSnapshot: replay };
      }
      const existing = await client.query(
        'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, candidate.sessionId],
      );
      if (!existing.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const row = existing.rows[0];
      if (Number(row.execution_revision) !== Number(candidate.expectedRevision)) {
        throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
      }
      if (row.current_block_id !== candidate.blockId) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
      const block = row.blocks.find((item) => item.id === candidate.blockId);
      if (!block) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
      const source = await adaptiveAdvanceSource(client, username, row, block, candidate.attempt);
      const nextBlock = row.blocks.find((item) => item.position === block.position + 1) || null;
      const events = await adaptiveSessionEvents(client, username, row.id);
      if (events.some((event) => event.block_id === block.id)) throw new Error('ADAPTIVE_SESSION_BLOCK_ALREADY_COMPLETED');
      const nextRevision = Number(row.execution_revision) + 1;
      if (candidate.responseSnapshot?.execution?.revision !== nextRevision
        || candidate.responseSnapshot?.completedBlock?.blockId !== block.id
        || candidate.responseSnapshot?.session?.currentBlockId !== (nextBlock?.id || null)) {
        throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
      }
      const inserted = await client.query(
        `INSERT INTO adaptive_learning_session_events
         (id, username, session_id, sequence, event_type, block_id, block_kind, module,
          skill_id, activity_id, source_type, source_ref, evidence_quality, planned_minutes,
          actual_minutes, created_at)
         VALUES ($1, $2, $3, $4, 'block_completed', $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15) RETURNING *`,
        [candidate.eventId, username, row.id, events.length + 1, block.id, block.kind,
          block.module, block.skillId, block.activityId, source.source_type, source.source_ref,
          source.evidence_quality, block.plannedMinutes, source.actual_minutes, candidate.now],
      );
      await client.query(
        `UPDATE adaptive_learning_sessions
         SET execution_revision = $3, current_block_id = $4,
             completed_learning_minutes = completed_learning_minutes + $5, updated_at = $6
         WHERE username = $1 AND id = $2`,
        [username, row.id, nextRevision, nextBlock?.id || null,
          block.kind === 'learning' ? block.plannedMinutes : 0, candidate.now],
      );
      await client.query(
        `INSERT INTO adaptive_learning_session_mutations
         (username, idempotency_key, operation, session_id, request_hash, response_snapshot, created_at)
         VALUES ($1, $2, 'advance', $3, $4, $5::jsonb, $6)`,
        [username, candidate.idempotencyKey, row.id, candidate.requestHash,
          JSON.stringify(candidate.responseSnapshot), candidate.now],
      );
      await client.query('COMMIT');
      return {
        advanced: true, replayed: false,
        event: adaptiveExecutionEventExportDto(inserted.rows[0]),
        responseSnapshot: structuredClone(candidate.responseSnapshot),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getAdaptiveLearningSessionFinishContext(username, candidate) {
    const result = await pool.query(
      'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2',
      [username, candidate.sessionId],
    );
    if (!result.rowCount) return null;
    const events = await adaptiveSessionEvents(pool, username, candidate.sessionId);
    return {
      session: adaptiveLearningSessionPublicDto(result.rows[0]),
      execution: adaptiveExecutionView(result.rows[0], events),
      events: events.map(adaptiveExecutionEventExportDto),
    };
  }

  async function finishAdaptiveLearningSession(username, candidate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      const replay = await adaptiveMutationReplay(client, username, { ...candidate, operation: 'finish' }, true);
      if (replay) {
        await client.query('COMMIT');
        return { finished: false, replayed: true, responseSnapshot: replay };
      }
      const existing = await client.query(
        'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, candidate.sessionId],
      );
      if (!existing.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const row = existing.rows[0];
      if (Number(row.execution_revision) !== Number(candidate.expectedRevision)) {
        throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
      }
      const events = await adaptiveSessionEvents(client, username, row.id);
      if (row.status !== 'in_progress' || row.current_block_id !== null
        || events.filter((event) => event.event_type === 'block_completed').length !== row.blocks.length) {
        throw new Error('ADAPTIVE_SESSION_NOT_READY_TO_FINISH');
      }
      const nextRevision = Number(row.execution_revision) + 1;
      const summary = adaptiveExecutionSummary(row, events, candidate.nextRecommendedAction);
      if (candidate.responseSnapshot?.execution?.revision !== nextRevision
        || candidate.responseSnapshot?.session?.status !== 'completed'
        || JSON.stringify(candidate.responseSnapshot?.summary) !== JSON.stringify(summary)) {
        throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
      }
      await client.query(
        `INSERT INTO adaptive_learning_session_events
         (id, username, session_id, sequence, event_type, planned_minutes, created_at)
         VALUES ($1, $2, $3, $4, 'session_finished', 0, $5)`,
        [candidate.eventId, username, row.id, events.length + 1, candidate.now],
      );
      await client.query(
        `UPDATE adaptive_learning_sessions SET execution_revision = $3, status = 'completed',
         completed_at = $4, completion_summary = $5::jsonb, updated_at = $4
         WHERE username = $1 AND id = $2`,
        [username, row.id, nextRevision, candidate.now, JSON.stringify(summary)],
      );
      await client.query(
        `INSERT INTO adaptive_learning_session_mutations
         (username, idempotency_key, operation, session_id, request_hash, response_snapshot, created_at)
         VALUES ($1, $2, 'finish', $3, $4, $5::jsonb, $6)`,
        [username, candidate.idempotencyKey, row.id, candidate.requestHash,
          JSON.stringify(candidate.responseSnapshot), candidate.now],
      );
      await client.query('COMMIT');
      return { finished: true, replayed: false, responseSnapshot: structuredClone(candidate.responseSnapshot) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getAdaptiveLearningWeekUsage(username, weekStart) {
    const result = await pool.query(
      `SELECT blocks FROM adaptive_learning_sessions
       WHERE username = $1 AND week_start = $2 AND status <> 'abandoned'`,
      [username, weekStart],
    );
    const totals = new Map();
    for (const row of result.rows) {
      for (const block of row.blocks.filter((item) => item.kind === 'learning')) {
        const current = totals.get(block.skillId) || { skillId: block.skillId, plannedMinutes: 0, completedMinutes: 0 };
        current.plannedMinutes += block.plannedMinutes;
        totals.set(block.skillId, current);
      }
    }
    return [...totals.values()].sort((left, right) => left.skillId.localeCompare(right.skillId));
  }

  async function readAdaptiveDiagnostic(queryable, username, diagnosticId = null) {
    const result = await queryable.query(
      `SELECT diagnostic.*,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(response) - 'diagnostic_id' - 'idempotency_key' - 'request_hash'
                                 ORDER BY response.answered_at, response.id)
                FROM adaptive_diagnostic_responses response
                WHERE response.diagnostic_id = diagnostic.id
              ), '[]'::jsonb) AS responses
       FROM adaptive_diagnostic_sessions diagnostic
       WHERE diagnostic.username = $1 AND ($2::uuid IS NULL OR diagnostic.id = $2::uuid)
       ORDER BY diagnostic.started_at DESC LIMIT 1`,
      [username, diagnosticId],
    );
    return result.rowCount
      ? adaptiveDiagnosticRepositoryDto(result.rows[0], result.rows[0].responses)
      : null;
  }

  async function startAdaptiveDiagnostic(username, diagnostic) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      await client.query(
        'DELETE FROM adaptive_diagnostic_start_claims WHERE claim_expires_at <= $1',
        [diagnostic.now],
      );
      const duplicate = await client.query(
        'SELECT * FROM adaptive_diagnostic_start_claims WHERE username = $1 AND idempotency_key = $2',
        [username, diagnostic.idempotencyKey],
      );
      if (duplicate.rowCount) {
        if (duplicate.rows[0].request_hash !== diagnostic.requestHash) {
          throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
        }
        await client.query('COMMIT');
        return {
          created: false,
          diagnostic: adaptiveDiagnosticStartClaimRepositoryDto(duplicate.rows[0]),
        };
      }
      const ownerClaimCount = await client.query(
        'SELECT COUNT(*)::integer AS count FROM adaptive_diagnostic_start_claims WHERE username = $1',
        [username],
      );
      if (ownerClaimCount.rows[0].count >= ADAPTIVE_DIAGNOSTIC_START_CLAIM_LIMIT) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_START_LIMIT');
      }
      await client.query(
        `UPDATE adaptive_diagnostic_sessions
         SET status = 'expired', current_item_id = NULL, stop_reason = 'maximum_time', updated_at = $2
         WHERE username = $1 AND status IN ('in_progress', 'ready') AND expires_at <= $2`,
        [username, diagnostic.now],
      );
      const active = await client.query(
        `SELECT id FROM adaptive_diagnostic_sessions
         WHERE username = $1 AND status IN ('in_progress', 'ready') ORDER BY started_at DESC LIMIT 1`,
        [username],
      );
      const created = !active.rowCount;
      let snapshot;
      if (active.rowCount) {
        snapshot = await readAdaptiveDiagnostic(client, username, active.rows[0].id);
      } else {
        await client.query(
          `INSERT INTO adaptive_diagnostic_sessions
           (id, username, catalog_version, status, current_item_id, idempotency_key, request_hash,
            started_at, expires_at, updated_at)
           VALUES ($1, $2, $3, 'in_progress', $4, $5, $6, $7, $8, $7)`,
          [diagnostic.id, username, diagnostic.catalogVersion, diagnostic.currentItemId,
            diagnostic.idempotencyKey, diagnostic.requestHash, diagnostic.now, diagnostic.expiresAt],
        );
        snapshot = await readAdaptiveDiagnostic(client, username, diagnostic.id);
      }
      await client.query(
        `INSERT INTO adaptive_diagnostic_start_claims
         (username, idempotency_key, request_hash, diagnostic_id, catalog_version, status,
          current_item_id, answered_items, correct_items, stop_reason, started_at, expires_at,
          completed_at, updated_at, claimed_at, claim_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [username, diagnostic.idempotencyKey, diagnostic.requestHash, snapshot.id,
          snapshot.catalog_version, snapshot.status, snapshot.current_item_id,
          snapshot.answered_items, snapshot.correct_items, snapshot.stop_reason,
          snapshot.started_at, snapshot.expires_at, snapshot.completed_at, snapshot.updated_at,
          diagnostic.now, adaptiveDiagnosticClaimExpiresAt(diagnostic.now)],
      );
      await client.query('COMMIT');
      return { created, diagnostic: snapshot };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getAdaptiveDiagnosticStartClaim(username, claim) {
    const result = await pool.query(
      `SELECT * FROM adaptive_diagnostic_start_claims
       WHERE username = $1 AND idempotency_key = $2 AND claim_expires_at > $3`,
      [username, claim.idempotencyKey, claim.now ?? new Date()],
    );
    if (!result.rowCount) return null;
    if (result.rows[0].request_hash !== claim.requestHash) {
      throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
    }
    return adaptiveDiagnosticStartClaimRepositoryDto(result.rows[0]);
  }

  async function getCurrentAdaptiveDiagnostic(username) {
    const diagnostic = await readAdaptiveDiagnostic(pool, username);
    return diagnostic?.status === 'completed' ? null : diagnostic;
  }

  async function getAdaptiveDiagnostic(username, diagnosticId) {
    return readAdaptiveDiagnostic(pool, username, diagnosticId);
  }

  async function getAdaptiveDiagnosticCompletionReplay(username, completion) {
    const result = await pool.query(
      `SELECT status, completion_idempotency_key, completion_request_hash,
              completion_response_snapshot
       FROM adaptive_diagnostic_sessions WHERE id = $1 AND username = $2`,
      [completion.diagnosticId, username],
    );
    if (!result.rowCount || result.rows[0].status !== 'completed') return null;
    const session = result.rows[0];
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
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      const selected = await client.query(
        'SELECT * FROM adaptive_diagnostic_sessions WHERE id = $1 AND username = $2 FOR UPDATE',
        [answer.diagnosticId, username],
      );
      if (!selected.rowCount) throw new Error('ADAPTIVE_DIAGNOSTIC_NOT_FOUND');
      const session = selected.rows[0];
      const duplicate = await client.query(
        'SELECT * FROM adaptive_diagnostic_responses WHERE diagnostic_id = $1 AND idempotency_key = $2',
        [session.id, answer.idempotencyKey],
      );
      if (duplicate.rowCount) {
        if (duplicate.rows[0].request_hash !== answer.requestHash) {
          throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
        }
        await client.query('COMMIT');
        inTransaction = false;
        return {
          created: false,
          diagnostic: adaptiveDiagnosticAnswerClaimRepositoryDto(duplicate.rows[0]),
        };
      }
      if (session.status === 'expired' && session.stop_reason === 'maximum_time') {
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      if (['in_progress', 'ready'].includes(session.status)
        && new Date(session.expires_at).getTime() <= new Date(answer.now).getTime()) {
        await client.query(
          `UPDATE adaptive_diagnostic_sessions SET status = 'expired', current_item_id = NULL,
           stop_reason = 'maximum_time', updated_at = $2 WHERE id = $1`,
          [session.id, answer.now],
        );
        await client.query('COMMIT');
        inTransaction = false;
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      const answered = await client.query(
        'SELECT 1 FROM adaptive_diagnostic_responses WHERE diagnostic_id = $1 AND item_id = $2',
        [session.id, answer.itemId],
      );
      if (answered.rowCount) throw new Error('ADAPTIVE_DIAGNOSTIC_ITEM_ALREADY_ANSWERED');
      if (session.status !== 'in_progress' || session.current_item_id !== answer.itemId) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_ITEM_NOT_CURRENT');
      }
      await client.query(
        `INSERT INTO adaptive_diagnostic_responses
         (id, diagnostic_id, item_id, skill_id, module, evidence_quality, choice_id, correct, response_ms,
          idempotency_key, request_hash, replay_catalog_version, replay_status, replay_current_item_id,
          replay_answered_items, replay_correct_items, replay_stop_reason, replay_started_at,
          replay_expires_at, replay_completed_at, replay_updated_at, answered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21, $22)`,
        [answer.id, session.id, answer.itemId, answer.skillId, answer.module, answer.evidenceQuality,
          answer.choiceId, answer.correct, answer.responseMs, answer.idempotencyKey,
          answer.requestHash, session.catalog_version, answer.status, answer.nextItemId,
          Number(session.answered_items) + 1,
          Number(session.correct_items) + (answer.correct ? 1 : 0), answer.stopReason,
          session.started_at, session.expires_at, session.completed_at, answer.now, answer.now],
      );
      await client.query(
        `UPDATE adaptive_diagnostic_sessions SET current_item_id = $2, status = $3,
         stop_reason = $4, answered_items = answered_items + 1,
         correct_items = correct_items + CASE WHEN $5::boolean THEN 1 ELSE 0 END, updated_at = $6
         WHERE id = $1`,
        [session.id, answer.nextItemId, answer.status, answer.stopReason, answer.correct, answer.now],
      );
      const snapshot = await readAdaptiveDiagnostic(client, username, session.id);
      await client.query('COMMIT');
      inTransaction = false;
      return { created: true, diagnostic: snapshot };
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function completeAdaptiveDiagnostic(username, completion) {
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      const selected = await client.query(
        'SELECT * FROM adaptive_diagnostic_sessions WHERE id = $1 AND username = $2 FOR UPDATE',
        [completion.diagnosticId, username],
      );
      if (!selected.rowCount) throw new Error('ADAPTIVE_DIAGNOSTIC_NOT_FOUND');
      const session = selected.rows[0];
      if (session.status === 'completed') {
        if (session.completion_idempotency_key === completion.idempotencyKey
          && session.completion_request_hash !== completion.requestHash) {
          throw new Error('ADAPTIVE_DIAGNOSTIC_IDEMPOTENCY_CONFLICT');
        }
        const snapshot = await readAdaptiveDiagnostic(client, username, session.id);
        const responseSnapshot = adaptiveDiagnosticCompletionSnapshotDto(
          session.completion_response_snapshot,
        );
        if (!responseSnapshot) throw new Error('ADAPTIVE_DIAGNOSTIC_COMPLETION_SNAPSHOT_MISSING');
        await client.query('COMMIT');
        inTransaction = false;
        return { created: false, diagnostic: snapshot, responseSnapshot };
      }
      if (session.status === 'expired' && session.stop_reason === 'maximum_time') {
        throw new Error('ADAPTIVE_DIAGNOSTIC_TIME_EXPIRED');
      }
      if (session.status === 'ready'
        && new Date(session.expires_at).getTime() <= new Date(completion.now).getTime()) {
        await client.query(
          `UPDATE adaptive_diagnostic_sessions SET status = 'expired', current_item_id = NULL,
           stop_reason = 'maximum_time', updated_at = $2 WHERE id = $1`,
          [session.id, completion.now],
        );
        await client.query('COMMIT');
        inTransaction = false;
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
      await client.query(
        `UPDATE adaptive_diagnostic_sessions SET status = 'completed', current_item_id = NULL,
         completion_idempotency_key = $2, completion_request_hash = $3,
         completion_response_snapshot = $5::jsonb,
         completed_at = $4, updated_at = $4 WHERE id = $1`,
        [session.id, completion.idempotencyKey, completion.requestHash, completion.now,
          JSON.stringify(responseSnapshot)],
      );
      const snapshot = await readAdaptiveDiagnostic(client, username, session.id);
      await client.query('COMMIT');
      inTransaction = false;
      return { created: true, diagnostic: snapshot, responseSnapshot };
    } catch (error) {
      if (inTransaction) await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function recordModuleAttempt(username, attempt, { evidenceQuality = 'client_reported' } = {}) {
    const trustedEvidenceQuality = requireModuleAttemptEvidenceQuality(evidenceQuality);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO module_attempts (id, username, module, activity, score, max_score, duration_ms, metadata, evidence_quality)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (id) DO NOTHING RETURNING id, created_at`,
        [attempt.id, username, attempt.module, attempt.activity, attempt.score, attempt.maxScore,
          attempt.durationMs ?? null, JSON.stringify(attempt.metadata || {}), trustedEvidenceQuality],
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

  async function recordModuleAttemptWithAdaptiveClaim(username, attempt, {
    executionClaim, now = new Date(),
  }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tokenHash = adaptiveExecutionTokenHash(executionClaim);
      const claimed = await client.query(
        `SELECT claim.*, session.status AS session_status,
                session.current_block_id, session.execution_revision, session.blocks
         FROM adaptive_learning_execution_claims claim
         JOIN adaptive_learning_sessions session ON session.id = claim.session_id
         WHERE claim.token_hash = $1 FOR UPDATE OF claim, session`,
        [tokenHash],
      );
      if (!claimed.rowCount || claimed.rows[0].username !== username) {
        throw new Error('ADAPTIVE_EXECUTION_CLAIM_INVALID');
      }
      const claim = claimed.rows[0];
      const block = claim.blocks.find((item) => item.id === claim.block_id);
      if (!block || claim.current_block_id !== block.id || claim.session_status !== 'in_progress'
        || Number(claim.execution_revision) !== Number(claim.session_execution_revision)
        || claim.revoked_at || new Date(claim.expires_at) <= new Date(now)
        || claim.launch_fingerprint !== adaptiveLaunchFingerprint(block)) {
        throw new Error(new Date(claim.expires_at) <= new Date(now)
          ? 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED' : 'ADAPTIVE_EXECUTION_CLAIM_INVALID');
      }
      const existing = await client.query('SELECT * FROM module_attempts WHERE id = $1', [attempt.id]);
      if (claim.consumed_at) {
        const row = existing.rows[0];
        if (claim.attempt_type !== 'module' || claim.attempt_ref !== attempt.id || !row
          || row.username !== username || row.module !== attempt.module || row.activity !== attempt.activity
          || Number(row.score) !== Number(attempt.score) || Number(row.max_score) !== Number(attempt.maxScore)
          || (row.duration_ms == null ? null : Number(row.duration_ms)) !== (attempt.durationMs ?? null)) {
          throw new Error('ADAPTIVE_EXECUTION_CLAIM_CONSUMED');
        }
        await client.query('COMMIT');
        return {
          id: attempt.id, created: false, evidenceQuality: row.evidence_quality,
          adaptiveExecution: {
            sessionId: claim.session_id, blockId: block.id,
            attemptType: 'module', attemptId: attempt.id,
          },
        };
      }
      if (existing.rowCount || attempt.module !== block.module || attempt.activity !== block.activityId) {
        throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
      }
      const metadata = {
        adaptive_session_id: claim.session_id,
        adaptive_block_id: block.id,
        adaptive_content_ref: block.contentRef,
      };
      const inserted = await client.query(
        `INSERT INTO module_attempts
         (id, username, module, activity, score, max_score, duration_ms, metadata, evidence_quality, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'client_reported', $9)
         RETURNING created_at`,
        [attempt.id, username, attempt.module, attempt.activity, attempt.score, attempt.maxScore,
          attempt.durationMs ?? null, JSON.stringify(metadata), now],
      );
      await client.query(
        `INSERT INTO progress_summary
         (username, module, attempt_count, best_score, best_max_score, total_duration_ms, last_attempt_at)
         VALUES ($1, $2, 1, $3, $4, $5, $6)
         ON CONFLICT (username, module) DO UPDATE SET
           attempt_count = progress_summary.attempt_count + 1,
           best_score = CASE WHEN EXCLUDED.best_score::numeric / EXCLUDED.best_max_score >
             progress_summary.best_score::numeric / progress_summary.best_max_score
             THEN EXCLUDED.best_score ELSE progress_summary.best_score END,
           best_max_score = CASE WHEN EXCLUDED.best_score::numeric / EXCLUDED.best_max_score >
             progress_summary.best_score::numeric / progress_summary.best_max_score
             THEN EXCLUDED.best_max_score ELSE progress_summary.best_max_score END,
           total_duration_ms = progress_summary.total_duration_ms + EXCLUDED.total_duration_ms,
           last_attempt_at = EXCLUDED.last_attempt_at, updated_at = $6`,
        [username, attempt.module, attempt.score, attempt.maxScore, attempt.durationMs ?? 0,
          inserted.rows[0].created_at],
      );
      await client.query(
        `UPDATE adaptive_learning_execution_claims
         SET consumed_at = $2, attempt_type = 'module', attempt_ref = $3 WHERE id = $1`,
        [claim.id, now, attempt.id],
      );
      await client.query('COMMIT');
      return {
        id: attempt.id, created: true, evidenceQuality: 'client_reported',
        adaptiveExecution: {
          sessionId: claim.session_id, blockId: block.id,
          attemptType: 'module', attemptId: attempt.id,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function bindAdaptiveLearningServerAttempt(username, {
    sessionId, executionClaim, attempt, now = new Date(),
  }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `SELECT claim.*, session.status AS session_status, session.current_block_id,
                session.execution_revision, session.blocks
         FROM adaptive_learning_execution_claims claim
         JOIN adaptive_learning_sessions session ON session.id = claim.session_id
         WHERE claim.token_hash = $1 FOR UPDATE OF claim, session`,
        [adaptiveExecutionTokenHash(executionClaim)],
      );
      if (!claimed.rowCount || claimed.rows[0].username !== username
        || claimed.rows[0].session_id !== sessionId) {
        throw new Error('ADAPTIVE_EXECUTION_CLAIM_INVALID');
      }
      const claim = claimed.rows[0];
      const block = claim.blocks.find((item) => item.id === claim.block_id);
      if (!block || claim.session_status !== 'in_progress' || claim.current_block_id !== block.id
        || Number(claim.execution_revision) !== Number(claim.session_execution_revision)
        || claim.revoked_at || new Date(claim.expires_at) <= new Date(now)
        || claim.launch_fingerprint !== adaptiveLaunchFingerprint(block)) {
        throw new Error(new Date(claim.expires_at) <= new Date(now)
          ? 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED' : 'ADAPTIVE_EXECUTION_CLAIM_INVALID');
      }
      if (claim.consumed_at) {
        if (claim.attempt_type !== attempt.type || String(claim.attempt_ref) !== String(attempt.id)) {
          throw new Error('ADAPTIVE_EXECUTION_CLAIM_CONSUMED');
        }
        await client.query('COMMIT');
        return {
          created: false, evidenceQuality: 'server_verified_assisted',
          adaptiveExecution: {
            sessionId, blockId: block.id, attemptType: attempt.type, attemptId: Number(attempt.id),
          },
        };
      }
      const table = attempt.type === 'writing' ? 'writing_attempts' : 'speaking_attempts';
      const source = await client.query(
        `SELECT id, username, task_type, status, created_at FROM ${table}
         WHERE username = $1 AND id = $2`,
        [username, attempt.id],
      );
      const sourceRow = source.rows[0];
      const expectedActivity = attempt.type === 'writing'
        ? String(sourceRow?.task_type || '') : `speaking_${sourceRow?.task_type}`;
      if (!sourceRow || sourceRow.status !== 'completed'
        || new Date(sourceRow.created_at) < new Date(claim.issued_at)
        || block.module !== attempt.type || block.activityId !== expectedActivity) {
        throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
      }
      await client.query(
        `UPDATE adaptive_learning_execution_claims
         SET consumed_at = $2, attempt_type = $3, attempt_ref = $4 WHERE id = $1`,
        [claim.id, now, attempt.type, String(attempt.id)],
      );
      await client.query('COMMIT');
      return {
        created: true, evidenceQuality: 'server_verified_assisted',
        adaptiveExecution: {
          sessionId, blockId: block.id, attemptType: attempt.type, attemptId: Number(attempt.id),
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getModuleAttempt(username, attemptId) {
    const result = await pool.query(
      `SELECT id, username, module, activity, score, max_score, duration_ms, metadata, evidence_quality, created_at
       FROM module_attempts WHERE username = $1 AND id = $2`,
      [username, attemptId],
    );
    return result.rows[0] || null;
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

  async function claimAiOperationSlot(username, {
    claimId, operation, promptVersion, requestsPerHour, dailyLimit, now = new Date(),
  }) {
    const client = await pool.connect();
    const instant = new Date(now);
    const startOfDay = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
    const startOfHour = new Date(instant.getTime() - 3_600_000);
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const existing = await client.query(
        'SELECT id, username, operation, status FROM ai_requests WHERE claim_key = $1',
        [claimId],
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.username !== username || row.operation !== operation) throw new VoiceTutorError('AI_OPERATION_CLAIM_CONFLICT');
        await client.query('COMMIT');
        return { claim_id: claimId, id: Number(row.id), status: row.status };
      }
      if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || !Number.isInteger(requestsPerHour) || requestsPerHour < 1) {
        throw new VoiceTutorError('AI_OPERATION_CLAIM_INVALID');
      }
      await client.query('SELECT pg_advisory_xact_lock($1)', [824_209_028]);
      const daily = await client.query('SELECT COUNT(*)::int AS count FROM ai_requests WHERE created_at >= $1', [startOfDay]);
      if (Number(daily.rows[0].count) >= dailyLimit) throw new VoiceTutorError('AI_BUDGET_EXHAUSTED');
      const hourly = await client.query(
        'SELECT COUNT(*)::int AS count FROM ai_requests WHERE username = $1 AND operation = $2 AND created_at >= $3',
        [username, operation, startOfHour],
      );
      if (Number(hourly.rows[0].count) >= requestsPerHour) throw new VoiceTutorError('RATE_LIMITED');
      const inserted = await client.query(
        `INSERT INTO ai_requests
         (username, operation, prompt_version, status, claim_key, created_at)
         VALUES ($1, $2, $3, 'in_progress', $4, $5)
         RETURNING id, status`,
        [username, operation, promptVersion || null, claimId, instant],
      );
      await client.query('COMMIT');
      return { claim_id: claimId, id: Number(inserted.rows[0].id), status: inserted.rows[0].status };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function settleAiOperationSlot(username, claimId, {
    status, provider = null, model = null, durationMs = null, errorCode = null,
    promptTokens = null, completionTokens = null, now = new Date(),
  }) {
    if (!['completed', 'failed'].includes(status)) throw new VoiceTutorError('AI_OPERATION_SETTLEMENT_INVALID');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const selected = await client.query(
        'SELECT id, status FROM ai_requests WHERE username = $1 AND claim_key = $2 FOR UPDATE',
        [username, claimId],
      );
      if (!selected.rowCount) throw new VoiceTutorError('AI_OPERATION_CLAIM_NOT_FOUND');
      if (selected.rows[0].status !== 'in_progress') {
        await client.query('COMMIT');
        return { applied: false, status: selected.rows[0].status };
      }
      const updated = await client.query(
        `UPDATE ai_requests
         SET status = $3, provider = $4, model = $5, duration_ms = $6,
             error_code = $7, prompt_tokens = $8, completion_tokens = $9, settled_at = $10
         WHERE username = $1 AND claim_key = $2
         RETURNING status`,
        [username, claimId, status, provider, model,
          Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
          errorCode, Number.isFinite(promptTokens) ? Math.max(0, Math.round(promptTokens)) : null,
          Number.isFinite(completionTokens) ? Math.max(0, Math.round(completionTokens)) : null, new Date(now)],
      );
      await client.query('COMMIT');
      return { applied: true, status: updated.rows[0].status };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function countAiRequestsSince(since) {
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM ai_requests WHERE created_at >= $1', [since]);
    return Number(result.rows[0].count);
  }

  async function countAiOperationRequestsSince(username, operation, since) {
    const result = await pool.query(
      'SELECT COUNT(*)::int AS count FROM ai_requests WHERE username = $1 AND operation = $2 AND created_at >= $3',
      [username, operation, since],
    );
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
    const [account, progress, privacyConsent, subscriptionEvents, subscriptionEntitlements, voiceTutorSessions, voiceTutorRecoveries, voiceTutorRepeats, voiceTutorRepeatAttempts, voiceTutorReports, ruleCards, paymentRequests, writingAttempts, speakingAttempts, generatedTasks, moduleAttempts, progressSummary, wordProgress, errorBank, adaptiveGoals, adaptiveSnapshot, adaptivePlanRevisions, adaptiveSessions, adaptiveSessionExecutionEvents, adaptiveDiagnosticSessions, adaptiveDiagnosticResponses, aiRequests, auditLog] = await Promise.all([
      pool.query('SELECT username, telegram_id, role, trial_used, subscription_until, created_at, updated_at FROM users WHERE username = $1', [username]),
      pool.query('SELECT data, updated_at FROM user_progress WHERE username = $1', [username]),
      pool.query('SELECT text_processing, voice_processing, policy_version, text_consented_at, voice_consented_at, updated_at FROM privacy_consents WHERE username = $1', [username]),
      pool.query('SELECT id, event_type, days, metadata, created_at FROM subscription_events WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT entitlement, starts_at, ends_at, created_at, updated_at FROM subscription_entitlements WHERE username = $1 ORDER BY entitlement', [username]),
      pool.query(`SELECT id, status, reserved_seconds, billable_seconds, capsule_id, capsule, delivery_mode,
                         pedagogical_state, micro_check_passed, micro_check_attempts, micro_check_passes,
                         transfer_passed, outcome, clarification_turns, error_code, provider, model, prompt_version,
                         proxy_input_audio_bytes, proxy_output_audio_bytes, proxy_usage_confirmed,
                         proxy_finalization_reason, proxy_finalized_at,
                         started_at, voice_activated_at, expires_at, ended_at, updated_at
                  FROM voice_tutor_sessions WHERE username = $1 ORDER BY started_at`, [username]),
      pool.query(`SELECT id, session_id, skill_id, skill_label, module, rule_id, origin_item_id,
                         origin_transfer_task_id, initial_micro_check_passed, initial_transfer_passed,
                         terminal_outcome, potential_ege_points, observed_at
                  FROM voice_tutor_recoveries WHERE username = $1 ORDER BY observed_at`, [username]),
      pool.query(`SELECT repeat.id, repeat.recovery_id, repeat.stage, repeat.task_id, repeat.due_at,
                         repeat.window_ends_at, repeat.superseded_at
                  FROM voice_tutor_repeats repeat
                  JOIN voice_tutor_recoveries recovery ON recovery.id = repeat.recovery_id
                  WHERE recovery.username = $1 ORDER BY repeat.due_at`, [username]),
      pool.query(`SELECT attempt.id, attempt.repeat_id, attempt.task_id, attempt.passed, attempt.observed_at
                  FROM voice_tutor_repeat_attempts attempt
                  JOIN voice_tutor_repeats repeat ON repeat.id = attempt.repeat_id
                  JOIN voice_tutor_recoveries recovery ON recovery.id = repeat.recovery_id
                  WHERE recovery.username = $1 ORDER BY attempt.observed_at`, [username]),
      pool.query(`SELECT id, session_id, rule_card_id, reason, status, review_audit, created_at, reviewed_at
                  FROM voice_tutor_reports WHERE username = $1 ORDER BY created_at`, [username]),
      pool.query('SELECT * FROM trusted_rule_cards WHERE created_for_username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, product, status, actor_telegram_id, result, created_at, resolved_at FROM payment_requests WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, task_type, assignment, answer, evaluated_answer, review, provider, model, prompt_version, status, error_code, created_at, evaluated_at FROM writing_attempts WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, task_type, assignment, transcript, review, provider, model, prompt_version, status, error_code, created_at, evaluated_at FROM speaking_attempts WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, operation, request, result, provider, prompt_version, created_at FROM generated_tasks WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, module, activity, score, max_score, duration_ms, metadata, evidence_quality, created_at FROM module_attempts WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT module, attempt_count, best_score, best_max_score, total_duration_ms, last_attempt_at, updated_at FROM progress_summary WHERE username = $1 ORDER BY module', [username]),
      pool.query('SELECT word, stage, error_count, review_count, due_at, updated_at FROM word_progress WHERE username = $1 ORDER BY word', [username]),
      pool.query('SELECT id, module, item_key, error_type, details, occurrence_count, first_seen_at, last_seen_at, resolved_at FROM error_bank WHERE username = $1 ORDER BY last_seen_at DESC', [username]),
      pool.query(`SELECT id, target_exam, target_score, exam_date, weekly_minutes, revision, created_at, updated_at
                  FROM adaptive_learning_goals WHERE username = $1 ORDER BY revision`, [username]),
      readAdaptiveLearningProfile(pool, username, { onAdaptiveProfileSnapshot }),
      pool.query(`SELECT * FROM adaptive_learning_plan_revisions
                  WHERE username = $1 ORDER BY revision`, [username]),
      pool.query(`SELECT * FROM adaptive_learning_sessions
                  WHERE username = $1 ORDER BY created_at`, [username]),
      pool.query(`SELECT * FROM adaptive_learning_session_events
                  WHERE username = $1 ORDER BY created_at, sequence`, [username]),
      pool.query(`SELECT id, catalog_version, status, current_item_id, answered_items, correct_items,
                         stop_reason, started_at, expires_at, completed_at, updated_at
                  FROM adaptive_diagnostic_sessions WHERE username = $1 ORDER BY started_at`, [username]),
      pool.query(`SELECT response.id, response.diagnostic_id, response.item_id, response.skill_id,
                         response.module, response.evidence_quality, response.choice_id,
                         response.correct, response.response_ms,
                         response.answered_at
                  FROM adaptive_diagnostic_responses response
                  JOIN adaptive_diagnostic_sessions diagnostic ON diagnostic.id = response.diagnostic_id
                  WHERE diagnostic.username = $1 ORDER BY response.answered_at`, [username]),
      pool.query('SELECT id, operation, provider, model, prompt_version, status, duration_ms, error_code, prompt_tokens, completion_tokens, estimated_cost_microusd, created_at FROM ai_requests WHERE username = $1 ORDER BY created_at', [username]),
      pool.query("SELECT id, actor_telegram_id, action, target_type, target_id, result, metadata, created_at FROM audit_log WHERE metadata->>'username' = $1 ORDER BY created_at", [username]),
    ]);
    if (!account.rowCount) return null;
    const adaptiveExport = adaptiveLearningProfileExportDto(
      adaptiveSnapshot,
      adaptiveSnapshot?.estimates || [],
    );
    return {
      exported_at: new Date().toISOString(),
      account: account.rows[0],
      progress: progress.rows[0]?.data || {},
      privacy_consent: privacyConsent.rows[0] || null,
      subscription_events: subscriptionEvents.rows,
      subscription_entitlements: subscriptionEntitlements.rows,
      voice_tutor_sessions: voiceTutorSessions.rows,
      voice_tutor_recoveries: voiceTutorRecoveries.rows,
      voice_tutor_repeats: voiceTutorRepeats.rows,
      voice_tutor_repeat_attempts: voiceTutorRepeatAttempts.rows,
      voice_tutor_reports: voiceTutorReports.rows,
      rule_cards: ruleCards.rows.map(mapRuleCard),
      payment_requests: paymentRequests.rows,
      writing_attempts: writingAttempts.rows,
      speaking_attempts: speakingAttempts.rows,
      generated_tasks: generatedTasks.rows,
      module_attempts: moduleAttempts.rows,
      progress_summary: progressSummary.rows,
      word_progress: wordProgress.rows,
      error_bank: errorBank.rows,
      adaptive_learning_goals: adaptiveGoals.rows.map(adaptiveLearningGoalRepositoryDto),
      adaptive_learning_profile: adaptiveExport.profile,
      adaptive_learning_skill_estimates: adaptiveExport.estimates,
      adaptive_learning_plan_revisions: adaptivePlanRevisions.rows.map(adaptiveLearningPlanRepositoryDto),
      adaptive_learning_sessions: adaptiveSessions.rows.map(adaptiveLearningSessionRepositoryDto),
      adaptive_learning_session_events: adaptiveSessionExecutionEvents.rows
        .map(adaptiveExecutionEventExportDto),
      adaptive_diagnostic_sessions: adaptiveDiagnosticSessions.rows.map(adaptiveDiagnosticExportDto),
      adaptive_diagnostic_responses: adaptiveDiagnosticResponses.rows.map(adaptiveDiagnosticResponseExportDto),
      ai_requests: aiRequests.rows,
      audit_log: auditLog.rows,
    };
  }

  async function deleteUserData(username) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT telegram_id FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) {
        await client.query('COMMIT');
        return false;
      }
      if (owner.rows[0].telegram_id != null) {
        await client.query('DELETE FROM telegram_auth_codes WHERE telegram_id = $1', [owner.rows[0].telegram_id]);
      }
      await client.query('DELETE FROM ai_requests WHERE username = $1', [username]);
      await client.query("DELETE FROM trusted_rule_cards WHERE created_for_username = $1 AND status <> 'approved'", [username]);
      await client.query("UPDATE trusted_rule_cards SET created_for_username = NULL WHERE created_for_username = $1 AND status = 'approved'", [username]);
      const reviewedCards = await client.query("SELECT id, review_audit FROM trusted_rule_cards WHERE review_audit @> $1::jsonb", [JSON.stringify([{ reviewer: username }])]);
      for (const card of reviewedCards.rows) {
        const audit = card.review_audit.map((entry) => entry.reviewer === username
          ? { ...entry, reviewer: null, account_deleted: true }
          : entry);
        await client.query('UPDATE trusted_rule_cards SET review_audit = $2::jsonb WHERE id = $1', [card.id, JSON.stringify(audit)]);
      }
      const reviewedReports = await client.query("SELECT id, review_audit FROM voice_tutor_reports WHERE review_audit @> $1::jsonb", [JSON.stringify([{ reviewer: username }])]);
      for (const report of reviewedReports.rows) {
        const audit = report.review_audit.map((entry) => entry.reviewer === username
          ? { ...entry, reviewer: null, account_deleted: true }
          : entry);
        await client.query('UPDATE voice_tutor_reports SET review_audit = $2::jsonb WHERE id = $1', [report.id, JSON.stringify(audit)]);
      }
      await client.query(
        `UPDATE audit_log
         SET metadata = (metadata - 'username') || '{"account_deleted":true}'::jsonb
         WHERE metadata->>'username' = $1`,
        [username],
      );
      await client.query(
        `UPDATE audit_log
         SET metadata = (metadata - 'reviewer') || '{"reviewer_account_deleted":true}'::jsonb
         WHERE metadata->>'reviewer' = $1`,
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
    getAdaptiveLearningPlanRevision,
    getAdaptiveLearningSessionCreateReplay,
    createAdaptiveLearningSession,
    getCurrentAdaptiveLearningSession,
    getAdaptiveLearningSessionReplacementReplay,
    replaceAdaptiveLearningSessionBlock,
    getAdaptiveLearningSessionMutationReplay,
    startAdaptiveLearningSessionBlock,
    getAdaptiveLearningSessionExecution,
    getAdaptiveLearningSessionAdvanceContext,
    advanceAdaptiveLearningSession,
    getAdaptiveLearningSessionFinishContext,
    finishAdaptiveLearningSession,
    getAdaptiveLearningWeekUsage,
    startAdaptiveDiagnostic,
    getAdaptiveDiagnosticStartClaim,
    getCurrentAdaptiveDiagnostic,
    getAdaptiveDiagnostic,
    getAdaptiveDiagnosticCompletionReplay,
    answerAdaptiveDiagnostic,
    completeAdaptiveDiagnostic,
    recordModuleAttempt,
    recordModuleAttemptWithAdaptiveClaim,
    bindAdaptiveLearningServerAttempt,
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
    close: () => Promise.all([pool.end(), finalizationPool.end()]),
  };
}
