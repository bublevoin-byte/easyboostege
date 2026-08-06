CREATE TABLE IF NOT EXISTS speaking_full_sessions (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  mode VARCHAR(24) NOT NULL CHECK (mode = 'full_section'),
  format_id VARCHAR(80) NOT NULL,
  format_revision INTEGER NOT NULL CHECK (format_revision > 0),
  catalog_id VARCHAR(80) NOT NULL,
  catalog_revision INTEGER NOT NULL CHECK (catalog_revision > 0),
  variant_index INTEGER NOT NULL CHECK (variant_index BETWEEN 0 AND 59),
  selection_reason VARCHAR(20) NOT NULL CHECK (selection_reason IN ('unseen', 'old')),
  maximum_score INTEGER NOT NULL CHECK (maximum_score = 20),
  assignments JSONB NOT NULL,
  responses JSONB NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('in_progress', 'submitted', 'abandoned')),
  phase VARCHAR(24) NOT NULL CHECK (phase IN ('ready', 'preparing', 'recording', 'ready_to_submit', 'submitted', 'abandoned')),
  current_task INTEGER NOT NULL CHECK (current_task BETWEEN 1 AND 4),
  current_response INTEGER NOT NULL CHECK (current_response BETWEEN 1 AND 5),
  stage_started_at TIMESTAMPTZ,
  stage_deadline_at TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  submission_key UUID,
  submission_response JSONB,
  CHECK (jsonb_typeof(assignments) = 'array' AND jsonb_array_length(assignments) = 4),
  CHECK (jsonb_typeof(responses) = 'array' AND jsonb_array_length(responses) = 4),
  CHECK ((phase IN ('preparing', 'recording')) = (stage_started_at IS NOT NULL AND stage_deadline_at IS NOT NULL)),
  CHECK (
    (status = 'in_progress' AND submitted_at IS NULL AND submission_key IS NULL AND submission_response IS NULL AND phase NOT IN ('submitted', 'abandoned'))
    OR
    (status = 'submitted' AND phase = 'submitted' AND submitted_at IS NOT NULL AND submission_key IS NOT NULL AND submission_response IS NOT NULL)
    OR
    (status = 'abandoned' AND phase = 'abandoned' AND submitted_at IS NULL AND submission_key IS NULL AND submission_response IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS speaking_full_sessions_owner_catalog_idx
  ON speaking_full_sessions (username, catalog_id, catalog_revision, assigned_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS speaking_full_sessions_one_active_idx
  ON speaking_full_sessions (username, catalog_id, catalog_revision) WHERE status = 'in_progress';
