import { integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { EmailConnectionSchema } from '@/modules/email-connection/email-connection.schema';

export const ProcessedEmailSchema = pgTable('processed_emails', {
  id: serial('id').primaryKey(),
  emailConnectionId: integer('email_connection_id')
    .references(() => EmailConnectionSchema.id, { onDelete: 'cascade' })
    .notNull(),
  gmailMessageId: text('gmail_message_id').notNull(),
  processedAt: timestamp('processed_at').defaultNow().notNull(),
  outcome: text('outcome').notNull(),
  transactionId: integer('transaction_id'),
  // Only meaningful when outcome='failed' — how many times a retryable failure
  // (e.g. rate-limited) has been reprocessed. Once it reaches MAX_PROCESSING_RETRIES
  // (ingestion.repository.ts) the row becomes terminal and is skipped like any
  // other processed message.
  retryCount: integer('retry_count').default(0).notNull(),
}, (table) => ({
  connectionMessageUnique: uniqueIndex('processed_emails_connection_message_unique').on(
    table.emailConnectionId,
    table.gmailMessageId,
  ),
}));
