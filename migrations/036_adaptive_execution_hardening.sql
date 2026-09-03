ALTER TABLE adaptive_learning_execution_claims
  ADD COLUMN IF NOT EXISTS evidence_context VARCHAR(32)
    CHECK (evidence_context IN ('exam_practice', 'planned_practice', 'scheduled_review', 'ai_assisted_review'));

ALTER TABLE adaptive_learning_session_events
  ADD COLUMN IF NOT EXISTS evidence_context VARCHAR(32)
    CHECK (evidence_context IN ('exam_practice', 'planned_practice', 'scheduled_review', 'ai_assisted_review'));

-- Migration 035 stored the random bearer itself in start response snapshots. Those tokens cannot
-- be reconstructed after the HMAC upgrade, and consumed Writing/Speaking claims lack the exact-task
-- columns introduced below. Revoke every legacy claim, consumed or not, so an interrupted block can
-- safely restart. A rerun preserves post-upgrade claims linked to a claim-id-only HMAC snapshot.
UPDATE adaptive_learning_execution_claims claim
SET consumed_at = NULL,
    attempt_type = NULL,
    attempt_ref = NULL,
    revoked_at = NOW()
WHERE claim.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM adaptive_learning_session_mutations mutation
    WHERE mutation.username = claim.username
      AND mutation.session_id = claim.session_id
      AND mutation.operation = 'start'
      AND NOT (mutation.response_snapshot ? 'executionClaim')
      AND mutation.response_snapshot->>'executionClaimId' = claim.id::text
  );

DELETE FROM adaptive_learning_session_mutations
WHERE operation = 'start'
  AND (
    response_snapshot ? 'executionClaim'
    OR (
      NOT (response_snapshot ? 'executionClaimId')
      AND NOT (
        response_snapshot ? 'recoveryAttempt'
        AND response_snapshot ? 'session'
        AND response_snapshot ? 'execution'
        AND response_snapshot ? 'block'
        AND response_snapshot ? 'launch'
        AND jsonb_typeof(response_snapshot->'recoveryAttempt') = 'object'
        AND response_snapshot->'recoveryAttempt'->>'type' IN ('module', 'writing', 'speaking')
      )
    )
  );

ALTER TABLE writing_attempts
  ADD COLUMN IF NOT EXISTS source_task_ref VARCHAR(240);

ALTER TABLE speaking_attempts
  ADD COLUMN IF NOT EXISTS assignment_fingerprint CHAR(64);

CREATE INDEX IF NOT EXISTS writing_attempts_adaptive_source_idx
  ON writing_attempts (username, source_task_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS speaking_attempts_adaptive_assignment_idx
  ON speaking_attempts (username, assignment_fingerprint, created_at DESC);
