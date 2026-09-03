ALTER TABLE voice_tutor_sessions
  ADD COLUMN IF NOT EXISTS clarification_turns INTEGER NOT NULL DEFAULT 0
    CHECK (clarification_turns BETWEEN 0 AND 3);

-- Older rows stored the complete teaching payload. Retain only a server-owned
-- pointer; route code reconstructs canonical prompts, answers and rubrics.
UPDATE voice_tutor_sessions
SET capsule = jsonb_strip_nulls(jsonb_build_object(
  'schema', 'voice-tutor-reference-legacy-v1',
  'id', capsule->'id',
  'version', capsule->'version',
  'source', capsule->'source',
  'module', capsule->'module',
  'skill_id', capsule#>'{skill,id}',
  'rule_card_id', capsule->'rule_card_id'
))
WHERE capsule IS NOT NULL
  AND COALESCE(capsule->>'schema', '') NOT IN ('voice-tutor-reference-v1', 'voice-tutor-reference-legacy-v1');

CREATE TABLE IF NOT EXISTS voice_tutor_reports (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES voice_tutor_sessions(id) ON DELETE CASCADE,
  rule_card_id UUID REFERENCES trusted_rule_cards(id) ON DELETE SET NULL,
  reason VARCHAR(32) NOT NULL
    CHECK (reason IN ('incorrect_rule', 'unclear_explanation', 'bad_example', 'technical_issue')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  review_audit JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  UNIQUE (username, session_id, reason)
);

CREATE INDEX IF NOT EXISTS voice_tutor_reports_review_queue_idx
  ON voice_tutor_reports (status, created_at);
