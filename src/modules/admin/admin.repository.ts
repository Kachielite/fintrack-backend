import { inject, injectable } from 'tsyringe';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import Database from '@/common/lib/database';
import { AiUsageLogSchema, AdminSnapshotSchema, AdminUserSchema } from './admin.schema';
import { IAiUsageLog, IAdminUser, ILogAiUsage } from './admin.interface';

// ── AI Usage Repository (injected into all OpenAI-calling services) ──────────

export interface IAiUsageRepository {
  log(data: ILogAiUsage): Promise<void>;
  findByPeriod(from: Date, to: Date): Promise<IAiUsageLog[]>;
}

@injectable()
export class AiUsageRepositoryImpl implements IAiUsageRepository {
  constructor(@inject(Database) private db: Database) {}

  async log(data: ILogAiUsage): Promise<void> {
    await this.db.client.insert(AiUsageLogSchema).values({
      operation: data.operation,
      promptTokens: data.promptTokens,
      completionTokens: data.completionTokens,
      totalTokens: data.totalTokens,
      modelUsed: data.modelUsed,
      userId: data.userId ?? null,
      transactionId: data.transactionId ?? null,
      templateId: data.templateId ?? null,
    });
  }

  async findByPeriod(from: Date, to: Date): Promise<IAiUsageLog[]> {
    return (await this.db.client
      .select()
      .from(AiUsageLogSchema)
      .where(and(gte(AiUsageLogSchema.createdAt, from), lte(AiUsageLogSchema.createdAt, to)))) as IAiUsageLog[];
  }
}

// ── Admin Analytics Repository ───────────────────────────────────────────────

export interface IAdminRepository {
  getTransactionStats(): Promise<{
    totalCount: number;
    count30d: number;
    handledByRegex: number;
    handledByAi: number;
    failedIngestion30d: number;
    unverifiedCount: number;
  }>;
  getTemplateStats(): Promise<{
    total: number;
    production: number;
    candidate: number;
    failedAudit: number;
    degrading: number;
    avgConfidence: number;
    banksWithCoverage: number;
    banksWithoutCoverage: number;
  }>;
  getUserStats(): Promise<{
    total: number;
    active30d: number;
    planFree: number;
    planPro: number;
    planPremium: number;
    onboardingComplete: number;
    emailConnected: number;
    newUsers30d: number;
    signedUp: number;
    firstTransactionParsed: number;
    usersWithTx7d: number;
    usersWithTx30d: number;
  }>;
  getIngestionStats(): Promise<{
    connectionsActive: number;
    connectionsStale: number;
    staleList: { connectionId: number; gmailAddress: string; lastSyncedAt: Date | null; status: string }[];
    emailsProcessed30d: number;
    emailsFailed30d: number;
    emailsNonTx30d: number;
  }>;
  getAiTokenStats(from: Date, to: Date): Promise<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    callCount: number;
  }>;
  getRegexTrend(from: Date, to: Date): Promise<{ date: string; regexCount: number; aiCount: number }[]>;
  getBankRegexStats(): Promise<{
    bankId: number; bankName: string; shortCode: string;
    productionTemplates: number; avgConfidence: number;
    txCount30d: number; regexCount30d: number; correctionCount: number;
  }[]>;
  /**
   * Per-connection (not per-bank) regex-vs-AI split over a recent window - the
   * bank-aggregated view above wouldn't have caught the September incident,
   * since it was one connection's runaway backfill, not a bank-wide issue. A
   * short window (hours, not the 30-day dashboard window) so a spike is
   * visible the same day it starts, not diluted into a monthly average.
   * See fintrack-backend#169.
   */
  getConnectionRegexStats(windowHours: number): Promise<{
    connectionId: number; userId: number; gmailAddress: string;
    txCount: number; regexCount: number; aiCount: number;
  }[]>;
  getTemplateActivity(from: Date, to: Date): Promise<{ added: number; modified: number; deprecated: number }>;
  getTemplateList(query: {
    page: number; limit: number; status?: string; bankId?: number;
    sortBy: string; sortOrder: string;
  }): Promise<{ total: number; items: any[] }>;
  getAuditQueue(): Promise<any[]>;
  getRegexGaps(): Promise<any[]>;
  getRegexCorrections(): Promise<any[]>;
  getIngestionTimeline(from: Date, to: Date): Promise<any[]>;
  getTransactionVolume(from: Date, to: Date): Promise<any>;
  getFullUserStats(): Promise<any>;
  getUserRegexStat(userId: number): Promise<any>;
  getAiUsageByPeriod(from: Date, to: Date): Promise<any>;
  saveSnapshot(data: unknown): Promise<void>;
  findAdminByEmail(email: string): Promise<IAdminUser | null>;
  findAdminById(id: number): Promise<IAdminUser | null>;
  updateAdminPassword(id: number, passwordHash: string): Promise<void>;
}

@injectable()
export class AdminRepositoryImpl implements IAdminRepository {
  constructor(@inject(Database) private db: Database) {}

  private get db_() { return this.db.client; }

  private thirtyDaysAgo(): Date {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  }

  private sevenDaysAgo(): Date {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d;
  }

  private async exec1(query: Parameters<typeof this.db_['execute']>[0]): Promise<any> {
    const result = await this.db_.execute(query);
    return (result.rows[0] ?? {}) as any;
  }

  private async execMany(query: Parameters<typeof this.db_['execute']>[0]): Promise<any[]> {
    const result = await this.db_.execute(query);
    return result.rows as any[];
  }

  async getTransactionStats() {
    const now = new Date();
    const ago30 = this.thirtyDaysAgo();

    const row = await this.exec1(sql`
      SELECT
        COUNT(*)::int                                                                       AS total_count,
        COUNT(*) FILTER (WHERE created_at >= ${ago30})::int                                AS count_30d,
        COUNT(*) FILTER (WHERE parser_template_id IS NOT NULL AND status = 'verified')::int AS handled_by_regex,
        COUNT(*) FILTER (WHERE parser_template_id IS NULL OR status = 'unverified')::int   AS handled_by_ai,
        COUNT(*) FILTER (WHERE status = 'unverified')::int                                 AS unverified_count
      FROM transactions
    `);

    const failRow = await this.exec1(sql`
      SELECT COUNT(*)::int AS failed FROM processed_emails
      WHERE outcome = 'failed' AND processed_at >= ${ago30}
    `);

    return {
      totalCount: Number(row.total_count),
      count30d: Number(row.count_30d),
      handledByRegex: Number(row.handled_by_regex),
      handledByAi: Number(row.handled_by_ai),
      failedIngestion30d: Number(failRow.failed),
      unverifiedCount: Number(row.unverified_count),
    };
  }

  async getTemplateStats() {
    const reauditThreshold = 0.60;

    const row = await this.exec1(sql`
      SELECT
        COUNT(*)::int                                                           AS total,
        COUNT(*) FILTER (WHERE status = 'production')::int                     AS production,
        COUNT(*) FILTER (WHERE status = 'candidate')::int                      AS candidate,
        COUNT(*) FILTER (WHERE status = 'failed_audit')::int                   AS failed_audit,
        COUNT(*) FILTER (WHERE status = 'production'
          AND confidence_score < ${reauditThreshold})::int                     AS degrading,
        COALESCE(AVG(confidence_score), 0)::float                              AS avg_confidence
      FROM parser_templates
    `);

    const coverageRow = await this.exec1(sql`
      SELECT
        COUNT(DISTINCT b.id) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM parser_templates pt
            WHERE pt.bank_id = b.id AND pt.status = 'production'
          )
        )::int AS banks_with,
        COUNT(DISTINCT b.id) FILTER (
          WHERE NOT EXISTS (
            SELECT 1 FROM parser_templates pt
            WHERE pt.bank_id = b.id AND pt.status = 'production'
          ) AND EXISTS (
            SELECT 1 FROM transactions t WHERE t.bank_id = b.id
          )
        )::int AS banks_without
      FROM banks b WHERE b.is_active = true
    `);

    return {
      total: Number(row.total),
      production: Number(row.production),
      candidate: Number(row.candidate),
      failedAudit: Number(row.failed_audit),
      degrading: Number(row.degrading),
      avgConfidence: Number(row.avg_confidence),
      banksWithCoverage: Number(coverageRow.banks_with),
      banksWithoutCoverage: Number(coverageRow.banks_without),
    };
  }

  async getUserStats() {
    const ago30 = this.thirtyDaysAgo();
    const ago7 = this.sevenDaysAgo();

    const row = await this.exec1(sql`
      SELECT
        COUNT(*)::int                                                           AS total,
        COUNT(*) FILTER (WHERE created_at >= ${ago30})::int                    AS new_30d,
        COUNT(*) FILTER (WHERE plan_tier = 'free')::int                        AS plan_free,
        COUNT(*) FILTER (WHERE plan_tier = 'pro')::int                         AS plan_pro,
        COUNT(*) FILTER (WHERE plan_tier = 'premium')::int                     AS plan_premium,
        COUNT(*) FILTER (WHERE onboarding_complete = true)::int                AS onboarding_complete,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM email_connections ec WHERE ec.user_id = users.id AND ec.status = 'active'
        ))::int                                                                AS email_connected
      FROM users
    `);

    const activeRow = await this.exec1(sql`
      SELECT
        COUNT(DISTINCT user_id) FILTER (WHERE transaction_date >= ${ago30})::int AS active_30d,
        COUNT(DISTINCT user_id) FILTER (WHERE transaction_date >= ${ago7})::int  AS active_7d
      FROM transactions
    `);

    const funnelRow = await this.exec1(sql`
      SELECT
        (SELECT COUNT(*)::int FROM users)                                       AS signed_up,
        (SELECT COUNT(DISTINCT user_id)::int FROM email_connections)           AS email_connected,
        (SELECT COUNT(*)::int FROM users WHERE onboarding_complete = true)     AS onboarding_complete,
        (SELECT COUNT(DISTINCT user_id)::int FROM transactions)                AS first_transaction_parsed
    `);

    return {
      total: Number(row.total),
      newUsers30d: Number(row.new_30d),
      planFree: Number(row.plan_free),
      planPro: Number(row.plan_pro),
      planPremium: Number(row.plan_premium),
      onboardingComplete: Number(row.onboarding_complete),
      emailConnected: Number(row.email_connected),
      active30d: Number(activeRow.active_30d),
      signedUp: Number(funnelRow.signed_up),
      firstTransactionParsed: Number(funnelRow.first_transaction_parsed),
      usersWithTx30d: Number(activeRow.active_30d),
      usersWithTx7d: Number(activeRow.active_7d),
    };
  }

  async getIngestionStats() {
    const ago24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const ago30 = this.thirtyDaysAgo();

    const staleRows = await this.execMany(sql`
      SELECT id, gmail_address, last_synced_at, status
      FROM email_connections
      WHERE status = 'active'
        AND (last_synced_at IS NULL OR last_synced_at < ${ago24h})
    `);

    const connRow = await this.exec1(sql`
      SELECT
        COUNT(*)::int                                                             AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int                           AS active,
        COUNT(*) FILTER (
          WHERE status = 'active'
            AND (last_synced_at IS NULL OR last_synced_at < ${ago24h})
        )::int                                                                   AS stale
      FROM email_connections
    `);

    const pipeRow = await this.exec1(sql`
      SELECT
        COUNT(*)::int                                                              AS total,
        COUNT(*) FILTER (WHERE outcome = 'failed')::int                           AS failed,
        COUNT(*) FILTER (WHERE outcome = 'non_transaction')::int                  AS non_tx
      FROM processed_emails WHERE processed_at >= ${ago30}
    `);

    return {
      connectionsActive: Number(connRow.active),
      connectionsStale: Number(connRow.stale),
      staleList: staleRows.map((r: any) => ({
        connectionId: r.id,
        gmailAddress: r.gmail_address,
        lastSyncedAt: r.last_synced_at,
        status: r.status,
      })),
      emailsProcessed30d: Number(pipeRow.total),
      emailsFailed30d: Number(pipeRow.failed),
      emailsNonTx30d: Number(pipeRow.non_tx),
    };
  }

  async getAiTokenStats(from: Date, to: Date) {
    const row = await this.exec1(sql`
      SELECT
        COALESCE(SUM(prompt_tokens), 0)::int      AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::int  AS completion_tokens,
        COALESCE(SUM(total_tokens), 0)::int       AS total_tokens,
        COUNT(*)::int                             AS call_count
      FROM ai_usage_logs WHERE created_at >= ${from} AND created_at <= ${to}
    `);
    return {
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      totalTokens: Number(row.total_tokens),
      callCount: Number(row.call_count),
    };
  }

  async getRegexTrend(from: Date, to: Date) {
    const rows = await this.execMany(sql`
      SELECT
        DATE(transaction_date)::text            AS date,
        COUNT(*) FILTER (WHERE parser_template_id IS NOT NULL AND status = 'verified')::int AS regex_count,
        COUNT(*) FILTER (WHERE parser_template_id IS NULL OR status = 'unverified')::int   AS ai_count
      FROM transactions
      WHERE transaction_date >= ${from} AND transaction_date <= ${to}
      GROUP BY DATE(transaction_date)
      ORDER BY DATE(transaction_date)
    `);
    return rows.map((r: any) => ({
      date: r.date,
      regexCount: Number(r.regex_count),
      aiCount: Number(r.ai_count),
    }));
  }

  async getBankRegexStats() {
    const ago30 = this.thirtyDaysAgo();
    const rows = await this.execMany(sql`
      SELECT
        b.id                                                                    AS bank_id,
        b.name                                                                  AS bank_name,
        b.short_code,
        COUNT(DISTINCT pt.id) FILTER (WHERE pt.status = 'production')::int     AS production_templates,
        COALESCE(AVG(pt.confidence_score) FILTER (WHERE pt.status='production'), 0)::float AS avg_confidence,
        COUNT(DISTINCT t.id) FILTER (WHERE t.transaction_date >= ${ago30})::int AS tx_count_30d,
        COUNT(DISTINCT t.id) FILTER (
          WHERE t.transaction_date >= ${ago30}
            AND t.parser_template_id IS NOT NULL AND t.status = 'verified'
        )::int                                                                  AS regex_count_30d,
        COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'corrected')::int        AS correction_count
      FROM banks b
      LEFT JOIN parser_templates pt ON pt.bank_id = b.id
      LEFT JOIN transactions t ON t.bank_id = b.id
      WHERE b.is_active = true
      GROUP BY b.id, b.name, b.short_code
    `);
    return rows.map((r: any) => ({
      bankId: Number(r.bank_id),
      bankName: r.bank_name,
      shortCode: r.short_code,
      productionTemplates: Number(r.production_templates),
      avgConfidence: Number(r.avg_confidence),
      txCount30d: Number(r.tx_count_30d),
      regexCount30d: Number(r.regex_count_30d),
      correctionCount: Number(r.correction_count),
    }));
  }

  async getConnectionRegexStats(windowHours: number) {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const rows = await this.execMany(sql`
      SELECT
        ec.id                                                                   AS connection_id,
        ec.user_id                                                              AS user_id,
        ec.gmail_address                                                        AS gmail_address,
        COUNT(t.id)::int                                                        AS tx_count,
        COUNT(t.id) FILTER (
          WHERE t.parser_template_id IS NOT NULL AND t.status = 'verified'
        )::int                                                                  AS regex_count
      FROM email_connections ec
      LEFT JOIN transactions t
        ON t.email_connection_id = ec.id AND t.created_at >= ${since}
      WHERE ec.status = 'active'
      GROUP BY ec.id, ec.user_id, ec.gmail_address
      HAVING COUNT(t.id) > 0
    `);
    return rows.map((r: any) => ({
      connectionId: Number(r.connection_id),
      userId: Number(r.user_id),
      gmailAddress: r.gmail_address,
      txCount: Number(r.tx_count),
      regexCount: Number(r.regex_count),
      aiCount: Number(r.tx_count) - Number(r.regex_count),
    }));
  }

  async getTemplateActivity(from: Date, to: Date) {
    const row = await this.exec1(sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ${from} AND created_at <= ${to})::int             AS added,
        COUNT(*) FILTER (WHERE promoted_at >= ${from} AND promoted_at <= ${to})::int           AS modified,
        COUNT(*) FILTER (WHERE deprecated_at >= ${from} AND deprecated_at <= ${to})::int       AS deprecated
      FROM parser_rules
    `);
    return {
      added: Number(row.added),
      modified: Number(row.modified),
      deprecated: Number(row.deprecated),
    };
  }

  async getTemplateList(query: {
    page: number; limit: number; status?: string; bankId?: number;
    sortBy: string; sortOrder: string;
  }) {
    const offset = (query.page - 1) * query.limit;
    const sortCol: Record<string, string> = {
      confidence_score: 'pt.confidence_score',
      match_count: 'pt.match_count',
      created_at: 'pt.created_at',
      last_failed_at: 'pt.last_failed_at',
    };
    const col = sortCol[query.sortBy] || 'pt.created_at';
    const dir = query.sortOrder === 'asc' ? sql`ASC` : sql`DESC`;
    const statusFilter = query.status ? sql`AND pt.status = ${query.status}` : sql``;
    const bankFilter = query.bankId ? sql`AND pt.bank_id = ${query.bankId}` : sql``;

    const countRow = await this.exec1(sql`
      SELECT COUNT(*)::int AS total FROM parser_templates pt WHERE 1=1 ${statusFilter} ${bankFilter}
    `);

    const rows = await this.execMany(sql`
      SELECT
        pt.id, b.name AS bank_name, pt.version, pt.description, pt.status,
        pt.confidence_score, pt.match_count, pt.fail_count,
        pt.last_failed_at, pt.created_at,
        COALESCE((
          SELECT MAX(pr.audit_passed_at)::text FROM parser_rules pr
          INNER JOIN template_rules tr ON tr.rule_id = pr.id AND tr.template_id = pt.id
        ), NULL) AS audit_passed_at,
        COALESCE((
          SELECT MAX(pr.promoted_at)::text FROM parser_rules pr
          INNER JOIN template_rules tr ON tr.rule_id = pr.id AND tr.template_id = pt.id
        ), NULL) AS promoted_at,
        COALESCE((
          SELECT MAX(pr.created_by) FROM parser_rules pr
          INNER JOIN template_rules tr ON tr.rule_id = pr.id AND tr.template_id = pt.id
          LIMIT 1
        ), 'ai') AS created_by,
        (
          SELECT COUNT(*)::int FROM transactions t
          WHERE t.parser_template_id = pt.id AND t.status = 'corrected'
        ) AS correction_count
      FROM parser_templates pt
      JOIN banks b ON b.id = pt.bank_id
      WHERE 1=1 ${statusFilter} ${bankFilter}
      ORDER BY ${sql.raw(col)} ${dir}
      LIMIT ${query.limit} OFFSET ${offset}
    `);

    return {
      total: Number(countRow.total),
      items: rows.map((r: any) => ({
        id: r.id,
        bank_name: r.bank_name,
        version: r.version,
        description: r.description,
        status: r.status,
        confidence_score: Number(r.confidence_score),
        match_count: Number(r.match_count),
        fail_count: Number(r.fail_count),
        correction_count: Number(r.correction_count),
        created_by: r.created_by,
        audit_passed_at: r.audit_passed_at ?? null,
        promoted_at: r.promoted_at ?? null,
        last_failed_at: r.last_failed_at ? new Date(r.last_failed_at).toISOString() : null,
        created_at: new Date(r.created_at).toISOString(),
      })),
    };
  }

  async getAuditQueue() {
    const rows = await this.execMany(sql`
      SELECT
        pt.id AS template_id, b.name AS bank_name, pt.version, pt.created_at,
        EXTRACT(EPOCH FROM (NOW() - pt.created_at)) / 3600 AS hours_waiting,
        (
          SELECT pe.transaction_id FROM processed_emails pe
          WHERE pe.transaction_id IN (
            SELECT id FROM transactions WHERE parser_template_id = pt.id
          )
          LIMIT 1
        ) AS triggered_by_tx_id
      FROM parser_templates pt
      JOIN banks b ON b.id = pt.bank_id
      WHERE pt.status = 'candidate'
      ORDER BY pt.created_at ASC
    `);
    return rows.map((r: any) => ({
      template_id: r.template_id,
      bank_name: r.bank_name,
      version: r.version,
      created_at: new Date(r.created_at).toISOString(),
      hours_waiting: Math.round(Number(r.hours_waiting) * 10) / 10,
      triggered_by_tx_id: r.triggered_by_tx_id ?? null,
    }));
  }

  async getRegexGaps() {
    const ago30 = this.thirtyDaysAgo();
    const rows = await this.execMany(sql`
      SELECT
        b.id AS bank_id, b.name AS bank_name, b.short_code,
        COUNT(DISTINCT t.id)::int AS unhandled_tx_count,
        MIN(t.transaction_date)::text AS oldest_unhandled_at,
        EXISTS (
          SELECT 1 FROM parser_templates pt
          WHERE pt.bank_id = b.id AND pt.status IN ('candidate', 'audited')
        ) AS candidate_template_exists
      FROM banks b
      JOIN transactions t ON t.bank_id = b.id
      WHERE t.transaction_date >= ${ago30}
        AND t.parser_template_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM parser_templates pt
          WHERE pt.bank_id = b.id AND pt.status = 'production'
        )
      GROUP BY b.id, b.name, b.short_code
      ORDER BY unhandled_tx_count DESC
    `);
    return rows.map((r: any) => ({
      bank_id: r.bank_id,
      bank_name: r.bank_name,
      short_code: r.short_code,
      unhandled_tx_count: Number(r.unhandled_tx_count),
      oldest_unhandled_at: r.oldest_unhandled_at ?? new Date().toISOString(),
      candidate_template_exists: Boolean(r.candidate_template_exists),
    }));
  }

  async getRegexCorrections() {
    const rows = await this.execMany(sql`
      SELECT
        pt.id AS template_id, b.name AS bank_name, pt.description, pt.status,
        pt.match_count,
        COUNT(t.id) FILTER (WHERE t.status = 'corrected')::int AS correction_count,
        (
          SELECT field_changed FROM (
            SELECT
              CASE
                WHEN t2.merchant != t2.original_merchant THEN 'merchant'
                WHEN t2.category != t2.original_category THEN 'category'
                ELSE 'amount'
              END AS field_changed
            FROM transactions t2
            WHERE t2.parser_template_id = pt.id AND t2.status = 'corrected'
          ) fc
          GROUP BY field_changed ORDER BY COUNT(*) DESC LIMIT 1
        ) AS most_corrected_field
      FROM parser_templates pt
      JOIN banks b ON b.id = pt.bank_id
      LEFT JOIN transactions t ON t.parser_template_id = pt.id
      GROUP BY pt.id, b.name
      HAVING COUNT(t.id) FILTER (WHERE t.status = 'corrected') > 0
      ORDER BY correction_count DESC
    `);
    return rows.map((r: any) => ({
      template_id: r.template_id,
      bank_name: r.bank_name,
      description: r.description,
      status: r.status,
      match_count: Number(r.match_count),
      correction_count: Number(r.correction_count),
      correction_rate_pct: r.match_count > 0
        ? parseFloat(((r.correction_count / r.match_count) * 100).toFixed(2))
        : 0,
      most_corrected_field: r.most_corrected_field ?? null,
    }));
  }

  async getIngestionTimeline(from: Date, to: Date) {
    const rows = await this.execMany(sql`
      SELECT
        DATE(pe.processed_at)::text AS date,
        COUNT(*) FILTER (WHERE pe.outcome = 'parsed')::int   AS parsed,
        COUNT(*) FILTER (WHERE pe.outcome = 'failed')::int   AS failed,
        COUNT(DISTINCT t.id) FILTER (
          WHERE t.parser_template_id IS NOT NULL AND t.status = 'verified'
        )::int                                               AS regex_handled,
        COUNT(DISTINCT t.id) FILTER (
          WHERE t.parser_template_id IS NULL OR t.status = 'unverified'
        )::int                                               AS ai_handled
      FROM processed_emails pe
      LEFT JOIN transactions t ON t.id = pe.transaction_id
      WHERE pe.processed_at >= ${from} AND pe.processed_at <= ${to}
      GROUP BY DATE(pe.processed_at)
      ORDER BY DATE(pe.processed_at)
    `);
    return rows.map((r: any) => ({
      date: r.date,
      parsed: Number(r.parsed),
      failed: Number(r.failed),
      regex_handled: Number(r.regex_handled),
      ai_handled: Number(r.ai_handled),
    }));
  }

  async getTransactionVolume(from: Date, to: Date) {
    const totals = await this.exec1(sql`
      SELECT
        COUNT(*)::int                                                AS total_count,
        COUNT(*) FILTER (WHERE amount < 0)::int                     AS debit_count,
        COUNT(*) FILTER (WHERE amount >= 0)::int                    AS credit_count,
        COALESCE(SUM(ABS(ref_amount)) FILTER (WHERE amount < 0), 0) AS total_debit_ref,
        COALESCE(SUM(ref_amount) FILTER (WHERE amount >= 0), 0)     AS total_credit_ref
      FROM transactions
      WHERE transaction_date >= ${from} AND transaction_date <= ${to}
    `);

    const totalCount = Number(totals.total_count) || 1;

    const byBank = await this.execMany(sql`
      SELECT b.name AS bank_name, COUNT(t.id)::int AS cnt,
             COALESCE(SUM(ABS(t.ref_amount)), 0) AS total_ref
      FROM transactions t JOIN banks b ON b.id = t.bank_id
      WHERE t.transaction_date >= ${from} AND t.transaction_date <= ${to}
      GROUP BY b.name ORDER BY total_ref DESC
    `);

    const byCurrency = await this.execMany(sql`
      SELECT currency, COUNT(*)::int AS cnt,
             COALESCE(SUM(ABS(amount)), 0) AS total_native,
             COALESCE(SUM(ABS(ref_amount)), 0) AS total_ref
      FROM transactions
      WHERE transaction_date >= ${from} AND transaction_date <= ${to}
      GROUP BY currency ORDER BY total_ref DESC
    `);

    const byCategory = await this.execMany(sql`
      SELECT category, COUNT(*)::int AS cnt,
             COALESCE(SUM(ABS(ref_amount)), 0) AS total_ref
      FROM transactions
      WHERE transaction_date >= ${from} AND transaction_date <= ${to} AND amount < 0
      GROUP BY category ORDER BY total_ref DESC
    `);

    return {
      totals: {
        count: Number(totals.total_count),
        debit_count: Number(totals.debit_count),
        credit_count: Number(totals.credit_count),
        total_debit_ref: Number(totals.total_debit_ref),
        total_credit_ref: Number(totals.total_credit_ref),
      },
      by_bank: byBank.map((r: any) => ({
        bank_name: r.bank_name,
        count: Number(r.cnt),
        total_ref: Number(r.total_ref),
        pct_of_total: parseFloat(((r.cnt / totalCount) * 100).toFixed(2)),
      })),
      by_currency: byCurrency.map((r: any) => ({
        currency: r.currency,
        count: Number(r.cnt),
        total_native: Number(r.total_native),
        total_ref: Number(r.total_ref),
      })),
      by_category: byCategory.map((r: any) => ({
        category: r.category,
        count: Number(r.cnt),
        total_ref: Number(r.total_ref),
        pct_of_total: parseFloat(((r.cnt / totalCount) * 100).toFixed(2)),
      })),
    };
  }

  async getFullUserStats() {
    return this.getUserStats();
  }

  async getUserRegexStat(userId: number) {
    const ago30 = this.thirtyDaysAgo();
    const userRow = await this.exec1(sql`
      SELECT email FROM users WHERE id = ${userId}
    `);

    const allTime = await this.exec1(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE parser_template_id IS NOT NULL AND status='verified')::int AS regex,
        COUNT(*) FILTER (WHERE parser_template_id IS NULL OR status='unverified')::int    AS ai,
        COUNT(*) FILTER (WHERE status = 'unverified')::int                               AS unverified
      FROM transactions WHERE user_id = ${userId}
    `);

    const last30 = await this.exec1(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE parser_template_id IS NOT NULL AND status='verified')::int AS regex
      FROM transactions WHERE user_id = ${userId} AND transaction_date >= ${ago30}
    `);

    const bankRows = await this.execMany(sql`
      SELECT b.name FROM transactions t JOIN banks b ON b.id = t.bank_id
      WHERE t.user_id = ${userId}
      GROUP BY b.name ORDER BY COUNT(*) DESC LIMIT 1
    `);

    const total = Number(allTime.total) || 1;
    const total30 = Number(last30.total) || 1;

    return {
      user_id: userId,
      email: userRow?.email ?? '',
      total_transactions: Number(allTime.total),
      handled_by_regex: Number(allTime.regex),
      handled_by_ai: Number(allTime.ai),
      regex_rate_pct: parseFloat(((Number(allTime.regex) / total) * 100).toFixed(2)),
      regex_rate_30d_pct: parseFloat(((Number(last30.regex) / total30) * 100).toFixed(2)),
      most_active_bank: bankRows[0]?.name ?? null,
      unverified_count: Number(allTime.unverified),
    };
  }

  async getAiUsageByPeriod(from: Date, to: Date) {
    const byOperation = await this.execMany(sql`
      SELECT
        operation,
        COUNT(*)::int                      AS call_count,
        SUM(prompt_tokens)::int            AS prompt_tokens,
        SUM(completion_tokens)::int        AS completion_tokens,
        SUM(total_tokens)::int             AS total_tokens
      FROM ai_usage_logs
      WHERE created_at >= ${from} AND created_at <= ${to}
      GROUP BY operation
    `);

    const trend = await this.execMany(sql`
      SELECT
        DATE(created_at)::text             AS date,
        SUM(total_tokens)::int             AS total_tokens,
        COUNT(*)::int                      AS call_count,
        SUM(prompt_tokens)::int            AS prompt_tokens,
        SUM(completion_tokens)::int        AS completion_tokens
      FROM ai_usage_logs
      WHERE created_at >= ${from} AND created_at <= ${to}
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at)
    `);

    const ago30 = this.thirtyDaysAgo();
    const costTrend = await this.execMany(sql`
      SELECT
        DATE(al.created_at)::text AS date,
        SUM(al.prompt_tokens)::int AS prompt_tokens,
        SUM(al.completion_tokens)::int AS completion_tokens,
        COUNT(DISTINCT t.id)::int AS tx_count
      FROM ai_usage_logs al
      LEFT JOIN transactions t ON DATE(t.transaction_date) = DATE(al.created_at)
      WHERE al.created_at >= ${ago30}
      GROUP BY DATE(al.created_at)
      ORDER BY DATE(al.created_at)
    `);

    return { byOperation, trend, costTrend };
  }

  async saveSnapshot(data: unknown): Promise<void> {
    await this.db_.insert(AdminSnapshotSchema).values({ data: data as any });
  }

  async findAdminByEmail(email: string): Promise<IAdminUser | null> {
    const rows = await this.db_.select().from(AdminUserSchema).where(eq(AdminUserSchema.email, email));
    return (rows[0] as unknown as IAdminUser) ?? null;
  }

  async findAdminById(id: number): Promise<IAdminUser | null> {
    const rows = await this.db_.select().from(AdminUserSchema).where(eq(AdminUserSchema.id, id));
    return (rows[0] as unknown as IAdminUser) ?? null;
  }

  async updateAdminPassword(id: number, passwordHash: string): Promise<void> {
    await this.db_.update(AdminUserSchema)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(AdminUserSchema.id, id));
  }
}
