import { boolean, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const CategorySchema = pgTable('categories', {
  id: serial('id').primaryKey(),
  // Null for system-wide categories, visible to everyone. Set for a
  // user-created custom category, visible only to its owner.
  userId: integer('user_id').references(() => UserSchema.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  icon: text('icon'),
  type: text('type').notNull().default('expense'),
  regex: text('regex'),
  isSystem: boolean('is_system').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
