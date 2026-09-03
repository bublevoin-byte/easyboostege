-- Ticket 06: bind existing Voice Tutor day-1/day-7 attempts to adaptive blocks.
-- Only an opaque attempt UUID is referenced; prompts and learner answers remain
-- in the existing Voice Tutor ledger and are not copied into adaptive storage.
ALTER TABLE adaptive_learning_execution_claims
  DROP CONSTRAINT IF EXISTS adaptive_learning_execution_claims_attempt_type_check;
ALTER TABLE adaptive_learning_execution_claims
  ADD CONSTRAINT adaptive_learning_execution_claims_attempt_type_check
  CHECK (attempt_type IN ('module', 'writing', 'speaking', 'voice_tutor_repeat'));

ALTER TABLE adaptive_learning_session_events
  DROP CONSTRAINT IF EXISTS adaptive_learning_session_events_source_type_check;
ALTER TABLE adaptive_learning_session_events
  ADD CONSTRAINT adaptive_learning_session_events_source_type_check
  CHECK (source_type IN ('module', 'writing', 'speaking', 'voice_tutor_repeat'));

ALTER TABLE adaptive_learning_skill_estimates
  ADD COLUMN IF NOT EXISTS critical_retention_expires_at TIMESTAMPTZ;
ALTER TABLE adaptive_learning_skill_estimates
  DROP CONSTRAINT IF EXISTS adaptive_learning_skill_estimates_due_state_check;
ALTER TABLE adaptive_learning_skill_estimates
  ADD CONSTRAINT adaptive_learning_skill_estimates_due_state_check
  CHECK (due_state IN ('not_due', 'due', 'overdue', 'critical_due'));
