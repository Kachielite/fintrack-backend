import { boolean, integer, pgTable, real, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const BudgetSchema = pgTable('budgets', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  category: text('category').notNull(),
  limitAmount: real('limit_amount').notNull(),
  currency: text('currency').notNull(),
  periodType: text('period_type').default('monthly').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  isSuggestedByAi: boolean('is_suggested_by_ai').default(false).notNull(),
  suppressedSuggestionsUntil: timestamp('suppressed_suggestions_until'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
