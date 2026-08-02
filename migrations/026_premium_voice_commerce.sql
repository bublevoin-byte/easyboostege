ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS product VARCHAR(32) NOT NULL DEFAULT 'base';

ALTER TABLE payment_requests
  DROP CONSTRAINT IF EXISTS payment_requests_product_check;
ALTER TABLE payment_requests
  ADD CONSTRAINT payment_requests_product_check CHECK (product IN ('base', 'premium_voice'));

DROP INDEX IF EXISTS payment_requests_one_new_per_user_idx;
CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_one_new_per_user_product_idx
  ON payment_requests (username, product) WHERE status = 'new';

CREATE INDEX IF NOT EXISTS payment_requests_user_product_created_idx
  ON payment_requests (username, product, created_at DESC);
