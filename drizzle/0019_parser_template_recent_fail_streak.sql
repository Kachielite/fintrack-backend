ALTER TABLE "parser_templates" ADD COLUMN IF NOT EXISTS "recent_fail_streak" integer DEFAULT 0 NOT NULL;
