import { boolean, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const CategorySchema = pgTable('categories', {
  id: serial('id').primaryKey(),
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
