ALTER TABLE "email_connections" ADD COLUMN IF NOT EXISTS "backfill_pending" boolean DEFAULT false NOT NULL;
