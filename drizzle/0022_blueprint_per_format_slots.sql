DROP INDEX IF EXISTS "bank_email_blueprints_bank_type_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bank_email_blueprints_bank_type_signature_uniq" ON "bank_email_blueprints" USING btree ("bank_id","transaction_type","format_signature");
