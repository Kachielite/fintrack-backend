CREATE TABLE IF NOT EXISTS bank_email_blueprints (
  id SERIAL PRIMARY KEY,
  bank_id INTEGER NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  transaction_type TEXT NOT NULL,
  sanitized_subject TEXT NOT NULL,
  sanitized_body TEXT NOT NULL,
  format_signature TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 1,
  drift_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS bank_email_blueprints_bank_type_uniq
  ON bank_email_blueprints(bank_id, transaction_type);

