CREATE TABLE IF NOT EXISTS word_progress (
  username VARCHAR(64) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  word VARCHAR(120) NOT NULL,
  stage SMALLINT NOT NULL CHECK (stage BETWEEN 0 AND 5),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  due_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (username, word)
);

CREATE INDEX IF NOT EXISTS word_progress_user_due_idx
  ON word_progress (username, due_at) WHERE due_at IS NOT NULL;
