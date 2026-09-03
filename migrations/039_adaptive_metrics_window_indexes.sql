-- Ticket 08: bounded 90-day operational snapshots scan only their timestamp window.
CREATE INDEX IF NOT EXISTS adaptive_learning_sessions_metrics_created_idx
  ON adaptive_learning_sessions (created_at);

CREATE INDEX IF NOT EXISTS adaptive_learning_session_events_metrics_created_idx
  ON adaptive_learning_session_events (created_at)
  WHERE block_kind = 'learning';

CREATE INDEX IF NOT EXISTS adaptive_diagnostic_sessions_metrics_completed_idx
  ON adaptive_diagnostic_sessions (completed_at)
  WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS adaptive_learning_skill_estimates_metrics_updated_idx
  ON adaptive_learning_skill_estimates (updated_at);
