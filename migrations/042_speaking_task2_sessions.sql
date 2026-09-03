CREATE TABLE IF NOT EXISTS speaking_task2_sessions (
  id UUID PRIMARY KEY,
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  catalog_id VARCHAR(80) NOT NULL,
  catalog_revision INTEGER NOT NULL CHECK (catalog_revision > 0),
  task_id VARCHAR(140) NOT NULL,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  selection_reason VARCHAR(20) NOT NULL CHECK (selection_reason IN ('unseen', 'due', 'weak', 'old')),
  status VARCHAR(20) NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'in_progress', 'completed')),
  current_question INTEGER NOT NULL DEFAULT 1 CHECK (current_question BETWEEN 1 AND 4),
  questions JSONB NOT NULL DEFAULT '[
    {"questionNumber":1,"status":"pending","recordingDurationSeconds":null,"localPlayback":false,"selfRating":null,"completedAt":null},
    {"questionNumber":2,"status":"pending","recordingDurationSeconds":null,"localPlayback":false,"selfRating":null,"completedAt":null},
    {"questionNumber":3,"status":"pending","recordingDurationSeconds":null,"localPlayback":false,"selfRating":null,"completedAt":null},
    {"questionNumber":4,"status":"pending","recordingDurationSeconds":null,"localPlayback":false,"selfRating":null,"completedAt":null}
  ]'::jsonb,
  self_rating VARCHAR(20) CHECK (self_rating IN ('weak', 'steady', 'strong')),
  assigned_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  CHECK (jsonb_typeof(questions) = 'array' AND jsonb_array_length(questions) = 4),
  CHECK ((questions -> 0 ->> 'questionNumber')::INTEGER = 1),
  CHECK ((questions -> 1 ->> 'questionNumber')::INTEGER = 2),
  CHECK ((questions -> 2 ->> 'questionNumber')::INTEGER = 3),
  CHECK ((questions -> 3 ->> 'questionNumber')::INTEGER = 4),
  CHECK (
    (status = 'assigned' AND current_question = 1 AND completed_at IS NULL AND due_at IS NULL AND self_rating IS NULL)
    OR
    (status = 'in_progress' AND current_question BETWEEN 2 AND 4 AND completed_at IS NULL AND due_at IS NULL AND self_rating IS NULL)
    OR
    (status = 'completed' AND current_question = 4 AND completed_at IS NOT NULL AND due_at IS NOT NULL AND self_rating IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS speaking_task2_sessions_owner_catalog_idx
  ON speaking_task2_sessions (username, catalog_id, catalog_revision, assigned_at, id);
CREATE INDEX IF NOT EXISTS speaking_task2_sessions_owner_task_idx
  ON speaking_task2_sessions (username, task_id, assigned_at DESC);
