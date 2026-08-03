ALTER TABLE voice_tutor_sessions
  ADD COLUMN IF NOT EXISTS proxy_ticket_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS proxy_ticket_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proxy_ticket_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proxy_ticket_consumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proxy_ticket_reissue_count INTEGER NOT NULL DEFAULT 0
    CHECK (proxy_ticket_reissue_count BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS proxy_input_audio_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS proxy_output_audio_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS proxy_usage_confirmed BOOLEAN,
  ADD COLUMN IF NOT EXISTS proxy_finalization_reason VARCHAR(64),
  ADD COLUMN IF NOT EXISTS proxy_finalized_at TIMESTAMPTZ;

ALTER TABLE voice_tutor_sessions DROP CONSTRAINT IF EXISTS voice_tutor_proxy_ticket_shape;
ALTER TABLE voice_tutor_sessions ADD CONSTRAINT voice_tutor_proxy_ticket_shape CHECK (
  (proxy_ticket_hash IS NULL AND proxy_ticket_issued_at IS NULL AND proxy_ticket_expires_at IS NULL
    AND proxy_ticket_consumed_at IS NULL)
  OR
  (proxy_ticket_hash ~ '^[a-f0-9]{64}$' AND proxy_ticket_issued_at IS NOT NULL
    AND proxy_ticket_expires_at > proxy_ticket_issued_at
    AND (proxy_ticket_consumed_at IS NULL OR proxy_ticket_consumed_at >= proxy_ticket_issued_at))
);

ALTER TABLE voice_tutor_sessions DROP CONSTRAINT IF EXISTS voice_tutor_proxy_usage_shape;
ALTER TABLE voice_tutor_sessions ADD CONSTRAINT voice_tutor_proxy_usage_shape CHECK (
  (proxy_finalized_at IS NULL AND proxy_input_audio_bytes IS NULL AND proxy_output_audio_bytes IS NULL
    AND proxy_usage_confirmed IS NULL AND proxy_finalization_reason IS NULL)
  OR
  (proxy_finalized_at IS NOT NULL AND proxy_input_audio_bytes >= 0 AND proxy_output_audio_bytes >= 0
    AND proxy_usage_confirmed IS NOT NULL
    AND proxy_finalization_reason ~ '^[a-z][a-z0-9_]{0,63}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_tutor_proxy_ticket_hash_unique
  ON voice_tutor_sessions (proxy_ticket_hash)
  WHERE proxy_ticket_hash IS NOT NULL;

WITH ranked_approved AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY skill_id, exam_year
           ORDER BY reviewed_at DESC NULLS LAST, created_at DESC, id DESC
         ) AS canonical_rank
  FROM trusted_rule_cards
  WHERE status = 'approved'
)
UPDATE trusted_rule_cards card
SET status = 'rejected',
    review_audit = card.review_audit || jsonb_build_array(jsonb_build_object(
      'reviewer', NULL,
      'decision', 'rejected',
      'reviewed_at', COALESCE(card.reviewed_at, card.created_at),
      'reason', 'canonical_deduplicated_by_migration_029'
    ))
FROM ranked_approved ranked
WHERE card.id = ranked.id AND ranked.canonical_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS trusted_rule_cards_one_approved_per_skill_year
  ON trusted_rule_cards (skill_id, exam_year)
  WHERE status = 'approved';
