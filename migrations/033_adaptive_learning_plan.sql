CREATE TABLE IF NOT EXISTS adaptive_learning_plan_revisions (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  plan_version VARCHAR(40) NOT NULL CHECK (plan_version = 'adaptive-plan-v1'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  base_plan_revision INTEGER CHECK (
    base_plan_revision IS NULL OR (base_plan_revision > 0 AND base_plan_revision < revision)
  ),
  goal_id UUID NOT NULL REFERENCES adaptive_learning_goals(id) ON DELETE CASCADE,
  goal_revision INTEGER NOT NULL CHECK (goal_revision > 0),
  taxonomy_version VARCHAR(40) NOT NULL,
  profile_calculation_revision INTEGER NOT NULL CHECK (profile_calculation_revision > 0),
  profile_evidence_watermark_version VARCHAR(40) NOT NULL,
  profile_evidence_observed_at TIMESTAMPTZ,
  profile_evidence_source_count INTEGER NOT NULL CHECK (profile_evidence_source_count >= 0),
  recalculation_bucket DATE NOT NULL,
  input_fingerprint CHAR(64) NOT NULL,
  forecast JSONB NOT NULL,
  allocation JSONB NOT NULL,
  stability JSONB NOT NULL,
  current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (username, revision),
  UNIQUE (username, input_fingerprint)
);

CREATE UNIQUE INDEX IF NOT EXISTS adaptive_learning_plan_current_owner_idx
  ON adaptive_learning_plan_revisions (username) WHERE current;

CREATE INDEX IF NOT EXISTS adaptive_learning_plan_owner_created_idx
  ON adaptive_learning_plan_revisions (username, created_at DESC);
