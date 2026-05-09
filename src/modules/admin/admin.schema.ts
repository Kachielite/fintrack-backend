import { boolean, integer, json, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const AiUsageLogSchema = pgTable('ai_usage_logs', {
  id: serial('id').primaryKey(),
  operation: text('operation').notNull(),
  promptTokens: integer('prompt_tokens').notNull(),
  completionTokens: integer('completion_tokens').notNull(),
  totalTokens: integer('total_tokens').notNull(),
  modelUsed: text('model_used').notNull(),
  userId: integer('user_id').references(() => UserSchema.id, { onDelete: 'set null' }),
  transactionId: integer('transaction_id'),
  templateId: integer('template_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const AdminSnapshotSchema = pgTable('admin_snapshots', {
  id: serial('id').primaryKey(),
  snapshotAt: timestamp('snapshot_at').defaultNow().notNull(),
  data: json('data').notNull(),
});

export const AdminUserSchema = pgTable('admin_users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
