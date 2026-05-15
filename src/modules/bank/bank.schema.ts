import { boolean, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const BankSchema = pgTable('banks', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  shortCode: text('short_code').notNull().unique(),
  country: text('country'),
  knownSenderEmails: text('known_sender_emails').array().notNull().default([]),
  knownSenderDomains: text('known_sender_domains').array().notNull().default([]),
  logoUrl: text('logo_url'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
