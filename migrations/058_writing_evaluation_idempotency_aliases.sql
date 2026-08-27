CREATE UNIQUE INDEX IF NOT EXISTS writing_attempts_id_username_idx
  ON writing_attempts (id, username);

CREATE TABLE IF NOT EXISTS writing_evaluation_idempotency_aliases (
  username TEXT NOT NULL,
  idempotency_key UUID NOT NULL,
  attempt_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (username, idempotency_key),
  CONSTRAINT writing_evaluation_alias_attempt_owner_fk
    FOREIGN KEY (attempt_id, username)
    REFERENCES writing_attempts (id, username)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS writing_evaluation_alias_attempt_idx
  ON writing_evaluation_idempotency_aliases (attempt_id);
