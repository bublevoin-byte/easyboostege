-- Section 10.7: the log must say why a provider was abandoned, not only that a call failed.
ALTER TABLE ai_requests
  ADD COLUMN IF NOT EXISTS fallback_reason TEXT;

-- Section 10.8: an identical generated task is reused across students, so the lookup is by hash.
CREATE INDEX IF NOT EXISTS generated_tasks_hash_idx
  ON generated_tasks (request_hash, created_at DESC);
