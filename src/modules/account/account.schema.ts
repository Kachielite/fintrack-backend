import { boolean, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';
import { BankSchema } from '@/modules/bank/bank.schema';

export const AccountSchema = pgTable('accounts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  bankId: integer('bank_id').references(() => BankSchema.id, { onDelete: 'set null' }),
  currency: text('currency').notNull(),
  label: text('label').notNull(),
  accountNumberMask: text('account_number_mask'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
