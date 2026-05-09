import { integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const AuthProviderSchema = pgTable('auth_providers', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  provider: text('provider').notNull(),
  providerUserId: text('provider_user_id').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
