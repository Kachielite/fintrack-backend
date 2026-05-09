import { integer, pgTable, real, serial, text, timestamp } from 'drizzle-orm/pg-core';
import { BankSchema } from '@/modules/bank/bank.schema';

export const ParserRuleSchema = pgTable('parser_rules', {
  id: serial('id').primaryKey(),
  bankId: integer('bank_id')
    .references(() => BankSchema.id, { onDelete: 'cascade' })
    .notNull(),
  version: integer('version').default(1).notNull(),
  field: text('field').notNull(),
  pattern: text('pattern').notNull(),
  flags: text('flags').default('i').notNull(),
  extractGroup: integer('extract_group').default(1).notNull(),
  status: text('status').default('candidate').notNull(),
  confidenceScore: real('confidence_score').default(0).notNull(),
  matchCount: integer('match_count').default(0).notNull(),
  failCount: integer('fail_count').default(0).notNull(),
  createdBy: text('created_by').default('ai').notNull(),
  auditNotes: text('audit_notes'),
  auditPassedAt: timestamp('audit_passed_at'),
  promotedAt: timestamp('promoted_at'),
  deprecatedAt: timestamp('deprecated_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const ParserTemplateSchema = pgTable('parser_templates', {
  id: serial('id').primaryKey(),
  bankId: integer('bank_id')
    .references(() => BankSchema.id, { onDelete: 'cascade' })
    .notNull(),
  version: integer('version').default(1).notNull(),
  description: text('description'),
  emailSubjectPattern: text('email_subject_pattern'),
  status: text('status').default('candidate').notNull(),
  confidenceScore: real('confidence_score').default(0).notNull(),
  matchCount: integer('match_count').default(0).notNull(),
  failCount: integer('fail_count').default(0).notNull(),
  lastFailedAt: timestamp('last_failed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const TemplateRuleSchema = pgTable('template_rules', {
  templateId: integer('template_id')
    .references(() => ParserTemplateSchema.id, { onDelete: 'cascade' })
    .notNull(),
  ruleId: integer('rule_id')
    .references(() => ParserRuleSchema.id, { onDelete: 'cascade' })
    .notNull(),
});
