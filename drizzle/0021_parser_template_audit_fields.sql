ALTER TABLE "parser_templates" ADD COLUMN IF NOT EXISTS "audit_notes" text;
ALTER TABLE "parser_templates" ADD COLUMN IF NOT EXISTS "audit_passed_at" timestamp;
ALTER TABLE "parser_templates" ADD COLUMN IF NOT EXISTS "promoted_at" timestamp;
ALTER TABLE "parser_templates" ADD COLUMN IF NOT EXISTS "deprecated_at" timestamp;
