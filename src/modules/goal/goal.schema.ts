import { boolean, integer, pgTable, real, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const GoalSchema = pgTable('goals', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  targetAmount: real('target_amount'),
  savedAmount: real('saved_amount').default(0).notNull(),
  currency: text('currency').notNull(),
  targetDate: timestamp('target_date'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
