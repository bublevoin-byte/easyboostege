-- Section 10.1: the server owns the tasks, so a client only has to send an identifier.
--
-- The bank is shared across students on purpose. A generated task is paid for once and then serves
-- everyone who has not seen it, so the AI bill grows with the number of distinct tasks rather than
-- with the number of students. external_id carries the stable name of a built-in task from
-- public/task-bank.json; generated tasks have none and are identified by their numeric id.

CREATE TABLE IF NOT EXISTS task_bank (
  id BIGSERIAL PRIMARY KEY,
  operation VARCHAR(60) NOT NULL,
  external_id VARCHAR(120),
  content_hash CHAR(64) NOT NULL,
  content JSONB NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'generated',
  provider VARCHAR(40) NOT NULL DEFAULT '',
  prompt_version VARCHAR(40) NOT NULL DEFAULT '',
  retired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (operation, content_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS task_bank_external_id_idx
  ON task_bank (external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS task_bank_operation_idx
  ON task_bank (operation, created_at) WHERE retired_at IS NULL;

-- Which student has already been given which task. Without this the bank could not tell whether a
-- paid generation is actually necessary for the student asking.
CREATE TABLE IF NOT EXISTS task_deliveries (
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  task_id BIGINT NOT NULL REFERENCES task_bank(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (username, task_id)
);

CREATE INDEX IF NOT EXISTS task_deliveries_user_idx
  ON task_deliveries (username, delivered_at DESC);
