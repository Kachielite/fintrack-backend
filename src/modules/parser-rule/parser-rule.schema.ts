import { boolean, integer, pgTable, real, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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
  // Same fingerprint as bank_email_blueprints.formatSignature (buildFormatSignature
  // in parser-rule.service.ts), computed from the triggering email's raw subject
  // and body labels. Lets a bank hold one template per distinct email shape
  // (debit alert, credit alert, interbank transfer, ...) instead of exactly one
  // template ever, which was the generation gate before fintrack-backend#160.
  formatSignature: text('format_signature'),
  status: text('status').default('candidate').notNull(),
  confidenceScore: real('confidence_score').default(0).notNull(),
  matchCount: integer('match_count').default(0).notNull(),
  failCount: integer('fail_count').default(0).notNull(),
  // Consecutive recordFailure calls since the last recordMatch (reset to 0 on
  // any match). matchCount/failCount are lifetime cumulative, so a template
  // with a long healthy history barely moves on a handful of new failures -
  // this catches a bank redesigning its email format (which fails every
  // subsequent match) promptly instead of waiting for the lifetime average to
  // eventually drift low enough. See fintrack-backend#165.
  recentFailStreak: integer('recent_fail_streak').default(0).notNull(),
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

export const BankEmailBlueprintSchema = pgTable(
  'bank_email_blueprints',
  {
    id: serial('id').primaryKey(),
    bankId: integer('bank_id')
      .references(() => BankSchema.id, { onDelete: 'cascade' })
      .notNull(),
    transactionType: text('transaction_type').notNull(),
    sanitizedSubject: text('sanitized_subject').notNull(),
    sanitizedBody: text('sanitized_body').notNull(),
    formatSignature: text('format_signature').notNull(),
    sampleCount: integer('sample_count').default(1).notNull(),
    driftCount: integer('drift_count').default(0).notNull(),
    // True when this sample came from an extraction that failed (non-transaction
    // or unparseable amount) rather than a successfully-created transaction.
    // Excluded from the pools that feed template generation/audit so a bad
    // sample can't silently corrupt regex quality.
    failed: boolean('failed').default(false).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqBankType: uniqueIndex('bank_email_blueprints_bank_type_uniq').on(
      table.bankId,
      table.transactionType,
    ),
  }),
);
