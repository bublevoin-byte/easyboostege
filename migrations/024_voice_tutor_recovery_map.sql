ALTER TABLE voice_tutor_sessions
  ADD COLUMN IF NOT EXISTS micro_check_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (micro_check_attempts BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS micro_check_passes SMALLINT NOT NULL DEFAULT 0 CHECK (micro_check_passes BETWEEN 0 AND micro_check_attempts);

CREATE TABLE IF NOT EXISTS voice_tutor_recoveries (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  session_id UUID NOT NULL UNIQUE REFERENCES voice_tutor_sessions(id) ON DELETE CASCADE,
  skill_id VARCHAR(120) NOT NULL,
  skill_label VARCHAR(160) NOT NULL,
  module VARCHAR(24) NOT NULL CHECK (module IN ('grammar', 'vocabulary', 'reading', 'listening', 'writing', 'speaking')),
  rule_id VARCHAR(160) NOT NULL,
  origin_item_id VARCHAR(160) NOT NULL,
  origin_transfer_task_id VARCHAR(160) NOT NULL,
  initial_micro_check_passed BOOLEAN NOT NULL,
  initial_transfer_passed BOOLEAN NOT NULL,
  terminal_outcome VARCHAR(20) NOT NULL CHECK (terminal_outcome IN ('resolved', 'fallback')),
  potential_ege_points SMALLINT NOT NULL CHECK (potential_ege_points BETWEEN 0 AND 2),
  observed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS voice_tutor_recoveries_user_skill_idx
  ON voice_tutor_recoveries (username, skill_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS voice_tutor_repeats (
  id UUID PRIMARY KEY,
  recovery_id UUID NOT NULL REFERENCES voice_tutor_recoveries(id) ON DELETE CASCADE,
  stage VARCHAR(8) NOT NULL CHECK (stage IN ('day_1', 'day_7')),
  task_id VARCHAR(180) NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  window_ends_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ,
  UNIQUE (recovery_id, stage),
  CHECK (window_ends_at > due_at)
);

CREATE INDEX IF NOT EXISTS voice_tutor_repeats_due_idx
  ON voice_tutor_repeats (due_at) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS voice_tutor_repeat_attempts (
  id UUID PRIMARY KEY,
  repeat_id UUID NOT NULL UNIQUE REFERENCES voice_tutor_repeats(id) ON DELETE CASCADE,
  task_id VARCHAR(180) NOT NULL,
  passed BOOLEAN NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL
);
