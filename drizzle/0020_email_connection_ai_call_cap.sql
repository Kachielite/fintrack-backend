ALTER TABLE "email_connections" ADD COLUMN IF NOT EXISTS "ai_extraction_calls_today" integer DEFAULT 0 NOT NULL;
ALTER TABLE "email_connections" ADD COLUMN IF NOT EXISTS "ai_extraction_calls_reset_at" timestamp;
