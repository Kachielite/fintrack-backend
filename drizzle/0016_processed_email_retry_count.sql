ALTER TABLE "processed_emails" ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0 NOT NULL;
