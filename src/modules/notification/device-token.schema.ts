import { integer, pgTable, serial, text, timestamp, varchar } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const DeviceTokenSchema = pgTable('device_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  playerId: text('player_id').notNull().unique(),
  platform: varchar('platform', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
