import { inject, injectable } from 'tsyringe';
import { ITransactionRepository } from './transaction.repository';
import { ITransaction, IDailySpendPoint, IDailySpendDetail, IMonthSpendSummary } from './transaction.interface';
import {
  CorrectTransactionDTO,
  TransactionQueryDTO,
  BulkCategoryDTO,
} from './transaction.dto';
import { TransactionStatusEnum, TransactionTypeEnum } from './transaction.enum';
import { IParserRuleService } from '@/modules/parser-rule/parser-rule.service';
import ParserRuleService from '@/modules/parser-rule/parser-rule.service';
import { ITransferLinkRepository } from '@/modules/account/transfer-link.repository';
import { IGeneralResponse, IPagination } from '@/common/types/interface';
import { BadRequestException, InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';
import { IUserRepository } from '@/modules/user/user.repository';
import { IExchangeRateService } from '@/modules/exchange-rate/exchange-rate.service';

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
}

@injectable()
class TransactionService implements ITransactionService {
  constructor(
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
    @inject(ParserRuleService) private parserRuleService: IParserRuleService,
    @inject('IUserRepository') private userRepository: IUserRepository,
    @inject('ITransferLinkRepository') private transferLinkRepository: ITransferLinkRepository,
    @inject('IExchangeRateService') private exchangeRateService: IExchangeRateService,
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

      const trendFrom = new Date(now.getFullYear(), now.getMonth() - 5, 1);
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

      // Monthly trend (always last 6 months)
      const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const trendMap = new Map<string, { spend: number; income: number }>();
      for (let i = 5; i >= 0; i--) {
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
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - user.dataRetentionMonths);
        await this.transactionRepository.deleteOlderThan(user.id, cutoff);
      }
      logger.info('Transaction pruning completed');
    } catch (error) {
      logger.error(`Error pruning transactions - ${error}`);
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
