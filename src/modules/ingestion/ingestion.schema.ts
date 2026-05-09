import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
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
});
