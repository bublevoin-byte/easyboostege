import crypto from 'node:crypto';

import {
  applyEgeMockAssessmentRetryable,
  applyEgeMockAssessmentRetryMutation,
  applyEgeMockDraftMutation,
  applyEgeMockOralMutation,
  applyEgeMockOralStageMutation,
  applyEgeMockOralStartMutation,
  applyEgeMockWrittenMutation,
  createEgeMockAttempt,
  egeMockAttemptExportDto,
  egeMockAttemptPublicDto,
  EgeMockAttemptError,
  egeMockResultPublicDto,
  egeMockStartDecision,
  reconcileEgeMockAttempt,
  shouldSettleEgeMockOralStageBeforeReconcile,
} from './attempt.js';
import {
  applyEgeMockAssessmentRunDisposition,
  egeMockAssessmentRunBeginDecision,
  egeMockAssessmentRunCanSettleTerminalSnapshot,
  egeMockAssessmentRunSettlement,
} from './assessment-run-command.js';
import { getEgeMockForm } from './catalog.js';
import {
  buildEgeMockHistory,
  egeMockErrorFocusEntries,
  refreshEgeMockStoredResult,
} from './result.js';
import { EGE_MOCK_RESULT_HISTORY_LIMIT } from '../shared/ege-mock-result-contract.js';
import {
  assertEgeMockWritingAssessmentRevisionAvailable,
  applyEgeMockWritingAssessmentClaim,
  applyEgeMockWritingAssessmentClaimRenewal,
  applyEgeMockWritingAssessmentFailure,
  applyEgeMockWritingAssessmentItemCompletion,
  applyEgeMockWritingAssessmentItemOutcome,
  applyEgeMockWritingAssessmentItemOutcomePreparation,
} from './writing-assessment.js';

function attemptRow(row) {
  if (!row) return null;
  return {
    ...row,
    form_revision: Number(row.form_revision),
    exam_year: Number(row.exam_year),
    attempt_number: Number(row.attempt_number),
    revision: Number(row.revision),
    assessment_retry_count: Number(row.assessment_retry_count),
  };
}

async function lockOwner(client, username, { requireSubscription = false, missingReturnsNull = false } = {}) {
  const [owner, clock] = await Promise.all([
    client.query(
      'SELECT username, created_at, subscription_until FROM users WHERE username = $1 FOR UPDATE',
      [username],
    ),
    client.query('SELECT clock_timestamp() AS now'),
  ]);
  if (!owner.rowCount) {
    if (missingReturnsNull) return null;
    throw new EgeMockAttemptError('EGE_MOCK_OWNER_NOT_FOUND');
  }
  const now = new Date(clock.rows[0].now);
  if (requireSubscription
    && (!owner.rows[0].subscription_until || new Date(owner.rows[0].subscription_until) <= now)) {
    throw new EgeMockAttemptError('SUBSCRIPTION_REQUIRED');
  }
  return { owner: owner.rows[0], now };
}

async function writeAttempt(client, row) {
  await client.query(
    `UPDATE ege_mock_attempts SET
       state = $2, revision = $3, draft = $4::jsonb,
       written_submitted_at = $5, written_receipt = $6::jsonb,
       oral_available_until = $7, oral_started_at = $8, oral_deadline_at = $9,
       oral_submitted_at = $10, oral_recordings = $11::jsonb, oral_receipt = $12::jsonb,
       oral_progress = $13::jsonb, assessment_status = $14, assessment_retry_count = $15,
       assessment_error_code = $16, result = $17::jsonb,
       writing_assessment = $18::jsonb, speaking_assessment = $19::jsonb, updated_at = $20
     WHERE id = $1`,
    [row.id, row.state, row.revision, JSON.stringify(row.draft || {}), row.written_submitted_at,
      JSON.stringify(row.written_receipt ?? null), row.oral_available_until, row.oral_started_at,
      row.oral_deadline_at, row.oral_submitted_at, JSON.stringify(row.oral_recordings || {}),
      JSON.stringify(row.oral_receipt ?? null),
      row.oral_progress == null ? null : JSON.stringify(row.oral_progress),
      row.assessment_status, row.assessment_retry_count,
      row.assessment_error_code ?? null, JSON.stringify(row.result ?? null),
      row.writing_assessment == null ? null : JSON.stringify(row.writing_assessment),
      row.speaking_assessment == null ? null : JSON.stringify(row.speaking_assessment), row.updated_at],
  );
}

export async function persistEgeMockDerivedProjections(
  client, username, row, { focus = true } = {},
) {
  refreshEgeMockStoredResult(row, getEgeMockForm(row.form_id, row.form_revision));
  if (focus) {
    for (const item of egeMockErrorFocusEntries(
      row, getEgeMockForm(row.form_id, row.form_revision),
    )) {
      await client.query(
        `INSERT INTO error_bank (username, module, item_key, error_type, details,
                                 first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6)
         ON CONFLICT (username, module, item_key, error_type) DO NOTHING`,
        [username, item.module, item.itemKey, item.errorType,
          JSON.stringify(item.details), row.oral_submitted_at],
      );
    }
  }
  await writeAttempt(client, row);
}

async function reconcileAndPersistEgeMockDerivedProjections(client, username, row, now) {
  const reconciled = reconcileEgeMockAttempt(row, now);
  if (reconciled) await persistEgeMockDerivedProjections(client, username, row);
  return reconciled;
}

async function transaction(pool, run) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

async function findMutationReplay(client, username, attemptId, idempotencyKey, operation, requestHash) {
  const start = await client.query(
    `SELECT id FROM ege_mock_attempts
     WHERE username = $1 AND start_idempotency_key = $2`,
    [username, idempotencyKey],
  );
  if (start.rowCount) throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
  const mutation = await client.query(
    `SELECT operation, attempt_id, request_hash, response_snapshot FROM ege_mock_mutations
     WHERE username = $1 AND idempotency_key = $2`,
    [username, idempotencyKey],
  );
  if (!mutation.rowCount) return null;
  const row = mutation.rows[0];
  if (row.attempt_id !== attemptId || row.operation !== operation || row.request_hash !== requestHash) {
    throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
  }
  return structuredClone(row.response_snapshot);
}

async function saveMutation(client, username, attemptId, operation, candidate, response, now) {
  await client.query(
    `INSERT INTO ege_mock_mutations
       (username, idempotency_key, operation, attempt_id, request_hash, response_snapshot, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [username, candidate.idempotencyKey, operation, attemptId, candidate.requestHash,
      JSON.stringify(response), now],
  );
}

async function findAssessmentRunMutation(client, username, attemptId, candidate) {
  const start = await client.query(
    `SELECT id FROM ege_mock_attempts
     WHERE username = $1 AND start_idempotency_key = $2`,
    [username, candidate.idempotencyKey],
  );
  if (start.rowCount) throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
  const result = await client.query(
    `SELECT operation, attempt_id, request_hash, response_snapshot
     FROM ege_mock_mutations
     WHERE username = $1 AND idempotency_key = $2 FOR UPDATE`,
    [username, candidate.idempotencyKey],
  );
  if (!result.rowCount) return null;
  const mutation = result.rows[0];
  if (mutation.attempt_id !== attemptId || mutation.operation !== 'assessment_run'
    || mutation.request_hash !== candidate.requestHash) {
    throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
  }
  return mutation;
}

async function lockedAttempt(client, username, attemptId) {
  const result = await client.query(
    'SELECT * FROM ege_mock_attempts WHERE username = $1 AND id = $2 FOR UPDATE',
    [username, attemptId],
  );
  return attemptRow(result.rows[0]);
}

export function createPostgresEgeMockStore(pool) {
  async function startEgeMockAttempt(username, candidate) {
    return transaction(pool, async (client) => {
      const { owner, now } = await lockOwner(client, username, { requireSubscription: true });
      const existing = await client.query(
        `SELECT * FROM ege_mock_attempts
         WHERE username = $1 AND start_idempotency_key = $2 FOR UPDATE`,
        [username, candidate.idempotencyKey],
      );
      if (existing.rowCount) {
        const row = attemptRow(existing.rows[0]);
        if (row.start_request_hash !== candidate.requestHash) {
          throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
        }
        return {
          created: false,
          replayed: true,
          attempt: structuredClone(row.start_response_attempt || egeMockAttemptPublicDto(row)),
        };
      }
      const mutationReplay = await client.query(
        `SELECT operation, request_hash, response_snapshot FROM ege_mock_mutations
         WHERE username = $1 AND idempotency_key = $2`, [username, candidate.idempotencyKey],
      );
      if (mutationReplay.rowCount) {
        const replay = mutationReplay.rows[0];
        if (replay.operation !== 'start' || replay.request_hash !== candidate.requestHash) {
          throw new EgeMockAttemptError('EGE_MOCK_IDEMPOTENCY_CONFLICT');
        }
        return { ...replay.response_snapshot, replayed: true };
      }
      const form = getEgeMockForm(candidate.formId, candidate.formRevision);
      if (!form || form.fingerprint !== candidate.catalogFingerprint) {
        throw new EgeMockAttemptError('EGE_MOCK_FORM_UNAVAILABLE');
      }
      const attempts = await client.query(
        `SELECT * FROM ege_mock_attempts
         WHERE username = $1 AND form_id = $2 AND form_revision = $3
         ORDER BY attempt_number FOR UPDATE`,
        [username, form.id, form.revision],
      );
      const rows = attempts.rows.map(attemptRow);
      for (const row of rows) {
        await reconcileAndPersistEgeMockDerivedProjections(client, username, row, now);
      }
      const decision = egeMockStartDecision(rows);
      const { active } = decision;
      if (active) {
        const response = {
          created: false, replayed: false, resumed: true,
          attempt: egeMockAttemptPublicDto(active),
        };
        await saveMutation(client, username, active.id, 'start', candidate, response, now);
        return response;
      }
      const attempt = createEgeMockAttempt({
        id: crypto.randomUUID(), username,
        ownerGeneration: `account:${new Date(owner.created_at).toISOString()}`,
        form, mode: decision.mode, attemptNumber: decision.attemptNumber,
        idempotencyKey: candidate.idempotencyKey, requestHash: candidate.requestHash, now,
      });
      await client.query(
        `INSERT INTO ege_mock_attempts
          (id, username, owner_generation, policy_id, form_id, form_revision, exam_year,
           catalog_fingerprint, mode, attempt_number, state, revision, draft,
           written_started_at, written_deadline_at, oral_recordings, assessment_status,
           assessment_retry_count, start_idempotency_key, start_request_hash,
           start_response_attempt, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,'{}'::jsonb,$16,$17,$18,$19,$20::jsonb,$21,$22)`,
        [attempt.id, username, attempt.owner_generation, attempt.policy_id, attempt.form_id,
          attempt.form_revision, attempt.exam_year, attempt.catalog_fingerprint, attempt.mode,
          attempt.attempt_number, attempt.state, attempt.revision, JSON.stringify(attempt.draft),
          attempt.written_started_at, attempt.written_deadline_at, attempt.assessment_status,
          attempt.assessment_retry_count, attempt.start_idempotency_key, attempt.start_request_hash,
          JSON.stringify(attempt.start_response_attempt), attempt.created_at, attempt.updated_at],
      );
      return { created: true, replayed: false, attempt: egeMockAttemptPublicDto(attempt) };
    });
  }

  async function getEgeMockAttempt(username, attemptId, { now: suppliedNow } = {}) {
    return transaction(pool, async (client) => {
      const locked = await lockOwner(client, username, { missingReturnsNull: true });
      if (!locked) return null;
      const now = typeof suppliedNow === 'function' ? new Date(suppliedNow()) : locked.now;
      if (!Number.isFinite(now.getTime())) throw new EgeMockAttemptError('EGE_MOCK_TIME_INVALID');
      const row = await lockedAttempt(client, username, attemptId);
      if (row) await reconcileAndPersistEgeMockDerivedProjections(client, username, row, now);
      return egeMockAttemptPublicDto(row);
    });
  }

  async function getCurrentEgeMockAttempt(username) {
    return transaction(pool, async (client) => {
      const locked = await lockOwner(client, username, { missingReturnsNull: true });
      if (!locked) return null;
      const { now } = locked;
      const result = await client.query(
        `SELECT * FROM ege_mock_attempts WHERE username = $1
         ORDER BY created_at DESC, id DESC FOR UPDATE`, [username],
      );
      const rows = result.rows.map(attemptRow);
      for (const row of rows) {
        await reconcileAndPersistEgeMockDerivedProjections(client, username, row, now);
      }
      return egeMockAttemptPublicDto(egeMockStartDecision(rows).active);
    });
  }

  async function mutate(username, attemptId, operation, candidate, apply, { now: suppliedNow } = {}) {
    const outcome = await transaction(pool, async (client) => {
      const { now: databaseNow } = await lockOwner(client, username, { requireSubscription: true });
      const now = typeof suppliedNow === 'function' ? new Date(suppliedNow()) : databaseNow;
      if (!Number.isFinite(now.getTime())) throw new EgeMockAttemptError('EGE_MOCK_TIME_INVALID');
      const replay = await findMutationReplay(
        client, username, attemptId, candidate.idempotencyKey, operation, candidate.requestHash,
      );
      if (replay) return { ...replay, replayed: true };
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const settlementDeferred = shouldSettleEgeMockOralStageBeforeReconcile(
        row, operation, candidate, now,
      );
      const reconciled = settlementDeferred ? false
        : await reconcileAndPersistEgeMockDerivedProjections(client, username, row, now);
      let result;
      try {
        result = await apply(row, now, reconciled);
      } catch (error) {
        const reconciledAfterRejectedSettlement = settlementDeferred
          ? await reconcileAndPersistEgeMockDerivedProjections(client, username, row, now)
          : false;
        if (!reconciled && !reconciledAfterRejectedSettlement) throw error;
        return { deferredError: error };
      }
      await persistEgeMockDerivedProjections(client, username, row);
      await saveMutation(client, username, row.id, operation, candidate, result, now);
      return result;
    });
    if (outcome?.deferredError) throw outcome.deferredError;
    return outcome;
  }

  const saveEgeMockDraft = (username, attemptId, candidate, options = {}) => mutate(
    username, attemptId, 'draft', candidate, (row, now) => applyEgeMockDraftMutation(row, {
      form: getEgeMockForm(row.form_id, row.form_revision),
      expectedRevision: candidate.expectedRevision,
      answers: candidate.answers,
      now,
    }), options,
  );

  const submitEgeMockWritten = (username, attemptId, candidate) => mutate(
    username, attemptId, 'written_submit', candidate,
    (row, now, reconciled) => applyEgeMockWrittenMutation(row, {
      expectedRevision: candidate.expectedRevision,
      now,
      receiptId: crypto.randomUUID(),
      reconciled,
    }),
  );

  const startEgeMockOral = (username, attemptId, candidate) => mutate(
    username, attemptId, 'oral_start', candidate, (row, now) => (
      applyEgeMockOralStartMutation(row, {
        expectedRevision: candidate.expectedRevision,
        now,
        form: getEgeMockForm(row.form_id, row.form_revision),
      })
    ),
  );

  const submitEgeMockOral = (username, attemptId, candidate) => mutate(
    username, attemptId, 'oral_submit', candidate,
    (row, now, reconciled) => applyEgeMockOralMutation(row, {
      expectedRevision: candidate.expectedRevision,
      recordings: candidate.recordings,
      now,
      receiptId: crypto.randomUUID(),
      reconciled,
    }),
  );

  const advanceEgeMockOralStage = (username, attemptId, candidate, options = {}) => mutate(
    username, attemptId, 'oral_stage', candidate,
    (row, now) => applyEgeMockOralStageMutation(row, {
      form: getEgeMockForm(row.form_id, row.form_revision),
      expectedRevision: candidate.expectedRevision,
      action: candidate.action,
      position: candidate.position,
      responseNumber: candidate.responseNumber,
      recording: candidate.recording,
      now,
    }), options,
  );

  async function getEgeMockResult(username, attemptId) {
    const result = await pool.query(
      'SELECT * FROM ege_mock_attempts WHERE username = $1 AND id = $2',
      [username, attemptId],
    );
    return egeMockResultPublicDto(attemptRow(result.rows[0]));
  }

  async function getEgeMockHistory(username, {
    now: suppliedNow, includeAttemptId = null,
  } = {}) {
    return transaction(pool, async (client) => {
      const locked = await lockOwner(client, username, { missingReturnsNull: true });
      if (!locked) return { baselineAttemptId: null, attempts: [] };
      const now = typeof suppliedNow === 'function' ? new Date(suppliedNow()) : locked.now;
      if (!Number.isFinite(now.getTime())) throw new EgeMockAttemptError('EGE_MOCK_TIME_INVALID');
      const active = await client.query(
        `SELECT * FROM ege_mock_attempts
         WHERE username = $1 AND oral_submitted_at IS NULL
           AND state NOT IN ('expired', 'completed')
         ORDER BY created_at DESC, id DESC FOR UPDATE`,
        [username],
      );
      for (const row of active.rows.map(attemptRow)) {
        await reconcileAndPersistEgeMockDerivedProjections(client, username, row, now);
      }
      const result = await client.query(
        `SELECT * FROM ege_mock_attempts
         WHERE username = $1 AND id IN (
           (SELECT id FROM ege_mock_attempts
            WHERE username = $1 AND oral_submitted_at IS NOT NULL
              AND state IN ('assessment_pending', 'completed')
            ORDER BY created_at DESC, id DESC LIMIT $2)
           UNION
           (SELECT id FROM ege_mock_attempts
            WHERE username = $1 AND oral_submitted_at IS NULL
              AND state NOT IN ('expired', 'completed')
            ORDER BY created_at DESC, id DESC LIMIT 1)
           UNION
           (SELECT id FROM ege_mock_attempts
            WHERE username = $1 AND mode = 'diagnostic' AND oral_submitted_at IS NOT NULL
              AND state IN ('assessment_pending', 'completed')
            ORDER BY created_at, id LIMIT 1)
         )
         ORDER BY created_at DESC, id DESC`,
        [username, EGE_MOCK_RESULT_HISTORY_LIMIT],
      );
      const rows = result.rows.map(attemptRow);
      if (includeAttemptId && !rows.some(({ id }) => id === includeAttemptId)) {
        const included = await client.query(
          `SELECT * FROM ege_mock_attempts
           WHERE username = $1 AND id = $2 AND oral_submitted_at IS NOT NULL
             AND state IN ('assessment_pending', 'completed')
           LIMIT 1`,
          [username, includeAttemptId],
        );
        if (included.rows[0]) rows.push(attemptRow(included.rows[0]));
      }
      return buildEgeMockHistory(rows, getEgeMockForm, { includeAttemptId });
    });
  }

  async function beginEgeMockAssessmentRun(username, attemptId, candidate) {
    return transaction(pool, async (client) => {
      const { owner, now } = await lockOwner(client, username);
      const existing = await findAssessmentRunMutation(client, username, attemptId, candidate);
      if (existing && existing.response_snapshot?.commandStatus !== 'pending') {
        const replay = egeMockAssessmentRunBeginDecision({
          responseSnapshot: existing.response_snapshot,
        });
        return { finalized: replay.finalized, response: replay.response };
      }
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const reconciled = await reconcileAndPersistEgeMockDerivedProjections(
        client, username, row, now,
      );
      if (!row.writing_assessment) {
        throw new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_STATE_INVALID');
      }
      const publicAttempt = egeMockAttemptPublicDto(row);
      if (!egeMockAssessmentRunCanSettleTerminalSnapshot({
        responseSnapshot: existing?.response_snapshot || null,
        attempt: publicAttempt,
      })) assertEgeMockWritingAssessmentRevisionAvailable(row.writing_assessment);
      const decision = egeMockAssessmentRunBeginDecision({
        responseSnapshot: existing?.response_snapshot || null,
        attempt: publicAttempt,
        subscriptionActive: Boolean(owner.subscription_until)
          && new Date(owner.subscription_until) > now,
        hasFrozenAuthorization: Boolean(row.writing_assessment.authorization),
        explicitRenewal: candidate.explicitRenewal === true,
      });
      const dispositionChanged = applyEgeMockAssessmentRunDisposition(row, decision, { now });
      if (dispositionChanged) await writeAttempt(client, row);
      if (decision.kind === 'start') {
        await saveMutation(
          client, username, attemptId, 'assessment_run', candidate, decision.responseSnapshot, now,
        );
      } else if (decision.kind === 'finalize') {
        if (existing) {
          await client.query(
            `UPDATE ege_mock_mutations SET response_snapshot = $4::jsonb
             WHERE username = $1 AND idempotency_key = $2 AND operation = $3`,
            [username, candidate.idempotencyKey, 'assessment_run',
              JSON.stringify(decision.responseSnapshot)],
          );
        } else {
          await saveMutation(
            client, username, attemptId, 'assessment_run', candidate, decision.responseSnapshot, now,
          );
        }
      }
      return decision.finalized
        ? { finalized: true, response: decision.response }
        : { finalized: false };
    });
  }

  async function settleEgeMockAssessmentRun(username, attemptId, candidate) {
    return transaction(pool, async (client) => {
      const { now } = await lockOwner(client, username);
      const mutation = await findAssessmentRunMutation(client, username, attemptId, candidate);
      if (!mutation) throw new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_STATE_INVALID');
      if (mutation.response_snapshot?.commandStatus !== 'pending') {
        return egeMockAssessmentRunSettlement({
          responseSnapshot: mutation.response_snapshot,
        }).response;
      }
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const reconciled = await reconcileAndPersistEgeMockDerivedProjections(
        client, username, row, now,
      );
      const publicAttempt = egeMockAttemptPublicDto(row);
      const decision = egeMockAssessmentRunSettlement({
        responseSnapshot: mutation.response_snapshot,
        attempt: publicAttempt,
        attemptChanged: reconciled,
      });
      if (decision.persistAttempt) await writeAttempt(client, row);
      if (decision.kind === 'finalize') {
        await client.query(
          `UPDATE ege_mock_mutations SET response_snapshot = $4::jsonb
           WHERE username = $1 AND idempotency_key = $2 AND operation = $3`,
          [username, candidate.idempotencyKey, 'assessment_run', JSON.stringify(decision.response)],
        );
      }
      return decision.response;
    });
  }

  async function markEgeMockAssessmentRetryable(username, attemptId, { reason } = {}) {
    return transaction(pool, async (client) => {
      const { now } = await lockOwner(client, username);
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_STATE_INVALID');
      const response = applyEgeMockAssessmentRetryable(row, { reason, now });
      await persistEgeMockDerivedProjections(client, username, row);
      return response;
    });
  }

  async function claimEgeMockWritingAssessment(username, attemptId, {
    claimToken, authorization = null,
  } = {}) {
    return transaction(pool, async (client) => {
      const { owner, now } = await lockOwner(client, username);
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      let frozenAuthorization = authorization;
      if (!row.writing_assessment?.authorization) {
        if (!owner.subscription_until || new Date(owner.subscription_until) <= now) {
          throw new EgeMockAttemptError('SUBSCRIPTION_REQUIRED');
        }
        const requiredPolicyVersion = typeof authorization?.consentPolicyVersion === 'string'
          && authorization.consentPolicyVersion ? authorization.consentPolicyVersion : null;
        const consent = await client.query(
          `SELECT text_processing, policy_version
           FROM privacy_consents WHERE username = $1 FOR UPDATE`,
          [username],
        );
        const currentConsent = consent.rows[0] || null;
        frozenAuthorization = {
          textProcessingConsent: requiredPolicyVersion != null
            && currentConsent?.text_processing === true
            && currentConsent.policy_version === requiredPolicyVersion,
          consentPolicyVersion: requiredPolicyVersion,
          subscriptionExpiresAt: new Date(owner.subscription_until).toISOString(),
        };
      }
      await reconcileAndPersistEgeMockDerivedProjections(client, username, row, now);
      const response = applyEgeMockWritingAssessmentClaim(row, {
        form: getEgeMockForm(row.form_id, row.form_revision), claimToken,
        authorization: frozenAuthorization, now,
      });
      await persistEgeMockDerivedProjections(client, username, row, { focus: false });
      return response;
    });
  }

  async function renewEgeMockWritingAssessmentClaim(username, attemptId, { claimToken } = {}) {
    return transaction(pool, async (client) => {
      const { now } = await lockOwner(client, username);
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const response = applyEgeMockWritingAssessmentClaimRenewal(row, { claimToken, now });
      await persistEgeMockDerivedProjections(client, username, row, { focus: false });
      return response;
    });
  }

  async function completeEgeMockWritingAssessmentItem(username, attemptId, candidate = {}) {
    return transaction(pool, async (client) => {
      const { now } = await lockOwner(client, username);
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const response = applyEgeMockWritingAssessmentItemCompletion(row, { ...candidate, now });
      await persistEgeMockDerivedProjections(client, username, row);
      return response;
    });
  }

  async function prepareEgeMockWritingAssessmentItemOutcome(username, attemptId, candidate = {}) {
    return transaction(pool, async (client) => {
      const { now } = await lockOwner(client, username);
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const response = applyEgeMockWritingAssessmentItemOutcomePreparation(row, {
        ...candidate, now,
      });
      await persistEgeMockDerivedProjections(client, username, row, { focus: false });
      return response;
    });
  }

  async function recordEgeMockWritingAssessmentItemOutcome(username, attemptId, candidate = {}) {
    return transaction(pool, async (client) => {
      const { now } = await lockOwner(client, username);
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const response = applyEgeMockWritingAssessmentItemOutcome(row, { ...candidate, now });
      await persistEgeMockDerivedProjections(client, username, row);
      return response;
    });
  }

  async function failEgeMockWritingAssessment(username, attemptId, candidate = {}) {
    return transaction(pool, async (client) => {
      const { now } = await lockOwner(client, username);
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const response = applyEgeMockWritingAssessmentFailure(row, { ...candidate, now });
      await persistEgeMockDerivedProjections(client, username, row);
      return response;
    });
  }

  const retryEgeMockAssessment = (username, attemptId, candidate) => mutate(
    username, attemptId, 'assessment_retry', candidate,
    (row, now) => applyEgeMockAssessmentRetryMutation(row, {
      now,
      acknowledgePossibleProviderRepeat: candidate?.acknowledgePossibleProviderRepeat,
    }),
  );

  async function exportEgeMockAttempts(username) {
    return transaction(pool, async (client) => {
      const locked = await lockOwner(client, username, { missingReturnsNull: true });
      if (!locked) return [];
      const result = await client.query(
        `SELECT * FROM ege_mock_attempts
         WHERE username = $1 ORDER BY created_at, id FOR UPDATE`, [username],
      );
      const rows = result.rows.map(attemptRow);
      for (const row of rows) {
        await reconcileAndPersistEgeMockDerivedProjections(client, username, row, locked.now);
      }
      return rows.map(egeMockAttemptExportDto);
    });
  }

  return {
    startEgeMockAttempt,
    getCurrentEgeMockAttempt,
    getEgeMockAttempt,
    saveEgeMockDraft,
    submitEgeMockWritten,
    startEgeMockOral,
    advanceEgeMockOralStage,
    submitEgeMockOral,
    getEgeMockResult,
    getEgeMockHistory,
    beginEgeMockAssessmentRun,
    settleEgeMockAssessmentRun,
    markEgeMockAssessmentRetryable,
    claimEgeMockWritingAssessment,
    renewEgeMockWritingAssessmentClaim,
    prepareEgeMockWritingAssessmentItemOutcome,
    recordEgeMockWritingAssessmentItemOutcome,
    completeEgeMockWritingAssessmentItem,
    failEgeMockWritingAssessment,
    retryEgeMockAssessment,
    exportEgeMockAttempts,
  };
}
