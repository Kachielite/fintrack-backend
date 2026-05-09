import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
