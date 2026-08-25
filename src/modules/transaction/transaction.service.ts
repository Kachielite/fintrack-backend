import { inject, injectable } from 'tsyringe';
import { ITransactionRepository } from './transaction.repository';
import { ITransaction, IDailySpendPoint, IDailySpendDetail, IMonthSpendSummary } from './transaction.interface';
import {
  CorrectTransactionDTO,
  TransactionQueryDTO,
  BulkCategoryDTO,
  CreateManualTransactionDTO,
} from './transaction.dto';
import { parse } from 'csv-parse/sync';
import { TransactionStatusEnum, TransactionTypeEnum } from './transaction.enum';
import { IParserRuleService } from '@/modules/parser-rule/parser-rule.service';
import ParserRuleService from '@/modules/parser-rule/parser-rule.service';
import { ITransferLinkRepository } from '@/modules/account/transfer-link.repository';
import { IGeneralResponse, IPagination } from '@/common/types/interface';
import { BadRequestException, InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';
import { IUserRepository } from '@/modules/user/user.repository';
import { IUser } from '@/modules/user/user.interface';
import { getRetentionMonthsForPlan } from '@/modules/user/user.constants';
import { IExchangeRateService } from '@/modules/exchange-rate/exchange-rate.service';
import NotificationService, { INotificationService } from '@/modules/notification/notification.service';
import AccountService, { IAccountService } from '@/modules/account/account.service';

// Extra buffer between a transaction crossing the retention cutoff and it
// actually being deleted, so the warning notification always has real lead time.
const RETENTION_WARNING_GRACE_DAYS = 14;

export interface ITransactionService {
  listTransactions(userId: number, query: TransactionQueryDTO): Promise<IPagination<ITransaction>>;
  getSummary(
    userId: number,
    year?: number,
    month?: number,
  ): Promise<Record<string, unknown>>;
  getChartData(userId: number, period: string): Promise<Record<string, unknown>>;
  getDailySpend(
    userId: number,
    year?: number,
    month?: number,
  ): Promise<{ month: IMonthSpendSummary; days: IDailySpendDetail[] }>;
  getTransaction(id: number, userId: number): Promise<ITransaction>;
  correctTransaction(
    id: number,
    userId: number,
    data: CorrectTransactionDTO,
  ): Promise<ITransaction>;
  getSimilarTransactions(id: number, userId: number): Promise<ITransaction[]>;
  bulkCorrectCategory(userId: number, data: BulkCategoryDTO): Promise<{ updated: number }>;
  getUnverified(userId: number): Promise<ITransaction[]>;
  pruneExpiredTransactions(): Promise<void>;
  markTransfer(userId: number, id: number, linkedTransactionId?: number): Promise<ITransaction>;
  unmarkTransfer(userId: number, id: number): Promise<ITransaction>;
  getLinkedTransaction(userId: number, id: number): Promise<ITransaction | null>;
  getRetentionStatus(userId: number): Promise<{
    retentionMonths: number;
    transactionsAtRisk: number;
    cutoffDate: string;
  }>;
  exportTransactionsCsv(userId: number): Promise<string>;
  createManualTransaction(userId: number, data: CreateManualTransactionDTO): Promise<ITransaction>;
  importTransactionsCsv(
    userId: number,
    csv: string,
  ): Promise<{ imported: number; skippedDuplicates: number; skippedInvalid: number; errors: string[] }>;
}

@injectable()
class TransactionService implements ITransactionService {
  constructor(
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
    @inject(ParserRuleService) private parserRuleService: IParserRuleService,
    @inject('IUserRepository') private userRepository: IUserRepository,
    @inject('ITransferLinkRepository') private transferLinkRepository: ITransferLinkRepository,
    @inject('IExchangeRateService') private exchangeRateService: IExchangeRateService,
    @inject(NotificationService) private notificationService: INotificationService,
    @inject(AccountService) private accountService: IAccountService,
  ) {}

  async listTransactions(
    userId: number,
    query: TransactionQueryDTO,
  ): Promise<IPagination<ITransaction>> {
    try {
      logger.info(`[Transaction] Listing transactions for user ${userId}`);
      return await this.transactionRepository.findAll({
        userId,
        page: query.page,
        limit: query.limit,
        category: query.category,
        currency: query.currency,
        bankId: query.bank_id,
        status: query.status,
        dateFrom: query.date_from ? new Date(query.date_from) : undefined,
        dateTo: query.date_to ? new Date(query.date_to) : undefined,
        search: query.search,
      });
    } catch (error) {
      logger.error(`Error listing transactions for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to list transactions');
    }
  }

  async getSummary(
    userId: number,
    year?: number,
    month?: number,
  ): Promise<Record<string, unknown>> {
    try {
      logger.info(`[Transaction] Getting summary for user ${userId} (year=${year}, month=${month})`);
      const now = new Date();
      const y = year || now.getFullYear();
      const m = month !== undefined ? month : now.getMonth() + 1;

      const from = new Date(y, m - 1, 1);
      const to = new Date(y, m, 0, 23, 59, 59);

      // Fetch the last 3 months worth of data for the rolling average comparison
      const threeMonthsFrom = new Date(y, m - 4, 1);
      const threeMonthsTo = new Date(y, m - 1, 0, 23, 59, 59);

      const [transactions, prevTransactions] = await Promise.all([
        this.transactionRepository.findForSummary(userId, from, to),
        this.transactionRepository.findForSummary(userId, threeMonthsFrom, threeMonthsTo),
      ]);

      const totalSpend = transactions
        .filter((t) => t.amount < 0)
        .reduce((acc, t) => acc + Math.abs(t.refAmount), 0);
      const totalIncome = transactions
        .filter((t) => t.amount > 0)
        .reduce((acc, t) => acc + t.refAmount, 0);

      // Split the 3-month window into individual months and average their spend
      const monthlySpends: number[] = [];
      for (let i = 1; i <= 3; i++) {
        const mStart = new Date(y, m - 1 - i, 1);
        const mEnd = new Date(y, m - i, 0, 23, 59, 59);
        const spend = prevTransactions
          .filter((t) => {
            const d = new Date(t.transactionDate);
            return t.amount < 0 && d >= mStart && d <= mEnd;
          })
          .reduce((acc, t) => acc + Math.abs(t.refAmount), 0);
        if (spend > 0) monthlySpends.push(spend);
      }
      const avgPrevSpend =
        monthlySpends.length > 0
          ? monthlySpends.reduce((s, v) => s + v, 0) / monthlySpends.length
          : 0;

      // Only show comparison when we have ≥2 months of real prior spend; otherwise
      // a tiny single-month baseline produces absurdly large percentages.
      const vsLastPeriodPct =
        monthlySpends.length >= 2
          ? ((totalSpend - avgPrevSpend) / avgPrevSpend) * 100
          : null;

      const categoryMap = new Map<string, { total: number; count: number }>();
      for (const t of transactions.filter((tx) => tx.amount < 0)) {
        const cat = t.category;
        const existing = categoryMap.get(cat) || { total: 0, count: 0 };
        categoryMap.set(cat, { total: existing.total + Math.abs(t.refAmount), count: existing.count + 1 });
      }

      const byCategory = Array.from(categoryMap.entries()).map(([category, data]) => ({
        category,
        total: data.total,
        count: data.count,
        percentage: totalSpend > 0 ? (data.total / totalSpend) * 100 : 0,
      }));

      const currencyMap = new Map<string, { spend: number; income: number }>();
      for (const t of transactions) {
        const cur = t.currency;
        const existing = currencyMap.get(cur) || { spend: 0, income: 0 };
        if (t.amount < 0) existing.spend += Math.abs(t.amount);
        else existing.income += t.amount;
        currencyMap.set(cur, existing);
      }

      const byCurrency = Array.from(currencyMap.entries()).map(([currency, data]) => ({
        currency,
        spend: data.spend,
        income: data.income,
        net: data.income - data.spend,
      }));

      return {
        period_start: from.toISOString(),
        period_end: to.toISOString(),
        total_spend: totalSpend,
        total_income: totalIncome,
        net: totalIncome - totalSpend,
        ref_currency: transactions[0]?.refCurrency || 'NGN',
        by_category: byCategory,
        by_currency: byCurrency,
        vs_last_period_pct: vsLastPeriodPct,
      };
    } catch (error) {
      logger.error(`Error getting summary for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to get transaction summary');
    }
  }

  async getChartData(userId: number, period: string): Promise<Record<string, unknown>> {
    try {
      logger.info(`[Transaction] Getting chart data for user ${userId} (period=${period})`);
      const now = new Date();
      let months = 1;
      if (period === '3m') months = 3;
      else if (period === '6m') months = 6;

      const from = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
      const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      // Trend window can't outrun what the user's plan actually retains —
      // a free-tier user with a 2-month window would otherwise see 4 blank
      // months on a chart that implies 6 months of history.
      const user = await this.userRepository.findById(userId);
      const retentionMonths = getRetentionMonthsForPlan(user?.planTier ?? 'free');
      const trendMonths = Math.min(6, retentionMonths);

      const trendFrom = new Date(now.getFullYear(), now.getMonth() - (trendMonths - 1), 1);
      const trendTo = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

      const [transactions, trendTransactions] = await Promise.all([
        this.transactionRepository.findForSummary(userId, from, to),
        this.transactionRepository.findForSummary(userId, trendFrom, trendTo),
      ]);

      const refCurrency = transactions.find((t) => t.refCurrency)?.refCurrency || 'NGN';

      // Daily spend
      const dailySpend = this.computeDailySpend(transactions);

      // By category
      const totalSpend = transactions.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.refAmount), 0);
      const catMap = new Map<string, { total: number; count: number }>();
      for (const t of transactions.filter((t) => t.amount < 0)) {
        const e = catMap.get(t.category) || { total: 0, count: 0 };
        catMap.set(t.category, { total: e.total + Math.abs(t.refAmount), count: e.count + 1 });
      }
      const byCategory = Array.from(catMap.entries())
        .map(([category, d]) => ({
          category,
          total: Math.round(d.total),
          count: d.count,
          percentage: totalSpend > 0 ? (d.total / totalSpend) * 100 : 0,
        }))
        .sort((a, b) => b.total - a.total);

      // Weekday vs weekend (0=Sun, 6=Sat)
      let weekdaySpend = 0;
      let weekendSpend = 0;
      for (const t of transactions.filter((t) => t.amount < 0)) {
        const day = new Date(t.transactionDate).getDay();
        if (day === 0 || day === 6) weekendSpend += Math.abs(t.refAmount);
        else weekdaySpend += Math.abs(t.refAmount);
      }

      // Monthly trend — capped to the user's retention window (see trendMonths above)
      const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const trendMap = new Map<string, { spend: number; income: number }>();
      for (let i = trendMonths - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        trendMap.set(`${MONTHS[d.getMonth()]} ${d.getFullYear()}`, { spend: 0, income: 0 });
      }
      for (const t of trendTransactions) {
        const d = new Date(t.transactionDate);
        const key = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
        if (!trendMap.has(key)) continue;
        const e = trendMap.get(key)!;
        if (t.amount < 0) e.spend += Math.abs(t.refAmount);
        else e.income += t.refAmount;
        trendMap.set(key, e);
      }
      const monthlyTrend = Array.from(trendMap.entries()).map(([month, d]) => ({
        month,
        spend: Math.round(d.spend),
        income: Math.round(d.income),
      }));

      // Day of week (Mon-Sun order)
      const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dowTotals = new Map<number, number>();
      for (let i = 0; i < 7; i++) dowTotals.set(i, 0);
      for (const t of transactions.filter((t) => t.amount < 0)) {
        const day = new Date(t.transactionDate).getDay();
        dowTotals.set(day, (dowTotals.get(day) || 0) + Math.abs(t.refAmount));
      }
      const dayOfWeek = [1, 2, 3, 4, 5, 6, 0].map((d) => ({
        day: DOW[d],
        spend: Math.round(dowTotals.get(d) || 0),
      }));

      // By currency
      const currencyMap = new Map<string, number>();
      for (const t of transactions.filter((t) => t.amount < 0)) {
        currencyMap.set(t.currency, (currencyMap.get(t.currency) || 0) + Math.abs(t.amount));
      }
      const byCurrency = Array.from(currencyMap.entries())
        .map(([currency, amount]) => ({ currency, amount: Math.round(amount) }))
        .sort((a, b) => b.amount - a.amount);

      // Top merchants
      const merchantMap = new Map<string, { total: number; count: number }>();
      for (const t of transactions.filter((t) => t.amount < 0)) {
        const e = merchantMap.get(t.merchant) || { total: 0, count: 0 };
        merchantMap.set(t.merchant, { total: e.total + Math.abs(t.refAmount), count: e.count + 1 });
      }
      const topMerchants = Array.from(merchantMap.entries())
        .map(([merchant, d]) => ({ merchant, total: Math.round(d.total), count: d.count }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 8);

      return {
        ref_currency: refCurrency,
        daily_spend: dailySpend,
        by_category: byCategory,
        weekday_vs_weekend: { weekday: Math.round(weekdaySpend), weekend: Math.round(weekendSpend) },
        monthly_trend: monthlyTrend,
        day_of_week: dayOfWeek,
        by_currency: byCurrency,
        top_merchants: topMerchants,
        period_start: from.toISOString(),
        period_end: to.toISOString(),
      };
    } catch (error) {
      logger.error(`Error getting chart data for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to get chart data');
    }
  }

  /**
   * Daily spend/income/net for one explicit month, plus the month's totals —
   * unlike getChartData's period (1m/3m/6m, always relative to today), this
   * takes a target year/month so a calendar view can page to any month, not
   * just the current one.
   *
   * Every transaction is converted at the CURRENT exchange rate to the
   * user's CURRENT ref currency, rather than trusting each transaction's
   * stored refAmount/refCurrency (which reflects whatever the user's ref
   * currency was at ingestion time). If the user ever changes their ref
   * currency, or a historical conversion silently fell back to an
   * unconverted amount, summing stored refAmount directly would mix
   * incompatible values. Re-converting from the transaction's own currency
   * at query time, all in one pass with one rate per currency, keeps every
   * figure in this response internally consistent.
   */
  async getDailySpend(
    userId: number,
    year?: number,
    month?: number,
  ): Promise<{ month: IMonthSpendSummary; days: IDailySpendDetail[] }> {
    try {
      const now = new Date();
      const y = year || now.getFullYear();
      const m = month !== undefined ? month : now.getMonth() + 1;

      const from = new Date(y, m - 1, 1);
      const to = new Date(y, m, 0, 23, 59, 59);

      logger.info(`[Transaction] Getting daily spend for user ${userId} (year=${y}, month=${m})`);
      const [user, transactions] = await Promise.all([
        this.userRepository.findById(userId),
        this.transactionRepository.findForSummary(userId, from, to),
      ]);
      const refCurrency = user?.refCurrency ?? 'NGN';

      return await this.aggregateDailySpend(transactions, refCurrency);
    } catch (error) {
      logger.error(`Error getting daily spend for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to get daily spend');
    }
  }

  private async aggregateDailySpend(
    transactions: ITransaction[],
    refCurrency: string,
  ): Promise<{ month: IMonthSpendSummary; days: IDailySpendDetail[] }> {
    const currencies = [...new Set(transactions.map((t) => t.currency))];
    const rateEntries = await Promise.all(
      currencies.map(async (c) => [c, await this.exchangeRateService.getRate(c, refCurrency)] as const),
    );
    const rateMap = new Map(rateEntries);

    const dailyMap = new Map<string, { spend: number; income: number }>();

    for (const t of transactions) {
      const rate = rateMap.get(t.currency) ?? 1;
      const converted = Math.abs(t.amount) * rate;
      const key = new Date(t.transactionDate).toISOString().split('T')[0];
      const e = dailyMap.get(key) || { spend: 0, income: 0 };
      if (t.amount < 0) {
        e.spend += converted;
      } else {
        e.income += converted;
      }
      dailyMap.set(key, e);
    }

    const days = Array.from(dailyMap.entries())
      .map(([date, d]) => {
        const spend = Math.round(d.spend);
        const income = Math.round(d.income);
        return { date, spend, income, net: income - spend };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    // Derive month totals from the already-rounded daily figures (not the raw
    // accumulators) so the displayed month total always equals the sum of the
    // displayed daily figures — rounding each independently can otherwise drift
    // by a unit or two.
    const monthSpendRounded = days.reduce((s, d) => s + d.spend, 0);
    const monthIncomeRounded = days.reduce((s, d) => s + d.income, 0);

    return {
      month: {
        spend: monthSpendRounded,
        income: monthIncomeRounded,
        net: monthIncomeRounded - monthSpendRounded,
      },
      days,
    };
  }

  private computeDailySpend(transactions: ITransaction[]): IDailySpendPoint[] {
    const dailyMap = new Map<string, { spend: number; income: number }>();
    for (const t of transactions) {
      const key = new Date(t.transactionDate).toISOString().split('T')[0];
      const e = dailyMap.get(key) || { spend: 0, income: 0 };
      if (t.amount < 0) e.spend += Math.abs(t.refAmount);
      else e.income += t.refAmount;
      dailyMap.set(key, e);
    }
    return Array.from(dailyMap.entries())
      .map(([date, d]) => ({ date, spend: Math.round(d.spend), income: Math.round(d.income) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async getTransaction(id: number, userId: number): Promise<ITransaction> {
    try {
      logger.info(`[Transaction] Fetching transaction ${id} for user ${userId}`);
      const transaction = await this.transactionRepository.findById(id, userId);
      if (!transaction) throw new ResourceNotFoundException('Transaction not found');
      return transaction;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error fetching transaction ${id} - ${error}`);
      throw new InternalServerException('Failed to fetch transaction');
    }
  }

  async correctTransaction(
    id: number,
    userId: number,
    data: CorrectTransactionDTO,
  ): Promise<ITransaction> {
    try {
      logger.info(`[Transaction] Correcting transaction ${id} for user ${userId}`);
      const transaction = await this.transactionRepository.findById(id, userId);
      if (!transaction) throw new ResourceNotFoundException('Transaction not found');

      const updateData: Partial<ITransaction> = { status: TransactionStatusEnum.CORRECTED };
      if (data.merchant) updateData.merchant = data.merchant;
      if (data.category) updateData.category = data.category;
      if (data.transaction_type) updateData.transactionType = data.transaction_type;
      if (data.amount !== undefined) updateData.amount = data.amount;

      const updated = await this.transactionRepository.update(id, userId, updateData);

      if (transaction.parserTemplateId) {
        setImmediate(() => {
          this.parserRuleService.recordFailure(transaction.parserTemplateId!).catch((err) => {
            logger.error(`Failed to record failure for template ${transaction.parserTemplateId} - ${err}`);
          });
        });
      }

      return updated;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error correcting transaction ${id} - ${error}`);
      throw new InternalServerException('Failed to correct transaction');
    }
  }

  async getSimilarTransactions(id: number, userId: number): Promise<ITransaction[]> {
    try {
      logger.info(`[Transaction] Fetching similar transactions for ${id} (user ${userId})`);
      const transaction = await this.transactionRepository.findById(id, userId);
      if (!transaction) throw new ResourceNotFoundException('Transaction not found');
      return await this.transactionRepository.findSimilarByMerchant(
        userId,
        transaction.merchant,
        transaction.category,
        id,
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error fetching similar transactions for ${id} - ${error}`);
      throw new InternalServerException('Failed to fetch similar transactions');
    }
  }

  async bulkCorrectCategory(userId: number, data: BulkCategoryDTO): Promise<{ updated: number }> {
    try {
      logger.info(`[Transaction] Bulk correcting ${data.ids.length} transactions for user ${userId}`);
      const updated = await this.transactionRepository.bulkUpdateCategory(userId, data.ids, data.category);
      return { updated };
    } catch (error) {
      logger.error(`Error bulk correcting categories for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to bulk update categories');
    }
  }

  async getUnverified(userId: number): Promise<ITransaction[]> {
    try {
      logger.info(`[Transaction] Fetching unverified transactions for user ${userId}`);
      return await this.transactionRepository.findUnverified(userId);
    } catch (error) {
      logger.error(`Error fetching unverified transactions for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to fetch unverified transactions');
    }
  }

  async pruneExpiredTransactions(): Promise<void> {
    try {
      logger.info('Starting transaction pruning job');
      const allUsers = await this.userRepository.findAll?.() || [];
      for (const user of allUsers) {
        const retentionMonths = getRetentionMonthsForPlan(user.planTier);
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - retentionMonths);

        // Data only becomes eligible for deletion once it's past the cutoff
        // AND past this extra grace window — guaranteeing real lead time
        // between a user seeing the "data at risk" warning and it being gone,
        // rather than pruning silently the moment the cutoff is crossed.
        const graceCutoff = new Date(cutoff);
        graceCutoff.setDate(graceCutoff.getDate() - RETENTION_WARNING_GRACE_DAYS);

        await this.warnIfApproachingRetentionCutoff(user, cutoff);
        await this.transactionRepository.deleteOlderThan(user.id, graceCutoff);
      }
      logger.info('Transaction pruning completed');
    } catch (error) {
      logger.error(`Error pruning transactions - ${error}`);
    }
  }

  private async warnIfApproachingRetentionCutoff(user: IUser, cutoff: Date): Promise<void> {
    try {
      const atRisk = await this.transactionRepository.countOlderThan(user.id, cutoff);
      if (atRisk === 0) return;

      // Dedupe: don't re-warn if we already sent one within the grace window.
      const recentNotifications = await this.notificationService.list(user.id);
      const warnedRecently = recentNotifications.some((n) => {
        if (n.type !== 'retention_warning') return false;
        const ageMs = Date.now() - new Date(n.createdAt).getTime();
        return ageMs < RETENTION_WARNING_GRACE_DAYS * 24 * 60 * 60 * 1000;
      });
      if (warnedRecently) return;

      const retentionMonths = getRetentionMonthsForPlan(user.planTier);
      await this.notificationService.create({
        userId: user.id,
        type: 'retention_warning',
        title: 'Older transactions will be removed soon',
        body: `You have ${atRisk} transaction${atRisk === 1 ? '' : 's'} older than your ${retentionMonths}-month retention window. Export your data if you want to keep it — they'll be deleted in about ${RETENTION_WARNING_GRACE_DAYS} days.`,
        data: { transactionsAtRisk: atRisk, retentionMonths, cutoffDate: cutoff.toISOString() },
      });
    } catch (error) {
      logger.warn(`[Transaction] Retention warning check failed for user ${user.id}: ${error}`);
    }
  }

  async getRetentionStatus(userId: number): Promise<{
    retentionMonths: number;
    transactionsAtRisk: number;
    cutoffDate: string;
  }> {
    try {
      const user = await this.userRepository.findById(userId);
      const retentionMonths = getRetentionMonthsForPlan(user?.planTier ?? 'free');
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - retentionMonths);
      const transactionsAtRisk = await this.transactionRepository.countOlderThan(userId, cutoff);
      return { retentionMonths, transactionsAtRisk, cutoffDate: cutoff.toISOString() };
    } catch (error) {
      logger.error(`Error getting retention status for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to get retention status');
    }
  }

  async exportTransactionsCsv(userId: number): Promise<string> {
    try {
      logger.info(`[Transaction] Exporting transactions to CSV for user ${userId}`);
      const transactions = await this.transactionRepository.findAllForExport(userId);
      const columns = [
        'date',
        'merchant',
        'category',
        'type',
        'amount',
        'currency',
        'ref_amount',
        'ref_currency',
        'status',
        'reference',
        'balance',
        'excluded_from_totals',
      ];
      const rows = transactions.map((t) => [
        t.transactionDate.toISOString(),
        t.merchant,
        t.category,
        t.transactionType,
        t.amount,
        t.currency,
        t.refAmount,
        t.refCurrency,
        t.status,
        t.reference ?? '',
        t.balance ?? '',
        t.excludeFromTotals,
      ]);
      return this.toCsv(columns, rows);
    } catch (error) {
      logger.error(`Error exporting transactions for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to export transactions');
    }
  }

  private toCsv(columns: string[], rows: (string | number | boolean)[][]): string {
    const escape = (value: string | number | boolean): string => {
      const str = String(value);
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [columns.map(escape).join(',')];
    for (const row of rows) {
      lines.push(row.map(escape).join(','));
    }
    return lines.join('\n');
  }

  /** Creates a transaction directly from user input, bypassing email ingestion entirely. */
  async createManualTransaction(userId: number, data: CreateManualTransactionDTO): Promise<ITransaction> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) throw new ResourceNotFoundException('User not found');

      const currency = data.currency.toUpperCase();
      let accountId: number | undefined;
      if (data.account_id) {
        const account = await this.accountService.findOwnedAccount(userId, data.account_id);
        if (!account) throw new ResourceNotFoundException('Account not found');
        accountId = account.id;
      } else {
        const account = await this.accountService.resolveOrCreate(userId, null, currency);
        accountId = account.id;
      }

      const amountAbs = Math.abs(data.amount);
      const signedAmount = data.transaction_type === TransactionTypeEnum.DEBIT ? -amountAbs : amountAbs;
      const [refAmount, exchangeRateUsed] = await Promise.all([
        this.exchangeRateService.convert(amountAbs, currency, user.refCurrency),
        this.exchangeRateService.getRate(currency, user.refCurrency),
      ]);

      const transaction = await this.transactionRepository.create({
        userId,
        accountId,
        merchant: data.merchant,
        category: data.category,
        transactionType: data.transaction_type,
        amount: signedAmount,
        currency,
        refAmount,
        refCurrency: user.refCurrency,
        exchangeRateUsed,
        transactionDate: new Date(data.transaction_date),
        // Manually entered by the user themselves — no AI confidence to verify.
        status: TransactionStatusEnum.VERIFIED,
        reference: data.reference,
        balance: data.balance,
      });

      return transaction;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error creating manual transaction for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to create transaction');
    }
  }

  /**
   * Parses an uploaded CSV into transactions, using the same column layout
   * exportTransactionsCsv produces (date, merchant, category, type, amount,
   * currency, reference, balance — extra/derived columns are ignored).
   * Deduped the same way ingestion dedupes, via existsSimilarTransaction.
   */
  async importTransactionsCsv(
    userId: number,
    csv: string,
  ): Promise<{ imported: number; skippedDuplicates: number; skippedInvalid: number; errors: string[] }> {
    try {
      const user = await this.userRepository.findById(userId);
      if (!user) throw new ResourceNotFoundException('User not found');

      let records: Record<string, string>[];
      try {
        records = parse(csv, {
          columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
          skip_empty_lines: true,
          trim: true,
        });
      } catch (parseError) {
        throw new BadRequestException(`Could not parse CSV: ${parseError}`);
      }

      let imported = 0;
      let skippedDuplicates = 0;
      let skippedInvalid = 0;
      const errors: string[] = [];

      for (let i = 0; i < records.length; i++) {
        const rowNumber = i + 2; // +1 for header, +1 for 1-indexing
        const row = records[i];
        try {
          const merchant = row.merchant?.trim();
          const category = row.category?.trim();
          const typeRaw = row.type?.trim().toLowerCase();
          const currency = row.currency?.trim().toUpperCase();
          const dateRaw = row.date?.trim();
          const amountAbs = Math.abs(parseFloat(row.amount));

          if (!merchant || !category || !currency || currency.length !== 3 || !dateRaw || !isFinite(amountAbs) || amountAbs <= 0) {
            skippedInvalid++;
            errors.push(`Row ${rowNumber}: missing or invalid required field`);
            continue;
          }
          const transactionDate = new Date(dateRaw);
          if (isNaN(transactionDate.getTime())) {
            skippedInvalid++;
            errors.push(`Row ${rowNumber}: invalid date`);
            continue;
          }
          const transactionType =
            typeRaw === TransactionTypeEnum.CREDIT ? TransactionTypeEnum.CREDIT : TransactionTypeEnum.DEBIT;
          const reference = row.reference?.trim() || undefined;
          const balance = row.balance?.trim() ? parseFloat(row.balance) : undefined;
          const signedAmount = transactionType === TransactionTypeEnum.DEBIT ? -amountAbs : amountAbs;

          const isDuplicate = await this.transactionRepository.existsSimilarTransaction({
            userId,
            currency,
            amountAbs,
            transactionType,
            reference,
            merchant,
            transactionDate,
          });
          if (isDuplicate) {
            skippedDuplicates++;
            continue;
          }

          const account = await this.accountService.resolveOrCreate(userId, null, currency);
          const [refAmount, exchangeRateUsed] = await Promise.all([
            this.exchangeRateService.convert(amountAbs, currency, user.refCurrency),
            this.exchangeRateService.getRate(currency, user.refCurrency),
          ]);

          await this.transactionRepository.create({
            userId,
            accountId: account.id,
            merchant,
            category,
            transactionType,
            amount: signedAmount,
            currency,
            refAmount,
            refCurrency: user.refCurrency,
            exchangeRateUsed,
            transactionDate,
            status: TransactionStatusEnum.VERIFIED,
            reference,
            balance,
          });
          imported++;
        } catch (rowError) {
          skippedInvalid++;
          errors.push(`Row ${rowNumber}: ${rowError}`);
        }
      }

      logger.info(
        `[Transaction] CSV import for user ${userId}: imported=${imported}, duplicates=${skippedDuplicates}, invalid=${skippedInvalid}`,
      );
      return { imported, skippedDuplicates, skippedInvalid, errors: errors.slice(0, 20) };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error importing CSV transactions for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to import transactions');
    }
  }

  async markTransfer(userId: number, id: number, linkedTransactionId?: number): Promise<ITransaction> {
    try {
      const transaction = await this.transactionRepository.findById(id, userId);
      if (!transaction) throw new ResourceNotFoundException('Transaction not found');

      // Replace any existing link this transaction is already part of, rather than layering a second one on top.
      await this.clearExistingLink(transaction.id);

      if (linkedTransactionId !== undefined) {
        const linked = await this.transactionRepository.findById(linkedTransactionId, userId);
        if (!linked) throw new ResourceNotFoundException('Linked transaction not found');
        if (linked.id === transaction.id) {
          throw new BadRequestException('A transaction cannot be linked to itself');
        }
        if (linked.transactionType === transaction.transactionType) {
          throw new BadRequestException('Linked transactions must be opposite in direction (one debit, one credit)');
        }
        await this.clearExistingLink(linked.id);

        const debit = transaction.transactionType === TransactionTypeEnum.DEBIT ? transaction : linked;
        const credit = debit === transaction ? linked : transaction;
        const linkType = transaction.currency === linked.currency ? 'internal_transfer' : 'currency_conversion';

        await this.transferLinkRepository.create({
          userId,
          fromTransactionId: debit.id,
          toTransactionId: credit.id,
          linkType,
          confidence: 'user_created',
        });
        await this.transactionRepository.markExcludedFromTotals([transaction.id, linked.id]);
      } else {
        const isDebit = transaction.transactionType === TransactionTypeEnum.DEBIT;
        await this.transferLinkRepository.create({
          userId,
          fromTransactionId: isDebit ? transaction.id : null,
          toTransactionId: isDebit ? null : transaction.id,
          linkType: 'internal_transfer',
          confidence: 'user_created',
        });
        await this.transactionRepository.markExcludedFromTotals([transaction.id]);
      }

      return (await this.transactionRepository.findById(id, userId)) as ITransaction;
    } catch (error) {
      if (error instanceof ResourceNotFoundException || error instanceof BadRequestException) throw error;
      logger.error(`[Transaction] markTransfer error for transaction ${id} - ${error}`);
      throw new InternalServerException('Failed to mark transaction as transfer');
    }
  }

  async unmarkTransfer(userId: number, id: number): Promise<ITransaction> {
    try {
      const transaction = await this.transactionRepository.findById(id, userId);
      if (!transaction) throw new ResourceNotFoundException('Transaction not found');

      await this.clearExistingLink(transaction.id);

      return (await this.transactionRepository.findById(id, userId)) as ITransaction;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`[Transaction] unmarkTransfer error for transaction ${id} - ${error}`);
      throw new InternalServerException('Failed to unmark transaction as transfer');
    }
  }

  async getLinkedTransaction(userId: number, id: number): Promise<ITransaction | null> {
    try {
      const transaction = await this.transactionRepository.findById(id, userId);
      if (!transaction) throw new ResourceNotFoundException('Transaction not found');

      const link = await this.transferLinkRepository.findByTransactionId(id);
      if (!link) return null;

      const linkedId = link.fromTransactionId === id ? link.toTransactionId : link.fromTransactionId;
      if (linkedId === null) return null;

      return await this.transactionRepository.findById(linkedId, userId);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`[Transaction] getLinkedTransaction error for transaction ${id} - ${error}`);
      throw new InternalServerException('Failed to fetch linked transaction');
    }
  }

  /** Removes any existing transfer_links row this transaction is part of and un-excludes both its legs. */
  private async clearExistingLink(transactionId: number): Promise<void> {
    const existing = await this.transferLinkRepository.findByTransactionId(transactionId);
    if (!existing) return;

    const legIds = [existing.fromTransactionId, existing.toTransactionId].filter(
      (x): x is number => x !== null,
    );
    await this.transferLinkRepository.delete(existing.id);
    await this.transactionRepository.markIncludedInTotals(legIds);
  }
}

export default TransactionService;
