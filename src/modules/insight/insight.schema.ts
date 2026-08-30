import { boolean, integer, json, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const InsightSchema = pgTable('insights', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  type: text('type').notNull(),
  message: text('message').notNull(),
  contextData: json('context_data'),
  periodType: text('period_type'),
  periodStart: timestamp('period_start'),
  periodEnd: timestamp('period_end'),
  isRead: boolean('is_read').default(false).notNull(),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
