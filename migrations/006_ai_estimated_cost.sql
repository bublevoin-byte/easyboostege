ALTER TABLE ai_requests
  ADD COLUMN IF NOT EXISTS estimated_cost_microusd BIGINT;
