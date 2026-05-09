import { integer, pgTable, real, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';
import { EmailConnectionSchema } from '@/modules/email-connection/email-connection.schema';
import { BankSchema } from '@/modules/bank/bank.schema';

export const TransactionSchema = pgTable('transactions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  emailConnectionId: integer('email_connection_id').references(() => EmailConnectionSchema.id, {
    onDelete: 'set null',
  }),
  bankId: integer('bank_id').references(() => BankSchema.id, { onDelete: 'set null' }),
  parserTemplateId: integer('parser_template_id'),
  gmailMessageId: text('gmail_message_id'),
  merchant: text('merchant').notNull(),
  category: text('category').notNull(),
  transactionType: text('transaction_type').notNull(),
  amount: real('amount').notNull(),
  currency: text('currency').notNull(),
  refAmount: real('ref_amount').notNull(),
  refCurrency: text('ref_currency').notNull(),
  exchangeRateUsed: real('exchange_rate_used'),
  transactionDate: timestamp('transaction_date').notNull(),
  status: text('status').default('unverified').notNull(),
  originalMerchant: text('original_merchant'),
  originalCategory: text('original_category'),
  reference: text('reference'),
  balance: real('balance'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
