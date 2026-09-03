CREATE TABLE IF NOT EXISTS speaking_task4_sessions (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  catalog_id VARCHAR(80) NOT NULL,
  catalog_revision INTEGER NOT NULL CHECK (catalog_revision > 0),
  task_id VARCHAR(140) NOT NULL,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  selection_reason VARCHAR(20) NOT NULL CHECK (selection_reason IN ('unseen', 'due', 'weak', 'old')),
  status VARCHAR(20) NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'completed')),
  recording_duration_seconds NUMERIC(5, 2),
  mic_check VARCHAR(20) CHECK (mic_check IN ('passed', 'quiet', 'skipped')),
  local_playback BOOLEAN NOT NULL DEFAULT FALSE,
  self_rating VARCHAR(20) CHECK (self_rating IN ('weak', 'steady', 'strong')),
  assigned_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  CHECK (recording_duration_seconds IS NULL OR recording_duration_seconds BETWEEN 1 AND 180),
  CHECK (
    (status = 'assigned' AND completed_at IS NULL AND due_at IS NULL
      AND recording_duration_seconds IS NULL AND mic_check IS NULL AND self_rating IS NULL)
    OR
    (status = 'completed' AND completed_at IS NOT NULL AND due_at IS NOT NULL
      AND recording_duration_seconds IS NOT NULL AND mic_check IS NOT NULL AND self_rating IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS speaking_task4_sessions_owner_catalog_idx
  ON speaking_task4_sessions (username, catalog_id, catalog_revision, assigned_at, id);
CREATE INDEX IF NOT EXISTS speaking_task4_sessions_owner_task_idx
  ON speaking_task4_sessions (username, task_id, assigned_at DESC);
