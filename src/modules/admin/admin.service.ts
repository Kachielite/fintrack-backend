import { inject, injectable } from 'tsyringe';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { IAdminRepository, IAiUsageRepository } from './admin.repository';
import { calculateCostUsd } from '@/common/utils/cost-calculator';
import { CONSTANTS } from '@/common/configuration/constants';
import { UnAuthorizedException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';
import ParserRuleService, { IParserRuleService, BulkReauditResult } from '@/modules/parser-rule/parser-rule.service';
import { AuditResult } from '@/modules/parser-rule/parser-rule.interface';
import { ParserTemplateResponseDTO } from '@/modules/parser-rule/parser-rule.dto';
import {
  AdminOverviewResponseDTO,
  RegexHealthResponseDTO,
  RegexTemplateListDTO,
  RegexTemplateQueryDTO,
  AuditQueueResponseDTO,
  RegexGapsResponseDTO,
  RegexCorrectionsResponseDTO,
  IngestionHealthResponseDTO,
  IngestionTimelineResponseDTO,
  TransactionVolumeResponseDTO,
  UserStatsResponseDTO,
  UserRegexStatResponseDTO,
  AiUsageResponseDTO,
  AdminDateRangeDTO,
} from './admin.dto';

export interface IAdminService {
  login(email: string, password: string): Promise<{ access_token: string; expires_in: string }>;
  getMe(adminId: number): Promise<{ id: number; email: string }>;
  changePassword(adminId: number, currentPassword: string, newPassword: string): Promise<void>;
  getOverview(): Promise<AdminOverviewResponseDTO>;
  getRegexHealth(): Promise<RegexHealthResponseDTO>;
  getRegexTemplates(query: RegexTemplateQueryDTO): Promise<RegexTemplateListDTO>;
  getAuditQueue(): Promise<AuditQueueResponseDTO>;
  getRegexGaps(): Promise<RegexGapsResponseDTO>;
  getRegexCorrections(): Promise<RegexCorrectionsResponseDTO>;
  getIngestionHealth(): Promise<IngestionHealthResponseDTO>;
  getIngestionTimeline(range: AdminDateRangeDTO): Promise<IngestionTimelineResponseDTO>;
  getTransactionVolume(range: AdminDateRangeDTO): Promise<TransactionVolumeResponseDTO>;
  getUserStats(): Promise<UserStatsResponseDTO>;
  getUserRegexStat(userId: number): Promise<UserRegexStatResponseDTO>;
  getAiUsage(range: AdminDateRangeDTO): Promise<AiUsageResponseDTO>;
  takeSnapshot(): Promise<void>;
  /**
   * Logs a warning for any connection whose AI share has crossed the alert
   * threshold in the last CONNECTION_HEALTH_WINDOW_HOURS - the proactive half
   * of fintrack-backend#169's per-connection health check; getRegexHealth's
   * by_connection field is the pull side (dashboard view), this is the push
   * side. No dedicated ops-alerting channel (Slack/email/PagerDuty) exists in
   * this codebase yet, so this surfaces via the application logger, which is
   * this codebase's one universal, already-relied-on channel; wiring it to a
   * real paging channel is a natural follow-up once one exists.
   */
  checkConnectionAlerts(): Promise<void>;
  /**
   * The admin dashboard's regex-template actions (Audit Queue's per-row
   * "Audit", "Trigger audit", and template "Promote") previously had no
   * admin-authenticated route to call - the real logic already existed on
   * ParserRuleService behind regular user bearer-auth, which the admin
   * dashboard's session token can't satisfy. These delegate straight
   * through under the admin auth this controller already gates every other
   * route with. See fintrack-backend#142.
   */
  auditTemplate(templateId: number): Promise<AuditResult>;
  promoteTemplate(templateId: number): Promise<ParserTemplateResponseDTO>;
  bulkReauditFailed(): Promise<BulkReauditResult>;
}

// Per-connection AI-share alerting (fintrack-backend#169): a 24h window catches
// a spike the same day it starts, unlike the 30-day dashboard averages used
// elsewhere in this file. A minimum sample size avoids alerting on noise from
// a connection with only a couple of transactions in the window.
const CONNECTION_HEALTH_WINDOW_HOURS = 24;
const CONNECTION_ALERT_AI_SHARE_THRESHOLD_PCT = 70;
const CONNECTION_ALERT_MIN_SAMPLE_SIZE = 10;

@injectable()
class AdminService implements IAdminService {
  constructor(
    @inject('IAdminRepository') private adminRepository: IAdminRepository,
    @inject('IAiUsageRepository') private aiUsageRepository: IAiUsageRepository,
    @inject(ParserRuleService) private parserRuleService: IParserRuleService,
  ) {}

  async login(email: string, password: string): Promise<{ access_token: string; expires_in: string }> {
    const admin = await this.adminRepository.findAdminByEmail(email);
    const hash = admin?.passwordHash ?? '$2b$12$invalidhashpadding000000000000000000000000000000000000';
    const valid = await bcrypt.compare(password, hash);
    if (!admin || !admin.isActive || !valid) {
      throw new UnAuthorizedException('Invalid credentials.');
    }
    const token = jwt.sign(
      { role: 'admin', adminId: admin.id },
      CONSTANTS.ADMIN_JWT_SECRET,
      { expiresIn: CONSTANTS.ADMIN_JWT_EXPIRES_IN } as any,
    );
    return { access_token: token, expires_in: CONSTANTS.ADMIN_JWT_EXPIRES_IN };
  }

  async getMe(adminId: number): Promise<{ id: number; email: string }> {
    const admin = await this.adminRepository.findAdminById(adminId);
    if (!admin) throw new ResourceNotFoundException('Admin not found.');
    return { id: admin.id, email: admin.email };
  }

  async changePassword(adminId: number, currentPassword: string, newPassword: string): Promise<void> {
    const admin = await this.adminRepository.findAdminById(adminId);
    if (!admin) throw new ResourceNotFoundException('Admin not found.');
    const valid = await bcrypt.compare(currentPassword, admin.passwordHash);
    if (!valid) throw new UnAuthorizedException('Current password is incorrect.');
    const newHash = await bcrypt.hash(newPassword, 12);
    await this.adminRepository.updateAdminPassword(adminId, newHash);
  }

  private defaultRange(range: AdminDateRangeDTO): { from: Date; to: Date } {
    const to = range.to ? new Date(range.to) : new Date();
    const from = range.from ? new Date(range.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return { from, to };
  }

  async getOverview(): Promise<AdminOverviewResponseDTO> {
    const now = new Date();
    const ago30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [txStats, templateStats, userStats, ingestionStats, todayAi, monthAi] = await Promise.all([
      this.adminRepository.getTransactionStats(),
      this.adminRepository.getTemplateStats(),
      this.adminRepository.getUserStats(),
      this.adminRepository.getIngestionStats(),
      this.adminRepository.getAiTokenStats(todayStart, now),
      this.adminRepository.getAiTokenStats(ago30, now),
    ]);

    const regexTotal = txStats.handledByRegex + txStats.handledByAi || 1;
    const regex30dBase = txStats.count30d || 1;

    const todayCost = calculateCostUsd(todayAi.promptTokens, todayAi.completionTokens);
    const monthCost = calculateCostUsd(monthAi.promptTokens, monthAi.completionTokens);
    const costPerTx = txStats.count30d > 0 ? monthCost / txStats.count30d : 0;

    return {
      snapshot_at: now.toISOString(),
      transactions: {
        total_count: txStats.totalCount,
        total_count_30d: txStats.count30d,
        handled_by_regex: txStats.handledByRegex,
        handled_by_ai: txStats.handledByAi,
        regex_rate_pct: parseFloat(((txStats.handledByRegex / regexTotal) * 100).toFixed(2)),
        regex_rate_30d_pct: parseFloat(((txStats.handledByRegex / regex30dBase) * 100).toFixed(2)),
        failed_ingestion_count: txStats.failedIngestion30d,
        unverified_count: txStats.unverifiedCount,
      },
      regex_engine: {
        total_templates: templateStats.total,
        production: templateStats.production,
        candidate: templateStats.candidate,
        failed_audit: templateStats.failedAudit,
        degrading: templateStats.degrading,
        avg_confidence_score: parseFloat(templateStats.avgConfidence.toFixed(4)),
        banks_with_coverage: templateStats.banksWithCoverage,
        banks_without_coverage: templateStats.banksWithoutCoverage,
      },
      users: {
        total: userStats.total,
        active_30d: userStats.active30d,
        plan_free: userStats.planFree,
        plan_pro: userStats.planPro,
        plan_premium: userStats.planPremium,
        onboarding_complete: userStats.onboardingComplete,
        email_connected: userStats.emailConnected,
      },
      ingestion: {
        connections_active: ingestionStats.connectionsActive,
        connections_stale: ingestionStats.connectionsStale,
        emails_processed_30d: ingestionStats.emailsProcessed30d,
        emails_failed_30d: ingestionStats.emailsFailed30d,
        avg_parse_time_ms: null,
      },
      ai_cost: {
        estimated_cost_today_usd: todayCost,
        estimated_cost_30d_usd: monthCost,
        total_tokens_30d: monthAi.totalTokens,
        cost_per_transaction_30d: parseFloat(costPerTx.toFixed(6)),
      },
    };
  }

  async getRegexHealth(): Promise<RegexHealthResponseDTO> {
    const now = new Date();
    const ago30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [txStats, bankStats, trend, activity, connectionStats] = await Promise.all([
      this.adminRepository.getTransactionStats(),
      this.adminRepository.getBankRegexStats(),
      this.adminRepository.getRegexTrend(ago30, now),
      this.adminRepository.getTemplateActivity(ago30, now),
      this.adminRepository.getConnectionRegexStats(CONNECTION_HEALTH_WINDOW_HOURS),
    ]);

    const regexTotal = txStats.handledByRegex + txStats.handledByAi || 1;
    const overallRegexRatePct = parseFloat(((txStats.handledByRegex / regexTotal) * 100).toFixed(2));

    const trendFormatted = trend.map((r) => {
      const total = r.regexCount + r.aiCount || 1;
      return {
        date: r.date,
        regex_count: r.regexCount,
        ai_count: r.aiCount,
        regex_rate_pct: parseFloat(((r.regexCount / total) * 100).toFixed(2)),
      };
    });

    const byBank = bankStats.map((b) => {
      const total30 = b.txCount30d || 1;
      const regexRate = parseFloat(((b.regexCount30d / total30) * 100).toFixed(2));
      const correctionRate = b.regexCount30d > 0
        ? parseFloat(((b.correctionCount / b.regexCount30d) * 100).toFixed(2))
        : 0;
      let status: 'healthy' | 'degrading' | 'no_coverage';
      if (b.productionTemplates === 0) {
        status = 'no_coverage';
      } else if (b.avgConfidence < 0.6 || correctionRate > 20) {
        status = 'degrading';
      } else {
        status = 'healthy';
      }
      return {
        bank_id: b.bankId,
        bank_name: b.bankName,
        short_code: b.shortCode,
        production_templates: b.productionTemplates,
        avg_confidence: parseFloat(b.avgConfidence.toFixed(4)),
        transaction_count_30d: b.txCount30d,
        regex_rate_pct: regexRate,
        correction_rate_pct: correctionRate,
        status,
      };
    });

    const byConnection = connectionStats.map((c) => {
      const aiSharePct = c.txCount > 0 ? parseFloat(((c.aiCount / c.txCount) * 100).toFixed(2)) : 0;
      const alert = c.txCount >= CONNECTION_ALERT_MIN_SAMPLE_SIZE && aiSharePct > CONNECTION_ALERT_AI_SHARE_THRESHOLD_PCT;
      return {
        connection_id: c.connectionId,
        gmail_address: c.gmailAddress,
        tx_count: c.txCount,
        regex_count: c.regexCount,
        ai_count: c.aiCount,
        ai_share_pct: aiSharePct,
        alert,
      };
    });

    return {
      as_of: now.toISOString(),
      overall_regex_rate_pct: overallRegexRatePct,
      trend: trendFormatted,
      by_bank: byBank,
      templates_added_30d: activity.added,
      templates_modified_30d: activity.modified,
      templates_deprecated_30d: activity.deprecated,
      by_connection: byConnection,
    };
  }

  async checkConnectionAlerts(): Promise<void> {
    const stats = await this.adminRepository.getConnectionRegexStats(CONNECTION_HEALTH_WINDOW_HOURS);
    for (const c of stats) {
      if (c.txCount < CONNECTION_ALERT_MIN_SAMPLE_SIZE) continue;
      const aiSharePct = (c.aiCount / c.txCount) * 100;
      if (aiSharePct > CONNECTION_ALERT_AI_SHARE_THRESHOLD_PCT) {
        logger.warn(
          `[AdminAlert] Connection ${c.connectionId} (${c.gmailAddress}) AI share is ${aiSharePct.toFixed(1)}% ` +
            `over the last ${CONNECTION_HEALTH_WINDOW_HOURS}h (${c.aiCount}/${c.txCount} transactions), ` +
            `above the ${CONNECTION_ALERT_AI_SHARE_THRESHOLD_PCT}% threshold. This is the signature of either a new/unhandled ` +
            `bank email format or a runaway backfill.`,
        );
      }
    }
  }

  async getRegexTemplates(query: RegexTemplateQueryDTO): Promise<RegexTemplateListDTO> {
    const result = await this.adminRepository.getTemplateList({
      page: query.page,
      limit: query.limit,
      status: query.status,
      bankId: query.bank_id,
      sortBy: query.sort_by,
      sortOrder: query.sort_order,
    });
    return {
      page: query.page,
      limit: query.limit,
      total_items: result.total,
      pages: Math.ceil(result.total / query.limit),
      items: result.items,
    };
  }

  async getAuditQueue(): Promise<AuditQueueResponseDTO> {
    const items = await this.adminRepository.getAuditQueue();
    return {
      total_pending: items.length,
      items,
    };
  }

  async getRegexGaps(): Promise<RegexGapsResponseDTO> {
    const items = await this.adminRepository.getRegexGaps();
    return {
      total_banks_with_gaps: items.length,
      items,
    };
  }

  async getRegexCorrections(): Promise<RegexCorrectionsResponseDTO> {
    const items = await this.adminRepository.getRegexCorrections();
    return { items };
  }

  async getIngestionHealth(): Promise<IngestionHealthResponseDTO> {
    const stats = await this.adminRepository.getIngestionStats();
    const failureRatePct = stats.emailsProcessed30d > 0
      ? parseFloat(((stats.emailsFailed30d / stats.emailsProcessed30d) * 100).toFixed(2))
      : 0;

    return {
      connections: {
        total: stats.connectionsActive + stats.connectionsStale,
        active: stats.connectionsActive,
        stale: stats.connectionsStale,
        stale_list: stats.staleList.map((s) => ({
          connection_id: s.connectionId,
          gmail_address: s.gmailAddress,
          last_synced_at: s.lastSyncedAt ? new Date(s.lastSyncedAt).toISOString() : null,
          status: s.status,
        })),
      },
      pipeline_30d: {
        emails_processed: stats.emailsProcessed30d,
        emails_failed: stats.emailsFailed30d,
        failure_rate_pct: failureRatePct,
        non_transaction_classified: stats.emailsNonTx30d,
        avg_parse_time_ms: null,
      },
      outcomes_30d: {
        parsed: stats.emailsProcessed30d - stats.emailsFailed30d - stats.emailsNonTx30d,
        non_transaction: stats.emailsNonTx30d,
        failed: stats.emailsFailed30d,
      },
    };
  }

  async getIngestionTimeline(range: AdminDateRangeDTO): Promise<IngestionTimelineResponseDTO> {
    const { from, to } = this.defaultRange(range);
    const buckets = await this.adminRepository.getIngestionTimeline(from, to);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      buckets,
    };
  }

  async getTransactionVolume(range: AdminDateRangeDTO): Promise<TransactionVolumeResponseDTO> {
    const { from, to } = this.defaultRange(range);
    const data = await this.adminRepository.getTransactionVolume(from, to);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      ...data,
    };
  }

  async getUserStats(): Promise<UserStatsResponseDTO> {
    const s = await this.adminRepository.getFullUserStats();
    return {
      total_users: s.total,
      new_users_30d: s.newUsers30d,
      active_30d: s.active30d,
      onboarding_funnel: {
        signed_up: s.signedUp,
        email_connected: s.emailConnected,
        onboarding_complete: s.onboardingComplete,
        first_transaction_parsed: s.firstTransactionParsed,
      },
      by_plan: {
        free: s.planFree,
        pro: s.planPro,
        premium: s.planPremium,
      },
      retention: {
        users_with_tx_last_7d: s.usersWithTx7d,
        users_with_tx_last_30d: s.usersWithTx30d,
      },
    };
  }

  async getUserRegexStat(userId: number): Promise<UserRegexStatResponseDTO> {
    return this.adminRepository.getUserRegexStat(userId);
  }

  async getAiUsage(range: AdminDateRangeDTO): Promise<AiUsageResponseDTO> {
    const { from, to } = this.defaultRange(range);
    const { byOperation, trend, costTrend } = await this.adminRepository.getAiUsageByPeriod(from, to);

    // Each row is now scoped per (bucket, model_used), so it can be priced
    // with that row's actual model instead of one flat rate applied to the
    // whole aggregate. See fintrack-backend#141.
    const rowCost = (r: any) =>
      calculateCostUsd(Number(r.prompt_tokens), Number(r.completion_tokens), r.model_used);

    const totalTokens = byOperation.reduce((acc: number, r: any) => acc + Number(r.total_tokens), 0);
    const totalCost = byOperation.reduce((acc: number, r: any) => acc + rowCost(r), 0);

    // Collapse the per-model rows back into one entry per operation - the
    // response shape callers/UI expect - summing tokens and (per-model-
    // priced) cost across whichever models actually served that operation.
    const byOperationMap = new Map<
      string,
      { call_count: number; prompt_tokens: number; completion_tokens: number; total_tokens: number; cost: number }
    >();
    for (const r of byOperation as any[]) {
      const entry = byOperationMap.get(r.operation) ?? {
        call_count: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cost: 0,
      };
      entry.call_count += Number(r.call_count);
      entry.prompt_tokens += Number(r.prompt_tokens);
      entry.completion_tokens += Number(r.completion_tokens);
      entry.total_tokens += Number(r.total_tokens);
      entry.cost += rowCost(r);
      byOperationMap.set(r.operation, entry);
    }
    const byOperationFormatted = Array.from(byOperationMap.entries()).map(([operation, e]) => ({
      operation,
      call_count: e.call_count,
      prompt_tokens: e.prompt_tokens,
      completion_tokens: e.completion_tokens,
      total_tokens: e.total_tokens,
      estimated_cost_usd: parseFloat(e.cost.toFixed(6)),
      pct_of_total_cost: totalCost > 0 ? parseFloat(((e.cost / totalCost) * 100).toFixed(2)) : 0,
    }));

    // Same collapse for the daily trend - one point per date, summed across
    // models.
    const trendMap = new Map<string, { total_tokens: number; call_count: number; cost: number }>();
    for (const r of trend as any[]) {
      const entry = trendMap.get(r.date) ?? { total_tokens: 0, call_count: 0, cost: 0 };
      entry.total_tokens += Number(r.total_tokens);
      entry.call_count += Number(r.call_count);
      entry.cost += rowCost(r);
      trendMap.set(r.date, entry);
    }
    const trendFormatted = Array.from(trendMap.entries()).map(([date, e]) => ({
      date,
      total_tokens: e.total_tokens,
      estimated_cost_usd: parseFloat(e.cost.toFixed(6)),
      call_count: e.call_count,
    }));

    // costTrend's tx_count comes from a join keyed only on date, not model -
    // every model-row for a given date carries the same tx_count, so it's
    // taken once per date rather than summed across models.
    const costTrendMap = new Map<string, { cost: number; tx_count: number }>();
    for (const r of costTrend as any[]) {
      const entry = costTrendMap.get(r.date) ?? { cost: 0, tx_count: Number(r.tx_count) || 0 };
      entry.cost += rowCost(r);
      costTrendMap.set(r.date, entry);
    }
    const costPerTxTrend = Array.from(costTrendMap.entries()).map(([date, e]) => {
      const txCount = e.tx_count || 1;
      return {
        date,
        cost_per_tx: parseFloat((e.cost / txCount).toFixed(6)),
      };
    });

    const ago30TxStats = await this.adminRepository.getTransactionStats();
    const costPerTx30d = ago30TxStats.count30d > 0
      ? parseFloat((totalCost / ago30TxStats.count30d).toFixed(6))
      : 0;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        prompt_tokens: byOperation.reduce((a: number, r: any) => a + Number(r.prompt_tokens), 0),
        completion_tokens: byOperation.reduce((a: number, r: any) => a + Number(r.completion_tokens), 0),
        total_tokens: totalTokens,
        estimated_cost_usd: parseFloat(totalCost.toFixed(6)),
        call_count: byOperation.reduce((a: number, r: any) => a + Number(r.call_count), 0),
      },
      by_operation: byOperationFormatted,
      trend: trendFormatted,
      cost_per_transaction_30d: costPerTx30d,
      cost_per_transaction_trend: costPerTxTrend,
    };
  }

  async takeSnapshot(): Promise<void> {
    const overview = await this.getOverview();
    await this.adminRepository.saveSnapshot(overview);
  }

  async auditTemplate(templateId: number): Promise<AuditResult> {
    return this.parserRuleService.auditTemplate(templateId);
  }

  async promoteTemplate(templateId: number): Promise<ParserTemplateResponseDTO> {
    return this.parserRuleService.promoteTemplate(templateId);
  }

  async bulkReauditFailed(): Promise<BulkReauditResult> {
    return this.parserRuleService.bulkReauditFailed();
  }
}

export default AdminService;
