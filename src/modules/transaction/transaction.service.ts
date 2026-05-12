import { inject, injectable } from 'tsyringe';
import { ITransactionRepository } from './transaction.repository';
import { ITransaction } from './transaction.interface';
import {
  CorrectTransactionDTO,
  TransactionQueryDTO,
} from './transaction.dto';
import { TransactionStatusEnum, CategoryEnum } from './transaction.enum';
import { IParserRuleService } from '@/modules/parser-rule/parser-rule.service';
import ParserRuleService from '@/modules/parser-rule/parser-rule.service';
import { IGeneralResponse, IPagination } from '@/common/types/interface';
import { InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';
import { IUserRepository } from '@/modules/user/user.repository';

export interface ITransactionService {
  listTransactions(userId: number, query: TransactionQueryDTO): Promise<IPagination<ITransaction>>;
  getSummary(
    userId: number,
    year?: number,
    month?: number,
  ): Promise<Record<string, unknown>>;
  getChartData(userId: number, period: string): Promise<Record<string, unknown>>;
  getTransaction(id: number, userId: number): Promise<ITransaction>;
  correctTransaction(
    id: number,
    userId: number,
    data: CorrectTransactionDTO,
  ): Promise<ITransaction>;
  getUnverified(userId: number): Promise<ITransaction[]>;
  pruneExpiredTransactions(): Promise<void>;
}

@injectable()
class TransactionService implements ITransactionService {
  constructor(
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
    @inject(ParserRuleService) private parserRuleService: IParserRuleService,
    @inject('IUserRepository') private userRepository: IUserRepository,
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

      const prevFrom = new Date(y, m - 2, 1);
      const prevTo = new Date(y, m - 1, 0, 23, 59, 59);

      const [transactions, prevTransactions] = await Promise.all([
        this.transactionRepository.findForSummary(userId, from, to),
        this.transactionRepository.findForSummary(userId, prevFrom, prevTo),
      ]);

      const totalSpend = transactions
        .filter((t) => t.amount < 0)
        .reduce((acc, t) => acc + Math.abs(t.refAmount), 0);
      const totalIncome = transactions
        .filter((t) => t.amount > 0)
        .reduce((acc, t) => acc + t.refAmount, 0);

      const prevSpend = prevTransactions
        .filter((t) => t.amount < 0)
        .reduce((acc, t) => acc + Math.abs(t.refAmount), 0);

      const vsLastPeriodPct = prevSpend > 0 ? ((totalSpend - prevSpend) / prevSpend) * 100 : null;

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
      const dailyMap = new Map<string, { spend: number; income: number }>();
      for (const t of transactions) {
        const key = new Date(t.transactionDate).toISOString().split('T')[0];
        const e = dailyMap.get(key) || { spend: 0, income: 0 };
        if (t.amount < 0) e.spend += Math.abs(t.refAmount);
        else e.income += t.refAmount;
        dailyMap.set(key, e);
      }
      const dailySpend = Array.from(dailyMap.entries())
        .map(([date, d]) => ({ date, spend: Math.round(d.spend), income: Math.round(d.income) }))
        .sort((a, b) => a.date.localeCompare(b.date));

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
}

export default TransactionService;
