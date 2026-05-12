import { boolean, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const UserSchema = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name'),
  refCurrency: text('ref_currency').default('NGN').notNull(),
  advisorTone: text('advisor_tone').default('warm').notNull(),
  goalType: text('goal_type'),
  incomeRange: text('income_range'),
  payFrequency: text('pay_frequency'),
  onboardingComplete: boolean('onboarding_complete').default(false).notNull(),
  refreshTokenHash: text('refresh_token_hash'),
  demoPasswordHash: text('demo_password_hash'),
  planTier: text('plan_tier').default('free').notNull(),
  dataRetentionMonths: integer('data_retention_months').default(3).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
