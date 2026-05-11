CREATE UNIQUE INDEX IF NOT EXISTS "processed_emails_connection_message_unique"
ON "processed_emails" ("email_connection_id", "gmail_message_id");

