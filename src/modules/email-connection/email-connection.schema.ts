import { boolean, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const EmailConnectionSchema = pgTable('email_connections', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  provider: text('provider').default('gmail').notNull(),
  gmailAddress: text('gmail_address').notNull(),
  encryptedAccessToken: text('encrypted_access_token').notNull(),
  encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
  tokenExpiresAt: timestamp('token_expires_at').notNull(),
  gmailLabelId: text('gmail_label_id'),
  gmailLabelName: text('gmail_label_name').default('Bank Transactions'),
  status: text('status').default('active').notNull(),
  lastSyncedAt: timestamp('last_synced_at'),
  lastSyncMessageCount: integer('last_sync_message_count').default(0),
  // Set while a manual poll's chunked backfill still has more Gmail pages to
  // walk through (see fintrack-backend#137) — lets other features (e.g. Iris's
  // first insight) know not to treat the connection's current transaction set
  // as final yet.
  backfillPending: boolean('backfill_pending').default(false).notNull(),
  // Per-connection daily cost circuit breaker (fintrack-backend#166): counts AI
  // extraction calls (the primary regex-fallback path, the dominant cost driver
  // in the September ingestion incident), reset whenever aiCallsResetAt isn't
  // today. Exceeding INGESTION_DAILY_AI_CALL_CAP pauses further AI calls for
  // the rest of that day instead of burning through an unbounded backlog.
  aiExtractionCallsToday: integer('ai_extraction_calls_today').default(0).notNull(),
  aiExtractionCallsResetAt: timestamp('ai_extraction_calls_reset_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
