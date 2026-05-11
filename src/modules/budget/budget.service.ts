import { inject, injectable } from 'tsyringe';
import OpenAI from 'openai';
import { CONSTANTS } from '@/common/configuration/constants';
import { IBudgetRepository } from './budget.repository';
import { ITransactionRepository } from '@/modules/transaction/transaction.repository';
import { IUserRepository } from '@/modules/user/user.repository';
import { IBankRepository } from '@/modules/bank/bank.repository';
import { IBudget } from './budget.interface';
import {
  CreateBudgetDTO,
  UpdateBudgetDTO,
  BudgetWithProgressDTO,
  BudgetDetailDTO,
} from './budget.dto';
import { IGeneralResponse } from '@/common/types/interface';
import { InternalServerException, ResourceNotFoundException } from '@/common/exception';
import logger from '@/common/lib/logger';
import { CategoryEnum } from '@/modules/transaction/transaction.enum';
import { BudgetPeriodEnum } from './budget.enum';
import { IAiUsageRepository } from '@/modules/admin/admin.repository';

const SUGGESTION_CACHE_TTL = 24 * 60 * 60 * 1000;
const suggestionCache = new Map<number, { data: any[]; cachedAt: number }>();

export interface IBudgetService {
  listBudgets(userId: number): Promise<BudgetWithProgressDTO[]>;
  createBudget(userId: number, data: CreateBudgetDTO): Promise<BudgetWithProgressDTO>;
  updateBudget(id: number, userId: number, data: UpdateBudgetDTO): Promise<BudgetWithProgressDTO>;
  deleteBudget(id: number, userId: number): Promise<IGeneralResponse<null>>;
  getBudgetDetail(id: number, userId: number): Promise<BudgetDetailDTO>;
  getBudgetSuggestions(userId: number): Promise<any[]>;
}

@injectable()
class BudgetService implements IBudgetService {
  private openai: OpenAI;

  constructor(
    @inject('IBudgetRepository') private budgetRepository: IBudgetRepository,
    @inject('ITransactionRepository') private transactionRepository: ITransactionRepository,
    @inject('IUserRepository') private userRepository: IUserRepository,
    @inject('IBankRepository') private bankRepository: IBankRepository,
    @inject('IAiUsageRepository') private aiUsageRepository: IAiUsageRepository,
  ) {
    this.openai = new OpenAI({ apiKey: CONSTANTS.OPENAI_API_KEY });
  }

  async listBudgets(userId: number): Promise<BudgetWithProgressDTO[]> {
    try {
      logger.info(`[Budget] Listing budgets for user ${userId}`);
      const budgets = await this.budgetRepository.findAllActive(userId);
      return Promise.all(budgets.map((b) => this.attachProgress(b, userId)));
    } catch (error) {
      logger.error(`Error listing budgets for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to list budgets');
    }
  }

  async createBudget(userId: number, data: CreateBudgetDTO): Promise<BudgetWithProgressDTO> {
    try {
      logger.info(`[Budget] Creating budget for user ${userId} (category=${data.category})`);
      const budget = await this.budgetRepository.create({
        userId,
        category: data.category,
        limitAmount: data.limit_amount,
        currency: data.currency,
        periodType: data.period_type,
      });
      return this.attachProgress(budget, userId);
    } catch (error) {
      logger.error(`Error creating budget for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to create budget');
    }
  }

  async updateBudget(
    id: number,
    userId: number,
    data: UpdateBudgetDTO,
  ): Promise<BudgetWithProgressDTO> {
    try {
      logger.info(`[Budget] Updating budget ${id} for user ${userId}`);
      const existing = await this.budgetRepository.findById(id, userId);
      if (!existing) throw new ResourceNotFoundException('Budget not found');

      const sixtyDaysFromNow = new Date();
      sixtyDaysFromNow.setDate(sixtyDaysFromNow.getDate() + 60);

      const updateData: Partial<IBudget> = {
        suppressedSuggestionsUntil: sixtyDaysFromNow,
      };
      if (data.limit_amount !== undefined) updateData.limitAmount = data.limit_amount;
      if (data.period_type !== undefined) updateData.periodType = data.period_type;
      if (data.is_active !== undefined) updateData.isActive = data.is_active;

      const updated = await this.budgetRepository.update(id, userId, updateData);
      return this.attachProgress(updated, userId);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error updating budget ${id} - ${error}`);
      throw new InternalServerException('Failed to update budget');
    }
  }

  async deleteBudget(id: number, userId: number): Promise<IGeneralResponse<null>> {
    try {
      logger.info(`[Budget] Deleting budget ${id} for user ${userId}`);
      const existing = await this.budgetRepository.findById(id, userId);
      if (!existing) throw new ResourceNotFoundException('Budget not found');
      await this.budgetRepository.deactivate(id, userId);
      return { success: true, message: 'Budget deactivated', data: null };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error deleting budget ${id} - ${error}`);
      throw new InternalServerException('Failed to delete budget');
    }
  }

  async getBudgetDetail(id: number, userId: number): Promise<BudgetDetailDTO> {
    try {
      logger.info(`[Budget] Fetching detail for budget ${id} (user ${userId})`);
      const budget = await this.budgetRepository.findById(id, userId);
      if (!budget) throw new ResourceNotFoundException('Budget not found');

      const now = new Date();
      const periodStart =
        budget.periodType === BudgetPeriodEnum.MONTHLY
          ? new Date(now.getFullYear(), now.getMonth(), 1)
          : new Date(now.getTime() - now.getDay() * 24 * 60 * 60 * 1000);
      const periodEnd =
        budget.periodType === BudgetPeriodEnum.MONTHLY
          ? new Date(now.getFullYear(), now.getMonth() + 1, 0)
          : new Date(periodStart.getTime() + 6 * 24 * 60 * 60 * 1000);

      const allTxns = await this.transactionRepository.findForSummary(userId, periodStart, now);
      const txns = allTxns.filter((t) => t.category === budget.category && t.amount < 0);

      const spent = txns.reduce((acc, t) => acc + Math.abs(t.refAmount), 0);
      const remaining = Math.max(0, budget.limitAmount - spent);
      const percentage = (spent / budget.limitAmount) * 100;
      const status: 'over' | 'warning' | 'healthy' =
        percentage >= 100 ? 'over' : percentage >= 80 ? 'warning' : 'healthy';
      const daysRemaining = Math.ceil(
        (periodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );

      // Merchant breakdown — top 10 by total spend
      const merchantMap = new Map<string, { total: number; count: number }>();
      for (const t of txns) {
        const entry = merchantMap.get(t.merchant) ?? { total: 0, count: 0 };
        entry.total += Math.abs(t.refAmount);
        entry.count += 1;
        merchantMap.set(t.merchant, entry);
      }
      const merchant_breakdown = Array.from(merchantMap.entries())
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 10)
        .map(([merchant, { total, count }]) => ({
          merchant,
          total,
          percentage_of_budget: (total / budget.limitAmount) * 100,
          transaction_count: count,
        }));

      // Batch bank name lookups
      const bankIds = [
        ...new Set(txns.map((t) => t.bankId).filter((bid): bid is number => bid !== null)),
      ];
      const bankMap = new Map<number, string>();
      await Promise.all(
        bankIds.map(async (bid) => {
          const bank = await this.bankRepository.findById(bid);
          bankMap.set(bid, bank?.name ?? 'Unknown');
        }),
      );

      // Date-grouped transactions (desc)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);

      const dateLabel = (date: Date): string => {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        if (d.getTime() === today.getTime()) return 'TODAY';
        if (d.getTime() === yesterday.getTime()) return 'YESTERDAY';
        return d
          .toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
          .toUpperCase();
      };

      const sorted = [...txns].sort(
        (a, b) => new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime(),
      );

      const groupOrder: string[] = [];
      const grouped = new Map<string, typeof sorted>();
      for (const t of sorted) {
        const label = dateLabel(new Date(t.transactionDate));
        if (!grouped.has(label)) {
          groupOrder.push(label);
          grouped.set(label, []);
        }
        grouped.get(label)!.push(t);
      }

      const transactions = groupOrder.map((date_group) => ({
        date_group,
        items: grouped.get(date_group)!.map((t) => ({
          id: t.id,
          merchant: t.merchant,
          bank: t.bankId !== null ? (bankMap.get(t.bankId) ?? 'Unknown') : 'Unknown',
          amount: t.amount,
          currency: t.currency,
          ref_amount: t.refAmount,
          time: new Date(t.transactionDate).toTimeString().slice(0, 5),
          status: t.status,
        })),
      }));

      return {
        id: budget.id,
        category: budget.category,
        limit_amount: budget.limitAmount,
        currency: budget.currency,
        period_type: budget.periodType,
        is_suggested_by_ai: budget.isSuggestedByAi,
        spent,
        remaining,
        percentage,
        status,
        days_remaining: daysRemaining,
        transaction_count: txns.length,
        merchant_breakdown,
        transactions,
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) throw error;
      logger.error(`Error fetching budget detail ${id} - ${error}`);
      throw new InternalServerException('Failed to fetch budget detail');
    }
  }

  async getBudgetSuggestions(userId: number): Promise<any[]> {
    try {
      logger.info(`[Budget] Fetching AI budget suggestions for user ${userId}`);
      const cached = suggestionCache.get(userId);
      if (cached && Date.now() - cached.cachedAt < SUGGESTION_CACHE_TTL) {
        return cached.data;
      }

      const user = await this.userRepository.findById(userId);
      const activeBudgets = await this.budgetRepository.findAllActive(userId);
      const now = new Date();
      const suppressedCategorySet = new Set(
        activeBudgets
          .filter((b) => b.suppressedSuggestionsUntil !== null && b.suppressedSuggestionsUntil > now)
          .map((b) => b.category),
      );

      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const transactions = await this.transactionRepository.findForSummary(userId, threeMonthsAgo, now);

      const categorySpend = new Map<string, number[]>();
      for (const t of transactions.filter((tx) => tx.amount < 0)) {
        const monthly = categorySpend.get(t.category) || [];
        monthly.push(Math.abs(t.refAmount));
        categorySpend.set(t.category, monthly);
      }

      const spendingContext = Array.from(categorySpend.entries())
        .filter(([cat]) => !suppressedCategorySet.has(cat))
        .map(([cat, amounts]) => ({
          category: cat,
          avg_monthly: amounts.reduce((a, b) => a + b, 0) / 3,
          suggested_limit: (amounts.reduce((a, b) => a + b, 0) / 3) * 0.9,
        }));

      if (spendingContext.length === 0) {
        return [];
      }

      const response = await this.openai.chat.completions.create({
        model: CONSTANTS.OPENAI_MODEL_BUDGET,
        messages: [
          {
            role: 'system',
            content: `You are Iris, a helpful financial advisor. Return JSON only.`,
          },
          {
            role: 'user',
            content: `Generate budget suggestions for a user with goal "${user?.goalType}" and advisor tone "${user?.advisorTone}".

Spending data (last 3 months): ${JSON.stringify(spendingContext)}

For each category, write a 1-2 sentence suggestion explaining why this budget makes sense. Use the user's preferred tone.

Return JSON array: [{ "category": string, "suggested_limit": number, "message": string }]`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      if (response.usage) {
        this.aiUsageRepository.log({
          operation: 'budget_suggestion',
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
          modelUsed: CONSTANTS.OPENAI_MODEL_BUDGET,
          userId: userId,
        }).catch(() => null);
      }

      const raw = JSON.parse(response.choices[0].message.content || '{"suggestions":[]}');
      const suggestions = raw.suggestions || raw;

      suggestionCache.set(userId, { data: suggestions, cachedAt: Date.now() });
      return suggestions;
    } catch (error) {
      logger.error(`Error generating budget suggestions for user ${userId} - ${error}`);
      throw new InternalServerException('Failed to generate budget suggestions');
    }
  }

  private async attachProgress(budget: IBudget, userId: number): Promise<BudgetWithProgressDTO> {
    const now = new Date();
    const periodStart =
      budget.periodType === BudgetPeriodEnum.MONTHLY
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(now.getTime() - (now.getDay() * 24 * 60 * 60 * 1000));
    const periodEnd =
      budget.periodType === BudgetPeriodEnum.MONTHLY
        ? new Date(now.getFullYear(), now.getMonth() + 1, 0)
        : new Date(periodStart.getTime() + 6 * 24 * 60 * 60 * 1000);

    const transactions = await this.transactionRepository.findForSummary(userId, periodStart, now);
    const spent = transactions
      .filter((t) => t.category === budget.category && t.amount < 0)
      .reduce((acc, t) => acc + Math.abs(t.refAmount), 0);

    const remaining = Math.max(0, budget.limitAmount - spent);
    const percentage = (spent / budget.limitAmount) * 100;
    const daysRemaining = Math.ceil(
      (periodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
    );
    const status =
      percentage >= 100 ? 'over' : percentage >= 80 ? 'warning' : 'healthy';

    return {
      id: budget.id,
      category: budget.category,
      limit_amount: budget.limitAmount,
      currency: budget.currency,
      period_type: budget.periodType,
      spent,
      remaining,
      percentage,
      status,
      days_remaining: daysRemaining,
    };
  }
}

export default BudgetService;
