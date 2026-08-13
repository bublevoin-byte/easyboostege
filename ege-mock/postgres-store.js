import crypto from 'node:crypto';

import {
  applyEgeMockAssessmentRetryable,
  applyEgeMockAssessmentRetryMutation,
  applyEgeMockDraftMutation,
  applyEgeMockOralMutation,
  applyEgeMockOralStartMutation,
  applyEgeMockWrittenMutation,
  createEgeMockAttempt,
  egeMockAttemptExportDto,
  egeMockAttemptPublicDto,
  EgeMockAttemptError,
  egeMockResultPublicDto,
  egeMockStartDecision,
  reconcileEgeMockAttempt,
} from './attempt.js';
import { getEgeMockForm } from './catalog.js';

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
       assessment_status = $13, assessment_retry_count = $14,
       assessment_error_code = $15, result = $16::jsonb, updated_at = $17
     WHERE id = $1`,
    [row.id, row.state, row.revision, JSON.stringify(row.draft || {}), row.written_submitted_at,
      JSON.stringify(row.written_receipt ?? null), row.oral_available_until, row.oral_started_at,
      row.oral_deadline_at, row.oral_submitted_at, JSON.stringify(row.oral_recordings || {}),
      JSON.stringify(row.oral_receipt ?? null), row.assessment_status, row.assessment_retry_count,
      row.assessment_error_code ?? null, JSON.stringify(row.result ?? null), row.updated_at],
  );
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
        if (reconcileEgeMockAttempt(row, now)) await writeAttempt(client, row);
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

  async function getEgeMockAttempt(username, attemptId) {
    return transaction(pool, async (client) => {
      const locked = await lockOwner(client, username, { missingReturnsNull: true });
      if (!locked) return null;
      const { now } = locked;
      const row = await lockedAttempt(client, username, attemptId);
      if (row && reconcileEgeMockAttempt(row, now)) await writeAttempt(client, row);
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
      let changed = false;
      const rows = result.rows.map(attemptRow);
      for (const row of rows) changed = reconcileEgeMockAttempt(row, now) || changed;
      if (changed) for (const row of rows) await writeAttempt(client, row);
      return egeMockAttemptPublicDto(egeMockStartDecision(rows).active);
    });
  }

  async function mutate(username, attemptId, operation, candidate, apply) {
    const outcome = await transaction(pool, async (client) => {
      const { now } = await lockOwner(client, username, { requireSubscription: true });
      const replay = await findMutationReplay(
        client, username, attemptId, candidate.idempotencyKey, operation, candidate.requestHash,
      );
      if (replay) return { ...replay, replayed: true };
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ATTEMPT_NOT_FOUND');
      const reconciled = reconcileEgeMockAttempt(row, now);
      let result;
      try {
        result = await apply(row, now, reconciled);
      } catch (error) {
        if (!reconciled) throw error;
        await writeAttempt(client, row);
        return { deferredError: error };
      }
      await writeAttempt(client, row);
      await saveMutation(client, username, row.id, operation, candidate, result, now);
      return result;
    });
    if (outcome?.deferredError) throw outcome.deferredError;
    return outcome;
  }

  const saveEgeMockDraft = (username, attemptId, candidate) => mutate(
    username, attemptId, 'draft', candidate, (row, now) => applyEgeMockDraftMutation(row, {
      form: getEgeMockForm(row.form_id, row.form_revision),
      expectedRevision: candidate.expectedRevision,
      answers: candidate.answers,
      now,
    }),
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
      applyEgeMockOralStartMutation(row, { expectedRevision: candidate.expectedRevision, now })
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

  async function getEgeMockResult(username, attemptId) {
    return transaction(pool, async (client) => {
      const locked = await lockOwner(client, username, { missingReturnsNull: true });
      if (!locked) return null;
      const { now } = locked;
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) return null;
      if (reconcileEgeMockAttempt(row, now)) await writeAttempt(client, row);
      return egeMockResultPublicDto(row);
    });
  }

  async function markEgeMockAssessmentRetryable(username, attemptId, { reason } = {}) {
    return transaction(pool, async (client) => {
      const { now } = await lockOwner(client, username);
      const row = await lockedAttempt(client, username, attemptId);
      if (!row) throw new EgeMockAttemptError('EGE_MOCK_ASSESSMENT_STATE_INVALID');
      const response = applyEgeMockAssessmentRetryable(row, { reason, now });
      await writeAttempt(client, row);
      return response;
    });
  }

  const retryEgeMockAssessment = (username, attemptId, candidate) => mutate(
    username, attemptId, 'assessment_retry', candidate,
    (row, now) => applyEgeMockAssessmentRetryMutation(row, { now }),
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
        if (reconcileEgeMockAttempt(row, locked.now)) await writeAttempt(client, row);
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
    submitEgeMockOral,
    getEgeMockResult,
    markEgeMockAssessmentRetryable,
    retryEgeMockAssessment,
    exportEgeMockAttempts,
  };
}
