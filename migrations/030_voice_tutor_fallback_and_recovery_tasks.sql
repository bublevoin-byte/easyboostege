-- A zero-second reservation keeps text/local pedagogy available after the
-- paid voice quota is exhausted without reserving or billing voice time.
ALTER TABLE voice_tutor_sessions DROP CONSTRAINT IF EXISTS voice_tutor_sessions_reserved_seconds_check;
ALTER TABLE voice_tutor_sessions ADD CONSTRAINT voice_tutor_sessions_reserved_seconds_check
  CHECK (reserved_seconds BETWEEN 0 AND 86400);
ALTER TABLE voice_tutor_sessions DROP CONSTRAINT IF EXISTS voice_tutor_zero_reservation_shape;
ALTER TABLE voice_tutor_sessions ADD CONSTRAINT voice_tutor_zero_reservation_shape CHECK (
  reserved_seconds > 0 OR (
    capsule_id IS NOT NULL
    AND delivery_mode IN ('text', 'local')
    AND voice_activated_at IS NULL
  )
);

-- New recoveries persist the exact server-owned, same-skill checks that were
-- bound to the originating capsule. Legacy exact-skill banks remain readable.
ALTER TABLE voice_tutor_recoveries
  ADD COLUMN IF NOT EXISTS repeat_tasks JSONB;
ALTER TABLE voice_tutor_recoveries DROP CONSTRAINT IF EXISTS voice_tutor_recovery_repeat_tasks_shape;
ALTER TABLE voice_tutor_recoveries ADD CONSTRAINT voice_tutor_recovery_repeat_tasks_shape CHECK (
  repeat_tasks IS NULL OR (
    jsonb_typeof(repeat_tasks) = 'object'
    AND repeat_tasks ? 'day_1'
    AND repeat_tasks ? 'day_7'
    AND repeat_tasks->'day_1' ? 'prompt'
    AND repeat_tasks->'day_1' ? 'answers'
    AND jsonb_typeof(repeat_tasks->'day_1') = 'object'
    AND jsonb_typeof(repeat_tasks->'day_1'->'prompt') = 'string'
    AND jsonb_typeof(repeat_tasks->'day_1'->'answers') = 'array'
    AND jsonb_array_length(repeat_tasks->'day_1'->'answers') BETWEEN 1 AND 10
    AND repeat_tasks->'day_7' ? 'prompt'
    AND repeat_tasks->'day_7' ? 'answers'
    AND jsonb_typeof(repeat_tasks->'day_7') = 'object'
    AND jsonb_typeof(repeat_tasks->'day_7'->'prompt') = 'string'
    AND jsonb_typeof(repeat_tasks->'day_7'->'answers') = 'array'
    AND jsonb_array_length(repeat_tasks->'day_7'->'answers') BETWEEN 1 AND 10
  )
);
