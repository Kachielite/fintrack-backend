import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const NotificationSchema = pgTable('notifications', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  type: text('type').notNull(), // 'sync_complete' | 'sync_skipped' | 'sync_failed'
  title: text('title').notNull(),
  body: text('body').notNull(),
  data: text('data'), // JSON string for arbitrary metadata
  readAt: timestamp('read_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
