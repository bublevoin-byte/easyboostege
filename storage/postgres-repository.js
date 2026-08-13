import crypto from 'node:crypto';
import pg from 'pg';
import { adaptiveAssistedMetadata, adaptiveReadingMetadata, requireModuleAttemptEvidenceQuality } from '../adaptive-learning/evidence-quality.js';
import {
  adaptiveEvidenceFingerprintConflict,
  compareAdaptiveEvidenceWatermarks,
} from '../adaptive-learning/evidence-watermark.js';
import { adaptiveProfileMatchesCurrentEvidence } from '../adaptive-learning/profile.js';
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
  ADAPTIVE_METRICS_HIGH_IMPACT_SKILLS,
  adaptiveMetricsWindow,
  emptyAdaptiveLearningMetricCounters,
  finalizeAdaptiveLearningMetrics,
} from '../adaptive-learning/metrics.js';
import { adaptiveSpeakingActivityMatchesTask, adaptiveSpeakingTask } from '../public/adaptive-speaking-tasks.js';
import {
  newSpeakingTask1Session,
  speakingTask1CompletionMetadata,
} from '../speaking/task1-session.js';
import { applySpeakingTask2QuestionCompletion, newSpeakingTask2Session } from '../speaking/task2-session.js';
import { applySpeakingTask3AnswerCompletion, newSpeakingTask3Session } from '../speaking/task3-session.js';
import {
  newSpeakingTask4Session,
  speakingTask4CompletionMetadata,
} from '../speaking/task4-session.js';
import { selectSpeakingTrainingAssignment } from '../speaking/training-session.js';
import {
  abandonFullSpeakingSession,
  advanceFullSpeakingStage,
  applyFullSpeakingEvaluation,
  assertFullSpeakingSessionCompatibility,
  claimFullSpeakingResponseAssessment,
  completeFullSpeakingResponse,
  createFullSpeakingSession,
  selectFullSpeakingVariant,
  submitFullSpeakingSession,
} from '../speaking/full-section-session.js';
import {
  SPEAKING_EVALUATION_CLAIM_LEASE_MS,
  SPEAKING_EVALUATION_RETRYABLE_ERRORS,
} from '../speaking/evaluation-claim.js';
import {
  assertSpeakingLearningSource,
  buildSpeakingLearningAttempt,
  canonicalSpeakingLearningSource,
  SPEAKING_ADAPTIVE_EVIDENCE_ATTEMPT_LIMIT,
  speakingTargetedPracticeAssignment,
  speakingAdaptiveEvidenceAttempts,
  speakingAdaptiveEvidenceMatchesTarget,
} from '../speaking/learning-loop.js';
import { isMonotonicAdaptiveRetentionRefresh } from '../adaptive-learning/retention.js';
import { adaptiveRepeatExecutionMatches } from '../adaptive-learning/repeat-execution.js';
import {
  adaptiveLearningSessionPublicDto,
  adaptiveLearningSessionRepositoryDto,
} from '../adaptive-learning/session-dto.js';
import {
  adaptiveActivityRequiresPremiumDepth,
  assertAdaptiveSessionCreateCandidate,
  assertAdaptiveSessionReplacementTransition,
} from '../adaptive-learning/session.js';
import {
  ADAPTIVE_EXECUTION_CLAIM_TTL_MS,
  adaptiveConsumedClaimAttempt,
  adaptiveExecutionEventExportDto,
  adaptiveExecutionRequestHash,
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
import {
  assertSpeakingAssessmentIdempotencyKey,
  assertSpeakingAssessmentReservation,
  SPEAKING_ASSESSMENT_LEASE_MS,
  SpeakingAssessmentQuotaError,
  speakingAssessmentExportDto,
  SPEAKING_ASSESSMENT_LIMITS,
  speakingAssessmentPeriodStart,
} from '../speaking/assessment-quota.js';
import {
  assertSpeakingAccentProfileChange,
  assertSpeakingCalibrationConsent,
  assertSpeakingCalibrationReview,
  assertSpeakingCalibrationSample,
  blindSpeakingCalibrationCard,
  materialSpeakingCalibrationDisagreement,
  publicSpeakingAccentCalibration,
  publicSpeakingAccentProfile,
  publicSpeakingCalibrationSample,
  speakingAccentError,
  speakingCalibrationExpiresAt,
  speakingCalibrationReviewClaim,
} from '../speaking/accent-calibration.js';
import { hashAuthCode, normalizeUsername, normalizeVoiceTutorDeliveryMetadata, normalizeVoiceTutorProxyHash, subscriptionView, VoiceTutorError, voiceTutorAccessView, voiceTutorBillableSeconds, voiceTutorProxyUsage, voiceTutorQuotaPeriods, voiceTutorReservationSeconds } from './shared.js';
import {
  hasCanonicalMasteryRecords,
  migrateLegacyMasteryRecords,
  masteryEventReplayMatches,
  migrateMasteryRecords,
  reduceMastery,
} from '../public/modules/grammar.js';
import { assertGeneratedGrammarMasteryReferences } from '../validation/generated-grammar-mastery.js';
import { transitionPedagogicalState } from '../voice-tutor/state-machine.js';
import { transitionRuleCardReview } from '../voice-tutor/rule-card.js';
import {
  persistedVoiceTutorCapsule,
  revalidateSpeakingPronunciationCapsule,
} from '../voice-tutor/capsule.js';
import { createRecoveryLedger, planRecoveryFromTransfer, planRepeatAttempt, publicRepeatAttempt, recoveryMap, recoveryMetrics } from '../voice-tutor/recovery.js';
import {
  wordProgressApiDto,
  wordProgressExportDto,
  wordProgressPersistenceCandidate,
  wordProgressStorageDto,
} from './word-progress-dto.js';

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
  onAdaptiveSessionSnapshot = async () => {},
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
    await migrateGrammarMastery(username);
    const result = await pool.query('SELECT data FROM user_progress WHERE username = $1', [username]);
    return result.rows[0]?.data || {};
  }

  async function saveProgress(username, data) {
    const accepted = structuredClone(data || {});
    delete accepted.grammarMastery;
    delete accepted.grammarRunner;
    await pool.query(
      `INSERT INTO user_progress (username, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (username) DO UPDATE
       SET data = EXCLUDED.data || CASE
         WHEN user_progress.data ? 'grammarMastery'
           THEN jsonb_build_object('grammarMastery', user_progress.data->'grammarMastery')
         ELSE '{}'::jsonb END,
           updated_at = NOW()`,
      [username, JSON.stringify(accepted)],
    );
  }

  async function mergeProgress(username, modules) {
    const accepted = structuredClone(modules || {});
    delete accepted.grammarMastery;
    delete accepted.grammarRunner;
    const result = await pool.query(
      `INSERT INTO user_progress (username, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (username) DO UPDATE
       SET data = (COALESCE(user_progress.data, '{}'::jsonb) - 'grammarRunner') || EXCLUDED.data,
           updated_at = NOW()
       RETURNING data`,
      [username, JSON.stringify(accepted)],
    );
    return result.rows[0]?.data || {};
  }

  async function migrateGrammarMastery(username) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      const [clock, stored] = await Promise.all([
        client.query('SELECT clock_timestamp() AS now'),
        client.query('SELECT data FROM user_progress WHERE username = $1 FOR UPDATE', [username]),
      ]);
      const progress = stored.rows[0]?.data || {};
      const canonicalOwnsTruth = hasCanonicalMasteryRecords(progress.grammarMastery);
      const source = canonicalOwnsTruth ? progress.grammarMastery : progress.gram;
      if (!source || typeof source !== 'object') {
        await client.query('COMMIT');
        return structuredClone(canonicalOwnsTruth ? progress.grammarMastery : {});
      }
      const migrated = canonicalOwnsTruth
        ? migrateMasteryRecords(source, { now: new Date(clock.rows[0].now).getTime() })
        : migrateLegacyMasteryRecords(source, { now: new Date(clock.rows[0].now).getTime() });
      if (JSON.stringify(progress.grammarMastery) !== JSON.stringify(migrated)) {
        await client.query(
          `INSERT INTO user_progress (username, data, updated_at)
           VALUES ($1, $2::jsonb, clock_timestamp())
           ON CONFLICT (username) DO UPDATE
           SET data = EXCLUDED.data, updated_at = clock_timestamp()`,
          [username, JSON.stringify({ ...progress, grammarMastery: migrated })],
        );
      }
      await client.query('COMMIT');
      return migrated;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function applyGrammarMasteryEvents(username, entries) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockedOwner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!lockedOwner.rowCount) throw new Error('USER_NOT_FOUND');
      const clock = await client.query('SELECT clock_timestamp() AS now');
      const stored = await client.query('SELECT data FROM user_progress WHERE username = $1 FOR UPDATE', [username]);
      const now = new Date(clock.rows[0].now).getTime();
      const progress = stored.rows[0]?.data || {};
      const canonicalOwnsTruth = hasCanonicalMasteryRecords(progress.grammarMastery);
      const source = canonicalOwnsTruth ? progress.grammarMastery : (progress.gram || {});
      const grammarMastery = canonicalOwnsTruth
        ? migrateMasteryRecords(source, { now })
        : migrateLegacyMasteryRecords(source, { now });
      const authoritativeMastery = structuredClone(grammarMastery);
      const pendingResults = [];
      let changed = !canonicalOwnsTruth;
      for (const { topicId, event } of entries) {
        const current = grammarMastery[topicId]
          || migrateMasteryRecords({ [topicId]: {} }, { now })[topicId];
        const eventSeen = current.recentEventIds.includes(event.id);
        const replay = eventSeen && masteryEventReplayMatches(current, event);
        if (!eventSeen) {
          await assertGeneratedGrammarMasteryReferences(topicId, event, async (requestHash) => {
            const generated = await client.query(
              `SELECT operation, request, result FROM generated_tasks
               WHERE username = $1 AND request_hash = $2`,
              [username, requestHash],
            );
            return generated.rows[0] || null;
          });
        }
        const record = eventSeen
          ? current
          : reduceMastery(current, event, { now, clockAuthority: 'server', topicId });
        const applied = !replay && record.masteryRevision === current.masteryRevision + 1;
        if (applied) {
          grammarMastery[topicId] = record;
          changed = true;
        }
        pendingResults.push({
          topicId,
          eventId: event.id,
          applied,
          conflict: !applied && !replay,
          replay,
          record: applied ? record : current,
        });
      }
      const hasConflict = pendingResults.some((result) => result.conflict);
      const results = hasConflict
        ? pendingResults.map(({ topicId, eventId, replay }) => ({
          eventId,
          applied: false,
          conflict: !replay,
          replay,
          record: authoritativeMastery[topicId]
            || migrateMasteryRecords({ [topicId]: {} }, { now })[topicId],
        }))
        : pendingResults.map(({ topicId: _topicId, ...result }) => result);
      if (changed && !hasConflict) {
        await client.query(
          `INSERT INTO user_progress (username, data, updated_at)
           VALUES ($1, $2::jsonb, clock_timestamp())
           ON CONFLICT (username) DO UPDATE
           SET data = EXCLUDED.data, updated_at = clock_timestamp()`,
          [username, JSON.stringify({ ...progress, grammarMastery })],
        );
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function applyGrammarMasteryEvent(username, topicId, event) {
    return (await applyGrammarMasteryEvents(username, [{ topicId, event }]))[0];
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
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const result = await client.query(
        `INSERT INTO subscription_entitlements (username, entitlement, starts_at, ends_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username, entitlement) DO UPDATE SET
           starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, updated_at = NOW()
         RETURNING entitlement`,
        [username, entitlement, startsAtDate, endsAtDate],
      );
      await client.query('COMMIT');
      return result.rows[0].entitlement;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
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

  async function requireVoiceTutorEntitlement(queryable, username, instant) {
    const result = await queryable.query(
      `SELECT u.subscription_until > $2 AS subscribed,
              EXISTS (
                SELECT 1 FROM subscription_entitlements e
                WHERE e.username = u.username AND e.entitlement = 'voice_tutor'
                  AND e.starts_at <= $2 AND (e.ends_at IS NULL OR e.ends_at > $2)
              ) AS premium
       FROM users u WHERE u.username = $1`,
      [username, instant],
    );
    if (!result.rowCount) throw new Error('USER_NOT_FOUND');
    if (!result.rows[0].subscribed) throw new VoiceTutorError('SUBSCRIPTION_REQUIRED');
    if (!result.rows[0].premium) throw new VoiceTutorError('VOICE_TUTOR_PREMIUM_REQUIRED');
  }

  async function revalidateVoiceTutorPronunciationCapsule(
    queryable, username, storedCapsule, effectiveNow,
  ) {
    if (!storedCapsule?.source?.pronunciation_error_ref) return null;
    const attempt = await queryable.query(
      `SELECT id, username, task_type, assignment, assignment_fingerprint,
              evaluation_fingerprint, evaluation_claimed_at, evaluation_claim_generation,
              transcript, review, provider, model, prompt_version, status, error_code,
              source_session_id, source_task_ref, source_task_revision, source_catalog_id,
              source_catalog_revision, assistance_used, assistance_updated_at,
              accent_locale, targeted_practice, created_at, evaluated_at
       FROM speaking_attempts WHERE username = $1 AND id = $2 FOR UPDATE`,
      [username, Number(storedCapsule.source.attempt_id)],
    );
    return revalidateSpeakingPronunciationCapsule({
      attempt: attempt.rows[0], storedCapsule, referenceTime: effectiveNow,
    });
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
    id, idempotencyKey, limits, context = null, allowFallbackOnly = false,
  }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!user.rowCount) throw new Error('USER_NOT_FOUND');
      const instant = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now);
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
        `SELECT id, status, capsule, pedagogical_state, micro_check_passed, transfer_passed, outcome,
                started_at, voice_activated_at, expires_at, ended_at
         FROM voice_tutor_sessions
         WHERE username = $1 AND idempotency_key = $2 FOR UPDATE`,
        [username, idempotencyKey],
      );
      await requireVoiceTutorEntitlement(client, username, instant);
      if (existing.rowCount) {
        const validatedCapsule = await revalidateVoiceTutorPronunciationCapsule(
          client, username, existing.rows[0].capsule, instant,
        );
        const access = await readVoiceTutorAccess(client, username, limits, instant);
        await client.query('COMMIT');
        return {
          created: false, session: mapVoiceTutorSession(existing.rows[0]), ...access,
          ...(validatedCapsule ? { capsule: validatedCapsule } : {}),
        };
      }
      const validatedCapsule = context?.capsule
        ? await revalidateVoiceTutorPronunciationCapsule(
          client, username, context.capsule, instant,
        ) : null;
      const storedContextCapsule = validatedCapsule
        ? persistedVoiceTutorCapsule(validatedCapsule) : context?.capsule;
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
          storedContextCapsule?.id || null,
          storedContextCapsule ? JSON.stringify(storedContextCapsule) : null,
          context?.nonceHash || null,
          context ? (fallbackOnly ? 'local' : 'voice') : null, context ? 'diagnose' : null, null, null, null],
      );
      const updatedAccess = await readVoiceTutorAccess(client, username, limits, instant);
      await client.query('COMMIT');
      return {
        created: true, fallback_only: fallbackOnly,
        session: mapVoiceTutorSession(inserted.rows[0]), ...updatedAccess,
        ...(validatedCapsule ? { capsule: validatedCapsule } : {}),
      };
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
    ticketHash, idempotencyKey, expiresAt, reissue = false, nextNonceHash,
  }) {
    const client = await pool.connect();
    const ticketExpiresAt = new Date(expiresAt);
    const hash = normalizeVoiceTutorProxyHash(ticketHash);
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const instant = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now);
      await requireVoiceTutorEntitlement(client, username, instant);
      const selected = await client.query(
        `SELECT id, idempotency_key, status, capsule, nonce_hash, expires_at,
                proxy_ticket_hash, proxy_ticket_expires_at, proxy_ticket_consumed_at,
                proxy_ticket_reissue_count
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const session = selected.rows[0];
      if (!session?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      await revalidateVoiceTutorPronunciationCapsule(client, username, session.capsule, instant);
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
    idempotencyKey, nextNonceHash, recoverLostRealtime = false,
  }) {
    const client = await pool.connect();
    const nonceHash = normalizeVoiceTutorProxyHash(nextNonceHash);
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const instant = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now);
      await requireVoiceTutorEntitlement(client, username, instant);
      const selected = await client.query(
        `SELECT id, capsule, idempotency_key, delivery_mode, status, voice_activated_at,
                proxy_ticket_hash, proxy_ticket_consumed_at, proxy_ticket_reissue_count
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const session = selected.rows[0];
      await revalidateVoiceTutorPronunciationCapsule(client, username, session?.capsule, instant);
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
      const owner = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
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

  async function submitVoiceTutorRepeat(username, repeatId, {
    attemptId,
    taskId,
    answer,
    adaptiveExecutionClaim = null,
    adaptiveSessionId = null,
    now = new Date(),
  }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) throw new Error('VOICE_TUTOR_REPEAT_NOT_FOUND');
      await client.query('SELECT id FROM voice_tutor_repeats WHERE id = $1 FOR UPDATE', [repeatId]);
      const recoveryRows = await readRecoveryRows(client, username);
      const effectiveNow = adaptiveExecutionClaim
        ? new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now)
        : new Date(now);
      const plan = planRepeatAttempt({
        ledger: createRecoveryLedger(recoveryRows),
        username, repeatId, attemptId, taskId, answer, now: effectiveNow,
      });
      let adaptiveExecution = null;
      let claim = null;
      let block = null;
      let bindingCreated = false;
      if (adaptiveExecutionClaim) {
        const claimed = await client.query(
          `SELECT claim.*, session.status AS session_status, session.current_block_id,
                  session.execution_revision, session.blocks
           FROM adaptive_learning_execution_claims claim
           JOIN adaptive_learning_sessions session ON session.id = claim.session_id
           WHERE claim.token_hash = $1 FOR UPDATE OF claim, session`,
          [adaptiveExecutionTokenHash(adaptiveExecutionClaim)],
        );
        if (!claimed.rowCount || claimed.rows[0].username !== username
          || claimed.rows[0].session_id !== adaptiveSessionId) {
          throw new Error('ADAPTIVE_EXECUTION_CLAIM_INVALID');
        }
        claim = claimed.rows[0];
        block = claim.blocks.find((item) => item.id === claim.block_id);
        if (!block || claim.session_status !== 'in_progress' || claim.current_block_id !== block.id
          || Number(claim.execution_revision) !== Number(claim.session_execution_revision)
          || claim.revoked_at || new Date(claim.expires_at) <= effectiveNow
          || claim.launch_fingerprint !== adaptiveLaunchFingerprint(block)) {
          throw new Error(new Date(claim.expires_at) <= effectiveNow
            ? 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED' : 'ADAPTIVE_EXECUTION_CLAIM_INVALID');
        }
        if (claim.consumed_at) {
          if (claim.attempt_type !== 'voice_tutor_repeat'
            || String(claim.attempt_ref) !== String(plan.attempt.id)) {
            throw new Error('ADAPTIVE_EXECUTION_CLAIM_CONSUMED');
          }
        } else {
          const repeat = recoveryRows.repeats.find((item) => item.id === repeatId);
          const recovery = recoveryRows.recoveries.find((item) => item.id === repeat?.recovery_id);
          if (!adaptiveRepeatExecutionMatches({
            username, block, repeat, recovery, attempt: plan.attempt,
            claimIssuedAt: claim.issued_at,
          })) {
            throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
          }
          bindingCreated = true;
        }
        adaptiveExecution = {
          created: bindingCreated,
          evidenceQuality: 'server_verified_unassisted',
          adaptiveExecution: {
            sessionId: adaptiveSessionId,
            blockId: block.id,
            attemptType: 'voice_tutor_repeat',
            attemptId: String(plan.attempt.id),
          },
        };
      }
      let persistedAttempt = plan.attempt;
      if (plan.created) {
        const inserted = await client.query(
          `INSERT INTO voice_tutor_repeat_attempts (id, repeat_id, task_id, passed, fingerprint, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [plan.attempt.id, plan.attempt.repeat_id, plan.attempt.task_id, plan.attempt.passed,
            plan.attempt.fingerprint, new Date(plan.attempt.observed_at)],
        );
        persistedAttempt = inserted.rows[0];
        if (plan.daySevenReschedule) {
          await client.query(
            `UPDATE voice_tutor_repeats
             SET due_at = $2, window_ends_at = $3 WHERE id = $1`,
            [plan.daySevenReschedule.repeatId, new Date(plan.daySevenReschedule.dueAt), new Date(plan.daySevenReschedule.windowEndsAt)],
          );
        }
      }
      if (bindingCreated) {
        await client.query(
          `UPDATE adaptive_learning_execution_claims
           SET consumed_at = $2, attempt_type = 'voice_tutor_repeat', attempt_ref = $3 WHERE id = $1`,
          [claim.id, effectiveNow, String(plan.attempt.id)],
        );
      }
      await client.query('COMMIT');
      return {
        created: plan.created,
        attempt: publicRepeatAttempt(persistedAttempt),
        ...(adaptiveExecution ? { adaptiveExecution } : {}),
      };
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

  async function switchVoiceTutorSessionDelivery(username, sessionId, {
    nonceHash, nextNonceHash, mode, limits, errorCode = null,
  }) {
    if (!['text', 'local'].includes(mode)) throw new VoiceTutorError('VOICE_TUTOR_DELIVERY_INVALID');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!user.rowCount) throw new Error('USER_NOT_FOUND');
      const instant = new Date((await client.query(
        'SELECT clock_timestamp() AS now',
      )).rows[0].now);
      await requireVoiceTutorEntitlement(client, username, instant);
      const selected = await client.query(
        `SELECT status, reserved_seconds, started_at, voice_activated_at, expires_at, capsule_id, capsule, nonce_hash,
                proxy_ticket_consumed_at, proxy_input_audio_bytes, proxy_output_audio_bytes, proxy_finalized_at
         FROM voice_tutor_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, sessionId],
      );
      const row = selected.rows[0];
      if (!row?.capsule) throw new VoiceTutorError('VOICE_TUTOR_SESSION_NOT_FOUND');
      const validatedCapsule = await revalidateVoiceTutorPronunciationCapsule(
        client, username, row.capsule, instant,
      );
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
      return {
        session: mapVoiceTutorSession(updated.rows[0]),
        capsule: validatedCapsule || row.capsule,
        ...access,
      };
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

  async function getSpeakingAccentProfile(username) {
    const result = await pool.query('SELECT * FROM speaking_accent_profiles WHERE username = $1', [username]);
    return publicSpeakingAccentProfile(result.rows[0] || null);
  }

  async function getSpeakingAccentHistory(username) {
    const result = await pool.query(
      `SELECT id, locale, revision, source, effective_at
       FROM speaking_accent_profile_history WHERE username = $1 ORDER BY revision`,
      [username],
    );
    return result.rows.map((row) => ({ ...row, revision: Number(row.revision) }));
  }

  async function setSpeakingAccentProfile(username, input) {
    const parsed = assertSpeakingAccentProfileChange(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const selected = await client.query('SELECT * FROM speaking_accent_profiles WHERE username = $1 FOR UPDATE', [username]);
      const previous = selected.rows[0] || null;
      const calibration = await client.query(
        'SELECT * FROM speaking_accent_calibrations WHERE username = $1 FOR UPDATE',
        [username],
      );
      if (parsed.source === 'manual' && calibration.rows[0]?.status === 'pending') {
        await client.query(
          `UPDATE speaking_accent_calibrations
           SET status = 'cancelled', completed_at = $2, locale = NULL, confidence = NULL,
               evidence_keys = NULL, policy_version = NULL
           WHERE username = $1 AND status = 'pending'`,
          [username, parsed.now],
        );
      }
      if (previous?.locale === parsed.locale) {
        await client.query('COMMIT');
        return { changed: false, profile: publicSpeakingAccentProfile(previous) };
      }
      const revision = Number(previous?.revision || 0) + 1;
      const calibrationUsed = Boolean(previous?.calibration_used || calibration.rowCount);
      const updated = await client.query(
        `INSERT INTO speaking_accent_profiles
         (username, locale, revision, source, effective_at, calibration_used)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (username) DO UPDATE SET locale = EXCLUDED.locale, revision = EXCLUDED.revision,
           source = EXCLUDED.source, effective_at = EXCLUDED.effective_at,
           calibration_used = EXCLUDED.calibration_used
         RETURNING *`,
        [username, parsed.locale, revision, parsed.source, parsed.now, calibrationUsed],
      );
      await client.query(
        `INSERT INTO speaking_accent_profile_history
         (id, username, locale, revision, source, effective_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [crypto.randomUUID(), username, parsed.locale, revision, parsed.source, parsed.now],
      );
      await client.query('COMMIT');
      return { changed: true, profile: publicSpeakingAccentProfile(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function startSpeakingAccentCalibration(username, { now = new Date() } = {}) {
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_INVALID');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const profile = await client.query(
        'SELECT username FROM speaking_accent_profiles WHERE username = $1 FOR UPDATE',
        [username],
      );
      if (profile.rowCount) throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_ALREADY_USED');
      const result = await client.query(
        `INSERT INTO speaking_accent_calibrations (id, username, status, started_at)
         VALUES ($1, $2, 'pending', $3) RETURNING id, status, started_at`,
        [crypto.randomUUID(), username, instant],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_ALREADY_USED');
      throw error;
    } finally { client.release(); }
  }

  async function getSpeakingAccentCalibration(username, setupId) {
    const result = await pool.query(
      'SELECT * FROM speaking_accent_calibrations WHERE username = $1 AND id = $2',
      [username, setupId],
    );
    return result.rows[0] || null;
  }

  async function getPendingSpeakingAccentCalibration(username) {
    const result = await pool.query(
      `SELECT id, status, started_at FROM speaking_accent_calibrations
       WHERE username = $1 AND status = 'pending'`,
      [username],
    );
    return result.rows[0] || null;
  }

  async function completeSpeakingAccentCalibration(username, input) {
    const locale = String(input?.locale || '');
    const confidence = String(input?.suggestionConfidence || '');
    const setupId = String(input?.setupId || '');
    const policyVersion = String(input?.policyVersion || '');
    const evidenceKeys = Array.isArray(input?.evidenceKeys) ? input.evidenceKeys.map(String) : [];
    const instant = new Date(input?.now ?? new Date());
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
    if (!['en-GB', 'en-US'].includes(locale) || !['clear', 'close'].includes(confidence)
      || !uuid.test(setupId) || policyVersion !== 'speaking-accent-suggestion-v1'
      || evidenceKeys.length !== 2 || evidenceKeys[0] === evidenceKeys[1]
      || evidenceKeys.some((key) => !uuid.test(key)) || !Number.isFinite(instant.getTime())) {
      throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_INVALID');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const setup = await client.query(
        'SELECT * FROM speaking_accent_calibrations WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, setupId],
      );
      if (!setup.rowCount) throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_NOT_FOUND');
      if (setup.rows[0].status !== 'pending') throw speakingAccentError('SPEAKING_ACCENT_CALIBRATION_ALREADY_USED');
      const previous = await client.query('SELECT * FROM speaking_accent_profiles WHERE username = $1 FOR UPDATE', [username]);
      const revision = Number(previous.rows[0]?.revision || 0) + 1;
      await client.query(
        `UPDATE speaking_accent_calibrations SET status = 'completed', completed_at = $3,
           locale = $4, confidence = $5, evidence_keys = $6::uuid[], policy_version = $7
         WHERE username = $1 AND id = $2`,
        [username, setupId, instant, locale, confidence, evidenceKeys, policyVersion],
      );
      const profile = await client.query(
        `INSERT INTO speaking_accent_profiles
         (username, locale, revision, source, effective_at, calibration_used)
         VALUES ($1, $2, $3, 'calibration', $4, TRUE)
         ON CONFLICT (username) DO UPDATE SET locale = EXCLUDED.locale, revision = EXCLUDED.revision,
           source = 'calibration', effective_at = EXCLUDED.effective_at, calibration_used = TRUE
         RETURNING *`,
        [username, locale, revision, instant],
      );
      await client.query(
        `INSERT INTO speaking_accent_profile_history
         (id, username, locale, revision, source, effective_at)
         VALUES ($1, $2, $3, $4, 'calibration', $5)`,
        [crypto.randomUUID(), username, locale, revision, instant],
      );
      await client.query('COMMIT');
      return { profile: publicSpeakingAccentProfile(profile.rows[0]), suggestionConfidence: confidence };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getSpeakingCalibrationConsent(username) {
    const result = await pool.query(
      `SELECT granted, age_group, guardian_confirmed, policy_version,
              granted_at, revoked_at, updated_at
       FROM speaking_calibration_consents WHERE username = $1`,
      [username],
    );
    return result.rows[0] || null;
  }

  async function setSpeakingCalibrationConsent(username, input) {
    const parsed = assertSpeakingCalibrationConsent(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const consent = await client.query(
        `INSERT INTO speaking_calibration_consents
         (username, granted, age_group, guardian_confirmed, policy_version,
          granted_at, revoked_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $2 THEN $6::timestamptz END,
                 CASE WHEN NOT $2 THEN $6::timestamptz END, $6)
         ON CONFLICT (username) DO UPDATE SET granted = EXCLUDED.granted,
           age_group = EXCLUDED.age_group, guardian_confirmed = EXCLUDED.guardian_confirmed,
           policy_version = EXCLUDED.policy_version,
           granted_at = CASE WHEN EXCLUDED.granted THEN COALESCE(speaking_calibration_consents.granted_at, EXCLUDED.updated_at) END,
           revoked_at = CASE WHEN NOT EXCLUDED.granted THEN EXCLUDED.updated_at END,
           updated_at = EXCLUDED.updated_at
         RETURNING granted, age_group, guardian_confirmed, policy_version,
                   granted_at, revoked_at, updated_at`,
        [username, parsed.granted, parsed.ageGroup, parsed.guardianConfirmed, parsed.policyVersion, parsed.now],
      );
      if (!parsed.granted) {
        await client.query(
          `UPDATE speaking_calibration_samples SET audio = NULL, raw_deleted_at = $2,
             status = 'consent_revoked'
           WHERE username = $1 AND audio IS NOT NULL`,
          [username, parsed.now],
        );
      }
      await client.query('COMMIT');
      return consent.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function createSpeakingCalibrationSample(username, input) {
    const parsed = assertSpeakingCalibrationSample(input);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const consent = await client.query(
        'SELECT granted FROM speaking_calibration_consents WHERE username = $1 FOR UPDATE',
        [username],
      );
      if (!consent.rows[0]?.granted) throw speakingAccentError('SPEAKING_CALIBRATION_CONSENT_REQUIRED');
      const duplicate = await client.query(
        'SELECT * FROM speaking_calibration_samples WHERE username = $1 AND assessment_key = $2',
        [username, parsed.assessmentKey],
      );
      if (duplicate.rowCount) {
        await client.query('COMMIT');
        return publicSpeakingCalibrationSample(duplicate.rows[0]);
      }
      const sample = await client.query(
        `INSERT INTO speaking_calibration_samples
         (id, username, assessment_key, task_type, task_ref, locale, maximum_score,
          task_snapshot, rubric_snapshot, status, audio, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
                 'awaiting_reviews', $10, $11, $12)
         RETURNING *`,
        [parsed.id, username, parsed.assessmentKey, parsed.taskType, parsed.taskRef,
          parsed.locale, parsed.maximumScore, JSON.stringify(parsed.taskSnapshot),
          JSON.stringify(parsed.rubricSnapshot), parsed.audio, parsed.now,
          speakingCalibrationExpiresAt(parsed.now)],
      );
      await client.query('COMMIT');
      return publicSpeakingCalibrationSample(sample.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function purgeExpiredSpeakingCalibrationSamples({ now = new Date() } = {}) {
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw speakingAccentError('SPEAKING_CALIBRATION_TIME_INVALID');
    const result = await pool.query(
      `UPDATE speaking_calibration_samples SET audio = NULL, raw_deleted_at = $1, status = 'expired'
       WHERE audio IS NOT NULL AND expires_at <= $1 RETURNING id`,
      [instant],
    );
    return { deletedAudio: result.rowCount };
  }

  async function claimSpeakingCalibrationSample(reviewer, { now = new Date() } = {}) {
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw speakingAccentError('SPEAKING_CALIBRATION_TIME_INVALID');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE speaking_calibration_samples SET audio = NULL, raw_deleted_at = $1, status = 'expired'
         WHERE audio IS NOT NULL AND expires_at <= $1`,
        [instant],
      );
      const selected = await client.query(
        `SELECT sample.* FROM speaking_calibration_samples sample
         JOIN speaking_calibration_consents consent ON consent.username = sample.username AND consent.granted
         LEFT JOIN LATERAL (
           SELECT entry.audit
           FROM jsonb_array_elements(sample.access_audit) WITH ORDINALITY AS entry(audit, ordinal)
           WHERE (entry.audit->>'review_round')::integer = jsonb_array_length(sample.reviews) + 1
           ORDER BY entry.ordinal DESC
           LIMIT 1
         ) current_claim ON TRUE
         WHERE sample.audio IS NOT NULL
           AND sample.status IN ('awaiting_reviews', 'adjudication_pending')
           AND NOT sample.reviews @> $1::jsonb
           AND jsonb_array_length(sample.reviews) < 12
           AND (SELECT COUNT(*) FROM jsonb_array_elements(sample.reviews) review
                WHERE COALESCE((review->>'sufficient')::boolean, FALSE)) < 3
           AND (current_claim.audit IS NULL
             OR current_claim.audit->>'reviewer' = $2
             OR (current_claim.audit->>'accessed_at')::timestamptz <= $3)
         ORDER BY sample.created_at, sample.id
         LIMIT 1 FOR UPDATE OF sample SKIP LOCKED`,
        [JSON.stringify([{ reviewer }]), reviewer,
          new Date(instant.getTime() - 15 * 60 * 1_000)],
      );
      const sample = selected.rows[0] || null;
      if (!sample) {
        await client.query('COMMIT');
        return null;
      }
      const claim = speakingCalibrationReviewClaim(sample, reviewer, instant);
      if (!claim.resume) {
        const accessAudit = [...sample.access_audit, {
          reviewer, review_round: claim.reviewRound, accessed_at: instant.toISOString(),
        }].slice(-12);
        sample.access_audit = accessAudit;
        await client.query(
          'UPDATE speaking_calibration_samples SET access_audit = $2::jsonb WHERE id = $1',
          [sample.id, JSON.stringify(accessAudit)],
        );
      }
      await client.query('COMMIT');
      return blindSpeakingCalibrationCard(sample);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getSpeakingCalibrationAudio(sampleId, reviewer, { now = new Date() } = {}) {
    const instant = new Date(now);
    if (!Number.isFinite(instant.getTime())) throw speakingAccentError('SPEAKING_CALIBRATION_TIME_INVALID');
    const expired = await pool.query(
      `UPDATE speaking_calibration_samples
       SET audio = NULL, raw_deleted_at = $2, status = 'expired'
       WHERE id = $1 AND audio IS NOT NULL AND expires_at <= $2
       RETURNING id`,
      [sampleId, instant],
    );
    if (expired.rowCount) return null;
    const result = await pool.query(
      'SELECT audio, reviews, access_audit FROM speaking_calibration_samples WHERE id = $1 AND audio IS NOT NULL',
      [sampleId],
    );
    const sample = result.rows[0];
    return sample && speakingCalibrationReviewClaim(sample, reviewer, instant).ownsActiveClaim
      ? sample.audio : null;
  }

  async function submitSpeakingCalibrationReview(reviewer, sampleId, input) {
    const reviewInstant = new Date(input?.now ?? new Date());
    if (Number.isFinite(reviewInstant.getTime())) {
      await pool.query(
        `UPDATE speaking_calibration_samples
         SET audio = NULL, raw_deleted_at = $2, status = 'expired'
         WHERE id = $1 AND audio IS NOT NULL AND expires_at <= $2`,
        [sampleId, reviewInstant],
      );
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        'SELECT * FROM speaking_calibration_samples WHERE id = $1 FOR UPDATE',
        [sampleId],
      );
      const sample = selected.rows[0];
      if (!sample?.audio || !['awaiting_reviews', 'adjudication_pending'].includes(sample.status)) {
        throw speakingAccentError('SPEAKING_CALIBRATION_SAMPLE_NOT_AVAILABLE');
      }
      if (sample.reviews.some((entry) => entry.reviewer === reviewer)) {
        throw speakingAccentError('SPEAKING_CALIBRATION_REVIEWER_NOT_INDEPENDENT');
      }
      if (!speakingCalibrationReviewClaim(sample, reviewer, input?.now).ownsActiveClaim) {
        throw speakingAccentError('SPEAKING_CALIBRATION_REVIEW_CLAIM_REQUIRED');
      }
      const review = assertSpeakingCalibrationReview(sample, input);
      const reviews = [...sample.reviews, {
        reviewer, sufficient: review.sufficient, score: review.score, critical_error: review.criticalError,
        reviewed_at: review.now.toISOString(),
      }];
      const sufficientReviews = reviews.filter((entry) => entry.sufficient !== false);
      let status = 'awaiting_reviews';
      let deleteAudio = false;
      if (sufficientReviews.length === 2) {
        const material = materialSpeakingCalibrationDisagreement(sample.task_type,
          { score: sufficientReviews[0].score, criticalError: sufficientReviews[0].critical_error },
          { score: sufficientReviews[1].score, criticalError: sufficientReviews[1].critical_error });
        status = material ? 'adjudication_pending' : 'completed';
        deleteAudio = !material;
      } else if (sufficientReviews.length === 3) {
        status = 'completed';
        deleteAudio = true;
      }
      const updated = await client.query(
        `UPDATE speaking_calibration_samples
         SET reviews = $2::jsonb, status = $3,
             audio = CASE WHEN $4 THEN NULL ELSE audio END,
             raw_deleted_at = CASE WHEN $4 THEN $5 ELSE raw_deleted_at END,
             completed_at = CASE WHEN $4 THEN $5 ELSE completed_at END
         WHERE id = $1 RETURNING *`,
        [sampleId, JSON.stringify(reviews), status, deleteAudio, review.now],
      );
      await client.query('COMMIT');
      const row = updated.rows[0];
      return {
        sampleId: row.id, status: row.status, audio_retained: Boolean(row.audio),
        reviewCount: row.reviews.filter((entry) => entry.sufficient !== false).length,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function listSpeakingCalibrationSamplesForOwner(username) {
    const result = await pool.query(
      'SELECT * FROM speaking_calibration_samples WHERE username = $1 ORDER BY created_at',
      [username],
    );
    return result.rows.map(publicSpeakingCalibrationSample);
  }

  async function listAnonymousSpeakingCalibrationLabels() {
    const result = await pool.query(
      `SELECT id, task_type, locale, reviews FROM speaking_calibration_samples
       WHERE status = 'completed' ORDER BY created_at`,
    );
    return result.rows.map((row) => ({
      sampleId: row.id, taskType: Number(row.task_type), accentLocale: row.locale,
      ratings: row.reviews.map(({ reviewer, ...rating }) => rating),
    }));
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
       (username, task_type, assignment, answer, evaluated_answer, source_task_ref, prompt_version, status)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, 'pending')
       RETURNING id`,
      [username, input.taskType, JSON.stringify(input.assignment), input.answer,
        input.evaluatedAnswer ?? input.answer, input.sourceTaskRef || null, promptVersion],
    );
    return Number(result.rows[0].id);
  }

  async function finishWritingAttempt(id, result) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const attempt = await client.query(
        'SELECT username FROM writing_attempts WHERE id = $1', [id],
      );
      if (!attempt.rowCount) throw new Error('WRITING_ATTEMPT_NOT_FOUND');
      const username = attempt.rows[0].username;
      const owner = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) throw new Error('WRITING_ATTEMPT_NOT_FOUND');
      const updated = await client.query(
        `UPDATE writing_attempts
         SET status = $2, review = $3::jsonb, provider = $4, model = $5,
             error_code = $6, evaluated_at = NOW()
         WHERE id = $1 AND username = $7
         RETURNING id`,
        [id, result.status, result.review ? JSON.stringify(result.review) : null, result.provider || null,
          result.model || null, result.errorCode || null, username],
      );
      if (!updated.rowCount) throw new Error('WRITING_ATTEMPT_NOT_FOUND');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getWritingAttempt(username, id) {
    const result = await pool.query(
      `SELECT id, username, task_type, assignment, answer, evaluated_answer, source_task_ref, review, provider, model,
              prompt_version, status, error_code, created_at, evaluated_at
       FROM writing_attempts WHERE username = $1 AND id = $2`,
      [username, id],
    );
    return result.rows[0] || null;
  }

  async function createSpeakingAttempt(username, input, promptVersion) {
    const result = await pool.query(
      `INSERT INTO speaking_attempts
       (username, task_type, assignment, assignment_fingerprint, transcript, prompt_version, status)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'pending') RETURNING id`,
      [username, input.taskType, JSON.stringify(input.assignment),
        adaptiveExecutionRequestHash(input.assignment), input.transcript, promptVersion],
    );
    return Number(result.rows[0].id);
  }

  async function claimSpeakingEvaluation(username, input, promptVersion, evaluationFingerprint, {
    now = new Date(), source = null,
  } = {}) {
    if (!/^[a-f0-9]{64}$/u.test(evaluationFingerprint)) {
      throw new Error('SPEAKING_EVALUATION_FINGERPRINT_INVALID');
    }
    const requestedSource = source == null ? null : assertSpeakingLearningSource(source);
    const claimedAt = new Date(now);
    if (!Number.isFinite(claimedAt.getTime())) throw new Error('SPEAKING_EVALUATION_CLAIM_TIME_INVALID');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE',
        [username],
      );
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      let learningSource = requestedSource;
      if (requestedSource) {
        const taskType = Number(input.taskType);
        if (!Number.isInteger(taskType) || taskType < 1 || taskType > 4) {
          throw new Error('SPEAKING_LEARNING_SOURCE_INVALID');
        }
        const fullSection = requestedSource.sessionMode === 'full_section';
        const sourceSession = fullSection
          ? await client.query(
            `SELECT id, assignments, status, accent_locale
             FROM speaking_full_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
            [username, requestedSource.sessionId],
          )
          : await client.query(
            `SELECT id, catalog_id, catalog_revision, task_id, task_revision, status, assistance_used,
                    accent_locale, targeted_practice
             FROM speaking_task${taskType}_sessions WHERE username = $1 AND id = $2 FOR UPDATE`,
            [username, requestedSource.sessionId],
          );
        learningSource = canonicalSpeakingLearningSource(requestedSource, {
          taskType,
          session: sourceSession.rows[0],
        });
      }
      const values = [
        username,
        input.taskType,
        JSON.stringify(input.assignment),
        adaptiveExecutionRequestHash(input.assignment),
        evaluationFingerprint,
        input.transcript,
        promptVersion,
        claimedAt,
        new Date(claimedAt.getTime() - SPEAKING_EVALUATION_CLAIM_LEASE_MS),
        SPEAKING_EVALUATION_RETRYABLE_ERRORS,
        learningSource?.sessionId || null,
        learningSource?.taskRef || null,
        learningSource?.taskRevision || null,
        learningSource?.catalogId || null,
        learningSource?.catalogRevision || null,
        learningSource?.assistanceUsed ?? true,
        learningSource?.accentLocale || null,
        learningSource?.targetedPractice ? JSON.stringify(learningSource.targetedPractice) : null,
      ];
      const inserted = await client.query(
      `INSERT INTO speaking_attempts
       (username, task_type, assignment, assignment_fingerprint, evaluation_fingerprint,
         transcript, prompt_version, status, evaluation_claimed_at, evaluation_claim_generation,
         source_session_id, source_task_ref, source_task_revision, source_catalog_id,
         source_catalog_revision, assistance_used, assistance_updated_at, accent_locale, targeted_practice)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, 'pending', $8, 1,
          $11, $12, $13, $14, $15, $16, CASE WHEN $16 THEN $8::timestamptz ELSE NULL END, $17, $18::jsonb)
       ON CONFLICT (username, evaluation_fingerprint)
         WHERE evaluation_fingerprint IS NOT NULL
       DO UPDATE SET status = 'pending', review = NULL, provider = NULL, model = NULL,
         error_code = NULL, evaluated_at = NULL, evaluation_claimed_at = EXCLUDED.evaluation_claimed_at,
         evaluation_claim_generation = speaking_attempts.evaluation_claim_generation + 1,
         source_session_id = COALESCE(EXCLUDED.source_session_id, speaking_attempts.source_session_id),
         source_task_ref = COALESCE(EXCLUDED.source_task_ref, speaking_attempts.source_task_ref),
         source_task_revision = COALESCE(EXCLUDED.source_task_revision, speaking_attempts.source_task_revision),
         source_catalog_id = COALESCE(EXCLUDED.source_catalog_id, speaking_attempts.source_catalog_id),
         source_catalog_revision = COALESCE(EXCLUDED.source_catalog_revision, speaking_attempts.source_catalog_revision),
         accent_locale = COALESCE(EXCLUDED.accent_locale, speaking_attempts.accent_locale),
         targeted_practice = COALESCE(EXCLUDED.targeted_practice, speaking_attempts.targeted_practice),
         assistance_used = speaking_attempts.assistance_used OR EXCLUDED.assistance_used,
         assistance_updated_at = CASE
           WHEN speaking_attempts.assistance_used THEN speaking_attempts.assistance_updated_at
           WHEN EXCLUDED.assistance_used THEN EXCLUDED.assistance_updated_at
           ELSE NULL
         END
       WHERE (
         speaking_attempts.status = 'pending'
         AND COALESCE(speaking_attempts.evaluation_claimed_at, speaking_attempts.created_at) <= $9
       ) OR (
         speaking_attempts.status = 'failed'
         AND speaking_attempts.error_code = ANY($10::text[])
       )
       RETURNING id, username, task_type, assignment, assignment_fingerprint,
          evaluation_fingerprint, evaluation_claimed_at, evaluation_claim_generation,
          source_session_id, source_task_ref, source_task_revision, source_catalog_id,
          source_catalog_revision, assistance_used, assistance_updated_at, accent_locale, targeted_practice,
         transcript, review, provider, model, prompt_version, status,
         error_code, created_at, evaluated_at`,
        values,
      );
      let row = inserted.rows[0];
      if (!row) {
        const replay = await client.query(
        `SELECT id, username, task_type, assignment, assignment_fingerprint,
                evaluation_fingerprint, evaluation_claimed_at, evaluation_claim_generation,
                source_session_id, source_task_ref, source_task_revision, source_catalog_id,
                source_catalog_revision, assistance_used, assistance_updated_at, accent_locale, targeted_practice,
                transcript, review, provider, model, prompt_version, status,
                error_code, created_at, evaluated_at
         FROM speaking_attempts
         WHERE username = $1 AND evaluation_fingerprint = $2`,
        [username, evaluationFingerprint],
      );
        row = replay.rows[0];
      }
      if (!row) throw new Error('SPEAKING_EVALUATION_CLAIM_FAILED');
      await client.query('COMMIT');
      return { created: inserted.rowCount === 1, attempt: { ...row, id: Number(row.id) } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function finishSpeakingAttempt(id, result, { claimGeneration = null } = {}) {
    const generation = claimGeneration == null ? null : Number(claimGeneration);
    const resultLocale = result.review?.acousticFacts?.accentLocale || null;
    if (generation != null && (!Number.isInteger(generation) || generation < 1)) {
      throw new Error('SPEAKING_EVALUATION_CLAIM_LOST');
    }
    if (resultLocale && !['en-GB', 'en-US'].includes(resultLocale)) {
      throw new Error('SPEAKING_ACCENT_LOCALE_INVALID');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const attempt = await client.query(
        'SELECT username, accent_locale FROM speaking_attempts WHERE id = $1', [id],
      );
      if (!attempt.rowCount) throw new Error('SPEAKING_ATTEMPT_NOT_FOUND');
      const username = attempt.rows[0].username;
      if (attempt.rows[0].accent_locale && resultLocale
        && attempt.rows[0].accent_locale !== resultLocale) {
        throw new Error('SPEAKING_LEARNING_SOURCE_MISMATCH');
      }
      const owner = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) throw new Error('SPEAKING_ATTEMPT_NOT_FOUND');
      const updated = await client.query(
        `UPDATE speaking_attempts SET status = $2, review = $3::jsonb, provider = $4, model = $5,
           error_code = $6, evaluated_at = NOW(), accent_locale = COALESCE(accent_locale, $9)
         WHERE id = $1 AND username = $8
           AND ($7::integer IS NULL OR (status = 'pending' AND evaluation_claim_generation = $7))
         RETURNING id`,
        [id, result.status, result.review ? JSON.stringify(result.review) : null,
          result.provider || null, result.model || null, result.errorCode || null, generation, username,
          resultLocale],
      );
      if (!updated.rowCount) {
        throw new Error(generation == null
          ? 'SPEAKING_ATTEMPT_NOT_FOUND' : 'SPEAKING_EVALUATION_CLAIM_LOST');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function getSpeakingEvaluationClaim(username, evaluationFingerprint) {
    const result = await pool.query(
      `SELECT id, username, task_type, assignment, assignment_fingerprint,
               evaluation_fingerprint, evaluation_claimed_at, evaluation_claim_generation,
               source_session_id, source_task_ref, source_task_revision, source_catalog_id,
               source_catalog_revision, assistance_used, assistance_updated_at, accent_locale, targeted_practice,
              transcript, review, provider, model, prompt_version, status,
              error_code, created_at, evaluated_at
       FROM speaking_attempts
       WHERE username = $1 AND evaluation_fingerprint = $2`,
      [username, evaluationFingerprint],
    );
    return result.rows[0] ? { ...result.rows[0], id: Number(result.rows[0].id) } : null;
  }

  async function getSpeakingAttempt(username, id) {
    const result = await pool.query(
      `SELECT id, username, task_type, assignment, assignment_fingerprint, evaluation_fingerprint,
               evaluation_claimed_at, evaluation_claim_generation, transcript, review, provider, model,
               prompt_version, status, error_code, source_session_id, source_task_ref,
               source_task_revision, source_catalog_id, source_catalog_revision, assistance_used,
               assistance_updated_at, accent_locale, targeted_practice, created_at, evaluated_at
       FROM speaking_attempts WHERE username = $1 AND id = $2`,
      [username, id],
    );
    return result.rows[0] || null;
  }

  async function readSpeakingLearningAttempts(queryable, username, { limit = 120 } = {}) {
    const boundedLimit = Math.min(120, Math.max(1, Number.isInteger(limit) ? limit : 120));
    const result = await queryable.query(
      `SELECT id, task_type, transcript, review, status, source_session_id, source_task_ref,
              source_task_revision, source_catalog_id, source_catalog_revision, assistance_used,
              assistance_updated_at, accent_locale, targeted_practice, created_at, evaluated_at
       FROM speaking_attempts
       WHERE username = $1 AND status IN ('completed', 'needs_retry')
       ORDER BY COALESCE(evaluated_at, created_at) DESC, id DESC
       LIMIT $2`,
      [username, boundedLimit],
    );
    return result.rows.map(buildSpeakingLearningAttempt).filter(Boolean);
  }

  async function getSpeakingLearningAttempts(username, options = {}) {
    return readSpeakingLearningAttempts(pool, username, options);
  }

  async function getSpeakingLearningReportSnapshot(username, { limit = 120 } = {}) {
    return withSpeakingAssessmentTransaction(username, async (client, owner) => {
      const effectiveNow = new Date((await client.query(
        'SELECT clock_timestamp() AS now',
      )).rows[0].now);
      if (!owner.subscription_until || new Date(owner.subscription_until) <= effectiveNow) {
        throw Object.assign(new Error('SUBSCRIPTION_REQUIRED'), { code: 'SUBSCRIPTION_REQUIRED' });
      }
      await reconcileSpeakingAssessmentLeases(client, username, effectiveNow);
      const attempts = await readSpeakingLearningAttempts(client, username, { limit });
      const quota = await readSpeakingAssessmentQuota(client, username, effectiveNow);
      const profile = await client.query(
        'SELECT * FROM speaking_accent_profiles WHERE username = $1',
        [username],
      );
      return {
        attempts,
        quota,
        accentProfile: publicSpeakingAccentProfile(profile.rows[0] || null),
        effectiveNow: effectiveNow.toISOString(),
      };
    });
  }

  const speakingSessionTable = (kind) => ({
    task1: 'speaking_task1_sessions',
    task2: 'speaking_task2_sessions',
    task3: 'speaking_task3_sessions',
    task4: 'speaking_task4_sessions',
  })[kind];

  async function assignSpeakingCatalogSession(kind, createSession, username, {
    catalogId, catalogRevision, tasks, accentProfile = null, calibrationSetupId = null, now,
    excludeTaskIds = [], preferredTaskIds = [], selectionReason = null, targetedPractice = null,
    targetedPracticeRequest = null,
  }) {
    const table = speakingSessionTable(kind);
    if (!table) throw new Error('SPEAKING_SESSION_KIND_INVALID');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        'SELECT username, subscription_until FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      let targetedPracticeNow = null;
      if (targetedPracticeRequest) {
        targetedPracticeNow = new Date((await client.query(
          'SELECT clock_timestamp() AS now',
        )).rows[0].now);
        if (!owner.rows[0].subscription_until
          || new Date(owner.rows[0].subscription_until) <= targetedPracticeNow) {
          throw Object.assign(new Error('SUBSCRIPTION_REQUIRED'), { code: 'SUBSCRIPTION_REQUIRED' });
        }
      }
      const canonicalProfile = await client.query(
        'SELECT * FROM speaking_accent_profiles WHERE username = $1',
        [username],
      );
      const effectiveAccentProfile = canonicalProfile.rowCount
        ? publicSpeakingAccentProfile(canonicalProfile.rows[0])
        : accentProfile;
      const effectiveCalibrationSetupId = effectiveAccentProfile ? null : calibrationSetupId;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`speaking-${kind}:${username}`]);
      if (effectiveCalibrationSetupId) {
        const calibration = await client.query(
          `SELECT id FROM speaking_accent_calibrations
           WHERE id = $1 AND username = $2 AND status = 'pending'`,
          [effectiveCalibrationSetupId, username],
        );
        if (!calibration.rowCount) throw speakingAccentError('SPEAKING_ACCENT_PROFILE_REQUIRED');
      }
      let effectiveAssignment = {
        excludeTaskIds, preferredTaskIds, selectionReason, targetedPractice,
      };
      if (targetedPracticeRequest) {
        const quota = await readSpeakingAssessmentQuota(client, username, targetedPracticeNow);
        const learningRows = await client.query(
          `SELECT id, task_type, transcript, review, status, source_session_id, source_task_ref,
                  source_task_revision, source_catalog_id, source_catalog_revision, assistance_used,
                  assistance_updated_at, accent_locale, targeted_practice, created_at, evaluated_at
           FROM speaking_attempts
           WHERE username = $1 AND status IN ('completed', 'needs_retry')
           ORDER BY COALESCE(evaluated_at, created_at) DESC, id DESC
           LIMIT 120`,
          [username],
        );
        effectiveAssignment = speakingTargetedPracticeAssignment(
          learningRows.rows.map(buildSpeakingLearningAttempt).filter(Boolean),
          targetedPracticeRequest,
          tasks[0]?.taskType,
          { tier: quota.tier, activeAccentLocale: effectiveAccentProfile?.locale || null },
        );
      }
      const history = await client.query(
        `SELECT * FROM ${table}
         WHERE username = $1 AND catalog_id = $2 AND catalog_revision = $3
         ORDER BY assigned_at, id`,
        [username, catalogId, catalogRevision],
      );
      const selection = selectSpeakingTrainingAssignment(tasks, history.rows, now, {
        ...effectiveAssignment,
      });
      const session = createSession({
        username, catalogId, catalogRevision, selection, accentProfile: effectiveAccentProfile,
        calibrationSetupId: effectiveCalibrationSetupId, now,
      });
      const commonValues = [
        session.id, username, catalogId, catalogRevision, session.task_id, session.task_revision,
        session.selection_reason, session.accent_locale, session.accent_profile_revision,
        session.accent_effective_at,
        session.targeted_practice ? JSON.stringify(session.targeted_practice) : null,
      ];
      const inserted = kind === 'task1'
        ? await client.query(
          `INSERT INTO ${table}
           (id, username, catalog_id, catalog_revision, task_id, task_revision, selection_reason,
            accent_locale, accent_profile_revision, accent_effective_at, targeted_practice, calibration_setup_id,
            status, assigned_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, 'assigned', $13)
           RETURNING *`,
          [...commonValues, session.calibration_setup_id, session.assigned_at],
        )
        : await client.query(
          `INSERT INTO ${table}
           (id, username, catalog_id, catalog_revision, task_id, task_revision, selection_reason,
            accent_locale, accent_profile_revision, accent_effective_at, targeted_practice, status, assigned_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'assigned', $12)
           RETURNING *`,
          [...commonValues, session.assigned_at],
        );
      await client.query('COMMIT');
      return inserted.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function getSpeakingCatalogSession(kind, username, id) {
    const table = speakingSessionTable(kind);
    if (!table) throw new Error('SPEAKING_SESSION_KIND_INVALID');
    const result = await pool.query(
      `SELECT * FROM ${table} WHERE username = $1 AND id = $2`,
      [username, id],
    );
    return result.rows[0] || null;
  }

  async function markSpeakingSessionAssisted(username, taskType, id, { now = new Date() } = {}) {
    const kind = `task${Number(taskType)}`;
    const table = speakingSessionTable(kind);
    if (!table) throw new Error('SPEAKING_SESSION_KIND_INVALID');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const changedAt = new Date(now);
      if (!Number.isFinite(changedAt.getTime())) throw new Error('SPEAKING_ASSISTANCE_TIME_INVALID');
      const owner = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const locked = await client.query(
        `SELECT id FROM ${table} WHERE username = $1 AND id = $2 FOR UPDATE`, [username, id],
      );
      if (!locked.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }
      const result = await client.query(
        `UPDATE ${table} SET assistance_used = TRUE WHERE username = $1 AND id = $2 RETURNING *`,
        [username, id],
      );
      await client.query(
        `UPDATE speaking_attempts
         SET assistance_used = TRUE, assistance_updated_at = COALESCE(assistance_updated_at, $3)
         WHERE username = $1 AND source_session_id = $2 AND assistance_used = FALSE`,
        [username, id, changedAt],
      );
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const assignSpeakingTask1Session = (username, options) => assignSpeakingCatalogSession(
    'task1', newSpeakingTask1Session, username, options,
  );

  const getSpeakingTask1Session = (username, id) => getSpeakingCatalogSession('task1', username, id);

  async function completeSpeakingTask1Session(username, id, completion, { now = new Date() } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT * FROM speaking_task1_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, id],
      );
      if (!existing.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      if (existing.rows[0].status === 'completed') {
        await client.query('COMMIT');
        return existing.rows[0];
      }
      const metadata = speakingTask1CompletionMetadata(completion, now);
      const updated = await client.query(
        `UPDATE speaking_task1_sessions
         SET status = 'completed', recording_duration_seconds = $3, mic_check = $4,
             local_playback = $5, self_rating = $6, completed_at = $7, due_at = $8
         WHERE username = $1 AND id = $2
         RETURNING *`,
        [username, id, metadata.recording_duration_seconds, metadata.mic_check,
          metadata.local_playback, metadata.self_rating, metadata.completed_at, metadata.due_at],
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const assignSpeakingTask2Session = (username, options) => assignSpeakingCatalogSession(
    'task2', newSpeakingTask2Session, username, options,
  );

  const getSpeakingTask2Session = (username, id) => getSpeakingCatalogSession('task2', username, id);

  async function completeSequentialSpeakingPosition({
    kind, collectionColumn, applyCompletion, username, id, positionNumber, completion, now,
  }) {
    const table = speakingSessionTable(kind);
    if (!table || !['questions', 'answers'].includes(collectionColumn)) {
      throw new Error('SPEAKING_SESSION_KIND_INVALID');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT * FROM ${table} WHERE username = $1 AND id = $2 FOR UPDATE`,
        [username, id],
      );
      if (!existing.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const session = applyCompletion(existing.rows[0], positionNumber, completion, now);
      const updated = await client.query(
        `UPDATE ${table}
         SET status = $3, current_question = $4, ${collectionColumn} = $5,
             self_rating = $6, completed_at = $7, due_at = $8
         WHERE username = $1 AND id = $2
         RETURNING *`,
        [username, id, session.status, session.current_question, JSON.stringify(session[collectionColumn]),
          session.self_rating, session.completed_at, session.due_at],
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function completeSpeakingTask2Question(username, id, questionNumber, completion, { now = new Date() } = {}) {
    return completeSequentialSpeakingPosition({
      kind: 'task2', collectionColumn: 'questions', applyCompletion: applySpeakingTask2QuestionCompletion,
      username, id, positionNumber: questionNumber, completion, now,
    });
  }

  const assignSpeakingTask3Session = (username, options) => assignSpeakingCatalogSession(
    'task3', newSpeakingTask3Session, username, options,
  );

  const getSpeakingTask3Session = (username, id) => getSpeakingCatalogSession('task3', username, id);

  async function completeSpeakingTask3Answer(username, id, questionNumber, completion, { now = new Date() } = {}) {
    return completeSequentialSpeakingPosition({
      kind: 'task3', collectionColumn: 'answers', applyCompletion: applySpeakingTask3AnswerCompletion,
      username, id, positionNumber: questionNumber, completion, now,
    });
  }

  const assignSpeakingTask4Session = (username, options) => assignSpeakingCatalogSession(
    'task4', newSpeakingTask4Session, username, options,
  );

  const getSpeakingTask4Session = (username, id) => getSpeakingCatalogSession('task4', username, id);

  async function completeSpeakingTask4Session(username, id, completion, { now = new Date() } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT * FROM speaking_task4_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, id],
      );
      if (!existing.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      if (existing.rows[0].status === 'completed') {
        await client.query('COMMIT');
        return existing.rows[0];
      }
      const metadata = speakingTask4CompletionMetadata(completion, now);
      const updated = await client.query(
        `UPDATE speaking_task4_sessions
         SET status = 'completed', recording_duration_seconds = $3, mic_check = $4,
             local_playback = $5, self_rating = $6, completed_at = $7, due_at = $8
         WHERE username = $1 AND id = $2
         RETURNING *`,
        [username, id, metadata.recording_duration_seconds, metadata.mic_check,
          metadata.local_playback, metadata.self_rating, metadata.completed_at, metadata.due_at],
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function assignFullSpeakingSession(username, { catalogs, accentProfile = null, now = new Date() }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const canonicalProfile = await client.query(
        'SELECT * FROM speaking_accent_profiles WHERE username = $1',
        [username],
      );
      const effectiveAccentProfile = canonicalProfile.rowCount
        ? publicSpeakingAccentProfile(canonicalProfile.rows[0])
        : accentProfile;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`speaking-full:${username}`]);
      const active = await client.query(
        `SELECT * FROM speaking_full_sessions
         WHERE username = $1 AND status = 'in_progress' AND catalog_id = $2 AND catalog_revision = $3
         ORDER BY assigned_at DESC LIMIT 1`,
        [username, catalogs[0]?.id, catalogs[0]?.revision],
      );
      if (active.rowCount) {
        try {
          assertFullSpeakingSessionCompatibility(active.rows[0], catalogs);
          await client.query('COMMIT');
          return active.rows[0];
        } catch (error) {
          if (error?.code !== 'SPEAKING_FULL_CATALOG_REVISION_MISMATCH') throw error;
          const abandoned = abandonFullSpeakingSession(active.rows[0]);
          await client.query(
            `UPDATE speaking_full_sessions
             SET status = $3, phase = $4, stage_started_at = NULL, stage_deadline_at = NULL
             WHERE username = $1 AND id = $2`,
            [username, abandoned.id, abandoned.status, abandoned.phase],
          );
        }
      }
      const history = await client.query(
        `SELECT * FROM speaking_full_sessions
         WHERE username = $1 AND catalog_id = $2 AND catalog_revision = $3
         ORDER BY assigned_at, id`,
        [username, catalogs[0]?.id, catalogs[0]?.revision],
      );
      const selection = selectFullSpeakingVariant(catalogs, history.rows);
      const session = createFullSpeakingSession({
        username, catalogs, variantIndex: selection.variantIndex,
        selectionReason: selection.reason, accentProfile: effectiveAccentProfile, now,
      });
      const inserted = await client.query(
        `INSERT INTO speaking_full_sessions
         (id, username, mode, format_id, format_revision, catalog_id, catalog_revision,
          variant_index, selection_reason, maximum_score, assignments, responses, status, phase,
          current_task, current_response, accent_locale, accent_profile_revision,
          accent_effective_at, assigned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
                 $13, $14, $15, $16, $17, $18, $19, $20)
         RETURNING *`,
        [session.id, username, session.mode, session.format_id, session.format_revision,
          session.catalog_id, session.catalog_revision, session.variant_index, session.selection_reason,
          session.maximum_score, JSON.stringify(session.assignments), JSON.stringify(session.responses),
          session.status, session.phase, session.current_task, session.current_response,
          session.accent_locale, session.accent_profile_revision, session.accent_effective_at,
          session.assigned_at],
      );
      await client.query('COMMIT');
      return inserted.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function getFullSpeakingSession(username, id) {
    const result = await pool.query(
      `SELECT * FROM speaking_full_sessions
       WHERE username = $1 AND id = $2 AND status <> 'abandoned'`,
      [username, id],
    );
    return result.rows[0] || null;
  }

  async function mutateFullSpeakingSession(username, id, mutate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT * FROM speaking_full_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, id],
      );
      if (!existing.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      const session = existing.rows[0];
      const value = await mutate(session, client);
      const updated = await client.query(
        `UPDATE speaking_full_sessions
         SET responses = $3::jsonb, status = $4, phase = $5, current_task = $6,
             current_response = $7, stage_started_at = $8, stage_deadline_at = $9,
             submitted_at = $10, submission_key = $11, submission_response = $12::jsonb
         WHERE username = $1 AND id = $2
         RETURNING *`,
        [username, id, JSON.stringify(session.responses), session.status, session.phase,
          session.current_task, session.current_response, session.stage_started_at,
          session.stage_deadline_at, session.submitted_at, session.submission_key,
          session.submission_response ? JSON.stringify(session.submission_response) : null],
      );
      await client.query('COMMIT');
      return { session: updated.rows[0], value };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function advanceFullSpeakingSessionStage(username, id, { now = new Date() } = {}) {
    const mutation = await mutateFullSpeakingSession(
      username, id, (session) => advanceFullSpeakingStage(session, now),
    );
    return mutation?.session || null;
  }

  async function completeFullSpeakingSessionResponse(username, id, completion, { now = new Date() } = {}) {
    const mutation = await mutateFullSpeakingSession(username, id, (session) => {
      if (Number(session.current_task) !== Number(completion.taskType)
        || Number(session.current_response) !== Number(completion.responseNumber)) {
        throw Object.assign(new Error('SPEAKING_FULL_RESPONSE_OUT_OF_SEQUENCE'), {
          code: 'SPEAKING_FULL_RESPONSE_OUT_OF_SEQUENCE',
        });
      }
      return completeFullSpeakingResponse(session, completion, now);
    });
    return mutation?.session || null;
  }

  async function claimFullSpeakingSessionAssessment(username, id, binding) {
    const mutation = await mutateFullSpeakingSession(
      username, id, (session) => claimFullSpeakingResponseAssessment(session, binding),
    );
    return mutation?.session || null;
  }

  async function submitFullSpeakingSessionResult(username, id, idempotencyKey, { now = new Date() } = {}) {
    const mutation = await mutateFullSpeakingSession(
      username, id, (session) => submitFullSpeakingSession(session, idempotencyKey, now),
    );
    return mutation ? { session: mutation.session, result: mutation.value } : null;
  }

  async function completeFullSpeakingSessionEvaluation(
    username, id, attemptIds, { now = new Date() } = {},
  ) {
    const requestedIds = Array.isArray(attemptIds) ? attemptIds.map(Number) : [];
    const mutation = await mutateFullSpeakingSession(username, id, async (session, client) => {
      const attempts = requestedIds.length ? await client.query(
        `SELECT * FROM speaking_attempts
         WHERE username = $1 AND id = ANY($2::bigint[]) ORDER BY array_position($2::bigint[], id)`,
        [username, requestedIds],
      ) : { rows: [] };
      if (attempts.rows.length !== requestedIds.length) {
        throw Object.assign(new Error('SPEAKING_FULL_EVALUATION_INVALID'), {
          code: 'SPEAKING_FULL_EVALUATION_INVALID',
        });
      }
      return applyFullSpeakingEvaluation(session, attempts.rows, now);
    });
    return mutation ? { session: mutation.session, result: mutation.value } : null;
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

  async function deleteGeneratedTask(username, requestHash) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const result = await client.query(
        'DELETE FROM generated_tasks WHERE username = $1 AND request_hash = $2',
        [username, requestHash],
      );
      await client.query('COMMIT');
      return result.rowCount > 0;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
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

  async function readAdaptiveLearningEvidenceSources(queryable, username, { notify = false } = {}) {
    const result = await queryable.query(
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
           ) source_attempt
         ), '[]'::jsonb) AS attempts,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(source_speaking)
             ORDER BY COALESCE(source_speaking.evaluated_at, source_speaking.created_at) DESC,
                      source_speaking.id DESC)
           FROM (
             SELECT id, task_type, review, status, source_session_id, source_task_ref,
                    source_task_revision, source_catalog_id, source_catalog_revision, assistance_used,
                    assistance_updated_at, accent_locale, targeted_practice, created_at, evaluated_at
             FROM speaking_attempts
             WHERE username = $1 AND status IN ('completed', 'needs_retry')
             ORDER BY COALESCE(evaluated_at, created_at) DESC, id DESC
             LIMIT $2
           ) source_speaking
         ), '[]'::jsonb) AS speaking_attempts,
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
      [username, SPEAKING_ADAPTIVE_EVIDENCE_ATTEMPT_LIMIT],
    );
    const sources = {
      attempts: [
        ...result.rows[0].attempts,
        ...speakingAdaptiveEvidenceAttempts(
          result.rows[0].speaking_attempts.map(buildSpeakingLearningAttempt).filter(Boolean),
        ),
      ],
      recoveries: result.rows[0].recoveries,
      repeatAttempts: result.rows[0].repeat_attempts,
      diagnosticResponses: result.rows[0].diagnostic_responses,
      diagnosticCompletions: result.rows[0].diagnostic_completions,
    };
    if (notify) await onAdaptiveEvidenceSnapshot({ username, sources });
    return sources;
  }

  async function getAdaptiveLearningEvidenceSources(username) {
    return readAdaptiveLearningEvidenceSources(pool, username, { notify: true });
  }

  async function saveAdaptiveLearningProfile(username, profile, {
    now = new Date(), verifyCurrentEvidence = false, diagnosticRegistry,
  } = {}) {
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query('BEGIN');
      inTransaction = true;
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      if (verifyCurrentEvidence) {
        const currentSources = await readAdaptiveLearningEvidenceSources(client, username);
        if (!adaptiveProfileMatchesCurrentEvidence(profile, currentSources, { diagnosticRegistry })) {
          throw new Error('ADAPTIVE_PROFILE_EVIDENCE_STALE');
        }
      }
      const persisted = await client.query(
        `SELECT profile_calculation_revision, evidence_watermark_version,
                evidence_observed_at, evidence_source_count, evidence_fingerprint
         FROM adaptive_learning_profiles WHERE username = $1`,
        [username],
      );
      if (persisted.rowCount) {
        if (adaptiveEvidenceFingerprintConflict(profile, persisted.rows[0])) {
          const currentSources = await readAdaptiveLearningEvidenceSources(client, username);
          if (!adaptiveProfileMatchesCurrentEvidence(profile, currentSources, { diagnosticRegistry })) {
            const currentSnapshot = await readAdaptiveLearningProfile(client, username, { onAdaptiveProfileSnapshot });
            await client.query('COMMIT');
            inTransaction = false;
            return currentSnapshot;
          }
        }
        const evidenceOrder = compareAdaptiveEvidenceWatermarks(profile, persisted.rows[0]);
        if (evidenceOrder <= 0) {
          const currentSnapshot = await readAdaptiveLearningProfile(client, username, { onAdaptiveProfileSnapshot });
          if (evidenceOrder < 0 || !isMonotonicAdaptiveRetentionRefresh(
            profile, currentSnapshot, currentSnapshot.estimates,
          )) {
            await client.query('COMMIT');
            inTransaction = false;
            return currentSnapshot;
          }
        }
      }
      await client.query(
        `INSERT INTO adaptive_learning_profiles
         (username, taxonomy_version, weighting_version, status, preliminary, confidence, evidence_count,
          independent_evidence_count, assisted_evidence_count, client_reported_evidence_count,
          independent_module_count, established_skill_count, profile_calculation_revision,
          evidence_watermark_version, evidence_observed_at, evidence_source_count, evidence_fingerprint,
          needs_diagnostic, explanation_codes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20)
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
           evidence_fingerprint = EXCLUDED.evidence_fingerprint,
           needs_diagnostic = EXCLUDED.needs_diagnostic,
           explanation_codes = EXCLUDED.explanation_codes,
           updated_at = EXCLUDED.updated_at`,
        [username, profile.taxonomyVersion, profile.weightingVersion, profile.status, profile.preliminary,
          profile.confidence, profile.evidenceCount, profile.independentEvidenceCount,
          profile.assistedEvidenceCount, profile.clientReportedEvidenceCount, profile.independentModuleCount,
          profile.establishedSkillCount, profile.profileCalculationRevision, profile.evidenceWatermarkVersion,
          profile.evidenceObservedAt, profile.evidenceSourceCount, profile.evidenceFingerprint,
          profile.needsDiagnostic, JSON.stringify(profile.explanationCodes), now],
      );
      await client.query('DELETE FROM adaptive_learning_skill_estimates WHERE username = $1', [username]);
      for (const skill of profile.skills) {
        await client.query(
          `INSERT INTO adaptive_learning_skill_estimates
           (username, taxonomy_version, skill_id, module, mastery, uncertainty, evidence_count,
            effective_evidence_count, independent_evidence_count, evidence_quality, status,
            last_observed_at, due_state, critical_retention_expires_at, explanation_code, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [username, profile.taxonomyVersion, skill.id, skill.module, skill.mastery, skill.uncertainty,
            skill.evidenceCount, skill.effectiveEvidenceCount, skill.independentEvidenceCount,
            skill.evidenceQuality, skill.status, skill.lastObservedAt, skill.dueState,
            skill.criticalRetentionExpiresAt, skill.explanationCode, now],
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

  async function saveAdaptiveLearningPlan(username, candidate, { diagnosticRegistry } = {}) {
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
      const authoritativeProfile = await readAdaptiveLearningProfile(client, username);
      const currentSources = await readAdaptiveLearningEvidenceSources(client, username);
      if (!adaptiveProfileMatchesCurrentEvidence(authoritativeProfile, currentSources, { diagnosticRegistry })
        || !adaptiveProfileMatchesCurrentEvidence(candidate, currentSources, { diagnosticRegistry })) {
        throw new Error('ADAPTIVE_PLAN_EVIDENCE_STALE');
      }
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
          profile_evidence_observed_at, profile_evidence_source_count, profile_evidence_fingerprint,
          recalculation_bucket, input_fingerprint, forecast, allocation, stability, current,
          created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::date, $15,
                 $16::jsonb, $17::jsonb, $18::jsonb, TRUE, $19, $19)
         RETURNING *`,
        [candidate.id, username, candidate.plan.version, revisionResult.rows[0].revision,
          basePlanRevision, candidate.goalId, candidate.goalRevision, candidate.taxonomyVersion,
          candidate.profileCalculationRevision, candidate.profileEvidenceWatermarkVersion,
          candidate.profileEvidenceObservedAt, candidate.profileEvidenceSourceCount,
          candidate.profileEvidenceFingerprint, candidate.recalculationBucket, candidate.inputFingerprint,
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
      if (candidate.commercialMode === 'free_demo') {
        const used = await client.query(
          'SELECT 1 FROM adaptive_learning_sessions WHERE username = $1 LIMIT 1',
          [username],
        );
        if (used.rowCount) throw new Error('ADAPTIVE_FREE_DEMO_USED');
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
           created_at, updated_at, commercial_scope)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15::jsonb, $16::jsonb, $17, $18, $19, $20::jsonb, $21, $22,
                  $23::jsonb, $24, $25, $26)
         RETURNING *`,
        [session.id, username, session.session_version, session.revision, session.plan_id,
          session.plan_revision, session.preview_fingerprint, session.composer_policy_version,
          session.content_registry_version, session.taxonomy_version, session.week_start,
          session.duration_minutes, session.learning_minutes, session.break_minutes,
          JSON.stringify(session.weekly_budget_snapshot), JSON.stringify(session.blocks), session.status,
          session.current_block_id, session.completed_learning_minutes,
          session.replacement == null ? null : JSON.stringify(session.replacement),
          candidate.idempotencyKey, candidate.requestHash, JSON.stringify(candidate.session),
          session.created_at, session.updated_at, candidate.commercialScope || 'base'],
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

  async function getAdaptiveLearningSessionCommercialScope(username, sessionId) {
    const result = await pool.query(
      'SELECT commercial_scope FROM adaptive_learning_sessions WHERE username = $1 AND id = $2',
      [username, sessionId],
    );
    return result.rows[0]?.commercial_scope || null;
  }

  async function getAdaptiveLearningSessionReplacementReplay(username, sessionId, candidate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const replay = await client.query(
        `SELECT * FROM adaptive_learning_sessions
         WHERE username = $1 AND replacement_idempotency_key = $2 FOR UPDATE`,
        [username, candidate.idempotencyKey],
      );
      if (replay.rowCount && (replay.rows[0].id !== sessionId
        || replay.rows[0].replacement_request_hash !== candidate.requestHash)) {
        throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
      }
      const target = replay.rowCount ? replay : await client.query(
        'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, sessionId],
      );
      if (!target.rowCount) {
        await client.query('COMMIT');
        return null;
      }
      await assertAdaptiveSessionReplacementOpen(client, username, target.rows[0]);
      await client.query('COMMIT');
      return replay.rowCount
        ? adaptiveLearningSessionPublicDto(replay.rows[0].replacement_response_snapshot)
        : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function assertAdaptiveSessionReplacementOpen(queryable, username, row) {
    const state = await queryable.query(
      `SELECT
         EXISTS (SELECT 1 FROM adaptive_learning_execution_claims
                 WHERE username = $1 AND session_id = $2) AS has_claim,
         EXISTS (SELECT 1 FROM adaptive_learning_session_events
                 WHERE username = $1 AND session_id = $2) AS has_event`,
      [username, row.id],
    );
    if (row.status !== 'created' || row.started_at != null
      || Number(row.execution_revision || 0) > 0
      || state.rows[0]?.has_claim || state.rows[0]?.has_event) {
      throw new Error('ADAPTIVE_SESSION_REPLACEMENT_LOCKED');
    }
  }

  async function replaceAdaptiveLearningSessionBlock(username, candidate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const replay = await client.query(
        `SELECT *
         FROM adaptive_learning_sessions
         WHERE username = $1 AND replacement_idempotency_key = $2 FOR UPDATE`,
        [username, candidate.idempotencyKey],
      );
      if (replay.rowCount) {
        if (replay.rows[0].id !== candidate.sessionId
          || replay.rows[0].replacement_request_hash !== candidate.requestHash) {
          throw new Error('ADAPTIVE_SESSION_IDEMPOTENCY_CONFLICT');
        }
        await assertAdaptiveSessionReplacementOpen(client, username, replay.rows[0]);
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
      await assertAdaptiveSessionReplacementOpen(client, username, row);
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

  async function requireAdaptivePremiumDepthEntitlement(queryable, username, block) {
    if (!adaptiveActivityRequiresPremiumDepth(block)) return;
    const entitled = await queryable.query(
      `WITH effective_time AS (SELECT clock_timestamp() AS now)
       SELECT EXISTS (
         SELECT 1 FROM subscription_entitlements entitlement
         JOIN users owner ON owner.username = entitlement.username
         CROSS JOIN effective_time
         WHERE entitlement.username = $1 AND entitlement.entitlement = 'voice_tutor'
           AND owner.subscription_until > effective_time.now
           AND entitlement.starts_at <= effective_time.now
           AND (entitlement.ends_at IS NULL OR entitlement.ends_at > effective_time.now)
       ) AS entitled`,
      [username],
    );
    if (!entitled.rows[0]?.entitled) throw new Error('ADAPTIVE_PREMIUM_REQUIRED');
  }

  function assertAdaptiveStartSnapshotMatchesLockedSession(row, block, snapshot) {
    const lockedSession = adaptiveLearningSessionPublicDto(row);
    if (Number(snapshot?.session?.revision) !== Number(lockedSession.revision)) {
      throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
    }
    if (snapshot.session.id !== lockedSession.id
      || snapshot.session.previewFingerprint !== lockedSession.previewFingerprint
      || JSON.stringify(snapshot.session.replacement ?? null) !== JSON.stringify(lockedSession.replacement ?? null)
      || adaptiveLaunchFingerprint(snapshot.block || {}) !== adaptiveLaunchFingerprint(block)
      || JSON.stringify(snapshot.launch) !== JSON.stringify(block.launch)) {
      throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
    }
  }

  async function adaptiveSessionEvents(queryable, username, sessionId) {
    const result = await queryable.query(
      `SELECT * FROM adaptive_learning_session_events
       WHERE username = $1 AND session_id = $2 ORDER BY sequence`,
      [username, sessionId],
    );
    return result.rows;
  }

  async function adaptiveRepeatableRead(read) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const value = await read(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function getAdaptiveLearningSessionMutationReplay(username, candidate) {
    if (!candidate.blockId) return adaptiveMutationReplay(pool, username, candidate);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const session = await client.query(
        'SELECT blocks FROM adaptive_learning_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, candidate.sessionId],
      );
      if (!session.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const block = session.rows[0].blocks.find((item) => item.id === candidate.blockId);
      await requireAdaptivePremiumDepthEntitlement(client, username, block);
      const replay = await adaptiveMutationReplay(client, username, candidate, true);
      await client.query('COMMIT');
      return replay;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function startAdaptiveLearningSessionBlock(username, candidate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const existing = await client.query(
        'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, candidate.sessionId],
      );
      if (!existing.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const row = existing.rows[0];
      const block = row.blocks.find((item) => item.id === candidate.blockId);
      const effectiveNow = new Date((await client.query(
        'SELECT clock_timestamp() AS now',
      )).rows[0].now);
      await requireAdaptivePremiumDepthEntitlement(client, username, block);
      const replay = await adaptiveMutationReplay(client, username, { ...candidate, operation: 'start' }, true);
      if (replay) {
        const replayClaim = replay.executionClaimId ? await client.query(
          `SELECT expires_at FROM adaptive_learning_execution_claims
           WHERE id = $1 AND username = $2`,
          [replay.executionClaimId, username],
        ) : null;
        if (replayClaim?.rowCount
          && new Date(replayClaim.rows[0].expires_at) <= effectiveNow) {
          throw new Error('ADAPTIVE_EXECUTION_CLAIM_EXPIRED');
        }
        await client.query('COMMIT');
        return { created: false, replayed: true, responseSnapshot: replay };
      }
      if (!['created', 'in_progress'].includes(row.status)) throw new Error('ADAPTIVE_SESSION_STATE_CONFLICT');
      if (Number(row.execution_revision) !== Number(candidate.expectedRevision)) {
        throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
      }
      if (row.current_block_id !== candidate.blockId) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
      if (!block || block.kind !== 'learning') throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_LAUNCHABLE');
      assertAdaptiveStartSnapshotMatchesLockedSession(row, block, candidate.responseSnapshot);
      const active = await client.query(
        `SELECT id, expires_at, consumed_at, revoked_at, attempt_type, attempt_ref
         FROM adaptive_learning_execution_claims
         WHERE username = $1 AND session_id = $2 AND block_id = $3 AND revoked_at IS NULL FOR UPDATE`,
        [username, row.id, block.id],
      );
      const consumedClaims = active.rows.filter((claim) => claim.consumed_at);
      if (consumedClaims.length > 1
        || active.rows.some((claim) => !claim.consumed_at
          && new Date(claim.expires_at) > effectiveNow)) {
        throw new Error('ADAPTIVE_SESSION_BLOCK_ALREADY_STARTED');
      }
      if (consumedClaims.length === 1) {
        const recoveryAttempt = adaptiveConsumedClaimAttempt(consumedClaims[0]);
        if (!recoveryAttempt
          || candidate.recoveryResponseSnapshot?.execution?.revision !== Number(row.execution_revision)
          || candidate.recoveryResponseSnapshot?.block?.id !== block.id
          || 'executionClaim' in (candidate.recoveryResponseSnapshot || {})
          || 'executionClaimId' in (candidate.recoveryResponseSnapshot || {})) {
          throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
        }
        const recoverySnapshot = {
          ...structuredClone(candidate.recoveryResponseSnapshot), recoveryAttempt,
        };
        await client.query(
          `INSERT INTO adaptive_learning_session_mutations
           (username, idempotency_key, operation, session_id, request_hash, response_snapshot, created_at)
           VALUES ($1, $2, 'start', $3, $4, $5::jsonb, $6)`,
          [username, candidate.idempotencyKey, row.id, candidate.requestHash,
            JSON.stringify(recoverySnapshot), effectiveNow],
        );
        await client.query('COMMIT');
        return {
          created: false, replayed: false, recovered: true,
          responseSnapshot: recoverySnapshot,
        };
      }
      await client.query(
        `UPDATE adaptive_learning_execution_claims SET revoked_at = $3
         WHERE username = $1 AND session_id = $2 AND consumed_at IS NULL AND revoked_at IS NULL`,
        [username, row.id, effectiveNow],
      );
      const nextRevision = Number(row.execution_revision) + 1;
      const claimIssuedAt = new Date((await client.query(
        'SELECT clock_timestamp() AS now',
      )).rows[0].now);
      const expiresAt = new Date(claimIssuedAt.getTime() + ADAPTIVE_EXECUTION_CLAIM_TTL_MS);
      const responseSnapshot = {
        ...structuredClone(candidate.responseSnapshot),
        session: {
          ...structuredClone(candidate.responseSnapshot?.session),
          status: 'in_progress',
          updatedAt: claimIssuedAt.toISOString(),
        },
        execution: {
          ...structuredClone(candidate.responseSnapshot?.execution),
          startedAt: row.started_at
            ? new Date(row.started_at).toISOString() : claimIssuedAt.toISOString(),
        },
        claimExpiresAt: expiresAt.toISOString(),
      };
      if (candidate.responseSnapshot?.execution?.revision !== nextRevision
        || candidate.responseSnapshot?.block?.id !== block.id
        || candidate.responseSnapshot?.executionClaimId !== candidate.claimId
        || JSON.stringify(candidate.responseSnapshot).includes(candidate.token)
        || adaptiveExecutionTokenHash(candidate.token) !== candidate.tokenHash) {
        throw new Error('ADAPTIVE_SESSION_EXECUTION_SNAPSHOT_INVALID');
      }
      await client.query(
        `INSERT INTO adaptive_learning_execution_claims
          (id, username, session_id, block_id, session_execution_revision, token_hash,
           launch_fingerprint, evidence_context, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [candidate.claimId, username, row.id, block.id, nextRevision, candidate.tokenHash,
          adaptiveLaunchFingerprint(block), candidate.evidenceContext, claimIssuedAt, expiresAt],
      );
      await client.query(
        `UPDATE adaptive_learning_sessions
         SET execution_revision = $3, status = 'in_progress', started_at = COALESCE(started_at, $4), updated_at = $4
         WHERE username = $1 AND id = $2`,
        [username, row.id, nextRevision, claimIssuedAt],
      );
      await client.query(
        `INSERT INTO adaptive_learning_session_mutations
         (username, idempotency_key, operation, session_id, request_hash, response_snapshot, created_at)
         VALUES ($1, $2, 'start', $3, $4, $5::jsonb, $6)`,
        [username, candidate.idempotencyKey, row.id, candidate.requestHash,
          JSON.stringify(responseSnapshot), claimIssuedAt],
      );
      await client.query('COMMIT');
      return { created: true, replayed: false, responseSnapshot: structuredClone(responseSnapshot) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function getAdaptiveLearningSessionExecution(username, sessionId) {
    return adaptiveRepeatableRead(async (client) => {
      const result = await client.query(
        'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2',
        [username, sessionId],
      );
      if (!result.rowCount) return null;
      await onAdaptiveSessionSnapshot({
        operation: 'current', username, sessionId, session: result.rows[0],
      });
      const events = await adaptiveSessionEvents(client, username, sessionId);
      return {
        session: adaptiveLearningSessionPublicDto(result.rows[0]),
        execution: adaptiveExecutionView(result.rows[0], events),
        events: events.map(adaptiveExecutionEventExportDto),
        summary: result.rows[0].completion_summary || null,
      };
    });
  }

  async function adaptiveSpeakingSourceMatches(queryable, username, block, source, claimIssuedAt, {
    lockSession = false,
  } = {}) {
    const descriptor = adaptiveSpeakingTask(block?.contentRef);
    const taskType = Number(source?.task_type);
    if (!descriptor || descriptor.taskNumber !== taskType
      || !Number.isInteger(taskType) || taskType < 1 || taskType > 4
      || descriptor.skillId !== block.skillId || block.module !== 'speaking'
      || !adaptiveSpeakingActivityMatchesTask(block.activityId, taskType)) return false;
    const session = await queryable.query(
      `SELECT id, username, catalog_id, catalog_revision, task_id, task_revision,
              assistance_used, assigned_at
       FROM speaking_task${taskType}_sessions WHERE username = $1 AND id = $2${lockSession ? ' FOR UPDATE' : ''}`,
      [username, source.source_session_id],
    );
    const taskSession = session.rows[0];
    const evidence = buildSpeakingLearningAttempt(source);
    return Boolean(taskSession
      && taskSession.task_id === source.source_task_ref
      && Number(taskSession.task_revision) === Number(source.source_task_revision)
      && taskSession.catalog_id === source.source_catalog_id
      && Number(taskSession.catalog_revision) === Number(source.source_catalog_revision)
      && taskSession.assistance_used === false
      && source.assistance_used === false
      && new Date(taskSession.assigned_at) >= new Date(claimIssuedAt)
      && new Date(source.created_at) >= new Date(claimIssuedAt)
      && speakingAdaptiveEvidenceMatchesTarget(evidence, {
        skillId: block.skillId,
        focusRef: descriptor.focusRef,
      }));
  }

  async function adaptiveAdvanceSource(queryable, username, row, block, attempt, authorityNow = null) {
    if (block.kind === 'break') {
      if (attempt != null) throw new Error('ADAPTIVE_SESSION_BREAK_ATTEMPT_FORBIDDEN');
      return {
        source_type: null, source_ref: null, evidence_quality: null, evidence_context: null,
        actual_minutes: null,
      };
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
    if (authorityNow && new Date(claim.expires_at) <= new Date(authorityNow)) {
      throw new Error('ADAPTIVE_EXECUTION_CLAIM_EXPIRED');
    }
    if (claim.launch_fingerprint !== adaptiveLaunchFingerprint(block)
      || Number(claim.session_execution_revision) !== Number(row.execution_revision)) {
      throw new Error('ADAPTIVE_SESSION_ATTEMPT_MISMATCH');
    }
    if (attempt.type === 'voice_tutor_repeat') {
      const source = await queryable.query(
        `SELECT attempt.id, attempt.repeat_id, attempt.task_id, attempt.observed_at,
                repeat.task_id AS repeat_task_id, repeat.stage AS repeat_stage,
                repeat.due_at AS repeat_due_at, repeat.window_ends_at AS repeat_window_ends_at,
                repeat.recovery_id, recovery.username AS recovery_username,
                recovery.skill_id, recovery.module
         FROM voice_tutor_repeat_attempts attempt
         JOIN voice_tutor_repeats repeat ON repeat.id = attempt.repeat_id
         JOIN voice_tutor_recoveries recovery ON recovery.id = repeat.recovery_id
         WHERE attempt.id = $1 AND recovery.username = $2 AND attempt.task_id = repeat.task_id`,
        [attempt.id, username],
      );
      const sourceRow = source.rows[0];
      if (!sourceRow || !adaptiveRepeatExecutionMatches({
        username,
        block,
        attempt: sourceRow,
        repeat: {
          id: sourceRow.repeat_id,
          task_id: sourceRow.repeat_task_id,
          stage: sourceRow.repeat_stage,
          due_at: sourceRow.repeat_due_at,
          window_ends_at: sourceRow.repeat_window_ends_at,
          recovery_id: sourceRow.recovery_id,
        },
        recovery: {
          id: sourceRow.recovery_id,
          username: sourceRow.recovery_username,
          skill_id: sourceRow.skill_id,
          module: sourceRow.module,
        },
        claimIssuedAt: claim.issued_at,
      })) {
        throw new Error('ADAPTIVE_SESSION_ATTEMPT_MISMATCH');
      }
      return {
        source_type: 'voice_tutor_repeat', source_ref: String(sourceRow.id),
        evidence_quality: 'server_verified_unassisted', evidence_context: claim.evidence_context,
        actual_minutes: null,
      };
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
        evidence_context: claim.evidence_context,
        actual_minutes: source.rows[0].duration_ms == null
          ? null : Math.max(0, Math.round(Number(source.rows[0].duration_ms) / 60_000)),
      };
    }
    const table = attempt.type === 'writing' ? 'writing_attempts' : 'speaking_attempts';
    const exactTaskColumns = attempt.type === 'writing'
      ? 'source_task_ref, NULL::text AS assignment_fingerprint'
      : `source_task_ref, assignment_fingerprint, source_session_id, source_task_revision,
         source_catalog_id, source_catalog_revision, assistance_used, accent_locale, transcript, review, evaluated_at`;
    const source = await queryable.query(
      `SELECT id, task_type, ${exactTaskColumns}, status, created_at
       FROM ${table} WHERE username = $1 AND id = $2`,
      [username, attempt.id],
    );
    const sourceRow = source.rows[0];
    const exactTask = attempt.type === 'writing'
      ? sourceRow?.source_task_ref === block.launch?.taskId
      : await adaptiveSpeakingSourceMatches(queryable, username, block, sourceRow, claim.issued_at);
    if (!source.rowCount || sourceRow.status !== 'completed'
      || new Date(sourceRow.created_at) < new Date(claim.issued_at) || !exactTask) {
      throw new Error('ADAPTIVE_SESSION_ATTEMPT_MISMATCH');
    }
    return {
      source_type: attempt.type, source_ref: String(source.rows[0].id),
      evidence_quality: attempt.type === 'speaking'
        ? 'server_verified_unassisted' : 'server_verified_assisted',
      evidence_context: claim.evidence_context,
      actual_minutes: null,
    };
  }

  async function getAdaptiveLearningSessionAdvanceContext(username, candidate) {
    return adaptiveRepeatableRead(async (client) => {
      const result = await client.query(
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
      await onAdaptiveSessionSnapshot({
        operation: 'advance', username, sessionId: candidate.sessionId, session: row,
      });
      const source = await adaptiveAdvanceSource(client, username, row, block, candidate.attempt);
      const events = await adaptiveSessionEvents(client, username, row.id);
      const nextBlock = row.blocks.find((item) => item.position === block.position + 1) || null;
      return {
        session: adaptiveLearningSessionPublicDto(row), execution: adaptiveExecutionView(row, events),
        block: structuredClone(block), source, nextBlock: nextBlock ? structuredClone(nextBlock) : null,
      };
    });
  }

  async function advanceAdaptiveLearningSession(username, candidate) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      const existing = await client.query(
        'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2 FOR UPDATE',
        [username, candidate.sessionId],
      );
      if (!existing.rowCount) throw new Error('ADAPTIVE_SESSION_NOT_FOUND');
      const row = existing.rows[0];
      const block = row.blocks.find((item) => item.id === candidate.blockId);
      const effectiveNow = new Date((await client.query(
        'SELECT clock_timestamp() AS now',
      )).rows[0].now);
      await requireAdaptivePremiumDepthEntitlement(client, username, block);
      const replay = await adaptiveMutationReplay(client, username, { ...candidate, operation: 'advance' }, true);
      if (replay) {
        await client.query('COMMIT');
        return { advanced: false, replayed: true, responseSnapshot: replay };
      }
      if (Number(row.execution_revision) !== Number(candidate.expectedRevision)) {
        throw new Error('ADAPTIVE_SESSION_REVISION_CONFLICT');
      }
      if (row.current_block_id !== candidate.blockId) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
      if (!block) throw new Error('ADAPTIVE_SESSION_BLOCK_NOT_CURRENT');
      const source = await adaptiveAdvanceSource(
        client, username, row, block, candidate.attempt, effectiveNow,
      );
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
           skill_id, activity_id, source_type, source_ref, evidence_quality, evidence_context,
           planned_minutes, actual_minutes, created_at)
         VALUES ($1, $2, $3, $4, 'block_completed', $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16) RETURNING *`,
        [candidate.eventId, username, row.id, events.length + 1, block.id, block.kind,
          block.module, block.skillId, block.activityId, source.source_type, source.source_ref,
          source.evidence_quality, source.evidence_context, block.plannedMinutes,
          source.actual_minutes, effectiveNow],
      );
      await client.query(
        `UPDATE adaptive_learning_sessions
         SET execution_revision = $3, current_block_id = $4,
             completed_learning_minutes = completed_learning_minutes + $5, updated_at = $6
         WHERE username = $1 AND id = $2`,
        [username, row.id, nextRevision, nextBlock?.id || null,
          block.kind === 'learning' ? block.plannedMinutes : 0, effectiveNow],
      );
      await client.query(
        `INSERT INTO adaptive_learning_session_mutations
         (username, idempotency_key, operation, session_id, request_hash, response_snapshot, created_at)
         VALUES ($1, $2, 'advance', $3, $4, $5::jsonb, $6)`,
        [username, candidate.idempotencyKey, row.id, candidate.requestHash,
          JSON.stringify(candidate.responseSnapshot), effectiveNow],
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
    return adaptiveRepeatableRead(async (client) => {
      const result = await client.query(
        'SELECT * FROM adaptive_learning_sessions WHERE username = $1 AND id = $2',
        [username, candidate.sessionId],
      );
      if (!result.rowCount) return null;
      await onAdaptiveSessionSnapshot({
        operation: 'finish', username, sessionId: candidate.sessionId, session: result.rows[0],
      });
      const events = await adaptiveSessionEvents(client, username, candidate.sessionId);
      return {
        session: adaptiveLearningSessionPublicDto(result.rows[0]),
        execution: adaptiveExecutionView(result.rows[0], events),
        events: events.map(adaptiveExecutionEventExportDto),
      };
    });
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
      const summary = adaptiveExecutionSummary(row, events, candidate.nextRecommendedAction, {
        planRevisionAfter: candidate.planRevisionAfter,
      });
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

  async function getAdaptiveLearningCommercialUsage(username) {
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::integer FROM adaptive_diagnostic_sessions
           WHERE username = $1 AND status = 'completed'
             AND catalog_version IN ('ege-short-diagnostic-v1', 'ege-short-diagnostic-v2')) AS short_diagnostics_completed,
         (SELECT COUNT(*)::integer FROM adaptive_diagnostic_sessions
           WHERE username = $1 AND status = 'completed'
             AND catalog_version IN ('ege-deep-diagnostic-v1', 'ege-deep-diagnostic-v2')) AS deep_diagnostics_completed,
         (SELECT COUNT(*)::integer FROM adaptive_learning_sessions
           WHERE username = $1) AS sessions_created,
         (SELECT COUNT(*)::integer FROM adaptive_learning_sessions
           WHERE username = $1 AND status = 'completed') AS sessions_completed`,
      [username],
    );
    const row = result.rows[0];
    return {
      shortDiagnosticsCompleted: Number(row.short_diagnostics_completed),
      deepDiagnosticsCompleted: Number(row.deep_diagnostics_completed),
      sessionsCreated: Number(row.sessions_created),
      sessionsCompleted: Number(row.sessions_completed),
    };
  }

  async function getAdaptiveLearningCompletedSessionReports(username, { limit = 12 } = {}) {
    return adaptiveRepeatableRead(async (client) => {
      const result = await client.query(
        `SELECT * FROM adaptive_learning_sessions
         WHERE username = $1 AND status = 'completed' AND completion_summary IS NOT NULL
         ORDER BY completed_at DESC LIMIT $2`,
        [username, Math.max(1, Math.min(12, Number(limit) || 12))],
      );
      return result.rows.map((row) => ({
        session: {
          ...adaptiveLearningSessionPublicDto(row),
          completedAt: new Date(row.completed_at).toISOString(),
        },
        summary: structuredClone(row.completion_summary),
      }));
    });
  }

  async function getAdaptiveLearningMetrics({ now = new Date() } = {}) {
    const window = adaptiveMetricsWindow(now);
    const parameters = [new Date(window.from), new Date(window.to)];
    return adaptiveRepeatableRead(async (client) => {
      const sessions = await client.query(
          `SELECT
             COUNT(*)::integer AS created,
             (COUNT(*) FILTER (WHERE started_at IS NOT NULL OR status IN ('in_progress', 'completed', 'abandoned')))::integer AS started,
             (COUNT(*) FILTER (WHERE status = 'completed'))::integer AS completed,
             COALESCE(SUM(learning_minutes), 0)::bigint AS planned_learning_minutes,
             COALESCE(SUM(LEAST(learning_minutes, completed_learning_minutes)), 0)::bigint AS completed_planned_minutes,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 15 AND 30))::integer AS duration_15_30_created,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 15 AND 30 AND (started_at IS NOT NULL OR status IN ('in_progress', 'completed', 'abandoned'))))::integer AS duration_15_30_started,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 15 AND 30 AND status = 'completed'))::integer AS duration_15_30_completed,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 35 AND 60))::integer AS duration_35_60_created,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 35 AND 60 AND (started_at IS NOT NULL OR status IN ('in_progress', 'completed', 'abandoned'))))::integer AS duration_35_60_started,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 35 AND 60 AND status = 'completed'))::integer AS duration_35_60_completed,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 65 AND 90))::integer AS duration_65_90_created,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 65 AND 90 AND (started_at IS NOT NULL OR status IN ('in_progress', 'completed', 'abandoned'))))::integer AS duration_65_90_started,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 65 AND 90 AND status = 'completed'))::integer AS duration_65_90_completed,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 95 AND 120))::integer AS duration_95_120_created,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 95 AND 120 AND (started_at IS NOT NULL OR status IN ('in_progress', 'completed', 'abandoned'))))::integer AS duration_95_120_started,
             (COUNT(*) FILTER (WHERE duration_minutes BETWEEN 95 AND 120 AND status = 'completed'))::integer AS duration_95_120_completed,
             (COUNT(*) FILTER (WHERE commercial_scope = 'free_demo'))::integer AS scope_free_demo,
             (COUNT(*) FILTER (WHERE commercial_scope = 'base'))::integer AS scope_base,
             (COUNT(*) FILTER (WHERE commercial_scope = 'premium'))::integer AS scope_premium,
             (COUNT(*) FILTER (WHERE replacement->>'reason' IN ('too_difficult', 'too_easy', 'not_relevant', 'accessibility', 'excluded')))::integer AS adjusted,
             (COUNT(*) FILTER (WHERE replacement->>'reason' = 'too_difficult'))::integer AS reason_too_difficult,
             (COUNT(*) FILTER (WHERE replacement->>'reason' = 'too_easy'))::integer AS reason_too_easy,
             (COUNT(*) FILTER (WHERE replacement->>'reason' = 'not_relevant'))::integer AS reason_not_relevant,
             (COUNT(*) FILTER (WHERE replacement->>'reason' = 'accessibility'))::integer AS reason_accessibility,
             (COUNT(*) FILTER (WHERE replacement->>'reason' = 'excluded'))::integer AS reason_excluded
           FROM adaptive_learning_sessions session
           WHERE session.created_at >= $1 AND session.created_at <= $2`,
        parameters,
      );
      const events = await client.query(
          `SELECT
             COUNT(*)::integer AS learning_block_completions,
             (COUNT(*) FILTER (WHERE event.evidence_quality = 'client_reported'))::integer AS quality_client_reported,
             (COUNT(*) FILTER (WHERE event.evidence_quality = 'server_verified_assisted'))::integer AS quality_server_verified_assisted,
             (COUNT(*) FILTER (WHERE event.evidence_quality = 'server_verified_unassisted'))::integer AS quality_server_verified_unassisted,
             (COUNT(*) FILTER (WHERE event.evidence_context = 'exam_practice'))::integer AS context_exam_practice,
             (COUNT(*) FILTER (WHERE event.evidence_context = 'planned_practice'))::integer AS context_planned_practice,
             (COUNT(*) FILTER (WHERE event.evidence_context = 'scheduled_review'))::integer AS context_scheduled_review,
             (COUNT(*) FILTER (WHERE event.evidence_context = 'ai_assisted_review'))::integer AS context_ai_assisted_review,
             (COUNT(*) FILTER (WHERE repeat.stage IN ('day_1', 'day_7')))::integer AS retention_observed,
             (COUNT(*) FILTER (WHERE repeat.stage IN ('day_1', 'day_7') AND attempt.passed))::integer AS retention_passed,
             (COUNT(*) FILTER (WHERE repeat.stage = 'day_1'))::integer AS day_1_observed,
             (COUNT(*) FILTER (WHERE repeat.stage = 'day_1' AND attempt.passed))::integer AS day_1_passed,
             (COUNT(*) FILTER (WHERE repeat.stage = 'day_7'))::integer AS day_7_observed,
             (COUNT(*) FILTER (WHERE repeat.stage = 'day_7' AND attempt.passed))::integer AS day_7_passed
           FROM adaptive_learning_session_events event
           LEFT JOIN voice_tutor_repeat_attempts attempt
             ON event.source_type = 'voice_tutor_repeat' AND attempt.id::text = event.source_ref
           LEFT JOIN voice_tutor_repeats repeat ON repeat.id = attempt.repeat_id
           WHERE event.block_kind = 'learning'
             AND event.created_at >= $1 AND event.created_at <= $2`,
        parameters,
      );
      const diagnostics = await client.query(
          `SELECT
             (COUNT(*) FILTER (WHERE catalog_version IN ('ege-short-diagnostic-v1', 'ege-short-diagnostic-v2')))::integer AS short_completed,
             (COUNT(*) FILTER (WHERE catalog_version IN ('ege-deep-diagnostic-v1', 'ege-deep-diagnostic-v2')))::integer AS deep_completed
           FROM adaptive_diagnostic_sessions diagnostic
           WHERE diagnostic.status = 'completed'
             AND diagnostic.completed_at >= $1 AND diagnostic.completed_at <= $2`,
        parameters,
      );
      const estimates = await client.query(
          `SELECT
             COUNT(*)::integer AS skill_estimates,
             (COUNT(*) FILTER (WHERE skill_id::text = ANY($3::text[]) AND uncertainty >= 70))::integer AS high_impact_high_uncertainty,
             (COUNT(*) FILTER (WHERE status = 'established'))::integer AS established_skills
           FROM adaptive_learning_skill_estimates estimate
           WHERE estimate.updated_at >= $1 AND estimate.updated_at <= $2`,
        [...parameters, ADAPTIVE_METRICS_HIGH_IMPACT_SKILLS],
      );
      const number = (row, name) => Number(row?.[name] || 0);
      const counters = emptyAdaptiveLearningMetricCounters();
      const session = sessions.rows[0];
      counters.sessions.created = number(session, 'created');
      counters.sessions.started = number(session, 'started');
      counters.sessions.completed = number(session, 'completed');
      counters.sessions.plannedLearningMinutes = number(session, 'planned_learning_minutes');
      counters.sessions.completedPlannedMinutes = number(session, 'completed_planned_minutes');
      for (const bucket of ['15_30', '35_60', '65_90', '95_120']) {
        for (const state of ['created', 'started', 'completed']) {
          counters.sessions.byDuration[bucket][state] = number(session, `duration_${bucket}_${state}`);
        }
      }
      counters.commercialScopes.free_demo = number(session, 'scope_free_demo');
      counters.commercialScopes.base = number(session, 'scope_base');
      counters.commercialScopes.premium = number(session, 'scope_premium');
      counters.adjustments.sessions = number(session, 'adjusted');
      for (const reason of ['too_difficult', 'too_easy', 'not_relevant', 'accessibility', 'excluded']) {
        counters.adjustments.reasons[reason] = number(session, `reason_${reason}`);
      }

      const event = events.rows[0];
      counters.evidence.learningBlockCompletions = number(event, 'learning_block_completions');
      for (const quality of ['client_reported', 'server_verified_assisted', 'server_verified_unassisted']) {
        counters.evidence.byQuality[quality] = number(event, `quality_${quality}`);
      }
      for (const context of ['exam_practice', 'planned_practice', 'scheduled_review', 'ai_assisted_review']) {
        counters.evidence.byContext[context] = number(event, `context_${context}`);
      }
      counters.retention.observed = number(event, 'retention_observed');
      counters.retention.passed = number(event, 'retention_passed');
      for (const stage of ['day_1', 'day_7']) {
        counters.retention[stage].observed = number(event, `${stage}_observed`);
        counters.retention[stage].passed = number(event, `${stage}_passed`);
      }

      const diagnostic = diagnostics.rows[0];
      counters.diagnostics.shortCompleted = number(diagnostic, 'short_completed');
      counters.diagnostics.deepCompleted = number(diagnostic, 'deep_completed');
      const estimate = estimates.rows[0];
      counters.profile.skillEstimates = number(estimate, 'skill_estimates');
      counters.profile.highImpactHighUncertaintySkills = number(estimate, 'high_impact_high_uncertainty');
      counters.profile.establishedSkills = number(estimate, 'established_skills');
      return finalizeAdaptiveLearningMetrics(counters, { window });
    });
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
      if (diagnostic.commercialMode === 'free_short') {
        const used = await client.query(
          `SELECT 1 FROM adaptive_diagnostic_sessions
           WHERE username = $1 AND status = 'completed'
             AND catalog_version IN ('ege-short-diagnostic-v1', 'ege-short-diagnostic-v2') LIMIT 1`,
          [username],
        );
        if (used.rowCount) throw new Error('ADAPTIVE_FREE_DIAGNOSTIC_USED');
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
        `SELECT id, catalog_version FROM adaptive_diagnostic_sessions
         WHERE username = $1 AND status IN ('in_progress', 'ready') ORDER BY started_at DESC LIMIT 1`,
        [username],
      );
      if (active.rowCount && active.rows[0].catalog_version !== diagnostic.catalogVersion) {
        throw new Error('ADAPTIVE_DIAGNOSTIC_ALREADY_CURRENT');
      }
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
      const owner = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) throw new Error('ADAPTIVE_DIAGNOSTIC_NOT_FOUND');
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
      const owner = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) throw new Error('ADAPTIVE_DIAGNOSTIC_NOT_FOUND');
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
      const owner = await client.query(
        'SELECT username FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
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

  async function recordModuleAttemptWithAdaptiveClaim(username, attempt, { executionClaim }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('ADAPTIVE_EXECUTION_CLAIM_INVALID');
      const effectiveNow = new Date((await client.query(
        'SELECT clock_timestamp() AS now',
      )).rows[0].now);
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
        || claim.revoked_at || new Date(claim.expires_at) <= effectiveNow
        || claim.launch_fingerprint !== adaptiveLaunchFingerprint(block)) {
        throw new Error(new Date(claim.expires_at) <= effectiveNow
          ? 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED' : 'ADAPTIVE_EXECUTION_CLAIM_INVALID');
      }
      const existing = await client.query('SELECT * FROM module_attempts WHERE id = $1', [attempt.id]);
      if (['writing', 'speaking'].includes(block.module)) {
        throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
      }
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
        ...(block.module === 'reading'
          ? adaptiveReadingMetadata(attempt.metadata, block)
          : adaptiveAssistedMetadata(attempt.metadata)),
      };
      const inserted = await client.query(
        `INSERT INTO module_attempts
         (id, username, module, activity, score, max_score, duration_ms, metadata, evidence_quality, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'client_reported', $9)
         RETURNING created_at`,
        [attempt.id, username, attempt.module, attempt.activity, attempt.score, attempt.maxScore,
          attempt.durationMs ?? null, JSON.stringify(metadata), effectiveNow],
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
        [claim.id, effectiveNow, attempt.id],
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
    sessionId, executionClaim, attempt,
  }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query('SELECT username FROM users WHERE username = $1 FOR UPDATE', [username]);
      if (!owner.rowCount) throw new Error('ADAPTIVE_EXECUTION_CLAIM_INVALID');
      const effectiveNow = new Date((await client.query(
        'SELECT clock_timestamp() AS now',
      )).rows[0].now);
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
        || claim.revoked_at || new Date(claim.expires_at) <= effectiveNow
        || claim.launch_fingerprint !== adaptiveLaunchFingerprint(block)) {
        throw new Error(new Date(claim.expires_at) <= effectiveNow
          ? 'ADAPTIVE_EXECUTION_CLAIM_EXPIRED' : 'ADAPTIVE_EXECUTION_CLAIM_INVALID');
      }
      await requireAdaptivePremiumDepthEntitlement(client, username, block);
      if (claim.consumed_at) {
        if (claim.attempt_type !== attempt.type || String(claim.attempt_ref) !== String(attempt.id)) {
          throw new Error('ADAPTIVE_EXECUTION_CLAIM_CONSUMED');
        }
        await client.query('COMMIT');
        return {
          created: false,
          evidenceQuality: ['voice_tutor_repeat', 'speaking'].includes(attempt.type)
            ? 'server_verified_unassisted' : 'server_verified_assisted',
          adaptiveExecution: {
            sessionId, blockId: block.id, attemptType: attempt.type,
            attemptId: attempt.type === 'voice_tutor_repeat' ? String(attempt.id) : Number(attempt.id),
          },
        };
      }
      if (attempt.type === 'voice_tutor_repeat') {
        const source = await client.query(
          `SELECT attempt.id, attempt.repeat_id, attempt.task_id, attempt.observed_at,
                  repeat.task_id AS repeat_task_id, repeat.stage AS repeat_stage,
                  repeat.due_at AS repeat_due_at, repeat.window_ends_at AS repeat_window_ends_at,
                  repeat.recovery_id, recovery.username AS recovery_username,
                  recovery.skill_id, recovery.module
           FROM voice_tutor_repeat_attempts attempt
           JOIN voice_tutor_repeats repeat ON repeat.id = attempt.repeat_id
           JOIN voice_tutor_recoveries recovery ON recovery.id = repeat.recovery_id
           WHERE attempt.id = $1 AND recovery.username = $2 AND attempt.task_id = repeat.task_id`,
          [attempt.id, username],
        );
        const sourceRow = source.rows[0];
        if (!sourceRow || !adaptiveRepeatExecutionMatches({
          username,
          block,
          attempt: sourceRow,
          repeat: {
            id: sourceRow.repeat_id,
            task_id: sourceRow.repeat_task_id,
            stage: sourceRow.repeat_stage,
            due_at: sourceRow.repeat_due_at,
            window_ends_at: sourceRow.repeat_window_ends_at,
            recovery_id: sourceRow.recovery_id,
          },
          recovery: {
            id: sourceRow.recovery_id,
            username: sourceRow.recovery_username,
            skill_id: sourceRow.skill_id,
            module: sourceRow.module,
          },
          claimIssuedAt: claim.issued_at,
        })) {
          throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
        }
        await client.query(
          `UPDATE adaptive_learning_execution_claims
           SET consumed_at = $2, attempt_type = $3, attempt_ref = $4 WHERE id = $1`,
          [claim.id, effectiveNow, attempt.type, String(attempt.id)],
        );
        await client.query('COMMIT');
        return {
          created: true, evidenceQuality: 'server_verified_unassisted',
          adaptiveExecution: {
            sessionId, blockId: block.id, attemptType: attempt.type, attemptId: String(attempt.id),
          },
        };
      }
      const table = attempt.type === 'writing' ? 'writing_attempts' : 'speaking_attempts';
      const exactTaskColumns = attempt.type === 'writing'
        ? 'source_task_ref, NULL::text AS assignment_fingerprint'
        : `source_task_ref, assignment_fingerprint, source_session_id, source_task_revision,
           source_catalog_id, source_catalog_revision, assistance_used, accent_locale, transcript, evaluated_at`;
      let source = await client.query(
        `SELECT id, username, task_type, ${exactTaskColumns}, status, review, created_at FROM ${table}
         WHERE username = $1 AND id = $2`,
        [username, attempt.id],
      );
      if (attempt.type === 'speaking' && source.rows[0]) {
        const sessionLocked = await adaptiveSpeakingSourceMatches(
          client, username, block, source.rows[0], claim.issued_at, { lockSession: true },
        );
        if (!sessionLocked) throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
        source = await client.query(
          `SELECT id, username, task_type, ${exactTaskColumns}, status, review, created_at
           FROM speaking_attempts WHERE username = $1 AND id = $2 FOR UPDATE`,
          [username, attempt.id],
        );
      }
      const sourceRow = source.rows[0];
      const activityMatches = attempt.type === 'writing'
        ? block.activityId === String(sourceRow?.task_type || '')
        : adaptiveSpeakingActivityMatchesTask(block.activityId, sourceRow?.task_type);
      const exactTask = attempt.type === 'writing'
        ? sourceRow?.source_task_ref === block.launch?.taskId
        : await adaptiveSpeakingSourceMatches(
          client, username, block, sourceRow, claim.issued_at, { lockSession: true },
        );
      if (!sourceRow || sourceRow.status !== 'completed'
        || (attempt.type === 'speaking' && (sourceRow.review?.status !== 'scored'
          || typeof sourceRow.review?.got !== 'number' || typeof sourceRow.review?.max !== 'number'))
        || new Date(sourceRow.created_at) < new Date(claim.issued_at)
        || block.module !== attempt.type || !activityMatches || !exactTask) {
        throw new Error('ADAPTIVE_EXECUTION_ATTEMPT_MISMATCH');
      }
      await client.query(
        `UPDATE adaptive_learning_execution_claims
         SET consumed_at = $2, attempt_type = $3, attempt_ref = $4 WHERE id = $1`,
        [claim.id, effectiveNow, attempt.type, String(attempt.id)],
      );
      await client.query('COMMIT');
      return {
        created: true, evidenceQuality: attempt.type === 'speaking'
          ? 'server_verified_unassisted' : 'server_verified_assisted',
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

  async function getReadingCompletedAttempts(username, { limit = 120 } = {}) {
    const boundedLimit = Math.min(120, Math.max(1, Number.isInteger(limit) ? limit : 120));
    const result = await pool.query(
      `SELECT id, username, module, activity, score, max_score, duration_ms, metadata,
              evidence_quality, created_at
       FROM module_attempts
       WHERE username = $1 AND module = 'reading'
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [username, boundedLimit],
    );
    return result.rows;
  }

  async function upsertWordProgress(username, words) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const item of words) {
        const normalized = wordProgressApiDto(item);
        const selected = await client.query(
          `SELECT word, stage, error_count, review_count, due_at, updated_at,
                  mastery_version, dimensions, last_mode, last_outcome
           FROM word_progress WHERE username = $1 AND word = $2 FOR UPDATE`,
          [username, normalized.word],
        );
        const candidate = wordProgressPersistenceCandidate(selected.rows[0], item);
        const stored = wordProgressStorageDto(candidate);
        await client.query(
          `INSERT INTO word_progress (
             username, word, stage, error_count, review_count, due_at,
             mastery_version, dimensions, last_mode, last_outcome
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
           ON CONFLICT (username, word) DO UPDATE SET stage = EXCLUDED.stage,
             error_count = EXCLUDED.error_count, review_count = EXCLUDED.review_count,
             due_at = EXCLUDED.due_at, mastery_version = EXCLUDED.mastery_version,
             dimensions = EXCLUDED.dimensions, last_mode = EXCLUDED.last_mode,
             last_outcome = EXCLUDED.last_outcome, updated_at = NOW()`,
          [
            username, stored.word, stored.stage, stored.error_count, stored.review_count,
            stored.due_at == null ? null : new Date(stored.due_at), stored.mastery_version,
            JSON.stringify(stored.dimensions), stored.last_mode, stored.last_outcome,
          ],
        );
      }
      await client.query('COMMIT');
      return { updated: words.length };
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async function getWordProgress(username) {
    const result = await pool.query(
      `SELECT word, stage, error_count, review_count, due_at, updated_at,
              mastery_version, dimensions, last_mode, last_outcome
       FROM word_progress WHERE username = $1 ORDER BY word`,
      [username],
    );
    return result.rows.map(wordProgressApiDto);
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

  function mapSpeakingAssessment(row) {
    if (!row) return null;
    return {
      ...row,
      allowance_seconds: Number(row.allowance_seconds),
      reserved_seconds: Number(row.reserved_seconds),
      billable_seconds: row.billable_seconds == null ? null : Number(row.billable_seconds),
      period_start: new Date(row.period_start).toISOString(),
      reserved_at: new Date(row.reserved_at).toISOString(),
      dispatch_started_at: row.dispatch_started_at ? new Date(row.dispatch_started_at).toISOString() : null,
      provider_started_at: row.provider_started_at ? new Date(row.provider_started_at).toISOString() : null,
      finalized_at: row.finalized_at ? new Date(row.finalized_at).toISOString() : null,
      released_at: row.released_at ? new Date(row.released_at).toISOString() : null,
    };
  }

  async function readSpeakingAssessmentQuota(queryable, username, now = new Date()) {
    const instant = new Date(now);
    const periodStart = speakingAssessmentPeriodStart(instant);
    const [access, usage] = await Promise.all([
      queryable.query(
        `SELECT EXISTS (
           SELECT 1 FROM subscription_entitlements entitlement
           WHERE entitlement.username = users.username AND entitlement.entitlement = 'voice_tutor'
             AND entitlement.starts_at <= $2
             AND (entitlement.ends_at IS NULL OR entitlement.ends_at > $2)
         ) AND users.subscription_until > $2 AS premium
         FROM users WHERE username = $1`,
        [username, instant],
      ),
      queryable.query(
        `SELECT
           COALESCE(SUM(billable_seconds) FILTER (WHERE status = 'finalized'), 0) AS used_seconds,
           COALESCE(SUM(reserved_seconds) FILTER (WHERE status IN ('reserved', 'dispatching', 'started')), 0) AS held_seconds
         FROM speaking_pronunciation_assessments
         WHERE username = $1 AND period_start = $2`,
        [username, periodStart],
      ),
    ]);
    if (!access.rowCount) throw new Error('USER_NOT_FOUND');
    const tier = access.rows[0].premium ? 'premium' : 'base';
    const limitSeconds = SPEAKING_ASSESSMENT_LIMITS[tier];
    const usedSeconds = Number(usage.rows[0].used_seconds);
    const heldSeconds = Number(usage.rows[0].held_seconds);
    return {
      tier,
      periodStart: periodStart.toISOString(),
      limitSeconds,
      usedSeconds,
      heldSeconds,
      remainingSeconds: Math.max(0, limitSeconds - usedSeconds - heldSeconds),
    };
  }

  async function reconcileSpeakingAssessmentLeases(client, username, now) {
    const instant = new Date(now);
    speakingAssessmentPeriodStart(instant);
    const cutoff = new Date(instant.getTime() - SPEAKING_ASSESSMENT_LEASE_MS);
    await client.query(
      `UPDATE speaking_pronunciation_assessments
       SET status = 'released', billable_seconds = 0, released_at = $2,
           release_reason = 'process_interrupted_before_start',
           result = jsonb_build_object(
             'assessment', jsonb_build_object(
               'status', 'unavailable', 'available', false,
               'reason', 'process_interrupted_before_start', 'retryable', true
             ),
             'billing', jsonb_build_object(
               'assessmentId', id::text, 'reservedSeconds', reserved_seconds,
               'billableSeconds', 0, 'conservative', false
             )
           )
       WHERE username = $1 AND status = 'reserved' AND reserved_at <= $3`,
      [username, instant, cutoff],
    );
    await client.query(
      `UPDATE speaking_pronunciation_assessments
       SET status = 'finalized', billable_seconds = reserved_seconds, finalized_at = $2,
           result = jsonb_build_object(
             'assessment', jsonb_build_object(
               'status', 'unavailable', 'available', false,
               'reason', 'process_interrupted_during_dispatch', 'retryable', true
             ),
             'billing', jsonb_build_object(
               'assessmentId', id::text, 'reservedSeconds', reserved_seconds,
               'billableSeconds', reserved_seconds, 'conservative', true
             )
           )
       WHERE username = $1 AND status = 'dispatching' AND dispatch_started_at <= $3`,
      [username, instant, cutoff],
    );
    await client.query(
      `UPDATE speaking_pronunciation_assessments
       SET status = 'finalized', billable_seconds = reserved_seconds, finalized_at = $2,
           result = jsonb_build_object(
             'assessment', jsonb_build_object(
               'status', 'unavailable', 'available', false,
               'reason', 'process_interrupted_after_start', 'retryable', true
             ),
             'billing', jsonb_build_object(
               'assessmentId', id::text, 'reservedSeconds', reserved_seconds,
               'billableSeconds', reserved_seconds, 'conservative', true
             )
           )
       WHERE username = $1 AND status = 'started' AND provider_started_at <= $3`,
      [username, instant, cutoff],
    );
  }

  async function getSpeakingAssessmentQuota(username, { now = new Date() } = {}) {
    return withSpeakingAssessmentTransaction(username, async (client) => {
      await reconcileSpeakingAssessmentLeases(client, username, now);
      return readSpeakingAssessmentQuota(client, username, now);
    });
  }

  async function getSpeakingAssessmentReservation(username, idempotencyKey, { now = new Date() } = {}) {
    const key = assertSpeakingAssessmentIdempotencyKey(idempotencyKey);
    return withSpeakingAssessmentTransaction(username, async (client) => {
      await reconcileSpeakingAssessmentLeases(client, username, now);
      const reservation = await client.query(
        `SELECT * FROM speaking_pronunciation_assessments
         WHERE username = $1 AND idempotency_key = $2`,
        [username, key],
      );
      return {
        reservation: mapSpeakingAssessment(reservation.rows[0]),
        quota: await readSpeakingAssessmentQuota(client, username, now),
      };
    });
  }

  async function withSpeakingAssessmentTransaction(username, run) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        'SELECT username, subscription_until FROM users WHERE username = $1 FOR UPDATE', [username],
      );
      if (!owner.rowCount) throw new Error('USER_NOT_FOUND');
      const result = await run(client, owner.rows[0]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function reserveSpeakingAssessment(username, input) {
    const candidate = assertSpeakingAssessmentReservation(input);
    return withSpeakingAssessmentTransaction(username, async (client) => {
      await reconcileSpeakingAssessmentLeases(client, username, candidate.now);
      const existing = await client.query(
        `SELECT * FROM speaking_pronunciation_assessments
         WHERE username = $1 AND idempotency_key = $2`,
        [username, candidate.idempotencyKey],
      );
      if (existing.rowCount) {
        if (existing.rows[0].request_hash !== candidate.requestHash) {
          throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_IDEMPOTENCY_CONFLICT');
        }
        return {
          created: false,
          reservation: mapSpeakingAssessment(existing.rows[0]),
          quota: await readSpeakingAssessmentQuota(client, username, candidate.now),
        };
      }
      const quota = await readSpeakingAssessmentQuota(client, username, candidate.now);
      if (candidate.reservedSeconds > quota.remainingSeconds) {
        throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_QUOTA_EXHAUSTED');
      }
      const inserted = await client.query(
        `INSERT INTO speaking_pronunciation_assessments
         (id, username, idempotency_key, request_hash, audio_hash, status, locale, context_id, period_start,
          allowance_seconds, reserved_seconds, reserved_at)
         VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [candidate.id, username, candidate.idempotencyKey, candidate.requestHash,
          candidate.audioHash, candidate.locale, candidate.contextId, candidate.periodStart, quota.limitSeconds,
          candidate.reservedSeconds, candidate.now],
      );
      return {
        created: true,
        reservation: mapSpeakingAssessment(inserted.rows[0]),
        quota: await readSpeakingAssessmentQuota(client, username, candidate.now),
      };
    });
  }

  async function dispatchSpeakingAssessment(username, idempotencyKey, { now = new Date() } = {}) {
    return withSpeakingAssessmentTransaction(username, async (client) => {
      const instant = new Date(now);
      const current = await client.query(
        `SELECT * FROM speaking_pronunciation_assessments
         WHERE username = $1 AND idempotency_key = $2 FOR UPDATE`,
        [username, idempotencyKey],
      );
      if (!current.rowCount) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RESERVATION_NOT_FOUND');
      if (current.rows[0].status === 'released') throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_ALREADY_RELEASED');
      let row = current.rows[0];
      let dispatched = false;
      if (row.status === 'reserved') {
        const updated = await client.query(
          `UPDATE speaking_pronunciation_assessments
           SET status = 'dispatching', dispatch_started_at = $3
           WHERE username = $1 AND idempotency_key = $2
           RETURNING *`,
          [username, idempotencyKey, instant],
        );
        row = updated.rows[0];
        dispatched = true;
      }
      return {
        dispatched,
        reservation: mapSpeakingAssessment(row),
        quota: await readSpeakingAssessmentQuota(client, username, instant),
      };
    });
  }

  async function startSpeakingAssessment(username, idempotencyKey, { now = new Date() } = {}) {
    return withSpeakingAssessmentTransaction(username, async (client) => {
      const instant = new Date(now);
      const current = await client.query(
        `SELECT * FROM speaking_pronunciation_assessments
         WHERE username = $1 AND idempotency_key = $2 FOR UPDATE`,
        [username, idempotencyKey],
      );
      if (!current.rowCount) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RESERVATION_NOT_FOUND');
      if (current.rows[0].status === 'released') throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_ALREADY_RELEASED');
      if (current.rows[0].status === 'reserved') throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_NOT_DISPATCHED');
      let row = current.rows[0];
      let started = false;
      if (row.status === 'dispatching') {
        const updated = await client.query(
          `UPDATE speaking_pronunciation_assessments
           SET status = 'started', provider_started_at = $3
           WHERE username = $1 AND idempotency_key = $2
           RETURNING *`,
          [username, idempotencyKey, instant],
        );
        row = updated.rows[0];
        started = true;
      }
      return {
        started,
        reservation: mapSpeakingAssessment(row),
        quota: await readSpeakingAssessmentQuota(client, username, instant),
      };
    });
  }

  async function finalizeSpeakingAssessment(username, idempotencyKey, {
    billableSeconds, result, now = new Date(),
  } = {}) {
    return withSpeakingAssessmentTransaction(username, async (client) => {
      const instant = new Date(now);
      const current = await client.query(
        `SELECT * FROM speaking_pronunciation_assessments
         WHERE username = $1 AND idempotency_key = $2 FOR UPDATE`,
        [username, idempotencyKey],
      );
      if (!current.rowCount) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RESERVATION_NOT_FOUND');
      if (current.rows[0].status === 'finalized') return {
        finalized: false,
        reservation: mapSpeakingAssessment(current.rows[0]),
        quota: await readSpeakingAssessmentQuota(client, username, instant),
      };
      const seconds = Number(billableSeconds);
      if (current.rows[0].status !== 'started') throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_NOT_STARTED');
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > Number(current.rows[0].reserved_seconds)
        || !result || typeof result !== 'object' || Array.isArray(result)
        || !Number.isFinite(instant.getTime())) {
        throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_FINALIZATION_INVALID');
      }
      const updated = await client.query(
        `UPDATE speaking_pronunciation_assessments
         SET status = 'finalized', billable_seconds = $3, result = $4::jsonb, finalized_at = $5
         WHERE username = $1 AND idempotency_key = $2
         RETURNING *`,
        [username, idempotencyKey, seconds, JSON.stringify(result), instant],
      );
      return {
        finalized: true,
        reservation: mapSpeakingAssessment(updated.rows[0]),
        quota: await readSpeakingAssessmentQuota(client, username, instant),
      };
    });
  }

  async function releaseSpeakingAssessment(username, idempotencyKey, {
    reason, result, now = new Date(),
  } = {}) {
    return withSpeakingAssessmentTransaction(username, async (client) => {
      const instant = new Date(now);
      const current = await client.query(
        `SELECT * FROM speaking_pronunciation_assessments
         WHERE username = $1 AND idempotency_key = $2 FOR UPDATE`,
        [username, idempotencyKey],
      );
      if (!current.rowCount) throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RESERVATION_NOT_FOUND');
      if (['released', 'finalized'].includes(current.rows[0].status)) return {
        released: false,
        reservation: mapSpeakingAssessment(current.rows[0]),
        quota: await readSpeakingAssessmentQuota(client, username, instant),
      };
      if (!['reserved', 'dispatching'].includes(current.rows[0].status)
        || !/^[a-z][a-z0-9_]{0,63}$/u.test(String(reason || ''))
        || !result || typeof result !== 'object' || Array.isArray(result)
        || !Number.isFinite(instant.getTime())) {
        throw new SpeakingAssessmentQuotaError('SPEAKING_ASSESSMENT_RELEASE_INVALID');
      }
      const updated = await client.query(
        `UPDATE speaking_pronunciation_assessments
         SET status = 'released', billable_seconds = 0, released_at = $3, release_reason = $4,
             result = $5::jsonb
         WHERE username = $1 AND idempotency_key = $2
         RETURNING *`,
        [username, idempotencyKey, instant, String(reason), JSON.stringify(result)],
      );
      return {
        released: true,
        reservation: mapSpeakingAssessment(updated.rows[0]),
        quota: await readSpeakingAssessmentQuota(client, username, instant),
      };
    });
  }

  async function exportUserData(username) {
    const [account, progress, privacyConsent, subscriptionEvents, subscriptionEntitlements, voiceTutorSessions, voiceTutorRecoveries, voiceTutorRepeats, voiceTutorRepeatAttempts, voiceTutorReports, ruleCards, paymentRequests, writingAttempts, speakingAttempts, speakingTask1Sessions, speakingTask2Sessions, speakingTask3Sessions, speakingTask4Sessions, speakingFullSessions, speakingAssessments, generatedTasks, moduleAttempts, progressSummary, wordProgress, errorBank, adaptiveGoals, adaptiveSnapshot, adaptivePlanRevisions, adaptiveSessions, adaptiveSessionExecutionEvents, adaptiveDiagnosticSessions, adaptiveDiagnosticResponses, aiRequests, auditLog] = await Promise.all([
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
      pool.query(`SELECT id, task_type, assignment, transcript, review, provider, model, prompt_version,
                         status, error_code, source_session_id, source_task_ref, source_task_revision,
                         source_catalog_id, source_catalog_revision, assistance_used, assistance_updated_at,
                         accent_locale, targeted_practice, created_at, evaluated_at
                  FROM speaking_attempts WHERE username = $1 ORDER BY created_at`, [username]),
      pool.query(`SELECT id, catalog_id, catalog_revision, task_id, task_revision, selection_reason,
                         accent_locale, accent_profile_revision, accent_effective_at,
                         targeted_practice, status, assistance_used, recording_duration_seconds, mic_check, local_playback, self_rating,
                         assigned_at, completed_at, due_at
                  FROM speaking_task1_sessions WHERE username = $1 ORDER BY assigned_at, id`, [username]),
      pool.query(`SELECT id, catalog_id, catalog_revision, task_id, task_revision, selection_reason,
                         accent_locale, accent_profile_revision, accent_effective_at,
                         targeted_practice, status, assistance_used, current_question, questions, self_rating, assigned_at, completed_at, due_at
                  FROM speaking_task2_sessions WHERE username = $1 ORDER BY assigned_at, id`, [username]),
      pool.query(`SELECT id, catalog_id, catalog_revision, task_id, task_revision, selection_reason,
                         accent_locale, accent_profile_revision, accent_effective_at,
                         targeted_practice, status, assistance_used, current_question, answers, self_rating, assigned_at, completed_at, due_at
                  FROM speaking_task3_sessions WHERE username = $1 ORDER BY assigned_at, id`, [username]),
      pool.query(`SELECT id, catalog_id, catalog_revision, task_id, task_revision, selection_reason,
                         accent_locale, accent_profile_revision, accent_effective_at,
                         targeted_practice, status, assistance_used, recording_duration_seconds, mic_check, local_playback, self_rating,
                         assigned_at, completed_at, due_at
                  FROM speaking_task4_sessions WHERE username = $1 ORDER BY assigned_at, id`, [username]),
      pool.query(`SELECT id, mode, format_id, format_revision, catalog_id, catalog_revision,
                         variant_index, selection_reason, maximum_score, assignments, responses,
                         accent_locale, accent_profile_revision, accent_effective_at,
                         status, phase, current_task, current_response, stage_started_at,
                         stage_deadline_at, assigned_at, submitted_at, submission_response
                  FROM speaking_full_sessions WHERE username = $1 ORDER BY assigned_at, id`, [username]),
      pool.query(`SELECT id, status, locale, context_id, period_start, allowance_seconds, reserved_seconds,
                         billable_seconds, reserved_at, dispatch_started_at, provider_started_at, finalized_at,
                         released_at, release_reason, result
                  FROM speaking_pronunciation_assessments
                  WHERE username = $1 ORDER BY reserved_at, id`, [username]),
      pool.query('SELECT id, operation, request, result, provider, prompt_version, created_at FROM generated_tasks WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT id, module, activity, score, max_score, duration_ms, metadata, evidence_quality, created_at FROM module_attempts WHERE username = $1 ORDER BY created_at', [username]),
      pool.query('SELECT module, attempt_count, best_score, best_max_score, total_duration_ms, last_attempt_at, updated_at FROM progress_summary WHERE username = $1 ORDER BY module', [username]),
      pool.query(`SELECT word, stage, error_count, review_count, due_at, updated_at,
                         mastery_version, dimensions, last_mode, last_outcome
                  FROM word_progress WHERE username = $1 ORDER BY word`, [username]),
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
    const [speakingAccentProfile, speakingAccentHistory, speakingAccentCalibration,
      speakingCalibrationConsent, speakingCalibrationSamples] = await Promise.all([
      getSpeakingAccentProfile(username),
      getSpeakingAccentHistory(username),
      pool.query(
        `SELECT id, status, started_at, completed_at, locale, confidence, policy_version
         FROM speaking_accent_calibrations WHERE username = $1`,
        [username],
      ).then((result) => publicSpeakingAccentCalibration(result.rows[0] || null)),
      getSpeakingCalibrationConsent(username),
      listSpeakingCalibrationSamplesForOwner(username),
    ]);
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
      speaking_task1_sessions: speakingTask1Sessions.rows,
      speaking_task2_sessions: speakingTask2Sessions.rows,
      speaking_task3_sessions: speakingTask3Sessions.rows,
      speaking_task4_sessions: speakingTask4Sessions.rows,
      speaking_full_sessions: speakingFullSessions.rows,
      speaking_assessments: speakingAssessments.rows.map(speakingAssessmentExportDto),
      speaking_accent_profile: speakingAccentProfile,
      speaking_accent_history: speakingAccentHistory,
      speaking_accent_calibration: speakingAccentCalibration,
      speaking_calibration_consent: speakingCalibrationConsent,
      speaking_calibration_samples: speakingCalibrationSamples,
      generated_tasks: generatedTasks.rows,
      module_attempts: moduleAttempts.rows,
      progress_summary: progressSummary.rows,
      word_progress: wordProgress.rows.map(wordProgressExportDto),
      error_bank: errorBank.rows,
      adaptive_learning_goals: adaptiveGoals.rows.map(adaptiveLearningGoalRepositoryDto),
      adaptive_learning_profile: adaptiveExport.profile,
      adaptive_learning_skill_estimates: adaptiveExport.estimates,
      adaptive_learning_plan_revisions: adaptivePlanRevisions.rows.map(adaptiveLearningPlanRepositoryDto),
      adaptive_learning_sessions: adaptiveSessions.rows.map(adaptiveLearningSessionRepositoryDto),
      adaptive_learning_reports: adaptiveSessions.rows
        .filter((row) => row.status === 'completed' && row.completion_summary)
        .map((row) => ({
          session_id: row.id,
          completed_at: row.completed_at,
          summary: structuredClone(row.completion_summary),
        })),
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
      const calibrationReviews = await client.query(
        `SELECT id, reviews, access_audit FROM speaking_calibration_samples
         WHERE reviews @> $1::jsonb OR access_audit @> $1::jsonb`,
        [JSON.stringify([{ reviewer: username }])],
      );
      for (const sample of calibrationReviews.rows) {
        const anonymize = (entries) => entries.map((entry) => (entry.reviewer === username
          ? { ...entry, reviewer: null, reviewer_account_deleted: true }
          : entry));
        await client.query(
          `UPDATE speaking_calibration_samples
           SET reviews = $2::jsonb, access_audit = $3::jsonb WHERE id = $1`,
          [sample.id, JSON.stringify(anonymize(sample.reviews)),
            JSON.stringify(anonymize(sample.access_audit))],
        );
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
      await client.query(
        `DELETE FROM speaking_calibration_samples
         WHERE username = $1 AND status <> 'completed'`,
        [username],
      );
      const completedCalibrationSamples = await client.query(
        `SELECT id, reviews FROM speaking_calibration_samples
         WHERE username = $1 AND status = 'completed' FOR UPDATE`,
        [username],
      );
      for (const sample of completedCalibrationSamples.rows) {
        const anonymousReviews = sample.reviews.map((review) => ({ ...review, reviewer: null }));
        await client.query(
          `UPDATE speaking_calibration_samples
           SET assessment_key = NULL, reviews = $2::jsonb, access_audit = '[]'::jsonb
           WHERE id = $1`,
          [sample.id, JSON.stringify(anonymousReviews)],
        );
      }
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
    migrateGrammarMastery,
    applyGrammarMasteryEvent,
    applyGrammarMasteryEvents,
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
    getSpeakingAssessmentQuota,
    getSpeakingAssessmentReservation,
    reserveSpeakingAssessment,
    dispatchSpeakingAssessment,
    startSpeakingAssessment,
    finalizeSpeakingAssessment,
    releaseSpeakingAssessment,
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
    getSpeakingAccentProfile,
    getSpeakingAccentHistory,
    setSpeakingAccentProfile,
    startSpeakingAccentCalibration,
    getSpeakingAccentCalibration,
    getPendingSpeakingAccentCalibration,
    completeSpeakingAccentCalibration,
    getSpeakingCalibrationConsent,
    setSpeakingCalibrationConsent,
    createSpeakingCalibrationSample,
    purgeExpiredSpeakingCalibrationSamples,
    claimSpeakingCalibrationSample,
    getSpeakingCalibrationAudio,
    submitSpeakingCalibrationReview,
    listSpeakingCalibrationSamplesForOwner,
    listAnonymousSpeakingCalibrationLabels,
    createTelegramAuthCode,
    confirmTelegramAuthCode,
    consumeTelegramAuthCode,
    createWritingAttempt,
    finishWritingAttempt,
    getWritingAttempt,
    createSpeakingAttempt,
    claimSpeakingEvaluation,
    getSpeakingEvaluationClaim,
    finishSpeakingAttempt,
    getSpeakingAttempt,
    getSpeakingLearningAttempts,
    getSpeakingLearningReportSnapshot,
    markSpeakingSessionAssisted,
    assignSpeakingTask1Session,
    getSpeakingTask1Session,
    completeSpeakingTask1Session,
    assignSpeakingTask2Session,
    getSpeakingTask2Session,
    completeSpeakingTask2Question,
    assignSpeakingTask3Session,
    getSpeakingTask3Session,
    completeSpeakingTask3Answer,
    assignSpeakingTask4Session,
    getSpeakingTask4Session,
    completeSpeakingTask4Session,
    assignFullSpeakingSession,
    getFullSpeakingSession,
    advanceFullSpeakingSessionStage,
    completeFullSpeakingSessionResponse,
    claimFullSpeakingSessionAssessment,
    submitFullSpeakingSessionResult,
    completeFullSpeakingSessionEvaluation,
    getGeneratedTask,
    deleteGeneratedTask,
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
    getAdaptiveLearningSessionCommercialScope,
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
    getAdaptiveLearningCommercialUsage,
    getAdaptiveLearningCompletedSessionReports,
    getAdaptiveLearningMetrics,
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
    getReadingCompletedAttempts,
    upsertWordProgress,
    getWordProgress,
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
