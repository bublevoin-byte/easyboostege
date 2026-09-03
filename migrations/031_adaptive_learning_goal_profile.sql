ALTER TABLE module_attempts
  ADD COLUMN IF NOT EXISTS evidence_quality VARCHAR(40) NOT NULL DEFAULT 'client_reported'
  CHECK (evidence_quality IN ('client_reported', 'server_verified_assisted', 'server_verified_unassisted'));

CREATE TABLE IF NOT EXISTS adaptive_learning_goals (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  target_exam VARCHAR(24) NOT NULL CHECK (target_exam = 'ege_english'),
  target_score SMALLINT NOT NULL CHECK (target_score BETWEEN 0 AND 100),
  exam_date DATE NOT NULL,
  weekly_minutes SMALLINT NOT NULL CHECK (weekly_minutes BETWEEN 30 AND 2520 AND weekly_minutes % 5 = 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  idempotency_key VARCHAR(120) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  current BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (username, revision),
  UNIQUE (username, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS adaptive_learning_goals_current_idx
  ON adaptive_learning_goals (username) WHERE current;

CREATE TABLE IF NOT EXISTS adaptive_learning_profiles (
  username VARCHAR(64) PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
  taxonomy_version VARCHAR(40) NOT NULL,
  weighting_version VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('preliminary', 'established')),
  preliminary BOOLEAN NOT NULL,
  confidence SMALLINT NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
  independent_evidence_count INTEGER NOT NULL CHECK (independent_evidence_count >= 0),
  assisted_evidence_count INTEGER NOT NULL CHECK (assisted_evidence_count >= 0),
  client_reported_evidence_count INTEGER NOT NULL CHECK (client_reported_evidence_count >= 0),
  independent_module_count SMALLINT NOT NULL CHECK (independent_module_count BETWEEN 0 AND 6),
  established_skill_count SMALLINT NOT NULL CHECK (established_skill_count BETWEEN 0 AND 12),
  profile_calculation_revision INTEGER NOT NULL CHECK (profile_calculation_revision > 0),
  evidence_watermark_version VARCHAR(40) NOT NULL,
  evidence_observed_at TIMESTAMPTZ,
  evidence_source_count INTEGER NOT NULL CHECK (evidence_source_count >= 0),
  needs_diagnostic BOOLEAN NOT NULL,
  explanation_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS adaptive_learning_skill_estimates (
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  taxonomy_version VARCHAR(40) NOT NULL,
  skill_id VARCHAR(120) NOT NULL,
  module VARCHAR(24) NOT NULL CHECK (module IN ('grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking')),
  mastery SMALLINT NOT NULL CHECK (mastery BETWEEN 0 AND 100),
  uncertainty SMALLINT NOT NULL CHECK (uncertainty BETWEEN 0 AND 100),
  evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
  effective_evidence_count INTEGER NOT NULL CHECK (effective_evidence_count >= 0),
  independent_evidence_count INTEGER NOT NULL CHECK (independent_evidence_count >= 0),
  evidence_quality VARCHAR(20) NOT NULL CHECK (evidence_quality IN ('none', 'client_reported', 'assisted', 'independent', 'mixed')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('unobserved', 'preliminary', 'established')),
  last_observed_at TIMESTAMPTZ,
  due_state VARCHAR(20) NOT NULL CHECK (due_state IN ('not_due', 'due', 'overdue')),
  explanation_code VARCHAR(40) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (username, skill_id)
);

CREATE INDEX IF NOT EXISTS adaptive_learning_estimates_priority_idx
  ON adaptive_learning_skill_estimates (username, uncertainty DESC, mastery ASC);
