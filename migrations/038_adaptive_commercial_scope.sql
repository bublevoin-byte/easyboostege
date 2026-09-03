-- Ticket 07: persist the server-owned commercial scope used when an adaptive
-- session is created. Legacy sessions default to base so an expired paid
-- session can never be mistaken for the one Free demo.
ALTER TABLE adaptive_learning_sessions
  ADD COLUMN IF NOT EXISTS commercial_scope TEXT NOT NULL DEFAULT 'base';

ALTER TABLE adaptive_learning_sessions
  DROP CONSTRAINT IF EXISTS adaptive_learning_sessions_commercial_scope_check;
ALTER TABLE adaptive_learning_sessions
  ADD CONSTRAINT adaptive_learning_sessions_commercial_scope_check
  CHECK (commercial_scope IN ('free_demo', 'base', 'premium'));
