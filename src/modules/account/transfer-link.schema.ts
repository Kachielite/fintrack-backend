import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';
import { TransactionSchema } from '@/modules/transaction/transaction.schema';

export const TransferLinkSchema = pgTable('transfer_links', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  fromTransactionId: integer('from_transaction_id').references(() => TransactionSchema.id, {
    onDelete: 'set null',
  }),
  toTransactionId: integer('to_transaction_id').references(() => TransactionSchema.id, {
    onDelete: 'set null',
  }),
  linkType: text('link_type').notNull(),
  confidence: text('confidence').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
