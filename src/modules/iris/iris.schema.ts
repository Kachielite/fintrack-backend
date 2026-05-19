import { integer, json, pgTable, real, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { UserSchema } from '@/modules/user/user.schema';

export const IrisSessionSchema = pgTable('iris_sessions', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  title: text('title'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const IrisMessageSchema = pgTable('iris_messages', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id')
    .references(() => IrisSessionSchema.id, { onDelete: 'cascade' })
    .notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  chartData: json('chart_data'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const IrisEmbeddingSchema = pgTable('iris_embeddings', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => UserSchema.id, { onDelete: 'cascade' })
    .notNull(),
  chunkType: text('chunk_type').notNull(),
  period: text('period').notNull(),
  content: text('content').notNull(),
  embedding: real('embedding').array().notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
