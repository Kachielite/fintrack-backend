import { integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';
import { AccountSchema } from './account.schema';

// A user's remembered decision for one specific pair of their own accounts —
// "money moving between these two is always/never a transfer". Stored
// direction-independent (accountAId < accountBId) since a self-transfer can
// run either way between the same two accounts on different days.
export const AccountTransferRuleSchema = pgTable(
  'account_transfer_rules',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => UserSchema.id, { onDelete: 'cascade' })
      .notNull(),
    accountAId: integer('account_a_id')
      .references(() => AccountSchema.id, { onDelete: 'cascade' })
      .notNull(),
    accountBId: integer('account_b_id')
      .references(() => AccountSchema.id, { onDelete: 'cascade' })
      .notNull(),
    decision: text('decision').notNull(), // 'always_transfer' | 'never_transfer'
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqPair: uniqueIndex('account_transfer_rules_pair_uniq').on(
      table.userId,
      table.accountAId,
      table.accountBId,
    ),
  }),
);
