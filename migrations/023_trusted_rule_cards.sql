CREATE TABLE IF NOT EXISTS trusted_rule_cards (
  id UUID PRIMARY KEY,
  created_for_username VARCHAR(64) REFERENCES users(username) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected')),
  skill_id VARCHAR(120) NOT NULL,
  skill_title VARCHAR(160) NOT NULL,
  exam_year INTEGER NOT NULL CHECK (exam_year BETWEEN 2020 AND 2100),
  rule_content JSONB NOT NULL,
  agreement_hash CHAR(64) NOT NULL,
  sources JSONB NOT NULL,
  discrepancies JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_audit JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS trusted_rule_cards_review_queue_idx
  ON trusted_rule_cards (status, created_at);
CREATE INDEX IF NOT EXISTS trusted_rule_cards_canonical_idx
  ON trusted_rule_cards (skill_id, exam_year, reviewed_at DESC)
  WHERE status = 'approved';
