import { pgTable, real, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const ExchangeRateSchema = pgTable(
  'exchange_rates',
  {
    id: serial('id').primaryKey(),
    baseCurrency: text('base_currency').notNull(),
    targetCurrency: text('target_currency').notNull(),
    rate: real('rate').notNull(),
    fetchedAt: timestamp('fetched_at').defaultNow().notNull(),
  },
  (table) => ({
    currencyPairIdx: uniqueIndex('exchange_rates_pair_idx').on(
      table.baseCurrency,
      table.targetCurrency,
    ),
  }),
);
